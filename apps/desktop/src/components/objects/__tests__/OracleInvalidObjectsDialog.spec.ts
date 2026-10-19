// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import OracleInvalidObjectsDialog from "@/components/objects/OracleInvalidObjectsDialog.vue";

const mocks = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  compileFinished: vi.fn(),
  guard: vi.fn(),
  executeAllowed: true,
  guardGate: null as null | (() => Promise<void>),
  identityChangedAfterGuard: false,
  failStatusReadback: false,
  statusReadbackErrorMode: "throw" as "throw" | "result",
  statusMissingAfterCompile: false,
  truncateBatchStatusBefore: false,
  truncateBatchStatusAfter: false,
  truncateSingleIdentity: false,
  truncateSingleStatusAfter: false,
  compileGate: null as null | (() => Promise<void>),
  batchStatusGate: null as null | (() => Promise<void>),
  batchPageGate: null as null | (() => Promise<void>),
  definiteBatchFailureName: "",
  definiteBatchFailureMode: "result" as "result" | "throw",
  batchObjects: [] as unknown[][],
  batchMode: false,
  batchStatuses: {} as Record<string, string>,
  missingBatchStatusName: "",
  batchObjectIds: {} as Record<string, string>,
  batchTimes: {} as Record<string, string>,
  failBatchPage: false,
  failRemainingAfterWrite: false,
  batchDdlSubmitted: false,
  failBatchCompileName: "",
  unknownBatchCompileName: "",
  unknownBatchCompileResultName: "",
  truncatedErrors: false,
  failCompile: false,
  failInvalidObjectList: false,
  postCompileListGate: null as null | (() => Promise<void>),
}));

