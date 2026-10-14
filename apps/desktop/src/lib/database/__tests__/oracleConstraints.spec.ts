import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { executeOracleConstraintPlan, oracleConstraintDefinitionFromInfo, OracleConstraintMetadataError, prepareOracleConstraintPlan } from "../oracleConstraints";
import type { ConstraintInfo } from "@/types/database";
import type { OracleConstraintChange } from "@/lib/table/tableStructureEditorSql";

vi.mock("@/lib/backend/api", () => ({ executeQuery: vi.fn(), listConstraints: vi.fn(), buildTableStructureChangeSql: vi.fn() }));

const target = { connectionId: "fixture", database: "APP", schema: "APP", tableName: "CONTACTS", databaseType: "oracle" as const };
const state = { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false };
const uniqueInfo: ConstraintInfo = {
  name: "UQ_PAIR",
  constraint_type: "UNIQUE",
  columns: ["A", "B"],
  definition: "",
  ref_columns: [],
  enabled: true,
  valid: true,
  deferrable: false,
  initially_deferred: false,
  oracle_metadata: {
    metadataComplete: true,
    owner: "APP",
    constraintType: "U",
    status: "ENABLED",
    validated: "VALIDATED",
    deferrable: "NOT DEFERRABLE",
    deferred: "IMMEDIATE",
    rely: null,
    indexOwner: "APP",
    indexName: "UQ_PAIR",
    indexSharing: "exclusive",
    index: {
      metadataComplete: true,
      owner: "APP",
      tableOwner: "APP",
      tableName: "CONTACTS",
      indexType: "NORMAL",
      uniqueness: "UNIQUE",
      status: "VALID",
      partitioned: false,
      visibility: "VISIBLE",
      secondary: "N",
      columns: ["A", "B"],
      directions: ["ASC", "ASC"],
      keyIsExpression: [false, false],
      includedColumns: [],
    },
  },
};
const result = (rows: unknown[][]) => ({ execution_error: false, truncated: false, has_more: false, rows, error: undefined });

function makeChange(): OracleConstraintChange {
  const original = {
    kind: "unique" as const,
    definition: {
      name: "UQ_PAIR",
      columns: ["A", "B"],
      state,
      relyRaw: "NULL",
      index: {
        owner: "APP",
        name: "UQ_PAIR",
        tableOwner: "APP",
        tableName: "CONTACTS",
        sharing: "exclusive",
        metadataComplete: true,
        indexType: "NORMAL",
        uniqueness: "UNIQUE",
        status: "VALID",
        partitioned: false,
        visibility: "VISIBLE",
        secondary: "N",
        columns: ["A", "B"],
        directions: ["ASC", "ASC"],
        keyIsExpression: [false, false],
        includedColumns: [],
        newNameAvailable: false,
      },
    },
  };
  return { original, target: { kind: "unique", definition: { ...original.definition, columns: ["B", "A"] } } };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.listConstraints).mockResolvedValue([uniqueInfo]);
  vi.mocked(api.buildTableStructureChangeSql).mockResolvedValue({ statements: ['ALTER TABLE "APP"."CONTACTS" DROP CONSTRAINT "UQ_PAIR" KEEP INDEX;', 'ALTER TABLE "APP"."CONTACTS" ADD CONSTRAINT "UQ_PAIR" UNIQUE ("B", "A") USING INDEX "APP"."UQ_PAIR";'], warnings: [] } as never);
  vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => {
    if (sql.includes("SYS_CONTEXT")) return result([["APP", "APP", "ORCL"]]) as never;
    if (sql.includes("SYS.ALL_OBJECTS")) return result([["APP", "CONTACTS", 77]]) as never;
    if (sql.includes("SYS.ALL_TABLES")) return result([[null, "N"]]) as never;
    if (sql.includes("SYS.ALL_EXTERNAL_TABLES")) return result([]) as never;
    if (sql.includes("SYS.ALL_IND_COLUMNS"))
      return result([
        ["APP", "UQ_PAIR", "APP", "CONTACTS", "NORMAL", "UNIQUE", "VALID", "NO", "VISIBLE", "N", "A", "ASC", null],
        ["APP", "UQ_PAIR", "APP", "CONTACTS", "NORMAL", "UNIQUE", "VALID", "NO", "VISIBLE", "N", "B", "ASC", null],
      ]) as never;
    if (sql.includes("SYS.ALL_TAB_COLS"))
      return result([
        ["A", "NUMBER", 22, null, 0, "Y"],
        ["B", "NUMBER", 22, null, 0, "Y"],
      ]) as never;
    if (sql.includes("R_CONSTRAINT_NAME")) return result([]) as never;
    if (sql.includes("INDEX_NAME IS NOT NULL")) return result([]) as never;
    if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([["UQ_PAIR", "CONTACTS"]]) as never;
    if (sql.includes("SYS.ALL_INDEXES")) return result([["UQ_PAIR"]]) as never;
    return result([]) as never;
  });
});

