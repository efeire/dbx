// @vitest-environment happy-dom

import { createApp, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({ loadObjectDdl: mocks.load, invalidateObjectDdlCache: vi.fn() }));
vi.mock("@/lib/sql/ddlDisplay", async (original) => ({ ...(await original<object>()), formatDdlForDisplay: async (sql: string) => sql }));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ __esModule: true, default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({ __esModule: true, default: { render: () => null } }));
import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";

const ddl = 'CREATE  TABLE "Owner"."First" ("ID" NUMBER) PCTFREE 20 TABLESPACE "USERS";';
const apps: App[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockReset().mockResolvedValue({ ddl });
  window.localStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  window.localStorage.clear();
});
async function mountViewer(type: "oracle" | "oceanbase-oracle" = "oracle") {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = { id: "oracle-viewer", name: "Oracle", db_type: type, host: "localhost", port: 1, username: "test", password: "" } as ConnectionConfig;
  useConnectionStore().connections = [connection];
  const store = useQueryStore();
  const settings = useSettingsStore();
  const id = store.createTab(connection.id, "service", "DDL", "query", "Owner", "", undefined, { forceNew: true, sourceView: true });
  const tab = store.tabs.find((tab) => tab.id === id)!;
  tab.ddlViewer = { schema: "Owner", tableName: "First", formatDialect: "plsql" };
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({ render: () => h(ContentArea, { activeTab: tab, activeConnection: connection, activeOutputView: "result", executableSql: "", formatSqlRequest: null, compressSqlRequest: null, selectedSql: "", cursorPos: 0, blockDangerousRedisCommands: false }) });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(container);
  apps.push(app);
  await vi.waitFor(() => expect(mocks.load).toHaveBeenCalled());
  return { tab, store, settings, container };
}
function toggle(container: HTMLElement, option: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[id$="-${option}"]`);
  expect(button).not.toBeNull();
  expect(button!.disabled).toBe(false);
  button!.click();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["oracle", "oceanbase-oracle"] as const)("re-renders %s read-only DDL from its baseline without re-querying", async (type) => {
  const { tab, container } = await mountViewer(type);
  await vi.waitFor(() => expect(tab.ddlLoad).toBeUndefined());
  expect(tab.sql).not.toContain("PCTFREE");
  expect(tab.sql).toContain("CREATE TABLE");
  expect(tab.ddlViewer!.displaySource).toBe(ddl);
  toggle(container, "includeDdlStorage");
  await nextTick();
  expect(tab.sql).toContain('PCTFREE 20 TABLESPACE "USERS"');
  toggle(container, "compactDdlSql");
  await nextTick();
  expect(tab.sql).toBe(ddl);
  expect(tab.originalSql).toBe(tab.sql);
  expect(mocks.load).toHaveBeenCalledOnce();
});

it("reloads the same read-only tab for independent indexes and ignores the superseded result", async () => {
  const old = deferred<{ ddl: string }>();
  mocks.load.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ddl: 'CREATE TABLE "First" (id NUMBER);\nCREATE INDEX current_index ON "First"(id);' });
  const { tab, container } = await mountViewer();
  toggle(container, "separateDdlIndexes");
  await vi.waitFor(() => expect(tab.sql).toContain("current_index"));
  expect(mocks.load.mock.calls[1][0]).toMatchObject({ connectionId: tab.connectionId, database: "service", schema: "Owner", tableName: "First", separateIndexes: true });
  old.resolve({ ddl: "STALE" });
  await nextTick();
  await nextTick();
  expect(tab.sql).not.toContain("STALE");
  expect(tab.ddlViewer!.separateIndexes).toBe(true);
});

it("keeps the DDL option controls available after a failed independent-index reload", async () => {
  const { tab, container } = await mountViewer();
  await vi.waitFor(() => expect(tab.ddlLoad).toBeUndefined());
  mocks.load.mockRejectedValueOnce(new Error("index metadata unavailable")).mockResolvedValueOnce({ ddl });
  toggle(container, "separateDdlIndexes");
  await vi.waitFor(() => expect(tab.ddlLoad?.error).toBe("index metadata unavailable"));
  toggle(container, "separateDdlIndexes");
  await vi.waitFor(() => expect(tab.ddlLoad).toBeUndefined());
  expect(tab.sql).toContain("CREATE TABLE");
  expect(tab.ddlViewer!.separateIndexes).toBe(false);
});

it("returns to the loaded baseline when independent indexes are switched back off during loading", async () => {
  const { tab, container } = await mountViewer();
  await vi.waitFor(() => expect(tab.ddlLoad).toBeUndefined());
  const pending = deferred<{ ddl: string }>();
  mocks.load.mockReturnValueOnce(pending.promise);
  toggle(container, "separateDdlIndexes");
  await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
  toggle(container, "separateDdlIndexes");
  await nextTick();
  expect(tab.ddlLoad).toBeUndefined();
  expect(tab.sql).toContain("CREATE TABLE");
  pending.resolve({ ddl: "STALE INDEX RESULT" });
  await nextTick();
  await nextTick();
  expect(tab.sql).not.toContain("STALE");
  expect(tab.ddlViewer!.separateIndexes).toBe(false);
  expect(mocks.load).toHaveBeenCalledTimes(2);
});
