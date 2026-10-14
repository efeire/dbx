// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression: after creating a table the editor converts itself into the edit
// tab of the new table, so the emitted created name must be the name the
// server actually stored. The CREATE DDL emits plain Oracle identifiers
// unquoted (stored upper-folded) and plain Informix-family identifiers
// unquoted (stored lower-folded); dialects that quote new names keep the
// as-typed spelling. Emitting the as-typed name on a folding dialect left the
// converted edit tab querying a case that matches nothing.

const mocks = vi.hoisted(() => ({
  connection: {
    id: "structure-create-mode",
    name: "Oracle",
    db_type: "oracle",
    driver_label: "Oracle",
    database: "APP",
    production_databases: [] as string[],
  },
  ensureConnected: vi.fn(),
  connectionStateRevision: vi.fn(() => 1),
  isCurrentConnectionStateRevision: vi.fn(() => true),
  executeQuery: vi.fn(),
  executeBatch: vi.fn(),
  listDataTypes: vi.fn(),
  buildTableStructureChangeSql: vi.fn(),
  buildCreateTableSql: vi.fn(),
  buildMysqlAutoIncrementSql: vi.fn(),
  buildTableOwnerChangeSql: vi.fn(),
  getTablePartitionStatus: vi.fn(),
  getTableOwner: vi.fn(),
  updateEditorSettings: vi.fn(),
  loadObjectDdl: vi.fn(),
  invalidateObjectDdl: vi.fn(),
  loadObjectMetadataFacet: vi.fn(),
  invalidateObjectMetadataCache: vi.fn(),
  invalidateTableMetadataCache: vi.fn(),
  requestConfirmation: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  const Icon = defineComponent({ name: "Icon", setup: () => () => h("span") });
  return {
    AlertTriangle: Icon,
    Check: Icon,
    ChevronDown: Icon,
    ChevronLeft: Icon,
    ChevronRight: Icon,
    ChevronUp: Icon,
    ClipboardList: Icon,
    Copy: Icon,
    Database: Icon,
    Info: Icon,
    Keyboard: Icon,
    KeyRound: Icon,
    ListChevronsUpDown: Icon,
    Loader2: Icon,
    Maximize2: Icon,
    Pencil: Icon,
    Plus: Icon,
    RefreshCw: Icon,
    RotateCcw: Icon,
    Rows3: Icon,
    Save: Icon,
    Search: Icon,
    Settings: Icon,
    SlidersHorizontal: Icon,
    Trash2: Icon,
    UserRound: Icon,
    X: Icon,
  };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      name: "Button",
      inheritAttrs: false,
      setup:
        (_props, { attrs, slots }) =>
        () =>
          h("button", attrs, slots.default?.()),
    }),
  };
});
vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      name: "Input",
      inheritAttrs: false,
      props: { modelValue: { type: [String, Number], default: "" } },
      emits: ["update:modelValue"],
      setup:
        (props, { attrs, emit }) =>
        () =>
          h("input", {
            ...attrs,
            value: props.modelValue,
            onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
          }),
    }),
  };
});
vi.mock("@/components/ui/badge", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Badge: defineComponent({
      name: "Badge",
      inheritAttrs: false,
      setup:
        (_props, { attrs }) =>
        () =>
          h("span", attrs),
    }),
  };
});
vi.mock("@/components/ui/tabs", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs }) =>
      () =>
        h("div", attrs),
  });
  const TabsContent = defineComponent({
    name: "MockTabsContent",
    inheritAttrs: false,
    setup:
      (_props, { attrs }) =>
      () =>
        h("div", attrs),
  });
  const TabsTrigger = defineComponent({
    name: "MockTabsTrigger",
    inheritAttrs: false,
    props: { value: { type: String, required: true } },
    setup:
      (props, { attrs }) =>
      () =>
        h("button", { ...attrs, type: "button", "data-tab-trigger": props.value }),
  });
  return { Tabs: Div, TabsContent, TabsList: Div, TabsTrigger };
});
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs }) =>
      () =>
        h("div", attrs),
  });
  return { DropdownMenu: Div, DropdownMenuCheckboxItem: Div, DropdownMenuContent: Div, DropdownMenuItem: Div, DropdownMenuTrigger: Div };
});
vi.mock("@/components/ui/popover", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs }) =>
      () =>
        h("div", attrs),
  });
  return { Popover: Div, PopoverContent: Div, PopoverTrigger: Div };
});
vi.mock("@/components/ui/tooltip", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs }) =>
      () =>
        h("div", attrs),
  });
  return { Tooltip: Div, TooltipContent: Div, TooltipTrigger: Div };
});
vi.mock("@/components/ui/searchable-select", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    SearchableSelect: defineComponent({
      name: "SearchableSelect",
      inheritAttrs: false,
      props: { modelValue: { type: String, default: "" } },
      emits: ["update:modelValue"],
      setup:
        (props, { attrs }) =>
        () =>
          h("button", { ...attrs, type: "button", "data-model-value": props.modelValue }),
    }),
  };
});
vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const Div = defineComponent({
    inheritAttrs: false,
    setup:
      (_props, { attrs }) =>
      () =>
        h("div", attrs),
  });
  return { Select: Div, SelectContent: Div, SelectItem: Div, SelectTrigger: Div, SelectValue: Div };
});
vi.mock("@/components/editor/DangerConfirmDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { open: Boolean, title: String, message: String },
      setup:
        (props, { slots }) =>
        () =>
          props.open ? h("div", { role: "alertdialog" }, [h("h2", props.title), h("p", props.message), slots.options?.()]) : null,
    }),
  };
});
vi.mock("@/components/editor/EditorSearchPanel.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "MockEditorSearchPanel",
      setup: () => ({ openSearch: () => false, closeSearch: () => false }),
      render: () => h("div", { "data-editor-search-panel": "true" }),
    }),
  };
});

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: (connectionId: string) => (connectionId === mocks.connection.id ? mocks.connection : undefined),
    connectionStateRevision: mocks.connectionStateRevision,
    isCurrentConnectionStateRevision: mocks.isCurrentConnectionStateRevision,
  }),
}));
vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => ({ requestConfirmation: mocks.requestConfirmation }) }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ tableStructureRefreshVersion: () => 0 }) }));
vi.mock("@/stores/historyStore", () => ({ useHistoryStore: () => ({ add: vi.fn() }) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { structureEditorDensity: "compact", sqlFormatter: {}, tableColumnTemplateFields: [], fontSize: 13, fontFamily: "monospace", theme: "default", generateSqlQuoteIdentifiers: true },
    updateEditorSettings: mocks.updateEditorSettings,
  }),
}));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false }, themePalette: { value: "pearl" } }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/sql/sqlHighlighter", () => ({ createShikiSqlHighlighter: vi.fn(async () => (sql: string) => sql) }));
vi.mock("@/lib/sql/sqlFormatter", () => ({
  formatSqlForDisplay: vi.fn(async (sql: string) => sql),
  sqlFormatDialectForDbType: vi.fn(() => "mysql"),
}));
vi.mock("@/lib/editor/editorThemes", () => ({ loadEditorTheme: vi.fn(async () => []), editorFontTheme: vi.fn(() => []) }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({
  loadObjectDdl: mocks.loadObjectDdl,
  invalidateObjectDdl: mocks.invalidateObjectDdl,
}));
vi.mock("@/lib/metadata/objectMetadataCache", () => ({ loadObjectMetadataFacet: mocks.loadObjectMetadataFacet, invalidateObjectMetadataCache: mocks.invalidateObjectMetadataCache }));
vi.mock("@/lib/metadata/tableMetadataCache", () => ({ invalidateTableMetadataCache: mocks.invalidateTableMetadataCache }));
vi.mock("@/lib/backend/api", () => ({
  executeQuery: mocks.executeQuery,
  executeBatch: mocks.executeBatch,
  listDataTypes: mocks.listDataTypes,
  buildTableStructureChangeSql: mocks.buildTableStructureChangeSql,
  buildCreateTableSql: mocks.buildCreateTableSql,
  buildMysqlAutoIncrementSql: mocks.buildMysqlAutoIncrementSql,
  buildTableOwnerChangeSql: mocks.buildTableOwnerChangeSql,
  getTablePartitionStatus: mocks.getTablePartitionStatus,
  getTableOwner: mocks.getTableOwner,
}));

import TableStructureEditor from "@/components/structure/TableStructureEditor.vue";

const mountedApps: App[] = [];

async function settle() {
  for (let i = 0; i < 30; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

type SavedPayload = { commentChanged: boolean; createdTableName?: string };

/**
 * Mount the editor in create mode, run the generated CREATE batch to
 * completion, and return what the `saved` event carried — the exact string
 * the converted edit tab would be assigned as its table name.
 */
async function createTableAndCaptureSaved(dbType: string, newTableName: string): Promise<SavedPayload> {
  const previousDbType = mocks.connection.db_type;
  mocks.connection.db_type = dbType;
  let saved: SavedPayload | undefined;
  try {
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "test",
      tableName: "",
      draft: {
        dirty: true,
        activeTab: "columns",
        newTableName,
        tableComment: "",
        originalTableComment: "",
        columns: [{ id: "new:id", name: "id", dataType: "number", isNullable: false, defaultValue: "", comment: "", isPrimaryKey: false, extra: {}, markedForDrop: false }],
        indexes: [],
        foreignKeys: [],
        triggers: [],
        initialized: true,
      },
      onSaved: (commentChanged: boolean, createdName?: string) => {
        saved = { commentChanged, createdTableName: createdName };
      },
    });
    mountedApps.push(app);
    const editor = app.mount(root) as unknown as { applyChanges: () => Promise<boolean> };

    // The SQL preview is debounced (300ms), and a hydrated draft schedules a
    // second refresh on mount; poll the apply entry point — its guard returns
    // false without side effects while the preview is still pending.
    await vi.waitFor(() => expect(mocks.buildCreateTableSql).toHaveBeenCalled(), { timeout: 3000 });
    await vi.waitFor(
      async () => {
        const applied = await editor.applyChanges();
        expect(applied).toBe(true);
      },
      { timeout: 3000 },
    );
    expect(mocks.executeBatch).toHaveBeenCalled();
    await settle();
  } finally {
    mocks.connection.db_type = previousDbType;
  }
  expect(saved).toBeDefined();
  return saved!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connection.production_databases = [];
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.requestConfirmation.mockResolvedValue(true);
  mocks.executeQuery.mockResolvedValue({ columns: [], rows: [] });
  mocks.executeBatch.mockResolvedValue({ rowsAffected: 0 });
  mocks.listDataTypes.mockResolvedValue([]);
  mocks.getTablePartitionStatus.mockResolvedValue({ isPartitionedParent: false, isPartition: false, isForeign: false });
  mocks.getTableOwner.mockResolvedValue("");
  mocks.buildTableOwnerChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: [], warnings: [] });
  mocks.buildCreateTableSql.mockResolvedValue({ statements: ["CREATE TABLE MyTable (id number)"], warnings: [] });
  mocks.loadObjectDdl.mockResolvedValue({ ddl: "CREATE TABLE MyTable (id number)", cacheStatus: "remote" });
  mocks.loadObjectMetadataFacet.mockImplementation(async (_request: unknown, facet: string) => ({
    value: facet === "comment" ? "" : [],
    cacheStatus: "remote",
  }));
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("TableStructureEditor created-table name write-back", () => {
  it("emits the upper-folded storage name for a plain Oracle table", async () => {
    const saved = await createTableAndCaptureSaved("oracle", "MyTable");
    expect(saved.createdTableName).toBe("MYTABLE");
  });

  it("emits the lower-folded storage name for a plain Informix-family table", async () => {
    const saved = await createTableAndCaptureSaved("informix", "MyTable");
    expect(saved.createdTableName).toBe("mytable");
  });

  it("emits the as-typed name unchanged on dialects that quote new identifiers", async () => {
    const postgres = await createTableAndCaptureSaved("postgres", "MyTable");
    expect(postgres.createdTableName).toBe("MyTable");

    const mysql = await createTableAndCaptureSaved("mysql", "MyTable");
    expect(mysql.createdTableName).toBe("MyTable");
  });

  it("keeps a quoting-required Oracle name exactly as typed", async () => {
    const saved = await createTableAndCaptureSaved("oracle", "my table");
    expect(saved.createdTableName).toBe("my table");
  });

  it("preflights and executes an Oracle self-reference through the ordered create plan", async () => {
    mocks.connection.db_type = "oracle";
    mocks.connection.production_databases = ["APP"];
    mocks.buildCreateTableSql.mockResolvedValue({
      statements: ['CREATE TABLE "APP".MyTable (id number NOT NULL, parent_id number, CONSTRAINT PK_NEW PRIMARY KEY (id));', 'ALTER TABLE "APP".MyTable ADD CONSTRAINT fk_new FOREIGN KEY (parent_id) REFERENCES "APP".MyTable (id) NORELY ENABLE VALIDATE;'],
      warnings: [],
    });
    const ddl = 'ALTER TABLE "APP"."MYTABLE" ADD CONSTRAINT "FK_NEW" FOREIGN KEY ("PARENT_ID") REFERENCES "APP"."MYTABLE" ("ID") ENABLE VALIDATE;';
    mocks.executeQuery.mockImplementation(async (_id, _database, sql: string) => ({
      columns: [],
      rows: sql.includes("SELECT USER, SYS_CONTEXT")
        ? [["APP", "APP"]]
        : sql.includes("SYS.ALL_OBJECTS")
          ? [["APP", "MYTABLE", 802]]
          : sql.includes("SYS.ALL_TAB_COLS")
            ? [
                ["ID", "NUMBER", 22, null, null, "N"],
                ["PARENT_ID", "NUMBER", 22, null, null, "Y"],
              ]
            : sql.includes("SYS.ALL_TABLES")
              ? [["APP", "MYTABLE"]]
              : sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")
                ? [["FK_NEW", "MYTABLE"]]
                : sql.includes("SYS.ALL_CONSTRAINTS")
                  ? [["FK_NEW", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "APP", "PK_NEW", "NO ACTION"]]
                  : sql.includes("DBMS_METADATA.GET_DDL")
                    ? [[ddl]]
                    : [],
      execution_time_ms: 0,
      rows_affected: 0,
    }));
    let savedName: string | undefined;
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "APP",
      schema: "APP",
      tableName: "",
      draft: {
        dirty: true,
        activeTab: "foreignKeys",
        newTableName: "MyTable",
        tableComment: "",
        originalTableComment: "",
        columns: [
          { id: "new:id", name: "id", dataType: "number", isNullable: false, defaultValue: "", comment: "", isPrimaryKey: true, extra: {}, markedForDrop: false },
          { id: "new:parent", name: "parent_id", dataType: "number", isNullable: true, defaultValue: "", comment: "", isPrimaryKey: false, extra: {}, markedForDrop: false },
        ],
        indexes: [],
        foreignKeys: [
          {
            id: "new:fk",
            name: "fk_new",
            column: "parent_id",
            columns: ["parent_id"],
            refSchema: "APP",
            refTable: "MyTable",
            refColumn: "id",
            refColumns: ["id"],
            onUpdate: "",
            onDelete: "NO ACTION",
            oracleState: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false },
            markedForDrop: false,
          },
        ],
        triggers: [],
        initialized: true,
      },
      onSaved: (_commentChanged: boolean, createdName?: string) => {
        savedName = createdName;
      },
    });
    mountedApps.push(app);
    const editor = app.mount(root) as unknown as { applyChanges: () => Promise<boolean> };
    await vi.waitFor(() => expect(mocks.buildCreateTableSql).toHaveBeenCalled());
    mocks.requestConfirmation.mockResolvedValueOnce(false);
    expect(await editor.applyChanges()).toBe(false);
    expect(mocks.executeQuery.mock.calls.some((call) => /^(CREATE TABLE|ALTER TABLE)\b/i.test(String(call[2])))).toBe(false);
    expect(mocks.requestConfirmation).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect(await editor.applyChanges()).toBe(true), { timeout: 3000 });
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("CREATE TABLE"))).toHaveLength(1);
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER TABLE"))).toHaveLength(1);
    expect(savedName).toBe("MYTABLE");
  });

  it("shows partial new-table foreign-key results and never replays committed DDL", async () => {
    mocks.connection.db_type = "oracle";
    mocks.buildCreateTableSql.mockResolvedValue({
      statements: [
        'CREATE TABLE "APP".MyTable (id number NOT NULL, parent_id number, CONSTRAINT PK_NEW PRIMARY KEY (id));',
        'ALTER TABLE "APP".MyTable ADD CONSTRAINT fk_first FOREIGN KEY (parent_id) REFERENCES "APP".MyTable (id) NORELY ENABLE VALIDATE;',
        'ALTER TABLE "APP".MyTable ADD CONSTRAINT fk_second FOREIGN KEY (parent_id) REFERENCES "APP".MyTable (id) NORELY ENABLE VALIDATE;',
      ],
      warnings: [],
    });
    const writes: string[] = [];
    let secondForeignKeyAttempts = 0;
    mocks.executeQuery.mockImplementation(async (_id, _database, sql: string) => {
      if (/^(CREATE TABLE|ALTER TABLE)\b/i.test(sql)) {
        writes.push(sql);
        if (sql.toUpperCase().includes("FK_SECOND") && secondForeignKeyAttempts++ === 0) return { columns: [], rows: [], execution_error: true, error: { detail: "Second foreign key rejected" } };
      }
      const ddl = sql.includes("FK_SECOND")
        ? 'ALTER TABLE "APP"."MYTABLE" ADD CONSTRAINT "FK_SECOND" FOREIGN KEY ("PARENT_ID") REFERENCES "APP"."MYTABLE" ("ID") ENABLE VALIDATE;'
        : 'ALTER TABLE "APP"."MYTABLE" ADD CONSTRAINT "FK_FIRST" FOREIGN KEY ("PARENT_ID") REFERENCES "APP"."MYTABLE" ("ID") ENABLE VALIDATE;';
      return {
        columns: [],
        rows: sql.includes("SELECT USER, SYS_CONTEXT")
          ? [["APP", "APP"]]
          : sql.includes("SYS.ALL_OBJECTS")
            ? [["APP", "MYTABLE", 802]]
            : sql.includes("SYS.ALL_TAB_COLS")
              ? [
                  ["ID", "NUMBER", 22, null, null, "N"],
                  ["PARENT_ID", "NUMBER", 22, null, null, "Y"],
                ]
              : sql.includes("SYS.ALL_TABLES")
                ? [["APP", "MYTABLE"]]
                : sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")
                  ? secondForeignKeyAttempts > 1
                    ? [
                        ["FK_FIRST", "MYTABLE"],
                        ["FK_SECOND", "MYTABLE"],
                      ]
                    : [["FK_FIRST", "MYTABLE"]]
                  : sql.includes("SYS.ALL_CONSTRAINTS")
                    ? secondForeignKeyAttempts > 1
                      ? [
                          ["FK_FIRST", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "APP", "PK_NEW", "NO ACTION"],
                          ["FK_SECOND", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "APP", "PK_NEW", "NO ACTION"],
                        ]
                      : [["FK_FIRST", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "APP", "PK_NEW", "NO ACTION"]]
                    : sql.includes("DBMS_METADATA.GET_DDL")
                      ? [[ddl]]
                      : [],
        execution_time_ms: 0,
        rows_affected: 0,
      };
    });
    let savedName: string | undefined;
    let savedDraft: import("@/types/database").TableStructureEditorDraft | undefined;
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "APP",
      schema: "APP",
      tableName: "",
      draft: {
        dirty: true,
        activeTab: "foreignKeys",
        newTableName: "MyTable",
        tableComment: "",
        originalTableComment: "",
        columns: [
          { id: "new:id", name: "id", dataType: "number", isNullable: false, defaultValue: "", comment: "", isPrimaryKey: true, extra: {}, markedForDrop: false },
          { id: "new:parent", name: "parent_id", dataType: "number", isNullable: true, defaultValue: "", comment: "", isPrimaryKey: false, extra: {}, markedForDrop: false },
        ],
        indexes: [],
        foreignKeys: ["first", "second"].map((name) => ({
          id: `new:fk_${name}`,
          name: `fk_${name}`,
          column: "parent_id",
          columns: ["parent_id"],
          refSchema: "APP",
          refTable: "MyTable",
          refColumn: "id",
          refColumns: ["id"],
          onUpdate: "",
          onDelete: "NO ACTION",
          oracleState: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false },
          markedForDrop: false,
        })),
        triggers: [],
        initialized: true,
      },
      onSaved: (_commentChanged: boolean, createdName?: string) => {
        savedName = createdName;
      },
      "onUpdate:draft": (draft: import("@/types/database").TableStructureEditorDraft | undefined) => {
        savedDraft = draft;
      },
    });
    mountedApps.push(app);
    const editor = app.mount(root) as unknown as { applyChanges: () => Promise<boolean> };
    await vi.waitFor(() => expect(mocks.buildCreateTableSql).toHaveBeenCalled());
    const applyButton = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("structureEditor.apply"))!;
    await vi.waitFor(() => expect(applyButton.disabled).toBe(false), { timeout: 3000 });

    expect(await editor.applyChanges()).toBe(false);
    await vi.waitFor(() => expect(savedName).toBe("MYTABLE"));
    expect(root.textContent).toContain("oracleForeignKey.createdTablePartial");
    expect(root.textContent).toContain("oceanbasePrimaryKey.committed");
    expect(root.textContent).toContain("oceanbasePrimaryKey.rejected");
    expect(root.textContent).toContain("Second foreign key rejected");
    expect(savedDraft?.oracleForeignKeyCreateRecovery).toMatchObject({
      tableName: "MYTABLE",
      tableExists: true,
      remaining: [{ name: "FK_SECOND", columns: ["PARENT_ID"], refSchema: "APP", refTable: "MYTABLE", refColumns: ["ID"] }],
    });
    expect(savedDraft?.columns).toEqual([]);
    expect(writes).toHaveLength(3);
    expect(writes.filter((sql) => sql.startsWith("CREATE TABLE"))).toHaveLength(1);
    expect(writes.filter((sql) => sql.includes("fk_first"))).toHaveLength(1);
    expect(writes.filter((sql) => sql.includes("fk_second"))).toHaveLength(1);
    expect(await editor.applyChanges()).toBe(false);
    expect(writes).toHaveLength(3);

    const resumedRoot = document.createElement("div");
    document.body.append(resumedRoot);
    mocks.buildTableStructureChangeSql.mockResolvedValue({ statements: ['ALTER TABLE "APP"."MYTABLE" ADD CONSTRAINT "FK_SECOND" FOREIGN KEY ("PARENT_ID") REFERENCES "APP"."MYTABLE" ("ID") ENABLE VALIDATE;'], warnings: [] });
    const resumedApp = createApp(TableStructureEditor, { connectionId: mocks.connection.id, database: "APP", schema: "APP", tableName: "MYTABLE", draft: savedDraft });
    mountedApps.push(resumedApp);
    const resumedEditor = resumedApp.mount(resumedRoot) as unknown as { applyChanges: () => Promise<boolean> };
    await vi.waitFor(() => expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).includes("SYS.ALL_OBJECTS"))).toBe(true));
    await vi.waitFor(() => expect(resumedRoot.textContent).not.toContain("structureEditor.loading"));
    expect(mocks.buildTableStructureChangeSql).toHaveBeenCalled();
    const resumedApplyButton = Array.from(resumedRoot.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("structureEditor.apply"))!;
    await vi.waitFor(() => expect(resumedApplyButton.disabled).toBe(false), { timeout: 3000 });
    const sourceSnapshotsBeforeApply = mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("SYS.ALL_OBJECTS")).length;
    await vi.waitFor(async () => expect(await resumedEditor.applyChanges()).toBe(true), { timeout: 3000 });
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("SYS.ALL_OBJECTS")).length).toBeGreaterThan(sourceSnapshotsBeforeApply);
    expect(resumedRoot.textContent).not.toContain("oracleForeignKey.invalid");
    expect(mocks.buildTableStructureChangeSql).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: "MYTABLE",
        oracleForeignKeyChanges: [expect.objectContaining({ original: null, target: expect.objectContaining({ name: "FK_SECOND", columns: ["PARENT_ID"], refSchema: "APP", refTable: "MYTABLE", refColumns: ["ID"] }) })],
      }),
    );
    expect(writes.filter((sql) => sql.startsWith("CREATE TABLE"))).toHaveLength(1);
    expect(writes.filter((sql) => sql.toUpperCase().includes("FK_FIRST"))).toHaveLength(1);
    expect(writes.filter((sql) => sql.toUpperCase().includes("FK_SECOND"))).toHaveLength(2);
  });

  it("blocks retry after an unknown CREATE response until the table is manually verified", async () => {
    mocks.connection.db_type = "oracle";
    const create = 'CREATE TABLE "APP".MyTable (id number NOT NULL, CONSTRAINT PK_NEW PRIMARY KEY (id));';
    mocks.buildCreateTableSql.mockResolvedValue({
      statements: [create, 'ALTER TABLE "APP".MyTable ADD CONSTRAINT fk_self FOREIGN KEY (id) REFERENCES "APP".MyTable (id) NORELY ENABLE VALIDATE;'],
      warnings: [],
    });
    mocks.executeQuery.mockImplementation(async (_id, _database, sql: string) => {
      if (sql.startsWith("CREATE TABLE")) throw new Error("Connection lost after request");
      return {
        columns: [],
        rows: sql.includes("SELECT USER, SYS_CONTEXT") ? [["APP", "APP"]] : sql.includes("SYS.ALL_TABLES") ? [] : [],
        execution_time_ms: 0,
        rows_affected: 0,
      };
    });
    let savedDraft: import("@/types/database").TableStructureEditorDraft | undefined;
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "APP",
      schema: "APP",
      tableName: "",
      draft: {
        dirty: true,
        activeTab: "foreignKeys",
        newTableName: "MyTable",
        tableComment: "",
        originalTableComment: "",
        columns: [{ id: "new:id", name: "id", dataType: "number", isNullable: false, defaultValue: "", comment: "", isPrimaryKey: true, extra: {}, markedForDrop: false }],
        indexes: [],
        foreignKeys: [
          {
            id: "new:fk",
            name: "fk_self",
            column: "id",
            columns: ["id"],
            refSchema: "APP",
            refTable: "MyTable",
            refColumn: "id",
            refColumns: ["id"],
            onUpdate: "",
            onDelete: "NO ACTION",
            oracleState: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false },
            markedForDrop: false,
          },
        ],
        triggers: [],
        initialized: true,
      },
      "onUpdate:draft": (draft: import("@/types/database").TableStructureEditorDraft | undefined) => {
        savedDraft = draft;
      },
    });
    mountedApps.push(app);
    const editor = app.mount(root) as unknown as { applyChanges: () => Promise<boolean> };
    await vi.waitFor(() => expect(mocks.buildCreateTableSql).toHaveBeenCalled());
    const applyButton = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("structureEditor.apply"))!;
    await vi.waitFor(() => expect(applyButton.disabled).toBe(false), { timeout: 3000 });
    expect(await editor.applyChanges()).toBe(false);
    await vi.waitFor(() => expect(savedDraft?.oracleForeignKeyCreateRecovery?.uncertainSteps).toContain("CREATE"));
    await vi.waitFor(() => expect(applyButton.disabled).toBe(true));
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("CREATE TABLE"))).toHaveLength(1);
    expect(await editor.applyChanges()).toBe(false);
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("CREATE TABLE"))).toHaveLength(1);
  });

  it("does not emit saved when the connection changes after CREATE commits", async () => {
    mocks.connection.db_type = "oracle";
    let revision = 1;
    mocks.connectionStateRevision.mockImplementation(() => revision);
    mocks.buildCreateTableSql.mockResolvedValue({
      statements: ['CREATE TABLE "APP".MyTable (id number NOT NULL, parent_id number, CONSTRAINT PK_NEW PRIMARY KEY (id));', 'ALTER TABLE "APP".MyTable ADD CONSTRAINT fk_new FOREIGN KEY (parent_id) REFERENCES "APP".MyTable (id) NORELY ENABLE VALIDATE;'],
      warnings: [],
    });
    mocks.executeQuery.mockImplementation(async (_id, _database, sql: string) => {
      if (sql.startsWith("CREATE TABLE")) revision = 2;
      return {
        columns: [],
        rows: sql.includes("SELECT USER, SYS_CONTEXT")
          ? [["APP", "APP"]]
          : sql.includes("SYS.ALL_OBJECTS")
            ? [["APP", "MYTABLE", 802]]
            : sql.includes("SYS.ALL_TAB_COLS")
              ? [
                  ["ID", "NUMBER", 22, null, null, "N"],
                  ["PARENT_ID", "NUMBER", 22, null, null, "Y"],
                ]
              : sql.includes("SYS.ALL_TABLES")
                ? [["APP", "MYTABLE"]]
                : sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")
                  ? [["FK_NEW", "MYTABLE"]]
                  : sql.includes("SYS.ALL_CONSTRAINTS")
                    ? [["FK_NEW", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "APP", "PK_NEW", "NO ACTION"]]
                    : sql.includes("DBMS_METADATA.GET_DDL")
                      ? [['ALTER TABLE "APP"."MYTABLE" ADD CONSTRAINT "FK_NEW" FOREIGN KEY ("PARENT_ID") REFERENCES "APP"."MYTABLE" ("ID") ENABLE VALIDATE;']]
                      : [],
        execution_time_ms: 0,
        rows_affected: 0,
      };
    });
    let saved = false;
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "APP",
      schema: "APP",
      tableName: "",
      draft: {
        dirty: true,
        activeTab: "foreignKeys",
        newTableName: "MyTable",
        tableComment: "",
        originalTableComment: "",
        columns: [
          { id: "new:id", name: "id", dataType: "number", isNullable: false, defaultValue: "", comment: "", isPrimaryKey: true, extra: {}, markedForDrop: false },
          { id: "new:parent", name: "parent_id", dataType: "number", isNullable: true, defaultValue: "", comment: "", isPrimaryKey: false, extra: {}, markedForDrop: false },
        ],
        indexes: [],
        foreignKeys: [
          {
            id: "new:fk",
            name: "fk_new",
            column: "parent_id",
            columns: ["parent_id"],
            refSchema: "APP",
            refTable: "MyTable",
            refColumn: "id",
            refColumns: ["id"],
            onUpdate: "",
            onDelete: "NO ACTION",
            oracleState: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false },
            markedForDrop: false,
          },
        ],
        triggers: [],
        initialized: true,
      },
      onSaved: () => {
        saved = true;
      },
    });
    mountedApps.push(app);
    const editor = app.mount(root) as unknown as { applyChanges: () => Promise<boolean> };
    await vi.waitFor(() => expect(mocks.buildCreateTableSql).toHaveBeenCalled());
    await vi.waitFor(
      async () => {
        await editor.applyChanges();
        expect(revision).toBe(2);
      },
      { timeout: 3000 },
    );
    expect(revision).toBe(2);
    expect(saved).toBe(false);
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("CREATE TABLE"))).toHaveLength(1);
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith("ALTER TABLE"))).toHaveLength(0);
  });

  it("preserves a new CREATE plan when the previous target returns late", async () => {
    mocks.connection.db_type = "oracle";
    mocks.buildCreateTableSql.mockImplementation(async (options: { tableName: string }) => ({
      statements: [`CREATE TABLE "APP".${options.tableName} (id number NOT NULL, parent_id number, CONSTRAINT PK_NEW PRIMARY KEY (id));`, `ALTER TABLE "APP".${options.tableName} ADD CONSTRAINT fk_new FOREIGN KEY (parent_id) REFERENCES "PARENT_OWNER".PARENT (id) NORELY ENABLE VALIDATE;`],
      warnings: [],
    }));

    let releaseOldCreate!: () => void;
    let signalOldCreateStarted!: () => void;
    let metadataTableName = "MYTABLE";
    const oldCreateStarted = new Promise<void>((resolve) => {
      signalOldCreateStarted = resolve;
    });
    const oldCreateGate = new Promise<void>((resolve) => {
      releaseOldCreate = resolve;
    });
    mocks.executeQuery.mockImplementation(async (_id, _database, sql: string) => {
      if (sql.startsWith('CREATE TABLE "APP".MyTable')) {
        signalOldCreateStarted();
        await oldCreateGate;
      }
      return {
        columns: [],
        rows: sql.includes("SELECT USER, SYS_CONTEXT")
          ? [["APP", "APP"]]
          : sql.includes("SYS.ALL_OBJECTS") && sql.includes("PARENT_OWNER")
            ? [["PARENT_OWNER", "PARENT", 900]]
            : sql.includes("SYS.ALL_OBJECTS")
              ? [["APP", "MYTABLE", 802]]
              : sql.includes("SYS.ALL_TAB_COLS") && sql.includes("PARENT_OWNER")
                ? [["ID", "NUMBER"]]
                : sql.includes("SYS.ALL_TAB_COLS")
                  ? [
                      ["ID", "NUMBER", 22, null, null, "N"],
                      ["PARENT_ID", "NUMBER", 22, null, null, "Y"],
                    ]
                  : sql.includes("SYS.ALL_TABLES")
                    ? [["APP", sql.match(/TABLE_NAME = '([^']+)'/)?.[1] ?? "MYTABLE"]]
                    : sql.includes("SELECT CONSTRAINT_NAME, TABLE_NAME")
                      ? [["FK_NEW", "MYTABLE"]]
                      : sql.includes("c.CONSTRAINT_TYPE IN ('P', 'U')")
                        ? [["PK_PARENT", "P", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "ID", 1]]
                        : sql.includes("SYS.ALL_CONSTRAINTS")
                          ? [["FK_NEW", "ENABLED", "VALIDATED", "NOT DEFERRABLE", "IMMEDIATE", null, "PARENT_OWNER", "PK_PARENT", "NO ACTION"]]
                          : sql.includes("SYS.ALL_TAB_PRIVS")
                            ? [["REFERENCES"]]
                            : sql.includes("SYS.ALL_COL_PRIVS") || sql.includes("SESSION_PRIVS")
                              ? []
                              : sql.includes("DBMS_METADATA.GET_DDL")
                                ? [[`ALTER TABLE "APP"."${metadataTableName}" ADD CONSTRAINT "FK_NEW" FOREIGN KEY ("PARENT_ID") REFERENCES "PARENT_OWNER"."PARENT" ("ID") ENABLE VALIDATE;`]]
                                : [],
        execution_time_ms: 0,
        rows_affected: 0,
      };
    });

    let savedName: string | undefined;
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(TableStructureEditor, {
      connectionId: mocks.connection.id,
      database: "APP",
      schema: "APP",
      tableName: "",
      draft: {
        dirty: true,
        activeTab: "foreignKeys",
        newTableName: "MyTable",
        tableComment: "",
        originalTableComment: "",
        columns: [
          { id: "new:id", name: "id", dataType: "number", isNullable: false, defaultValue: "", comment: "", isPrimaryKey: true, extra: {}, markedForDrop: false },
          { id: "new:parent", name: "parent_id", dataType: "number", isNullable: true, defaultValue: "", comment: "", isPrimaryKey: false, extra: {}, markedForDrop: false },
        ],
        indexes: [],
        foreignKeys: [
          {
            id: "new:fk",
            name: "fk_new",
            column: "parent_id",
            columns: ["parent_id"],
            refSchema: "PARENT_OWNER",
            refTable: "PARENT",
            refColumn: "ID",
            refColumns: ["ID"],
            onUpdate: "",
            onDelete: "NO ACTION",
            oracleState: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false },
            markedForDrop: false,
          },
        ],
        triggers: [],
        initialized: true,
      },
      onSaved: (_commentChanged: boolean, createdName?: string) => {
        savedName = createdName;
      },
    });
    mountedApps.push(app);
    const editor = app.mount(root) as unknown as { applyChanges: () => Promise<boolean> };
    await vi.waitFor(() => expect(mocks.buildCreateTableSql).toHaveBeenCalled());
    const applyButton = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("structureEditor.apply"))!;
    await vi.waitFor(() => expect(applyButton.disabled, `${root.textContent}\n${JSON.stringify(mocks.toast.mock.calls)}\n${JSON.stringify(mocks.executeQuery.mock.calls.map((call) => call[2]))}`).toBe(false));

    const oldApply = editor.applyChanges();
    await vi.waitFor(
      () =>
        expect(
          mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith('CREATE TABLE "APP".MyTable')),
          `${JSON.stringify(mocks.toast.mock.calls)}\n${JSON.stringify(mocks.executeQuery.mock.calls.map((call) => call[2]))}`,
        ).toBe(true),
      { timeout: 3000 },
    );
    await oldCreateStarted;
    const tableName = root.querySelector<HTMLInputElement>('input[placeholder="contextMenu.duplicateNamePlaceholder"]')!;
    tableName.value = "NextTable";
    tableName.dispatchEvent(new Event("input", { bubbles: true }));
    metadataTableName = "NEXTTABLE";
    await vi.waitFor(() => expect(mocks.buildCreateTableSql).toHaveBeenCalledWith(expect.objectContaining({ tableName: "NextTable" })));

    releaseOldCreate();
    expect(await oldApply).toBe(false);
    await settle();

    await vi.waitFor(() => expect(applyButton.disabled).toBe(false), { timeout: 3000 });
    expect(await editor.applyChanges()).toBe(true);
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith('CREATE TABLE "APP".MyTable'))).toHaveLength(1);
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith('CREATE TABLE "APP".NextTable'))).toHaveLength(1);
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[2]).startsWith('ALTER TABLE "APP".MyTable'))).toHaveLength(0);
    expect(savedName).toBe("NEXTTABLE");
  });
});
