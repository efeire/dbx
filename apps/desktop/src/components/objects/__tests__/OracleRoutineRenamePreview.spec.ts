// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { setLocale } from "@/i18n";
import OracleRoutineRenamePreview from "../OracleRoutineRenamePreview.vue";
import type { OracleRoutineRenamePlan } from "@/lib/table/oracleRoutineRename";

function fixture(): OracleRoutineRenamePlan {
  const target = { connectionId: "routine-preview", database: "APP", databaseType: "oceanbase-oracle" as const, schema: "APP", objectType: "PROCEDURE" as const, oldName: "P_OLD", newName: "P_NEW" };
  const root = { name: "P_OLD", objectType: "PROCEDURE", objectId: "101", status: "VALID", source: "CREATE OR REPLACE PROCEDURE APP.P_OLD AS BEGIN NULL; END;", signature: "[]", grants: "[]", errors: "[]" };
  return {
    target,
    canonicalNewName: "P_NEW",
    root,
    callers: [],
    dependencyEdges: [],
    statements: ["CREATE PROCEDURE APP.P_NEW AS BEGIN NULL; END;", "DROP PROCEDURE APP.P_OLD"],
    steps: [
      { kind: "create", objectName: "P_NEW", objectType: "PROCEDURE", sql: "CREATE PROCEDURE APP.P_NEW AS BEGIN NULL; END;" },
      { kind: "drop", objectName: "P_OLD", objectType: "PROCEDURE", sql: "DROP PROCEDURE APP.P_OLD" },
    ],
    issues: [{ code: "unsupported_dependency", message: "Cannot update dependent OTHER.P_CALLER (PACKAGE).", objectName: "P_CALLER" }],
    metadataComplete: true,
    executable: false,
  };
}

const cleanups: Array<() => void> = [];
function mount(options: Partial<{ plan: OracleRoutineRenamePlan | null; loading: boolean; executing: boolean }> = {}) {
  const state = reactive({ plan: fixture() as OracleRoutineRenamePlan | null, loading: false, executing: false, ...options });
  const reload = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp({ render: () => h(OracleRoutineRenamePreview, { ...state, onReload: reload }) }).use(i18n);
  app.mount(container);
  cleanups.push(() => {
    app.unmount();
    container.remove();
  });
  return { container, state, reload };
}

describe("Oracle routine rename preview", () => {
  beforeEach(async () => {
    await setLocale("zh-CN");
  });
  afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

  it("shows the blocking dependent and the exact SQL sequence without enabling execution", () => {
    const { container } = mount();

    expect(container.textContent).toContain("P_CALLER");
    expect(container.textContent).toContain("PACKAGE");
    expect(container.textContent).toContain("CREATE PROCEDURE APP.P_NEW AS BEGIN NULL; END;");
    expect(container.textContent).toContain("DROP PROCEDURE APP.P_OLD");
    expect(container.querySelector('[role="status"]')!.textContent).toBe(i18n.global.t("objects.viewRenameValidationPending"));
  });

  it("offers a localized refresh control and disables it while execution is active", async () => {
    const { container, state, reload } = mount();
    const button = container.querySelector<HTMLButtonElement>("[data-reload]")!;
    button.click();
    expect(reload).toHaveBeenCalledOnce();
    state.executing = true;
    await nextTick();
    expect(button.disabled).toBe(true);
  });
});
