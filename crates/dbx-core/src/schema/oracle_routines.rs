use super::*;
use crate::schema_diff::{comparable_oracle_routine, FunctionDiff};

fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

async fn dictionary_query(
    state: &AppState,
    connection: &str,
    database: &str,
    schema: &str,
    sql: &str,
) -> Result<db::QueryResult, String> {
    let config = connection_config(state, connection).await.ok_or("Connection not found")?;
    if !crate::schema_diff::is_oracle_routine_database(config.db_type) {
        return Err("Routine validation requires Oracle or OceanBase Oracle".into());
    }
    let pool = state.get_or_create_metadata_pool_for_session(connection, Some(database), None).await?;
    let result = crate::query::do_execute(
        state,
        &pool,
        db::mysql::MySqlQueryDialect::for_connection(config.db_type, config.driver_profile.as_deref()),
        Some(database),
        sql,
        Some(schema),
        None,
        QueryExecutionOptions::default(),
    )
    .await?;
    if result.truncated || result.has_more {
        return Err("Dictionary result is incomplete; comparison stopped".into());
    }
    Ok(result)
}
fn cell(row: &[serde_json::Value], index: usize) -> String {
    row.get(index).and_then(serde_json::Value::as_str).unwrap_or_default().to_string()
}

#[cfg(all(test, unix))]
#[path = "oracle_routine_context_tests.rs"]
mod context_tests;

