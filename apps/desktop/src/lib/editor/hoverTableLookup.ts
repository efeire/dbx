import { isSchemaAware, isSingleDatabase } from "@/lib/database/databaseFeatureSupport";
import { matchTable, normalizeOracleNavigationIdentityName, splitQualifiedIdentifier } from "@/lib/sql/sqlNavigation";
import type { DatabaseType } from "@/types/database";

export const TABLE_HOVER_LOOKUP_MODES = ["current", "fallback", "always"] as const;
export type TableHoverLookupMode = (typeof TABLE_HOVER_LOOKUP_MODES)[number];

export function normalizeTableHoverLookupMode(value: unknown, fallback: TableHoverLookupMode = "fallback"): TableHoverLookupMode {
  return value === "current" || value === "fallback" || value === "always" ? value : fallback;
}

export interface ResolveHoverTableLookupTargetInput {
  database: string;
  /** Currently selected schema from the editor toolbar. */
  schema?: string;
  catalog?: string;
  databaseType?: DatabaseType;
  tableName: string;
  /** Identifier segments from the hovered/clicked token (e.g. `["other", "users"]`). */
  identifierParts: string[];
  /** Quote flags from SQL parsing, before identifier delimiters are removed. */
  identifierPartsQuoted?: boolean[];
  /** Semantic table identity may differ from the hovered alias. */
  tableNameQuoted?: boolean;
  semanticDatabase?: string;
  semanticSchema?: string;
  semanticSchemaQuoted?: boolean;
  mode: TableHoverLookupMode;
}

export interface HoverTableLookupTarget {
  database: string;
  schema?: string;
  catalog?: string;
  tableName: string;
  /** Schema/database came from SQL qualifier or semantic model — do not global-search. */
  schemaFromQualifier: boolean;
  /** After a scoped miss, retry with globalSearch by exact table name. */
  allowGlobalFallback: boolean;
  /** Unqualified + always mode: search across schemas first. */
  preferGlobalFirst: boolean;
  /** SQL names have been folded; compare canonical dictionary names exactly. */
  caseSensitive?: boolean;
}

/**
 * Resolve the metadata scope for table hover / Ctrl+click navigation.
 *
 * Qualified names (`schema.table`, `db.schema.table`, MySQL-style `db.table`)
 * always use the SQL qualifier. Unqualified names follow `mode`:
 * - `current`: only the selected schema
 * - `fallback`: selected schema first, then name-filtered global search
 * - `always`: name-filtered global search first
 *
 * "Global" here means same-database cross-schema, not cross-database.
 */
export function resolveHoverTableLookupTarget(input: ResolveHoverTableLookupTargetInput): HoverTableLookupTarget {
  // Only SQL-derived names are normalized here. Toolbar/current-schema and
  // dictionary names are already canonical and may belong to quoted objects.
  const caseSensitive = input.databaseType === "oceanbase-oracle";
  const tableName = caseSensitive ? normalizeOracleNavigationIdentityName(input.tableName, input.tableNameQuoted ?? input.identifierPartsQuoted?.[input.identifierParts.length - 1]) : input.tableName;
  let database = input.semanticDatabase ?? input.database;
  let schema = input.semanticSchema;
  let schemaFromQualifier = !!input.semanticSchema;

  if (!schemaFromQualifier && input.identifierParts.length >= 2) {
    const parts = input.identifierParts;
    if (parts.length >= 3) {
      database = parts[parts.length - 3]!;
      schema = parts[parts.length - 2];
      schemaFromQualifier = true;
    } else {
      if (input.databaseType && !isSchemaAware(input.databaseType) && !isSingleDatabase(input.databaseType)) {
        database = parts[0]!;
        schema = undefined;
      } else {
        schema = parts[0];
      }
      schemaFromQualifier = true;
    }
  }

  if (!schemaFromQualifier) {
    schema = input.schema;
  } else if (caseSensitive && schema != null) {
    const quoted = input.semanticSchema ? input.semanticSchemaQuoted : input.identifierPartsQuoted?.[input.identifierParts.length - 2];
    schema = normalizeOracleNavigationIdentityName(schema, quoted);
  }

  const unqualified = !schemaFromQualifier;
  const preferGlobalFirst = unqualified && input.mode === "always";
  const allowGlobalFallback = unqualified && (input.mode === "fallback" || input.mode === "always");

  return {
    database,
    schema: preferGlobalFirst ? undefined : schema,
    catalog: input.catalog,
    tableName,
    schemaFromQualifier,
    allowGlobalFallback,
    preferGlobalFirst,
    ...(caseSensitive ? { caseSensitive: true } : {}),
  };
}

/** Prefer the selected schema when the same table name exists in multiple schemas. */
export function pickHoverTableMatch<T extends { name: string; schema?: string }>(tableName: string, tables: readonly T[], preferredSchema?: string): T | null {
  const nameLower = tableName.toLowerCase();
  const nameMatches = tables.filter((table) => table.name.toLowerCase() === nameLower);
  if (nameMatches.length === 0) return null;
  if (preferredSchema) {
    const preferred = nameMatches.find((table) => table.schema?.toLowerCase() === preferredSchema.toLowerCase());
    if (preferred) return preferred;
  }
  return nameMatches[0] ?? null;
}

export interface MatchHoverTableCandidatesOptions {
  /** Qualified forms to try first (e.g. `schema.table` from the token or semantic model). */
  lookups?: string[];
  tableName: string;
  preferredSchema?: string;
  /** Reuse the exact identity and scope used for the metadata request. */
  lookupTarget?: HoverTableLookupTarget;
}

/**
 * Match hover/navigation table candidates.
 *
 * Qualified lookups use {@link matchTable}. Unqualified names go through
 * {@link pickHoverTableMatch} so the toolbar schema wins over arbitrary order.
 */
export function matchHoverTableCandidates<T extends { name: string; schema?: string; database?: string }>(tables: readonly T[], options: MatchHoverTableCandidatesOptions): T | null {
  const target = options.lookupTarget;
  if (target?.caseSensitive) {
    const matches = tables.filter((table) => table.name === target.tableName && (!table.database || table.database === target.database));
    if (target.schemaFromQualifier || (!target.allowGlobalFallback && target.schema)) {
      return matches.find((table) => table.schema === target.schema) ?? null;
    }
    const preferredSchema = options.preferredSchema ?? target.schema;
    return matches.find((table) => table.schema === preferredSchema) ?? matches[0] ?? null;
  }

  const seen = new Set<string>();
  for (const lookup of options.lookups ?? []) {
    const trimmed = lookup.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (splitQualifiedIdentifier(trimmed).length < 2) continue;
    const matched = matchTable(trimmed, tables);
    if (matched) return matched;
  }
  return pickHoverTableMatch(options.tableName, tables, options.preferredSchema);
}
