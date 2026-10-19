export interface DataGridColumnMetadataForCopy {
  name: string;
  type?: string;
  source?: string;
  nullable?: boolean;
  comment?: string;
}

function tsv(value: string | undefined): string {
  if (value === undefined) return "";
  return /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function formatDataGridColumnMetadataForCopy(columns: readonly DataGridColumnMetadataForCopy[]): string {
  const rows = [["Name", "Type", "Source", "Nullable", "Comment"], ...columns.map((column) => [column.name, column.type ?? "", column.source ?? "", column.nullable === undefined ? "" : column.nullable ? "YES" : "NO", column.comment ?? ""])];
  return rows.map((row) => row.map(tsv).join("\t")).join("\n");
}
