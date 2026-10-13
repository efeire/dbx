<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import type { OracleRoutineRenamePlan } from "@/lib/table/oracleRoutineRename";

const props = defineProps<{ plan: OracleRoutineRenamePlan | null; loading: boolean; executing: boolean }>();
const emit = defineEmits<{ reload: [] }>();
const { t } = useI18n();
const busy = computed(() => props.loading || props.executing);
</script>

<template>
  <section class="space-y-3 text-sm" :aria-busy="busy">
    <p class="text-xs leading-relaxed text-muted-foreground">{{ t("objects.routineRenameCoverage") }}</p>
    <p v-if="loading" role="status" class="text-muted-foreground">{{ t("common.loading") }}</p>
    <p v-else-if="!plan?.executable" role="status" class="text-destructive">{{ t("objects.viewRenameValidationPending") }}</p>
    <div v-if="plan?.root" class="rounded border border-border p-3">
      <p class="mb-2 font-medium">{{ t("objects.routineRenameObjects") }}</p>
      <ul class="space-y-1 text-xs text-muted-foreground">
        <li>{{ plan.root.objectType }} · {{ plan.target.schema }}.{{ plan.target.oldName }} → {{ plan.target.schema }}.{{ plan.canonicalNewName }}</li>
        <li v-for="caller in plan.callers" :key="`${caller.objectType}:${caller.name}`">{{ caller.objectType }} · {{ plan.target.schema }}.{{ caller.name }} · {{ t(caller.rewriteRequired ? "objects.routineRenameRewrite" : "objects.routineRenameCompile") }}</li>
      </ul>
    </div>
    <ul v-if="plan?.issues.length" class="space-y-2" aria-live="polite">
      <li v-for="(issue, index) in plan.issues" :key="index" class="rounded border border-destructive/40 p-2">
        <p class="font-medium text-destructive">{{ issue.objectName || plan.target.oldName }} · {{ t("objects.viewRenameNeedsRepair") }}</p>
        <details class="mt-1 text-xs text-muted-foreground" data-diagnostics>
          <summary class="cursor-pointer">{{ t("objects.viewRenameDiagnostics") }}</summary>
          <pre class="mt-1 whitespace-pre-wrap break-all">{{ issue.message }}</pre>
        </details>
      </li>
    </ul>
    <details v-if="plan?.statements.length" class="rounded border border-border" open>
      <summary class="cursor-pointer px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{{ t("objects.viewRenameFinalSql") }}</summary>
      <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-border p-3 font-mono text-xs">{{ plan.statements.join("\n\n") }}</pre>
    </details>
    <Button type="button" variant="outline" size="sm" :disabled="busy" data-reload @click="emit('reload')">{{ t("objects.viewRenameReload") }}</Button>
  </section>
</template>
