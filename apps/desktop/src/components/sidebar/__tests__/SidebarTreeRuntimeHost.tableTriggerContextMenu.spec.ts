// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { DatabaseType, TreeNode } from "@/types/database";

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    listPlugins: vi.fn().mockResolvedValue([]),
    executeQuery: vi.fn().mockResolvedValue({ success: true, columns: [], rows: [] }),
  };
});

import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";

const node = (type: TreeNode["type"], label: string, tableName?: string): TreeNode => ({
  id: `test-conn:db:${type}:${label}`,
  type,
  label,
  objectName: label,
  tableName,
  connectionId: "test-conn",
  database: "testdb",
});
const mountedApps: App<Element>[] = [];
const sourceEvents: Array<{ node: TreeNode; initialEditing: boolean }> = [];
const labels = (items: ContextMenuItem[]): string[] => items.flatMap((item) => [...(item.label ? [item.label] : []), ...(item.children ? labels(item.children) : [])]);
const tr = (key: string) => i18n.global.t(key);

async function mountHost(dbType: DatabaseType = "firebird") {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  store.connections = [{ id: "test-conn", name: "TestDB", db_type: dbType, driver_profile: dbType, host: "localhost", port: 3050, username: "sysdba", password: "masterkey" }];
  vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined as any);
  vi.spyOn(store, "refreshTreeNode").mockResolvedValue(undefined as any);
  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const root = defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: node("connection", "TestDB"), depth: 0, "onOpen-object-source": (sourceNode: TreeNode, initialEditing: boolean) => sourceEvents.push({ node: sourceNode, initialEditing }) }) });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(root);
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mountedApps.push(app);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  return host.value as { buildContextMenu(node: TreeNode): ContextMenuItem[] };
}

