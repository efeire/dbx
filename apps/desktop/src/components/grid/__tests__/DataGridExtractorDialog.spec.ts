// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_GRID_COPY_EXTRACTOR_IDS, DATA_GRID_DEFAULT_VISIBLE_COPY_EXTRACTORS, normalizeDataGridExtractorOptions, type DataGridCopyPreference, type DataGridExtractPreview } from "@/lib/dataGrid/dataGridCopyExtractor";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/dialog", () => {
  const passthrough = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return { Dialog: passthrough, DialogContent: passthrough, DialogFooter: passthrough, DialogHeader: passthrough, DialogTitle: passthrough };
});
vi.mock("@/components/ui/select", () => {
  const passthrough = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return {
    Select: defineComponent({
      props: ["modelValue"],
      emits: ["update:modelValue"],
      setup:
        (props, { emit, slots }) =>
        () =>
          h("select", { value: props.modelValue, onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value) }, slots.default?.()),
    }),
    SelectItem: defineComponent({
      props: ["value"],
      setup:
        (props, { slots }) =>
        () =>
          h("option", { value: props.value }, slots.default?.()),
    }),
    SelectContent: passthrough,
    SelectTrigger: passthrough,
    SelectValue: passthrough,
  };
});

import DataGridExtractorDialog from "../DataGridExtractorDialog.vue";

const mounted: Array<{ app: App; host: HTMLElement }> = [];
const result = (text: string): DataGridExtractPreview => ({ text, mimeType: "text/plain", fileExtension: "sql", rowCount: 1, columnCount: 1, sourceRowCount: 1, truncated: false });

function deferred() {
  let resolve!: (value: DataGridExtractPreview) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<DataGridExtractPreview>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mountDialog(preview = vi.fn(async () => result("initial")), open = false, preference: DataGridCopyPreference = "sql-inserts") {
  const props = reactive({
    open,
    preference,
    sourceTableName: undefined as string | undefined,
    visibleCopyExtractors: [...DATA_GRID_DEFAULT_VISIBLE_COPY_EXTRACTORS],
    options: normalizeDataGridExtractorOptions({}),
    items: [{ value: preference, label: preference.toUpperCase() }],
    preview,
  });
  const save = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(DataGridExtractorDialog, { ...props, visibleItems: DATA_GRID_COPY_EXTRACTOR_IDS.map((value) => ({ value, label: value })), onSave: save }) });
  app.mount(host);
  mounted.push({ app, host });
  return { props, host, save, preview };
}

async function advancePreview() {
  await nextTick();
  await vi.advanceTimersByTimeAsync(180);
  await nextTick();
}

async function toggle(host: HTMLElement, key: string) {
  const label = Array.from(host.querySelectorAll("label")).find((item) => item.textContent?.includes(key));
  const input = label?.querySelector("input");
  expect(input).toBeTruthy();
  input!.checked = !input!.checked;
  input!.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.useRealTimers();
});

