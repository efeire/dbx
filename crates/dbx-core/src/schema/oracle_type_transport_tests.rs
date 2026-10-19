use super::{get_custom_type_details_core, AppState, ConnectionConfig, DatabaseType, PoolKind};
use crate::db::agent_driver::{AgentDriverClient, AgentLaunchSpec, AgentRuntimeClient};
use serde_json::{json, Value};
#[cfg(unix)]
use std::sync::Arc;
use std::time::Duration;

// Both real transports reach the same external query boundary. Any use of an
// unsupported getCustomTypeDetails/get_custom_type_details RPC is an error.
const SCRIPT: &str = r#"#!/usr/bin/env python3
import json, pathlib, sys
oceanbase = 'oceanbase' in pathlib.Path(__file__).stem
if '--agent' in sys.argv or pathlib.Path(__file__).name in ('agent', 'agent.exe'):
    print(json.dumps({'ready': True}), flush=True)
def query(sql):
    if 'FROM ALL_OBJECTS ' in sql:
        return ['OWNER', 'OBJECT_NAME', 'OBJECT_TYPE', 'STATUS'], [['APP', 'Mixed Type', 'TYPE', 'VALID']]
    if 'FROM ALL_TYPES ' in sql:
        return ['OWNER', 'TYPE_NAME', 'TYPECODE', 'ATTRIBUTES', 'METHODS', 'FINAL', 'INSTANTIABLE', 'SUPERTYPE_OWNER', 'SUPERTYPE_NAME'], [['APP', 'Mixed Type', 'OBJECT', 2 if oceanbase else 0, 1 if oceanbase else 0, 'YES', 'YES', None, None]]
    if 'FROM ALL_TYPE_ATTRS ' in sql:
        if oceanbase:
            return ['OWNER', 'TYPE_NAME', 'ATTR_NAME', 'ATTR_NO', 'ATTR_TYPE_OWNER', 'ATTR_TYPE_NAME', 'LENGTH', 'NUMBER_PRECISION', 'SCALE'], [['APP', 'Mixed Type', 'ID', 1, None, 'NUMBER', -1, -1, -85], ['APP', 'Mixed Type', 'LABEL', 2, None, 'VARCHAR2', 40, 2, -1]]
        return ['OWNER', 'TYPE_NAME', 'ATTR_NAME', 'ATTR_NO', 'ATTR_TYPE_OWNER', 'ATTR_TYPE_NAME', 'LENGTH', 'PRECISION', 'SCALE'], []
    if 'FROM ALL_TYPE_METHODS ' in sql:
        return ['OWNER', 'TYPE_NAME', 'METHOD_NAME', 'METHOD_NO', 'METHOD_TYPE', 'PARAMETERS', 'RESULTS'], []
    if 'FROM ALL_COLL_TYPES ' in sql:
        return ['OWNER', 'TYPE_NAME', 'COLL_TYPE', 'ELEM_TYPE_OWNER', 'ELEM_TYPE_NAME', 'LENGTH', 'PRECISION', 'SCALE'], []
    raise Exception('unexpected query')
