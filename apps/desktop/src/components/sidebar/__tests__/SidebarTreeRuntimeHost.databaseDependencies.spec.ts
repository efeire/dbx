// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DatabaseType, TreeNode } from "@/types/database";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  listPlugins: vi.fn().mockResolvedValue([]),
}));

import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

const mounted: { app: App; container: HTMLElement }[] = [];

async function mountContextMenu(databaseType: DatabaseType) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connections = useConnectionStore();
  connections.connections = [{ id: "dependency-test", name: "Test", db_type: databaseType, driver_profile: databaseType, host: "localhost", port: 1, username: "test" }];
  vi.spyOn(connections, "ensureConnected").mockResolvedValue(undefined as any);
  const queries = useQueryStore();
  vi.spyOn(queries, "executeTabSql").mockResolvedValue(undefined as any);

  const host = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
  const rootNode: TreeNode = { id: "dependency-test", type: "connection", label: "Test", connectionId: "dependency-test", database: "APP" };
  const root = defineComponent({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: host, node: rootNode, depth: 0 }) });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(root);
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mounted.push({ app, container });
  await nextTick();

  return { host: host.value as unknown as { buildContextMenu(node: TreeNode): ContextMenuItem[] }, queries };
}

describe("routine dependency context-menu action", () => {
  afterEach(() => {
    for (const { app, container } of mounted.splice(0)) {
      app.unmount();
      container.remove();
    }
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("opens a package-scope query from an Oracle package member in %s", async (databaseType) => {
    const { host, queries } = await mountContextMenu(databaseType);
    const member: TreeNode = {
      id: "dependency-test:package-member",
      type: "procedure",
      label: "RUN_JOB",
      objectName: "RUN_JOB",
      parentType: "package",
      parentName: "BATCH_API",
      parentSchema: "APP",
      schema: "APP",
      connectionId: "dependency-test",
      database: "APP",
    };
    const menu = host.buildContextMenu(member);
    const action = menu.find((item) => item.label === i18n.global.t("contextMenu.viewDependencies"))?.action;
    expect(action).toBeDefined();

    await action?.();

    const queryTab = queries.tabs.find((tab) => tab.mode === "query");
    expect(queryTab?.title).toBe(`${i18n.global.t("contextMenu.viewDependencies")} - ${i18n.global.t("tree.package")} APP.BATCH_API`);
    expect(queryTab?.sql).toContain("'BATCH_API' AS TARGET_NAME");
    expect(queryTab?.sql).toContain("d.TYPE IN ('PACKAGE', 'PACKAGE BODY')");
    expect(queries.executeTabSql).toHaveBeenCalledWith(queryTab?.id, queryTab?.sql);
  });

  it("keeps package-member dependency action hidden for Xugu", async () => {
    const { host } = await mountContextMenu("xugu");
    const member: TreeNode = {
      id: "dependency-test:package-member",
      type: "procedure",
      label: "RUN_JOB",
      objectName: "RUN_JOB",
      parentType: "package",
      parentName: "BATCH_API",
      parentSchema: "APP",
      schema: "APP",
      connectionId: "dependency-test",
      database: "APP",
    };
    expect(host.buildContextMenu(member).map((item) => item.label)).not.toContain(i18n.global.t("contextMenu.viewDependencies"));
  });
});
