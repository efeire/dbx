//! Explicit user TYPE/BODY transfer using E09a full source and typed metadata.
use super::oracle_packages::{self, TransferSchemaObjectDependency, TransferSchemaObjectItem};
use super::*;
use crate::schema::oracle_types::{OracleMetadataReadState, OracleTypeDetails};
use std::io::Write;

fn is_type(kind: TransferObjectKind) -> bool { matches!(kind, TransferObjectKind::Type | TransferObjectKind::TypeBody) }
fn dictionary_kind(kind: TransferObjectKind) -> &'static str { if kind == TransferObjectKind::TypeBody { "TYPE BODY" } else { "TYPE" } }
fn api_kind(kind: TransferObjectKind) -> &'static str { if kind == TransferObjectKind::TypeBody { "TYPE_BODY" } else { "TYPE" } }
fn source_kind(kind: TransferObjectKind) -> db::ObjectSourceKind { if kind == TransferObjectKind::TypeBody { db::ObjectSourceKind::TypeBody } else { db::ObjectSourceKind::Type } }
fn selected(request: &TransferRequest) -> Vec<(TransferObjectKind, String)> {
    let mut result = Vec::new();
    for selection in request.object_selection_mode().selections() {
        if is_type(selection.object_type) { for name in &selection.names { let key = (selection.object_type, name.clone()); if !result.contains(&key) { result.push(key); } } }
    }
    result
}
fn text(row: &[serde_json::Value], index: usize) -> Result<String, String> {
    row.get(index).and_then(|v| v.as_str()).map(str::to_string).ok_or_else(|| "Type dictionary returned incomplete metadata".into())
}
async fn metadata(state: &AppState, pool: &str, sql: &str) -> Result<db::QueryResult, String> {
    let result = execute_read_on_pool_with_max_rows(state, pool, sql, Some(i32::MAX as usize)).await?;
    if result.truncated || result.has_more { return Err("Type metadata is incomplete; transfer blocked".into()); }
    Ok(result)
}
async fn source(state: &AppState, connection: &str, database: &str, owner: &str, name: &str, kind: TransferObjectKind) -> Result<String, String> {
    let source = crate::schema::get_object_source_core(state, connection, database, owner, name, source_kind(kind), None, None).await?;
    let (_, _, tail) = oracle_packages::declaration(&source.source, kind)?;
    if oracle_packages::sql_words(&tail).iter().all(|word| word == ";" || word == "/") { return Err("Incomplete type declaration cannot be migrated".into()); }
    Ok(source.source)
}
async fn details(state: &AppState, connection: &str, database: &str, owner: &str, name: &str, kind: TransferObjectKind) -> Result<OracleTypeDetails, String> {
    let value = crate::schema::oracle_types::get_oracle_type_details_core(state, connection, database, owner, name, api_kind(kind)).await?;
    require_details(&value)?;
    Ok(value)
}
fn readable(state: &OracleMetadataReadState) -> bool { matches!(state, OracleMetadataReadState::Available | OracleMetadataReadState::Empty) }
fn require_details(value: &OracleTypeDetails) -> Result<(), String> {
    if value.status.as_deref() != Some("VALID") || !readable(&value.pairing_state) || !readable(&value.dependencies.state) {
        return Err("Type status, pairing or dependencies are invalid, unknown, denied or unsupported".into());
    }
    if let Some(pair) = &value.paired_object {
        if pair.schema != value.identity.schema || pair.name != value.identity.name || pair.object_type == value.identity.object_type { return Err("Type pairing identity does not match owner/name/specification/body".into()); }
    } else if value.identity.object_type == "TYPE_BODY" { return Err("TYPE BODY has no visible paired TYPE".into()); }
    Ok(())
}
async fn user_type(state: &AppState, pool: &str, owner: &str, name: &str) -> Result<String, String> {
    let rows = metadata(state, pool, &format!("SELECT T.TYPECODE FROM ALL_TYPES T JOIN ALL_OBJECTS O ON O.OWNER=T.OWNER AND O.OBJECT_NAME=T.TYPE_NAME AND O.OBJECT_TYPE='TYPE' WHERE T.OWNER={} AND T.TYPE_NAME={} AND T.PREDEFINED='NO' AND O.GENERATED='N' AND O.ORACLE_MAINTAINED='N'", quote_string_literal(owner), quote_string_literal(name))).await?.rows;
    if rows.len() != 1 { return Err("Selected object is not a visible, non-generated user type".into()); }
    let code = text(&rows[0], 0)?;
    if !matches!(code.as_str(), "OBJECT" | "COLLECTION") { return Err(format!("Unsupported user type category: {code}")); }
    Ok(code)
}
async fn object_status(state: &AppState, pool: &str, owner: &str, name: &str, kind: &str) -> Result<Option<String>, String> {
    let rows = metadata(state, pool, &format!("SELECT STATUS FROM ALL_OBJECTS WHERE OWNER={} AND OBJECT_NAME={} AND OBJECT_TYPE={}", quote_string_literal(owner), quote_string_literal(name), quote_string_literal(&kind.replace('_', " ")))).await?.rows;
    if rows.len() > 1 { return Err("Ambiguous type dependency identity".into()); }
    rows.first().map(|row| text(row, 0)).transpose()
}
fn supported_version(kind: &DatabaseType, banner: &str) -> Result<String, String> {
    let pattern = if *kind == DatabaseType::Oracle { r"Oracle Database (19c|21c|23ai|23c)\b" } else { r"(?i)\b(4\.2\.5)(?:\.|\b)" };
    Regex::new(pattern).unwrap().captures(banner).and_then(|c| c.get(1)).map(|c| c.as_str().to_ascii_lowercase()).ok_or_else(|| "Target/source type support is unknown for this version".into())
}
async fn check_engines(state: &AppState, request: &TransferRequest, source: &str, target: &str) -> Result<(), String> {
    let source_type = get_db_type(state, &request.source_connection_id).await?;
    let target_type = get_db_type(state, &request.target_connection_id).await?;
    if !matches!(source_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle) || source_type != target_type { return Err("Cross-engine Oracle/OceanBase type compatibility requires a reviewed conversion; transfer blocked".into()); }
    let sql = if source_type == DatabaseType::Oracle { "SELECT BANNER FROM V$VERSION WHERE BANNER LIKE 'Oracle Database%'" } else { "SELECT VERSION() FROM DUAL" };
    let source_version = metadata(state, source, sql).await?.rows.first().map(|r| text(r, 0)).transpose()?.ok_or("Source version is unknown")?;
    let target_version = metadata(state, target, sql).await?.rows.first().map(|r| text(r, 0)).transpose()?.ok_or("Target version is unknown")?;
    if supported_version(&source_type, &source_version)? != supported_version(&target_type, &target_version)? { return Err("Cross-version type compatibility is unverified; transfer blocked".into()); }
    Ok(())
}

