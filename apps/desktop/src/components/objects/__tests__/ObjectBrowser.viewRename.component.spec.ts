// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  listObjects: vi.fn(),
  listSchemas: vi.fn().mockResolvedValue(["APP"]),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  buildRenameObjectSql: vi.fn().mockResolvedValue('RENAME "Old View" TO "New View"'),
  executeQuery: vi.fn(),
  getObjectSource: vi.fn().mockResolvedValue({ source: "CREATE VIEW old_view AS SELECT 2", editable: true }),
  buildEditableObjectSource: vi.fn().mockResolvedValue("CREATE VIEW old_view AS SELECT 2"),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    props: ["items"],
    setup:
      (props, { slots }) =>
      () =>
        h(
          "div",
          props.items.map((item: unknown) => slots.default?.({ item })),
        ),
  }),
}));
vi.mock("@/components/ui/CustomContextMenu.vue", () => ({
  default: defineComponent({
    props: ["items"],
    setup(props, { slots }) {
      return () =>
        h("div", [
          slots.default?.({ onContextMenu: () => undefined, isOpen: false }),
          ...props
            .items()
            .filter((item: ContextMenuItem) => [i18n.global.t("contextMenu.renameObject"), i18n.global.t("contextMenu.viewSource")].includes(item.label || ""))
            .map((item: ContextMenuItem) => h("button", { "data-open-rename": item.label === i18n.global.t("contextMenu.renameObject") ? true : undefined, "data-open-source": item.label === i18n.global.t("contextMenu.viewSource") ? true : undefined, onClick: item.action }, item.label)),
        ]);
    },
  }),
}));
vi.mock("@/components/editor/QueryEditor.vue", () => ({
  default: defineComponent({
    props: ["modelValue", "readOnly"],
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () => h("div", [h("pre", props.modelValue), !props.readOnly && h("button", { "data-edit-source": true, onClick: () => emit("update:modelValue", "CREATE VIEW old_view AS SELECT 3") }, "edit draft")]);
    },
  }),
}));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { notifyViewRenameReadback } from "@/lib/table/objectRenameSql";

const connection = { id: "ob-rename", name: "OB", db_type: "oceanbase-oracle" as const, database: "APP", host: "localhost", port: 2881, username: "APP", password: "", is_production: true };
const mounted: App[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  invalidateObjectBrowserRowsCache({});
  vi.mocked(api.listObjects).mockResolvedValue([{ name: "Old View", schema: "APP", object_type: "VIEW" }]);
  vi.mocked(api.executeQuery).mockResolvedValue({ columns: [], rows: [["Old View"]] } as any);
});
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = "";
  invalidateObjectBrowserRowsCache({});
  vi.restoreAllMocks();
});

async function openRename() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connections = useConnectionStore();
  connections.connections = [connection];
  vi.spyOn(connections, "ensureConnected").mockResolvedValue(undefined);
  const refresh = vi.spyOn(connections, "refreshObjectListTreeNode").mockResolvedValue(undefined);
  const settings = useSettingsStore();
  settings.editorSettings.objectBrowserViewMode = "list";
  const queries = useQueryStore();
  const sourceId = queries.openObjectSourceTab({ connectionId: connection.id, database: "APP", schema: "APP", title: "Old View", sql: "CREATE VIEW old_view AS SELECT 1", objectSource: { schema: "APP", name: "Old View", objectType: "VIEW" } });
  queries.updateSql(sourceId, "CREATE VIEW old_view AS SELECT 2");
  const container = document.createElement("div");
  document.body.append(container);
  const database = ref("APP");
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: database.value }) });
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mounted.push(app);
  await vi.waitFor(() => expect(container.querySelector("[data-open-rename]")).not.toBeNull());
  (container.querySelector("[data-open-source]") as HTMLElement).click();
  await vi.waitFor(() => expect(api.getObjectSource).toHaveBeenCalled());
  await vi.waitFor(() => expect(container.querySelector("[data-edit-source]")).not.toBeNull());
  (container.querySelector("[data-edit-source]") as HTMLElement).click();
  await nextTick();
  (container.querySelector("[data-open-rename]") as HTMLElement).click();
  await nextTick();
  const dialog = document.querySelector('[role="dialog"]')!;
  const input = dialog.querySelector("input")!;
  input.value = "New View";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  const button = [...dialog.querySelectorAll("button")].find((item) => item.textContent?.trim() === i18n.global.t("contextMenu.renameObject"))!;
  button.click();
  const safety = useProductionSafetyStore();
  await vi.waitFor(() => expect(safety.pending).toBeDefined());
  return { container, queries, sourceId, safety, refresh, database };
}

