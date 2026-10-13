<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/backend/api";
import type { ConnectionConfig } from "@/types/database";
import { loadOracleSecurity, oracleGrantSources, oracleObjectGrantSources, oracleSecurityObjectMatches, ORACLE_SECURITY_ROW_LIMIT, type OracleSecuritySnapshot, type SecurityRead } from "@/lib/database/oracleSecurity";

const props = defineProps<{ connection: ConnectionConfig }>();
const { t } = useI18n();
const connectionStore = useConnectionStore();
const snapshot = ref<OracleSecuritySnapshot>();
const busy = ref(false);
const error = ref("");
const principal = ref("");
const owner = ref("");
const objectName = ref("");
const search = ref("");
let generation = 0;
const principals = computed(() => (snapshot.value ? [...new Set([...snapshot.value.users.rows.map((row) => row.name), ...snapshot.value.roles.rows.map((row) => row.name), "PUBLIC", principal.value])].filter((name) => name && (name === principal.value || name.includes(search.value))) : []));
const sources = computed(() => (snapshot.value ? (principal.value ? oracleGrantSources(snapshot.value, principal.value) : { grants: oracleObjectGrantSources(snapshot.value), bounded: false }) : { grants: [], bounded: false }));
const grants = computed(() => sources.value.grants.filter((row) => (!owner.value && !objectName.value) || oracleSecurityObjectMatches(row.grant, owner.value, objectName.value)));
const memberships = computed(() => snapshot.value?.roleGrants.rows.filter((row) => !principal.value || row.grantee === principal.value || row.role === principal.value) ?? []);
const sections = computed(() => (snapshot.value ? Object.entries(snapshot.value) : []));
const grantsIncomplete = computed(() => {
  if (!snapshot.value) return true;
  const reads: SecurityRead<unknown>[] = [snapshot.value.objectGrants, snapshot.value.columnGrants];
  if (principal.value) reads.push(snapshot.value.roleGrants, snapshot.value.systemGrants);
  return sources.value.bounded || reads.some((read) => !["ok", "empty"].includes(read.state) || read.visibility === "limited");
});
const selectedUser = computed(() => snapshot.value?.users.rows.find((row) => row.name === principal.value));
const selectedRole = computed(() => snapshot.value?.roles.rows.find((row) => row.name === principal.value));
const stateLabel = (state: string) =>
  ({
    ok: t("oracleSecurity.loaded"),
    empty: t("oracleSecurity.empty"),
    denied: t("oracleSecurity.denied"),
    unavailable: t("oracleSecurity.unavailable"),
    error: t("oracleSecurity.error"),
    unsupported: t("oracleSecurity.unsupported"),
  })[state] ?? state;

