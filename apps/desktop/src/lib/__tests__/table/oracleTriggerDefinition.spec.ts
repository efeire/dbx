import { describe, expect, it } from "vitest";
import { parseOracleTriggerDefinition, prepareDisabledOracleTriggerReplacement, prepareOracleTriggerReplacement, updateOracleTriggerDefinition } from "@/lib/table/oracleTriggerDefinition";

const source = `-- original header
CREATE OR REPLACE TRIGGER "APP"."Quoted Trigger"
BEFORE INSERT OR UPDATE OF "Value" ON "APP"."Data Table"
REFERENCING OLD AS prior NEW AS next
FOR EACH ROW DISABLE
WHEN (next."Value" <> q'[O'Reilly (body)]')
DECLARE
  v_text VARCHAR2(100) := q'[BEGIN; END; Quoted Trigger]';
BEGIN
  :next."Value" := :prior."Value";
END;
/`;

describe("Oracle complete trigger definition editing", () => {
  it("round-trips comments, aliases, WHEN, body and quoted names without serialization", () => {
    const parsed = parseOracleTriggerDefinition(source);
    expect(parsed).toMatchObject({ structured: true, schema: "APP", name: "Quoted Trigger", tableName: "Data Table" });
    expect(parsed.fields).toMatchObject({ referencing: "OLD AS prior NEW AS next", rowLevel: true, when: `next."Value" <> q'[O'Reilly (body)]'` });
    expect(updateOracleTriggerDefinition(parsed, { ...parsed.fields! })).toBe(source);
  });

  it("changes only the requested event field while retaining unrelated text", () => {
    const parsed = parseOracleTriggerDefinition(source);
    const edited = updateOracleTriggerDefinition(parsed, { ...parsed.fields!, events: "DELETE" });
    expect(edited).toBe(source.replace('INSERT OR UPDATE OF "Value"', "DELETE"));
  });

  it("inserts row and alias clauses before an existing DISABLE and WHEN clause", () => {
    const initial = "CREATE TRIGGER APP.T AFTER INSERT ON APP.DATA DISABLE BEGIN NULL; END;";
    const parsed = parseOracleTriggerDefinition(initial);
    const edited = updateOracleTriggerDefinition(parsed, { ...parsed.fields!, rowLevel: true, referencing: "NEW AS next", when: "next.VALUE > 0" });
    expect(edited).toContain("REFERENCING NEW AS next\nFOR EACH ROW\nDISABLE WHEN (next.VALUE > 0)\nBEGIN");
    expect(parseOracleTriggerDefinition(edited).fields).toMatchObject({ rowLevel: true, referencing: "NEW AS next", when: "next.VALUE > 0" });
  });

  it("requires complete source mode for compound and ordering clauses", () => {
    for (const sql of [
      "CREATE TRIGGER APP.T FOR INSERT ON APP.DATA COMPOUND TRIGGER BEFORE STATEMENT IS BEGIN NULL; END BEFORE STATEMENT; END;",
      "CREATE TRIGGER APP.T AFTER INSERT ON APP.DATA FOR EACH ROW FOLLOWS APP.OTHER BEGIN NULL; END;",
    ]) expect(parseOracleTriggerDefinition(sql).structured).toBe(false);
  });

  it("rejects changing the selected identity and never emits DROP", () => {
    expect(() => prepareOracleTriggerReplacement(source, { schema: "OTHER", name: "Quoted Trigger" })).toThrow("identity");
    const sql = prepareDisabledOracleTriggerReplacement(source, { schema: "APP", name: "Quoted Trigger" });
    expect(sql).toContain("FOR EACH ROW DISABLE");
    expect(sql).not.toContain("DROP TRIGGER");
    expect(sql.endsWith("/" )).toBe(false);
  });

  it("adds replacement and disabled state without rewriting a compound body", () => {
    const sql = "CREATE TRIGGER APP.T FOR INSERT ON APP.DATA COMPOUND TRIGGER BEFORE STATEMENT IS BEGIN NULL; END BEFORE STATEMENT; END;";
    expect(prepareDisabledOracleTriggerReplacement(sql, { schema: "APP", name: "T" })).toBe(sql.replace("CREATE TRIGGER", "CREATE OR REPLACE TRIGGER").replace("COMPOUND TRIGGER", "DISABLE\nCOMPOUND TRIGGER"));
  });
});
