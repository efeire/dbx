interface Token {
  text: string;
  start: number;
  end: number;
  kind: "word" | "identifier" | "literal" | "symbol";
}
interface Span { start: number; end: number }

export interface OracleTriggerFields {
  timing: string;
  events: string;
  referencing: string;
  rowLevel: boolean;
  when: string;
  body: string;
}

export interface OracleTriggerDefinition {
  source: string;
  schema?: string;
  name: string;
  tableSchema?: string;
  tableName?: string;
  structured: boolean;
  reason?: string;
  fields?: OracleTriggerFields;
  spans?: Record<keyof OracleTriggerFields, Span>;
  createEnd: number;
  replace: boolean;
}

// Keep source offsets, including comments and whitespace, so unchanged fields
// do not pass through a serializer. Oracle q/nq literals can contain apostrophes.
function scan(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith("--", i)) { const end = source.indexOf("\n", i + 2); i = end < 0 ? source.length : end; continue; }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Unclosed trigger comment");
      i = end + 2; continue;
    }
    const start = i;
    const alternative = /^(?:nq|q)'/i.exec(source.slice(i));
    if (alternative) {
      const open = source[i + alternative[0].length];
      const close = ({ "[": "]", "{": "}", "(": ")", "<": ">" } as Record<string, string>)[open] ?? open;
      const end = source.indexOf(`${close}'`, i + alternative[0].length + 1);
      if (!open || /\s/.test(open) || end < 0) throw new Error("Unclosed trigger alternative literal");
      i = end + 2;
      tokens.push({ text: source.slice(start, i), start, end: i, kind: "literal" });
      continue;
    }
    if (source[i] === "'" || source[i] === '"') {
      const quote = source[i++];
      let closed = false;
      while (i < source.length) {
        if (source[i++] !== quote) continue;
        if (source[i] === quote) { i++; continue; }
        closed = true; break;
      }
      if (!closed) throw new Error("Unclosed trigger quoted token");
      tokens.push({ text: source.slice(start, i), start, end: i, kind: quote === '"' ? "identifier" : "literal" });
      continue;
    }
    const word = /^[\p{L}_$#][\p{L}\p{N}_$#]*/u.exec(source.slice(i));
    if (word) {
      i += word[0].length;
      tokens.push({ text: word[0], start, end: i, kind: "word" });
    } else {
      i++;
      tokens.push({ text: source[start], start, end: i, kind: "symbol" });
    }
  }
  return tokens;
}

function identifier(token: Token | undefined): string {
  if (token?.kind === "identifier") return token.text.slice(1, -1).replaceAll('""', '"');
  if (token?.kind === "word") return token.text.toUpperCase();
  throw new Error("Expected a trigger identifier");
}

function definitionEnd(source: string, tokens: Token[], identity: { schema?: string; name: string }): number {
  const alters = tokens.flatMap((token, index) => token.kind === "word" && token.text.toUpperCase() === "ALTER" ? [index] : []);
  let end = source.length;
  if (alters.length) {
    if (alters.length !== 1) throw new Error("Only one matching trigger state clause may follow the definition");
    let index = alters[0];
    end = tokens[index++].start;
    if (tokens[index]?.kind !== "word" || tokens[index++].text.toUpperCase() !== "TRIGGER") throw new Error("Only a matching ALTER TRIGGER state clause may follow the definition");
    let name = identifier(tokens[index++]);
    let schema: string | undefined;
    if (tokens[index]?.text === ".") { index++; schema = name; name = identifier(tokens[index++]); }
    if (name !== identity.name || (schema !== undefined && identity.schema !== undefined && schema !== identity.schema)) throw new Error("Trailing trigger state clause has a different identity");
    const state = tokens[index++];
    if (state?.kind !== "word" || !["ENABLE", "DISABLE"].includes(state.text.toUpperCase())) throw new Error("Unsupported trailing trigger state clause");
    if (tokens[index]?.text === ";") index++;
    if (tokens[index]?.text === "/") index++;
    if (index !== tokens.length) throw new Error("Additional statements cannot be saved with a trigger definition");
  }
  const definition = source.slice(0, end);
  const slash = /\r?\n[ \t]*\/[ \t]*(?:\r?\n[ \t]*)*$/.exec(definition);
  return slash?.index ?? end;
}

