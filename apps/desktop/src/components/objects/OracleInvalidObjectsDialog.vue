<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { AlertTriangle, Loader2, RefreshCw, Wrench } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ConnectionConfig, DatabaseType } from "@/types/database";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import {
  oracleCompileUnsupportedReason,
  buildOracleCompileSql,
  buildOracleInvalidObjectsSql,
  buildOracleObjectErrorsSql,
  buildOracleObjectIdentitySql,
  buildOracleObjectStatusSql,
  mapOracleInvalidObjects,
  mapOracleObjectErrors,
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
const generation = ref(0);
type ManagedSession = { id: string; connectionId: string; database: string; active: number; closeRequested: boolean; closed: boolean };
function newManagedSession(connectionId: string, database: string): ManagedSession {
  return { id: `invalid-objects:${crypto.randomUUID()}`, connectionId, database, active: 0, closeRequested: false, closed: false };
}
let managedSession = newManagedSession(props.connection.id, props.database);
const databaseType = computed(() => (effectiveDatabaseTypeForConnection(props.connection) ?? props.connection.db_type) as DatabaseType);

function isCurrent(token: number): boolean {
  return token === generation.value && props.open;
}

async function query(sql: string, maxRows = 501) {
  const connectionId = props.connection.id;
  const database = props.database;
  if (managedSession.connectionId !== connectionId || managedSession.database !== database || managedSession.closeRequested || managedSession.closed) rotateManagedSession(connectionId, database);
  const session = managedSession;
  session.active++;
  try {
    return await api.executeQuery(connectionId, database, sql, props.schema, undefined, { maxRows, clientSessionId: session.id });
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

function rotateManagedSession(connectionId: string, database: string) {
  const previous = managedSession;
  managedSession = newManagedSession(connectionId, database);
  previous.closeRequested = true;
  closeManagedSession(previous);
}

function closeCurrentManagedSession() {
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
    const result = await query(buildOracleObjectErrorsSql(object.owner, object), 1000);
    if (!isCurrent(token) || selected.value?.objectId !== object.objectId) return;
    errors.value = mapOracleObjectErrors(result.rows);
    errorsTruncated.value = result.truncated === true || result.rows.length >= 1000;
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
  outcome.value = "";
  void loadErrors(object);
}

const unsupportedReason = computed(() => (selected.value ? oracleCompileUnsupportedReason(databaseType.value, selected.value.type) : "unsupported-type"));

function previewCompile() {
  if (!selected.value || unsupportedReason.value || compiling.value) return;
  try {
    previewSql.value = buildOracleCompileSql(databaseType.value, selected.value.owner, selected.value);
    outcome.value = "";
  } catch (error) {
    outcome.value = error instanceof Error ? error.message : String(error);
  }
}

async function confirmCompile() {
  const target = selected.value;
  const sql = previewSql.value;
  if (!target || !sql || unsupportedReason.value || compiling.value) return;
  const token = generation.value;
  const connection = { ...props.connection };
  const database = props.database;
  const schema = target.owner || props.schema;
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
        if (!isCurrent(token) || props.connection.id !== connection.id || props.database !== database) throw new Error(t("processList.oracleInvalidObjects.targetChanged"));
        const identity = await query(buildOracleObjectIdentitySql(target.owner, target), 2);
        const row = identity.rows[0];
        if (!isCurrent(token)) return undefined;
        if (!row || String(row[0]) !== target.objectId || String(row[1] ?? "") !== target.lastDdlTime) {
          previewSql.value = "";
          await loadList(token);
          outcome.value = t("processList.oracleInvalidObjects.targetChanged");
          return undefined;
        }
        actionSubmitted = true;
        return query(sql, 1);
      },
    });
    if (!isCurrent(token)) return;
    if (result === undefined) return;
    const statusResult = await query(buildOracleObjectStatusSql(target.owner, target), 2);
    if (!isCurrent(token)) return;
    const statusRow = statusResult.rows.length === 1 ? statusResult.rows[0] : undefined;
    // Compilation is DDL and can update LAST_DDL_TIME on the same object.
    // OBJECT_ID distinguishes a replacement; the preflight above still checks both fields.
    const sameObject = statusRow && String(statusRow[0]) === target.objectId;
    const status = sameObject ? String(statusRow[2] ?? "") : "";
    await loadList(token, { allowLastDdlTimeChange: true });
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
  } catch (error) {
    if (isCurrent(token)) {
      if (actionSubmitted) {
        previewSql.value = "";
        await loadList(token);
        outcome.value = `${t("processList.oracleInvalidObjects.compileUnknown")} ${error instanceof Error ? error.message : String(error)}`;
      } else {
        outcome.value = t("processList.oracleInvalidObjects.compileFailed", { message: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    if (actionSubmitted) emit("compile-finished", { connectionId: connection.id, database, schema });
    compiling.value = false;
  }
}

function close() {
  generation.value++;
  emit("update:open", false);
}

watch(
  () => [props.open, JSON.stringify(props.connection), props.database, props.schema] as const,
  ([open], previous) => {
    if (previous && (previous[1] !== JSON.stringify(props.connection) || previous[2] !== props.database)) rotateManagedSession(props.connection.id, props.database);
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
  closeCurrentManagedSession();
});
</script>

<template>
  <Dialog :open="open" @update:open="(value) => !value && close()">
    <DialogContent class="max-h-[min(85vh,760px)] max-w-5xl overflow-hidden p-0" @interact-outside="(event) => compiling && event.preventDefault()" @escape-key-down="(event) => compiling && event.preventDefault()">
      <DialogHeader class="border-b px-5 py-4">
        <DialogTitle>{{ t("processList.oracleInvalidObjects.title") }} · {{ schema }}</DialogTitle>
      </DialogHeader>
      <div class="grid min-h-0 grid-cols-[minmax(16rem,0.9fr)_minmax(20rem,1.3fr)] overflow-hidden">
        <section class="min-h-0 overflow-auto border-r" :aria-label="t('processList.oracleInvalidObjects.listLabel')">
          <div class="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-3 py-2 text-xs text-muted-foreground">
            <span>{{ t("processList.oracleInvalidObjects.listCount", { count: objects.length }) }}</span>
            <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('common.refresh')" :disabled="loading || compiling" @click="loadList()"><RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" /></Button>
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
        <section class="flex min-h-0 flex-col overflow-hidden">
          <p v-if="outcome" class="m-3 rounded border bg-muted/20 p-3 text-xs" role="status">{{ outcome }}</p>
          <template v-if="selected">
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
              <div v-if="previewSql" class="mt-3 rounded border bg-muted/20 p-3">
                <div class="mb-1 text-xs font-medium">{{ t("processList.oracleInvalidObjects.preview") }}</div>
                <pre class="overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{{ previewSql }}</pre>
                <p class="mt-2 text-xs text-muted-foreground">{{ t("processList.oracleInvalidObjects.ddlWarning") }}</p>
              </div>
            </div>
            <DialogFooter class="border-t px-4 py-3">
              <Button variant="outline" :disabled="compiling" @click="close">{{ t("common.close") }}</Button>
              <Button v-if="!previewSql" variant="destructive" :disabled="!!unsupportedReason || compiling || !!loadError" @click="previewCompile">{{ t("processList.oracleInvalidObjects.previewCompile") }}</Button>
              <Button v-else variant="destructive" :disabled="compiling" @click="confirmCompile"><Loader2 v-if="compiling" class="mr-1.5 h-3.5 w-3.5 animate-spin" />{{ t("processList.oracleInvalidObjects.confirmCompile") }}</Button>
            </DialogFooter>
          </template>
          <p v-else class="m-auto max-w-sm px-6 text-center text-sm text-muted-foreground">{{ t("processList.oracleInvalidObjects.selectPrompt") }}</p>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
