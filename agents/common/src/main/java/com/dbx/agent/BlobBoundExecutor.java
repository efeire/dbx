package com.dbx.agent;

import java.io.InputStream;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.sql.Savepoint;
import java.sql.SQLException;
import java.sql.SQLTransientConnectionException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.function.Function;
import java.util.function.Supplier;

public final class BlobBoundExecutor {
    private BlobBoundExecutor() { }

    @FunctionalInterface
    public interface PreparedStatementConfigurer {
        void configure(PreparedStatement statement) throws SQLException;
    }

    public static QueryResult execute(Connection conn, List<String> previews, List<BlobBoundStatement> statements,
        String schema, Function<String, String> setSchemaSql, Supplier<String> resetSchemaSql,
        int timeoutSecs, boolean transaction) {
        return execute(conn, previews, statements, schema, setSchemaSql, resetSchemaSql, timeoutSecs,
            transaction, statement -> { });
    }

    public static QueryResult execute(Connection conn, List<String> previews, List<BlobBoundStatement> statements,
        String schema, Function<String, String> setSchemaSql, Supplier<String> resetSchemaSql,
        int timeoutSecs, boolean transaction, PreparedStatementConfigurer configurer) {
        BlobBoundStatement.validate(previews, statements);
        if (timeoutSecs < 0) throw new IllegalArgumentException("BLOB binding timeout must be non-negative");
        try (JdbcExecutor.NativeOperation operation = JdbcExecutor.current().beginNativeOperation()) {
            operation.checkCancelled();
            boolean autoCommit = conn.getAutoCommit();
            if (transaction && !autoCommit) {
                throw new IllegalStateException("Cannot start a one-shot transaction while a manual transaction is open");
            }
            if (transaction && !conn.getMetaData().supportsTransactions()) {
                throw new UnsupportedOperationException("Transactions are not supported by this JDBC driver");
            }
            if (transaction) conn.setAutoCommit(false);
            Savepoint savepoint = !transaction && !autoCommit ? conn.setSavepoint() : null;
            boolean finished = !transaction;
            boolean discarded = false;
            try {
                long start = System.currentTimeMillis();
                long affected = executeAll(conn, statements, schema, setSchemaSql, resetSchemaSql, timeoutSecs, operation, configurer);
                operation.checkCancelled();
                if (transaction) conn.commit();
                if (savepoint != null) conn.releaseSavepoint(savepoint);
                finished = true;
                return new QueryResult(Collections.emptyList(), Collections.emptyList(), affected,
                    System.currentTimeMillis() - start, false);
            } catch (Exception failure) {
                if (transaction) {
                    try { conn.rollback(); finished = true; }
                    catch (Exception rollbackFailure) {
                        discarded = true;
                        throw rollbackUnconfirmed(conn, failure, rollbackFailure);
                    }
                }
                if (savepoint != null) {
                    try { conn.rollback(savepoint); }
                    catch (Exception rollbackFailure) { throw rollbackUnconfirmed(conn, failure, rollbackFailure); }
                    try { conn.releaseSavepoint(savepoint); }
                    catch (Exception releaseFailure) { failure.addSuppressed(releaseFailure); }
                }
                throw failure;
            } finally {
                if (transaction) {
                    if (finished) {
                        try { conn.setAutoCommit(autoCommit); }
                        catch (Exception resetFailure) {
                            SQLTransientConnectionException unsafe = new SQLTransientConnectionException(
                                "BLOB transaction connection reset failed; committed writes may exist and operation outcome is unknown", "08007", resetFailure);
                            try { conn.close(); } catch (Exception closeFailure) { unsafe.addSuppressed(closeFailure); }
                            throw unsafe;
                        }
                    } else if (!discarded) conn.close(); // Never enable auto-commit after an unconfirmed rollback.
                }
            }
        } catch (RuntimeException failure) {
            throw failure;
        } catch (Exception failure) {
            throw new RuntimeException(failure);
        }
    }