describe("Oracle CHECK/UNIQUE constraint preflight", () => {
  it("checks duplicate composite keys including partial NULL keys and excludes all-NULL keys", async () => {
    const change = makeChange();
    const plan = await prepareOracleConstraintPlan(target, { tableName: target.tableName, columns: [], indexes: [] }, change);
    expect(plan.statements).toHaveLength(2);
    const duplicateScan = vi
      .mocked(api.executeQuery)
      .mock.calls.map((call) => String(call[2]))
      .find((sql) => sql.includes("GROUP BY"));
    expect(duplicateScan).toContain('WHERE "B" IS NOT NULL OR "A" IS NOT NULL');
    expect(duplicateScan).toContain('GROUP BY "B", "A" HAVING COUNT(*) > 1');
  });

  it("stops before returning a plan when duplicate target keys are found", async () => {
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => {
      if (sql.includes("SYS_CONTEXT")) return result([["APP", "APP", "ORCL"]]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result([["APP", "CONTACTS", 77]]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([[null, "N"]]) as never;
      if (sql.includes("SYS.ALL_EXTERNAL_TABLES")) return result([]) as never;
      if (sql.includes("SYS.ALL_IND_COLUMNS"))
        return result([
          ["APP", "UQ_PAIR", "APP", "CONTACTS", "NORMAL", "UNIQUE", "VALID", "NO", "VISIBLE", "N", "A", "ASC", null],
          ["APP", "UQ_PAIR", "APP", "CONTACTS", "NORMAL", "UNIQUE", "VALID", "NO", "VISIBLE", "N", "B", "ASC", null],
        ]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS"))
        return result([
          ["A", "NUMBER", 22, null, 0, "Y"],
          ["B", "NUMBER", 22, null, 0, "Y"],
        ]) as never;
      if (sql.includes("R_CONSTRAINT_NAME")) return result([]) as never;
      if (sql.includes("INDEX_NAME IS NOT NULL")) return result([]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([["UQ_PAIR", "CONTACTS"]]) as never;
      if (sql.includes("SYS.ALL_INDEXES")) return result([["UQ_PAIR"]]) as never;
      if (sql.includes("GROUP BY")) return result([[1]]) as never;
      return result([]) as never;
    });
    await expect(prepareOracleConstraintPlan(target, { tableName: target.tableName, columns: [], indexes: [] }, makeChange())).rejects.toMatchObject({ reason: "invalidData" } satisfies Partial<OracleConstraintMetadataError>);
  });

  it("fails closed when constraint metadata is incomplete", async () => {
    vi.mocked(api.listConstraints).mockResolvedValue([{ ...uniqueInfo, oracle_metadata: { ...uniqueInfo.oracle_metadata!, metadataComplete: false } }] as ConstraintInfo[]);
    await expect(prepareOracleConstraintPlan(target, { tableName: target.tableName, columns: [], indexes: [] }, makeChange())).rejects.toMatchObject({ reason: "incomplete" });
    expect(api.buildTableStructureChangeSql).not.toHaveBeenCalled();
  });

  it("allows an OceanBase UNIQUE creation without requiring a pre-existing paired index", async () => {
    const oceanbaseTarget = { ...target, databaseType: "oceanbase-oracle" as const };
    vi.mocked(api.listConstraints).mockResolvedValue([{ ...uniqueInfo, oracle_metadata: { ...uniqueInfo.oracle_metadata!, index: { ...uniqueInfo.oracle_metadata!.index!, secondary: null } } }] as ConstraintInfo[]);
    const change: OracleConstraintChange = {
      original: null,
      target: {
        kind: "unique",
        definition: {
          name: "UQ_NEW",
          columns: ["A", "B"],
          state,
          index: {
            owner: "APP",
            name: "",
            tableOwner: "APP",
            tableName: "CONTACTS",
            sharing: "exclusive",
            metadataComplete: false,
            indexType: "NORMAL",
            uniqueness: "UNIQUE",
            status: "VALID",
            partitioned: false,
            visibility: "VISIBLE",
            secondary: null,
            columns: ["A", "B"],
            directions: ["ASC", "ASC"],
            keyIsExpression: [false, false],
            includedColumns: [],
            newNameAvailable: false,
          },
        },
      },
      indexPolicy: "none",
    };
    const plan = await prepareOracleConstraintPlan(oceanbaseTarget, { tableName: target.tableName, columns: [], indexes: [] }, change);
    expect(plan.change.target?.kind).toBe("unique");
    expect(plan.change.target?.kind === "unique" && plan.change.target.definition.index.metadataComplete).toBe(false);
    expect(plan.statements).toHaveLength(2);
  });

  it("reads back an Oracle UNIQUE and its generated supporting-index name", async () => {
    let ddlApplied = false;
    let generatedIndexName = "";
    const createdInfo = (): ConstraintInfo => ({
      ...uniqueInfo,
      name: "UQ_NEW",
      columns: ["A"],
      oracle_metadata: {
        ...uniqueInfo.oracle_metadata!,
        indexName: generatedIndexName,
        index: { ...uniqueInfo.oracle_metadata!.index!, columns: ["A"], directions: ["ASC"], keyIsExpression: [false] },
      },
    });
    vi.mocked(api.listConstraints).mockImplementation(async () => (ddlApplied ? [createdInfo()] : [uniqueInfo]));
    vi.mocked(api.buildTableStructureChangeSql).mockResolvedValue({ statements: ['ALTER TABLE "APP"."CONTACTS" ADD CONSTRAINT "UQ_NEW" UNIQUE ("A");'], warnings: [] } as never);
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => {
      if (sql.startsWith("ALTER TABLE")) {
        ddlApplied = true;
        return result([]) as never;
      }
      if (sql.includes("SYS_CONTEXT")) return result([["APP", "APP", "ORCL"]]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result([["APP", "CONTACTS", 77]]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([[null, "N"]]) as never;
      if (sql.includes("SYS.ALL_EXTERNAL_TABLES")) return result([]) as never;
      if (sql.includes("SYS.ALL_IND_COLUMNS"))
        return result([
          ["APP", "UQ_PAIR", "APP", "CONTACTS", "NORMAL", "UNIQUE", "VALID", "NO", "VISIBLE", "N", "A", "ASC", null],
          ["APP", "UQ_PAIR", "APP", "CONTACTS", "NORMAL", "UNIQUE", "VALID", "NO", "VISIBLE", "N", "B", "ASC", null],
        ]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS"))
        return result([
          ["A", "NUMBER", 22, null, 0, "Y"],
          ["B", "NUMBER", 22, null, 0, "Y"],
        ]) as never;
      if (sql.includes("INDEX_NAME IS NOT NULL")) return result([]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([[ddlApplied ? "UQ_NEW" : "UQ_PAIR", "CONTACTS"]]) as never;
      if (sql.includes("SYS.ALL_INDEXES")) return result([[ddlApplied ? generatedIndexName : "UQ_PAIR"]]) as never;
      return result([]) as never;
    });
    const change: OracleConstraintChange = {
      original: null,
      target: {
        kind: "unique",
        definition: {
          name: "UQ_NEW",
          columns: ["A"],
          state,
          index: {
            owner: "APP",
            name: "",
            tableOwner: "APP",
            tableName: "CONTACTS",
            sharing: "exclusive",
            metadataComplete: false,
            indexType: "NORMAL",
            uniqueness: "UNIQUE",
            status: "VALID",
            partitioned: false,
            visibility: "VISIBLE",
            secondary: "N",
            columns: ["A"],
            directions: ["ASC"],
            keyIsExpression: [false],
            includedColumns: [],
            newNameAvailable: false,
          },
        },
      },
    };
    const plan = await prepareOracleConstraintPlan(target, { tableName: target.tableName, columns: [], indexes: [] }, change);
    generatedIndexName = plan.change.target?.kind === "unique" ? plan.change.target.definition.index.newName! : "";
    const outcome = await executeOracleConstraintPlan(plan, 0, () => true);
    expect(generatedIndexName).toBeTruthy();
    expect(outcome?.steps.map((step) => step.state)).toEqual(["committed"]);
    expect(outcome?.readbackError).toBeUndefined();
  });

  it("reads back a new OceanBase UNIQUE constraint as a paired object", async () => {
    let ddlApplied = false;
    const oceanbaseTarget = { ...target, databaseType: "oceanbase-oracle" as const };
    const createdInfo: ConstraintInfo = {
      ...uniqueInfo,
      name: "UQ_NEW",
      columns: ["A"],
      oracle_metadata: { ...uniqueInfo.oracle_metadata!, indexName: "UQ_NEW", index: { ...uniqueInfo.oracle_metadata!.index!, secondary: null, columns: ["A"], directions: ["ASC"], keyIsExpression: [false] } },
    };
    vi.mocked(api.listConstraints).mockImplementation(async () => (ddlApplied ? [createdInfo] : [{ ...uniqueInfo, oracle_metadata: { ...uniqueInfo.oracle_metadata!, index: { ...uniqueInfo.oracle_metadata!.index!, secondary: null } } }]));
    vi.mocked(api.buildTableStructureChangeSql).mockResolvedValue({ statements: ['ALTER TABLE "APP"."CONTACTS" ADD CONSTRAINT "UQ_NEW" UNIQUE ("A");'], warnings: [] } as never);
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => {
      if (sql.startsWith("ALTER TABLE")) {
        ddlApplied = true;
        return result([]) as never;
      }
      if (sql.includes("SYS_CONTEXT")) return result([["APP", "APP", "ORCL"]]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result([["APP", "CONTACTS", 77]]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([[null, "N"]]) as never;
      if (sql.includes("SYS.ALL_EXTERNAL_TABLES")) return result([]) as never;
      if (sql.includes("SYS.ALL_IND_COLUMNS")) return result([["APP", "UQ_NEW", "APP", "CONTACTS", "NORMAL", "UNIQUE", "VALID", "NO", "VISIBLE", "N", "A", "ASC", null]]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS"))
        return result([
          ["A", "NUMBER", 22, null, 0, "Y"],
          ["B", "NUMBER", 22, null, 0, "Y"],
        ]) as never;
      if (sql.includes("INDEX_NAME IS NOT NULL")) return result([]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([[ddlApplied ? "UQ_NEW" : "UQ_PAIR", "CONTACTS"]]) as never;
      if (sql.includes("SYS.ALL_INDEXES")) return result([["UQ_NEW"]]) as never;
      return result([]) as never;
    });
    const change: OracleConstraintChange = {
      original: null,
      target: {
        kind: "unique",
        definition: {
          name: "UQ_NEW",
          columns: ["A"],
          state,
          index: {
            owner: "APP",
            name: "",
            tableOwner: "APP",
            tableName: "CONTACTS",
            sharing: "exclusive",
            metadataComplete: false,
            indexType: "NORMAL",
            uniqueness: "UNIQUE",
            status: "VALID",
            partitioned: false,
            visibility: "VISIBLE",
            secondary: null,
            columns: ["A"],
            directions: ["ASC"],
            keyIsExpression: [false],
            includedColumns: [],
            newNameAvailable: false,
          },
        },
      },
      indexPolicy: "none",
    };
    const plan = await prepareOracleConstraintPlan(oceanbaseTarget, { tableName: target.tableName, columns: [], indexes: [] }, change);
    const outcome = await executeOracleConstraintPlan(plan, 0, () => true);
    expect(outcome?.steps.map((step) => step.state)).toEqual(["committed"]);
    expect(outcome?.readbackError).toBeUndefined();
  });

  it.each([
    { identity: "table object id", objectId: 78, databaseName: "ORCL" },
    { identity: "database name", objectId: 77, databaseName: "OTHER" },
  ])("stops after one DDL when the $identity changes mid-plan", async ({ objectId, databaseName }) => {
    const plan = await prepareOracleConstraintPlan(target, { tableName: target.tableName, columns: [], indexes: [] }, makeChange());
    let ddlStarted = false;
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => {
      if (sql.startsWith("ALTER TABLE")) {
        ddlStarted = true;
        return result([]) as never;
      }
      if (sql.includes("SYS_CONTEXT")) return result([["APP", "APP", ddlStarted ? databaseName : "ORCL"]]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result([["APP", "CONTACTS", ddlStarted ? objectId : 77]]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([[null, "N"]]) as never;
      if (sql.includes("SYS.ALL_EXTERNAL_TABLES")) return result([]) as never;
      if (sql.includes("SYS.ALL_IND_COLUMNS"))
        return result([
          ["APP", "UQ_PAIR", "APP", "CONTACTS", "NORMAL", "UNIQUE", "VALID", "NO", "VISIBLE", "N", "A", "ASC", null],
          ["APP", "UQ_PAIR", "APP", "CONTACTS", "NORMAL", "UNIQUE", "VALID", "NO", "VISIBLE", "N", "B", "ASC", null],
        ]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS"))
        return result([
          ["A", "NUMBER", 22, null, 0, "Y"],
          ["B", "NUMBER", 22, null, 0, "Y"],
        ]) as never;
      if (sql.includes("R_CONSTRAINT_NAME")) return result([]) as never;
      if (sql.includes("INDEX_NAME IS NOT NULL")) return result([]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([["UQ_PAIR", "CONTACTS"]]) as never;
      if (sql.includes("SYS.ALL_INDEXES")) return result([["UQ_PAIR"]]) as never;
      return result([]) as never;
    });
    const outcome = await executeOracleConstraintPlan(plan, 0, () => true);
    expect(outcome?.steps.map((step) => step.state)).toEqual(["committed", "notExecuted"]);
    expect(outcome?.readbackError).toContain("identity changed");
    expect(vi.mocked(api.executeQuery).mock.calls.filter((call) => String(call[2]).startsWith("ALTER TABLE"))).toHaveLength(1);
  });

  it("records a rejected DDL and never sends later statements", async () => {
    const plan = await prepareOracleConstraintPlan(target, { tableName: target.tableName, columns: [], indexes: [] }, makeChange());
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => {
      if (sql.startsWith("ALTER TABLE")) return { ...result([]), execution_error: true, error: { detail: "database rejected" } } as never;
      if (sql.includes("SYS_CONTEXT")) return result([["APP", "APP", "ORCL"]]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result([["APP", "CONTACTS", 77]]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([[null, "N"]]) as never;
      if (sql.includes("SYS.ALL_EXTERNAL_TABLES")) return result([]) as never;
      if (sql.includes("SYS.ALL_IND_COLUMNS"))
        return result([
          ["APP", "UQ_PAIR", "APP", "CONTACTS", "NORMAL", "UNIQUE", "VALID", "NO", "VISIBLE", "N", "A", "ASC", null],
          ["APP", "UQ_PAIR", "APP", "CONTACTS", "NORMAL", "UNIQUE", "VALID", "NO", "VISIBLE", "N", "B", "ASC", null],
        ]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS"))
        return result([
          ["A", "NUMBER", 22, null, 0, "Y"],
          ["B", "NUMBER", 22, null, 0, "Y"],
        ]) as never;
      if (sql.includes("R_CONSTRAINT_NAME")) return result([]) as never;
      if (sql.includes("INDEX_NAME IS NOT NULL")) return result([]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([["UQ_PAIR", "CONTACTS"]]) as never;
      if (sql.includes("SYS.ALL_INDEXES")) return result([["UQ_PAIR"]]) as never;
      return result([]) as never;
    });
    const outcome = await executeOracleConstraintPlan(plan, 0, () => true);
    expect(outcome?.steps.map((step) => step.state)).toEqual(["rejected", "notExecuted"]);
    expect(outcome?.steps[0]?.error).toContain("database rejected");
    expect(outcome?.steps[0]?.error).toContain("Original definition remains after readback.");
    expect(vi.mocked(api.executeQuery).mock.calls.filter((call) => String(call[2]).startsWith("ALTER TABLE"))).toHaveLength(1);
  });

  it("builds a manual recovery candidate after DROP commits and ADD is rejected", async () => {
    const plan = await prepareOracleConstraintPlan(target, { tableName: target.tableName, columns: [], indexes: [] }, makeChange());
    let dropped = false;
    vi.mocked(api.listConstraints).mockImplementation(async () => (dropped ? [] : [uniqueInfo]));
    let recoveryBuilt = false;
    let applyBuildCalls = 0;
    vi.mocked(api.buildTableStructureChangeSql).mockImplementation(async () => {
      if (++applyBuildCalls === 1) return { statements: plan.statements, warnings: [] } as never;
      recoveryBuilt = true;
      return { statements: ["ALTER TABLE recovery ADD constraint"], warnings: [] } as never;
    });
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => {
      if (sql.startsWith("ALTER TABLE")) {
        if (sql.includes("DROP CONSTRAINT")) {
          dropped = true;
          return result([]) as never;
        }
        return { ...result([]), execution_error: true, error: { detail: "ADD rejected" } } as never;
      }
      if (sql.includes("SYS_CONTEXT")) return result([["APP", "APP", "ORCL"]]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result([["APP", "CONTACTS", 77]]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([[null, "N"]]) as never;
      if (sql.includes("SYS.ALL_EXTERNAL_TABLES")) return result([]) as never;
      if (sql.includes("SYS.ALL_IND_COLUMNS"))
        return dropped
          ? (result([]) as never)
          : (result([
              ["APP", "UQ_PAIR", "APP", "CONTACTS", "NORMAL", "UNIQUE", "VALID", "NO", "VISIBLE", "N", "A", "ASC", null],
              ["APP", "UQ_PAIR", "APP", "CONTACTS", "NORMAL", "UNIQUE", "VALID", "NO", "VISIBLE", "N", "B", "ASC", null],
            ]) as never);
      if (sql.includes("SYS.ALL_TAB_COLS"))
        return result([
          ["A", "NUMBER", 22, null, 0, "Y"],
          ["B", "NUMBER", 22, null, 0, "Y"],
        ]) as never;
      if (sql.includes("R_CONSTRAINT_NAME")) return result([]) as never;
      if (sql.includes("INDEX_NAME IS NOT NULL")) return result([]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result(dropped ? [] : [["UQ_PAIR", "CONTACTS"]]) as never;
      if (sql.includes("SYS.ALL_INDEXES")) return result([["UQ_PAIR"]]) as never;
      return result([]) as never;
    });
    const outcome = await executeOracleConstraintPlan(plan, 0, () => true);
    expect(outcome?.steps.map((step) => step.state)).toEqual(["committed", "rejected"]);
    expect(recoveryBuilt).toBe(true);
  });

  it("does not send the next DDL when the fixed connection generation changes", async () => {
    const plan = await prepareOracleConstraintPlan(target, { tableName: target.tableName, columns: [], indexes: [] }, makeChange());
    let currentChecks = 0;
    const outcome = await executeOracleConstraintPlan(plan, 0, () => ++currentChecks < 3);
    expect(outcome?.steps.map((step) => step.state)).toEqual(["committed", "notExecuted"]);
    expect(outcome?.readbackError).toContain("Connection or target changed");
    expect(vi.mocked(api.executeQuery).mock.calls.filter((call) => String(call[2]).startsWith("ALTER TABLE"))).toHaveLength(1);
  });

  it("accepts a CHECK expression readback with equivalent Oracle whitespace normalization", async () => {
    let ddlApplied = false;
    const checkInfo: ConstraintInfo = {
      name: "CK_POSITIVE",
      constraint_type: "CHECK",
      columns: [],
      definition: '"A">=1',
      ref_columns: [],
      enabled: true,
      valid: true,
      deferrable: false,
      initially_deferred: false,
      oracle_metadata: { metadataComplete: true, owner: "APP", constraintType: "C", status: "ENABLED", validated: "VALIDATED", deferrable: "NOT DEFERRABLE", deferred: "IMMEDIATE", rely: null, indexOwner: null, indexName: null, indexSharing: null, index: null },
    };
    vi.mocked(api.listConstraints).mockImplementation(async () => (ddlApplied ? [checkInfo] : []));
    vi.mocked(api.buildTableStructureChangeSql).mockResolvedValue({ statements: ['ALTER TABLE "APP"."CONTACTS" ADD CONSTRAINT "CK_POSITIVE" CHECK ("A" >= 1);'], warnings: [] } as never);
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => {
      if (sql.startsWith("ALTER TABLE")) {
        ddlApplied = true;
        return result([]) as never;
      }
      if (sql.includes("SYS_CONTEXT")) return result([["APP", "APP", "ORCL"]]) as never;
      if (sql.includes("SYS.ALL_OBJECTS")) return result([["APP", "CONTACTS", 77]]) as never;
      if (sql.includes("SYS.ALL_TABLES")) return result([[null, "N"]]) as never;
      if (sql.includes("SYS.ALL_EXTERNAL_TABLES")) return result([]) as never;
      if (sql.includes("SYS.ALL_IND_COLUMNS"))
        return result([
          ["APP", "UQ_PAIR", "APP", "CONTACTS", "NORMAL", "UNIQUE", "VALID", "NO", "VISIBLE", "N", "A", "ASC", null],
          ["APP", "UQ_PAIR", "APP", "CONTACTS", "NORMAL", "UNIQUE", "VALID", "NO", "VISIBLE", "N", "B", "ASC", null],
        ]) as never;
      if (sql.includes("SYS.ALL_TAB_COLS"))
        return result([
          ["A", "NUMBER", 22, null, 0, "Y"],
          ["B", "NUMBER", 22, null, 0, "Y"],
        ]) as never;
      if (sql.includes("INDEX_NAME IS NOT NULL")) return result([]) as never;
      if (sql.includes("SYS.ALL_CONSTRAINTS")) return result([[ddlApplied ? "CK_POSITIVE" : "UQ_PAIR", "CONTACTS"]]) as never;
      if (sql.includes("SYS.ALL_INDEXES")) return result([["UQ_PAIR"]]) as never;
      return result([]) as never;
    });
    const change: OracleConstraintChange = { original: null, target: { kind: "check", definition: { name: "CK_POSITIVE", expression: '"A" >= 1', state } } };
    const plan = await prepareOracleConstraintPlan(target, { tableName: target.tableName, columns: [], indexes: [] }, change);
    const outcome = await executeOracleConstraintPlan(plan, 0, () => true);
    expect(outcome?.steps.map((step) => step.state)).toEqual(["committed"]);
    expect(outcome?.readbackError).toBeUndefined();
  });

  it("converts disabled UNIQUE constraint with SQL NULL index into no-index definition", () => {
    const disabledInfo: ConstraintInfo = {
      name: "UQ_DISABLED_NO_IDX",
      constraint_type: "UNIQUE",
      columns: ["EMAIL"],
      definition: "",
      ref_columns: [],
      enabled: false,
      valid: false,
      deferrable: false,
      initially_deferred: false,
      oracle_metadata: {
        metadataComplete: true,
        owner: "APP",
        constraintType: "U",
        status: "DISABLED",
        validated: "NOT VALIDATED",
        deferrable: "NOT DEFERRABLE",
        deferred: "IMMEDIATE",
        rely: null,
        indexOwner: null,
        indexName: null,
        indexSharing: null,
        index: null,
      },
    };
    const definition = oracleConstraintDefinitionFromInfo(disabledInfo, target);
    expect(definition.kind).toBe("unique");
    if (definition.kind === "unique") {
      expect(definition.definition.name).toBe("UQ_DISABLED_NO_IDX");
      expect(definition.definition.state.enabled).toBe(false);
      expect(definition.definition.index.name).toBe("");
    }
  });
});
