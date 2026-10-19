import { describe, expect, it, vi } from "vitest";

// Simulate the external package moving its private parser, not our own layout behavior.
vi.mock("sql-formatter/dist/esm/parser/createParser.js", () => {
  throw new Error("External parser module unavailable");
});

import { formatSqlText } from "@/lib/sql/sqlFormatter";

describe("custom rule engine recovery", () => {
  it("keeps the public formatter usable and reports the downgrade once", async () => {
    const source = "select a,b from t where id=1;";
    const base = await formatSqlText(source, "oracle", { layoutStyle: "classic" });
    const diagnostics: string[] = [];
    const result = await formatSqlText(source, "oracle", { customRulesEnabled: true, selectListLayout: "singleLine", layoutStyle: "classic" }, (diagnostic) => diagnostics.push(diagnostic));
    expect(result).toBe(base);
    expect(diagnostics).toEqual(["custom-rules-fallback"]);
  });
});