for line in sys.stdin:
    request = json.loads(line)
    method, params = request['method'], request.get('params', {})
    with pathlib.Path(__file__).with_name('calls.jsonl').open('a') as log:
        log.write(json.dumps(request) + '\n')
    if method == 'handshake':
        result = {'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['multi_session']}
    elif method in ('execute_query', 'executeQuery'):
        if 'FROM all_objects ' in params['sql']:
            rows = [['Mixed Type', 'TYPE', params['schema']], ['Mixed Type', 'TYPE_BODY', params['schema']]]
            offset = params.get('rowOffset', 0)
            result = {'columns': ['OBJECT_NAME', 'OBJECT_TYPE', 'OWNER'], 'rows': rows[offset:offset+1], 'truncated': offset == 0, 'affected_rows': 0, 'execution_time_ms': 0}
        else:
            columns, rows = query(params['sql'])
            result = {'columns': columns, 'rows': rows, 'affected_rows': 0, 'execution_time_ms': 0}
    elif method == 'list_objects':
        result = [{'name': 'Mixed Type', 'object_type': kind, 'schema': params['schema']} for kind in ('TYPE', 'TYPE_BODY')]
        if params.get('object_types'):
            result = [row for row in result if row['object_type'] in params['object_types']]
        offset, limit = params.get('offset', 0), params.get('limit', 0)
        result = result[offset:offset+limit] if limit else result[offset:]
    elif method in ('open_session', 'connect', 'close_session', 'close', 'disconnect', 'ping'):
        result = {}
    else:
        print(json.dumps({'id': request['id'], 'error': {'code': -1, 'message': 'unsupported fixture RPC: ' + method}}), flush=True)
        continue
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
"#;

async fn state(dir: &std::path::Path) -> AppState {
    AppState::new(crate::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap())
}

fn config(db_type: DatabaseType) -> ConnectionConfig {
    serde_json::from_value(json!({
        "id": "type-transport", "name": "Type transport test", "db_type": db_type,
        "host": "127.0.0.1", "port": 1521, "username": "fixture", "password": "",
        "database": "app", "query_timeout_secs": 2, "keepalive_interval_secs": 0,
        "connection_string": "jdbc:oracle:thin:@127.0.0.1:1521/app"
    }))
    .unwrap()
}

fn assert_queries(dir: &std::path::Path, method: &str) {
    let requests: Vec<Value> = std::fs::read_to_string(dir.join("calls.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(requests.iter().all(|request| !matches!(
        request["method"].as_str(),
        Some("getCustomTypeDetails" | "get_custom_type_details")
    )));
    let queries: Vec<_> = requests.iter().filter(|request| request["method"] == method).collect();
    assert_eq!(queries.len(), 5);
    for query in queries {
        assert_eq!(query["params"]["database"], "app");
        assert!(query["params"].get("schema").is_none(), "dictionary reads must not request a session schema switch");
        assert!(query["params"]["sql"].as_str().unwrap().contains("= 'Mixed Type'"));
    }
}

fn assert_dictionary_details(details: crate::db::CustomTypeDetails) {
    use crate::db::TypeMetadataState;
    assert_eq!(details.name, "Mixed Type");
    assert_eq!(details.schema, "APP");
    assert_eq!(details.kind, crate::db::CustomTypeKind::Object);
    assert!(details.ddl.is_none());
    let metadata = details.oracle_metadata.unwrap();
    assert_eq!(metadata.body_visible, Some(false));
    assert_eq!(metadata.attribute_count, Some(0));
    assert_eq!(metadata.method_count, Some(0));
    for section in [
        metadata.properties_read,
        metadata.body_read,
        metadata.attributes_read,
        metadata.methods_read,
        metadata.collection_read,
    ] {
        assert_eq!(section.state, TypeMetadataState::Available);
        assert!(section.reason.is_none());
    }
    assert!(metadata.attributes.is_empty() && metadata.methods.is_empty() && metadata.collection.is_none());
}

#[tokio::test]
async fn agent_type_details_use_existing_query_rpc_before_the_pg_details_rpc() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("type-agent.py");
    std::fs::write(&script, SCRIPT).unwrap();
    let python = if cfg!(windows) { "python" } else { "python3" };
    let runtime = AgentRuntimeClient::spawn(
        AgentLaunchSpec::new(python).with_args([script.to_string_lossy().to_string(), "--agent".to_string()]),
        "test",
    )
    .await
    .unwrap();
    runtime.increment_session_count();
    let state = state(dir.path()).await;
    let config = config(DatabaseType::Oracle);
    state.configs.write().await.insert(config.id.clone(), config);
    state
        .update_connection_pools(|pools| {
            pools.insert(
                "type-transport:role:metadata".into(),
                PoolKind::agent(AgentDriverClient::shared_session(runtime.clone(), "metadata-session".into())),
            );
        })
        .await;
    let details = get_custom_type_details_core(&state, "type-transport", "app", "APP", "Mixed Type").await.unwrap();
    assert_dictionary_details(details);
    assert_queries(dir.path(), "execute_query");
    state.shutdown(Duration::from_secs(2)).await;
    runtime.kill();
}

