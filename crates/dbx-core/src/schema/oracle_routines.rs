use super::*;
use crate::schema_diff::{comparable_oracle_routine, FunctionDiff};
use sqlparser::dialect::OracleDialect;
use sqlparser::tokenizer::{Token, Tokenizer};

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
        return Err("Routine compilation validation requires Oracle or OceanBase Oracle".to_string());
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

fn complete_dictionary_body(
    rows: &[Vec<serde_json::Value>],
    schema: &str,
    name: &str,
    kind: &str,
) -> Result<String, String> {
    let number = |value: &serde_json::Value| value.as_u64().or_else(|| value.as_str()?.parse().ok());
    if rows.is_empty() {
        return Err("Complete routine dictionary source is unavailable".into());
    }
    let mut body = String::new();
    for (index, row) in rows.iter().enumerate() {
        if row.len() != 6
            || cell(row, 0) != schema
            || cell(row, 1) != name
            || cell(row, 2) != kind
            || number(&row[3]) != Some(index as u64 + 1)
            || number(&row[5]) != Some(rows.len() as u64)
        {
            return Err("Routine dictionary source identity or line sequence is incomplete".into());
        }
        body.push_str(row[4].as_str().ok_or("Routine dictionary source text is unavailable")?);
    }
    let declaration = regex::Regex::new(r"(?is)^\s*(PROCEDURE|FUNCTION|PACKAGE\s+BODY|PACKAGE|TRIGGER)\b").unwrap();
    let actual_kind = declaration
        .captures(&body)
        .map(|matched| matched[1].split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_uppercase());
    if actual_kind.as_deref() != Some(kind) {
        return Err("Routine dictionary declaration and identity disagree".into());
    }
    let tokens = Tokenizer::new(&OracleDialect {}, &body)
        .tokenize()
        .map_err(|_| "Routine dictionary source cannot be tokenized")?;
    let mut code = tokens.iter().filter(|token| !matches!(token, Token::Whitespace(_))).collect::<Vec<_>>();
    if matches!(code.last(), Some(Token::SemiColon)) {
        code.pop();
    }
    let end = |token: &&Token| matches!(token, Token::Word(word) if word.quote_style.is_none() && word.value.eq_ignore_ascii_case("END"));
    let named_end = matches!(code.last(), Some(Token::Word(word)) if word.value == name || word.quote_style.is_none() && word.value.eq_ignore_ascii_case(name))
        && code.len() > 1
        && end(&code[code.len() - 2]);
    if !code.last().is_some_and(end) && !named_end {
        return Err("The complete dictionary routine has no outer END boundary".into());
    }
    let ddl = crate::object_source_sql::ensure_oracle_ddl_terminated(&format!("CREATE OR REPLACE {body}"));
    if crate::sql::split_sql_statements_for_database(&ddl, DatabaseType::Oracle).len() != 1 {
        return Err("Routine dictionary source contains multiple statements".into());
    }
    Ok(body)
}

