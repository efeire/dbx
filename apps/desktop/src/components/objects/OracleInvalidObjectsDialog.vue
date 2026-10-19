<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { AlertTriangle, Loader2, RefreshCw, Wrench } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ConnectionConfig, DatabaseType } from "@/types/database";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { uuid } from "@/lib/common/utils";
import { formatError, normalizeBackendError } from "@/lib/backend/errorUtils";
import { oracleWriteRejected } from "@/lib/database/oracleSecurity";
import {
  oracleCompileUnsupportedReason,
  buildOracleCompileSql,
  buildOracleInvalidObjectsSql,
  buildOracleObjectErrorsSql,
  buildOracleObjectIdentitySql,
  buildOracleObjectStatusSql,
  mapOracleInvalidObjects,
  mapOracleObjectErrors,
  readAllOracleInvalidObjects,
  type OracleInvalidObject,
  type OracleObjectError,
} from "@/lib/database/oracleInvalidObjects";

const props = defineProps<{ open: boolean; connection: ConnectionConfig; database: string; schema: string }>();
const emit = defineEmits<{
  "update:open": [open: boolean];
  "open-source": [object: OracleInvalidObject];
  "compile-finished": [scope: { connectionId: string; database: string; schema: string }];
}>();
const { t } = useI18n();
const objects = ref<OracleInvalidObject[]>([]);
const selected = ref<OracleInvalidObject | null>(null);
const errors = ref<OracleObjectError[]>([]);
const errorsTruncated = ref(false);
const loadError = ref("");
const errorLoadError = ref("");
const loading = ref(false);
const compiling = ref(false);
const truncated = ref(false);
const previewSql = ref("");
const outcome = ref("");
const singlePlan = ref<{ scope: ExecutionScope; object: OracleInvalidObject; sql: string } | null>(null);
const generation = ref(0);
type ManagedSession = { id: string; connectionId: string; database: string; active: number; closeRequested: boolean; closed: boolean };
type ExecutionScope = { connection: ConnectionConfig; connectionKey: string; database: string; schema: string; generation: number; session: ManagedSession };
type BatchStatus = "pending" | "unsupported" | "valid" | "still-invalid" | "already-valid" | "target-changed" | "deleted" | "failed" | "unknown" | "not-run";
type BatchItem = { object: OracleInvalidObject; sql?: string; unsupportedReason?: "unsupported-type" | "unsupported-on-engine"; status: BatchStatus; message?: string; errors?: OracleObjectError[]; errorsTruncated?: boolean };
type BatchRun = {
  id: string;
  scope: ExecutionScope;
  state: "reading" | "confirm" | "running" | "results" | "error";
  readCount: number;
  items: BatchItem[];
  page: number;
  stopRequested: boolean;
  submittedAny: boolean;
  currentName: string;
  readError: string;
  remaining?: OracleInvalidObject[];
  remainingError: string;
};
const batchRun = ref<BatchRun | null>(null);
const batchPageSize = 100;
const batchPageCount = computed(() => Math.max(1, Math.ceil((batchRun.value?.items.length ?? 0) / batchPageSize)));
const visibleBatchItems = computed(() => {
  const items = batchRun.value?.items ?? [];
  const start = (batchRun.value?.page ?? 0) * batchPageSize;
  return items.slice(start, start + batchPageSize);
});
const batchSupportedCount = computed(() => batchRun.value?.items.filter((item) => !!item.sql).length ?? 0);
const batchSkippedCount = computed(() => batchRun.value?.items.filter((item) => !item.sql || item.status === "not-run").length ?? 0);
const batchHandledCount = computed(() => batchRun.value?.items.filter((item) => item.status !== "pending" && item.status !== "unsupported").length ?? 0);
const batchValidCount = computed(() => batchRun.value?.items.filter((item) => item.status === "valid" || item.status === "already-valid").length ?? 0);
const batchStillInvalidCount = computed(() => batchRun.value?.items.filter((item) => item.status === "still-invalid").length ?? 0);
const batchFailureCount = computed(() => batchRun.value?.items.filter((item) => item.status === "failed" || item.status === "unknown" || item.status === "target-changed" || item.status === "deleted").length ?? 0);
let batchExecutionGeneration = 0;
function newManagedSession(connectionId: string, database: string): ManagedSession {
  return { id: `invalid-objects:${uuid()}`, connectionId, database, active: 0, closeRequested: false, closed: false };
}
let managedSession: ManagedSession | null = null;
let singleCompilationGeneration = 0;
const databaseType = computed(() => (effectiveDatabaseTypeForConnection(props.connection) ?? props.connection.db_type) as DatabaseType);

function isCurrent(token: number): boolean {
  return token === generation.value && props.open;
}

function ensureManagedSession(connectionId: string, database: string): ManagedSession {
  if (!managedSession || managedSession.connectionId !== connectionId || managedSession.database !== database || managedSession.closeRequested || managedSession.closed) rotateManagedSession(connectionId, database);
  return managedSession!;
}

function captureExecutionScope(): ExecutionScope {
  const connection = { ...props.connection };
  const database = props.database;
  return { connection, connectionKey: JSON.stringify(connection), database, schema: props.schema, generation: generation.value, session: ensureManagedSession(connection.id, database) };
}