async function refresh() {
  const request = ++generation;
  const connection = { ...props.connection };
  const connectionId = connection.id;
  busy.value = true;
  error.value = "";
  snapshot.value = undefined;
  try {
    await connectionStore.ensureConnected(connectionId);
    if (request !== generation) return;
    const next = await loadOracleSecurity((sql) => {
      if (request !== generation) throw new Error("Request superseded");
      return api.executeQuery(connectionId, "", sql, undefined, undefined, { maxRows: ORACLE_SECURITY_ROW_LIMIT });
    }, connection);
    if (request !== generation) return;
    snapshot.value = next;
    if (!principal.value) principal.value = next.currentUser.rows[0] ?? "";
  } catch (cause) {
    if (request === generation) error.value = String(cause);
  } finally {
    if (request === generation) busy.value = false;
  }
}
watch(
  () => props.connection.id,
  () => {
    snapshot.value = undefined;
    principal.value = "";
    owner.value = "";
    objectName.value = "";
    void refresh();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
});
defineExpose({ refresh });
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4" data-oracle-security>
    <header class="flex items-center gap-3">
      <h2 class="text-sm font-semibold">{{ t("oracleSecurity.title") }}</h2>
      <Button variant="outline" size="sm" :disabled="busy" @click="refresh">{{ busy ? t("common.loading") : t("grid.refresh") }}</Button>
    </header>
    <p class="text-xs text-muted-foreground">
      {{ t("oracleSecurity.notice") }}
    </p>
    <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
    <div v-if="snapshot" class="grid gap-2 text-xs sm:grid-cols-2">
      <details v-for="[name, result] in sections" :key="name" class="rounded border p-2" :data-security-state="result.state">
        <summary>{{ t(`oracleSecurity.${name}`) }} · {{ stateLabel(result.state) }} · {{ result.rows.length }} · {{ result.visibility === "complete" ? t("oracleSecurity.full") : t("oracleSecurity.limited") }}{{ result.truncated ? t("oracleSecurity.truncated") : "" }}</summary>
        <p v-if="result.message" class="mt-2 whitespace-pre-wrap text-destructive">{{ result.message }}</p>
        <pre class="mt-2 overflow-auto whitespace-pre-wrap">{{ result.source }}</pre>
      </details>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <Input v-model="search" class="w-40" :placeholder="t('oracleSecurity.filter')" />
      <select v-model="principal" class="h-9 max-w-72 rounded border bg-background px-2 text-sm" :aria-label="t('oracleSecurity.principal')">
        <option value="">{{ t("oracleSecurity.all") }}</option>
        <option v-for="name in principals" :key="name" :value="name">{{ name }}</option>
      </select>
      <Input v-model="owner" class="w-40" :placeholder="t('oracleSecurity.owner')" />
      <Input v-model="objectName" class="w-48" :placeholder="t('oracleSecurity.objectName')" />
    </div>
    <p v-if="selectedUser" class="text-xs">{{ selectedUser.name }} · {{ selectedUser.accountStatus || t("oracleSecurity.accountUnavailable") }} · {{ selectedUser.profile }}</p>
    <p v-if="selectedRole" class="text-xs">{{ t("oracleSecurity.role") }} {{ selectedRole.name }} · PASSWORD_REQUIRED: {{ selectedRole.authentication || t("oracleSecurity.unknown") }}</p>
    <p v-if="sources.bounded" role="alert" class="text-xs text-destructive">{{ t("oracleSecurity.bounded") }}</p>
    <table class="w-full text-left text-xs">
      <thead>
        <tr class="border-b">
          <th class="p-2">{{ t("oracleSecurity.kind") }}</th>
          <th>{{ t("oracleSecurity.privilege") }}</th>
          <th>{{ t("oracleSecurity.object") }}</th>
          <th>{{ t("oracleSecurity.source") }}</th>
          <th>{{ t("oracleSecurity.grantOption") }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in grants" :key="index" class="border-b">
          <td class="p-2">{{ t(`oracleSecurity.${row.kind}`) }}</td>
          <td>{{ row.grant.privilege }}</td>
          <td>{{ "owner" in row.grant ? `${row.grant.owner}.${row.grant.objectName}` : "—" }}{{ "columnName" in row.grant ? `.${row.grant.columnName}` : "" }}</td>
          <td>{{ t(`oracleSecurity.${row.source}`) }} · {{ row.grant.grantee }}{{ row.rolePath.length ? ` (${row.rolePath.join(" → ")})` : "" }}{{ "grantor" in row.grant ? ` · grantor: ${row.grant.grantor || t("oracleSecurity.unknownGrantor")}` : "" }}</td>
          <td>{{ t(("adminOption" in row.grant ? row.grant.adminOption : row.grant.grantable) ? "oracleSecurity.yes" : "oracleSecurity.no") }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="snapshot && grantsIncomplete" role="status" class="text-xs text-muted-foreground">{{ t("oracleSecurity.incomplete") }}</p>
    <p v-else-if="snapshot && !grants.length" class="text-xs text-muted-foreground">{{ t("oracleSecurity.noGrants") }}</p>
    <h3 class="text-sm font-medium">{{ t("oracleSecurity.memberships") }}</h3>
    <table class="w-full text-left text-xs">
      <thead>
        <tr class="border-b">
          <th class="p-2">{{ t("oracleSecurity.grantee") }}</th>
          <th>{{ t("oracleSecurity.role") }}</th>
          <th>ADMIN OPTION</th>
          <th>DEFAULT ROLE</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in memberships" :key="index" class="border-b">
          <td class="p-2">{{ row.grantee }}</td>
          <td>{{ row.role }}</td>
          <td>{{ t(row.adminOption ? "oracleSecurity.yes" : "oracleSecurity.no") }}</td>
          <td>{{ row.defaultRole === undefined ? t("oracleSecurity.unknown") : t(row.defaultRole ? "oracleSecurity.yes" : "oracleSecurity.no") }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
