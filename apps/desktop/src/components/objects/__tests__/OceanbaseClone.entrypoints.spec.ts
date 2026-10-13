// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig, TreeNode } from "@/types/database";

const backend = vi.hoisted(() => ({ executeQuery: vi.fn(), buildCreateTableSql: vi.fn(), buildCopyTableDataSql: vi.fn() }));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  ...backend,
  listPlugins: vi.fn().mockResolvedValue([]),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
  listSchemas: vi.fn().mockResolvedValue(["APP"]),
  listDatabases: vi.fn().mockResolvedValue(["APP"]),
  listObjects: vi.fn().mockResolvedValue([{ name: "SOURCE", object_type: "TABLE", schema: "APP" }]),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  getColumns: vi.fn().mockResolvedValue([{ name: "ID", data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null }]),
  listConstraints: vi.fn().mockResolvedValue([]),
  listIndexes: vi.fn().mockResolvedValue([]),
  listTriggers: vi.fn().mockResolvedValue([]),
}));

const result = (rows: unknown[][] = []) => ({ columns: [], rows, affected_rows: 0, execution_time_ms: 0 });
const connection = { id: "ob-entry", name: "OB", db_type: "oceanbase-oracle", driver_profile: "oceanbase-oracle", host: "test", port: 2881, username: "APP", database: "APP" } as ConnectionConfig;
const source: TreeNode = { id: "ob-entry:APP:APP:table:SOURCE", type: "table", label: "SOURCE", connectionId: connection.id, database: "APP", schema: "APP" };
const mounted: App[] = [];
const auxiliaryRequests = new Set<string>();
const ddlCalls = () => backend.executeQuery.mock.calls.filter((call) => !String(call[2]).startsWith("SELECT "));

beforeEach(() => {
  vi.clearAllMocks();
  connection.is_production = false;
  invalidateObjectBrowserRowsCache({});
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
  vi.stubGlobal("alert", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      auxiliaryRequests.add(String(input));
      throw new Error(`Unexpected HTTP request: ${input}`);
    }),
  );
  backend.buildCreateTableSql.mockResolvedValue({ statements: ['CREATE TABLE "APP"."MixedCopy" ("ID" NUMBER);'], warnings: [] });
  backend.buildCopyTableDataSql.mockResolvedValue('INSERT INTO "APP"."MixedCopy" SELECT * FROM "APP"."SOURCE"');
  backend.executeQuery.mockImplementation(async (_id, _db, sql: string) => {
    if (sql.includes("ALL_TAB_COMMENTS")) return result([["source comment"]]);
    if (sql.includes("ALL_TABLES")) return result([["NO", "N"]]);
    return result();
  });
});

afterAll(() => expect([...auxiliaryRequests]).toEqual([]));

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  invalidateObjectBrowserRowsCache({});
});

async function mountEntry(surface: "sidebar" | "objects") {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  store.connections = [{ ...connection }];
  store.connectedIds.add(connection.id);
  store.treeNodes = [{ id: `${connection.id}:APP:APP`, type: "schema", label: "APP", connectionId: connection.id, database: "APP", schema: "APP", children: [], isExpanded: false }];
  const refresh = vi.spyOn(store, "refreshObjectListTreeNode");
  const component = ref<any>(null);
  const context = ref({ connection, database: "APP", schema: "APP" });
  let controller: any;
  const app = createApp({
    setup: () => () =>
      surface === "sidebar"
        ? h(SidebarTreeRuntimeHost, {
            ref: component,
            node: source,
            depth: 0,
            onOpenDialogController: (value: unknown) => {
              controller = value;
            },
          })
        : h(ObjectBrowser, { ref: component, ...context.value }),
  });
  app.use(pinia);
  app.use(i18n);
  const container = document.createElement("div");
  document.body.append(container);
  mounted.push(app);
  app.mount(container);
  await nextTick();
  if (surface === "sidebar") component.value.buildContextMenu(source);
  else controller = component.value.$.setupState;
  await nextTick();
  expect(controller).toBeDefined();
  controller.duplicateTableName = '"MixedCopy"';
  if (surface === "objects") controller.duplicateTarget = { name: "SOURCE", schema: "APP", object_type: "TABLE" };
  controller.pasteTableEntries = [{ sourceName: "SOURCE", targetName: '"MixedCopy"', connectionId: connection.id, database: "APP", schema: "APP" }];
  controller.pasteTableMode = "structure-and-data";
  return { controller, refresh, context };
}

