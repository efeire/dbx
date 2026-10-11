package com.dbx.agent;

final class AgentExecutionContext {
    private static final ThreadLocal<JdbcExecutor> JDBC_EXECUTOR = new ThreadLocal<>();
    private record StatementExecution(int timeoutSecs, JdbcExecutor.NativeOperation operation) { }
    private static final ThreadLocal<StatementExecution> STATEMENT_EXECUTION = new ThreadLocal<>();

    private AgentExecutionContext() {
    }

    static JdbcExecutor jdbcExecutor() {
        JdbcExecutor executor = JDBC_EXECUTOR.get();
        return executor == null ? JdbcExecutor.INSTANCE : executor;
    }

    static int statementTimeoutSecs() {
        StatementExecution execution = STATEMENT_EXECUTION.get();
        return execution == null ? 0 : execution.timeoutSecs();
    }

    static JdbcExecutor.NativeOperation statementOperation() {
        StatementExecution execution = STATEMENT_EXECUTION.get();
        return execution == null ? null : execution.operation();
    }

    static <T> T withStatementTimeout(int timeoutSecs, JdbcExecutor.NativeOperation operation,
        DatabaseAgent.ThrowingSupplier<T> supplier) throws Exception {
        if (timeoutSecs < 0) throw new IllegalArgumentException("Query timeout cannot be negative");
        StatementExecution previous = STATEMENT_EXECUTION.get();
        STATEMENT_EXECUTION.set(new StatementExecution(timeoutSecs, operation));
        try {
            return supplier.get();
        } finally {
            if (previous == null) STATEMENT_EXECUTION.remove();
            else STATEMENT_EXECUTION.set(previous);
        }
    }

    static <T> T withJdbcExecutor(JdbcExecutor executor, DatabaseAgent.ThrowingSupplier<T> supplier) throws Exception {
        JdbcExecutor previous = JDBC_EXECUTOR.get();
        JDBC_EXECUTOR.set(executor);
        try {
            return supplier.get();
        } finally {
            if (previous == null) {
                JDBC_EXECUTOR.remove();
            } else {
                JDBC_EXECUTOR.set(previous);
            }
        }
    }
}