    private static SQLTransientConnectionException rollbackUnconfirmed(Connection conn, Exception failure,
        Exception rollbackFailure) {
        SQLTransientConnectionException unsafe = new SQLTransientConnectionException(
            "BLOB binding rollback was not confirmed; discard this connection and treat the operation outcome as unknown", "08007", failure);
        unsafe.addSuppressed(rollbackFailure);
        try { conn.close(); } catch (Exception closeFailure) { unsafe.addSuppressed(closeFailure); }
        return unsafe;
    }

    private static long executeAll(Connection conn, List<BlobBoundStatement> statements, String schema,
        Function<String, String> setSchemaSql, Supplier<String> resetSchemaSql, int timeoutSecs,
        JdbcExecutor.NativeOperation operation, PreparedStatementConfigurer configurer) throws Exception {
        JdbcExecutor executor = JdbcExecutor.current();
        try (BoundResources resources = new BoundResources()) {
            operation.checkCancelled();
            JdbcSchemaSwitcher.apply(conn, schema, setSchemaSql, resetSchemaSql);
            for (BlobBoundStatement bound : statements) {
                operation.checkCancelled();
                String sql = JdbcExecutor.trimSql(bound.sql());
                Statement statement = bound.blobParameters().isEmpty() ? conn.createStatement()
                    : isAnonymousBlock(sql) ? conn.prepareCall(sql) : conn.prepareStatement(sql);
                resources.statements.add(executor.trackStatement(statement));
                statement.setQueryTimeout(timeoutSecs);
                if (statement instanceof PreparedStatement prepared) {
                    configurer.configure(prepared);
                    int index = 1;
                    for (String hex : bound.blobParameters()) {
                        InputStream stream = new HexStream(hex);
                        resources.streams.add(stream);
                        prepared.setBlob(index++, stream, (long) hex.length() / 2);
                    }
                }
            }
            // Prepare and bind the complete batch before the first write.
            long affected = 0;
            for (int i = 0; i < statements.size(); i++) {
                operation.checkCancelled();
                Statement statement = resources.statements.get(i).statement();
                boolean result = statement instanceof PreparedStatement prepared ? prepared.execute()
                    : statement.execute(JdbcExecutor.trimSql(statements.get(i).sql()));
                if (!result) affected += Math.max(0, statement.getUpdateCount());
                operation.checkCancelled();
            }
            return affected;
        }
    }

    private static final class BoundResources implements AutoCloseable {
        final List<JdbcExecutor.TrackedStatement<Statement>> statements = new ArrayList<>();
        final List<InputStream> streams = new ArrayList<>();
        @Override public void close() throws Exception {
            Exception failure = null;
            List<AutoCloseable> resources = new ArrayList<>(statements);
            resources.addAll(streams);
            for (AutoCloseable resource : resources) {
                try { resource.close(); }
                catch (Exception error) {
                    if (failure == null) failure = error;
                    else failure.addSuppressed(error);
                }
            }
            if (failure != null) throw failure;
        }
    }

    private static boolean isAnonymousBlock(String sql) {
        String normalized = sql.toUpperCase(Locale.ROOT);
        return normalized.startsWith("DECLARE") || normalized.startsWith("BEGIN");
    }

    /** Decode already-validated hex without retaining a second full byte array. */
    private static final class HexStream extends InputStream {
        private final String hex;
        private int offset;
        private boolean closed;
        HexStream(String hex) { this.hex = hex; }
        @Override public int read() throws java.io.IOException {
            if (closed) throw new java.io.IOException("BLOB binding stream is closed");
            if (offset == hex.length()) return -1;
            int value = Character.digit(hex.charAt(offset), 16) * 16 + Character.digit(hex.charAt(offset + 1), 16);
            offset += 2;
            return value;
        }
        @Override public void close() { closed = true; }
    }
}
