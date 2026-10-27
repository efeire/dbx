package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func connectionInfoSteps(database, version string) []oracleViewSourceQueryStep {
	return []oracleViewSourceQueryStep{
		{queryContains: "SYS_CONTEXT('USERENV','DB_NAME')", args: []driver.Value{}, rows: [][]driver.Value{{database}}},
		{queryContains: "PRODUCT LIKE 'Oracle Database%'", args: []driver.Value{}, columns: []string{"PRODUCT", "VERSION"}, rows: [][]driver.Value{{"Oracle Database", version}}},
	}
}

func TestConnectionInfoRuntimeSessionIdentity(t *testing.T) {
	runtime := newRuntimeServer()
	for _, id := range []string{"a", "b"} {
		db, _ := openOracleViewSourceTestDB(t, connectionInfoSteps("live-"+id, "11.2.0.4.0"))
		s := newServer()
		s.db = db
		s.params.Database = "configured-service-not-database"
		runtime.sessions[id] = &agentSession{server: s}
	}
	for _, id := range []string{"b", "a"} {
		resp, shutdown := runtime.handleLine(`{"jsonrpc":"2.0","id":1,"method":"connection_info","params":{"agentSessionId":"` + id + `"}}`)
		if resp.Error != nil || shutdown {
			t.Fatalf("connection_info failed for %s: %#v", id, resp.Error)
		}
		data, err := json.Marshal(resp.Result)
		if err != nil {
			t.Fatal(err)
		}
		var result struct {
			IdentifierQuote string            `json:"identifierQuote"`
			DatabaseInfo    map[string]string `json:"databaseInfo"`
		}
		if err := json.Unmarshal(data, &result); err != nil {
			t.Fatal(err)
		}
		if result.IdentifierQuote != `"` || result.DatabaseInfo["currentDatabase"] != "live-"+id || result.DatabaseInfo["productName"] != "Oracle Database" || result.DatabaseInfo["productVersion"] != "11.2.0.4.0" {
			t.Fatalf("unexpected live identity: %s", data)
		}
	}
}

func TestConnectionInfoFailureBoundaries(t *testing.T) {
	for _, test := range []struct {
		name    string
		step    int
		err     error
		allowed bool
	}{
		{"identity-failed", 0, errors.New("identity unavailable"), false},
		{"version-disconnected", 1, errors.New("connection closed"), false},
		{"version-cancelled", 1, context.Canceled, false},
		{"version-permission", 1, oracleRPCCodedError(1031), true},
		{"version-view-unavailable", 1, oracleRPCCodedError(942), true},
		{"version-no-record", 1, sql.ErrNoRows, true},
		{"version-untrusted-error-text", 1, errors.New("ORA-01031 is only untrusted text"), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			steps := connectionInfoSteps("LIVE", "11.2.0.4.0")
			steps[test.step].err = test.err
			db, _ := openOracleViewSourceTestDB(t, steps)
			s := newServer()
			s.db = db
			result, _, err := s.dispatch("connection_info", nil)
			if test.allowed {
				if err != nil {
					t.Fatal(err)
				}
				data, _ := json.Marshal(result)
				if strings.Contains(string(data), "productVersion") || !strings.Contains(string(data), `"currentDatabase":"LIVE"`) {
					t.Fatalf("unexpected optional metadata: %s", data)
				}
			} else if err == nil {
				t.Fatal("query failure must not return successful identity")
			}
		})
	}
}

func TestConnectionInfoUsesReservedStatementConnection(t *testing.T) {
	db, _ := openOracleViewSourceTestDB(t, connectionInfoSteps("LIVE", "11.2.0.4.0"))
	db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	s := newServer()
	s.db, s.statementConn, s.statementCtx = db, conn, ctx
	if _, _, err := s.dispatch("connection_info", nil); err != nil {
		t.Fatalf("connection_info must reuse the reserved connection: %v", err)
	}
}

func TestConnectionInfoHonorsCancelledContext(t *testing.T) {
	db, _ := openOracleViewSourceTestDB(t, connectionInfoSteps("LIVE", "11.2.0.4.0"))
	s := newServer()
	s.db = db
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.statementCtx = ctx
	if _, _, err := s.dispatch("connection_info", nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancelled context, got %v", err)
	}
}

func TestConnectionInfoCanCancelConnectionAcquisition(t *testing.T) {
	db, _ := openOracleViewSourceTestDB(t, connectionInfoSteps("LIVE", "11.2.0.4.0"))
	db.SetMaxOpenConns(1)
	reserved, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer reserved.Close()
	s := newServer()
	s.db = db
	runtime := newRuntimeServer()
	runtime.sessions["identity"] = &agentSession{server: s}
	finished := make(chan response, 1)
	go func() {
		result, _ := runtime.handleLine(`{"id":1,"method":"connection_info","params":{"agentSessionId":"identity"}}`)
		finished <- result
	}()
	deadline := time.Now().Add(time.Second)
	for {
		s.activeCancelMu.Lock()
		registered := s.activeCancel != nil
		s.activeCancelMu.Unlock()
		if registered {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("identity request did not register cancellation before acquiring a connection")
		}
		time.Sleep(time.Millisecond)
	}
	cancelled, _ := runtime.handleLine(`{"id":2,"method":"cancel_session","params":{"agentSessionId":"identity"}}`)
	if cancelled.Error != nil {
		t.Fatal(cancelled.Error)
	}
	select {
	case result := <-finished:
		if result.Error == nil || !strings.Contains(result.Error.Message, "canceled") {
			t.Fatalf("cancelled identity request must fail: %#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("cancel_session did not release the waiting identity request")
	}
}
