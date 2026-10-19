import { describe, expect, it } from "vitest";
import { formatDataGridColumnMetadataForCopy } from "@/lib/dataGrid/dataGridColumnMetadataCopy";

describe("formatDataGridColumnMetadataForCopy", () => {
  it("keeps unknown metadata empty and escapes TSV cells", () => {
    expect(
      formatDataGridColumnMetadataForCopy([
        { name: "a\tb", type: "VARCHAR", source: "t.a", nullable: true, comment: 'x\n"y' },
        { name: "expr", type: "", nullable: undefined },
      ]),
    ).toBe('Name\tType\tSource\tNullable\tComment\n"a\tb"\tVARCHAR\tt.a\tYES\t"x\n""y"\nexpr\t\t\t\t');
  });
});
