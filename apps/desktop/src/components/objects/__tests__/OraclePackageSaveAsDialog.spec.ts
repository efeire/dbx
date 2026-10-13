// @vitest-environment happy-dom
import { createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { setLocale } from "@/i18n";
import OraclePackageSaveAsDialog from "../OraclePackageSaveAsDialog.vue";
import type { OraclePackageSaveAsPlan } from "@/lib/table/oraclePackageSaveAs";

const cleanups: Array<() => void> = [];
async function flush() {
  for (let turn = 0; turn < 5; turn += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
  }
}
function fixture(executable: boolean): OraclePackageSaveAsPlan {
  return {
    target: { connectionId: "c", database: "APP", databaseType: "oracle", schema: "APP", oldName: "P_OLD", newName: "P_NEW" },
    canonicalNewName: "P_NEW",
    snapshot: null,
    specSource: 'CREATE PACKAGE "P_NEW" AS END "P_NEW";',
    bodySource: null,
    statements: ['CREATE PACKAGE "P_NEW" AS END "P_NEW";'],
    issues: executable ? [] : [{ code: "source_rewrite_failed", message: "An uncertain member reference." }],
    metadataComplete: true,
    executable,
  };
}

function mount(plan: OraclePackageSaveAsPlan) {
  const confirm = vi.fn();
  const updateName = vi.fn();
  const updateOpen = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp({
    render: () =>
      h(OraclePackageSaveAsDialog, {
        open: true,
        oldName: "P_OLD",
        newName: "P_NEW",
        plan,
        error: "",
        diagnostic: "",
        loading: false,
        executing: false,
        onConfirm: confirm,
        "onUpdate:newName": updateName,
        "onUpdate:open": updateOpen,
      }),
  }).use(i18n);
  app.mount(container);
  cleanups.push(() => {
    app.unmount();
    container.remove();
  });
  return { container: document.body, confirm, updateName, updateOpen };
}

describe("Oracle package Save As dialog", () => {
  beforeEach(async () => {
    await setLocale("zh-CN");
  });
  afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

  it("keeps confirmation disabled when a source issue needs resolution and localizes the prompt", async () => {
    const { container } = mount(fixture(false));
    await flush();
    expect(container.textContent).toContain(i18n.global.t("objects.packageSaveAsTitle"));
    expect(container.textContent).toContain(i18n.global.t("objects.packageSaveAsHint", { name: "P_OLD" }));
    expect(container.textContent).toContain(i18n.global.t("objects.packageSaveAsMetadataProblem"));
    expect(container.querySelector<HTMLButtonElement>("button[data-confirm]")?.disabled).toBe(true);
    expect(container.querySelector<HTMLDetailsElement>("li details")?.open).toBe(false);
  });

  it("shows the validated CREATE preview and emits the save action", async () => {
    const { container, confirm } = mount(fixture(true));
    await flush();
    expect(container.textContent).toContain('CREATE PACKAGE "P_NEW"');
    container.querySelector<HTMLButtonElement>("button[data-confirm]")?.click();
    expect(confirm).toHaveBeenCalledOnce();
  });
});