function passthrough(tag: string): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
}

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => (values === undefined ? key : `${key}:${Object.values(values).join(",")}`) }) }));
vi.mock("@lucide/vue", () => {
  const Icon = passthrough("span");
  return { AlertTriangle: Icon, Loader2: Icon, RefreshCw: Icon, Wrench: Icon };
});
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: passthrough("div"), DialogContent: passthrough("div"), DialogFooter: passthrough("div"), DialogHeader: passthrough("div"), DialogTitle: passthrough("div") }));
vi.mock("@/lib/backend/api", () => ({ executeQuery: mocks.executeQuery, closeClientConnectionSession: mocks.closeClientConnectionSession }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({
  executeWithProductionSqlGuard: async (options: { execute: () => Promise<unknown> }) => {
    mocks.guard(options);
    if (mocks.guardGate) await mocks.guardGate();
    return mocks.executeAllowed ? options.execute() : undefined;
  },
}));

const connection: ConnectionConfig = { id: "oracle-invalid-1", name: "Oracle", db_type: "oracle", host: "localhost", port: 1521, username: "APP", password: "" };
let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;
let compiled = false;
let compileStatus = "VALID";
let objectIdAfterCompile = "9";
let errorsReloadedAfterCompile = false;

beforeEach(() => {
  compiled = false;
  compileStatus = "VALID";
  objectIdAfterCompile = "9";
  errorsReloadedAfterCompile = false;
  mocks.guardGate = null;
  mocks.identityChangedAfterGuard = false;
  mocks.failStatusReadback = false;
  mocks.statusReadbackErrorMode = "throw";
  mocks.statusMissingAfterCompile = false;
  mocks.truncateBatchStatusBefore = false;
  mocks.truncateBatchStatusAfter = false;
  mocks.truncateSingleIdentity = false;
  mocks.truncateSingleStatusAfter = false;
  mocks.compileGate = null;
  mocks.batchStatusGate = null;
  mocks.batchPageGate = null;
  mocks.definiteBatchFailureName = "";
  mocks.definiteBatchFailureMode = "result";
  mocks.batchObjects = [
    ["APP", "P_OK", "PROCEDURE", "101", "2026-10-20 09:00:00"],
    ["APP", "P_BAD", "PROCEDURE", "102", "2026-10-20 09:00:00"],
    ["APP", "V_SKIP", "VIEW", "103", "2026-10-20 09:00:00"],
  ];
  mocks.batchMode = false;
  mocks.batchStatuses = {};
  mocks.missingBatchStatusName = "";
  mocks.batchObjectIds = {};
  mocks.batchTimes = {};
  mocks.failBatchPage = false;
  mocks.failRemainingAfterWrite = false;
  mocks.batchDdlSubmitted = false;
  mocks.failBatchCompileName = "";
  mocks.unknownBatchCompileName = "";
  mocks.unknownBatchCompileResultName = "";
  mocks.truncatedErrors = false;
  mocks.failCompile = false;
  mocks.failInvalidObjectList = false;
  mocks.postCompileListGate = null;
  mocks.executeAllowed = true;
  mocks.guard.mockReset();
  mocks.closeClientConnectionSession.mockReset().mockResolvedValue(undefined);
  mocks.compileFinished.mockReset();
  mocks.executeQuery.mockReset().mockImplementation(async (_connectionId: string, _database: string, sql: string) => {
    if (sql.includes("OBJECT_ID >")) {
      if (mocks.batchPageGate) {
        const gate = mocks.batchPageGate;
        mocks.batchPageGate = null;
        await gate();
      }
      mocks.batchMode = true;
      const cursor = BigInt(sql.match(/OBJECT_ID > (\d+)/)?.[1] ?? "0");
      if (mocks.failRemainingAfterWrite && mocks.batchDdlSubmitted) throw new Error("remaining list denied");
      if (mocks.failBatchPage && cursor > 0n) throw new Error("middle page failed");
      return { columns: ["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID", "LAST_DDL_TIME"], rows: mocks.batchObjects.filter((row) => BigInt(String(row[3])) > cursor).slice(0, 500) };
    }
    if (sql.includes("FROM (SELECT OWNER")) {
      if (compiled && mocks.postCompileListGate) {
        const gate = mocks.postCompileListGate;
        mocks.postCompileListGate = null;
        await gate();
      }
      if (mocks.failInvalidObjectList) throw new Error("ORA-01031: insufficient privileges");
      return { columns: [], rows: !compiled || compileStatus === "INVALID" ? [["APP", "P_BAD", "PROCEDURE", 9, compiled ? "2026-10-20 09:01:00" : "2026-10-20 09:00:00"]] : [] };
    }
    if (sql.includes("FROM ALL_ERRORS")) {
      if (compiled) errorsReloadedAfterCompile = true;
      return { columns: [], rows: mocks.truncatedErrors ? Array.from({ length: 1000 }, (_, index) => [index + 1, index + 1, 1, "invalid identifier"]) : [[1, 3, 7, compiled ? "still invalid after compile" : "invalid identifier"]] };
    }
    if (sql.includes("STATUS = 'INVALID'")) return { columns: [], rows: [[mocks.identityChangedAfterGuard ? 10 : 9, "2026-10-20 09:00:00"]], truncated: mocks.truncateSingleIdentity };
    if (sql.includes("ALTER PROCEDURE") && !mocks.batchMode) {
      if (mocks.failCompile) throw new Error("ORA-01031: insufficient privileges");
      if (mocks.compileGate) await mocks.compileGate();
      compiled = true;
      return { columns: [], rows: [] };
    }
    if (sql.startsWith("ALTER ")) {
      const name = sql.match(/\."([^"]+)"/)?.[1] ?? "";
      const rejectedBackendError = {
        version: 1,
        code: "DBX-JDBC-4001",
        messageKey: "backendErrors.jdbc.sqlFailed",
        messageParams: {},
        source: "jdbcAgent",
        operationOutcome: "not_started",
        detail: "Request rejected before database execution",
      };
      if (name === mocks.definiteBatchFailureName) {
        if (mocks.definiteBatchFailureMode === "throw") throw { name: "BackendErrorException", backendError: rejectedBackendError };
        return { columns: ["Error"], rows: [["request rejected"]], execution_error: true, error: rejectedBackendError };
      }
      if (name === mocks.unknownBatchCompileName) throw new Error("connection lost during DDL");
      if (name === mocks.unknownBatchCompileResultName) return { columns: ["Error"], rows: [["result unavailable"]], execution_error: true, error: { detail: "result unavailable", operationOutcome: "unknown" } };
      if (name === mocks.failBatchCompileName) return { columns: ["Error"], rows: [["ORA-01031: insufficient privileges"]], execution_error: true, error: { detail: "ORA-01031: insufficient privileges", operationOutcome: "not_started" } };
      if (mocks.compileGate) await mocks.compileGate();
      mocks.batchStatuses[name] = name === "P_BAD" ? "INVALID" : "VALID";
      mocks.batchDdlSubmitted = true;
      return { columns: [], rows: [] };
    }
    if (sql.includes("STATUS FROM ALL_OBJECTS")) {
      if (mocks.batchMode) {
        const name = sql.match(/OBJECT_NAME = '([^']+)'/)?.[1] ?? "";
        if (mocks.batchStatusGate) {
          const gate = mocks.batchStatusGate;
          mocks.batchStatusGate = null;
          await gate();
        }
        const item = mocks.batchObjects.find((row) => row[1] === name);
        if (!item || name === mocks.missingBatchStatusName) return { columns: ["OBJECT_ID", "LAST_DDL_TIME", "STATUS"], rows: [] };
        return {
          columns: ["OBJECT_ID", "LAST_DDL_TIME", "STATUS"],
          rows: [[mocks.batchObjectIds[name] ?? item[3], mocks.batchTimes[name] ?? item[4], mocks.batchStatuses[name] ?? "INVALID"]],
          truncated: mocks.batchDdlSubmitted ? mocks.truncateBatchStatusAfter : mocks.truncateBatchStatusBefore,
        };
      }
      if (compiled) {
        if (mocks.failStatusReadback) {
          if (mocks.statusReadbackErrorMode === "result") return { columns: ["Error"], rows: [["ORA-01031: insufficient privileges"]], execution_error: true, error: { detail: "ORA-01031: insufficient privileges" } };
          throw new Error("ORA-01031: insufficient privileges while reading status");
        }
        return { columns: [], rows: mocks.statusMissingAfterCompile ? [] : [[objectIdAfterCompile, "2026-10-20 09:01:00", compileStatus]], truncated: mocks.truncateSingleStatusAfter };
      }
      const name = sql.match(/OBJECT_NAME = '([^']+)'/)?.[1] ?? "";
      const item = mocks.batchObjects.find((row) => row[1] === name);
      if (!item) return { columns: [], rows: [] };
      return { columns: ["OBJECT_ID", "LAST_DDL_TIME", "STATUS"], rows: [[item[3], item[4], mocks.batchStatuses[name] ?? "INVALID"]] };
    }
    return { columns: [], rows: [] };
  });
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
  document.body.innerHTML = "";
});