#[cfg(unix)]
#[tokio::test]
async fn legacy_oracle_type_lists_use_server_paging_and_full_schema_reads_do_not_drop_later_types() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let storage = crate::persistence::test_storage::open(&dir.path().join("storage.db")).await.unwrap();
    let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        dir.path().join("agents"),
        "test",
    );
    let script = state.agent_manager.driver_native_path("oracle");
    std::fs::create_dir_all(script.parent().unwrap()).unwrap();
    std::fs::write(&script, SCRIPT).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = config(DatabaseType::Oracle);
    config.port = listener.local_addr().unwrap().port();
    config.driver_profile = Some("oracle-legacy".into());
    state.configs.write().await.insert(config.id.clone(), config);
    let kinds = ["TYPE".to_string(), "TYPE_BODY".to_string()];
    let schema = " Exact O'wner ";
    let page = super::list_objects_core(
        &state,
        "type-transport",
        "app",
        schema,
        Some("Mixed"),
        Some(1),
        Some(1),
        Some(&kinds),
        None,
    )
    .await
    .unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].object_type, "TYPE_BODY");
    assert_eq!(page[0].schema.as_deref(), Some(schema));
    let all =
        super::list_objects_core(&state, "type-transport", "app", schema, None, None, None, None, None).await.unwrap();
    assert_eq!(all.iter().map(|object| object.object_type.as_str()).collect::<Vec<_>>(), ["TYPE", "TYPE_BODY"]);
    let calls: Vec<Value> = std::fs::read_to_string(script.with_file_name("calls.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let typed = calls.iter().find(|call| call["method"] == "list_objects").unwrap();
    assert_eq!(typed["params"]["schema"], schema);
    assert_eq!(typed["params"]["limit"], 1);
    assert_eq!(typed["params"]["offset"], 1);
    assert_eq!(typed["params"]["filter"], "Mixed");
    let queries: Vec<_> = calls.iter().filter(|call| call["method"] == "execute_query").collect();
    assert_eq!(queries.len(), 2);
    assert_eq!(queries[0]["params"]["rowOffset"], 0);
    assert_eq!(queries[1]["params"]["rowOffset"], 1);
    assert!(queries[0]["params"]["sql"]
        .as_str()
        .unwrap()
        .contains("owner = ' Exact O''wner ' AND object_type IN ('TYPE', 'TYPE BODY')"));
    state.shutdown(Duration::from_secs(2)).await;
}

#[cfg(unix)]
#[tokio::test]
async fn external_driver_type_details_return_the_same_dictionary_result_via_execute_query() {
    use crate::plugins::{
        InstalledPlugin, PluginCompatibility, PluginDriverManifest, PluginDriverSession, PluginManifest,
        PluginRuntimeEnv,
    };
    use std::os::unix::fs::PermissionsExt;
    for oceanbase in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let executable = if oceanbase { "type-plugin-oceanbase.py" } else { "type-plugin.py" };
        let script = dir.path().join(executable);
        std::fs::write(&script, SCRIPT).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let plugin = InstalledPlugin {
            manifest: PluginManifest {
                id: "jdbc".into(),
                name: "JDBC".into(),
                version: "test".into(),
                protocol_version: 1,
                executable: Some(executable.into()),
                drivers: vec![PluginDriverManifest {
                    id: "jdbc".into(),
                    label: "JDBC".into(),
                    kind: "external".into(),
                    database_type: Some("jdbc".into()),
                }],
                ..PluginManifest::default()
            },
            path: dir.path().to_path_buf(),
            compatibility: PluginCompatibility {
                compatible: true,
                backend_executable: Some(script),
                ..PluginCompatibility::default()
            },
            provenance: None,
        };
        let session = Arc::new(
            PluginDriverSession::start_for_test(plugin, "jdbc".into(), PluginRuntimeEnv::default()).await.unwrap(),
        );
        let state = state(dir.path()).await;
        let mut config = config(DatabaseType::Jdbc);
        if oceanbase {
            config.connection_string = Some(" JDBC:OceanBase:Oracle://127.0.0.1:2881/app ".into());
            config.jdbc_driver_class = Some("com.oceanbase.jdbc.Driver".into());
        }
        state.configs.write().await.insert(config.id.clone(), config.clone());
        state
            .update_connection_pools(|pools| {
                pools.insert(
                    config.id.clone(),
                    PoolKind::ExternalDriver { driver_id: "jdbc".into(), config: Arc::new(config), session },
                );
            })
            .await;
        let details = get_custom_type_details_core(&state, "type-transport", "app", "APP", "Mixed Type").await.unwrap();
        if oceanbase {
            let metadata = details.oracle_metadata.unwrap();
            assert_eq!(metadata.attribute_count, Some(2));
            assert_eq!(metadata.attributes.len(), 2);
            assert_eq!(metadata.attributes[0].length, None);
            assert_eq!(metadata.attributes[0].precision, None);
            assert_eq!(metadata.attributes[0].scale, None);
            assert_eq!(metadata.attributes[1].length, Some(40));
            assert_eq!(metadata.attributes[1].precision, None);
            assert_eq!(metadata.attributes[1].scale, None);
            assert_eq!(metadata.methods_read.state, crate::db::TypeMetadataState::Incomplete);
        } else {
            assert_dictionary_details(details);
        }
        assert_queries(dir.path(), "executeQuery");
        state.shutdown(Duration::from_secs(2)).await;
    }
}