export function parseOracleTriggerDefinition(source: string): OracleTriggerDefinition {
  const tokens = scan(source);
  let index = 0;
  const is = (word: string) => tokens[index]?.kind === "word" && tokens[index].text.toUpperCase() === word;
  const requireWord = (word: string) => { if (!is(word)) throw new Error(`Expected ${word} in trigger definition`); return tokens[index++]; };
  const name = () => {
    const first = identifier(tokens[index++]);
    if (tokens[index]?.text !== ".") return { name: first, schema: undefined };
    index++;
    return { schema: first, name: identifier(tokens[index++]) };
  };
  const createEnd = requireWord("CREATE").end;
  let replace = false;
  if (is("OR")) { index++; requireWord("REPLACE"); replace = true; }
  if (is("EDITIONABLE") || is("NONEDITIONABLE")) index++;
  requireWord("TRIGGER");
  const identity = name();
  const sourceEnd = definitionEnd(source, tokens, identity);
  const result: OracleTriggerDefinition = { source, ...identity, structured: false, createEnd, replace };
  const fallback = (reason: string) => ({ ...result, reason });
  const timingStart = tokens[index]?.start;
  if (timingStart === undefined) return fallback("Missing trigger timing");
  if (is("BEFORE") || is("AFTER") || is("FOR")) index++;
  else if (is("INSTEAD")) { index++; requireWord("OF"); }
  else return fallback("Compound or special trigger: edit the complete source");
  const timingEnd = tokens[index - 1].end;
  const eventsStart = tokens[index]?.start;
  while (index < tokens.length && !is("ON")) {
    if (tokens[index].text === ";") return fallback("Unrecognized trigger events");
    index++;
  }
  if (eventsStart === undefined || index === tokens.length) return fallback("Missing trigger target");
  const eventsEnd = tokens[index - 1].end;
  const eventTokens = tokens.filter((token) => token.start >= eventsStart && token.end <= eventsEnd);
  if (!eventTokens.some((token) => token.kind === "word" && ["INSERT", "UPDATE", "DELETE"].includes(token.text.toUpperCase()))) return fallback("System trigger: edit the complete source");
  index++;
  try {
    const table = name();
    result.tableName = table.name;
    result.tableSchema = table.schema;
  } catch { return fallback("Special trigger target: edit the complete source"); }
  let referencingSpan: Span | undefined;
  let rowSpan: Span | undefined;
  let whenSpan: Span | undefined;
  let referencing = "";
  let when = "";
  if (is("REFERENCING")) {
    const start = tokens[index++].start;
    const contentStart = tokens[index]?.start;
    while (is("OLD") || is("NEW") || is("PARENT")) {
      index++;
      if (is("AS")) index++;
      identifier(tokens[index++]);
    }
    referencingSpan = { start, end: tokens[index - 1].end };
    referencing = source.slice(contentStart, referencingSpan.end);
  }
  if (is("FOR")) {
    const start = tokens[index++].start;
    requireWord("EACH");
    const end = requireWord("ROW").end;
    rowSpan = { start, end };
  }
  const enabledStart = is("ENABLE") || is("DISABLE") ? tokens[index++].start : undefined;
  if (is("WHEN")) {
    const start = tokens[index++].start;
    if (tokens[index]?.text !== "(") return fallback("Unrecognized WHEN clause");
    const contentStart = tokens[index++].end;
    let depth = 1;
    while (index < tokens.length && depth > 0) {
      const token = tokens[index++];
      if (token.kind === "symbol" && token.text === "(") depth++;
      if (token.kind === "symbol" && token.text === ")") depth--;
    }
    if (depth !== 0) return fallback("Unclosed WHEN clause");
    const closing = tokens[index - 1];
    when = source.slice(contentStart, closing.start);
    whenSpan = { start, end: closing.end };
  }
  if (!is("BEGIN") && !is("DECLARE") && !is("CALL")) return fallback("Ordering, edition or compound clauses: edit the complete source");
  const bodyStart = tokens[index].start;
  // A SQL*Plus slash belongs to the transport, not the PL/SQL definition.
  const bodyEnd = sourceEnd;
  const insertAt = enabledStart ?? whenSpan?.start ?? bodyStart;
  return {
    ...result,
    structured: true,
    fields: { timing: source.slice(timingStart, timingEnd), events: source.slice(eventsStart, eventsEnd), referencing, rowLevel: !!rowSpan, when, body: source.slice(bodyStart, bodyEnd) },
    spans: { timing: { start: timingStart, end: timingEnd }, events: { start: eventsStart, end: eventsEnd }, referencing: referencingSpan ?? { start: rowSpan?.start ?? insertAt, end: rowSpan?.start ?? insertAt }, rowLevel: rowSpan ?? { start: insertAt, end: insertAt }, when: whenSpan ?? { start: bodyStart, end: bodyStart }, body: { start: bodyStart, end: bodyEnd } },
  };
}

