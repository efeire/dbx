// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { TreeNode } from "@/types/database";

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  listPlugins: vi.fn().mockResolvedValue([]),
  buildRenameObjectSql: vi.fn().mockResolvedValue('RENAME "Old View" TO "New View"'),
  executeQuery: vi.fn(),
}));

import * as api from "@/lib/backend/api";
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";

const mounted: App[] = [];
const node: TreeNode = { id: "ob:APP:view:Old View", type: "view", label: "Old View", connectionId: "ob", database: "APP" };

interface RenameDialog {
  renameObjectName: string;
  renameObjectError: string;
  showRenameObjectDialog: boolean;
  confirmRenameObject(): Promise<void>;
}

async function openRename() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  store.connections = [{ id: "ob", name: "OB", db_type: "oceanbase-oracle", host: "localhost", port: 2881, username: "APP", password: "", is_production: true }];
  vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined);
  const replacePin = vi.spyOn(store, "replacePinnedTreeNode");
  const instance = ref<{ buildContextMenu(target: TreeNode): ContextMenuItem[] }>();
  let controller: RenameDialog | undefined;
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({
    setup: () => () =>
      h(SidebarTreeRuntimeHost, {
        ref: instance,
        node,
        depth: 0,
        "onOpen-dialog-controller": (value: RenameDialog) => {
          controller = value;
        },
      }),
  });
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mounted.push(app);
  await nextTick();
  const item = instance.value!.buildContextMenu(node).find((entry) => entry.label === i18n.global.t("contextMenu.renameObject"));
  expect(item).toBeDefined();
  await item!.action?.();
  controller!.renameObjectName = "New View";
  await nextTick();
  return { dialog: controller!, safety: useProductionSafetyStore(), replacePin };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("OceanBase ordinary view rename", () => {
  it("keeps the rename dialog and old identity when production confirmation is cancelled", async () => {
    const { dialog, safety, replacePin } = await openRename();
    const execution = dialog.confirmRenameObject();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.cancel();
    await execution;
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(replacePin).not.toHaveBeenCalled();
    expect(dialog.showRenameObjectDialog).toBe(true);
    expect(api.buildRenameObjectSql).toHaveBeenCalledWith(expect.objectContaining({ objectType: "VIEW", schema: "APP", oldName: "Old View", newName: "New View" }));
  });

  it("retains the server error and original identity when rename fails", async () => {
    vi.mocked(api.executeQuery).mockRejectedValueOnce(new Error("ORA-00955: name is already used"));
    const { dialog, safety, replacePin } = await openRename();
    const execution = dialog.confirmRenameObject();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.confirm();
    await execution;
    expect(dialog.renameObjectError).toContain("ORA-00955");
    expect(dialog.showRenameObjectDialog).toBe(true);
    expect(replacePin).not.toHaveBeenCalled();
    expect(api.executeQuery).toHaveBeenCalledWith("ob", "APP", expect.any(String), "APP", undefined, expect.any(Object));
  });
});
