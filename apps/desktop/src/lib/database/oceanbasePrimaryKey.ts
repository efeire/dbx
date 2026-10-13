import * as api from "@/lib/backend/api";
import type { BuildTableStructureChangeSqlOptions } from "@/lib/table/tableStructureEditorSql";
import { generateUniqueIndexName } from "@/lib/table/tableStructureEditorState";

export interface PrimaryKeyTarget {
  connectionId: string;
  database: string;
  schema: string;
  tableName: string;
  catalog?: string;
  databaseType?: "oracle" | "oceanbase-oracle";
}

export type ExistingPrimaryKeyChange = NonNullable<BuildTableStructureChangeSqlOptions["primaryKeyChange"]>;

export interface OceanbasePrimaryKeyPlan {
  target: PrimaryKeyTarget;
  change: ExistingPrimaryKeyChange;
  draft?: ExistingPrimaryKeyChange;
  snapshot: string;
  statements: string[];
}

export interface OceanbasePrimaryKeyResult {
  steps: Array<{ sql: string; state: "committed" | "rejected" | "unknown" | "notExecuted"; error?: string }>;
  readbackError?: string;
  recoverySql?: string;
  indexStates?: Array<{ name: string; state: "indexPresent" | "indexAbsent" | "indexChanged" | "indexUnknown" }>;
}

