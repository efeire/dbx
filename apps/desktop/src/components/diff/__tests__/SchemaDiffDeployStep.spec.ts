// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import SchemaDiffDeployStep from "@/components/diff/SchemaDiffDeployStep.vue";

vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { theme: "default", fontSize: 14, fontFamily: "monospace" } }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: ref(false) }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/editor/editorThemes", () => ({ loadEditorTheme: async () => [], editorFontTheme: () => [] }));

let app: App | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

it.each([true, false])("program preview readOnly=%s controls actual editor editing and emitted SQL", async (readOnly) => {
  const update = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(SchemaDiffDeployStep, { deploySql: "CREATE PACKAGE P AS END;", selectedObjects: [], targetConnectionId: "target", targetDatabase: "test", targetSchema: "DST", executing: false, readOnly, "onUpdate:deploySql": update }) });
  app.use(createI18n({ legacy: false, locale: "en", missingWarn: false, fallbackWarn: false, messages: { en: { diff: { routinePreviewReadOnly: "Program SQL is read-only" } } } }));
  app.mount(host);
  await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull());
  const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")! as HTMLElement)!;
  expect(editor.state.facet(EditorState.readOnly)).toBe(readOnly);
  expect(host.querySelector(".cm-content")!.getAttribute("contenteditable")).toBe(String(!readOnly));
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "edited" } });
  await nextTick();
  if (readOnly) {
    expect(update).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Program SQL is read-only");
  } else expect(update).toHaveBeenCalledWith("edited");
});
