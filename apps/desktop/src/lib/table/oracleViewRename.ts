import * as api from "@/lib/backend/api";
import { BackendErrorException } from "@/lib/backend/errorUtils";
import { freezeSourceIdentities } from "@/lib/table/objectSourceIdentity";
import { invalidateObjectDdlCache } from "@/lib/metadata/objectDdlCache";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { QueryResult } from "@/types/database";

export interface OracleViewRenameTarget {
  connectionId: string;
  database: string;
  schema: string;
  oldName: string;
  newName: string;
}

interface ViewSnapshot {
  name: string;
  source: string;
  fingerprint: string;
  rewrittenSource: string;
  rewrittenFingerprint: string;
  grants: string;
}

export interface OracleViewRenamePlan {
  target: OracleViewRenameTarget;
  canonicalNewName: string;
  coverage: "visible-only";
  statements: string[];
  views: ViewSnapshot[];
  dependencyEdges: string[];
}

export class OracleViewRenameFailure extends Error {
  constructor(
    public readonly plan: OracleViewRenamePlan,
    public readonly completed: string[],
    public readonly uncertain: string,
    cause: unknown,
  ) {
    super(`View rename stopped. Confirmed: ${completed.join(", ") || "none"}. Check the database state of ${uncertain} before retrying. ${String(cause instanceof Error ? cause.message : cause)}`);
  }
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const metadataLimit = 5000;

async function query(target: OracleViewRenameTarget, sql: string): Promise<QueryResult> {
  const result = await api.executeQuery(target.connectionId, target.database, sql, target.schema, undefined, { maxRows: metadataLimit + 1 });
  if (result.execution_error) throw new BackendErrorException(result.error || "Metadata query failed.");
  if (result.truncated || result.has_more || result.rows.length > metadataLimit || result.large_value_cells?.length) {
    throw new Error("Metadata is incomplete; refresh with a complete definition before renaming.");
  }
  return result;
}

async function checkOwner(target: OracleViewRenameTarget) {
  const result = await query(target, "SELECT USER, SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL");
  if (result.rows.length !== 1 || result.rows[0][0] !== target.schema || result.rows[0][1] !== target.schema) {
    throw new Error("View rename requires the object's owner and matching current schema.");
  }
}

async function objectState(target: OracleViewRenameTarget, name: string) {
  return (await query(target, `SELECT OBJECT_TYPE, STATUS FROM USER_OBJECTS WHERE OBJECT_NAME=${literal(name)}`)).rows;
}

async function readSource(target: OracleViewRenameTarget, name: string): Promise<string> {
  const ddl = `DBMS_METADATA.GET_DDL('VIEW',${literal(name)},${literal(target.schema)})`;
  const lengthRows = (await query(target, `SELECT DBMS_LOB.GETLENGTH(${ddl}) FROM DUAL`)).rows;
  const length = Number(lengthRows[0]?.[0]);
  if (lengthRows.length !== 1 || !Number.isSafeInteger(length) || length <= 0 || length > 1_000_000) throw new Error(`Complete DDL is unavailable for ${name}.`);
  let source = "";
  for (let offset = 1; offset <= length; offset += 1000) {
    const rows = (await query(target, `SELECT DBMS_LOB.SUBSTR(${ddl},1000,${offset}) FROM DUAL`)).rows;
    const chunk = rows[0]?.[0];
    if (rows.length !== 1 || typeof chunk !== "string" || Array.from(chunk).length !== Math.min(1000, length - offset + 1)) {
      throw new Error(`Complete DDL is unavailable for ${name}.`);
    }
    source += chunk;
  }
  return source;
}

async function readGrants(target: OracleViewRenameTarget, name: string): Promise<string> {
  const tables = await query(target, `SELECT GRANTOR, GRANTEE, PRIVILEGE, GRANTABLE FROM ALL_TAB_PRIVS WHERE TABLE_SCHEMA=${literal(target.schema)} AND TABLE_NAME=${literal(name)}`);
  const columns = await query(target, `SELECT GRANTOR, GRANTEE, COLUMN_NAME, PRIVILEGE, GRANTABLE FROM ALL_COL_PRIVS WHERE OWNER=${literal(target.schema)} AND TABLE_NAME=${literal(name)}`);
  return JSON.stringify([tables.rows.map((row) => JSON.stringify(row)).sort(), columns.rows.map((row) => JSON.stringify(row)).sort()]);
}

async function readDependents(target: OracleViewRenameTarget, name: string) {
  const suffix = ` WHERE REFERENCED_OWNER=${literal(target.schema)} AND REFERENCED_NAME=${literal(name)} AND REFERENCED_TYPE='VIEW'`;
  const columns = "SELECT OWNER, NAME, TYPE, REFERENCED_LINK_NAME FROM ";
  try {
    return (await query(target, `${columns}SYS.DBA_DEPENDENCIES${suffix}`)).rows;
  } catch (error) {
    // Only a denied dictionary is a fallback. Timeouts and incomplete results
    // must never turn a known dependency graph into an empty successful plan.
    if (!/ORA-00942|ORA-01031/.test(String(error instanceof Error ? error.message : error))) throw error;
    return (await query(target, `${columns}SYS.ALL_DEPENDENCIES${suffix}`)).rows;
  }
}

export async function prepareOracleViewRename(target: OracleViewRenameTarget): Promise<OracleViewRenamePlan> {
  target = { ...target };
  const canonicalNewName = await api.parseOracleObjectName(target.newName);
  if (canonicalNewName === target.oldName) throw new Error("The new name matches the existing name.");
  await checkOwner(target);
  if ((await objectState(target, canonicalNewName)).length) throw new Error(`An object named ${canonicalNewName} already exists.`);

  const ordered: string[] = [];
  const edges: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = async (name: string) => {
    if (visiting.has(name)) throw new Error(`Cyclic view dependency: ${name}.`);
    if (visited.has(name)) return;
    if (visited.size + visiting.size >= metadataLimit) throw new Error("Dependency graph is incomplete: too many views.");
    visiting.add(name);
    const dependents = await readDependents(target, name);
    for (const row of dependents) {
      const [owner, dependent, kind, link] = row;
      if (owner !== target.schema || kind !== "VIEW" || link || typeof dependent !== "string") {
        throw new Error(`Cannot automatically update dependent ${String(owner)}.${String(dependent)} (${String(kind)}).`);
      }
      edges.push(JSON.stringify([name, dependent]));
      await walk(dependent);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(name);
  };
  await walk(target.oldName);
  ordered.reverse();

  const views: ViewSnapshot[] = [];
  for (const name of ordered) {
    const state = await objectState(target, name);
    if (state.length !== 1 || state[0][0] !== "VIEW" || state[0][1] !== "VALID") throw new Error(`View ${name} is missing or invalid.`);
    const source = await readSource(target, name);
    const original = await api.buildOracleViewRenameSource({ source, owner: target.schema, viewName: name, oldName: target.oldName, newName: target.oldName });
    const rewritten = await api.buildOracleViewRenameSource({
      source,
      owner: target.schema,
      viewName: name,
      oldName: target.oldName,
      newName: canonicalNewName,
      ...(name === target.oldName ? { targetViewName: canonicalNewName } : {}),
    });
    views.push({ name, source, fingerprint: original.fingerprint, rewrittenSource: rewritten.source, rewrittenFingerprint: rewritten.fingerprint, grants: await readGrants(target, name) });
  }
  return {
    target,
    canonicalNewName,
    coverage: "visible-only",
    views,
    dependencyEdges: [...new Set(edges)].sort(),
    statements: [`RENAME ${identifier(target.oldName)} TO ${identifier(canonicalNewName)};`, ...views.slice(1).map((view) => view.rewrittenSource)],
  };
}

function planIdentity(plan: OracleViewRenamePlan) {
  return JSON.stringify([plan.target, plan.canonicalNewName, plan.dependencyEdges, plan.views.map((view) => [view.name, view.source, view.grants])]);
}

export async function executeOracleViewRename(plan: OracleViewRenamePlan, isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) throw new Error("The rename target changed. Refresh the preview.");
  const current = await prepareOracleViewRename(plan.target);
  if (!isCurrent() || planIdentity(current) !== planIdentity(plan)) throw new Error("The rename target or its dependencies changed. Refresh the preview.");
  const frozen = freezeSourceIdentities(
    plan.views.map((view) => ({
      connectionId: plan.target.connectionId,
      database: plan.target.database,
      schema: plan.target.schema,
      objectType: "VIEW" as const,
      name: view.name,
    })),
  );
  const completed: string[] = [];
  let dispatched = false;
  let activeName = plan.target.oldName;
  try {
    for (let index = 0; index < plan.statements.length; index++) {
      const view = plan.views[index];
      activeName = index === 0 ? plan.canonicalNewName : view.name;
      if (!isCurrent()) throw new Error("The rename dialog changed or closed; remaining steps were not sent.");
      if (index > 0) {
        const source = await readSource(plan.target, view.name);
        if (source !== view.source || (await readGrants(plan.target, view.name)) !== view.grants) throw new Error(`View ${view.name} changed during rename; its definition was not overwritten.`);
        if (!isCurrent()) throw new Error("The rename dialog changed or closed; remaining steps were not sent.");
      }
      if (!dispatched) {
        frozen.markDispatched();
        dispatched = true;
      }
      await query(plan.target, plan.statements[index]);
      const state = await objectState(plan.target, activeName);
      if (state.length !== 1 || state[0][0] !== "VIEW" || state[0][1] !== "VALID") throw new Error(`View ${activeName} is not valid after the change.`);
      const source = await readSource(plan.target, activeName);
      const actual = await api.buildOracleViewRenameSource({ source, owner: plan.target.schema, viewName: activeName, oldName: plan.canonicalNewName, newName: plan.canonicalNewName });
      if (actual.fingerprint !== view.rewrittenFingerprint || (await readGrants(plan.target, activeName)) !== view.grants) throw new Error(`Definition or grants did not match the preview for ${activeName}.`);
      if (index === 0 && (await objectState(plan.target, plan.target.oldName)).length) throw new Error("The old view name still exists after rename.");
      completed.push(activeName);
    }
  } catch (error) {
    if (dispatched) throw new OracleViewRenameFailure(plan, completed, activeName, error);
    throw error;
  } finally {
    if (dispatched) {
      const scope = { connectionId: plan.target.connectionId, database: plan.target.database, schema: plan.target.schema };
      invalidateObjectBrowserRowsCache(scope);
      await Promise.allSettled([...new Set([...plan.views.map((view) => view.name), plan.canonicalNewName])].map((tableName) => invalidateObjectDdlCache({ ...scope, tableName })));
      frozen.finish();
    } else frozen.cancel();
  }
}
