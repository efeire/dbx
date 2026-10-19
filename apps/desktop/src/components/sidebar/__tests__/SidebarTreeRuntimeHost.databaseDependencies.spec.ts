// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DatabaseType, TreeNode } from "@/types/database";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";

const backend = vi.hoisted(() => ({
  executeMulti: vi.fn().mockResolvedValue([{ columns: ["DIRECTION"], rows: [["DEPENDS_ON"]], affected_rows: 0, execution_time_ms: 3 }]),
  prepareQueryPaginationExecutionPlan: vi.fn(async ({ sql }: { sql: string }) => ({ sqlToExecute: sql, pageSql: sql, pageLimit: 100, useAgentResultSession: false })),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  ...backend,
  listPlugins: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/backend/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/http")>()),
  ...backend,
}));

import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

const mounted: { app: App; container: HTMLElement }[] = [];

async function mountContextMenu(databaseType: DatabaseType) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connections = useConnectionStore();
  connections.addEphemeralConnection({ id: "dependency-test", name: "Test", db_type: databaseType, driver_profile: databaseType, host: "localhost", port: 1, username: "test", password: "" });
  const queries = useQueryStore();

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    expect(queryTab?.title).toBe(`${i18n.global.t("contextMenu.viewDependencies")} - ${i18n.global.t("common.package")} APP.BATCH_API`);
    expect(queryTab?.sql).toContain("'BATCH_API' AS TARGET_NAME");
    expect(queryTab?.sql).toContain("d.TYPE IN ('PACKAGE', 'PACKAGE BODY')");
    expect(backend.executeMulti).toHaveBeenCalledWith("dependency-test", "APP", queryTab?.sql, "APP", expect.any(String), expect.objectContaining({ timeoutSecs: expect.any(Number) }));
    expect(backend.executeMulti).toHaveBeenCalledTimes(1);
    expect(queryTab?.result).toMatchObject({ columns: ["DIRECTION"], rows: [["DEPENDS_ON"]], affected_rows: 0 });
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