function scopeIsCurrent(scope: ExecutionScope): boolean {
  return isCurrent(scope.generation) && props.connection.id === scope.connection.id && JSON.stringify(props.connection) === scope.connectionKey && props.database === scope.database && props.schema === scope.schema;
}

async function query(sql: string, maxRows = 501, scope?: ExecutionScope, allowExecutionError = false) {
  const connectionId = scope?.connection.id ?? props.connection.id;
  const database = scope?.database ?? props.database;
  const schema = scope?.schema ?? props.schema;
  const session = scope?.session ?? ensureManagedSession(connectionId, database);
  session.active++;
  try {
    const result = await api.executeQuery(connectionId, database, sql, schema, undefined, { maxRows, clientSessionId: session.id });
    if (!allowExecutionError && result.execution_error) throw new Error(result.error ? formatError(result.error) : String(result.rows[0]?.[0] ?? "Database query failed"));
    return result;
  } finally {
    session.active--;
    closeManagedSession(session);
  }
}

function closeManagedSession(session: ManagedSession) {
  if (!session.closeRequested || session.active > 0 || session.closed) return;
  session.closeRequested = false;
  session.closed = true;
  void api.closeClientConnectionSession(session.connectionId, session.database, session.id).catch(() => undefined);
}

function retireManagedSession() {
  const previous = managedSession;
  managedSession = null;
  if (!previous) return;
  previous.closeRequested = true;
  closeManagedSession(previous);
}

function rotateManagedSession(connectionId: string, database: string) {
  retireManagedSession();
  managedSession = newManagedSession(connectionId, database);
}

function closeCurrentManagedSession() {
  if (!managedSession) return;
  managedSession.closeRequested = true;
  closeManagedSession(managedSession);
}

async function loadList(existingToken?: number, options?: { allowLastDdlTimeChange?: boolean }) {
  const token = existingToken ?? ++generation.value;
  loading.value = true;
  loadError.value = "";
  errorLoadError.value = "";
  errorsTruncated.value = false;
  outcome.value = "";
  try {
    const result = await query(buildOracleInvalidObjectsSql(props.schema, 501), 501);
    if (!isCurrent(token)) return;
    objects.value = mapOracleInvalidObjects(result.rows, props.schema);
    truncated.value = result.truncated === true || objects.value.length >= 501;
    if (selected.value) {
      const previous = selected.value;
      const refreshed = objects.value.find((row) => row.objectId === previous.objectId && row.owner === previous.owner) ?? null;
      if (!refreshed || refreshed.name !== previous.name || refreshed.type !== previous.type || (!options?.allowLastDdlTimeChange && refreshed.lastDdlTime !== previous.lastDdlTime)) {
        previewSql.value = "";
        if (refreshed) outcome.value = t("processList.oracleInvalidObjects.targetChanged");
      }
      selected.value = refreshed;
    }
    if (selected.value) await loadErrors(selected.value, token);
    else {
      errors.value = [];
      errorsTruncated.value = false;
    }
  } catch (error) {
    if (isCurrent(token)) {
      loadError.value = error instanceof Error ? error.message : String(error);
      objects.value = [];
      selected.value = null;
      errors.value = [];
      errorsTruncated.value = false;
      truncated.value = false;
      previewSql.value = "";
    }
  } finally {
    if (isCurrent(token)) loading.value = false;
  }
}

async function loadErrors(object: OracleInvalidObject, token = generation.value) {
  errorLoadError.value = "";
  errors.value = [];
  errorsTruncated.value = false;
  try {
    const result = await readObjectErrors(captureExecutionScope(), object);
    if (!isCurrent(token) || selected.value?.objectId !== object.objectId) return;
    errors.value = result.errors;
    errorsTruncated.value = result.truncated;
  } catch (error) {
    if (isCurrent(token) && selected.value?.objectId === object.objectId) errorLoadError.value = error instanceof Error ? error.message : String(error);
  }
}

function selectObject(object: OracleInvalidObject) {
  selected.value = object;
  errors.value = [];
  errorsTruncated.value = false;
  errorLoadError.value = "";
  previewSql.value = "";
  singlePlan.value = null;
  outcome.value = "";
  void loadErrors(object);
}

class BatchWriteError extends Error {
  constructor(
    readonly value: unknown,
    readonly unknown: boolean,
  ) {
    super(writeErrorMessage(value));
  }
}

function writeErrorMessage(value: unknown): string {
  if (value && typeof value === "object" && "execution_error" in value) {
    const result = value as { error?: unknown; rows?: unknown[][] };
    return result.error ? formatError(result.error) : String(result.rows?.[0]?.[0] ?? "Database execution failed");
  }
  return formatError(value);
}

function knownWriteRejection(value: unknown): boolean {
  const backendError = normalizeBackendError(value);
  if (backendError?.operationOutcome === "not_started") return true;
  const message = backendError?.detail ?? writeErrorMessage(value);
  return oracleWriteRejected(message, true);
}

function objectIdentityMatches(object: OracleInvalidObject, row: unknown[] | undefined): boolean {
  return !!row && String(row[0] ?? "") === object.objectId && String(row[1] ?? "") === object.lastDdlTime;
}