async fn source(
    state: &AppState,
    connection: &str,
    database: &str,
    schema: &str,
    name: &str,
    kind: &str,
    signature: Option<&str>,
) -> Result<String, String> {
    let (_, source_kind) = schema_diff_routine_kind(kind).ok_or("Unsupported routine type")?;
    let original =
        get_object_source_core(state, connection, database, schema, name, source_kind, signature, None).await?.source;
    if !connection_config(state, connection).await.is_some_and(|config| config.db_type == DatabaseType::OceanbaseOracle)
        || original.trim_end().ends_with(';')
    {
        return Ok(original);
    }
    // OB may omit the final terminator in GET_DDL and ALL_SOURCE. Only a complete,
    // stable VALID dictionary object can supply the executable replacement.
    let identity_sql = format!("SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS'), STATUS FROM ALL_OBJECTS WHERE OWNER={} AND OBJECT_NAME={} AND OBJECT_TYPE={}", literal(schema), literal(name), literal(kind));
    let before = dictionary_query(state, connection, database, schema, &identity_sql).await?;
    if before.rows.len() != 1
        || before.rows[0].len() != 6
        || cell(&before.rows[0], 0) != schema
        || cell(&before.rows[0], 1) != name
        || cell(&before.rows[0], 2) != kind
        || before.rows[0][3].is_null()
        || cell(&before.rows[0], 4).is_empty()
    {
        return Err("Routine dictionary identity is missing or ambiguous".into());
    }
    if cell(&before.rows[0], 5) != "VALID" {
        return Ok(original);
    }
    let rows = dictionary_query(state, connection, database, schema, &format!("SELECT OWNER, NAME, TYPE, LINE, TEXT, COUNT(*) OVER () FROM ALL_SOURCE WHERE OWNER={} AND NAME={} AND TYPE={} ORDER BY LINE", literal(schema), literal(name), literal(kind))).await?;
    let body = complete_dictionary_body(&rows.rows, schema, name, kind)?;
    let errors = dictionary_query(
        state,
        connection,
        database,
        schema,
        &format!(
            "SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE OWNER={} AND NAME={} AND TYPE={} ORDER BY SEQUENCE",
            literal(schema),
            literal(name),
            literal(kind)
        ),
    )
    .await?;
    let after = dictionary_query(state, connection, database, schema, &identity_sql).await?;
    if before.rows != after.rows {
        return Err("Routine changed during complete source collection; reload comparison".into());
    }
    if !errors.rows.is_empty() {
        return Ok(original);
    }
    let edition = regex::Regex::new(r"(?is)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(NONEDITIONABLE|EDITIONABLE)\b")
        .unwrap()
        .captures(&original)
        .map(|matched| format!("{} ", matched[1].to_ascii_uppercase()))
        .unwrap_or_default();
    Ok(crate::object_source_sql::ensure_oracle_ddl_terminated(&format!("CREATE OR REPLACE {edition}{body}")))
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

pub(super) async fn list_routines(
    state: &AppState,
    connection: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::FunctionInfo>, String> {
    if schema.is_empty() {
        return Err("An explicit source or target schema is required for routine comparison".to_string());
    }
    let kinds = vec!["PROCEDURE".to_string(), "FUNCTION".to_string()];
    let objects = list_objects_core(state, connection, database, schema, None, None, None, Some(&kinds), None).await?;
    let mut routines = Vec::with_capacity(objects.len());
    for object in objects {
        let (kind, _) = schema_diff_routine_kind(&object.object_type).ok_or("Unexpected routine object type")?;
        let source = source(state, connection, database, schema, &object.name, kind, object.signature.as_deref())
            .await
            .map_err(|error| format!("Cannot read {schema}.{} ({kind}): {error}", object.name))?;
        if source.trim().is_empty() {
            return Err(format!(
                "Complete source is unavailable for {schema}.{} ({kind}); comparison stopped",
                object.name
            ));
        }
        let object_status = status(state, connection, database, schema, &object.name, kind)
            .await?
            .ok_or_else(|| format!("{schema}.{} disappeared during metadata collection", object.name))?;
        let dependencies = dictionary_query(state, connection, database, schema, &format!("SELECT REFERENCED_OWNER, REFERENCED_NAME FROM ALL_DEPENDENCIES WHERE OWNER = {} AND NAME = {} AND TYPE = {} ORDER BY REFERENCED_OWNER, REFERENCED_NAME", literal(schema), literal(&object.name), literal(kind))).await?;
        let dependencies = dependencies
            .rows
            .iter()
            .map(|row| format!("\"{}\".\"{}\"", cell(row, 0).replace('"', "\"\""), cell(row, 1).replace('"', "\"\"")))
            .collect();
        routines.push(db::FunctionInfo {
            name: object.name,
            function_type: kind.to_string(),
            data_type: String::new(),
            definition: source,
            arguments: object.signature.unwrap_or_default(),
            schema: Some(schema.to_string()),
            status: Some(object_status),
            dependencies,
        });
    }
    Ok(routines)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineValidation {
    pub name: String,
    pub routine_type: String,
    pub success: bool,
    pub message: String,
}

pub async fn validate_schema_diff_routines(
    state: &AppState,
    connection: &str,
    database: &str,
    schema: &str,
    expected: &[FunctionDiff],
    preflight: bool,
) -> Result<Vec<RoutineValidation>, String> {
    if schema.is_empty() {
        return Err("An explicit target schema is required".to_string());
    }
    let mut results = Vec::with_capacity(expected.len());
    for diff in expected {
        let info = if diff.diff_type == "removed" { diff.target.as_ref() } else { diff.source.as_ref() }
            .ok_or("Routine metadata is missing")?;
        let (kind, _) = schema_diff_routine_kind(&info.function_type).ok_or("Unsupported routine type")?;
        let current_status = status(state, connection, database, schema, &diff.name, kind).await?;
        if preflight {
            if let Some(previous) = &diff.target {
                if previous.schema.as_deref() != Some(schema) || current_status != previous.status {
                    return Err("Routine target owner/status changed; reload comparison".into());
                }
                let actual = source(state, connection, database, schema, &diff.name, kind, None).await?;
                let dependencies = dictionary_query(state, connection, database, schema, &format!("SELECT REFERENCED_OWNER, REFERENCED_NAME FROM ALL_DEPENDENCIES WHERE OWNER = {} AND NAME = {} AND TYPE = {} ORDER BY REFERENCED_OWNER, REFERENCED_NAME", literal(schema), literal(&diff.name), literal(kind))).await?;
                let current: Vec<_> = dependencies
                    .rows
                    .iter()
                    .map(|row| {
                        format!("\"{}\".\"{}\"", cell(row, 0).replace('"', "\"\""), cell(row, 1).replace('"', "\"\""))
                    })
                    .collect();
                ensure_saved_source(previous, &actual, &current)?;
            } else if current_status.is_some() {
                return Err("Routine target appeared after comparison; reload comparison".into());
            }
            if diff.diff_type == "removed" {
                // ALL_DEPENDENCIES can hide callers outside the account's visibility.
                let callers = dictionary_query(state, connection, database, schema, &format!("SELECT OWNER, NAME, TYPE FROM DBA_DEPENDENCIES WHERE REFERENCED_OWNER = {} AND REFERENCED_NAME = {} AND REFERENCED_TYPE = {} ORDER BY OWNER, NAME, TYPE", literal(schema), literal(&diff.name), literal(kind))).await
                    .map_err(|error| format!("Cannot confirm complete incoming dependencies; deletion blocked: {error}"))?;
                ensure_selected_callers(&callers.rows, schema, expected)?;
            }
            results.push(RoutineValidation {
                name: diff.name.clone(),
                routine_type: kind.to_string(),
                success: true,
                message: "Saved target snapshot and incoming dependencies verified".into(),
            });
            continue;
        }
        let result = if diff.diff_type == "removed" {
            if current_status.is_none() {
                Ok(())
            } else {
                Err("The dropped routine still exists".to_string())
            }
        } else if current_status.as_deref() != Some("VALID") {
            let errors = dictionary_query(state, connection, database, schema, &format!("SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE OWNER = {} AND NAME = {} AND TYPE = {} ORDER BY SEQUENCE", literal(schema), literal(&diff.name), literal(kind))).await?;
            Err(format!(
                "Compilation status: {}. {}",
                current_status.as_deref().unwrap_or("MISSING"),
                errors.rows.iter().map(|row| cell(row, 2)).collect::<Vec<_>>().join("\n")
            ))
        } else {
            let actual = source(state, connection, database, schema, &diff.name, kind, None).await?;
            if actual.trim().is_empty()
                || comparable_oracle_routine(&actual) != comparable_oracle_routine(&info.definition)
            {
                Err("The complete source read back from the target differs from the selected definition".to_string())
            } else {
                Ok(())
            }
        };
        results.push(RoutineValidation {
            name: diff.name.clone(),
            routine_type: kind.to_string(),
            success: result.is_ok(),
            message: result.err().unwrap_or_else(|| "Dictionary status and complete source verified".to_string()),
        });
    }
    Ok(results)
}

fn ensure_saved_source(previous: &db::FunctionInfo, actual: &str, dependencies: &[String]) -> Result<(), String> {
    if actual.trim().is_empty() || comparable_oracle_routine(actual) != comparable_oracle_routine(&previous.definition)
    {
        return Err("Routine target source changed; reload comparison".into());
    }
    if dependencies != previous.dependencies.as_slice() {
        return Err("Routine target dependencies changed; reload comparison".into());
    }
    Ok(())
}

fn ensure_selected_callers(
    rows: &[Vec<serde_json::Value>],
    schema: &str,
    expected: &[FunctionDiff],
) -> Result<(), String> {
    for row in rows {
        let owner = cell(row, 0);
        let name = cell(row, 1);
        let kind = cell(row, 2);
        if owner != schema
            || !expected.iter().any(|diff| {
                diff.diff_type == "removed"
                    && diff.name == name
                    && diff
                        .target
                        .as_ref()
                        .is_some_and(|info| info.schema.as_deref() == Some(schema) && info.function_type == kind)
            })
        {
            return Err(format!("Deletion would invalidate retained caller {owner}.{name} ({kind}); reload and select a complete removal plan"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_ob_dictionary_rows_preserve_body_and_reject_missing_identity_lines_or_multiple_statements() {
        let text = "FUNCTION \"F Mixed\" RETURN NUMBER IS BEGIN RETURN 42; END";
        let rows = vec![vec![
            serde_json::json!("Mixed Owner"),
            serde_json::json!("F Mixed"),
            serde_json::json!("FUNCTION"),
            serde_json::json!(1),
            serde_json::json!(text),
            serde_json::json!(1),
        ]];
        assert_eq!(complete_dictionary_body(&rows, "Mixed Owner", "F Mixed", "FUNCTION").unwrap(), text);
        assert!(complete_dictionary_body(&rows, "OTHER", "F Mixed", "FUNCTION").is_err());
        assert!(complete_dictionary_body(&rows, "Mixed Owner", "OTHER", "FUNCTION").is_err());
        assert!(complete_dictionary_body(&rows, "Mixed Owner", "F Mixed", "PROCEDURE").is_err());
        for (index, value) in [
            (3, serde_json::json!(2)),
            (5, serde_json::json!(2)),
            (4, serde_json::Value::Null),
            (4, serde_json::json!("FUNCTION F RETURN NUMBER IS BEGIN RETURN 42;")),
            (4, serde_json::json!("FUNCTION F RETURN NUMBER IS BEGIN RETURN 42; -- END")),
            (4, serde_json::json!("FUNCTION F RETURN VARCHAR2 IS BEGIN RETURN 'END'")),
            (4, serde_json::json!("FUNCTION F RETURN NUMBER IS BEGIN RETURN 42; END; DROP TABLE T;")),
        ] {
            let mut invalid = rows.clone();
            invalid[0][index] = value;
            assert!(complete_dictionary_body(&invalid, "Mixed Owner", "F Mixed", "FUNCTION").is_err());
        }
        assert!(complete_dictionary_body(&[], "Mixed Owner", "F Mixed", "FUNCTION").is_err());
    }

    #[test]
    fn preflight_rejects_changed_or_empty_target_source_and_changed_dependencies() {
        let previous: db::FunctionInfo = serde_json::from_value(serde_json::json!({
            "name": "P", "functionType": "PROCEDURE", "dataType": "", "arguments": "", "definition": "CREATE PROCEDURE DST.P AS BEGIN NULL; END;", "schema": "DST", "status": "VALID", "dependencies": []
        })).unwrap();
        assert!(ensure_saved_source(&previous, &previous.definition, &[]).is_ok());
        assert!(ensure_saved_source(&previous, "", &[]).is_err());
        assert!(ensure_saved_source(&previous, "CREATE PROCEDURE DST.P AS BEGIN NEW_CALL; END;", &[]).is_err());
        assert!(ensure_saved_source(&previous, &previous.definition, &["\"DST\".\"Q\"".into()]).is_err());
    }

    #[test]
    fn removal_requires_all_incoming_callers_to_be_selected_for_removal() {
        let caller = vec![serde_json::json!("DST"), serde_json::json!("Q"), serde_json::json!("PROCEDURE")];
        let selected: FunctionDiff = serde_json::from_value(serde_json::json!({
            "type": "removed", "name": "Q", "target": {
                "name": "Q", "functionType": "PROCEDURE", "dataType": "", "arguments": "", "definition": "CREATE PROCEDURE Q AS BEGIN NULL; END;", "schema": "DST"
            }
        })).unwrap();
        assert!(ensure_selected_callers(&[caller.clone()], "DST", &[]).is_err());
        assert!(ensure_selected_callers(&[caller.clone()], "DST", &[selected.clone()]).is_ok());
        let mut retained = selected.clone();
        retained.diff_type = "modified".into();
        assert!(ensure_selected_callers(&[caller.clone()], "DST", &[retained]).is_err());
        let external = vec![serde_json::json!("OTHER"), serde_json::json!("Q"), serde_json::json!("PROCEDURE")];
        assert!(ensure_selected_callers(&[external], "DST", &[selected]).is_err());
    }
}