/// A fully visible target inventory is required before replacing a type. ALL_* alone
/// cannot prove that another schema has no stored data or program dependency.
async fn incoming(state: &AppState, pool: &str, owner: &str, name: &str, complete: bool) -> Result<Vec<TransferSchemaObjectDependency>, String> {
    let prefix = if complete { "DBA" } else { "ALL" };
    let mut sql = format!("SELECT OWNER, NAME, TYPE FROM {prefix}_DEPENDENCIES WHERE REFERENCED_OWNER={} AND REFERENCED_NAME={} AND REFERENCED_TYPE='TYPE' UNION SELECT OWNER, TABLE_NAME, 'TABLE COLUMN ' || COLUMN_NAME FROM {prefix}_TAB_COLUMNS WHERE DATA_TYPE_OWNER={} AND DATA_TYPE={}", quote_string_literal(owner), quote_string_literal(name), quote_string_literal(owner), quote_string_literal(name));
    if transfer_pool_context(state, pool).await.2 == Some(DatabaseType::Oracle) {
        sql.push_str(&format!(" UNION SELECT OWNER, TABLE_NAME, 'OBJECT TABLE' FROM {prefix}_OBJECT_TABLES WHERE TABLE_TYPE_OWNER={} AND TABLE_TYPE={}", quote_string_literal(owner), quote_string_literal(name)));
    }
    metadata(state, pool, &sql).await?.rows.iter().map(|row| Ok(TransferSchemaObjectDependency { owner: text(row, 0)?, name: text(row, 1)?, object_type: format!("INCOMING {}", text(row, 2)?), available: true })).collect()
}
fn replacement_allowed(incoming: &[TransferSchemaObjectDependency], owner: &str, name: &str, kind: TransferObjectKind, selection: &[(TransferObjectKind, String)]) -> Result<(), String> {
    // Replacing a body cannot change stored type attributes. Replacing a specification
    // with table/type/program dependents must not rely on FORCE or a cascading drop.
    if kind == TransferObjectKind::TypeBody { return Ok(()); }
    if incoming.iter().any(|d| !(d.owner == owner && d.name == name && d.object_type == "INCOMING TYPE BODY" && selection.contains(&(TransferObjectKind::TypeBody, name.into())))) {
        return Err("Existing target table/type/program dependencies prevent safe type replacement; no FORCE/CASCADE is used".into());
    }
    Ok(())
}
fn needs_type_before_tables(request: &TransferRequest, incoming: &[TransferSchemaObjectDependency], source_owner: &str, kind: TransferObjectKind, target_status: Option<&str>) -> bool {
    kind == TransferObjectKind::Type && request.create_table && (target_status != Some("VALID") || request.object_conflict_policy == TransferObjectConflictPolicy::Replace) && incoming.iter().any(|dependency| {
        dependency.owner == source_owner && request.tables.contains(&dependency.name)
            && (dependency.object_type == "INCOMING TABLE" || dependency.object_type == "INCOMING OBJECT TABLE" || dependency.object_type.starts_with("INCOMING TABLE COLUMN "))
    })
}
#[derive(Clone)]
struct Planned { item: TransferSchemaObjectItem, original: Option<String>, original_body: Option<String> }

