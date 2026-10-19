import type { DatabaseType } from "@/types/database";

export type OracleInvalidObject = {
  owner: string;
  name: string;
  type: string;
  objectId: string;
  lastDdlTime: string;
};

export type OracleObjectError = {
  sequence: number;
  line: number;
  position: number;
  text: string;
};

const ORACLE_COMPILE_TYPES = new Set(["VIEW", "MATERIALIZED VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "PACKAGE", "PACKAGE BODY", "TYPE", "TYPE BODY", "SYNONYM"]);

const OCEANBASE_COMPILE_TYPES = new Set(["PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE BODY"]);

export function quoteOracleLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function quoteOracleIdentifier(value: string): string {
  if (!value || value.includes("\0")) throw new Error("Invalid Oracle identifier");
  return `"${value.replaceAll('"', '""')}"`;
}

export function buildOracleInvalidObjectsSql(owner: string, limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error("Invalid row limit");
  const escapedOwner = quoteOracleLiteral(owner);
  return `SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS') AS LAST_DDL_TIME\nFROM (SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, LAST_DDL_TIME FROM ALL_OBJECTS WHERE OWNER = ${escapedOwner} AND STATUS = 'INVALID' ORDER BY OBJECT_NAME, OBJECT_TYPE)\nWHERE ROWNUM <= ${limit}`;
}

export function buildOracleObjectErrorsSql(owner: string, object: Pick<OracleInvalidObject, "name" | "type">): string {
  return `SELECT SEQUENCE, LINE, POSITION, TEXT FROM ALL_ERRORS WHERE OWNER = ${quoteOracleLiteral(owner)} AND NAME = ${quoteOracleLiteral(object.name)} AND TYPE = ${quoteOracleLiteral(object.type)} ORDER BY SEQUENCE`;
}

export function buildOracleObjectIdentitySql(owner: string, object: OracleInvalidObject): string {
  return `SELECT OBJECT_ID, TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS') AS LAST_DDL_TIME FROM ALL_OBJECTS WHERE OWNER = ${quoteOracleLiteral(owner)} AND OBJECT_NAME = ${quoteOracleLiteral(object.name)} AND OBJECT_TYPE = ${quoteOracleLiteral(object.type)} AND STATUS = 'INVALID'`;
}

export function buildOracleObjectStatusSql(owner: string, object: OracleInvalidObject): string {
  return `SELECT OBJECT_ID, TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS') AS LAST_DDL_TIME, STATUS FROM ALL_OBJECTS WHERE OWNER = ${quoteOracleLiteral(owner)} AND OBJECT_NAME = ${quoteOracleLiteral(object.name)} AND OBJECT_TYPE = ${quoteOracleLiteral(object.type)}`;
}

export function oracleCompileUnsupportedReason(dbType: DatabaseType, objectType: string): "unsupported-type" | "unsupported-on-engine" | null {
  const type = objectType.toUpperCase();
  if (!ORACLE_COMPILE_TYPES.has(type)) return "unsupported-type";
  if (dbType === "oceanbase-oracle" && !OCEANBASE_COMPILE_TYPES.has(type)) return "unsupported-on-engine";
  return null;
}

export function buildOracleCompileSql(dbType: DatabaseType, owner: string, object: Pick<OracleInvalidObject, "name" | "type">): string {
  const type = object.type.toUpperCase();
  if (oracleCompileUnsupportedReason(dbType, type)) throw new Error("Unsupported Oracle object compile type");
  const qualified = `${quoteOracleIdentifier(owner)}.${quoteOracleIdentifier(object.name)}`;
  if (type === "SYNONYM") return `ALTER ${owner === "PUBLIC" ? "PUBLIC " : ""}SYNONYM ${owner === "PUBLIC" ? quoteOracleIdentifier(object.name) : qualified} COMPILE`;
  if (type === "MATERIALIZED VIEW") return `ALTER MATERIALIZED VIEW ${qualified} COMPILE`;
  if (type === "PACKAGE BODY") return `ALTER PACKAGE ${qualified} COMPILE BODY${dbType === "oracle" ? " REUSE SETTINGS" : ""}`;
  if (type === "PACKAGE" && dbType === "oracle") return `ALTER PACKAGE ${qualified} COMPILE SPECIFICATION REUSE SETTINGS`;
  if (type === "TYPE") return `ALTER TYPE ${qualified} COMPILE SPECIFICATION${dbType === "oracle" ? " REUSE SETTINGS" : ""}`;
  if (type === "TYPE BODY") return `ALTER TYPE ${qualified} COMPILE BODY${dbType === "oracle" ? " REUSE SETTINGS" : ""}`;
  const reuseSettings = dbType === "oracle" && ["PROCEDURE", "FUNCTION", "TRIGGER"].includes(type) ? " REUSE SETTINGS" : "";
  return `ALTER ${type} ${qualified} COMPILE${reuseSettings}`;
}

export function mapOracleInvalidObjects(rows: unknown[][], owner: string): OracleInvalidObject[] {
  return rows.flatMap((row) => {
    const name = row[1];
    const type = row[2];
    if (typeof name !== "string" || typeof type !== "string") return [];
    return [{ owner: String(row[0] ?? owner), name, type, objectId: String(row[3] ?? ""), lastDdlTime: String(row[4] ?? "") }];
  });
}

export function mapOracleObjectErrors(rows: unknown[][]): OracleObjectError[] {
  return rows
    .flatMap((row) => {
      const sequence = Number(row[0]);
      const line = Number(row[1]);
      const position = Number(row[2]);
      if (![sequence, line, position].every(Number.isSafeInteger)) return [];
      return [{ sequence, line, position, text: String(row[3] ?? "") }];
    })
    .sort((a, b) => a.sequence - b.sequence);
}
