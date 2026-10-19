import { describe, expect, it } from "vitest";
import { buildOceanbaseKillConnectionBlock, buildOceanbaseLockDetailsSql, buildOceanbaseSessionListSql, buildOracleKillSessionBlock, buildOracleLockDetailsSql, buildOracleSessionListSql, mapOceanbaseSessions, mapOracleSessions, oracleMajorVersion } from "../oracleSessionManagement";

describe("Oracle session identity and SQL", () => {
  it("parses the reported Oracle major version and rejects unknown formats", () => {
    expect(oracleMajorVersion("19.0.0.0.0")).toBe(19);
    expect(oracleMajorVersion(" 11.2.0.4.0 ")).toBe(11);
    expect(oracleMajorVersion("Oracle Database 19c")).toBeNull();
  });

  it("scopes modern sessions to the current container and keeps legacy SQL separate", () => {
    expect(buildOracleSessionListSql(false)).toContain("s.CON_ID = TO_NUMBER(SYS_CONTEXT('USERENV','CON_ID'))");
    expect(buildOracleSessionListSql(true)).not.toContain("CON_ID");
  });

  it("preserves complete Oracle target identity and permits non-CDB CON_ID zero", () => {
    const [target] = mapOracleSessions({ rows: [["17", "8", "2", "0", "APP", "INACTIVE", "host", "client", null, null, null, null, "99", "2026-10-20 10:00:00"]] });
    expect(buildOracleKillSessionBlock(target!, false)).toContain("CON_ID = 0");
    expect(buildOracleKillSessionBlock(target!, false)).toContain("SID = 17 AND SERIAL# = 8 AND INST_ID = 2 AND CON_ID = 0");
    expect(buildOracleKillSessionBlock(target!, false)).toContain("ALTER SYSTEM KILL SESSION ''17,8,@2'' IMMEDIATE");
    expect(buildOracleLockDetailsSql(target!, false)).toContain("l.CON_ID = 0");
  });

  it("rejects unsafe Oracle target identities", () => {
    const [target] = mapOracleSessions({ rows: [["9007199254740993", "8", "2", "1", "APP", "INACTIVE", "", "", null, null, null, null, "99", "2026-10-20 10:00:00"]] });
    expect(() => buildOracleKillSessionBlock(target!, false)).toThrow("Invalid SID");
  });
});

describe("OceanBase session identity and SQL", () => {
  const row = {
    id: "9007199254740993",
    user: "APP'X",
    tenant: "tenant_a",
    proxySessionId: null,
    serverIp: "127.0.0.1",
    serverPort: "2882",
  };

  it("maps large IDs losslessly, scopes the list to the active tenant, and reads own identity", () => {
    expect(mapOceanbaseSessions({ rows: [[row.id, row.user, row.tenant, "host", "db", "Query", "2", "active", "SELECT 1", null, row.serverIp, row.serverPort]] })[0]?.id).toBe(row.id);
    expect(buildOceanbaseSessionListSql()).toContain("TENANT = (SELECT TENANT FROM GV$OB_SESSION");
  });

  it("uses one guarded KILL CONNECTION block with exact user, tenant, node and decimal ID", () => {
    const sql = buildOceanbaseKillConnectionBlock(row);
    expect(sql).toContain(`ID = ${row.id} AND USER = 'APP''X' AND TENANT = 'tenant_a'`);
    expect(sql).toContain("SVR_IP = '127.0.0.1' AND SVR_PORT = 2882");
    expect(sql).toContain(`EXECUTE IMMEDIATE 'KILL CONNECTION ${row.id}'`);
    expect(sql).toContain("Cannot terminate the executing management session");
  });

  it("rejects proxy sessions and includes same-resource lock rows within the target tenant", () => {
    expect(() => buildOceanbaseKillConnectionBlock({ ...row, proxySessionId: "88" })).toThrow("Unsupported");
    const sql = buildOceanbaseLockDetailsSql({ ...row, tenantId: 7 });
    expect(sql).toContain("t.ID3 = l.ID3");
    expect(sql).toContain("p.USER AS SESSION_USER");
    expect(sql).toContain("TENANT_ID = (SELECT TENANT_ID FROM GV$OB_SESSION");
  });
});