function dialogButtons(): HTMLButtonElement[] {
  return Array.from(root?.querySelectorAll("button") ?? []);
}

async function mountDialog(connectionState = ref(connection), databaseState = ref("ORCL"), initiallyOpen = true, schemaState = ref("APP")) {
  const open = ref(initiallyOpen);
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h("div", [
          h(
            "button",
            {
              "data-test-open": true,
              onClick: () => {
                open.value = true;
              },
            },
            "reopen",
          ),
          h(
            "button",
            {
              "data-test-close": true,
              onClick: () => {
                open.value = false;
              },
            },
            "dismiss",
          ),
          h(OracleInvalidObjectsDialog, {
            open: open.value,
            connection: connectionState.value,
            database: databaseState.value,
            schema: schemaState.value,
            onCompileFinished: mocks.compileFinished,
            "onUpdate:open": (value: boolean) => {
              open.value = value;
            },
          }),
        ]);
    },
  });
  app = createApp(Wrapper);
  app.mount(root!);
  if (initiallyOpen) await vi.waitFor(() => expect(root?.textContent).toMatch(/P_BAD|ORA-01031/));
  return { open, connectionState, databaseState };
}

describe("OracleInvalidObjectsDialog production flow", () => {
  it("shows a dictionary read denial instead of treating it as an empty list", async () => {
    mocks.failInvalidObjectList = true;
    await mountDialog();
    expect(root?.textContent).toContain("ORA-01031: insufficient privileges");
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.empty");
    expect(dialogButtons().some((button) => button.title === "common.refresh")).toBe(true);
  });

  it("uses one managed client session, closes it, and rotates it when the dialog reopens", async () => {
    await mountDialog();
    const sessionIds = mocks.executeQuery.mock.calls.map((call) => (call[5] as { clientSessionId?: string } | undefined)?.clientSessionId);
    expect(new Set(sessionIds).size).toBe(1);
    const sessionId = sessionIds[0];
    expect(sessionId).toMatch(/^invalid-objects:/);
    root?.querySelector<HTMLButtonElement>("[data-test-close]")?.click();
    await nextTick();
    expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith(connection.id, "ORCL", sessionId);
    const listCallsBeforeReopen = mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length;
    root?.querySelector<HTMLButtonElement>("[data-test-open]")?.click();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length).toBeGreaterThan(listCallsBeforeReopen));
    const reopenedListCall = mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).at(-1);
    expect((reopenedListCall?.[5] as { clientSessionId?: string } | undefined)?.clientSessionId).not.toBe(sessionId);
  });

  it("does not create or close a client session when the hidden dialog context changes", async () => {
    const connectionState = ref({ ...connection });
    const databaseState = ref("ORCL");
    const { open } = await mountDialog(connectionState, databaseState, false);

    connectionState.value = { ...connection, host: "replacement-host" };
    databaseState.value = "ORCL2";
    await nextTick();

    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
    open.value = true;
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalled());
    expect(mocks.executeQuery.mock.calls[0]).toEqual(expect.arrayContaining([connection.id, "ORCL2"]));
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
  });

  it("reads a complete batch, shows unsupported objects, and executes each supported object once after one confirmation", async () => {
    mocks.truncatedErrors = true;
    await mountDialog(ref({ ...connection, db_type: "oceanbase-oracle" }));
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("OBJECT_ID >"))).toBe(true));
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    expect(root?.textContent).toContain("batchCounts:3,2,1");
    expect(root?.textContent).toContain("V_SKIP");
    expect(mocks.guard).not.toHaveBeenCalled();
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();

    await vi.waitFor(() => expect(root?.textContent).toContain("batchResults"));
    expect(mocks.guard).toHaveBeenCalledOnce();
    const sessionIds = mocks.executeQuery.mock.calls.map((call) => (call[5] as { clientSessionId?: string } | undefined)?.clientSessionId);
    expect(new Set(sessionIds).size).toBe(1);
    expect(sessionIds[0]).toMatch(/^invalid-objects:/);
    const options = mocks.guard.mock.calls[0]?.[0] as { sql: string };
    expect(options.sql).toContain('ALTER PROCEDURE "APP"."P_OK" COMPILE');
    expect(options.sql).toContain('ALTER PROCEDURE "APP"."P_BAD" COMPILE');
    expect(options.sql).not.toContain("V_SKIP");
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(2);
    expect(root?.textContent).toContain("still-invalid");
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.unsupportedOnEngine");
    expect(root?.textContent).toContain("errorsTruncated");
    expect(root?.textContent).toContain("batchMoreErrors");
  });

  it("does not submit a partial plan when a middle batch page fails", async () => {
    mocks.batchObjects = Array.from({ length: 501 }, (_, index) => ["APP", `P_${index}`, "PROCEDURE", String(index + 1), "time"]);
    mocks.failBatchPage = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchNoPartialPlan"));
    expect(root?.textContent).toContain("middle page failed");
    expect(root?.textContent).not.toContain("batchConfirmTitle");
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
  });

  it("does not compile an object when its preflight status result is truncated", async () => {
    mocks.batchObjects = mocks.batchObjects.slice(0, 1);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    mocks.truncateBatchStatusBefore = true;
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchResults"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(0);
    expect(root?.textContent).toContain("batchStatus.unknown");
    expect(root?.textContent).toContain("batchIdentityUnknown");
    expect(root?.textContent).not.toContain("compileUnknown");
  });

  it("does not compile a single object when its identity preflight is truncated", async () => {
    mocks.truncateSingleIdentity = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.batchIdentityUnknown"));
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.compileUnknown");
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(0);
  });

  it("stops the batch with unknown status when post-compile readback is truncated", async () => {
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    mocks.truncateBatchStatusAfter = true;
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchResults"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
    expect(root?.textContent).toContain("batchStatus.unknown");
    expect(root?.textContent).toContain("batchStatus.not-run");
    expect(root?.textContent).toContain("compileUnknown");
    expect(root?.textContent).not.toContain("batchIdentityUnknown");
  });

  it("cancels batch confirmation without compiling or refreshing the remaining list", async () => {
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    mocks.executeAllowed = false;
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchGuardDeclined"));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    expect(mocks.compileFinished).not.toHaveBeenCalled();
  });

  it("stops before the next object when the user requests it during a submitted compile", async () => {
    let release!: () => void;
    mocks.compileGate = () => new Promise<void>((resolve) => (release = resolve));
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(root?.querySelector('[role="status"]')?.textContent).not.toContain("batchStopping");
    dialogButtons()
      .find((button) => button.textContent?.includes("batchStop"))
      ?.click();
    await nextTick();
    expect(root?.textContent).toContain("batchStopping");
    const stopButton = dialogButtons().find((button) => button.textContent?.includes("batchStopping"));
    expect(stopButton?.disabled).toBe(true);
    release();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchResults"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
    expect(root?.textContent).toContain("not-run");
  });

  it("stops before the first DDL when requested while production confirmation is pending", async () => {
    let release!: () => void;
    mocks.guardGate = () => new Promise<void>((resolve) => (release = resolve));
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(root?.querySelector('[role="status"]')?.textContent).not.toContain("batchStopping");
    dialogButtons()
      .find((button) => button.textContent?.includes("batchStop"))
      ?.click();
    release();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchResults"));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    expect(root?.textContent).toContain("not-run");
  });

  it("stops before DDL when requested while the first object's identity preflight is pending", async () => {
    let release!: () => void;
    mocks.batchStatusGate = () => new Promise<void>((resolve) => (release = resolve));
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchStop"))
      ?.click();
    release();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchResults"));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    expect(root?.textContent).toContain("not-run");
  });

  it("does not send a confirmed batch to a replacement connection configuration", async () => {
    let release!: () => void;
    mocks.guardGate = () => new Promise<void>((resolve) => (release = resolve));
    const connectionState = ref(connection);
    await mountDialog(connectionState);
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    connectionState.value = { ...connection, host: "replacement-host" };
    await nextTick();
    release();
    await nextTick();

    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    expect(mocks.compileFinished).not.toHaveBeenCalled();
  });

  it("does not send a confirmed batch after the selected schema changes", async () => {
    let release!: () => void;
    mocks.guardGate = () => new Promise<void>((resolve) => (release = resolve));
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    const schemaState = ref("APP");
    await mountDialog(ref(connection), ref("ORCL"), true, schemaState);
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    schemaState.value = "OTHER_SCHEMA";
    await nextTick();
    release();
    await nextTick();

    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    expect(mocks.compileFinished).not.toHaveBeenCalled();
  });

  it("drains a submitted batch on its original session and reports completion only for its frozen scope", async () => {
    let release!: () => void;
    mocks.compileGate = () => new Promise<void>((resolve) => (release = resolve));
    mocks.batchObjects = mocks.batchObjects.slice(0, 1);
    const databaseState = ref("ORCL");
    await mountDialog(ref(connection), databaseState);
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const ddlCall = mocks.executeQuery.mock.calls.find((call) => String(call[2]).startsWith("ALTER "));
    const sessionId = (ddlCall?.[5] as { clientSessionId?: string } | undefined)?.clientSessionId;
    expect(sessionId).toBeTruthy();

    databaseState.value = "ORCL2";
    await nextTick();
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith(connection.id, "ORCL", sessionId));
    expect(mocks.compileFinished).toHaveBeenCalledWith({ connectionId: connection.id, database: "ORCL", schema: "APP" });
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER ")).every((call) => call[1] === "ORCL")).toBe(true);
  });

  it("preserves per-object results when the complete remaining-list refresh fails", async () => {
    mocks.batchObjects = mocks.batchObjects.slice(0, 1);
    mocks.failRemainingAfterWrite = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("remaining list denied"));
    expect(root?.textContent).toContain("batchStatus.valid");
    expect(root?.textContent).toContain("batchRemainingUnknown");
  });

  it("stops after an unknown write outcome and leaves later items unsubmitted", async () => {
    mocks.unknownBatchCompileName = "P_OK";
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("connection lost during DDL"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
    expect(root?.textContent).toContain("not-run");
  });

  it("stops after an unknown execution_error result object", async () => {
    mocks.unknownBatchCompileResultName = "P_OK";
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("result unavailable"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(1);
    expect(root?.textContent).toContain("unknown");
    expect(root?.textContent).toContain("not-run");
  });

  it("allows a later object when an earlier DDL is explicitly rejected before start", async () => {
    mocks.failBatchCompileName = "P_OK";
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchResults"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(2);
    expect(root?.textContent).toContain("ORA-01031: insufficient privileges");
    expect(root?.textContent).toContain("valid");
  });

  it.each(["result", "throw"] as const)("continues the batch after a structured not_started rejection (%s)", async (mode) => {
    mocks.definiteBatchFailureName = "P_OK";
    mocks.definiteBatchFailureMode = mode;
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchResults"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(2);
    expect(root?.textContent).toContain("batchStatus.failed");
    expect(root?.textContent).not.toContain("batchStatus.not-run");
  });

  it("skips an already-valid object and blocks an object whose identity changed", async () => {
    mocks.batchStatuses.P_OK = "VALID";
    mocks.batchTimes.P_OK = "2026-10-20 09:01:00";
    mocks.batchObjectIds.P_BAD = "999";
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchResults"));
    const ddlNames = mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER ")).map((call) => String(call[2]));
    expect(ddlNames).not.toContainEqual(expect.stringContaining('"P_OK"'));
    expect(ddlNames).not.toContainEqual(expect.stringContaining('"P_BAD"'));
    expect(root?.textContent).toContain("already-valid");
    expect(root?.textContent).toContain("target-changed");
  });

  it("classifies missing and unexpected preflight states without submitting DDL", async () => {
    mocks.missingBatchStatusName = "P_OK";
    mocks.batchStatuses.P_BAD = "UNKNOWN_STATUS";
    mocks.batchObjects = mocks.batchObjects.slice(0, 2);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchResults"));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    expect(root?.textContent).toContain("batchStatus.deleted");
    expect(root?.textContent).toContain("batchStatus.unknown");
  });

  it("blocks an object whose DDL time changed after the plan was read", async () => {
    mocks.batchTimes.P_BAD = "2026-10-20 09:01:00";
    mocks.batchObjects = mocks.batchObjects.slice(1, 2);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchResults"));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);
    expect(root?.textContent).toContain("target-changed");
  });

  it("shows every batch object through client-side pages without changing the execution plan", async () => {
    mocks.batchObjects = Array.from({ length: 101 }, (_, index) => ["APP", `P_${index}`, "PROCEDURE", String(index + 1), "time"]);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    expect(root?.textContent).toContain("APP.P_0");
    expect(root?.textContent).not.toContain("APP.P_100");
    dialogButtons()
      .find((button) => button.textContent?.includes("batchNextPage"))
      ?.click();
    await nextTick();
    expect(root?.textContent).toContain("APP.P_100");
    expect(root?.textContent).not.toContain("APP.P_0 ·");
  });

  it("does not enable batch confirmation when the engine has no supported compile type", async () => {
    mocks.batchObjects = [["APP", "V_ONLY", "VIEW", "201", "time"]];
    await mountDialog(ref({ ...connection, db_type: "oceanbase-oracle" }));
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    const confirm = dialogButtons().find((button) => button.textContent?.includes("batchConfirm"));
    expect(confirm?.disabled).toBe(true);
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.unsupportedOnEngine");
    expect(mocks.guard).not.toHaveBeenCalled();
  });

  it("loads diagnostics, confirms the target without a preview step, compiles in its own session, and verifies status", async () => {
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.singleConfirmTitle");
    expect(root?.querySelector("details")?.open).toBe(false);
    expect(root?.querySelector("details pre")?.textContent).toContain('ALTER PROCEDURE "APP"."P_BAD" COMPILE REUSE SETTINGS');
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(compiled).toBe(false);

    const confirm = dialogButtons().find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile");
    confirm?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileValid"));
    expect(compiled).toBe(true);
    expect(mocks.compileFinished).toHaveBeenCalledWith({ connectionId: connection.id, database: "ORCL", schema: "APP" });
    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining({ database: "APP", sql: 'ALTER PROCEDURE "APP"."P_BAD" COMPILE REUSE SETTINGS' }));
    const compileCall = mocks.executeQuery.mock.calls.find((call) => String(call[2]).includes("ALTER PROCEDURE"));
    const clientSessionId = (compileCall?.[5] as { clientSessionId?: string } | undefined)?.clientSessionId;
    expect(clientSessionId).toBeTruthy();
    expect(mocks.executeQuery.mock.calls.every((call) => (call[5] as { clientSessionId?: string } | undefined)?.clientSessionId === clientSessionId)).toBe(true);
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.empty");
  });

  it("keeps compile unexecuted when production confirmation is declined", async () => {
    mocks.executeAllowed = false;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();
    await vi.waitFor(() => expect(mocks.guard).toHaveBeenCalled());
    expect(compiled).toBe(false);
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("ALTER PROCEDURE"))).toBe(false);
  });

  it("keeps the object selected and reloads diagnostics when compilation changes LAST_DDL_TIME but remains invalid", async () => {
    compileStatus = "INVALID";
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();

    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileStillInvalid"));
    expect(root?.textContent).toContain("still invalid after compile");
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.targetChanged");
    expect(errorsReloadedAfterCompile).toBe(true);
  });

  it("does not report a replacement object as the compiled target", async () => {
    objectIdAfterCompile = "10";
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();

    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.targetChanged"));
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.compileValid");
  });

  it("refreshes when the user clicks the refresh control", async () => {
    await mountDialog();
    const count = () => mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length;
    const before = count();
    root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.click();
    await vi.waitFor(() => expect(count()).toBeGreaterThan(before));
    await vi.waitFor(() => expect(root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.disabled).toBe(false));
  });

  it("replaces an in-flight batch read when the user refreshes, then allows a fresh full plan", async () => {
    let release!: () => void;
    mocks.batchPageGate = () => new Promise<void>((resolve) => (release = resolve));
    await mountDialog();
    const listCount = () => mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length;
    const before = listCount();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.click();
    await vi.waitFor(() => expect(listCount()).toBeGreaterThan(before));
    release();
    await vi.waitFor(() => expect(root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.disabled).toBe(false));
    expect(root?.textContent).not.toContain("batchReading");
    expect(root?.textContent).not.toContain("batchConfirmTitle");

    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchResults"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(3);
  });

  it("replaces a confirmed batch plan on manual refresh and allows a fresh plan", async () => {
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.click();
    await vi.waitFor(() => expect(root?.textContent).not.toContain("batchConfirmTitle"));
    await vi.waitFor(() => expect(root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.disabled).toBe(false));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER "))).toBe(false);

    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchResults"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER "))).toHaveLength(3);
  });

  it("bounds the dialog and keeps batch controls in the fixed footer layout", async () => {
    await mountDialog();
    const divs = Array.from(root?.querySelectorAll("div") ?? []);
    const dialogContent = divs.find((element) => element.className.includes("max-w-5xl"));
    const header = divs.find((element) => element.className.includes("px-5 py-4"));
    const grid = divs.find((element) => element.className.includes("grid-rows-[minmax(0,0.9fr)_minmax(0,1.1fr)]"));

    expect(dialogContent?.className).toContain("h-[min(85vh,760px)]");
    expect(dialogContent?.className).toContain("flex flex-col");
    expect(header?.className).toContain("shrink-0");
    expect(grid?.className).toContain("min-h-0");
    expect(grid?.className).toContain("flex-1");
    expect(grid?.className).toContain("md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)]");

    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    const footer = Array.from(root?.querySelectorAll("div") ?? []).find((element) => element.className.includes("mx-0 mb-0 shrink-0 border-t"));
    expect(footer).toBeTruthy();
    expect(dialogButtons().some((button) => button.textContent?.includes("batchConfirm"))).toBe(true);
  });

  it("shows the diagnostics truncation warning alongside the fetched error rows", async () => {
    mocks.truncatedErrors = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.errorsTruncated"));
    expect(root?.querySelectorAll("tbody tr").length).toBe(1000);
  });

  it("reports a removed object separately after compile", async () => {
    mocks.statusMissingAfterCompile = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileGone"));
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.empty");
  });

  it("preserves status readback diagnostics when compile outcome is unknown", async () => {
    mocks.failStatusReadback = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("ORA-01031: insufficient privileges while reading status"));
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileUnknown");
  });

  it.each(["throw", "result"] as const)("keeps submitted single compile unknown when status readback is denied (%s)", async (mode) => {
    mocks.failStatusReadback = true;
    mocks.statusReadbackErrorMode = mode;
    compileStatus = "INVALID";
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileUnknown"));
    expect(root?.textContent).toContain("ORA-01031: insufficient privileges");
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("ALTER PROCEDURE"))).toHaveLength(1);
    expect(mocks.compileFinished).toHaveBeenCalledWith({ connectionId: connection.id, database: "ORCL", schema: "APP" });
    expect(root?.querySelector("button")?.textContent).not.toContain("confirmCompile");
  });

  it("keeps single compile status unknown when the readback is truncated", async () => {
    mocks.truncateSingleStatusAfter = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileUnknown"));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("ALTER PROCEDURE"))).toHaveLength(1);
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.compileValid");
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.batchIdentityUnknown");
  });

  it("preserves a definite compile permission denial", async () => {
    mocks.failCompile = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("ORA-01031: insufficient privileges"));
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileFailed");
  });

  it("rechecks identity after production confirmation", async () => {
    let release!: () => void;
    mocks.guardGate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();
    await vi.waitFor(() => expect(mocks.guard).toHaveBeenCalled());
    mocks.identityChangedAfterGuard = true;
    release();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.targetChanged"));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("ALTER PROCEDURE"))).toBe(false);
  });

  it("does not submit compile after the connection configuration changes behind the confirmation", async () => {
    let release!: () => void;
    mocks.guardGate = () => new Promise<void>((resolve) => (release = resolve));
    const connectionState = ref(connection);
    await mountDialog(connectionState);
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();
    await vi.waitFor(() => expect(mocks.guard).toHaveBeenCalled());

    connectionState.value = { ...connection, host: "replacement-host" };
    await nextTick();
    release();
    await nextTick();
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("ALTER PROCEDURE"))).toBe(false);
  });

  it("uses a fresh session after close while a submitted compile drains, without leaving the reopened dialog stuck", async () => {
    let release!: () => void;
    mocks.compileGate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("ALTER PROCEDURE"))).toBe(true));
    const compileCall = mocks.executeQuery.mock.calls.find((call) => String(call[2]).includes("ALTER PROCEDURE"));
    const compileSessionId = (compileCall?.[5] as { clientSessionId?: string } | undefined)?.clientSessionId;
    dialogButtons()
      .find((button) => button.hasAttribute("data-test-close"))
      ?.click();
    await nextTick();
    expect(mocks.closeClientConnectionSession).not.toHaveBeenCalled();
    dialogButtons()
      .find((button) => button.hasAttribute("data-test-open"))
      ?.click();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length).toBeGreaterThan(1));
    const reopenedListCall = mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).at(-1);
    const reopenedSessionId = (reopenedListCall?.[5] as { clientSessionId?: string } | undefined)?.clientSessionId;
    expect(reopenedSessionId).not.toBe(compileSessionId);
    release();
    await vi.waitFor(() => expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith(connection.id, "ORCL", compileSessionId));
    await vi.waitFor(() => expect(root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.disabled).toBe(false));
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.disabled).toBe(false));
    expect(dialogButtons().find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")?.disabled).toBe(false);
  });

  it("does not write a late compile outcome into the reopened dialog after readback refresh", async () => {
    let release!: () => void;
    mocks.postCompileListGate = () => new Promise<void>((resolve) => (release = resolve));
    const { open } = await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.compile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    open.value = false;
    await nextTick();
    open.value = true;
    await nextTick();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length).toBeGreaterThan(2));
    release();
    await nextTick();
    await vi.waitFor(() => expect(root?.textContent).toContain("processList.oracleInvalidObjects.empty"));
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.compileValid");
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.compileGone");
    expect(root?.textContent).not.toContain("processList.oracleInvalidObjects.compileUnknown");
  });

  it("drains a submitted batch session after the dialog unmounts", async () => {
    let release!: () => void;
    mocks.compileGate = () => new Promise<void>((resolve) => (release = resolve));
    mocks.batchObjects = mocks.batchObjects.slice(0, 1);
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("compileAll"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("batchConfirmTitle"));
    dialogButtons()
      .find((button) => button.textContent?.includes("batchConfirm"))
      ?.click();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const ddlCall = mocks.executeQuery.mock.calls.find((call) => String(call[2]).startsWith("ALTER "));
    const sessionId = (ddlCall?.[5] as { clientSessionId?: string } | undefined)?.clientSessionId;
    expect(sessionId).toBeTruthy();

    app?.unmount();
    app = null;
    release();
    await vi.waitFor(() => expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith(connection.id, "ORCL", sessionId));
    expect(mocks.closeClientConnectionSession).toHaveBeenCalledTimes(1);
  });
});