export class OceanbasePrimaryKeyValidationError extends Error {
  constructor(
    readonly key: string,
    readonly values: Record<string, string> = {},
  ) {
    super(key);
  }
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameMembers = (a: string[], b: string[]) => same([...a].sort(), [...b].sort());
const fail = (key: string): never => {
  throw new OceanbasePrimaryKeyValidationError(key);
};

async function queryPrimaryKey(target: PrimaryKeyTarget, sql: string) {
  const result = await api.executeQuery(target.connectionId, target.database, sql, target.schema, undefined, { catalog: target.catalog, maxRows: 10001 });
  if (result.execution_error) throw new Error(result.error?.detail || "Primary key metadata query failed");
  if (result.truncated || result.has_more || result.rows.length >= 10001) fail("incompleteMetadata");
  return result.rows;
}

async function readOracleIndex(target: PrimaryKeyTarget, owner: string, name: string) {
  const [properties, columns] = await Promise.all([
    queryPrimaryKey(target, `SELECT OWNER, INDEX_NAME, INDEX_TYPE, UNIQUENESS, STATUS, VISIBILITY, PARTITIONED, TABLE_OWNER, TABLE_NAME FROM SYS.ALL_INDEXES WHERE OWNER = ${literal(owner)} AND INDEX_NAME = ${literal(name)}`),
    queryPrimaryKey(target, `SELECT COLUMN_NAME, COLUMN_POSITION, DESCEND FROM SYS.ALL_IND_COLUMNS WHERE INDEX_OWNER = ${literal(owner)} AND INDEX_NAME = ${literal(name)} ORDER BY COLUMN_POSITION`),
  ]);
  return { properties, columns };
}

export async function prepareOraclePrimaryKeyChange(target: PrimaryKeyTarget, draft: ExistingPrimaryKeyChange) {
  const snapshot = await readOceanbasePrimaryKeySnapshot(target, draft);
  const original = JSON.parse(snapshot) as { keys: string[][] };
  const policy = draft.oracleIndex?.policy ?? "keep";
  const oracleIndex: NonNullable<ExistingPrimaryKeyChange["oracleIndex"]> = { policy, owner: target.schema, name: original.keys[0]![6]! };
  if (draft.columns.length && (policy === "drop" || !sameMembers(draft.originalColumns, draft.columns))) {
    const rows = await queryPrimaryKey(target, `SELECT INDEX_NAME FROM SYS.ALL_INDEXES WHERE OWNER = ${literal(target.schema)} ORDER BY INDEX_NAME`);
    if (rows.some((row) => row.length !== 1 || typeof row[0] !== "string" || !row[0])) fail("incompleteMetadata");
    const taken = rows.map((row) => String(row[0]));
    oracleIndex.newName = generateUniqueIndexName(target.tableName, draft.columns, taken, 30) || generateUniqueIndexName("DBX_PK", [], taken, 30);
    if (taken.includes(oracleIndex.newName)) fail("definitionChanged");
  }
  return { snapshot, change: { ...draft, oracleIndex } };
}

/** Reads the captured target afresh. No DDL is issued by this preflight. */
export async function readOceanbasePrimaryKeySnapshot(target: PrimaryKeyTarget, change: ExistingPrimaryKeyChange): Promise<string> {
  const oracle = target.databaseType === "oracle";
  if (!target.schema || !target.tableName || !change.name || !change.originalColumns.length) fail("incompleteMetadata");
  if (new Set(change.originalColumns).size !== change.originalColumns.length || new Set(change.columns).size !== change.columns.length) fail("duplicateColumns");
  const query = (sql: string) => queryPrimaryKey(target, sql);
  const where = `OWNER = ${literal(target.schema)} AND TABLE_NAME = ${literal(target.tableName)}`;
  const [columns, constraints, indexes, keys, keyColumns, tableFlags, columnFlags, references] = await Promise.all([
    api.getColumns(target.connectionId, target.database, target.schema, target.tableName, target.catalog),
    api.listConstraints(target.connectionId, target.database, target.schema, target.tableName, target.catalog),
    api.listIndexes(target.connectionId, target.database, target.schema, target.tableName, target.catalog),
    query(`SELECT CONSTRAINT_NAME, STATUS, VALIDATED, DEFERRABLE, DEFERRED, INDEX_OWNER, INDEX_NAME FROM SYS.ALL_CONSTRAINTS WHERE ${where} AND CONSTRAINT_TYPE = 'P'`),
    query(`SELECT COLUMN_NAME, POSITION FROM SYS.ALL_CONS_COLUMNS WHERE ${where} AND CONSTRAINT_NAME = ${literal(change.name)} ORDER BY POSITION`),
    query(`SELECT IOT_TYPE, TEMPORARY FROM SYS.ALL_TABLES WHERE ${where}`),
    query(`SELECT COLUMN_NAME, NULLABLE, VIRTUAL_COLUMN FROM SYS.ALL_TAB_COLS WHERE ${where} ORDER BY COLUMN_ID`),
    query(`SELECT OWNER, TABLE_NAME, CONSTRAINT_NAME, STATUS FROM SYS.ALL_CONSTRAINTS WHERE CONSTRAINT_TYPE = 'R' AND R_OWNER = ${literal(target.schema)} AND R_CONSTRAINT_NAME = ${literal(change.name)} ORDER BY OWNER, TABLE_NAME, CONSTRAINT_NAME`),
  ]);
  if (tableFlags.length !== 1 || tableFlags[0]?.length !== 2 || tableFlags[0][0] !== null || tableFlags[0][1] !== "N") fail("unsupportedTable");
  const key = keys[0];
  if (keys.length !== 1 || key?.length !== 7 || key[0] !== change.name) fail("incompleteMetadata");
  if (!same(key.slice(1, 5), ["ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE"])) fail("unsupportedState");
  if (key[5] !== target.schema || typeof key[6] !== "string" || !key[6]) fail("unsupportedIndex");
  if (
    !same(
      keyColumns.map((row) => row[0]),
      change.originalColumns,
    ) ||
    keyColumns.some((row, i) => row.length !== 2 || Number(row[1]) !== i + 1)
  )
    fail("definitionChanged");
  const reported = constraints.filter((constraint) => constraint.constraint_type === "PRIMARY KEY");
  if (reported.length !== 1 || reported[0]?.name !== change.name || !same(reported[0]?.columns, change.originalColumns) || reported[0]?.enabled !== true || reported[0]?.valid !== true || reported[0]?.deferrable !== false || reported[0]?.initially_deferred !== false) fail("incompleteMetadata");
  const columnNames = new Set(columns.map((column) => column.name));
  const markedNames = columns.filter((column) => column.is_primary_key).map((column) => column.name);
  if (!columns.length || columnNames.size !== columns.length || markedNames.length !== change.originalColumns.length || change.originalColumns.some((name) => !markedNames.includes(name))) fail("incompleteMetadata");
  for (const name of new Set([...change.originalColumns, ...change.columns])) {
    const flags = columnFlags.filter((row) => row[0] === name);
    if (!columnNames.has(name) || flags.length !== 1 || flags[0]?.length !== 3 || !["Y", "N"].includes(String(flags[0][1]))) fail("incompleteMetadata");
    if (flags[0][2] !== "NO") fail("virtualColumn");
    if (columns.find((column) => column.name === name)?.is_nullable !== (flags[0][1] === "Y")) fail("incompleteMetadata");
  }
  if (references.length) {
    throw new OceanbasePrimaryKeyValidationError("referenced", { names: references.map((row) => `${String(row[0])}.${String(row[1])}.${String(row[2])}`).join(", ") });
  }
  const indexName = key[6] as string;
  const [indexProperties, indexColumns, indexUsers] = await Promise.all([
    query(`SELECT OWNER, INDEX_NAME, INDEX_TYPE, UNIQUENESS, STATUS, VISIBILITY, PARTITIONED FROM SYS.ALL_INDEXES WHERE OWNER = ${literal(target.schema)} AND INDEX_NAME = ${literal(indexName)} AND TABLE_OWNER = ${literal(target.schema)} AND TABLE_NAME = ${literal(target.tableName)}`),
    query(`SELECT COLUMN_NAME, COLUMN_POSITION, DESCEND FROM SYS.ALL_IND_COLUMNS WHERE INDEX_OWNER = ${literal(target.schema)} AND INDEX_NAME = ${literal(indexName)} ORDER BY COLUMN_POSITION`),
    query(`SELECT OWNER, TABLE_NAME, CONSTRAINT_NAME, CONSTRAINT_TYPE FROM SYS.ALL_CONSTRAINTS WHERE INDEX_OWNER = ${literal(target.schema)} AND INDEX_NAME = ${literal(indexName)} ORDER BY OWNER, TABLE_NAME, CONSTRAINT_NAME`),
  ]);
  if (!same(indexProperties, [[target.schema, indexName, "NORMAL", "UNIQUE", "VALID", "VISIBLE", "NO"]])) fail("unsupportedIndex");
  if (
    !(oracle
      ? sameMembers(
          indexColumns.map((row) => String(row[0])),
          change.originalColumns,
        )
      : same(
          indexColumns.map((row) => row[0]),
          change.originalColumns,
        )) ||
    indexColumns.some((row, i) => row.length !== 3 || Number(row[1]) !== i + 1 || row[2] !== "ASC")
  )
    fail("unsupportedIndex");
  if (!same(indexUsers, [[target.schema, target.tableName, change.name, "P"]])) fail("sharedIndex");
  const reportedIndexes = indexes.filter((index) => index.name === indexName);
  if (
    reportedIndexes.length !== 1 ||
    !same(
      reportedIndexes[0]?.columns,
      indexColumns.map((row) => row[0]),
    ) ||
    reportedIndexes[0]?.is_unique !== true ||
    reportedIndexes[0]?.is_primary !== true ||
    reportedIndexes[0]?.index_type !== "NORMAL"
  )
    fail("incompleteMetadata");
  if (oracle && change.oracleIndex?.name) {
    const index = change.oracleIndex;
    if (index.owner !== target.schema || index.name !== indexName || !["keep", "drop"].includes(index.policy)) fail("definitionChanged");
    if (index.newName) {
      const conflict = await query(`SELECT INDEX_NAME FROM SYS.ALL_INDEXES WHERE OWNER = ${literal(index.owner)} AND INDEX_NAME = ${literal(index.newName)}`);
      if (conflict.length) fail("definitionChanged");
    }
  }
  if (change.columns.length) {
    const table = `${ident(target.schema)}.${ident(target.tableName)}`;
    const [nulls, duplicates] = await Promise.all([
      query(`SELECT COUNT(*) FROM ${table} WHERE (${change.columns.map((name) => `${ident(name)} IS NULL`).join(" OR ")}) AND ROWNUM <= 1`),
      query(`SELECT COUNT(*) FROM (SELECT 1 FROM ${table} GROUP BY ${change.columns.map(ident).join(", ")} HAVING COUNT(*) > 1) WHERE ROWNUM <= 1`),
    ]);
    for (const [rows, error] of [
      [nulls, "nullValues"],
      [duplicates, "duplicateValues"],
    ] as const) {
      if (rows.length !== 1 || rows[0]?.length !== 1 || ![0, 1, "0", "1"].includes(rows[0][0] as number | string)) fail("incompleteMetadata");
      if (Number(rows[0][0]) !== 0) fail(error);
    }
  }
  return JSON.stringify({ columns, keys, keyColumns, tableFlags, columnFlags, indexProperties, indexColumns, indexUsers });
}

/** Rechecks the original target and stops at the first failed independent DDL. */
export async function executeOceanbasePrimaryKeyPlan(plan: OceanbasePrimaryKeyPlan, timeoutSecs: number, stillCurrent: () => boolean): Promise<OceanbasePrimaryKeyResult | undefined> {
  const { target, change } = plan;
  const current = await readOceanbasePrimaryKeySnapshot(target, change);
  if (!stillCurrent()) return undefined;
  if (current !== plan.snapshot) fail("definitionChanged");
  const steps: OceanbasePrimaryKeyResult["steps"] = plan.statements.map((sql) => ({ sql, state: "notExecuted" }));
  for (const step of steps) {
    try {
      const result = await api.executeQuery(target.connectionId, target.database, step.sql.replace(/;\s*$/, ""), target.schema, undefined, { catalog: target.catalog, timeoutSecs });
      if (result.execution_error) {
        step.state = "rejected";
        step.error = result.error?.detail || "Primary key statement rejected";
        break;
      }
      step.state = "committed";
    } catch (error) {
      step.state = "unknown";
      step.error = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  const result: OceanbasePrimaryKeyResult = { steps };
  try {
    const [, constraints] = await Promise.all([
      api.getColumns(target.connectionId, target.database, target.schema, target.tableName, target.catalog),
      api.listConstraints(target.connectionId, target.database, target.schema, target.tableName, target.catalog),
      api.listIndexes(target.connectionId, target.database, target.schema, target.tableName, target.catalog),
    ]);
    const keys = constraints.filter((constraint) => constraint.constraint_type === "PRIMARY KEY");
    if (steps.every((step) => step.state === "committed")) {
      if (change.columns.length ? keys.length !== 1 || keys[0]?.name !== change.name || !same(keys[0]?.columns, change.columns) : keys.length !== 0) {
        result.readbackError = "definitionChanged";
      }
    }
    let recoveryIndex = "";
    let recoveryVerified = true;
    if (target.databaseType === "oracle" && change.oracleIndex) {
      const original = JSON.parse(plan.snapshot) as { indexProperties: unknown[][]; indexColumns: unknown[][] };
      const index = change.oracleIndex;
      result.indexStates = [];
      for (const name of [index.name, ...(index.newName ? [index.newName] : [])]) {
        try {
          const currentIndex = await readOracleIndex(target, index.owner, name);
          const absent = currentIndex.properties.length === 0 && currentIndex.columns.length === 0;
          const isOriginal = name === index.name;
          const expectedProperties = isOriginal ? original.indexProperties.map((row) => [...row, target.schema, target.tableName]) : [[index.owner, name, "NORMAL", "UNIQUE", "VALID", "VISIBLE", "NO", target.schema, target.tableName]];
          const expectedColumns = isOriginal ? original.indexColumns : change.columns.map((column, i) => [column, i + 1, "ASC"]);
          const normalizedColumns = currentIndex.columns.map((row) => [row[0], Number(row[1]), row[2]]);
          const matches =
            same(currentIndex.properties, expectedProperties) &&
            same(
              normalizedColumns,
              expectedColumns.map((row) => [row[0], Number(row[1]), row[2]]),
            );
          result.indexStates.push({ name: `${index.owner}.${name}`, state: absent ? "indexAbsent" : matches ? "indexPresent" : "indexChanged" });
          if (isOriginal) {
            recoveryVerified = absent || matches;
            if (matches) recoveryIndex = ` USING INDEX ${ident(index.owner)}.${ident(name)}`;
          }
          if (steps.every((step) => step.state === "committed")) {
            const shouldExist = !isOriginal || index.policy === "keep";
            if (shouldExist ? !matches : !absent) result.readbackError = "definitionChanged";
          }
        } catch (error) {
          result.indexStates.push({ name: `${index.owner}.${name}`, state: "indexUnknown" });
          result.readbackError = error instanceof Error ? error.message : String(error);
          recoveryVerified = false;
        }
      }
    }
    if (steps[0]?.state === "committed" && keys.length === 0) {
      const sql = `ALTER TABLE ${ident(target.schema)}.${ident(target.tableName)} ADD CONSTRAINT ${ident(change.name)} PRIMARY KEY (${change.originalColumns.map(ident).join(", ")})${recoveryIndex};`;
      result.recoverySql = recoveryVerified
        ? sql
        : `-- VERIFY ORIGINAL INDEX DEFINITION BEFORE RECOVERY\n${sql
            .split(/\r?\n/)
            .map((line) => `-- ${line}`)
            .join("\n")}`;
    }
  } catch (error) {
    result.readbackError = error instanceof Error ? error.message : String(error);
  }
  return result;
}
