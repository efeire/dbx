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
  statusMissingAfterCompile: false,
  compileGate: null as null | (() => Promise<void>),
  truncatedErrors: false,
  failCompile: false,
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
  mocks.statusMissingAfterCompile = false;
  mocks.compileGate = null;
  mocks.truncatedErrors = false;
  mocks.failCompile = false;
  mocks.executeAllowed = true;
  mocks.guard.mockReset();
  mocks.closeClientConnectionSession.mockReset().mockResolvedValue(undefined);
  mocks.compileFinished.mockReset();
  mocks.executeQuery.mockReset().mockImplementation(async (_connectionId: string, _database: string, sql: string) => {
    if (sql.includes("FROM (SELECT OWNER")) return { columns: [], rows: !compiled || compileStatus === "INVALID" ? [["APP", "P_BAD", "PROCEDURE", 9, compiled ? "2026-10-20 09:01:00" : "2026-10-20 09:00:00"]] : [] };
    if (sql.includes("FROM ALL_ERRORS")) {
      if (compiled) errorsReloadedAfterCompile = true;
      return { columns: [], rows: mocks.truncatedErrors ? Array.from({ length: 1000 }, (_, index) => [index + 1, index + 1, 1, "invalid identifier"]) : [[1, 3, 7, compiled ? "still invalid after compile" : "invalid identifier"]] };
    }
    if (sql.includes("SELECT OBJECT_ID") && sql.includes("STATUS = 'INVALID'")) return { columns: [], rows: [[mocks.identityChangedAfterGuard ? 10 : 9, "2026-10-20 09:00:00"]] };
    if (sql.includes("ALTER PROCEDURE")) {
      if (mocks.failCompile) throw new Error("ORA-01031: insufficient privileges");
      if (mocks.compileGate) await mocks.compileGate();
      compiled = true;
      return { columns: [], rows: [] };
    }
    if (sql.includes("SELECT OBJECT_ID") && sql.includes("STATUS FROM ALL_OBJECTS")) {
      if (mocks.failStatusReadback) throw new Error("permission denied while reading status");
      return { columns: [], rows: mocks.statusMissingAfterCompile ? [] : [[objectIdAfterCompile, "2026-10-20 09:01:00", compileStatus]] };
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

async function mountDialog() {
  const open = ref(true);
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
            connection,
            database: "ORCL",
            schema: "APP",
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
  await vi.waitFor(() => expect(root?.textContent).toContain("P_BAD"));
}

describe("OracleInvalidObjectsDialog production flow", () => {
  it("loads diagnostics, previews before writing, compiles in its own session, and verifies status", async () => {
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.previewCompile")
      ?.click();
    await nextTick();
    expect(root?.textContent).toContain('ALTER PROCEDURE "APP"."P_BAD" COMPILE REUSE SETTINGS');
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
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.previewCompile")
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
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.previewCompile")
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
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.previewCompile")
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
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.previewCompile")
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
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.previewCompile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("permission denied while reading status"));
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileUnknown");
  });

  it("preserves a compile permission denial alongside the unknown outcome", async () => {
    mocks.failCompile = true;
    await mountDialog();
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("invalid identifier"));
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.previewCompile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();
    await vi.waitFor(() => expect(root?.textContent).toContain("ORA-01031: insufficient privileges"));
    expect(root?.textContent).toContain("processList.oracleInvalidObjects.compileUnknown");
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
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.previewCompile")
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

  it("allows close and reopen while a submitted compile is pending without leaving the reopened dialog stuck", async () => {
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
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.previewCompile")
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.confirmCompile")
      ?.click();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("ALTER PROCEDURE"))).toBe(true));
    dialogButtons()
      .find((button) => button.hasAttribute("data-test-close"))
      ?.click();
    await nextTick();
    dialogButtons()
      .find((button) => button.hasAttribute("data-test-open"))
      ?.click();
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("FROM (SELECT OWNER")).length).toBeGreaterThan(1));
    release();
    await vi.waitFor(() => expect(root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.disabled).toBe(false));
    dialogButtons()
      .find((button) => button.textContent?.includes("P_BAD"))
      ?.click();
    await vi.waitFor(() => expect(root?.querySelector<HTMLButtonElement>('button[title="common.refresh"]')?.disabled).toBe(false));
    expect(dialogButtons().find((button) => button.textContent?.trim() === "processList.oracleInvalidObjects.previewCompile")?.disabled).toBe(false);
  });
});
