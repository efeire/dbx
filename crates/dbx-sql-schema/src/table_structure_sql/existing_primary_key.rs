use std::collections::HashSet;

use super::dialect::StructureDialect;
use super::util::{qualified_table, quote_ident};
use super::{build_table_structure_change_sql, TableStructureSqlOptions, TableStructureSqlResult};
use crate::models::connection::DatabaseType;

pub(super) fn build_existing_primary_key_change(mut options: TableStructureSqlOptions) -> TableStructureSqlResult {
    let change = options.primary_key_change.take().expect("existing primary key change");
    let reject =
        |message: &str| TableStructureSqlResult { statements: Vec::new(), warnings: vec![message.to_string()] };
    if options.database_type != Some(DatabaseType::OceanbaseOracle) || options.is_gaussdb_m_mode {
        return reject("Ordered existing primary key changes are only supported for OceanBase Oracle.");
    }
    if change.name.trim().is_empty() || change.original_columns.is_empty() {
        return reject("The original primary key name and ordered columns are required.");
    }
    let original: HashSet<_> = change.original_columns.iter().collect();
    let target: HashSet<_> = change.columns.iter().collect();
    if original.len() != change.original_columns.len() || target.len() != change.columns.len() {
        return reject("Primary key columns must not repeat.");
    }
    let known_original: HashSet<_> = options
        .columns
        .iter()
        .filter_map(|column| column.original.as_ref())
        .filter(|column| column.is_primary_key)
        .map(|column| &column.name)
        .collect();
    if original != known_original {
        return reject("The original primary key does not match the loaded columns. Refresh the table definition.");
    }
    if change.columns.iter().any(|name| {
        !options.columns.iter().any(|column| {
            !column.marked_for_drop
                && &column.name == name
                && column.original.as_ref().is_some_and(|old| &old.name == name)
        })
    }) {
        return reject("Primary key columns must be existing, unchanged columns.");
    }
    // Reuse the ordinary structure diff to reject combined edits. The explicit
    // ordered draft owns the key; the column membership flags remain unchanged.
    let ordinary = build_table_structure_change_sql(options.clone());
    if !ordinary.statements.is_empty() || !ordinary.warnings.is_empty() {
        return reject("Apply other table structure changes separately from an existing primary key change.");
    }
    if change.original_columns == change.columns {
        return TableStructureSqlResult { statements: Vec::new(), warnings: Vec::new() };
    }
    let dialect = StructureDialect::Oracle;
    let table = qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let name = quote_ident(dialect, &change.name);
    let mut statements = vec![format!("ALTER TABLE {table} DROP CONSTRAINT {name};")];
    if !change.columns.is_empty() {
        let columns = change.columns.iter().map(|name| quote_ident(dialect, name)).collect::<Vec<_>>().join(", ");
        statements.push(format!("ALTER TABLE {table} ADD CONSTRAINT {name} PRIMARY KEY ({columns});"));
    }
    TableStructureSqlResult { statements, warnings: Vec::new() }
}