#[allow(clippy::too_many_arguments)]
pub async fn schema_diff_routine_context(
    state: &AppState,
    endpoints: Option<&crate::schema_diff::RoutineEndpoints>,
    source_type: Option<DatabaseType>,
    target_type: DatabaseType,
    source_schema: Option<&str>,
    target_schema: Option<&str>,
    source_objects: &[db::FunctionInfo],
    removed_objects: &[db::FunctionInfo],
    target_objects: &[db::FunctionInfo],
) -> Result<Option<dbx_sql::oracle_program_compatibility::OracleProgramContext>, String> {
    if (source_objects.is_empty() && removed_objects.is_empty() && target_objects.is_empty())
        || !crate::schema_diff::is_oracle_routine_database(target_type)
        || !source_type.is_some_and(crate::schema_diff::is_oracle_routine_database)
    {
        return Ok(None);
    }
    let Some(endpoints) = endpoints else { return Ok(None) };
    let source_schema = source_schema.filter(|s| !s.is_empty()).ok_or("Explicit source schema is required")?;
    let target_schema = target_schema.filter(|s| !s.is_empty()).ok_or("Explicit target schema is required")?;
    let source_config =
        connection_config(state, &endpoints.source_connection_id).await.ok_or("Source connection not found")?;
    let target_config =
        connection_config(state, &endpoints.target_connection_id).await.ok_or("Target connection not found")?;
    if Some(source_config.db_type) != source_type || target_config.db_type != target_type {
        return Err("Routine endpoint engines disagree with comparison metadata".into());
    }
    if endpoints.recovery
        && (endpoints.source_connection_id != endpoints.target_connection_id
            || endpoints.source_database != endpoints.target_database
            || source_schema != target_schema
            || source_type != Some(target_type))
    {
        return Err("Routine recovery must use the saved target schema and the same target connection".into());
    }
    let version_sql = |kind: DatabaseType| {
        if kind == DatabaseType::Oracle {
            "SELECT BANNER FROM V$VERSION WHERE BANNER LIKE 'Oracle Database%'"
        } else {
            "SELECT OB_VERSION() FROM DUAL"
        }
    };
    let from = dictionary_query(
        state,
        &endpoints.source_connection_id,
        &endpoints.source_database,
        source_schema,
        version_sql(source_config.db_type),
    )
    .await?;
    let to = dictionary_query(
        state,
        &endpoints.target_connection_id,
        &endpoints.target_database,
        target_schema,
        version_sql(target_type),
    )
    .await?;
    if from.rows.len() != 1 || to.rows.len() != 1 {
        return Err("Routine source/target version is missing or ambiguous".into());
    }
    let mut context = dbx_sql::oracle_program_compatibility::OracleProgramContext {
        source_version: cell(&from.rows[0], 0),
        target_version: cell(&to.rows[0], 0),
        target_editions_disabled: target_type != DatabaseType::Oracle,
        non_editioned_source_objects: Vec::new(),
        target_dependencies: Vec::new(),
        blocked_types: Vec::new(),
        blocked_bodies: Vec::new(),
    };
    if target_type == DatabaseType::Oracle {
        let rows = dictionary_query(
            state,
            &endpoints.target_connection_id,
            &endpoints.target_database,
            target_schema,
            &format!("SELECT EDITIONS_ENABLED FROM ALL_USERS WHERE USERNAME={}", literal(target_schema)),
        )
        .await?
        .rows;
        context.target_editions_disabled = rows.len() == 1 && cell(&rows[0], 0) == "N";
    }
    if source_config.db_type == DatabaseType::Oracle {
        for info in source_objects {
            if info.schema.as_deref() != Some(source_schema) {
                return Err("Routine source owner differs from comparison schema".into());
            }
            let kinds = match info.function_type.as_str() {
                "PACKAGE" | "PACKAGE BODY" => "'PACKAGE','PACKAGE BODY'".to_string(),
                kind => literal(kind),
            };
            let rows = dictionary_query(state, &endpoints.source_connection_id, &endpoints.source_database, source_schema, &format!("SELECT OBJECT_TYPE, EDITION_NAME FROM ALL_OBJECTS WHERE OWNER={} AND OBJECT_NAME={} AND OBJECT_TYPE IN ({kinds})", literal(source_schema), literal(&info.name))).await?.rows;
            if !rows.is_empty() && rows.iter().all(|row| row.get(1).is_some_and(serde_json::Value::is_null)) {
                for row in rows {
                    let identity = (info.name.clone(), cell(&row, 0));
                    if !context.non_editioned_source_objects.contains(&identity) {
                        context.non_editioned_source_objects.push(identity);
                    }
                }
            }
        }
    }
    for info in source_objects {
        if info.schema.as_deref() != Some(source_schema) {
            return Err("Routine source owner differs from comparison schema".into());
        }
        // Recovery source is the saved target definition, not the post-execution dictionary.
        // Current target definitions and global data dependencies are still checked below.
        if !endpoints.recovery {
            if status(
                state,
                &endpoints.source_connection_id,
                &endpoints.source_database,
                source_schema,
                &info.name,
                &info.function_type,
            )
            .await?
                != info.status
            {
                return Err("Routine source status changed; reload comparison".into());
            }
            let current = source(
                state,
                &endpoints.source_connection_id,
                &endpoints.source_database,
                source_schema,
                &info.name,
                &info.function_type,
            )
            .await?;
            if comparable_oracle_routine(&current) != comparable_oracle_routine(&info.definition) {
                return Err("Routine source changed; reload comparison".into());
            }
        }
        if !target_objects.iter().any(|target| target.name == info.name && target.function_type == info.function_type)
            && status(
                state,
                &endpoints.target_connection_id,
                &endpoints.target_database,
                target_schema,
                &info.name,
                &info.function_type,
            )
            .await?
            .is_some()
        {
            return Err("A target routine appeared after comparison; reload before replacement".into());
        }
        for dependency in info.dependency_objects.iter().filter(|dependency| dependency.object_type == "TYPE") {
            let owner = if dependency.owner == source_schema { target_schema } else { &dependency.owner };
            if status(
                state,
                &endpoints.target_connection_id,
                &endpoints.target_database,
                owner,
                &dependency.name,
                "TYPE",
            )
            .await?
            .as_deref()
                == Some("VALID")
            {
                let identity = (owner.to_string(), dependency.name.clone(), "TYPE".to_string());
                if !context.target_dependencies.contains(&identity) {
                    context.target_dependencies.push(identity);
                }
            }
        }
        if let Some(trigger) = &info.trigger {
            let owner = if trigger.table_owner == source_schema { target_schema } else { &trigger.table_owner };
            if status(
                state,
                &endpoints.target_connection_id,
                &endpoints.target_database,
                owner,
                &trigger.table_name,
                &trigger.base_object_type,
            )
            .await?
            .as_deref()
                == Some("VALID")
            {
                context.target_dependencies.push((
                    owner.to_string(),
                    trigger.table_name.clone(),
                    trigger.base_object_type.clone(),
                ));
            }
        }
    }
    for info in target_objects {
        if info.schema.as_deref() != Some(target_schema)
            || status(
                state,
                &endpoints.target_connection_id,
                &endpoints.target_database,
                target_schema,
                &info.name,
                &info.function_type,
            )
            .await?
                != info.status
        {
            return Err("Routine target owner/status changed; reload comparison".into());
        }
        let current = source(
            state,
            &endpoints.target_connection_id,
            &endpoints.target_database,
            target_schema,
            &info.name,
            &info.function_type,
        )
        .await?;
        if comparable_oracle_routine(&current) != comparable_oracle_routine(&info.definition) {
            return Err("Routine target source changed; reload comparison before replacing the saved definition".into());
        }
    }
    Ok(Some(context))
}

