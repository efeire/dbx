// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { TreeNode } from "@/types/database";

const guard = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/database/productionExecutionGuard", async (original) => ({ ...(await original<object>()), executeWithProductionSqlGuard: guard }));
vi.mock("@/lib/backend/api", async (original) => ({
  ...(await original<object>()),
  listPlugins: vi.fn().mockResolvedValue([]),
  getObjectSource: vi.fn().mockResolvedValue({ source: "CREATE PROCEDURE OLD AS BEGIN NULL; END;" }),
  buildRoutineRenameObjectSourceStatements: vi.fn().mockResolvedValue(["CREATE PROCEDURE NEW AS BEGIN NULL; END;", "DROP PROCEDURE OLD"]),
}));
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { renameObjectName, showRenameObjectDialog } from "../sidebarTreeDialogState";

describe("sidebar rename production cancellation", () => {
  it("stops after the first cancelled statement and keeps the old identity", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useConnectionStore();
    store.connections = [{ id: "rename-c", name: "Owner", db_type: "oracle", host: "localhost", port: 1521, username: "OWNER" } as any];
    vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined);
    const replacePin = vi.spyOn(store, "replacePinnedTreeNode");
    const host = ref<any>();
    let controller: any;
    const node: TreeNode = { id: "rename-procedure", type: "procedure", label: "OLD", objectName: "OLD", connectionId: "rename-c", database: "OWNER", schema: "OWNER" };
    const root = defineComponent({
      setup: () => () =>
        h(SidebarTreeRuntimeHost, {
          ref: host,
          node,
          depth: 0,
          onOpenDialogController: (value: unknown) => {
            controller = value;
          },
        }),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp(root).use(pinia).use(i18n);
    try {
      app.mount(container);
      await nextTick();
      const items: ContextMenuItem[] = host.value.buildContextMenu(node);
      const rename = items.find((item) => item.label === i18n.global.t("contextMenu.renameObject"));
      expect(rename).toBeDefined();
      rename!.action!();
      renameObjectName.value = "NEW";
      await nextTick();
      await controller.confirmRenameObject();
      expect(guard).toHaveBeenCalledTimes(1);
      expect(replacePin).not.toHaveBeenCalled();
      expect(showRenameObjectDialog.value).toBe(true);
    } finally {
      app.unmount();
      container.remove();
      showRenameObjectDialog.value = false;
    }
  });
});
