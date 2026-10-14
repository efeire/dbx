// @vitest-environment happy-dom
import { createApp, h, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TableStructureEditor from "../TableStructureEditor.vue";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { invalidateObjectMetadataCache } from "@/lib/metadata/objectMetadataCache";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  listPlugins: vi.fn().mockResolvedValue([]),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
  listDataTypes: vi.fn().mockResolvedValue([]),
  getColumns: vi.fn(async (_id, _database, _schema, table) => (table === "SOURCE" ? ["A", "B"] : ["ID", "V"]).map((name) => ({ name, data_type: "NUMBER", is_nullable: true, is_primary_key: false, column_default: null }))),
  listConstraints: vi.fn().mockResolvedValue([]),
  listIndexes: vi.fn().mockResolvedValue([]),
  listForeignKeys: vi.fn().mockResolvedValue([
    { name: "FK_SOURCE", column: "A", ref_schema: "PARENT_OWNER", ref_table: "PARENT", ref_column: "ID", on_delete: "CASCADE", on_update: null },
    { name: "FK_SOURCE", column: "B", ref_schema: "PARENT_OWNER", ref_table: "PARENT", ref_column: "V", on_delete: "CASCADE", on_update: null },
  ]),
  listTriggers: vi.fn().mockResolvedValue([]),
  getTableComment: vi.fn().mockResolvedValue(""),
  getTablePartitioning: vi.fn().mockResolvedValue(null),
  buildTableStructureChangeSql: vi.fn().mockResolvedValue({ statements: [], warnings: [] }),
  executeQuery: vi.fn(async (_id, _database, sql: string) => ({
    columns: [],
    rows: sql.includes("SELECT USER")
      ? [["APP"]]
      : sql.includes("SYS.ALL_TABLES")
        ? [["APP", "SOURCE"]]
        : sql.includes("SYS.ALL_CONSTRAINTS") || sql.includes("SYS.USER_CONSTRAINTS")
          ? [["FK_SOURCE", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "PARENT_OWNER", "PK_PARENT", "CASCADE"]]
          : [['ALTER TABLE "APP"."SOURCE" ADD CONSTRAINT "FK_SOURCE" FOREIGN KEY ("A", "B") REFERENCES "PARENT_OWNER"."PARENT" ("ID", "V") ON DELETE CASCADE ENABLE VALIDATE']],
    execution_time_ms: 0,
    rows_affected: 0,
  })),
}));

let app: App | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  i18n.global.locale.value = "en";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected HTTP request");
    }),
  );
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Oracle family foreign key editing entry", () => {
  it.each([
    { databaseType: "oracle", readable: true },
    { databaseType: "oceanbase-oracle", readable: true },
    { databaseType: "oracle", readable: false },
    { databaseType: "oceanbase-oracle", readable: false },
  ])("activates $databaseType editing only after definition verification (readable=$readable)", async ({ databaseType, readable }) => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useConnectionStore();
    const id = `foreign-key-${databaseType}`;
    store.connections = [{ id, name: "Foreign key fixture", db_type: databaseType, driver_profile: databaseType, host: "fixture", port: 2881, username: "APP", database: "APP" } as ConnectionConfig];
    store.connectedIds.add(id);
    await invalidateObjectMetadataCache({ connectionId: id });
    const container = document.createElement("div");
    document.body.append(container);
    app = createApp({ render: () => h(TooltipProvider, {}, { default: () => h(TableStructureEditor, { connectionId: id, database: "APP", schema: "APP", tableName: "SOURCE", initialTab: "foreignKeys" }) }) });
    app.use(pinia);
    app.use(i18n);
    app.component("LightTooltip", LightTooltip);
    app.mount(container);
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>('input[placeholder="' + i18n.global.t("structureEditor.foreignKeyName") + '"]')?.value).toBe("FK_SOURCE"));
    const name = container.querySelector<HTMLInputElement>('input[placeholder="' + i18n.global.t("structureEditor.foreignKeyName") + '"]')!;
    expect(container.textContent).toContain("PARENT_OWNER.PARENT");
    expect(name.disabled).toBe(true);
    const edit = container.querySelector<HTMLButtonElement>("[data-oracle-foreign-key-edit]");
    expect(edit).not.toBeNull();
    if (!readable) vi.mocked(api.executeQuery).mockRejectedValueOnce(new Error("Metadata access denied"));
    edit!.click();
    if (!readable) {
      await vi.waitFor(() => expect(edit!.disabled).toBe(false));
      expect(name.disabled).toBe(true);
      expect(container.querySelector("[data-oracle-foreign-key-state]")).toBeNull();
      expect(api.executeQuery).toHaveBeenCalledTimes(1);
      return;
    }
    await vi.waitFor(() => expect(name.disabled).toBe(false));
    expect(api.executeQuery).toHaveBeenCalledTimes(databaseType === "oracle" ? 3 : 4);
    expect(vi.mocked(api.executeQuery).mock.calls.every((call) => call[2].startsWith("SELECT "))).toBe(true);
    const enabled = container.querySelector<HTMLInputElement>("[data-oracle-foreign-key-enabled]")!;
    const validated = container.querySelector<HTMLInputElement>("[data-oracle-foreign-key-validated]")!;
    const deferrable = container.querySelector<HTMLInputElement>("[data-oracle-foreign-key-deferrable]")!;
    expect(enabled.checked).toBe(true);
    expect(validated.checked).toBe(true);
    expect(deferrable.disabled).toBe(databaseType !== "oracle");
    enabled.checked = false;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(enabled.checked).toBe(false));
    if (databaseType === "oracle") {
      deferrable.checked = true;
      deferrable.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("[data-oracle-foreign-key-deferred]")!.disabled).toBe(false));
    }
    const referenceInputs = () => Array.from(container.querySelectorAll<HTMLInputElement>("[data-oracle-foreign-key-reference]"));
    expect(referenceInputs().map((input) => input.value)).toEqual(["ID", "V"]);
    container.querySelector<HTMLButtonElement>("[data-oracle-foreign-key-down]")!.click();
    await vi.waitFor(() => expect(referenceInputs().map((input) => input.value)).toEqual(["V", "ID"]));
    const rows = container.querySelectorAll("[data-oracle-foreign-key-pair]");
    expect(rows[0]!.textContent).toContain("B");
    expect(rows[1]!.textContent).toContain("A");
    const parentTable = container.querySelector<HTMLInputElement>('input[placeholder="' + i18n.global.t("structureEditor.referencedTable") + '"]')!;
    parentTable.value = "OtherParent";
    parentTable.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(referenceInputs().map((input) => input.value)).toEqual(["", ""]));
  });
});