pub async fn prepare_schema_diff_core(
    state: &AppState,
    mut options: crate::schema_diff::SchemaDiffPreparationOptions,
) -> Result<crate::schema_diff::SchemaDiffPreparation, String> {
    let diffs = crate::schema_diff::diff_functions(&options.source_functions, &options.target_functions);
    let source = diffs.iter().filter_map(|diff| diff.source.clone()).collect::<Vec<_>>();
    let target = diffs.iter().filter_map(|diff| diff.target.clone()).collect::<Vec<_>>();
    let removed = diffs
        .iter()
        .filter(|diff| diff.diff_type == "removed")
        .filter_map(|diff| diff.target.clone())
        .collect::<Vec<_>>();
    options.routine_context = schema_diff_routine_context(
        state,
        options.routine_endpoints.as_ref(),
        options.source_database_type,
        options.database_type,
        options.source_schema.as_deref(),
        options.target_schema.as_deref(),
        &source,
        &removed,
        &target,
    )
    .await?;
    Ok(crate::schema_diff::prepare_schema_diff(options))
}
async fn status(
    state: &AppState,
    connection: &str,
    database: &str,
    schema: &str,
    name: &str,
    kind: &str,
) -> Result<Option<String>, String> {
    let result = dictionary_query(
        state,
        connection,
        database,
        schema,
        &format!(
            "SELECT STATUS FROM ALL_OBJECTS WHERE OWNER = {} AND OBJECT_NAME = {} AND OBJECT_TYPE = {}",
            literal(schema),
            literal(name),
            literal(kind)
        ),
    )
    .await?;
    Ok(result.rows.first().map(|row| cell(row, 0)))
}
async fn source(
    state: &AppState,
    connection: &str,
    database: &str,
    schema: &str,
    name: &str,
    kind: &str,
) -> Result<String, String> {
    let (_, source_kind) = schema_diff_routine_kind(kind).ok_or("Unsupported routine type")?;
    let source = get_object_source_core(state, connection, database, schema, name, source_kind, None, None).await?;
    if source.source.trim().is_empty() {
        return Err("Complete source is unavailable; comparison stopped".into());
    }
    Ok(source.source)
}
async fn trigger(
    state: &AppState,
    connection: &str,
    database: &str,
    schema: &str,
    name: &str,
) -> Result<db::RoutineTriggerInfo, String> {
    let result = dictionary_query(state, connection, database, schema, &format!("SELECT TABLE_OWNER, TABLE_NAME, TRIGGER_TYPE, TRIGGERING_EVENT, STATUS, BASE_OBJECT_TYPE FROM ALL_TRIGGERS WHERE OWNER = {} AND TRIGGER_NAME = {}", literal(schema), literal(name))).await?;
    if result.rows.len() != 1 {
        return Err("Trigger metadata disappeared or is ambiguous; comparison stopped".into());
    }
    let row = &result.rows[0];
    Ok(db::RoutineTriggerInfo {
        table_owner: cell(row, 0),
        table_name: cell(row, 1),
        timing: cell(row, 2),
        event: cell(row, 3),
        status: cell(row, 4),
        base_object_type: cell(row, 5),
    })
}
fn dependency_rows(rows: &[Vec<serde_json::Value>]) -> Result<Vec<db::RoutineDependency>, String> {
    rows.iter()
        .map(|row| {
            let dependency =
                db::RoutineDependency { owner: cell(row, 0), name: cell(row, 1), object_type: cell(row, 2) };
            if dependency.owner.is_empty() || dependency.name.is_empty() || dependency.object_type.is_empty() {
                return Err("Incomplete dependency metadata; comparison stopped".into());
            }
            Ok(dependency)
        })
        .collect()
}
pub(super) async fn list_routines(
    state: &AppState,
    connection: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::FunctionInfo>, String> {
    if schema.is_empty() {
        return Err("An explicit source or target schema is required for routine comparison".into());
    }
    // A failed inventory/source read must never become an absent object.
    let objects = dictionary_query(state, connection, database, schema, &format!("SELECT OBJECT_NAME, OBJECT_TYPE, STATUS FROM ALL_OBJECTS WHERE OWNER = {} AND OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY', 'TRIGGER') ORDER BY OBJECT_NAME, OBJECT_TYPE", literal(schema))).await?;
    let mut routines = Vec::with_capacity(objects.rows.len());
    for row in &objects.rows {
        let name = cell(row, 0);
        let kind = cell(row, 1);
        schema_diff_routine_kind(&kind).ok_or("Unexpected routine object type")?;
        let definition = source(state, connection, database, schema, &name, &kind)
            .await
            .map_err(|error| format!("Cannot read {schema}.{name} ({kind}): {error}"))?;
        let dependencies = dictionary_query(state, connection, database, schema, &format!("SELECT REFERENCED_OWNER, REFERENCED_NAME, REFERENCED_TYPE FROM ALL_DEPENDENCIES WHERE OWNER = {} AND NAME = {} AND TYPE = {} ORDER BY REFERENCED_OWNER, REFERENCED_NAME, REFERENCED_TYPE", literal(schema), literal(&name), literal(&kind))).await?;
        let dependency_objects = dependency_rows(&dependencies.rows)?;
        let incoming = dictionary_query(state, connection, database, schema, &format!("SELECT OWNER, NAME, TYPE FROM ALL_DEPENDENCIES WHERE REFERENCED_OWNER = {} AND REFERENCED_NAME = {} AND REFERENCED_TYPE = {} ORDER BY OWNER, NAME, TYPE", literal(schema), literal(&name), literal(&kind))).await?;
        let paired_kind = match kind.as_str() {
            "PACKAGE" => Some("PACKAGE BODY"),
            "PACKAGE BODY" => Some("PACKAGE"),
            _ => None,
        };
        let paired_object_present = paired_kind.map(|paired| {
            objects.rows.iter().any(|candidate| cell(candidate, 0) == name && cell(candidate, 1) == paired)
        });
        let trigger =
            if kind == "TRIGGER" { Some(trigger(state, connection, database, schema, &name).await?) } else { None };
        if status(state, connection, database, schema, &name, &kind).await?.as_deref() != Some(cell(row, 2).as_str()) {
            return Err(format!("{schema}.{name} ({kind}) changed during metadata collection"));
        }
        routines.push(db::FunctionInfo {
            name,
            function_type: kind,
            data_type: String::new(),
            definition,
            arguments: String::new(),
            schema: Some(schema.to_string()),
            status: Some(cell(row, 2)),
            dependencies: dependency_objects
                .iter()
                .map(|dependency| {
                    format!(
                        "\"{}\".\"{}\"",
                        dependency.owner.replace('"', "\"\""),
                        dependency.name.replace('"', "\"\"")
                    )
                })
                .collect(),
            dependency_objects,
            incoming_dependencies: dependency_rows(&incoming.rows)?,
            paired_object_present,
            trigger,
        });
    }
    Ok(routines)
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineValidation {
    pub name: String,
    pub schema: String,
    pub routine_type: String,
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<db::RoutineTriggerInfo>,
}
fn target_callers(expected: &[FunctionDiff], schema: &str) -> Vec<db::RoutineDependency> {
    let selected: Vec<_> = expected
        .iter()
        .filter_map(|diff| {
            let info = if diff.diff_type == "removed" { diff.target.as_ref() } else { diff.source.as_ref() }?;
            Some((schema.to_string(), diff.name.clone(), info.function_type.clone()))
        })
        .collect();
    let mut callers = Vec::new();
    for info in expected.iter().filter_map(|diff| diff.target.as_ref()) {
        for dependency in &info.incoming_dependencies {
            let mut caller = dependency.clone();
            if Some(caller.owner.as_str()) == info.schema.as_deref() {
                caller.owner = schema.to_string();
            }
            if !selected.contains(&(caller.owner.clone(), caller.name.clone(), caller.object_type.clone()))
                && !callers.contains(&caller)
            {
                callers.push(caller);
            }
        }
    }
    callers
}
pub async fn validate_schema_diff_routines(
    state: &AppState,
    connection: &str,
    database: &str,
    schema: &str,
    expected: &[FunctionDiff],
) -> Result<Vec<RoutineValidation>, String> {
    if schema.is_empty() {
        return Err("An explicit target schema is required".into());
    }
    let callers = target_callers(expected, schema);
    let mut results = Vec::with_capacity(expected.len());
    for diff in expected {
        let info = if diff.diff_type == "removed" { diff.target.as_ref() } else { diff.source.as_ref() }
            .ok_or("Routine metadata is missing")?;
        let (kind, _) = schema_diff_routine_kind(&info.function_type).ok_or("Unsupported routine type")?;
        let current_status = status(state, connection, database, schema, &diff.name, kind).await?;
        let expected_trigger = info.trigger.clone().map(|mut trigger| {
            if Some(trigger.table_owner.as_str()) == info.schema.as_deref() {
                trigger.table_owner = schema.to_string();
            }
            trigger
        });
        let actual_trigger = if kind == "TRIGGER" && current_status.is_some() {
            Some(trigger(state, connection, database, schema, &diff.name).await?)
        } else {
            None
        };
        let result = if diff.diff_type == "removed" {
            if current_status.is_none() {
                Ok(())
            } else {
                Err("The dropped routine still exists".into())
            }
        } else if current_status.as_deref() != Some("VALID") {
            let errors = dictionary_query(state, connection, database, schema, &format!("SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE OWNER = {} AND NAME = {} AND TYPE = {} ORDER BY SEQUENCE", literal(schema), literal(&diff.name), literal(kind))).await?;
            Err(format!(
                "Compilation status: {}. {}",
                current_status.as_deref().unwrap_or("MISSING"),
                errors.rows.iter().map(|row| cell(row, 2)).collect::<Vec<_>>().join("\n")
            ))
        } else if actual_trigger != expected_trigger {
            Err("Trigger table, timing, event or enabled state differs from the selected definition".into())
        } else {
            let actual = source(state, connection, database, schema, &diff.name, kind).await?;
            if comparable_oracle_routine(&actual) != comparable_oracle_routine(&info.definition) {
                Err("The complete source read back from the target differs from the selected definition".into())
            } else {
                Ok(())
            }
        };
        results.push(RoutineValidation {
            name: diff.name.clone(),
            schema: schema.to_string(),
            routine_type: kind.to_string(),
            success: result.is_ok(),
            message: result.err().unwrap_or_else(|| "Dictionary status and complete source verified".into()),
            trigger: expected_trigger,
        });
    }
    for caller in callers {
        let current_status =
            status(state, connection, database, &caller.owner, &caller.name, &caller.object_type).await?;
        results.push(RoutineValidation {
            name: caller.name.clone(),
            schema: caller.owner.clone(),
            routine_type: caller.object_type.clone(),
            success: current_status.as_deref() == Some("VALID"),
            message: format!(
                "Dependent object {}.{} ({}): {}",
                caller.owner,
                caller.name,
                caller.object_type,
                current_status.as_deref().unwrap_or("MISSING")
            ),
            trigger: None,
        });
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caller_readback_uses_target_inventory_and_keeps_owner_and_kind_identity() {
        let info: db::FunctionInfo = serde_json::from_value(serde_json::json!({
            "name": "p", "functionType": "PACKAGE", "dataType": "", "definition": "", "arguments": "",
            "schema": "TARGET", "incomingDependencies": [
                { "owner": "TARGET", "name": "p", "objectType": "PACKAGE BODY" },
                { "owner": "TARGET", "name": "caller", "objectType": "PROCEDURE" },
                { "owner": "OTHER", "name": "p", "objectType": "PACKAGE" }
            ]
        }))
        .unwrap();
        let body = db::FunctionInfo {
            function_type: "PACKAGE BODY".into(),
            incoming_dependencies: Vec::new(),
            ..info.clone()
        };
        let diffs = vec![
            FunctionDiff {
                name: "p".into(),
                diff_type: "modified".into(),
                source: Some(info.clone()),
                target: Some(info.clone()),
                changes: Vec::new(),
            },
            FunctionDiff {
                name: "p".into(),
                diff_type: "removed".into(),
                source: None,
                target: Some(body),
                changes: Vec::new(),
            },
        ];
        let callers = target_callers(&diffs, "TARGET");
        assert_eq!(callers.len(), 2);
        assert_eq!((&callers[0].owner, &callers[0].name), (&"TARGET".to_string(), &"caller".to_string()));
        assert_eq!((&callers[1].owner, &callers[1].object_type), (&"OTHER".to_string(), &"PACKAGE".to_string()));
        let added = FunctionDiff {
            name: "p".into(),
            diff_type: "added".into(),
            source: Some(info),
            target: None,
            changes: Vec::new(),
        };
        assert!(target_callers(&[added], "TARGET").is_empty());
    }
}