export function updateOracleTriggerDefinition(definition: OracleTriggerDefinition, fields: OracleTriggerFields): string {
  if (!definition.structured || !definition.fields || !definition.spans) throw new Error("This trigger requires complete source editing");
  if (fields.when.trim() && !fields.rowLevel) throw new Error("WHEN requires a row-level trigger");
  const replacements: Array<Span & { value: string; order: number }> = [];
  const keys: Array<keyof OracleTriggerFields> = ["timing", "events", "referencing", "rowLevel", "when", "body"];
  keys.forEach((key, order) => {
    if (fields[key] === definition.fields![key]) return;
    const span = definition.spans![key];
    let value = String(fields[key]);
    if (key === "referencing") value = fields.referencing.trim() ? `REFERENCING ${fields.referencing}` : "";
    if (key === "rowLevel") value = fields.rowLevel ? "FOR EACH ROW" : "";
    if (key === "when") value = fields.when.trim() ? `WHEN (${fields.when})` : "";
    if (span.start === span.end && value) value += "\n";
    replacements.push({ ...span, value, order });
  });
  let source = definition.source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start || b.order - a.order)) {
    source = source.slice(0, replacement.start) + replacement.value + source.slice(replacement.end);
  }
  return source;
}

export function prepareOracleTriggerReplacement(source: string, expected: { schema: string; name: string }): string {
  const definition = parseOracleTriggerDefinition(source);
  if (definition.name !== expected.name || (definition.schema ?? expected.schema) !== expected.schema) throw new Error("Trigger identity differs from the selected object");
  const tokens = scan(source);
  const end = definitionEnd(source, tokens, { schema: definition.schema ?? expected.schema, name: definition.name });
  const singleDefinition = source.slice(0, end);
  const definitionTokens = tokens.filter((token) => token.start < end);
  if (definitionTokens.slice(1).some((token) => token.kind === "word" && ["DROP", "CREATE", "ALTER"].includes(token.text.toUpperCase()))) throw new Error("Additional DDL cannot be saved with a trigger definition");
  let finalEnd = -1;
  definitionTokens.forEach((token, index) => { if (token.kind === "word" && token.text.toUpperCase() === "END") finalEnd = index; });
  if (finalEnd >= 0) {
    let tail = finalEnd + 1;
    if (definitionTokens[tail]?.kind === "identifier" || definitionTokens[tail]?.kind === "word") tail++;
    if (definitionTokens[tail]?.text === ";") tail++;
    if (tail !== definitionTokens.length) throw new Error("Additional statements follow the trigger body");
  } else if (definition.spans?.body) {
    let depth = 0;
    const body = definitionTokens.filter((token) => token.start >= definition.spans!.body.start);
    for (let index = 0; index < body.length; index++) {
      const token = body[index];
      if (token.text === "(" && token.kind === "symbol") depth++;
      if (token.text === ")" && token.kind === "symbol") depth--;
      if (token.text === ";" && token.kind === "symbol" && depth === 0 && index !== body.length - 1) throw new Error("Additional statements follow the trigger call");
    }
  }
  return definition.replace ? singleDefinition : singleDefinition.slice(0, definition.createEnd) + " OR REPLACE" + singleDefinition.slice(definition.createEnd);
}

export function prepareDisabledOracleTriggerReplacement(source: string, expected: { schema: string; name: string }): string {
  const sql = prepareOracleTriggerReplacement(source, expected);
  const tokens = scan(sql);
  let depth = 0;
  let state: Token | undefined;
  let insertion: number | undefined;
  for (const token of tokens) {
    if (token.kind === "symbol" && token.text === "(") depth++;
    if (token.kind === "symbol" && token.text === ")") depth--;
    if (depth || token.kind !== "word") continue;
    const word = token.text.toUpperCase();
    if (word === "ENABLE" || word === "DISABLE") state = token;
    if (["WHEN", "DECLARE", "BEGIN", "CALL", "COMPOUND"].includes(word)) { insertion = token.start; break; }
  }
  if (state) return sql.slice(0, state.start) + "DISABLE" + sql.slice(state.end);
  if (insertion === undefined) throw new Error("Cannot locate the trigger body safely");
  return sql.slice(0, insertion) + "DISABLE\n" + sql.slice(insertion);
}
