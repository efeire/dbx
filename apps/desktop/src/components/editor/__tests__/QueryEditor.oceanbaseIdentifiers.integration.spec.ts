// @vitest-environment happy-dom

import { createApp, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorView, type HoverTooltipSource } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import QueryEditor from "../QueryEditor.vue";

const mocks = vi.hoisted(() => ({
  hoverSource: undefined as HoverTooltipSource | undefined,
  getTableDisplayDdl: vi.fn(async () => 'CREATE TABLE "HR"."EMP" ("ID" NUMBER);'),
}));

// Keep the real editor and production hover callback. Capture the CodeMirror
// registration so headless tests do not depend on browser pointer geometry.
vi.mock("@codemirror/view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codemirror/view")>();
  return {
    ...actual,
    hoverTooltip: (...args: Parameters<typeof actual.hoverTooltip>) => {
      mocks.hoverSource = args[0];
      return actual.hoverTooltip(...args);
    },
  };
});
vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    getTableDisplayDdl: mocks.getTableDisplayDdl,
    loadSchemaCache: vi.fn(async () => null),
    saveSchemaCache: vi.fn(async () => undefined),
    deleteSchemaCachePrefix: vi.fn(async () => undefined),
  };
});

const cleanups: Array<() => void> = [];
let sequence = 0;
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  mocks.getTableDisplayDdl.mockClear();
  mocks.hoverSource = undefined;
});

async function mountEditor(sql: string, tables: SqlCompletionTable[], options: { local?: boolean; schema?: string } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  const settings = useSettingsStore();
  settings.editorSettings.showTableDdlHoverPreview = true;
  settings.editorSettings.tableHoverLookupMode = "current";
  const local = vi.spyOn(store, "lookupLocalCompletionTables").mockReturnValue(options.local ? tables : []);
  const remote = vi.spyOn(store, "listCompletionTables").mockResolvedValue(tables);
  vi.spyOn(store, "lookupLocalCompletionObjects").mockReturnValue([]);
  vi.spyOn(store, "listCompletionObjects").mockResolvedValue([]);
  const connectionId = `ob-case-${++sequence}`;
  const onClickTable = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(QueryEditor, {
        modelValue: sql,
        tabId: connectionId,
        connectionId,
        database: "oracletest",
        schema: options.schema ?? "HR",
        databaseType: "oceanbase-oracle",
        autoFocus: false,
        onClickTable,
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull(), { timeout: 10_000 });
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  await vi.waitFor(() => expect(mocks.hoverSource).toBeTypeOf("function"));
  return { view, onClickTable, connectionId, local, remote };
}

function clickTable(view: EditorView, pos: number) {
  vi.spyOn(view, "posAtCoords").mockReturnValue(pos);
  view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
}

describe("mounted OceanBase Oracle identifier lookup", () => {
  it.each([
    ["select * from hr.emp", "HR", "EMP"],
    ['select * from hr."Emp"', "HR", "Emp"],
    ['select * from "Hr.Dot"."Emp.Dot"', "Hr.Dot", "Emp.Dot"],
    ["select * from emp", "HR", "EMP"],
  ])("uses canonical DDL and navigation parameters for %s", async (sql, schema, name) => {
    const table: SqlCompletionTable = { name, schema, type: "table" };
    const { view, onClickTable, connectionId, remote } = await mountEditor(sql, [table]);
    const pos = sql.length - 2;
    const tooltip = await mocks.hoverSource!(view, pos, 0);
    expect(tooltip).not.toBeNull();
    expect(remote).toHaveBeenCalledWith(connectionId, "oracletest", name, expect.any(Number), schema, false, "HR", undefined);
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledWith(connectionId, "oracletest", schema, name, undefined, undefined);
    clickTable(view, pos);
    await vi.waitFor(() => expect(onClickTable).toHaveBeenCalledWith(expect.objectContaining({ name, schema })));
  });

  it.each([false, true])("does not merge distinct quoted objects in the %s local-cache path", async (local) => {
    const sql = "select * from hr.emp";
    // Both objects really can coexist; the lowercase one must not replace EMP.
    const tables: SqlCompletionTable[] = [
      { name: "EMP", schema: "HR", type: "table" },
      { name: "emp", schema: "HR", type: "table" },
    ];
    const { view, connectionId, onClickTable } = await mountEditor(sql, tables, { local });
    expect(await mocks.hoverSource!(view, sql.length - 1, 0)).not.toBeNull();
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledWith(connectionId, "oracletest", "HR", "EMP", undefined, undefined);
    clickTable(view, sql.length - 1);
    await vi.waitFor(() => expect(onClickTable).toHaveBeenCalledWith(expect.objectContaining({ name: "EMP", schema: "HR" })));
  });

  it("normalizes the SQL-reference fallback when metadata discovery is empty", async () => {
    const sql = "select * from hr.emp";
    const { view, onClickTable } = await mountEditor(sql, []);
    clickTable(view, sql.length - 1);
    await vi.waitFor(() => expect(onClickTable).toHaveBeenCalledWith(expect.objectContaining({ name: "EMP", schema: "HR" })));
  });
});