function objectIdMatches(object: OracleInvalidObject, row: unknown[] | undefined): boolean {
  return !!row && String(row[0] ?? "") === object.objectId;
}

function objectDdlTimeMatches(object: OracleInvalidObject, row: unknown[] | undefined): boolean {
  return !!row && String(row[1] ?? "") === object.lastDdlTime;
}

function readObjectStatus(scope: ExecutionScope, object: OracleInvalidObject) {
  return query(buildOracleObjectStatusSql(object.owner, object), 2, scope);
}

async function readObjectErrors(scope: ExecutionScope, object: OracleInvalidObject) {
  const result = await query(buildOracleObjectErrorsSql(object.owner, object), 1000, scope);
  return {
    errors: mapOracleObjectErrors(result.rows),
    truncated: result.truncated === true || result.rows.length >= 1000,
  };
}

async function submitCompile(scope: ExecutionScope, sql: string) {
  try {
    const result = await query(sql, 1, scope, true);
    if (result.execution_error) throw new BatchWriteError(result, !knownWriteRejection(result));
    return result;
  } catch (error) {
    if (error instanceof BatchWriteError) throw error;
    throw new BatchWriteError(error, !knownWriteRejection(error));
  }
}

const unsupportedReason = computed(() => (selected.value ? oracleCompileUnsupportedReason(databaseType.value, selected.value.type) : "unsupported-type"));

function prepareSingleCompile() {
  if (!selected.value || unsupportedReason.value || compiling.value) return;
  try {
    const object = { ...selected.value };
    const scope = captureExecutionScope();
    const sql = buildOracleCompileSql(databaseType.value, object.owner, object);
    singlePlan.value = { scope, object, sql };
    previewSql.value = sql;
    outcome.value = "";
  } catch (error) {
    outcome.value = error instanceof Error ? error.message : String(error);
  }
}

async function confirmCompile() {
  const plan = singlePlan.value;
  const target = plan?.object;
  const sql = plan?.sql;
  if (!target || !sql || unsupportedReason.value || compiling.value) return;
  const scope = plan.scope;
  const executionGeneration = ++singleCompilationGeneration;
  const token = scope.generation;
  const connection = scope.connection;
  const database = scope.database;
  const schema = scope.schema;
  let actionSubmitted = false;
  compiling.value = true;
  outcome.value = "";
  try {
    const result = await executeWithProductionSqlGuard({
      connection,
      database: props.schema,
      sql,
      source: t("production.sourceAdmin"),
      execute: async () => {
        if (!scopeIsCurrent(scope)) throw new Error(t("processList.oracleInvalidObjects.targetChanged"));
        const identity = await query(buildOracleObjectIdentitySql(target.owner, target), 2, scope);
        const row = identity.rows[0];
        if (!scopeIsCurrent(scope)) return undefined;
        if (!objectIdentityMatches(target, row)) {
          previewSql.value = "";
          singlePlan.value = null;
          await loadList(token);
          if (!scopeIsCurrent(scope)) return undefined;
          outcome.value = t("processList.oracleInvalidObjects.targetChanged");
          return undefined;
        }
        actionSubmitted = true;
        try {
          return await submitCompile(scope, sql);
        } catch (error) {
          if (error instanceof BatchWriteError && !error.unknown) actionSubmitted = false;
          throw error;
        }
      },
    });
    if (!isCurrent(token)) return;
    if (result === undefined) return;
    const statusResult = await readObjectStatus(scope, target);
    if (!scopeIsCurrent(scope)) return;
    const statusRow = statusResult.rows.length === 1 ? statusResult.rows[0] : undefined;
    // Compilation is DDL and can update LAST_DDL_TIME on the same object.
    // OBJECT_ID distinguishes a replacement; the preflight above still checks both fields.
    const sameObject = statusRow && String(statusRow[0]) === target.objectId;
    const status = sameObject ? String(statusRow[2] ?? "") : "";
    await loadList(token, { allowLastDdlTimeChange: true });
    if (!scopeIsCurrent(scope)) return;
    outcome.value = !statusRow
      ? t("processList.oracleInvalidObjects.compileGone")
      : !sameObject
        ? t("processList.oracleInvalidObjects.targetChanged")
        : status === "VALID"
          ? t("processList.oracleInvalidObjects.compileValid")
          : status === "INVALID"
            ? t("processList.oracleInvalidObjects.compileStillInvalid")
            : t("processList.oracleInvalidObjects.compileUnknown");
    previewSql.value = "";
    singlePlan.value = null;
  } catch (error) {
    if (scopeIsCurrent(scope)) {
      if (actionSubmitted) {
        previewSql.value = "";
        singlePlan.value = null;
        await loadList(token);
        if (!scopeIsCurrent(scope)) return;
        outcome.value = error instanceof BatchWriteError && !error.unknown ? t("processList.oracleInvalidObjects.compileFailed", { message: writeErrorMessage(error.value) }) : `${t("processList.oracleInvalidObjects.compileUnknown")} ${writeErrorMessage(error)}`;
      } else {
        outcome.value = t("processList.oracleInvalidObjects.compileFailed", { message: writeErrorMessage(error instanceof BatchWriteError ? error.value : error) });
      }
    }
  } finally {
    if (actionSubmitted) emit("compile-finished", { connectionId: connection.id, database, schema });
    if (singleCompilationGeneration === executionGeneration) compiling.value = false;
  }
}

