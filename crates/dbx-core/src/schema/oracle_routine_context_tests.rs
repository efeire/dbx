use super::*;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;

// Agent RPC dictionaries exercise Core routing and preview drift checks.
// They do not establish compatibility with a real database engine.
struct Fixture {
    state: Arc<AppState>,
    _directory: tempfile::TempDir,
    _listener: tokio::net::TcpListener,
}

impl Fixture {
    async fn new(mode: Value) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            directory.path().join("plugins"),
            directory.path().join("agents"),
            "test",
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        for id in ["source", "target"] {
            let db_type = DatabaseType::OceanbaseOracle;
            let key = crate::database_capabilities::agent_key(&db_type, None).unwrap();
            let executable = state.agent_manager.driver_native_path(key);
            std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
            std::fs::write(&executable, include_str!("oracle_routine_context_fixture.py")).unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
            let config: ConnectionConfig = serde_json::from_value(json!({"id":id,"name":id,"db_type":db_type,"host":"127.0.0.1","port":listener.local_addr().unwrap().port(),"username":"fixture","password":"","database":"configured","connect_timeout_secs":2,"query_timeout_secs":2,"keepalive_interval_secs":0,"idle_timeout_secs":0})).unwrap();
            state.configs.write().await.insert(id.into(), config);
        }
        std::fs::write(state.agent_manager.base_dir().join("routine.json"), mode.to_string()).unwrap();
        Self { state, _directory: directory, _listener: listener }
    }

    async fn shutdown(self) {
        self.state.shutdown(Duration::from_secs(2)).await;
    }
}

fn routine(schema: &str, definition: &str) -> db::FunctionInfo {
    serde_json::from_value(json!({"name":"P","functionType":"PACKAGE","schema":schema,"definition":definition,"dataType":"","arguments":"","status":"VALID","pairedObjectPresent":false})).unwrap()
}

fn endpoints() -> crate::schema_diff::RoutineEndpoints {
    crate::schema_diff::RoutineEndpoints {
        recovery: false,
        source_connection_id: "source".into(),
        source_database: "configured".into(),
        target_connection_id: "target".into(),
        target_database: "configured".into(),
    }
}

const SPEC: &str = "CREATE OR REPLACE PACKAGE P AS PROCEDURE RUN; END;";

#[tokio::test]
async fn same_engine_package_preview_checks_source_status_and_definition() {
    for (mode, message) in [
        (json!({"source_status":"INVALID"}), "source status changed"),
        (json!({"routine_source":"CREATE PACKAGE P AS PROCEDURE CHANGED; END;"}), "source changed"),
    ] {
        let fixture = Fixture::new(mode).await;
        let error = schema_diff_routine_context(
            &fixture.state,
            Some(&endpoints()),
            Some(DatabaseType::OceanbaseOracle),
            DatabaseType::OceanbaseOracle,
            Some("SRC"),
            Some("DST"),
            &[routine("SRC", SPEC)],
            &[],
            &[],
        )
        .await
        .unwrap_err();
        assert!(error.contains(message), "{error}");
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn removed_only_package_preview_checks_saved_target_before_deletion() {
    for (mode, message) in [
        (json!({"target_status":"INVALID"}), "target owner/status changed"),
        (
            json!({"target_status":"VALID","routine_source":"CREATE PACKAGE P AS PROCEDURE CHANGED; END;"}),
            "target source changed",
        ),
    ] {
        let fixture = Fixture::new(mode).await;
        let target = routine("DST", SPEC);
        let error = schema_diff_routine_context(
            &fixture.state,
            Some(&endpoints()),
            Some(DatabaseType::OceanbaseOracle),
            DatabaseType::OceanbaseOracle,
            Some("SRC"),
            Some("DST"),
            &[],
            std::slice::from_ref(&target),
            std::slice::from_ref(&target),
        )
        .await
        .unwrap_err();
        assert!(error.contains(message), "{error}");
        fixture.shutdown().await;
    }
}
