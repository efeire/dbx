package com.dbx.agent;

import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import java.io.InputStream;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.CallableStatement;
import java.sql.Savepoint;
import java.sql.SQLTimeoutException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class BlobBoundExecutorTest {
    private static final String PREVIEW = "UPDATE t SET b=HEXTORAW('00ff80')";
    private static final String SQL = "BEGIN UPDATE t SET b=? WHERE DBMS_LOB.COMPARE(b,?)=0; END;";
    private static BlobBoundStatement bound() { return new BlobBoundStatement(PREVIEW, SQL, Arrays.asList("00ff80", "cafe")); }

    @Test void bindsStreamsOnFixedCallableSqlAndClosesThemBeforeCommit() throws Exception {
        Fake jdbc = new Fake();
        QueryResult result = run(jdbc, Arrays.asList(bound()), true);
        assertEquals(SQL, jdbc.preparedSql);
        assertEquals(Arrays.asList("00ff80", "cafe"), jdbc.boundHex);
        assertEquals(Arrays.asList(3L, 2L), jdbc.lengths);
        assertEquals(7, jdbc.timeout);
        assertEquals(1, jdbc.closedStatements);
        assertTrue(jdbc.events.indexOf("close") < jdbc.events.indexOf("commit"));
        assertEquals(1, jdbc.commits);
        assertEquals(0, jdbc.rollbacks);
        assertTrue(jdbc.autoCommit);
        assertEquals(1, result.getAffected_rows());
        for (InputStream stream : jdbc.streams) assertThrows(java.io.IOException.class, stream::read);
    }

    @Test void timeoutRollsBackClosesStreamsAndNeverFallsBackToText() throws Exception {
        Fake jdbc = new Fake(); jdbc.fail = true;
        RuntimeException failure = assertThrows(RuntimeException.class, () -> run(jdbc, Arrays.asList(bound()), true));
        assertInstanceOf(SQLTimeoutException.class, failure.getCause());
        assertEquals(1, jdbc.executions); assertEquals(1, jdbc.rollbacks); assertEquals(0, jdbc.commits);
        assertEquals(1, jdbc.closedStatements); assertTrue(jdbc.autoCommit);
        for (InputStream stream : jdbc.streams) assertThrows(java.io.IOException.class, stream::read);
    }

    @Test void manualFailureRollsBackOnlyBatchSavepoint() {
        Fake jdbc = new Fake(); jdbc.autoCommit = false; jdbc.fail = true;
        assertThrows(RuntimeException.class, () -> run(jdbc, Arrays.asList(bound()), false));
        assertEquals(1, jdbc.savepointRollbacks); assertEquals(0, jdbc.rollbacks);
        assertEquals(0, jdbc.commits); assertFalse(jdbc.autoCommit); assertEquals(1, jdbc.releases);
    }

    @Test void manualSuccessDoesNotCommitOrChangeAutoCommit() {
        Fake jdbc = new Fake(); jdbc.autoCommit = false;
        run(jdbc, Arrays.asList(bound()), false);
        assertEquals(1, jdbc.savepoints); assertEquals(1, jdbc.releases);
        assertEquals(0, jdbc.commits); assertEquals(0, jdbc.rollbacks); assertFalse(jdbc.autoCommit);
    }

    @Test void laterManualConflictRollsBackFirstWriteButPreservesPriorTransactionWork() {
        Fake jdbc = new Fake(); jdbc.autoCommit=false; jdbc.failAt=2;
        assertThrows(RuntimeException.class, () -> run(jdbc, Arrays.asList(bound(),bound()), false));
        assertEquals(2,jdbc.executions); assertEquals(42,jdbc.value);
        assertEquals(1,jdbc.savepointRollbacks); assertEquals(0,jdbc.rollbacks);
        assertEquals(0,jdbc.commits); assertFalse(jdbc.autoCommit);
    }

    @Test void failedManualRollbackQuarantinesConnectionWithUnknownOutcome() {
        Fake jdbc = new Fake(); jdbc.autoCommit=false; jdbc.failAt=1; jdbc.failRollback=true;
        RuntimeException failure=assertThrows(RuntimeException.class,()->run(jdbc,Arrays.asList(bound()),false));
        assertTrue(jdbc.connectionClosed); assertEquals(0,jdbc.commits);
        com.google.gson.JsonObject data=AgentRpcError.toJson(failure,"execute_batch","test").getAsJsonObject("data");
        assertEquals("quarantine",data.get("sessionDisposition").getAsString());
        assertEquals("unknown",data.get("operationOutcome").getAsString());
        assertEquals("connection",data.get("category").getAsString());
        assertEquals("08007",data.get("sqlState").getAsString());
    }

    @Test void unsupportedSavepointFailsBeforeAnyWrite() {
        Fake jdbc = new Fake(); jdbc.autoCommit = false; jdbc.unsupportedSavepoint = true;
        assertThrows(RuntimeException.class, () -> run(jdbc, Arrays.asList(bound()), false));
        assertEquals(0, jdbc.executions); assertEquals(0, jdbc.commits); assertEquals(0, jdbc.rollbacks);
    }

    @Test void rejectsInvalidLaterBindingBeforeOpeningAnyStatement() {
        Fake jdbc = new Fake();
        assertThrows(IllegalArgumentException.class, () -> run(jdbc,
            Arrays.asList(bound(), new BlobBoundStatement(PREVIEW, SQL, Arrays.asList("0x00"))), true));
        assertEquals(0, jdbc.executions); assertNull(jdbc.preparedSql); assertTrue(jdbc.autoCommit);
        assertThrows(IllegalArgumentException.class, () -> BlobBoundStatement.validate(Arrays.asList("edited"), Arrays.asList(bound())));
    }

    @Test void cancellationTracksStatementAndPreventsNextStatement() {
        Fake jdbc = new Fake(); jdbc.cancel = true;
        assertThrows(java.util.concurrent.CancellationException.class, () -> run(jdbc, Arrays.asList(bound(), bound()), true));
        assertEquals(2, jdbc.cancels); assertEquals(1, jdbc.executions);
        assertEquals(1, jdbc.rollbacks); assertEquals(2, jdbc.closedStatements);
    }

    @Test void invalidLaterParameterCountFailsBeforeAnyWriteAndIgnoresQuotedMarkers() {
        Fake jdbc=new Fake();
        assertThrows(IllegalArgumentException.class,()->run(jdbc,Arrays.asList(bound(),new BlobBoundStatement(PREVIEW,SQL,Arrays.asList("cafe"))),true));
        assertEquals(0,jdbc.executions); assertNull(jdbc.preparedSql);
        BlobBoundStatement.validate(Arrays.asList(PREVIEW),Arrays.asList(new BlobBoundStatement(PREVIEW,
            "BEGIN UPDATE t SET b=?; x:='?''?'; x:=q'[?]'; -- ?\n/* ? */ END;",Arrays.asList("cafe"))));
    }

    @Test void legacyAgentRejectsBindingBeforeCallingLegacyBatch() {
        DatabaseAgent agent = (DatabaseAgent) Proxy.newProxyInstance(DatabaseAgent.class.getClassLoader(), new Class<?>[]{DatabaseAgent.class},
            (p, m, a) -> { if (m.getName().equals("supportsBlobBindStatements")) return false;
                if (m.getName().equals("getConnection")) return new Fake().connection();
                if (m.getName().startsWith("execute")) throw new AssertionError("Must not execute unsupported payload"); return defaultValue(m.getReturnType()); });
        String response = new JsonRpcServer(agent).handleRequest("{\"id\":1,\"method\":\"execute_batch\",\"params\":{\"statements\":[],\"boundStatements\":[]}}");
        assertTrue(JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error").get("message").getAsString().contains("blob_bind_statements_v1"), response);
    }

    @Test void onlyOptedInServerAdvertisesBindingCapability() {
        com.google.gson.Gson gson = new com.google.gson.Gson();
        assertFalse(gson.toJson(AgentProtocol.multiSessionJdbcHandshakeResult()).contains("blob_bind_statements_v1"));
        assertTrue(gson.toJson(AgentProtocol.multiSessionJdbcHandshakeResult(true)).contains("blob_bind_statements_v1"));
    }

    @Test void laterSetterFailureOccursBeforeAnyWriteAndClosesAllResources() {
        Fake jdbc=new Fake(); jdbc.failBindAt=3;
        assertThrows(RuntimeException.class,()->run(jdbc,Arrays.asList(bound(),bound()),true));
        assertEquals(0,jdbc.executions); assertEquals(1,jdbc.rollbacks); assertEquals(2,jdbc.closedStatements);
        for(InputStream stream:jdbc.streams)assertThrows(java.io.IOException.class,stream::read);
    }

    @Test void cancellationDuringResourceCloseStillPreventsCommit() {
        Fake jdbc=new Fake();jdbc.cancelOnClose=true;
        assertThrows(java.util.concurrent.CancellationException.class,()->run(jdbc,Arrays.asList(bound()),true));
        assertEquals(1,jdbc.executions);assertEquals(0,jdbc.commits);assertEquals(1,jdbc.rollbacks);
    }

    @Test void connectionResetAfterCommitReportsUnknownInsteadOfClaimingNoWrite() {
        Fake jdbc=new Fake();jdbc.failReset=true;
        RuntimeException failure=assertThrows(RuntimeException.class,()->run(jdbc,Arrays.asList(bound()),true));
        assertEquals(1,jdbc.commits);assertTrue(jdbc.connectionClosed);
        com.google.gson.JsonObject data=AgentRpcError.toJson(failure,"execute_transaction","test").getAsJsonObject("data");
        assertEquals("quarantine",data.get("sessionDisposition").getAsString());
        assertEquals("unknown",data.get("operationOutcome").getAsString());
    }

    @Test void rpcRejectsNonStringHexRatherThanGsonCoercingIt() {
        DatabaseAgent agent=(DatabaseAgent)Proxy.newProxyInstance(DatabaseAgent.class.getClassLoader(),new Class<?>[]{DatabaseAgent.class},
            (p,m,a)->{if(m.getName().equals("supportsBlobBindStatements"))return true;
                if(m.getName().equals("getConnection"))return new Fake().connection();
                if(m.getName().startsWith("execute"))throw new AssertionError("Malformed payload must not execute");return defaultValue(m.getReturnType());});
        String response=new JsonRpcServer(agent).handleRequest("{\"id\":2,\"method\":\"execute_transaction\",\"params\":{\"statements\":[\"preview\"],\"boundStatements\":[{\"previewSql\":\"preview\",\"sql\":\"BEGIN x:=?; END;\",\"blobParameters\":[12]}]}}");
        assertTrue(response.contains("hexadecimal string"),response);
    }

    private static QueryResult run(Fake jdbc, List<BlobBoundStatement> statements, boolean transaction) {
        List<String> previews = new ArrayList<>(); for (BlobBoundStatement ignored : statements) previews.add(PREVIEW);
        return BlobBoundExecutor.execute(jdbc.connection(), previews, statements, null, schema -> null, () -> "", 7, transaction);
    }

    private static final class Fake {
        boolean autoCommit = true, fail, cancel, unsupportedSavepoint, failRollback, connectionClosed, failReset, cancelOnClose;
        int value=42,savedValue=42,failAt,failBindAt;
        int commits, rollbacks, savepointRollbacks, savepoints, releases, executions, closedStatements, cancels, timeout;
        String preparedSql;
        List<String> events = new ArrayList<>(), boundHex = new ArrayList<>();
        List<Long> lengths = new ArrayList<>(); List<InputStream> streams = new ArrayList<>();
        Connection connection() {
            return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class}, (p,m,a) -> {
                switch (m.getName()) {
                    case "getAutoCommit": return autoCommit;
                    case "isValid": return true;
                    case "close": connectionClosed=true; return null;
                    case "setAutoCommit": if(failReset && (boolean)a[0])throw new java.sql.SQLException("reset failed"); autoCommit = (boolean)a[0]; return null;
                    case "getMetaData": return Proxy.newProxyInstance(DatabaseMetaData.class.getClassLoader(), new Class<?>[]{DatabaseMetaData.class}, (x,y,z) -> y.getName().equals("supportsTransactions") ? true : defaultValue(y.getReturnType()));
                    case "setSavepoint": if (unsupportedSavepoint) throw new java.sql.SQLFeatureNotSupportedException(); savepoints++; savedValue=value; return Proxy.newProxyInstance(Savepoint.class.getClassLoader(),new Class<?>[]{Savepoint.class},(x,y,z)->defaultValue(y.getReturnType()));
                    case "releaseSavepoint": releases++; return null;
                    case "commit": commits++; events.add("commit"); return null;
                    case "rollback": if(failRollback)throw new java.sql.SQLException("rollback lost connection","08006"); if (a == null || a.length == 0) rollbacks++; else {savepointRollbacks++;value=savedValue;} return null;
                    case "prepareCall": case "prepareStatement": preparedSql=(String)a[0]; return statement(m.getName().equals("prepareCall"));
                    default: return defaultValue(m.getReturnType());
                }
            });
        }
        PreparedStatement statement(boolean callable) {
            Class<?> type = callable ? CallableStatement.class : PreparedStatement.class;
            return (PreparedStatement) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, (p,m,a) -> {
                switch (m.getName()) {
                    case "setQueryTimeout": timeout=(int)a[0]; return null;
                    case "setBlob": assertInstanceOf(InputStream.class,a[1]); assertInstanceOf(Long.class,a[2]);
                        InputStream stream=(InputStream)a[1]; streams.add(stream); lengths.add((Long)a[2]);
                        if(streams.size()==failBindAt)throw new java.sql.SQLException("binding failed");
                        byte[] bytes=stream.readAllBytes(); StringBuilder hex=new StringBuilder(); for(byte b:bytes)hex.append(String.format("%02x",b&255)); boundHex.add(hex.toString()); return null;
                    case "execute": executions++;value++; if(fail)throw new SQLTimeoutException("timed out","HYT00"); if(executions==failAt)throw new java.sql.SQLException("stale target","23000"); if(cancel)JdbcExecutor.current().cancelActiveStatements(); return false;
                    case "getUpdateCount": return 1;
                    case "cancel": cancels++; return null;
                    case "close": closedStatements++; events.add("close"); if(cancelOnClose)JdbcExecutor.current().cancelActiveStatements(); return null;
                    case "hashCode": return System.identityHashCode(p);
                    case "equals": return p==a[0];
                    default: return defaultValue(m.getReturnType());
                }
            });
        }
    }
    private static Object defaultValue(Class<?> type) {
        if(type==boolean.class)return false;if(type==int.class)return 0;if(type==long.class)return 0L;return null;
    }
}