function batchIsCurrent(run: BatchRun): boolean {
  return batchRun.value?.id === run.id && scopeIsCurrent(run.scope);
}

function buildBatchItems(objects: OracleInvalidObject[]): BatchItem[] {
  return objects.map((object) => {
    const unsupportedReason = oracleCompileUnsupportedReason(databaseType.value, object.type);
    if (unsupportedReason) return { object, unsupportedReason, status: "unsupported" };
    try {
      return { object, sql: buildOracleCompileSql(databaseType.value, object.owner, object), status: "pending" };
    } catch (error) {
      return { object, unsupportedReason: "unsupported-type", status: "unsupported", message: formatError(error) };
    }
  });
}

async function readBatchPlan() {
  if (!props.open || compiling.value || batchRun.value?.state === "reading") return;
  generation.value++;
  const scope = captureExecutionScope();
  const run: BatchRun = reactive({
    id: uuid(),
    scope,
    state: "reading",
    readCount: 0,
    items: [],
    page: 0,
    stopRequested: false,
    submittedAny: false,
    currentName: "",
    readError: "",
    remainingError: "",
  });
  batchRun.value = run;
  try {
    const all = await readAllOracleInvalidObjects((sql, maxRows) => query(sql, maxRows, scope), scope.schema, {
      isCurrent: () => batchIsCurrent(run) && !run.stopRequested,
      onProgress: (count) => {
        if (batchIsCurrent(run)) run.readCount = count;
      },
    });
    if (!batchIsCurrent(run)) return;
    run.items = buildBatchItems(all);
    run.state = "confirm";
  } catch (error) {
    if (!batchIsCurrent(run)) return;
    run.state = "error";
    run.readError = run.stopRequested ? t("processList.oracleInvalidObjects.batchReadStopped") : writeErrorMessage(error);
  }
}

function refreshCurrentList() {
  const run = batchRun.value;
  if (run?.state === "reading" || run?.state === "confirm") {
    run.stopRequested = true;
    batchRun.value = null;
  }
  void loadList();
}

function stopBatch() {
  const run = batchRun.value;
  if (!run) return;
  if (run.state === "reading") run.stopRequested = true;
  else if (run.state === "running") run.stopRequested = true;
}

function changeBatchPage(delta: number) {
  const run = batchRun.value;
  if (run) run.page = Math.min(Math.max(0, run.page + delta), batchPageCount.value - 1);
}

function classifyBatchWriteFailure(error: unknown): "failed" | "unknown" {
  if (error instanceof BatchWriteError) return error.unknown ? "unknown" : "failed";
  return knownWriteRejection(error) ? "failed" : "unknown";
}

async function readBatchObjectErrors(run: BatchRun, item: BatchItem): Promise<void> {
  try {
    const result = await readObjectErrors(run.scope, item.object);
    if (!batchIsCurrent(run)) return;
    item.errors = result.errors;
    item.errorsTruncated = result.truncated;
  } catch (error) {
    if (batchIsCurrent(run)) item.message = `${item.message ? `${item.message}; ` : ""}${writeErrorMessage(error)}`;
  }
}

async function refreshBatchRemainder(run: BatchRun) {
  try {
    const remaining = await readAllOracleInvalidObjects((sql, maxRows) => query(sql, maxRows, run.scope), run.scope.schema, { isCurrent: () => scopeIsCurrent(run.scope) });
    if (!batchIsCurrent(run)) return;
    run.remaining = remaining;
    run.remainingError = "";
    objects.value = remaining.slice(0, 501);
    truncated.value = remaining.length > 501;
    const previous = selected.value;
    if (previous) {
      selected.value = remaining.find((object) => object.owner === previous.owner && object.objectId === previous.objectId) ?? null;
      if (!selected.value) {
        errors.value = [];
        errorsTruncated.value = false;
      }
    }
    loadError.value = "";
  } catch (error) {
    if (!batchIsCurrent(run)) return;
    run.remainingError = writeErrorMessage(error);
    objects.value = [];
    selected.value = null;
    errors.value = [];
    errorsTruncated.value = false;
    truncated.value = false;
    loadError.value = run.remainingError;
  }
}

