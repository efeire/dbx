<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { OraclePackageSaveAsPlan } from "@/lib/table/oraclePackageSaveAs";

const props = defineProps<{
  open: boolean;
  oldName: string;
  newName: string;
  plan: OraclePackageSaveAsPlan | null;
  error: string;
  diagnostic: string;
  loading: boolean;
  executing: boolean;
}>();
const emit = defineEmits<{
  "update:open": [value: boolean];
  "update:newName": [value: string];
  confirm: [];
}>();
const { t } = useI18n();
const busy = computed(() => props.loading || props.executing);
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-[min(90vw,900px)]">
      <DialogHeader>
        <DialogTitle>{{ t("objects.packageSaveAsTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <p class="text-sm text-muted-foreground">{{ t("objects.packageSaveAsHint", { name: oldName }) }}</p>
        <Input :model-value="newName" :placeholder="t('contextMenu.renameObjectNamePlaceholder')" :disabled="busy" @update:model-value="emit('update:newName', $event)" />
        <p v-if="loading" role="status" class="text-sm text-muted-foreground">{{ t("common.loading") }}</p>
        <div v-if="plan" class="grid gap-2">
          <p v-if="!plan.metadataComplete" class="text-sm text-destructive">{{ t("objects.packageSaveAsMetadataProblem") }}</p>
          <ul v-if="plan.issues.length" class="list-disc space-y-1 pl-5 text-sm text-destructive" aria-live="polite">
            <li v-for="(issue, index) in plan.issues" :key="index">
              {{ t("objects.packageSaveAsMetadataProblem") }}
              <details class="mt-1 text-xs text-muted-foreground">
                <summary class="cursor-pointer">{{ t("objects.viewRenameDiagnostics") }}</summary>
                <pre class="mt-1 whitespace-pre-wrap break-all">{{ issue.message }}</pre>
              </details>
            </li>
          </ul>
          <p v-if="plan.snapshot" class="text-xs text-muted-foreground">
            {{ t("objects.package") }} · {{ plan.target.schema }}.{{ plan.target.oldName }}
            <span v-if="plan.bodySource !== null"> · {{ t("objects.packageBody") }}</span>
          </p>
          <pre v-if="plan.statements.length" class="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 font-mono text-xs">{{ plan.statements.join("\n\n") }}</pre>
        </div>
        <p v-if="error" class="break-words text-sm text-destructive">{{ error }}</p>
        <details v-if="diagnostic" class="text-xs text-muted-foreground">
          <summary class="cursor-pointer">{{ t("objects.viewRenameDiagnostics") }}</summary>
          <pre class="mt-1 whitespace-pre-wrap break-all">{{ diagnostic }}</pre>
        </details>
      </div>
      <DialogFooter>
        <Button variant="outline" :disabled="executing" @click="emit('update:open', false)">{{ t("dangerDialog.cancel") }}</Button>
        <Button data-confirm :disabled="busy || !plan?.executable || !newName.trim() || newName.trim() === oldName" @click="emit('confirm')">
          {{ t("objects.packageSaveAsTitle") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