fn order_plan(items: &mut Vec<Planned>) {
    let mut pending = std::mem::take(items);
    while !pending.is_empty() {
        let next = pending.iter().position(|entry| !entry.item.dependencies.iter().any(|dependency| pending.iter().any(|other| {
            dependency.owner == other.item.target_schema && dependency.name == other.item.name && dependency.object_type == api_kind(other.item.object_type)
        })));
        if let Some(index) = next { items.push(pending.remove(index)); } else {
            for mut entry in pending { entry.item.action = "blocked".into(); entry.item.errors.push("Selected type dependency cycle requires an explicit migration plan".into()); items.push(entry); }
            break;
        }
    }
}
async fn build_plan(state: &AppState, request: &TransferRequest, source_pool: &str, target_pool: &str) -> Result<Vec<Planned>, String> {
    let selection = selected(request);
    let source_owner = resolve_oracle_schema(&request.source_schema, &request.source_database);
    let target_owner = resolve_oracle_schema(&request.target_schema, &request.target_database);
    let engine_check = check_engines(state, request, source_pool, target_pool).await;
    let mut plan = Vec::new();
    for (kind, name) in &selection {
        let mut entry = Planned { item: TransferSchemaObjectItem { credential_required: None, object_type: *kind, name: name.clone(), source_schema: source_owner.clone(), target_schema: target_owner.clone(), action: "create".into(), ddl: String::new(), dependencies: Vec::new(), warnings: vec!["Source incoming dependencies are limited to the current account's visibility. Explicit owner references in the body are preserved. Grants are not copied.".into()], errors: Vec::new() }, original: None, original_body: None };
        let preparation: Result<(), String> = async {
            engine_check.clone()?;
            if request.source_connection_id == request.target_connection_id && source_owner == target_owner { return Err("Source and target type identities must differ".into()); }
            user_type(state, source_pool, &source_owner, name).await?;
            let source_details = details(state, &request.source_connection_id, &request.source_database, &source_owner, name, *kind).await?;
            if *kind == TransferObjectKind::TypeBody && source_details.paired_object.is_none() { return Err("Selected TYPE BODY has no visible paired TYPE specification".into()); }
            let original = source(state, &request.source_connection_id, &request.source_database, &source_owner, name, *kind).await?;
            entry.item.ddl = oracle_packages::map_header(&original, *kind, name, &target_owner)?;
            let words = oracle_packages::sql_words(&oracle_packages::declaration(&original, *kind)?.2);
            for dependency in source_details.dependencies.rows {
                if dependency.referenced_link.as_deref().is_some_and(|link| !link.is_empty()) { return Err("Remote type dependencies cannot be verified for migration".into()); }
                let owner = dependency.referenced_schema.ok_or("Type dependency owner is unknown")?;
                let explicit = words.windows(3).any(|part| oracle_packages::identifier_word(&part[0]) == owner && part[1] == "." && oracle_packages::identifier_word(&part[2]) == dependency.referenced_name);
                let mapped_owner = if owner == source_owner && !explicit { target_owner.clone() } else { owner };
                let dependency_kind = match dependency.referenced_type.as_str() { "TYPE" => Some(TransferObjectKind::Type), "TYPE_BODY" => Some(TransferObjectKind::TypeBody), _ => None };
                let planned = mapped_owner == target_owner && dependency_kind.is_some_and(|kind| selection.contains(&(kind, dependency.referenced_name.clone())));
                // Dictionary self references do not form a migration edge.
                if mapped_owner == target_owner && dependency.referenced_name == *name && dependency_kind == Some(*kind) { continue; }
                let available = planned || object_status(state, target_pool, &mapped_owner, &dependency.referenced_name, &dependency.referenced_type).await?.as_deref() == Some("VALID");
                entry.item.dependencies.push(TransferSchemaObjectDependency { owner: mapped_owner, name: dependency.referenced_name, object_type: dependency.referenced_type, available });
            }
            if *kind == TransferObjectKind::TypeBody && !entry.item.dependencies.iter().any(|d| d.owner == target_owner && d.name == *name && d.object_type == "TYPE") {
                let available = selection.contains(&(TransferObjectKind::Type, name.clone())) || object_status(state, target_pool, &target_owner, name, "TYPE").await?.as_deref() == Some("VALID");
                entry.item.dependencies.push(TransferSchemaObjectDependency { owner: target_owner.clone(), name: name.clone(), object_type: "TYPE".into(), available });
            }
            if source_details.paired_object.is_some() && *kind == TransferObjectKind::Type && !selection.contains(&(TransferObjectKind::TypeBody, name.clone())) { entry.item.warnings.push("Source TYPE BODY exists but was not selected; it is not implicitly migrated.".into()); }
            entry.item.dependencies.extend(incoming(state, source_pool, &source_owner, name, false).await?);
            if entry.item.dependencies.iter().any(|d| !d.available) { return Err("Missing or invalid target type dependency".into()); }
            let namespace = metadata(state, target_pool, &format!("SELECT OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER={} AND OBJECT_NAME={} AND OBJECT_TYPE IN ('TABLE','VIEW','MATERIALIZED VIEW','SEQUENCE','PROCEDURE','FUNCTION','PACKAGE','TYPE','TYPE BODY','SYNONYM')", quote_string_literal(&target_owner), quote_string_literal(name))).await?;
            if namespace.rows.iter().any(|r| text(r, 0).is_ok_and(|kind| kind != "TYPE" && kind != "TYPE BODY")) { return Err("Target type name conflicts with another schema object".into()); }
            let existing = object_status(state, target_pool, &target_owner, name, dictionary_kind(*kind)).await?;
            if needs_type_before_tables(request, &entry.item.dependencies, &source_owner, *kind, existing.as_deref()) {
                return Err("Selected tables reference this new/invalid/replaced target TYPE. Tables currently run before schema objects; migrate the TYPE in a separate explicit run first".into());
            }
            if existing.is_some() {
                user_type(state, target_pool, &target_owner, name).await?;
                if request.object_conflict_policy == TransferObjectConflictPolicy::Skip { entry.item.action = "skip".into(); return Ok(()); }
                entry.item.action = "replace".into();
                let target_details = details(state, &request.target_connection_id, &request.target_database, &target_owner, name, *kind).await?;
                if !readable(&target_details.grants.state) { return Err("Target grants are unknown; safe replacement cannot be prepared".into()); }
                let dependents = incoming(state, target_pool, &target_owner, name, true).await?;
                replacement_allowed(&dependents, &target_owner, name, *kind, &selection)?;
                entry.item.dependencies.extend(dependents);
                entry.original = Some(source(state, &request.target_connection_id, &request.target_database, &target_owner, name, *kind).await?);
                if *kind == TransferObjectKind::Type && target_details.paired_object.is_some() { entry.original_body = Some(source(state, &request.target_connection_id, &request.target_database, &target_owner, name, TransferObjectKind::TypeBody).await?); }
            }
            let privileges = metadata(state, target_pool, "SELECT PRIVILEGE FROM SESSION_PRIVS").await?.rows;
            let login_rows = metadata(state, target_pool, "SELECT USER FROM DUAL").await?.rows;
            let login = login_rows.first().map(|r| text(r, 0)).transpose()?.ok_or("Target login is unknown")?;
            let required = if login == target_owner { "CREATE TYPE" } else { "CREATE ANY TYPE" };
            if !privileges.iter().any(|r| text(r, 0).ok().as_deref() == Some(required)) { return Err(format!("Missing target privilege: {required}")); }
            Ok(())
        }.await;
        if let Err(error) = preparation { entry.item.action = "blocked".into(); entry.item.errors.push(error); }
        plan.push(entry);
    }
    // Selection cannot make an invalid skipped specification into a usable dependency.
    let skipped: HashSet<_> = plan.iter().filter(|p| p.item.action == "skip").map(|p| (p.item.target_schema.clone(), p.item.name.clone(), api_kind(p.item.object_type).to_string())).collect();
    for entry in &mut plan {
        for dependency in &mut entry.item.dependencies {
            if skipped.contains(&(dependency.owner.clone(), dependency.name.clone(), dependency.object_type.clone())) {
                dependency.available = object_status(state, target_pool, &dependency.owner, &dependency.name, &dependency.object_type).await?.as_deref() == Some("VALID");
                if !dependency.available { entry.item.action = "blocked".into(); entry.item.errors.push("Selected skipped type dependency is invalid".into()); }
            }
        }
    }
    order_plan(&mut plan);
    Ok(plan)
}
pub(super) async fn preview(state: &AppState, request: &TransferRequest, source: &str, target: &str) -> Result<Option<TransferSchemaObjectPlan>, String> {
    if request.content == TransferContent::DataOnly || selected(request).is_empty() { return Ok(None); }
    let items: Vec<_> = build_plan(state, request, source, target).await?.into_iter().map(|p| p.item).collect();
    Ok(Some(TransferSchemaObjectPlan { can_execute: items.iter().all(|p| p.action != "blocked"), items }))
}
pub(super) async fn ensure_ready(state: &AppState, request: &TransferRequest, source: &str, target: &str) -> Result<(), String> {
    if let Some(plan) = preview(state, request, source, target).await? { if !plan.can_execute { return Err(plan.items.iter().flat_map(|p| p.errors.clone()).collect::<Vec<_>>().join("; ")); } }
    Ok(())
}
#[derive(Serialize)]
struct Backup<'a> { schema: &'a str, name: &'a str, object_type: TransferObjectKind, source: &'a str, paired_body: &'a Option<String> }
fn backup(state: &AppState, entry: &Planned) -> Result<String, String> {
    let directory = state.storage.data_dir().join("transfer-object-backups"); std::fs::create_dir_all(&directory).map_err(|_| "Cannot create type backup directory")?;
    let path = directory.join(format!("type-{}.json", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let payload = Backup { schema: &entry.item.target_schema, name: &entry.item.name, object_type: entry.item.object_type, source: entry.original.as_deref().ok_or("Missing original type source")?, paired_body: &entry.original_body };
    let mut file = options.open(&path).map_err(|_| "Cannot create type backup")?;
    file.write_all(&serde_json::to_vec(&payload).map_err(|e| e.to_string())?).and_then(|_| file.sync_all()).map_err(|_| "Cannot persist complete type backup")?;
    Ok(path.to_string_lossy().into_owned())
}
async fn verify(state: &AppState, request: &TransferRequest, pool: &str, item: &TransferSchemaObjectItem) -> Result<(), String> {
    let readback = source(state, &request.target_connection_id, &request.target_database, &item.target_schema, &item.name, item.object_type).await?;
    oracle_packages::verify_readback(&readback, item)?;
    if object_status(state, pool, &item.target_schema, &item.name, dictionary_kind(item.object_type)).await?.as_deref() != Some("VALID") {
        let errors = metadata(state, pool, &format!("SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE OWNER={} AND NAME={} AND TYPE={} ORDER BY SEQUENCE", quote_string_literal(&item.target_schema), quote_string_literal(&item.name), quote_string_literal(dictionary_kind(item.object_type)))).await?;
        return Err(format!("Target type is invalid after creation: {:?}", errors.rows));
    }
    Ok(())
}
pub(super) async fn execute<F: FnMut(TransferProgress)>(state: &AppState, request: &TransferRequest, source_pool: &str, target_pool: &str, progress: &mut F) -> Result<TransferObjectOutcome, String> {
    if request.content == TransferContent::DataOnly || selected(request).is_empty() { return Ok(TransferObjectOutcome::default()); }
    let plan = build_plan(state, request, source_pool, target_pool).await?;
    let blocked = plan.iter().any(|p| p.item.action == "blocked");
    let mut failed = HashSet::new(); let mut outcome = TransferObjectOutcome::default();
    for entry in plan {
        let item = &entry.item;
        let mut result = TransferSchemaObjectResult { object_type: item.object_type, name: item.name.clone(), schema: item.target_schema.clone(), status: "failed".into(), compile_status: None, source_verified: None, error: None, recovery: None };
        let operation: Result<(), String> = async {
            if blocked { return Err(if item.errors.is_empty() { "Type plan is incomplete; no type DDL executed".into() } else { item.errors.join("; ") }); }
            if is_cancelled(&request.transfer_id).await { return Err("Cancelled before type execution".into()); }
            if item.dependencies.iter().any(|d| failed.contains(&(d.owner.clone(), d.name.clone(), d.object_type.clone()))) { return Err("A selected type dependency failed; this object was not executed".into()); }
            if item.action == "skip" { result.status = "skipped".into(); return Ok(()); }
            // Recheck destructive replacement impact immediately before writing.
            let status = object_status(state, target_pool, &item.target_schema, &item.name, dictionary_kind(item.object_type)).await?;
            if entry.original.is_some() != status.is_some() { return Err("Target type changed after planning; preview again".into()); }
            if let Some(original) = &entry.original {
                let current = source(state, &request.target_connection_id, &request.target_database, &item.target_schema, &item.name, item.object_type).await?;
                let original_item = TransferSchemaObjectItem { ddl: original.clone(), ..item.clone() };
                oracle_packages::verify_readback(&current, &original_item)?;
                if let Some(body) = &entry.original_body {
                    let current_body = source(state, &request.target_connection_id, &request.target_database, &item.target_schema, &item.name, TransferObjectKind::TypeBody).await?;
                    let body_item = TransferSchemaObjectItem { object_type: TransferObjectKind::TypeBody, ddl: body.clone(), ..item.clone() };
                    oracle_packages::verify_readback(&current_body, &body_item)?;
                }
                let dependents = incoming(state, target_pool, &item.target_schema, &item.name, true).await?;
                replacement_allowed(&dependents, &item.target_schema, &item.name, item.object_type, &selected(request))?;
                let path = backup(state, &entry)?;
                result.recovery = Some(format!("Complete original type source and visible paired body retained at {path}. Restore explicitly after checking current dependencies; no automatic rollback or forced drop."));
            }
            for dependency in item.dependencies.iter().filter(|d| !d.object_type.starts_with("INCOMING ")) {
                if object_status(state, target_pool, &dependency.owner, &dependency.name, &dependency.object_type).await?.as_deref() != Some("VALID") { return Err("Target dependency is not valid at execution time".into()); }
            }
            // Existing transfer writes are non-replayable. There is no DROP/FORCE/CASCADE path.
            execute_on_pool(state, target_pool, &item.ddl).await?;
            verify(state, request, target_pool, item).await?;
            result.status = if item.action == "replace" { "replaced" } else { "created" }.into(); result.compile_status = Some("VALID".into()); result.source_verified = Some(true);
            Ok(())
        }.await;
        if let Err(error) = operation { result.error = Some(error); failed.insert((item.target_schema.clone(), item.name.clone(), api_kind(item.object_type).to_string())); }
        let key = format!("{:?}:{}", item.object_type, item.name);
        match result.status.as_str() { "created" | "replaced" => outcome.transferred.push(key), "skipped" => outcome.skipped.push(key), _ => outcome.failed.push(key) }
        progress(TransferProgress { transfer_id: request.transfer_id.clone(), table: format!("schema object: {}", item.name), table_index: request.tables.len(), total_tables: request.tables.len(), rows_transferred: outcome.transferred.len() as u64, total_rows: None, status: if result.error.is_some() { TransferStatus::Error } else { TransferStatus::Running }, error: result.error.clone(), terminal: false, object_result: Some(result.clone()) });
        outcome.object_results.push(result);
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::oracle_types::{OracleMetadataSection, OracleTypeIdentity};
    fn item(kind: TransferObjectKind, name: &str) -> Planned {
        Planned { item: TransferSchemaObjectItem { credential_required: None, object_type: kind, name: name.into(), source_schema: "SRC".into(), target_schema: "DST".into(), action: "create".into(), ddl: String::new(), dependencies: Vec::new(), warnings: Vec::new(), errors: Vec::new() }, original: None, original_body: None }
    }
    fn dependency(kind: &str, name: &str) -> TransferSchemaObjectDependency {
        TransferSchemaObjectDependency { owner: "DST".into(), name: name.into(), object_type: kind.into(), available: true }
    }
    #[test]
    fn maps_only_declaration_and_preserves_quoted_names_and_owner_references() {
        let original = r#"CREATE OR REPLACE TYPE "SRC"."a.b" AS OBJECT (value "SRC"."Other.Type", text VARCHAR2(30));"#;
        let ddl = oracle_packages::map_header(original, TransferObjectKind::Type, "a.b", "Target Owner").unwrap();
        assert_eq!(ddl, r#"CREATE OR REPLACE TYPE "Target Owner"."a.b" AS OBJECT (value "SRC"."Other.Type", text VARCHAR2(30));"#);
        let plan = TransferSchemaObjectItem { ddl: ddl.clone(), ..item(TransferObjectKind::Type, "a.b").item };
        assert!(oracle_packages::verify_readback(&ddl, &plan).is_ok());
        assert!(oracle_packages::verify_readback(&ddl.replace("VARCHAR2(30)", "VARCHAR2(10)"), &plan).is_err());
        assert!(oracle_packages::map_header(original, TransferObjectKind::TypeBody, "a.b", "DST").is_err());
    }
    #[test]
    fn orders_nested_types_and_their_exact_bodies() {
        let mut nested = item(TransferObjectKind::Type, "Nested"); nested.item.dependencies.push(dependency("TYPE", "Base"));
        let mut body = item(TransferObjectKind::TypeBody, "Nested"); body.item.dependencies.push(dependency("TYPE", "Nested"));
        let mut items = vec![body, nested, item(TransferObjectKind::Type, "Base")];
        order_plan(&mut items);
        assert_eq!(items.iter().map(|p| (p.item.object_type, p.item.name.as_str())).collect::<Vec<_>>(), vec![(TransferObjectKind::Type, "Base"), (TransferObjectKind::Type, "Nested"), (TransferObjectKind::TypeBody, "Nested")]);
    }
    #[test]
    fn cycles_are_blocked_and_incoming_labels_are_not_sort_edges() {
        let mut first = item(TransferObjectKind::Type, "A"); first.item.dependencies.push(dependency("TYPE", "B"));
        let mut second = item(TransferObjectKind::Type, "B"); second.item.dependencies.push(dependency("TYPE", "A"));
        let mut items = vec![first, second]; order_plan(&mut items);
        assert!(items.iter().all(|p| p.item.action == "blocked"));
        let mut item = item(TransferObjectKind::Type, "A"); item.item.dependencies.push(dependency("INCOMING TYPE BODY", "A"));
        let mut items = vec![item]; order_plan(&mut items); assert_eq!(items[0].item.action, "create");
    }
    #[test]
    fn existing_data_and_program_dependencies_block_specification_replacement() {
        for kind in ["INCOMING TABLE COLUMN PAYLOAD", "INCOMING PACKAGE", "INCOMING TYPE"] {
            assert!(replacement_allowed(&[dependency(kind, "Consumer")], "DST", "T", TransferObjectKind::Type, &[]).is_err());
        }
        let body = dependency("INCOMING TYPE BODY", "T");
        assert!(replacement_allowed(&[body.clone()], "DST", "T", TransferObjectKind::Type, &[]).is_err());
        assert!(replacement_allowed(&[body], "DST", "T", TransferObjectKind::Type, &[(TransferObjectKind::TypeBody, "T".into())]).is_ok());
    }
    #[test]
    fn selected_tables_cannot_precede_a_new_type() {
        let request: TransferRequest = serde_json::from_value(serde_json::json!({"transferId":"t","sourceConnectionId":"s","sourceDatabase":"SRC","sourceSchema":"SRC","targetConnectionId":"t","targetDatabase":"DST","targetSchema":"DST","tables":["PAYLOAD"],"createTable":true,"batchSize":10})).unwrap();
        let incoming = vec![TransferSchemaObjectDependency { owner: "SRC".into(), name: "PAYLOAD".into(), object_type: "INCOMING TABLE COLUMN VALUE".into(), available: true }];
        assert!(needs_type_before_tables(&request, &incoming, "SRC", TransferObjectKind::Type, None));
        assert!(needs_type_before_tables(&request, &incoming, "SRC", TransferObjectKind::Type, Some("INVALID")));
        assert!(!needs_type_before_tables(&request, &incoming, "SRC", TransferObjectKind::Type, Some("VALID")));
        assert!(!needs_type_before_tables(&request, &incoming, "SRC", TransferObjectKind::TypeBody, None));
    }
    #[test]
    fn unknown_or_denied_metadata_cannot_mean_no_dependencies() {
        let mut details = OracleTypeDetails { identity: OracleTypeIdentity { schema: "SRC".into(), name: "T".into(), object_type: "TYPE".into() }, status: Some("VALID".into()), paired_object: None, pairing_state: OracleMetadataReadState::Empty, dependencies: OracleMetadataSection { state: OracleMetadataReadState::Empty, rows: Vec::new(), message: None }, grants: OracleMetadataSection { state: OracleMetadataReadState::Empty, rows: Vec::new(), message: None } };
        assert!(require_details(&details).is_ok());
        for state in [OracleMetadataReadState::Unknown, OracleMetadataReadState::Denied, OracleMetadataReadState::Unsupported, OracleMetadataReadState::Error] { details.dependencies.state = state; assert!(require_details(&details).is_err()); }
        details.dependencies.state = OracleMetadataReadState::Empty; details.identity.object_type = "TYPE_BODY".into(); assert!(require_details(&details).is_err());
        details.paired_object = Some(OracleTypeIdentity { schema: "OTHER".into(), name: "T".into(), object_type: "TYPE".into() }); assert!(require_details(&details).is_err());
        details.paired_object.as_mut().unwrap().schema = "SRC".into(); assert!(require_details(&details).is_ok());
        details.status = None; assert!(require_details(&details).is_err());
    }
    #[test]
    fn version_support_does_not_assume_unknown_releases() {
        assert_eq!(supported_version(&DatabaseType::Oracle, "Oracle Database 19c Enterprise Edition").unwrap(), "19c");
        assert!(supported_version(&DatabaseType::Oracle, "Oracle Database 11g").is_err());
        assert!(supported_version(&DatabaseType::OceanbaseOracle, "OceanBase 4.2.5.6").is_ok());
        assert!(supported_version(&DatabaseType::OceanbaseOracle, "OceanBase 4.3.0").is_err());
    }
}