describe("ObjectBrowser OceanBase view rename", () => {
  it("cancels a confirmed rename after the browser database changes", async () => {
    const { safety, database } = await openRename();
    database.value = "OTHER_DATABASE";
    await nextTick();
    safety.confirm();
    await vi.waitFor(() => expect(safety.pending).toBeUndefined());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("does not mutate or detach source when confirmation is cancelled", async () => {
    const { queries, sourceId, safety, refresh } = await openRename();
    safety.cancel();
    await nextTick();
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource?.name).toBe("Old View");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("reports the database error and preserves source text when readback confirms the old name", async () => {
    vi.mocked(api.executeQuery).mockRejectedValueOnce(new Error("ORA-00955: name is already used"));
    const { queries, sourceId, safety, refresh } = await openRename();
    safety.confirm();
    await vi.waitFor(() => expect(document.body.textContent).toContain("ORA-00955"));
    expect(queries.tabs.find((tab) => tab.id === sourceId)).toMatchObject({ sourceSnapshot: true, sql: "CREATE VIEW old_view AS SELECT 2" });
    expect(api.executeQuery).toHaveBeenCalledTimes(2);
  });

  it("refreshes the renamed view and preserves edited source as a non-executable snapshot", async () => {
    const { container, queries, sourceId, safety, refresh } = await openRename();
    vi.mocked(api.listObjects).mockResolvedValue([{ name: "New View", schema: "APP", object_type: "VIEW" }]);
    safety.confirm();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(container.textContent).toContain("New View");
    expect(queries.tabs.find((tab) => tab.id === sourceId)).toMatchObject({ sourceSnapshot: true, sql: "CREATE VIEW old_view AS SELECT 2" });
    expect(api.executeQuery).toHaveBeenCalledWith(connection.id, "APP", expect.any(String), "APP");
  });

  it("freezes old source when the rename committed but its response was lost", async () => {
    vi.mocked(api.executeQuery)
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ columns: [], rows: [["New View"]] } as any);
    const { queries, sourceId, safety, refresh } = await openRename();
    vi.mocked(api.listObjects).mockResolvedValue([{ name: "New View", schema: "APP", object_type: "VIEW" }]);
    safety.confirm();
    await vi.waitFor(() => expect(document.body.textContent).toContain(i18n.global.t("contextMenu.viewRenameResponseLost")));
    expect(queries.tabs.find((tab) => tab.id === sourceId)).toMatchObject({ sourceSnapshot: true, sql: "CREATE VIEW old_view AS SELECT 2" });
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource).toBeUndefined();
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === i18n.global.t("objects.saveSource"))).toBe(false);
    expect(document.querySelector("[data-object-source-preview]")?.textContent).toContain("SELECT 3");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("keeps an unreadable rename outcome as a snapshot rather than a saveable old identity", async () => {
    vi.mocked(api.executeQuery).mockRejectedValue(new Error("connection lost"));
    const { queries, sourceId, safety } = await openRename();
    safety.confirm();
    await vi.waitFor(() => expect(document.body.textContent).toContain(i18n.global.t("contextMenu.viewRenameStateUnknown")));
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.sourceSnapshot).toBe(true);
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource).toBeUndefined();
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === i18n.global.t("objects.saveSource"))).toBe(false);
    expect(document.querySelector("[data-object-source-preview]")?.textContent).toContain("SELECT 3");
  });

  it("freezes the embedded source for a sidebar rename and restores editing only after old-name readback", async () => {
    const { safety } = await openRename();
    safety.cancel();
    const hasSave = () => [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === i18n.global.t("objects.saveSource"));
    expect(hasSave()).toBe(true);
    notifyViewRenameReadback(connection.id, "APP", "APP", "Old View", "pending");
    await nextTick();
    expect(hasSave()).toBe(false);
    notifyViewRenameReadback(connection.id, "APP", "APP", "Old View", "unknown");
    await nextTick();
    expect(hasSave()).toBe(false);
    expect(document.body.textContent).toContain(i18n.global.t("contextMenu.viewRenameStateUnknown"));
    notifyViewRenameReadback(connection.id, "APP", "APP", "Old View", "unchanged");
    await nextTick();
    expect(hasSave()).toBe(true);
  });
});
