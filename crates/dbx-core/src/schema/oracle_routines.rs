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
            type_info: None,
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
    let kinds = vec!["TYPE".to_string(), "TYPE_BODY".to_string()];
    let types = list_objects_core(state, connection, database, schema, None, None, None, Some(&kinds), None).await?;
    for object in types {
        if object.schema.as_deref() != Some(schema) {
            return Err("Type inventory owner differs from the selected schema".into());
        }
        let (kind, _) = schema_diff_routine_kind(&object.object_type).ok_or("Unexpected type inventory kind")?;
        let details = oracle_types::get_oracle_type_details_core(state, connection, database, schema, &object.name, &object.object_type).await?;
        let definition = source(state, connection, database, schema, &object.name, kind).await?;
        let incoming = dictionary_query(state, connection, database, schema, &format!("SELECT OWNER, NAME, TYPE FROM ALL_DEPENDENCIES WHERE REFERENCED_OWNER = {} AND REFERENCED_NAME = {} AND REFERENCED_TYPE = {} ORDER BY OWNER, NAME, TYPE", literal(schema), literal(&object.name), literal(kind))).await?;
        let incoming_dependencies = dependency_rows(&incoming.rows)?;
        let columns = if kind == "TYPE" {
            dictionary_query(state, connection, database, schema, &format!("SELECT OWNER, TABLE_NAME, COLUMN_NAME FROM ALL_TAB_COLUMNS WHERE DATA_TYPE_OWNER = {} AND DATA_TYPE = {} ORDER BY OWNER, TABLE_NAME, COLUMN_ID", literal(schema), literal(&object.name))).await?.rows
        } else { Vec::new() };
        let referenced_columns = columns.iter().map(|row| {
            let column = db::RoutineColumnDependency { owner: cell(row, 0), table_name: cell(row, 1), column_name: cell(row, 2) };
            if column.owner.is_empty() || column.table_name.is_empty() || column.column_name.is_empty() { return Err("Incomplete type column dependency metadata".to_string()); }
            Ok(column)
        }).collect::<Result<Vec<_>, _>>()?;
        let mut dependency_state = details.dependencies.state.clone();
        let mut metadata_message = details.dependencies.message.clone();
        let mut dependency_objects = Vec::new();
        for dependency in details.dependencies.rows {
            if dependency.referenced_schema.as_deref().is_none_or(str::is_empty) || dependency.referenced_link.is_some() {
                dependency_state = oracle_types::OracleMetadataReadState::Unknown;
                let message = format!("Type dependency {}.{} ({}) via {} cannot be mapped automatically", dependency.referenced_schema.as_deref().unwrap_or("UNKNOWN"), dependency.referenced_name, dependency.referenced_type, dependency.referenced_link.as_deref().unwrap_or("unknown owner"));
                metadata_message = Some(match metadata_message { Some(previous) => format!("{previous}\n{message}"), None => message });
                continue;
            }
            dependency_objects.push(db::RoutineDependency { owner: dependency.referenced_schema.unwrap(), name: dependency.referenced_name, object_type: dependency.referenced_type.replace('_', " ") });
        }
        let paired_object_present = match &details.pairing_state {
            oracle_types::OracleMetadataReadState::Available => Some(details.paired_object.is_some()),
            oracle_types::OracleMetadataReadState::Empty => Some(false),
            _ => None,
        };
        let incoming_state = if incoming_dependencies.is_empty() && referenced_columns.is_empty() { oracle_types::OracleMetadataReadState::Empty } else { oracle_types::OracleMetadataReadState::Available };
        if status(state, connection, database, schema, &object.name, kind).await? != details.status {
            return Err(format!("{schema}.{} ({kind}) changed during type metadata collection", object.name));
        }
        routines.push(db::FunctionInfo {
            name: object.name, function_type: kind.to_string(), data_type: String::new(), definition, arguments: String::new(), schema: Some(schema.to_string()), status: details.status,
            dependencies: dependency_objects.iter().map(|dependency| format!("\"{}\".\"{}\"", dependency.owner.replace('"', "\"\""), dependency.name.replace('"', "\"\""))).collect(),
            dependency_objects, incoming_dependencies, paired_object_present, trigger: None,
            type_info: Some(db::RoutineTypeInfo { pairing_state: details.pairing_state, dependency_state, incoming_state, referenced_columns, metadata_message }),
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
    let selected: Vec<_> = expected.iter().filter_map(|diff| {
        let info = if diff.diff_type == "removed" { diff.target.as_ref() } else { diff.source.as_ref() }?;
        Some((schema.to_string(), diff.name.clone(), info.function_type.clone()))
    }).collect();
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
        let current_status = status(state, connection, database, &caller.owner, &caller.name, &caller.object_type).await?;
        results.push(RoutineValidation {
            name: caller.name.clone(),
            schema: caller.owner.clone(),
            routine_type: caller.object_type.clone(),
            success: current_status.as_deref() == Some("VALID"),
            message: format!("Dependent object {}.{} ({}): {}", caller.owner, caller.name, caller.object_type, current_status.as_deref().unwrap_or("MISSING")),
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
        })).unwrap();
        let body = db::FunctionInfo { function_type: "PACKAGE BODY".into(), incoming_dependencies: Vec::new(), ..info.clone() };
        let diffs = vec![
            FunctionDiff { name: "p".into(), diff_type: "modified".into(), source: Some(info.clone()), target: Some(info.clone()), changes: Vec::new() },
            FunctionDiff { name: "p".into(), diff_type: "removed".into(), source: None, target: Some(body), changes: Vec::new() },
        ];
        let callers = target_callers(&diffs, "TARGET");
        assert_eq!(callers.len(), 2);
        assert_eq!((&callers[0].owner, &callers[0].name), (&"TARGET".to_string(), &"caller".to_string()));
        assert_eq!((&callers[1].owner, &callers[1].object_type), (&"OTHER".to_string(), &"PACKAGE".to_string()));
        let added = FunctionDiff { name: "p".into(), diff_type: "added".into(), source: Some(info), target: None, changes: Vec::new() };
        assert!(target_callers(&[added], "TARGET").is_empty());
    }
}
