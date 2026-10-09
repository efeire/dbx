package com.dbx.agent.oceanbaseoracle;

import com.oceanbase.jdbc.OceanBaseStatement;
import java.sql.SQLException;
import java.sql.Statement;

final class OceanBaseLobStatements {
    private OceanBaseLobStatements() { }

    static void configure(Statement statement) throws SQLException {
        OceanBaseStatement vendor;
        try {
            vendor = statement instanceof OceanBaseStatement ? (OceanBaseStatement) statement
                : statement.unwrap(OceanBaseStatement.class);
        } catch (SQLException error) {
            throw new SQLException("Unsupported OceanBase LOB statement", error);
        }
        if (vendor == null) throw new SQLException("Unsupported OceanBase LOB statement");
        // Set only the native LOB mode; binding, cancellation and close retain the pool proxy.
        vendor.setInternal();
    }
}
