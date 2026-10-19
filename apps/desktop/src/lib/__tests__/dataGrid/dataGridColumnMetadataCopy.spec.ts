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

  it("neutralizes spreadsheet formulas in copied metadata without changing TSV escaping", () => {
    expect(
      formatDataGridColumnMetadataForCopy([
        { name: "=1+1", comment: "  +cmd" },
        { name: "-123.45", comment: "@冯十二" },
      ]),
    ).toBe("Name\tType\tSource\tNullable\tComment\n'=1+1\t\t\t\t'  +cmd\n-123.45\t\t\t\t@冯十二");
  });
});
