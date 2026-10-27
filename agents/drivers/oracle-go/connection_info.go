package main

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

func (s *server) connectionInfo() (map[string]any, error) {
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(s.statementContext())
	s.activeCancelMu.Lock()
	s.activeCancel = cancel
	s.activeCancelMu.Unlock()
	defer func() {
		cancel()
		s.activeCancelMu.Lock()
		s.activeCancel = nil
		s.activeCancelMu.Unlock()
	}()

	var queryRow func(context.Context, string, ...any) *sql.Row
	if s.manualTx != nil {
		queryRow = s.manualTx.QueryRowContext
	} else if s.statementConn != nil {
		queryRow = s.statementConn.QueryRowContext
	} else {
		conn, err := db.Conn(ctx)
		if err != nil {
			return nil, err
		}
		defer conn.Close()
		queryRow = conn.QueryRowContext
	}
	var database string
	if err := queryRow(ctx, "SELECT SYS_CONTEXT('USERENV','DB_NAME') FROM DUAL").Scan(&database); err != nil {
		return nil, err
	}
	if strings.TrimSpace(database) == "" {
		return nil, errors.New("live database identity is empty")
	}
	info := map[string]string{"currentDatabase": database}
	var product, version sql.NullString
	err = queryRow(ctx, "SELECT PRODUCT, VERSION FROM PRODUCT_COMPONENT_VERSION WHERE PRODUCT LIKE 'Oracle Database%' AND ROWNUM = 1").Scan(&product, &version)
	if err == nil {
		if product.Valid && strings.TrimSpace(product.String) != "" {
			info["productName"] = product.String
		}
		if version.Valid && strings.TrimSpace(version.String) != "" {
			info["productVersion"] = version.String
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		code := oracleVendorCode(err)
		if code == nil || (*code != 942 && *code != 1031) {
			return nil, err
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"identifierQuote": `"`, "databaseInfo": info}, nil
}
