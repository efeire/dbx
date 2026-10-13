import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareOracleViewRename, executeOracleViewRename } from "@/lib/table/oracleViewRename";

const api = vi.hoisted(() => ({ executeQuery: vi.fn(), parseOracleObjectName: vi.fn(), buildOracleViewRenameSource: vi.fn(), deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/backend/api", () => api);

const target = { connectionId: "c", database: "OWNER", schema: "OWNER", oldName: "OLD", newName: "NEW" };
const result = (rows: unknown[][]) => ({ columns: [], rows, affected_rows: 0, execution_time_ms: 0 });
let graph: unknown[][];
let statements: string[];
let renamed: boolean;

beforeEach(() => {
  graph = [];
  statements = [];
  renamed = false;
  vi.clearAllMocks();
  api.parseOracleObjectName.mockImplementation(async (name) => name.toUpperCase());
  api.buildOracleViewRenameSource.mockImplementation(async ({ source, targetViewName }) => ({ source, fingerprint: targetViewName || source }));
  api.executeQuery.mockImplementation(async (_connection, _database, sql: string) => {
    statements.push(sql);
    if (sql.includes("SYS_CONTEXT")) return result([["OWNER", "OWNER"]]);
    if (sql.includes("DEPENDENCIES")) return result(graph);
    if (sql.includes("ALL_TAB_PRIVS") || sql.includes("ALL_COL_PRIVS")) return result([]);
    if (sql.includes("USER_OBJECTS")) {
      if (sql.includes("OBJECT_NAME='NEW'")) return result(renamed ? [["VIEW", "VALID"]] : []);
      return result(renamed ? [] : [["VIEW", "VALID"]]);
    }
    if (sql.includes("DBMS_LOB.GETLENGTH")) return result([[3]]);
    if (sql.includes("DBMS_LOB.SUBSTR")) return result([[renamed ? "NEW" : "OLD"]]);
    if (sql.startsWith("RENAME")) {
      renamed = true;
      return result([]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
});

describe("OceanBase view rename plan", () => {
  it("keeps the visible-scope limitation even when there are no visible dependencies", async () => {
    const plan = await prepareOracleViewRename(target);
    expect(plan.statements).toEqual(['RENAME "OLD" TO "NEW";']);
    expect(plan.coverage).toBe("visible-only");
    expect(statements.some((sql) => sql.startsWith("RENAME"))).toBe(false);
  });

  it("blocks a visible foreign dependency before any mutation", async () => {
    graph = [["OTHER", "DEP", "VIEW", null]];
    await expect(prepareOracleViewRename(target)).rejects.toThrow(/OTHER/);
    expect(renamed).toBe(false);
  });

  it("rejects truncated metadata instead of treating it as a complete graph", async () => {
    api.executeQuery.mockResolvedValue({ ...result([]), truncated: true });
    await expect(prepareOracleViewRename(target)).rejects.toThrow(/incomplete/i);
    expect(renamed).toBe(false);
  });

  it("invalidates the preview if a dependency appears before dispatch", async () => {
    const plan = await prepareOracleViewRename(target);
    graph = [["OTHER", "DEP", "VIEW", null]];
    await expect(executeOracleViewRename(plan)).rejects.toThrow(/OTHER|changed/i);
    expect(renamed).toBe(false);
  });

  it("checks metadata identity before using an unqualified RENAME", async () => {
    api.executeQuery.mockResolvedValue(result([["SOMEONE_ELSE", "OWNER"]]));
    await expect(prepareOracleViewRename(target)).rejects.toThrow(/owner/i);
    expect(renamed).toBe(false);
  });

  it("does not dispatch when the UI target changes during preflight", async () => {
    const plan = await prepareOracleViewRename(target);
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await expect(executeOracleViewRename(plan, isCurrent)).rejects.toThrow(/changed/i);
    expect(renamed).toBe(false);
  });

  it("reads back the new definition, validity, grants and disappearance of the old name", async () => {
    const plan = await prepareOracleViewRename({ ...target, connectionId: "success" });
    await executeOracleViewRename(plan);
    expect(renamed).toBe(true);
    expect(statements.filter((sql) => sql.startsWith("RENAME"))).toHaveLength(1);
    expect(statements.at(-1)).toContain("OBJECT_NAME='OLD'");
  });

  it("keeps a dispatched failure distinct from a preflight rejection", async () => {
    const plan = await prepareOracleViewRename({ ...target, connectionId: "unknown" });
    const implementation = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => {
      if (String(args[2]).startsWith("RENAME")) throw new Error("Connection closed before the reply");
      return implementation(...args);
    });
    await expect(executeOracleViewRename(plan)).rejects.toMatchObject({ completed: [], uncertain: "NEW", plan });
    expect(renamed).toBe(false);
  });

  it("falls back only for a denied dictionary and retains the visible-scope limitation", async () => {
    const implementation = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => {
      if (String(args[2]).includes("SYS.DBA_DEPENDENCIES")) throw new Error("ORA-00942: table or view does not exist");
      return implementation(...args);
    });
    const plan = await prepareOracleViewRename(target);
    expect(plan.coverage).toBe("visible-only");
    expect(statements.some((sql) => sql.includes("SYS.ALL_DEPENDENCIES"))).toBe(true);
  });

  it("does not hide a known foreign dependency behind a fallback query", async () => {
    graph = [["OTHER", "DEP", "VIEW", null]];
    await expect(prepareOracleViewRename(target)).rejects.toThrow(/OTHER/);
    expect(statements.some((sql) => sql.includes("SYS.ALL_DEPENDENCIES"))).toBe(false);
  });

  it("rejects a smaller dependency graph after preview", async () => {
    let visible = true;
    const implementation = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => {
      const sql = String(args[2]);
      if (sql.includes("DEPENDENCIES")) return result(visible && sql.includes("REFERENCED_NAME='OLD'") ? [["OWNER", "DEP", "VIEW", null]] : []);
      return implementation(...args);
    });
    const plan = await prepareOracleViewRename(target);
    expect(plan.views.map((view) => view.name)).toEqual(["OLD", "DEP"]);
    visible = false;
    await expect(executeOracleViewRename(plan)).rejects.toThrow(/changed/i);
    expect(renamed).toBe(false);
  });

  it("refuses dependency cycles", async () => {
    graph = [["OWNER", "OLD", "VIEW", null]];
    await expect(prepareOracleViewRename(target)).rejects.toThrow(/cyclic/i);
    expect(renamed).toBe(false);
  });

  it("uses the actual column-permission dictionary owner column", async () => {
    const implementation = api.executeQuery.getMockImplementation()!;
    api.executeQuery.mockImplementation(async (...args) => {
      if (String(args[2]).includes("ALL_COL_PRIVS") && String(args[2]).includes("TABLE_SCHEMA")) throw new Error("ORA-00904: invalid identifier 'TABLE_SCHEMA'");
      return implementation(...args);
    });
    await expect(prepareOracleViewRename(target)).resolves.toMatchObject({ canonicalNewName: "NEW" });
  });
});

function dependencyFixture(options: { drift?: boolean; failSecond?: boolean } = {}) {
  const sources = new Map([
    ["OLD", "CREATE VIEW OLD AS SELECT 42 X FROM DUAL"],
    ["DEP", "CREATE VIEW DEP AS SELECT /*+ FULL(OLD) */ * FROM OLD"],
    ["DEP2", "CREATE VIEW DEP2 AS SELECT * FROM DEP"],
  ]);
  const writes: string[] = [];
  const valid = new Set(["OLD", "DEP", "DEP2"]);
  api.buildOracleViewRenameSource.mockImplementation(async ({ source, oldName, newName, targetViewName }) => {
    let rewritten = source.replaceAll(new RegExp(`\\b${oldName}\\b`, "g"), newName);
    if (targetViewName) rewritten = rewritten.replace(/^CREATE VIEW \w+/, `CREATE VIEW ${targetViewName}`);
    return { source: rewritten, fingerprint: rewritten.replace(/\/\*.*?\*\//g, "") };
  });
  api.executeQuery.mockImplementation(async (_connection, _database, sql: string) => {
    if (sql.includes("SYS_CONTEXT")) return result([["OWNER", "OWNER"]]);
    if (sql.includes("DEPENDENCIES")) return result(sql.includes("REFERENCED_NAME='OLD'") ? [["OWNER", "DEP", "VIEW", null]] : sql.includes("REFERENCED_NAME='DEP'") ? [["OWNER", "DEP2", "VIEW", null]] : []);
    if (sql.includes("ALL_TAB_PRIVS") || sql.includes("ALL_COL_PRIVS")) return result([]);
    if (sql.includes("USER_OBJECTS")) {
      const name = /OBJECT_NAME='([^']+)'/.exec(sql)![1];
      return result(sources.has(name) ? [["VIEW", valid.has(name) ? "VALID" : "INVALID"]] : []);
    }
    if (sql.includes("DBMS_LOB")) {
      const name = /GET_DDL\('VIEW','([^']+)'/.exec(sql)![1];
      const source = sources.get(name)!;
      return result([[sql.includes("GETLENGTH") ? source.length : source]]);
    }
    writes.push(sql);
    if (sql.startsWith("RENAME")) {
      sources.set("NEW", sources.get("OLD")!.replace("VIEW OLD", "VIEW NEW"));
      sources.delete("OLD");
      valid.clear();
      valid.add("NEW");
      if (options.drift) sources.set("DEP", sources.get("DEP")!.replace("FULL(OLD)", "INDEX(OLD)"));
      return result([]);
    }
    if (sql.startsWith("CREATE VIEW")) {
      const name = /^CREATE VIEW (\w+)/.exec(sql)![1];
      if (name === "DEP2" && options.failSecond) throw new Error("DDL reply lost");
      sources.set(name, sql);
      valid.add(name);
      return result([]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { sources, writes, valid };
}

describe("view dependency execution", () => {
  it("rebuilds two levels in order and verifies their final state", async () => {
    const fixture = dependencyFixture();
    const plan = await prepareOracleViewRename({ ...target, connectionId: "two-level-success" });
    await executeOracleViewRename(plan);
    expect(fixture.writes).toEqual(plan.statements);
    expect([...fixture.valid]).toEqual(["NEW", "DEP", "DEP2"]);
    expect(fixture.sources.get("DEP")).toContain("FROM NEW");
  });

  it("reports confirmed steps and stops after an uncertain dependent rebuild", async () => {
    const fixture = dependencyFixture({ failSecond: true });
    const plan = await prepareOracleViewRename({ ...target, connectionId: "two-level-failure" });
    await expect(executeOracleViewRename(plan)).rejects.toMatchObject({ completed: ["NEW", "DEP"], uncertain: "DEP2", plan });
    expect(fixture.writes).toHaveLength(3);
    expect(fixture.valid.has("DEP2")).toBe(false);
  });

  it("preserves a concurrent hint-only edit before overwriting a dependent", async () => {
    const fixture = dependencyFixture({ drift: true });
    const plan = await prepareOracleViewRename({ ...target, connectionId: "hint-drift" });
    await expect(executeOracleViewRename(plan)).rejects.toMatchObject({ completed: ["NEW"], uncertain: "DEP" });
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.sources.get("DEP")).toContain("INDEX(OLD)");
  });
});
