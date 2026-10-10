package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.JdbcExecutor;
import com.oceanbase.jdbc.OceanBaseConnection;
import com.oceanbase.jdbc.OceanBaseStatement;
import com.oceanbase.jdbc.internal.protocol.Protocol;
import com.oceanbase.jdbc.util.Options;
import com.zaxxer.hikari.HikariDataSource;
import java.lang.reflect.Proxy;
import java.sql.CallableStatement;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.locks.ReentrantLock;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class OceanBaseLobStatementTest {
    @Test
    void serverLengthMarksExactLastChunkAndPastEndWithoutHidingReadErrors() throws Exception {
        for (String scenario : List.of("exact", "past-end", "beyond-end", "full-interior", "read-error")) {
            Options options = new Options();
            Protocol protocol = proxy(Protocol.class, (object, method, args) -> {
                if (method.getName().equals("getOptions")) return options;
                if (method.getName().equals("getLock")) return new ReentrantLock();
                return defaultValue(method.getReturnType());
            });
            OceanBaseStatement vendor = new OceanBaseStatement(new OceanBaseConnection(protocol), 1003, 1007, null);
            // JDBC UTF-16 length deliberately differs from the server's code-point length.
            Clob locator = proxy(Clob.class, (object, method, args) -> method.getName().equals("length") ? 10L : defaultValue(method.getReturnType()));
            SQLException failure = new SQLException("ORA-06502: real read failure", "HY000", 6502);
            CallableStatement call = proxy(CallableStatement.class, (object, method, args) -> {
                switch (method.getName()) {
                    case "unwrap": return vendor;
                    case "execute": if (scenario.equals("read-error")) throw failure; return false;
                    case "getInt": return scenario.equals("past-end") || scenario.equals("beyond-end") ? 0 : 3;
                    case "getLong": return scenario.equals("full-interior") ? 9L : 8L;
                    case "getBytes": return scenario.equals("past-end") || scenario.equals("beyond-end") ? null : "中😀末".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    default: return defaultValue(method.getReturnType());
                }
            });
            Connection connection = proxy(Connection.class, (object, method, args) -> method.getName().equals("prepareCall") ? call : defaultValue(method.getReturnType()));
            if (scenario.equals("read-error")) {
                assertSame(failure, assertThrows(SQLException.class, () -> OceanBaseLobValues.read(connection, locator, 5, 3)));
            } else {
                var chunk = OceanBaseLobValues.read(connection, locator, scenario.equals("beyond-end") ? 9 : scenario.equals("past-end") ? 8 : 5, 3);
                assertEquals(scenario.equals("past-end") || scenario.equals("beyond-end") ? "" : "中😀末", chunk.data());
                assertEquals(scenario.equals("beyond-end") ? 9 : 8, chunk.next_offset());
                assertEquals(!scenario.equals("full-interior"), chunk.eof(), "EOF must use server length, not JDBC UTF-16 length");
            }
            assertFalse(JdbcExecutor.current().hasActiveStatements());
        }
    }

    @Test
    void emptyLocatorReturnsEmptyEofWithoutCallingDbmsLobRead() throws Exception {
        Clob locator = proxy(Clob.class, (object, method, args) -> {
            if (method.getName().equals("length")) return 0L;
            throw new AssertionError("Empty LOB must not be materialized");
        });
        Connection connection = proxy(Connection.class, (object, method, args) -> {
            if (method.getName().equals("prepareCall")) throw new SQLException("ORA-06502: no data found", "HY000", 6502);
            throw new AssertionError("Empty LOB must not execute a statement");
        });
        var chunk = OceanBaseLobValues.read(connection, locator, 0, 257);
        assertEquals("", chunk.data());
        assertEquals(0, chunk.next_offset());
        assertTrue(chunk.eof());
        assertEquals("text", chunk.value_kind());
        assertFalse(JdbcExecutor.current().hasActiveStatements());
    }

    @Test
    void pooledCallableUnwrapsVendorOnlyForInternalFlagAndKeepsLifecycleOnProxy() throws Exception {
        {
            List<String> calls = new ArrayList<>();
            Options options = new Options();
            Protocol protocol = proxy(Protocol.class, (object, method, args) -> {
                if (method.getName().equals("getOptions")) return options;
                if (method.getName().equals("getLock")) return new ReentrantLock();
                return defaultValue(method.getReturnType());
            });
            OceanBaseStatement vendor = new OceanBaseStatement(new OceanBaseConnection(protocol), 1003, 1007, null);
            Clob locator = proxy(Clob.class, (o, m, a) -> m.getName().equals("length") ? 8L : defaultValue(m.getReturnType()));
            CallableStatement delegate = proxy(CallableStatement.class, (object, method, args) -> {
                switch (method.getName()) {
                    case "unwrap": return ((Class<?>) args[0]).cast(vendor);
                    case "isWrapperFor": return ((Class<?>) args[0]).isInstance(vendor);
                    case "setClob": assertSame(locator, args[1]); calls.add(method.getName()); return null;
                    case "setInt": assertEquals(3, args[1]); return null;
                    case "setLong": assertEquals(6L, args[1]); return null;
                    case "setQueryTimeout": assertEquals(20, args[0]); return null;
                    case "registerOutParameter": assertEquals((int) args[0] == 4 ? Types.INTEGER : (int) args[0] == 5 ? Types.VARCHAR : Types.BIGINT, args[1]); return null;
                    case "execute":
                        assertTrue(vendor.isInternal());
                        assertTrue(JdbcExecutor.current().hasActiveStatements());
                        JdbcExecutor.current().cancelActiveStatements();
                        calls.add("execute"); return false;
                    case "cancel", "close": calls.add(method.getName()); return null;
                    case "getInt": return 2;
                    case "getLong": return 7L;
                    case "getBytes": return "中😀".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    default: return defaultValue(method.getReturnType());
                }
            });
            Connection physical = proxy(Connection.class, (object, method, args) -> {
                if (method.getName().equals("prepareCall")) return delegate;
                if (method.getName().equals("getAutoCommit") || method.getName().equals("isValid")) return true;
                if (method.getName().equals("getTransactionIsolation")) return Connection.TRANSACTION_READ_COMMITTED;
                return defaultValue(method.getReturnType());
            });
            DataSource source = proxy(DataSource.class, (object, method, args) -> method.getName().equals("getConnection") ? physical : defaultValue(method.getReturnType()));
            try (HikariDataSource pool = new HikariDataSource()) {
                pool.setDataSource(source);
                pool.setMaximumPoolSize(1);
                pool.setMinimumIdle(0);
                try (Connection connection = pool.getConnection()) {
                    var chunk = OceanBaseLobValues.read(connection, locator, 5, 3);
                    assertEquals("中😀", chunk.data());
                    assertEquals(7, chunk.next_offset());
                    assertTrue(chunk.eof());
                    assertEquals("text", chunk.value_kind());
                }
            }
            assertEquals(List.of("setClob", "cancel", "execute", "close"), calls);
            assertFalse(JdbcExecutor.current().hasActiveStatements());
        }
    }

    @Test
    void nonOceanBaseCallableIsRejectedAndClosedBeforeExecuting() {
        List<String> calls = new ArrayList<>();
        CallableStatement call = proxy(CallableStatement.class, (object, method, args) -> {
            if (method.getName().equals("unwrap")) throw new SQLException("Not a vendor wrapper");
            if (method.getName().equals("close") || method.getName().equals("execute")) calls.add(method.getName());
            return defaultValue(method.getReturnType());
        });
        Connection connection = proxy(Connection.class, (object, method, args) -> method.getName().equals("prepareCall") ? call : defaultValue(method.getReturnType()));
        SQLException error = assertThrows(SQLException.class, () -> OceanBaseLobValues.read(connection, proxy(Clob.class, (o, m, a) -> m.getName().equals("length") ? 1L : null), 0, 1));
        assertEquals("Unsupported OceanBase LOB statement", error.getMessage());
        assertEquals(List.of("close"), calls);
        assertFalse(JdbcExecutor.current().hasActiveStatements());
    }

    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }

    private static <T> T proxy(Class<T> type, java.lang.reflect.InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }
}
