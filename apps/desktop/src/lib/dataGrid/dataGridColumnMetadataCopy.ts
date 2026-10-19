export interface DataGridColumnMetadataForCopy {
  name: string;
  type?: string;
  source?: string;
  nullable?: boolean;
  comment?: string;
}

function tsv(value: string | undefined): string {
  if (value === undefined) return "";
  const guarded = guardSpreadsheetFormula(value);
  return /[\t\r\n"]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function guardSpreadsheetFormula(value: string): string {
  const candidate = value.replace(/^ +/, "");
  if (candidate.startsWith("-") && isExactSpreadsheetDecimal(candidate.slice(1))) return value;
  if (candidate.startsWith("@") && !/^[\x00-\x7f]/.test(candidate.slice(1))) return value;
  return /^[=+\-@\t\r]/.test(candidate) ? `'${value}` : value;
}

function isExactSpreadsheetDecimal(value: string): boolean {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return false;
  const significant = value.replace(".", "").replace(/^0+/, "");
  return significant.length <= 15;
}

export function formatDataGridColumnMetadataForCopy(columns: readonly DataGridColumnMetadataForCopy[]): string {
  const rows = [["Name", "Type", "Source", "Nullable", "Comment"], ...columns.map((column) => [column.name, column.type ?? "", column.source ?? "", column.nullable === undefined ? "" : column.nullable ? "YES" : "NO", column.comment ?? ""])];
  return rows.map((row) => row.map(tsv).join("\t")).join("\n");
}