describe.each(["sidebar", "objects"] as const)("%s OceanBase clone entry points", (surface) => {
  it.each(["confirmDuplicateStructure", "confirmPasteTable"])("honors production confirmation cancellation in %s", async (action) => {
    connection.is_production = true;
    const { controller, refresh } = await mountEntry(surface);
    const pending = controller[action]();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending?.sql).toContain("CREATE TABLE"));
    safety.cancel();
    await pending;
    expect(ddlCalls()).toEqual([]);
    expect(backend.buildCopyTableDataSql).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(["confirmDuplicateStructure", "confirmPasteTable"])("cancels %s before any DDL or data copy", async (action) => {
    const { controller } = await mountEntry(surface);
    vi.mocked(window.confirm).mockReturnValue(false);
    await controller[action]();
    expect(window.confirm).toHaveBeenCalled();
    expect(ddlCalls()).toEqual([]);
    expect(backend.buildCopyTableDataSql).not.toHaveBeenCalled();
  });

  it.each(["confirmDuplicateStructure", "confirmPasteTable"])("refreshes after partial failure in %s and stops later writes", async (action) => {
    const { controller, refresh } = await mountEntry(surface);
    const read = backend.executeQuery.getMockImplementation()!;
    backend.executeQuery.mockImplementation(async (...args) => (String(args[2]).startsWith("COMMENT ") ? { ...result(), execution_error: true, error: { detail: "ORA-01031: insufficient privileges" } } : read(...args)));
    await controller[action]();
    expect(ddlCalls()).toHaveLength(2);
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("Rejected by the database"));
    expect(refresh).toHaveBeenCalledWith(connection.id, "APP", "APP");
    expect(backend.buildCopyTableDataSql).not.toHaveBeenCalled();
  });

  it("uses the resolved exact name for data copy after structure creation", async () => {
    const { controller } = await mountEntry(surface);
    await controller.confirmPasteTable();
    expect(backend.buildCopyTableDataSql).toHaveBeenCalledWith(expect.objectContaining({ targetName: "MixedCopy", schema: "APP", normalizeNewTargetName: false }));
    expect(ddlCalls().map((call) => call[2])).toEqual(['CREATE TABLE "APP"."MixedCopy" ("ID" NUMBER)', 'COMMENT ON TABLE "APP"."MixedCopy" IS \'source comment\'', 'INSERT INTO "APP"."MixedCopy" SELECT * FROM "APP"."SOURCE"']);
  });
});

describe.each([false, true])("ObjectBrowser clone execution identity (comment rejected: %s)", (rejected) => {
  it.each(["confirmDuplicateStructure", "confirmPasteTable"])("keeps writes on the original connection during %s", async (action) => {
    const { controller, context, refresh } = await mountEntry("objects");
    const read = backend.executeQuery.getMockImplementation()!;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.executeQuery.mockImplementation(async (...args) => {
      if (String(args[2]).startsWith("CREATE TABLE")) await paused;
      if (rejected && String(args[2]).startsWith("COMMENT ")) return { ...result(), execution_error: true, error: { detail: "ORA-01031: insufficient privileges" } };
      return read(...args);
    });
    const pending = controller[action]();
    await vi.waitFor(() => expect(ddlCalls()).toHaveLength(1));
    const otherConnection = { ...connection, id: "different-connection" };
    const store = useConnectionStore();
    store.connections.push(otherConnection);
    store.connectedIds.add(otherConnection.id);
    context.value = { connection: otherConnection, database: "OTHER", schema: "OTHER" };
    await nextTick();
    release();
    await pending;
    expect(ddlCalls().map((call) => call.slice(0, 2))).toEqual(ddlCalls().map(() => [connection.id, "APP"]));
    expect(refresh).toHaveBeenCalledWith(connection.id, "APP", "APP");
    expect(refresh.mock.calls.every((call) => call[0] === connection.id)).toBe(true);
    if (rejected) expect(backend.buildCopyTableDataSql).not.toHaveBeenCalled();
  });
});

describe("ObjectBrowser clone confirmation identity", () => {
  it.each(["confirmDuplicateStructure", "confirmPasteTable"])("checks the original production connection after planning in %s", async (action) => {
    connection.is_production = true;
    const { controller, context } = await mountEntry("objects");
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.buildCreateTableSql.mockImplementationOnce(async () => {
      await paused;
      return { statements: ['CREATE TABLE "APP"."MixedCopy" ("ID" NUMBER);'], warnings: [] };
    });
    const pending = controller[action]();
    await vi.waitFor(() => expect(backend.buildCreateTableSql).toHaveBeenCalled());
    const otherConnection = { ...connection, id: "different-connection", is_production: false };
    const store = useConnectionStore();
    store.connections.push(otherConnection);
    store.connectedIds.add(otherConnection.id);
    context.value = { connection: otherConnection, database: "OTHER", schema: "OTHER" };
    await nextTick();
    release();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending?.database).toBe("APP"));
    safety.cancel();
    await pending;
    expect(ddlCalls()).toEqual([]);
  });
});