describe("Table trigger context menu", () => {
  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
    sourceEvents.length = 0;
  });

  it("keeps Oracle-family TYPE and TYPE_BODY sources in the read-only dialog when query-tab is selected", async () => {
    for (const dbType of ["oracle", "oceanbase-oracle", "dameng"] as const) {
      const host = await mountHost(dbType);
      useSettingsStore().updateEditorSettings({ routineSourceOpenMode: "query-tab" });
      const pendingSourceTab = vi.spyOn(useQueryStore(), "openObjectSourceTabPending").mockImplementation(() => undefined);

      for (const type of ["type", "type-body"] as const) {
        const typeNode = node(type, type === "type" ? "TYPE_OBJ" : "TYPE_OBJ_BODY");
        const menu = host.buildContextMenu(typeNode);
        expect(labels(menu)).not.toContain(tr("contextMenu.changeOpenMode"));
        const sourceAction = menu.find((item) => item.label === tr("contextMenu.viewSource"));
        await sourceAction?.action?.();
      }
      expect(pendingSourceTab).not.toHaveBeenCalled();
    }

    expect(sourceEvents.map(({ node: sourceNode, initialEditing }) => [sourceNode.type, initialEditing])).toEqual([
      ["type", false],
      ["type-body", false],
      ["type", false],
      ["type-body", false],
      ["type", false],
      ["type-body", false],
    ]);
  });

  it("preserves query-tab source routing for Xugu types and routines", async () => {
    const host = await mountHost("xugu");
    useSettingsStore().updateEditorSettings({ routineSourceOpenMode: "query-tab" });
    const queryStore = useQueryStore();
    const pendingSourceTab = vi.spyOn(queryStore, "openObjectSourceTabPending").mockImplementation(() => undefined);

    const xuguTypeMenu = host.buildContextMenu(node("type", "T_XUGU"));
    expect(labels(xuguTypeMenu)).toContain(tr("contextMenu.changeOpenMode"));
    for (const sourceNode of [node("type", "T_XUGU"), node("procedure", "P_XUGU")]) {
      const sourceAction = host.buildContextMenu(sourceNode).find((item) => item.label === tr("contextMenu.viewSource"));
      await sourceAction?.action?.();
    }

    expect(pendingSourceTab).toHaveBeenCalledTimes(2);
    expect(sourceEvents).toHaveLength(0);
  });

  it("exposes view source and change open mode for table triggers", async () => {
    const host = await mountHost("firebird");
    const items = labels(host.buildContextMenu(node("trigger", "TR_ORDERS_BI", "ORDERS")));
    expect(items).toContain(tr("contextMenu.viewSource"));
    expect(items).toContain(tr("contextMenu.changeOpenMode"));
    expect(items).toContain(tr("contextMenu.copyName"));
  });

  it("exposes view source for database-level triggers", async () => {
    const host = await mountHost("firebird");
    const items = labels(host.buildContextMenu(node("trigger", "TR_CONN")));
    expect(items).toContain(tr("contextMenu.viewSource"));
    expect(items).toContain(tr("contextMenu.changeOpenMode"));
  });

  it("exposes disableTrigger for enabled SQL Server table trigger and executes SQL on action", async () => {
    const api = await import("@/lib/backend/api");
    const executeQueryMock = vi.fn().mockResolvedValue({ success: true, columns: [], rows: [] });
    (api as any).executeQuery = executeQueryMock;

    const host = await mountHost("sqlserver");
    const triggerNode: TreeNode = {
      ...node("trigger", "trg_orders_audit", "orders"),
      schema: "dbo",
      meta: { name: "trg_orders_audit", timing: "AFTER", event: "INSERT", enabled: true },
    };
    const menu = host.buildContextMenu(triggerNode);
    const itemLabels = labels(menu);
    expect(itemLabels).toContain(tr("contextMenu.disableTrigger"));
    expect(itemLabels).not.toContain(tr("contextMenu.enableTrigger"));

    const disableItem = menu.find((item) => item.label === tr("contextMenu.disableTrigger"));
    expect(disableItem).toBeDefined();
    await disableItem?.action?.();
    expect(executeQueryMock).toHaveBeenCalledWith("test-conn", "testdb", "DISABLE TRIGGER [dbo].[trg_orders_audit] ON [dbo].[orders];", "dbo", undefined, { timeoutSecs: expect.any(Number) });
  });

  it("exposes enableTrigger for disabled SQL Server table trigger and executes SQL on action", async () => {
    const api = await import("@/lib/backend/api");
    const executeQueryMock = vi.fn().mockResolvedValue({ success: true, columns: [], rows: [] });
    (api as any).executeQuery = executeQueryMock;

    const host = await mountHost("sqlserver");
    const triggerNode: TreeNode = {
      ...node("trigger", "trg_orders_audit", "orders"),
      schema: "dbo",
      meta: { name: "trg_orders_audit", timing: "AFTER", event: "INSERT", enabled: false },
    };
    const menu = host.buildContextMenu(triggerNode);
    const itemLabels = labels(menu);
    expect(itemLabels).toContain(tr("contextMenu.enableTrigger"));
    expect(itemLabels).not.toContain(tr("contextMenu.disableTrigger"));

    const enableItem = menu.find((item) => item.label === tr("contextMenu.enableTrigger"));
    expect(enableItem).toBeDefined();
    await enableItem?.action?.();
    expect(executeQueryMock).toHaveBeenCalledWith("test-conn", "testdb", "ENABLE TRIGGER [dbo].[trg_orders_audit] ON [dbo].[orders];", "dbo", undefined, { timeoutSecs: expect.any(Number) });
  });

  it("exposes both enable and disable when trigger enabled status is unknown", async () => {
    const host = await mountHost("sqlserver");
    const triggerNode: TreeNode = {
      ...node("trigger", "trg_orders_audit", "orders"),
      schema: "dbo",
      meta: { name: "trg_orders_audit", timing: "AFTER", event: "INSERT" },
    };
    const menu = host.buildContextMenu(triggerNode);
    const itemLabels = labels(menu);
    expect(itemLabels).toContain(tr("contextMenu.enableTrigger"));
    expect(itemLabels).toContain(tr("contextMenu.disableTrigger"));
  });

  it("does not expose trigger toggle actions for unsupported databases like mysql", async () => {
    const host = await mountHost("mysql");
    const triggerNode: TreeNode = {
      ...node("trigger", "trg_orders_audit", "orders"),
      meta: { name: "trg_orders_audit", timing: "AFTER", event: "INSERT", enabled: true },
    };
    const menu = host.buildContextMenu(triggerNode);
    const itemLabels = labels(menu);
    expect(itemLabels).not.toContain(tr("contextMenu.enableTrigger"));
    expect(itemLabels).not.toContain(tr("contextMenu.disableTrigger"));
  });
});
