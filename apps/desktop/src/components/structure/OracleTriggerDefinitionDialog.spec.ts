// @vitest-environment happy-dom
import { createApp, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import OracleTriggerDefinitionDialog from "./OracleTriggerDefinitionDialog.vue";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";

const storage = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/backend/browserAppStateStorage", () => ({
  loadBrowserAppState: vi.fn(async (key: string) => storage.get(key) ?? null),
  saveBrowserAppState: vi.fn(async (key: string, value: unknown) => { storage.set(key, structuredClone(value)); }),
}));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/backend/api")>(), getObjectSource: vi.fn(), executeQuery: vi.fn(), deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
}));
const original = "CREATE OR REPLACE TRIGGER APP.T BEFORE INSERT ON APP.DATA FOR EACH ROW BEGIN NULL; END;";
const mounted: App[] = [];
const click = (key: string) => {
  const label = i18n.global.t(key);
  const button = [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
  expect(button).toBeDefined();
  button!.click();
};
async function mountDialog() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = { id: "ob", name: "OB", db_type: "oceanbase-oracle" as const, host: "localhost", port: 2881, username: "APP", password: "", is_production: true };
  useConnectionStore().connections = [connection];
  const changed = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({ setup: () => () => h(OracleTriggerDefinitionDialog, { open: true, connectionId: "ob", database: "APP", schema: "APP", name: "T", tableSchema: "APP", tableName: "DATA", onChanged: changed }) });
  app.use(pinia); app.use(i18n); app.mount(container); mounted.push(app);
  await vi.waitFor(() => expect(document.querySelectorAll("textarea").length).toBeGreaterThan(0));
  await vi.waitFor(() => expect(api.getObjectSource).toHaveBeenCalled());
  await vi.waitFor(() => expect(document.querySelectorAll("input").length).toBeGreaterThan(1));
  return { changed, safety: useProductionSafetyStore() };
}
beforeEach(() => {
  storage.clear(); vi.clearAllMocks();
  vi.mocked(api.getObjectSource).mockResolvedValue({ source: original } as any);
  vi.mocked(api.executeQuery).mockResolvedValue({ columns: [], rows: [["VALID", "ENABLED", "APP", "DATA"]] } as any);
});
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("complete trigger definition dialog", () => {
  it("preserves structured body edits when switching to source and back", async () => {
    await mountDialog();
    const body = [...document.querySelectorAll("textarea")].at(-1)!;
    body.value = "BEGIN dbms_output.put_line(q'[O'Reilly]'); END;";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    click("structureEditor.triggerSourceMode"); await nextTick();
    expect(document.querySelector("textarea")!.value).toContain("q'[O'Reilly]'");
    click("structureEditor.triggerStructuredMode"); await nextTick();
    expect([...document.querySelectorAll("textarea")].at(-1)!.value).toContain("q'[O'Reilly]'");
  });

  it("does not write recovery material or execute SQL when production confirmation is cancelled", async () => {
    const { safety, changed } = await mountDialog();
    click("structureEditor.triggerPreviewDefinition"); await nextTick();
    click("common.save");
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.cancel(); await nextTick();
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps persisted recovery and reports INVALID while refreshing uncertain metadata", async () => {
    const { safety, changed } = await mountDialog();
    vi.mocked(api.executeQuery)
      .mockResolvedValueOnce({ columns: [], rows: [["VALID", "ENABLED", "APP", "DATA"]] } as any)
      .mockResolvedValueOnce({ columns: [], rows: [] } as any)
      .mockResolvedValueOnce({ columns: [], rows: [["INVALID", "DISABLED", "APP", "DATA"]] } as any)
      .mockResolvedValueOnce({ columns: [], rows: [[3, 7, "PLS-00201"]] } as any);
    click("structureEditor.triggerPreviewDefinition"); await nextTick();
    click("common.save");
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.confirm();
    await vi.waitFor(() => expect(document.body.textContent).toContain("PLS-00201"));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(storage.size).toBe(1);
    click("structureEditor.triggerOriginalDefinition"); await nextTick();
    expect([...document.querySelectorAll("textarea")].some((element) => element.readOnly && element.value === original)).toBe(true);
    expect(api.executeQuery).toHaveBeenCalledTimes(4);
  });
});
