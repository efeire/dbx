# OceanBase Oracle query timing details

The result status bar shows request wait as a number (for example, `364ms`). Hover or keyboard focus opens a three-column table: number, stage, time. All 14 stages remain visible; parenthetical notes identify preparation/rendering outside wait and derived remainders. Escape closes the tooltip. Missing telemetry shows unavailable, never a substituted zero or backend total.

![Timing details using a captured Agent response](query-timing-details.png)

## Boundaries

- Java uses request-scoped monotonic timings. The RPC scope includes pool checkout/checks and return/reset; nested driver scopes merge phase measurements, not overlapping totals.
- Core measures the Agent execution lock. Optional telemetry crosses Java JSON, Rust typed/manual serialization, TypeScript results and result-cache snapshots.
- Appended pages and OceanBase offset jumps accumulate timings without retaining skipped rows. Other database types keep their existing display and offset execution-time behavior.
- Backend-reported time overlaps measured stages. Other wait is a derived remainder, not measured network time.
- Ordinary queries no longer read LAST_TRACE_ID or the SQL audit view to obtain server plan time. The associated diagnostic rows and plan-time display are removed. Business SQL, timeout, transaction and row-limit behavior are unchanged.

## Failure modes reviewed

Missing/old responses; invalid timing values; nested scopes double-counting totals; stale timings after errors; skipped pagination timings; cache loss/aliasing; misleading unavailable values; non-OceanBase regressions; keyboard access and constrained tooltip height.

## Validation

Java (JDK 21), from `agents/`:

```sh
./gradlew :common:test :oceanbase-oracle:test :oceanbase-oracle:shadowJar --console=plain
```

261 Java checks passed (218 common, 43 OceanBase). Obsolete sampler coverage was replaced with assertions that completed/capped cursors do not execute diagnostic SQL. Live JSON-RPC validation against an OceanBase Oracle 4.2.5.7 test instance with Connector/J 2.4.18 covered seven requests: two 27-table UNION counts, three cursor pages, a capped result, and an empty query. No table writes. Final no-audit validation passed row counts, nonnegative phases, bounded phase sums, no stale execute stage on fetch, and absence of trace/audit/server-plan telemetry on all seven requests. A held real pool connection measured 353.463ms acquisition inside a 363.0827ms Agent total; pool timeout and SQL-error paths recovered on subsequent requests.

Frontend, from repository root:

```sh
node node_modules/vitest/vitest.mjs run apps/desktop/src/components/grid/__tests__/QueryTimingDetails.spec.ts apps/desktop/src/components/grid/__tests__/DataGridSurfaces.spec.ts apps/desktop/src/lib/__tests__/tabs/tabResultCache.spec.ts apps/desktop/src/stores/__tests__/queryStore.multiStatementError.spec.ts apps/desktop/src/stores/__tests__/queryStore.spatialMetadata.spec.ts apps/desktop/src/stores/__tests__/queryStore.hiddenPrimaryKey.spec.ts apps/desktop/src/composables/__tests__/useResultViewUpdateTiming.spec.ts
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit --project apps/desktop/tsconfig.json
```

Existing component, store and cache tests exercise production behavior; regression expectations were updated before implementation. The final presentation passed its two focused component checks. Browser verification mounted the actual component, CSS, locale and production cache codec using a previously captured Agent result. The final status showed `26ms`, keyboard focus opened all 14 numbered rows with right-aligned values and inline notes, and Escape closed it. Screenshot above. Missing Core/store measurements in this fixture are intentionally unavailable.

Rust: `cargo check -p dbx-core --no-default-features --target x86_64-pc-windows-gnu` passed with local OpenSSL; a prior GNU desktop release compilation passed before the final tooltip and audit-removal changes. `cargo run -p dbx-types --example query_timing_roundtrip -- <live-results.json>` verified all seven captured responses preserve telemetry, server timing and rows.

The live fixture requires a separately provisioned test database and local credentials; credentials and database captures are not committed. Browser evidence does not validate the complete native desktop Core/store/grid path. A previous local portable build predates the final tooltip presentation; no new release is published by this PR.

## Pre-PR review

Rebased onto origin/main 80141e353 on 2026-09-24. Standards: no blocking findings; no version bumps or generated build files included. Spec: inline notes and 14 ordered remaining stages match the confirmed presentation; audit/trace lookups are removed, including terminal cursor paths. Full native desktop execution remains unverified. After rebase, 191 focused frontend tests passed across seven files, including upstream grid surface coverage.

Final Rust core check and Vue typecheck passed after rebase. Focused lint reported only two existing spread warnings. Review counts: Standards 0 blocking findings; Spec 0 blocking findings.
