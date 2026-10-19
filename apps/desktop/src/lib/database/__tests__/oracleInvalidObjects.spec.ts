import { describe, expect, it } from "vitest";
import { buildOracleCompileSql, buildOracleInvalidObjectsSql, buildOracleObjectErrorsSql, buildOracleObjectIdentitySql, mapOracleInvalidObjects, mapOracleObjectErrors, oracleCompileUnsupportedReason } from "../oracleInvalidObjects";

describe("Oracle invalid-object SQL and mapping", () => {
  it("quotes schema and names as SQL literals and limits the complete ordered listing", () => {
    const sql = buildOracleInvalidObjectsSql("Owner'X", 501);
    expect(sql).toContain("OWNER = 'Owner''X'");
    expect(sql).toContain("STATUS = 'INVALID'");
    expect(sql).toContain("ORDER BY OBJECT_NAME, OBJECT_TYPE");
    expect(sql).toContain("ROWNUM <= 501");
  });

  it("preserves distinct object/body types and creates exact identity/error queries", () => {
    const object = { owner: "A", name: 'p"name', type: "PACKAGE BODY", objectId: "52", lastDdlTime: "now" };
    const rows = mapOracleInvalidObjects(
      [
        ["A", object.name, "PACKAGE", 51, "now"],
        ["A", object.name, "PACKAGE BODY", 52, "now"],
      ],
      "A",
    );
    expect(rows.map((row) => row.type)).toEqual(["PACKAGE", "PACKAGE BODY"]);
    expect(buildOracleObjectErrorsSql("A", object)).toContain("TYPE = 'PACKAGE BODY'");
    expect(buildOracleObjectErrorsSql("A", object)).toContain(`NAME = 'p"name'`);
    expect(buildOracleObjectIdentitySql("A", object)).toContain("OBJECT_ID");
    expect(buildOracleObjectIdentitySql("A", object)).toContain("STATUS = 'INVALID'");
  });

  it.each([
    ["oracle", "PROCEDURE", 'ALTER PROCEDURE "APP"."P" COMPILE REUSE SETTINGS'],
    ["oracle", "PACKAGE BODY", 'ALTER PACKAGE "APP"."P" COMPILE BODY REUSE SETTINGS'],
    ["oracle", "TYPE", 'ALTER TYPE "APP"."T" COMPILE SPECIFICATION REUSE SETTINGS'],
    ["oceanbase-oracle", "PROCEDURE", 'ALTER PROCEDURE "APP"."P" COMPILE'],
    ["oceanbase-oracle", "PACKAGE BODY", 'ALTER PACKAGE "APP"."P" COMPILE BODY'],
  ] as const)("builds the engine-specific compile command for %s %s", (dbType, type, expected) => {
    expect(buildOracleCompileSql(dbType, "APP", { name: type === "TYPE" ? "T" : "P", type })).toBe(expected);
  });

  it("treats only the exact PUBLIC dictionary owner as a public synonym", () => {
    expect(buildOracleCompileSql("oracle", "PUBLIC", { name: "EMP", type: "SYNONYM" })).toBe('ALTER PUBLIC SYNONYM "EMP" COMPILE');
    expect(buildOracleCompileSql("oracle", "Public", { name: "EMP", type: "SYNONYM" })).toBe('ALTER SYNONYM "Public"."EMP" COMPILE');
  });

  it("keeps unsupported OceanBase types visible without generating a write", () => {
    expect(oracleCompileUnsupportedReason("oceanbase-oracle", "VIEW")).toBe("unsupported-on-engine");
    expect(oracleCompileUnsupportedReason("oceanbase-oracle", "JAVA CLASS")).toBe("unsupported-type");
    expect(() => buildOracleCompileSql("oceanbase-oracle", "APP", { name: "V", type: "VIEW" })).toThrow();
  });

  it("maps numeric error locations and keeps the database sequence", () => {
    expect(
      mapOracleObjectErrors([
        [2, 18, 7, "second"],
        [1, 4, 3, "first"],
      ]),
    ).toEqual([
      { sequence: 1, line: 4, position: 3, text: "first" },
      { sequence: 2, line: 18, position: 7, text: "second" },
    ]);
  });
});