async function executeBatchItem(run: BatchRun, item: BatchItem): Promise<boolean> {
  const object = item.object;
  if (!batchIsCurrent(run) || run.stopRequested || !item.sql) return false;
  let before;
  try {
    before = await readObjectStatus(run.scope, object);
  } catch (error) {
    if (batchIsCurrent(run)) {
      item.status = "failed";
      item.message = writeErrorMessage(error);
    }
    return true;
  }
  if (!batchIsCurrent(run)) return false;
  if (run.stopRequested) return false;
  if (before.rows.length === 0) {
    item.status = "deleted";
    item.message = t("processList.oracleInvalidObjects.batchDeleted");
    return true;
  }
  if (before.rows.length !== 1) {
    item.status = "unknown";
    item.message = t("processList.oracleInvalidObjects.batchIdentityUnknown");
    return true;
  }
  const beforeStatus = before.rows[0]![2];
  if (!objectIdMatches(object, before.rows[0])) {
    item.status = "target-changed";
    item.message = t("processList.oracleInvalidObjects.batchTargetChanged");
    return true;
  }
  if (beforeStatus === "VALID") {
    item.status = "already-valid";
    item.message = t("processList.oracleInvalidObjects.batchAlreadyValid");
    return true;
  }
  if (beforeStatus !== "INVALID") {
    item.status = "unknown";
    item.message = t("processList.oracleInvalidObjects.batchIdentityUnknown");
    return true;
  }
  if (!objectDdlTimeMatches(object, before.rows[0])) {
    item.status = "target-changed";
    item.message = t("processList.oracleInvalidObjects.batchTargetChanged");
    return true;
  }
  if (!batchIsCurrent(run) || run.stopRequested) return false;

  run.currentName = `${object.owner}.${object.name}`;
  run.submittedAny = true;
  try {
    await submitCompile(run.scope, item.sql);
  } catch (error) {
    if (!batchIsCurrent(run)) return false;
    const status = classifyBatchWriteFailure(error);
    item.status = status;
    item.message = writeErrorMessage(error);
    return status !== "unknown";
  }
  if (!batchIsCurrent(run)) return false;
  let after;
  try {
    after = await readObjectStatus(run.scope, object);
  } catch (error) {
    if (batchIsCurrent(run)) {
      item.status = "unknown";
      item.message = `${t("processList.oracleInvalidObjects.compileUnknown")} ${writeErrorMessage(error)}`;
    }
    return false;
  }
  if (!batchIsCurrent(run)) return false;
  if (after.rows.length === 0) {
    item.status = "deleted";
    item.message = t("processList.oracleInvalidObjects.batchDeleted");
    return true;
  }
  if (after.rows.length !== 1) {
    item.status = "unknown";
    item.message = t("processList.oracleInvalidObjects.compileUnknown");
    return false;
  }
  const [afterId, , afterStatus] = after.rows[0]!;
  if (String(afterId ?? "") !== object.objectId) {
    item.status = "target-changed";
    item.message = t("processList.oracleInvalidObjects.batchTargetChanged");
    return true;
  }
  if (afterStatus === "VALID") {
    item.status = "valid";
    item.message = t("processList.oracleInvalidObjects.compileValid");
  } else if (afterStatus === "INVALID") {
    item.status = "still-invalid";
    item.message = t("processList.oracleInvalidObjects.compileStillInvalid");
    await readBatchObjectErrors(run, item);
  } else {
    item.status = "unknown";
    item.message = t("processList.oracleInvalidObjects.compileUnknown");
    return false;
  }
  return true;
}

async function confirmBatchCompile() {
  const run = batchRun.value;
  if (!run || run.state !== "confirm" || batchSupportedCount.value === 0 || compiling.value || !batchIsCurrent(run)) return;
  const executionGeneration = ++batchExecutionGeneration;
  run.state = "running";
  run.stopRequested = false;
  compiling.value = true;
  const queue = run.items.filter((item) => !!item.sql);
  const auditSql = queue.map((item) => item.sql).join(";\n");
  try {
    const guarded = await executeWithProductionSqlGuard({
      connection: run.scope.connection,
      database: run.scope.schema,
      sql: auditSql,
      source: t("production.sourceAdmin"),
      execute: async () => {
        for (const item of queue) {
          if (!batchIsCurrent(run) || run.stopRequested) break;
          const keepGoing = await executeBatchItem(run, item);
          if (!keepGoing) break;
        }
        return true;
      },
    });
    if (!batchIsCurrent(run)) return;
    if (guarded === undefined) {
      for (const item of queue) if (item.status === "pending") item.status = "not-run";
      run.state = "results";
      run.currentName = "";
      run.readError = t("processList.oracleInvalidObjects.batchGuardDeclined");
      await refreshBatchRemainder(run);
      return;
    }
    for (const item of queue) if (item.status === "pending") item.status = "not-run";
    run.state = "results";
    run.currentName = "";
    await refreshBatchRemainder(run);
  } catch (error) {
    if (!batchIsCurrent(run)) return;
    run.readError = writeErrorMessage(error);
    for (const item of queue) if (item.status === "pending") item.status = "not-run";
    run.state = "results";
    await refreshBatchRemainder(run);
  } finally {
    if (run.submittedAny) emit("compile-finished", { connectionId: run.scope.connection.id, database: run.scope.database, schema: run.scope.schema });
    if (batchExecutionGeneration === executionGeneration) compiling.value = false;
  }
}

function batchStatusLabel(status: BatchStatus): string {
  return t(`processList.oracleInvalidObjects.batchStatus.${status}`);
}

function openBatchItemSource(item: BatchItem) {
  if (item.status === "still-invalid") emit("open-source", item.object);
}

function close() {
  generation.value++;
  emit("update:open", false);
}