describe("extractor draft preview", () => {
  it("shows CSV-specific settings only for CSV and DSV extractors", async () => {
    const { host } = mountDialog(undefined, true, "tsv");
    await advancePreview();
    expect(host.textContent).not.toContain("grid.copyExtractorEscapeFormulas");
    expect(host.textContent).not.toContain("grid.copyExtractorHeaderPosition");
    const csv = mountDialog(undefined, true, "csv");
    await advancePreview();
    expect(csv.host.textContent).toContain("grid.copyExtractorEscapeFormulas");
    expect(csv.host.textContent).toContain("grid.copyExtractorHeaderPosition");
    expect(csv.host.querySelectorAll("details")).toHaveLength(2);
    expect([...csv.host.querySelectorAll("details")].every((details) => !details.open)).toBe(true);
    expect(csv.host.querySelector("details summary")?.textContent).toBe("common.advanced");
  });

  it.each(["tsv", "tsv-with-headers", "pipe-separated"] as const)("keeps the row-number option available for %s", async (preference) => {
    const { props, host, save } = mountDialog(undefined, true, preference);
    await advancePreview();

    const label = Array.from(host.querySelectorAll("label")).find((item) => item.textContent?.includes("grid.copyExtractorIncludeRowHeader"));
    expect(label).toBeTruthy();
    expect(label?.closest("details")).toBeNull();
    await toggle(host, "grid.copyExtractorIncludeRowHeader");

    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("common.save"))!;
    button.click();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ dsv: expect.objectContaining({ includeRowHeader: true }) }) }));
    expect(props.options.dsv.includeRowHeader).toBe(false);
  });

  it("previews an initially open dialog", async () => {
    const { preview, host } = mountDialog(undefined, true);
    await advancePreview();
    expect(preview).toHaveBeenCalledOnce();
    expect(host.querySelector("pre")?.textContent).toBe("initial");
  });

  it("offers the database-name option for SQL updates as well (#11195)", async () => {
    const { props, host, save } = mountDialog();
    props.preference = "sql-updates";
    props.items = [{ value: "sql-updates", label: "UPDATE" }];
    props.open = true;
    await advancePreview();

    // 勾选后保存应带上 includeDatabaseName（复制为 UPDATE 也支持带库名/模式名）
    await toggle(host, "copyExtractorIncludeDatabaseName");
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("common.save"))!;
    button.click();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ sql: expect.objectContaining({ includeDatabaseName: true }) }) }));
  });

  it("previews unsaved quote and temporal options without mutating saved settings", async () => {
    const { props, host, preview, save } = mountDialog();
    props.open = true;
    await advancePreview();
    await toggle(host, "copyExtractorQuoteIdentifiers");
    const select = Array.from(host.querySelectorAll("select")).find((item) => item.querySelector('option[value="string"]'))!;
    expect(select).toBeTruthy();
    select.value = "string";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await advancePreview();
    expect(preview).toHaveBeenLastCalledWith("sql-inserts", expect.objectContaining({ sql: expect.objectContaining({ quoteIdentifiers: false, temporalFormat: "string" }) }));
    expect(props.options.sql).toMatchObject({ quoteIdentifiers: true, temporalFormat: "native" });
    expect(save).not.toHaveBeenCalled();
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("common.save"))!;
    button.click();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ sql: expect.objectContaining({ quoteIdentifiers: false, temporalFormat: "string" }) }) }));
  });

  it.each(["resolve", "reject"] as const)("ignores an old %s during the debounce window and after a newer preview", async (settle) => {
    const old = deferred();
    const newer = deferred();
    const preview = vi
      .fn(async () => result("latest"))
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(newer.promise);
    const { props, host } = mountDialog(preview);
    props.open = true;
    await advancePreview();
    await toggle(host, "copyExtractorSkipComputed");
    if (settle === "resolve") old.resolve(result("stale"));
    else old.reject(new Error("stale error"));
    await nextTick();
    await nextTick();
    expect(host.querySelector("pre")?.textContent).not.toContain("stale");
    await advancePreview();
    await toggle(host, "copyExtractorSkipGenerated");
    await advancePreview();
    expect(host.querySelector("pre")?.textContent).toBe("latest");
    newer.resolve(result("also stale"));
    await nextTick();
    expect(host.querySelector("pre")?.textContent).toBe("latest");
  });

  it("shows current errors and resets draft options when reopened", async () => {
    const preview = vi.fn(async () => result("reopened")).mockRejectedValueOnce(new Error("preview failed"));
    const { props, host } = mountDialog(preview);
    props.open = true;
    await advancePreview();
    expect(host.querySelector("pre")?.textContent).toBe("preview failed");
    expect(host.querySelector("pre")?.classList.contains("break-words")).toBe(true);
    expect(host.querySelector("pre")?.classList.contains("whitespace-pre-wrap")).toBe(true);
    await toggle(host, "copyExtractorSkipComputed");
    props.open = false;
    await advancePreview();
    expect(preview).toHaveBeenCalledOnce();
    props.open = true;
    await advancePreview();
    expect(preview).toHaveBeenLastCalledWith("sql-inserts", props.options);
    expect(host.querySelector("pre")?.textContent).toBe("reopened");
  });

  it("ignores pending results after the dialog closes", async () => {
    const pending = deferred();
    const { props, host } = mountDialog(vi.fn(() => pending.promise));
    props.open = true;
    await advancePreview();
    props.open = false;
    await nextTick();
    pending.resolve(result("closed result"));
    await nextTick();
    expect(host.querySelector("pre")?.textContent).not.toContain("closed result");
  });
});
