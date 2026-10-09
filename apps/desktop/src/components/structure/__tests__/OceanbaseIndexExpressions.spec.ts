import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import OceanbaseIndexExpressions from "../OceanbaseIndexExpressions.vue";
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function render(terms: string[]) {
  return mount(OceanbaseIndexExpressions, {
    props: { modelValue: terms },
    global: { stubs: { Button: { template: '<button><slot /></button>' } } },
  });
}
describe("OceanBase index SQL terms", () => {
  it("keeps commas and newlines inside one expression", async () => {
    const wrapper = render(['"Name"']);
    const expression = 'SUBSTR(\n"Name", 1, 3)';
    await wrapper.get("textarea").setValue(expression);
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([[expression]]);
  });
  it("moves complete terms without splitting or rewriting them", async () => {
    const terms = ['LOWER("Name")', '"Second"'];
    const wrapper = render(terms);
    await wrapper.findAll('[aria-label="structureEditor.obIndexMoveDown"]')[0]!.trigger("click");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([[terms[1], terms[0]]]);
    expect(terms).toEqual(['LOWER("Name")', '"Second"']);
  });
  it("removes only the requested term", async () => {
    const wrapper = render(['"First"', '"Second"']);
    await wrapper.findAll('[aria-label="structureEditor.obIndexRemoveExpression"]')[0]!.trigger("click");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([['"Second"']]);
  });
});