watch(
  () => [props.open, JSON.stringify(props.connection), props.database, props.schema] as const,
  ([open], previous) => {
    const scopeChanged = !!previous && (previous[1] !== JSON.stringify(props.connection) || previous[2] !== props.database || previous[3] !== props.schema);
    if (scopeChanged || !open) {
      singleCompilationGeneration++;
      batchExecutionGeneration++;
      batchRun.value = null;
      singlePlan.value = null;
      previewSql.value = "";
      compiling.value = false;
    }
    if (previous && (previous[1] !== JSON.stringify(props.connection) || previous[2] !== props.database)) retireManagedSession();
    if (open) void loadList();
    else {
      generation.value++;
      objects.value = [];
      errors.value = [];
      errorsTruncated.value = false;
      selected.value = null;
      previewSql.value = "";
      outcome.value = "";
      closeCurrentManagedSession();
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  generation.value++;
  singleCompilationGeneration++;
  batchExecutionGeneration++;
  batchRun.value = null;
  closeCurrentManagedSession();
});
</script>

<template>
  <Dialog :open="open" @update:open="(value) => !value && close()">
    <DialogContent class="h-[min(85vh,760px)] max-h-[min(85vh,760px)] w-[calc(100vw-2rem)] max-w-5xl flex flex-col gap-0 overflow-hidden p-0" @interact-outside="(event) => compiling && event.preventDefault()" @escape-key-down="(event) => compiling && event.preventDefault()">
      <DialogHeader class="shrink-0 border-b px-5 py-4">
        <DialogTitle>{{ t("processList.oracleInvalidObjects.title") }} · {{ schema }}</DialogTitle>
      </DialogHeader>
      <div class="grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-[minmax(0,0.9fr)_minmax(0,1.1fr)] overflow-hidden md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)] md:grid-rows-[minmax(0,1fr)]">
        <section class="min-h-0 min-w-0 overflow-auto border-b md:border-r md:border-b-0" :aria-label="t('processList.oracleInvalidObjects.listLabel')">
          <div class="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-3 py-2 text-xs text-muted-foreground">
            <span>{{ t("processList.oracleInvalidObjects.listCount", { count: objects.length }) }}</span>
            <div class="flex items-center gap-1">
              <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-xs" :disabled="loading || compiling || batchRun?.state === 'reading'" @click="readBatchPlan"><Wrench class="h-3.5 w-3.5" />{{ t("processList.oracleInvalidObjects.compileAll") }}</Button>
              <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('common.refresh')" :disabled="loading || compiling" @click="refreshCurrentList"><RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" /></Button>
            </div>
          </div>
          <div v-if="loadError" class="m-3 rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">{{ loadError }}</div>
          <p v-else-if="!loading && objects.length === 0" class="px-4 py-8 text-center text-sm text-muted-foreground">{{ t("processList.oracleInvalidObjects.empty") }}</p>
          <button
            v-for="object in objects"
            :key="`${object.owner}:${object.objectId}`"
            type="button"
            class="flex w-full flex-col gap-1 border-b px-3 py-2.5 text-left text-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            :class="selected?.objectId === object.objectId ? 'bg-accent/60' : ''"
            :disabled="compiling"
            :aria-pressed="selected?.objectId === object.objectId"
            @click="selectObject(object)"
          >
            <span class="truncate font-medium text-foreground">{{ object.name }}</span>
            <span class="flex items-center gap-2 text-muted-foreground"
              ><span>{{ object.type }}</span
              ><span>{{ object.lastDdlTime }}</span></span
            >
          </button>
          <p v-if="truncated" class="border-t px-3 py-2 text-xs text-muted-foreground">{{ t("processList.oracleInvalidObjects.truncated") }}</p>
        </section>
        <section class="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <p v-if="outcome" class="m-3 rounded border bg-muted/20 p-3 text-xs" role="status">{{ outcome }}</p>
          <template v-if="batchRun">
            <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
              <div v-if="batchRun.state === 'reading'" class="space-y-3" role="status" aria-live="polite">
                <div class="font-medium">{{ t("processList.oracleInvalidObjects.batchReading") }}</div>
                <p class="text-sm text-muted-foreground">{{ t("processList.oracleInvalidObjects.batchReadProgress", { count: batchRun.readCount }) }}</p>
              </div>
              <div v-else-if="batchRun.state === 'error'" class="space-y-3" role="alert">
                <div class="font-medium">{{ t("processList.oracleInvalidObjects.batchReadFailed") }}</div>
                <p class="break-words text-sm text-destructive">{{ batchRun.readError }}</p>
                <p class="text-xs text-muted-foreground">{{ t("processList.oracleInvalidObjects.batchNoPartialPlan") }}</p>
              </div>
              <template v-else>
                <div class="mb-3 space-y-2">
                  <div class="text-sm font-semibold">{{ batchRun.state === "confirm" ? t("processList.oracleInvalidObjects.batchConfirmTitle") : batchRun.state === "running" ? t("processList.oracleInvalidObjects.batchRunning") : t("processList.oracleInvalidObjects.batchResults") }}</div>
                  <p class="text-xs text-muted-foreground">{{ t("processList.oracleInvalidObjects.batchScope", { connection: batchRun.scope.connection.name, database: batchRun.scope.database, schema: batchRun.scope.schema }) }}</p>
                  <p v-if="batchRun.state === 'confirm'" class="text-xs">{{ t("processList.oracleInvalidObjects.batchCounts", { total: batchRun.items.length, supported: batchSupportedCount, skipped: batchSkippedCount }) }}</p>
                  <p v-if="batchRun.state === 'confirm'" class="rounded border bg-muted/30 p-2 text-xs text-muted-foreground">{{ t("processList.oracleInvalidObjects.ddlWarning") }}</p>
                  <p v-if="batchRun.state === 'running'" role="status" aria-live="polite" class="rounded border bg-muted/30 p-2 text-xs">
                    {{
                      t("processList.oracleInvalidObjects.batchProgress", { handled: batchHandledCount, total: batchSupportedCount, current: batchRun.stopRequested ? t("processList.oracleInvalidObjects.batchStopping") : batchRun.currentName || t("processList.oracleInvalidObjects.batchRunning") })
                    }}
                  </p>
                  <div v-if="batchRun.state === 'results'" class="rounded border bg-muted/20 p-2 text-xs" role="status">
                    {{ t("processList.oracleInvalidObjects.batchSummary", { valid: batchValidCount, stillInvalid: batchStillInvalidCount, failed: batchFailureCount, skipped: batchSkippedCount }) }}
                    <span v-if="batchRun.remaining"> {{ t("processList.oracleInvalidObjects.batchRemaining", { count: batchRun.remaining.length }) }}</span>
                    <span v-else-if="batchRun.remainingError" class="text-destructive"> {{ t("processList.oracleInvalidObjects.batchRemainingUnknown", { message: batchRun.remainingError }) }}</span>
                  </div>
                  <p v-if="batchRun.readError && batchRun.state === 'results'" class="text-xs text-destructive" role="alert">{{ batchRun.readError }}</p>
                </div>
                <div v-if="batchRun.items.length" class="overflow-auto rounded border">
                  <div v-for="item in visibleBatchItems" :key="`${item.object.owner}:${item.object.objectId}`" class="space-y-1 border-b p-2.5 last:border-b-0">
                    <div class="flex items-start justify-between gap-2">
                      <div class="min-w-0">
                        <div class="break-all text-xs font-medium">
                          {{ item.object.owner }}.{{ item.object.name }} <span class="font-normal text-muted-foreground">· {{ item.object.type }}</span>
                        </div>
                        <div class="mt-1 text-xs text-muted-foreground">{{ batchStatusLabel(item.status) }}</div>
                      </div>
                      <Button v-if="item.status === 'still-invalid'" variant="outline" size="sm" class="h-7 shrink-0 px-2 text-xs" @click="openBatchItemSource(item)">{{ t("processList.oracleInvalidObjects.openSource") }}</Button>
                    </div>
                    <p v-if="item.message" class="break-words text-xs text-destructive">{{ item.message }}</p>
                    <p v-if="item.unsupportedReason" class="text-xs text-muted-foreground">{{ t(item.unsupportedReason === "unsupported-on-engine" ? "processList.oracleInvalidObjects.unsupportedOnEngine" : "processList.oracleInvalidObjects.unsupportedType") }}</p>
                    <p v-if="item.errorsTruncated" class="text-xs text-muted-foreground">{{ t("processList.oracleInvalidObjects.errorsTruncated") }}</p>
                    <div v-if="item.errors?.length" class="space-y-1 pl-2 text-xs text-muted-foreground">
                      <p v-for="error in item.errors.slice(0, 10)" :key="error.sequence" class="break-words font-mono">{{ error.line }}:{{ error.position }} {{ error.text }}</p>
                      <p v-if="item.errors.length > 10">{{ t("processList.oracleInvalidObjects.batchMoreErrors", { count: item.errors.length - 10 }) }}</p>
                    </div>
                    <details v-if="item.sql" class="text-xs">
                      <summary class="cursor-pointer text-muted-foreground">{{ t("processList.oracleInvalidObjects.batchSqlDetails") }}</summary>
                      <pre class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/30 p-2 font-mono">{{ item.sql }}</pre>
                    </details>
                  </div>
                </div>
                <p v-else-if="batchRun.state === 'confirm'" class="py-8 text-center text-sm text-muted-foreground">{{ t("processList.oracleInvalidObjects.batchEmpty") }}</p>
                <div v-if="batchRun.items.length > batchPageSize" class="mt-2 flex items-center justify-between text-xs">
                  <Button variant="ghost" size="sm" :disabled="batchRun.page === 0" @click="changeBatchPage(-1)">{{ t("processList.oracleInvalidObjects.batchPreviousPage") }}</Button>
                  <span>{{ t("processList.oracleInvalidObjects.batchPage", { current: batchRun.page + 1, total: batchPageCount }) }}</span>
                  <Button variant="ghost" size="sm" :disabled="batchRun.page + 1 >= batchPageCount" @click="changeBatchPage(1)">{{ t("processList.oracleInvalidObjects.batchNextPage") }}</Button>
                </div>
              </template>
            </div>
            <DialogFooter class="mx-0 mb-0 shrink-0 border-t px-4 py-3">
              <Button v-if="batchRun.state === 'reading' || batchRun.state === 'running'" variant="outline" :disabled="batchRun.stopRequested" @click="stopBatch">{{
                batchRun.state === "running" && batchRun.stopRequested ? t("processList.oracleInvalidObjects.batchStopping") : batchRun.state === "reading" ? t("processList.oracleInvalidObjects.batchStopReading") : t("processList.oracleInvalidObjects.batchStop")
              }}</Button>
              <Button v-if="batchRun.state === 'error'" variant="outline" @click="readBatchPlan">{{ t("processList.oracleInvalidObjects.batchRetryRead") }}</Button>
              <Button v-if="batchRun.state === 'confirm' || batchRun.state === 'error' || batchRun.state === 'results'" variant="outline" :disabled="compiling" @click="batchRun = null">{{ t("common.close") }}</Button>
              <Button v-if="batchRun.state === 'confirm'" variant="destructive" :disabled="batchSupportedCount === 0 || compiling" @click="confirmBatchCompile"
                ><Loader2 v-if="compiling" class="mr-1.5 h-3.5 w-3.5 animate-spin" />{{ t("processList.oracleInvalidObjects.batchConfirm", { count: batchSupportedCount }) }}</Button
              >
            </DialogFooter>
          </template>
          <template v-else-if="selected">
            <div class="flex items-start justify-between gap-3 border-b px-4 py-3">
              <div class="min-w-0">
                <div class="break-all text-sm font-semibold">{{ selected.owner }}.{{ selected.name }}</div>
                <div class="mt-1 text-xs text-muted-foreground">{{ selected.type }} · {{ t("processList.oracleInvalidObjects.objectId", { id: selected.objectId }) }}</div>
              </div>
              <Button variant="outline" size="sm" class="h-7 shrink-0 gap-1.5 text-xs" :disabled="compiling" @click="emit('open-source', selected)"><Wrench class="h-3.5 w-3.5" />{{ t("processList.oracleInvalidObjects.openSource") }}</Button>
            </div>
            <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
              <div class="mb-2 text-xs font-medium">{{ t("processList.oracleInvalidObjects.errorsTitle") }}</div>
              <div v-if="errorLoadError" class="rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">{{ errorLoadError }}</div>
              <p v-if="!errorLoadError && errorsTruncated" class="mb-2 rounded border bg-muted/30 p-2 text-xs text-muted-foreground">{{ t("processList.oracleInvalidObjects.errorsTruncated") }}</p>
              <p v-if="!errorLoadError && errors.length === 0" class="py-4 text-xs text-muted-foreground">{{ t("processList.oracleInvalidObjects.noErrors") }}</p>
              <div v-if="!errorLoadError && errors.length > 0" class="overflow-auto rounded border">
                <table class="w-full border-collapse text-xs">
                  <thead class="sticky top-0 bg-muted/60">
                    <tr>
                      <th class="px-2 py-1.5 text-left">{{ t("processList.oracleInvalidObjects.line") }}</th>
                      <th class="px-2 py-1.5 text-left">{{ t("processList.oracleInvalidObjects.position") }}</th>
                      <th class="px-2 py-1.5 text-left">{{ t("processList.oracleInvalidObjects.message") }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="error in errors" :key="error.sequence" class="border-t align-top">
                      <td class="whitespace-nowrap px-2 py-1.5 font-mono">{{ error.line }}</td>
                      <td class="whitespace-nowrap px-2 py-1.5 font-mono">{{ error.position }}</td>
                      <td class="break-words px-2 py-1.5 font-mono">{{ error.text }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-if="unsupportedReason" class="mt-3 flex items-start gap-2 rounded border bg-muted/30 p-3 text-xs text-muted-foreground">
                <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />{{ t(unsupportedReason === "unsupported-on-engine" ? "processList.oracleInvalidObjects.unsupportedOnEngine" : "processList.oracleInvalidObjects.unsupportedType") }}
              </p>
              <div v-if="previewSql" class="mt-3 space-y-2 rounded border bg-muted/20 p-3">
                <div class="text-xs font-medium">{{ t("processList.oracleInvalidObjects.singleConfirmTitle") }}</div>
                <div class="break-all text-xs">{{ singlePlan?.object.owner }}.{{ singlePlan?.object.name }} · {{ singlePlan?.object.type }} · {{ t("processList.oracleInvalidObjects.objectId", { id: singlePlan?.object.objectId }) }}</div>
                <p class="text-xs text-muted-foreground">{{ t("processList.oracleInvalidObjects.ddlWarning") }}</p>
                <details class="text-xs">
                  <summary class="cursor-pointer text-muted-foreground">{{ t("processList.oracleInvalidObjects.batchSqlDetails") }}</summary>
                  <pre class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/30 p-2 font-mono">{{ previewSql }}</pre>
                </details>
              </div>
            </div>
            <DialogFooter class="mx-0 mb-0 shrink-0 border-t px-4 py-3">
              <Button variant="outline" :disabled="compiling" @click="close">{{ t("common.close") }}</Button>
              <Button v-if="!previewSql" variant="destructive" :disabled="!!unsupportedReason || compiling || !!loadError" @click="prepareSingleCompile">{{ t("processList.oracleInvalidObjects.compile") }}</Button>
              <Button v-else variant="destructive" :disabled="compiling" @click="confirmCompile"><Loader2 v-if="compiling" class="mr-1.5 h-3.5 w-3.5 animate-spin" />{{ t("processList.oracleInvalidObjects.confirmCompile") }}</Button>
            </DialogFooter>
          </template>
          <p v-else class="m-auto max-w-sm px-6 text-center text-sm text-muted-foreground">{{ t("processList.oracleInvalidObjects.selectPrompt") }}</p>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
