import * as api from "@/lib/backend/api";
import type { DatabaseType, ObjectSource, QueryResult } from "@/types/database";
import { buildRoutineRenameObjectSourceStatements } from "@/lib/table/objectSourceEditor";

export function supportsPackageRename(databaseType: DatabaseType | undefined, objectType: string): boolean {
  return (databaseType === "oracle" || databaseType === "oceanbase-oracle") && (objectType === "PACKAGE" || objectType === "PACKAGE_BODY");
}

export interface PackageRenameContext {
  connectionId: string;
  database: string;
  databaseType: DatabaseType;
  schema: string;
  name: string;
  newName: string;
}

export interface PackageRenamePlan {
  context: PackageRenameContext;
  specification: string;
  body?: string;
  statements: string[];
  stages: string[];
}

function assertQuerySucceeded(result: QueryResult): QueryResult {
  if (result.execution_error) throw new Error(result.error?.detail || String(result.rows?.[0]?.[0] ?? "Package metadata query failed."));
  return result;
}

function validateSource(source: ObjectSource, context: PackageRenameContext, kind: "PACKAGE" | "PACKAGE_BODY"): string {
  if (source.name !== context.name || source.object_type !== kind || (source.schema && source.schema !== context.schema) || !source.source.trim()) {
    throw new Error("Package source identity is missing or differs from the selected object.");
  }
  return source.source;
}

/** A missing body is accepted only after an authoritative object-directory read. */
export async function preparePackageRename(context: PackageRenameContext): Promise<PackageRenamePlan> {
  if (!supportsPackageRename(context.databaseType, "PACKAGE") || !context.schema || !context.newName || context.name === context.newName) throw new Error("Invalid package migration target.");
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const objects = assertQuerySucceeded(await api.executeQuery(context.connectionId, context.database,
    `SELECT OBJECT_TYPE FROM SYS.DBA_OBJECTS WHERE OWNER=${literal(context.schema)} AND OBJECT_NAME=${literal(context.name)} AND OBJECT_TYPE IN ('PACKAGE','PACKAGE BODY') ORDER BY OBJECT_TYPE`, context.schema));
  const kinds = objects.rows.map((row) => String(row[0]));
  if (kinds.filter((kind) => kind === "PACKAGE").length !== 1 || kinds.filter((kind) => kind === "PACKAGE BODY").length > 1) throw new Error("The complete package identity is missing or ambiguous.");
  const specification = validateSource(await api.getObjectSource(context.connectionId, context.database, context.schema, context.name, "PACKAGE"), context, "PACKAGE");
  const body = kinds.includes("PACKAGE BODY")
    ? validateSource(await api.getObjectSource(context.connectionId, context.database, context.schema, context.name, "PACKAGE_BODY"), context, "PACKAGE_BODY")
    : undefined;
  const statements = await buildRoutineRenameObjectSourceStatements({
    databaseType: context.databaseType, objectType: "PACKAGE", schema: context.schema, name: context.name, newName: context.newName,
    source: specification, packageBodySource: body,
  });
  const stages = ["preflight", "create specification", ...(body !== undefined ? ["create body"] : []), "validate compilation and overloads", "copy and verify grants", "inspect remaining dependencies"];
  if (statements.length !== stages.length) throw new Error("The backend returned an incomplete package migration plan.");
  return { context, specification, body, statements, stages };
}

export class PackageRenameStepError extends Error {
  constructor(readonly step: number, readonly stage: string, cause: unknown) {
    super(`${stage}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PackageRenameStepError";
  }
}

export function packageRenameRecoveryText(plan: PackageRenamePlan, completed: number, attempted?: number, error?: string, dependencies?: QueryResult): string {
  const comment = (value: string) => value.split(/\r?\n/).map((line) => `-- ${line}`).join("\n");
  return [
    "-- Package migration recovery snapshot. DDL is not transactional. The original package was not dropped by this plan.",
    comment(`${plan.context.schema}.${plan.context.name} -> ${plan.context.newName}`),
    ...plan.stages.map((stage, index) => comment(`${index + 1}. ${stage}: ${index < completed ? "response received" : index === attempted ? "attempted; read back database state" : "not executed"}`)),
    ...(error ? [comment(error)] : []),
    ...(dependencies ? [comment(`Remaining dependencies: ${JSON.stringify(dependencies.rows)}`)] : []),
    "-- Review both names, compilation, grants and static/dynamic callers. Keep the original until callers are migrated.",
    "-- Any cleanup is a separate explicit operation. Inspect the replacement before deciding to repair or remove it.",
    "-- ORIGINAL SPECIFICATION", plan.specification,
    ...(plan.body !== undefined ? ["-- ORIGINAL BODY", plan.body] : []),
    "-- PLANNED STATEMENTS", ...plan.statements,
  ].join("\n\n");
}

/** The caller obtains the existing production confirmation before entering here. */
export async function executePackageRename(
  plan: PackageRenamePlan,
  saveRecovery: (text: string) => void,
  execute: (sql: string) => Promise<QueryResult> = (sql) => api.executeQuery(plan.context.connectionId, plan.context.database, sql, plan.context.schema),
): Promise<{ migrationComplete: false; dependencies: QueryResult }> {
  const expected = plan.body !== undefined ? 6 : 5;
  if (plan.statements.length !== expected || plan.stages.length !== expected) throw new Error("Expected the complete package migration plan.");
  saveRecovery(packageRenameRecoveryText(plan, 0));
  let last!: QueryResult;
  for (let index = 0; index < plan.statements.length; index += 1) {
    saveRecovery(packageRenameRecoveryText(plan, index, index));
    try {
      last = assertQuerySucceeded(await execute(plan.statements[index]!));
      saveRecovery(packageRenameRecoveryText(plan, index + 1, undefined, undefined, index === plan.statements.length - 1 ? last : undefined));
    } catch (error) {
      const failure = new PackageRenameStepError(index + 1, plan.stages[index]!, error);
      saveRecovery(packageRenameRecoveryText(plan, index, index, failure.message));
      throw failure;
    }
  }
  return { migrationComplete: false, dependencies: last };
}
