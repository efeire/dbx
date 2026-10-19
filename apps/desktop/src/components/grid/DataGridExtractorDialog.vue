<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DATA_GRID_COPY_EXTRACTOR_DESCRIPTORS,
  DATA_GRID_COPY_EXTRACTOR_IDS,
  DATA_GRID_DEFAULT_VISIBLE_COPY_EXTRACTORS,
  normalizeVisibleDataGridCopyExtractors,
  normalizeDataGridExtractorOptions,
  validateDataGridExtractorOptions,
  type DataGridCopyExtractorId,
  type DataGridCopyPreference,
  type DataGridExtractorOptions,
  type DataGridExtractPreview,
  type DataGridExtractWarningCode,
  type DataGridValueFormat,
} from "@/lib/dataGrid/dataGridCopyExtractor";

const props = defineProps<{
  open: boolean;
  preference: DataGridCopyPreference;
  sourceTableName?: string;
  visibleCopyExtractors: DataGridCopyExtractorId[];
  options: DataGridExtractorOptions;
  items: Array<{ value: DataGridCopyPreference; label: string; disabled?: boolean }>;
  visibleItems: Array<{ value: DataGridCopyExtractorId; label: string; disabled?: boolean }>;
  preview: (preference: DataGridCopyPreference, options: DataGridExtractorOptions) => Promise<DataGridExtractPreview>;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  save: [value: { preference: DataGridCopyPreference; options: DataGridExtractorOptions; visibleCopyExtractors: DataGridCopyExtractorId[] }];
}>();

const { t } = useI18n();
const draftPreference = ref<DataGridCopyPreference>(props.preference);
const draftOptions = ref<DataGridExtractorOptions>(normalizeDataGridExtractorOptions(props.options));
const draftVisibleCopyExtractors = ref<DataGridCopyExtractorId[]>(normalizeVisibleDataGridCopyExtractors(props.visibleCopyExtractors));
const previewText = ref("");
const previewError = ref("");
const previewWarnings = ref<string[]>([]);
const previewLoading = ref(false);
const previewTruncatedRows = ref(0);
let previewSequence = 0;
let previewTimer: ReturnType<typeof setTimeout> | undefined;

const draftExtractor = computed<DataGridCopyExtractorId | null>(() => (draftPreference.value === "smart" ? null : draftPreference.value));
const extractorCategory = computed(() => (draftExtractor.value ? DATA_GRID_COPY_EXTRACTOR_DESCRIPTORS[draftExtractor.value].category : null));
const isDsv = computed(() => extractorCategory.value === "delimited");
const supportsCsvOptions = computed(() => draftExtractor.value === "csv" || draftExtractor.value === "csv-with-headers" || draftExtractor.value === "dsv");
const isSql = computed(() => draftExtractor.value === "sql-inserts" || draftExtractor.value === "sql-deletes-inserts" || draftExtractor.value === "sql-updates");
const isJson = computed(() => extractorCategory.value === "json");
const isDbunit = computed(() => draftExtractor.value === "dbunit");
const isPhp = computed(() => draftExtractor.value === "php");
const optionsError = computed(() => {
  if (!draftExtractor.value) return "";
  if (draftExtractor.value === "dbunit" && !props.sourceTableName && !draftOptions.value.dbunit.tableName.trim()) return t("grid.copyDbunitTableNameRequired");
  if (draftExtractor.value === "php" && draftOptions.value.php.variableName !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(draftOptions.value.php.variableName)) return t("grid.copyPhpVariableInvalid");
  if (draftExtractor.value === "php" && draftOptions.value.php.rowDelimiter.length > 8) return t("grid.copyExtractorValidation.separator-too-long");
  const code = validateDataGridExtractorOptions(draftExtractor.value, draftOptions.value);
  if (!code) return "";
  return t(`grid.copyExtractorValidation.${code}`);
});

function visibleSeparator(value: string): string {
  return value.replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function separatorValue(value: string): string {
  return value.replace(/\\t/g, "\t").replace(/\\r/g, "\r").replace(/\\n/g, "\n");
}

function updateDsv<K extends keyof DataGridExtractorOptions["dsv"]>(key: K, value: DataGridExtractorOptions["dsv"][K]) {
  draftOptions.value = { ...draftOptions.value, dsv: { ...draftOptions.value.dsv, [key]: value } };
}

function updateSql<K extends keyof DataGridExtractorOptions["sql"]>(key: K, value: DataGridExtractorOptions["sql"][K]) {
  draftOptions.value = { ...draftOptions.value, sql: { ...draftOptions.value.sql, [key]: value } };
}

function updateJson<K extends keyof DataGridExtractorOptions["json"]>(key: K, value: DataGridExtractorOptions["json"][K]) {
  draftOptions.value = { ...draftOptions.value, json: { ...draftOptions.value.json, [key]: value } };
}

function updateDbunit<K extends keyof DataGridExtractorOptions["dbunit"]>(key: K, value: DataGridExtractorOptions["dbunit"][K]) {
  draftOptions.value = { ...draftOptions.value, dbunit: { ...draftOptions.value.dbunit, [key]: value } };
}

function updatePhp<K extends keyof DataGridExtractorOptions["php"]>(key: K, value: DataGridExtractorOptions["php"][K]) {
  draftOptions.value = { ...draftOptions.value, php: { ...draftOptions.value.php, [key]: value } };
}

function toggleVisibleCopyExtractor(extractor: DataGridCopyExtractorId, visible: boolean) {
  const current = new Set(draftVisibleCopyExtractors.value);
  if (visible) current.add(extractor);
  else current.delete(extractor);
  draftVisibleCopyExtractors.value = DATA_GRID_COPY_EXTRACTOR_IDS.filter((item) => current.has(item));
}

async function refreshPreview() {
  const sequence = ++previewSequence;
  previewLoading.value = true;
  previewError.value = "";
  previewWarnings.value = [];
  previewTruncatedRows.value = 0;
  if (optionsError.value) {
    previewError.value = optionsError.value;
    previewLoading.value = false;
    return;
  }
  try {
    const result = await props.preview(draftPreference.value, normalizeDataGridExtractorOptions(draftOptions.value));
    if (sequence === previewSequence) {
      previewText.value = result.text;
      previewWarnings.value = (result.warnings ?? []).map((warning) => warningText(warning.code, result.omittedColumns));
      previewTruncatedRows.value = result.truncated ? result.sourceRowCount : 0;
    }
  } catch (error: unknown) {
    if (sequence === previewSequence) {
      previewText.value = "";
      previewError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (sequence === previewSequence) previewLoading.value = false;
  }
}

function warningText(code: DataGridExtractWarningCode, omittedColumns: string[] | undefined): string {
  if (code === "omitted-columns") return t("grid.copyExtractorWarningOmittedColumns", { columns: omittedColumns?.join(", ") || "-" });
  if (code === "php-date-not-iso") return t("grid.copyExtractorWarningPhpDateNotIso");
  return t("grid.copyExtractorWarningDuplicateJsonColumns");
}

function schedulePreview() {
  previewSequence += 1;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void refreshPreview(), 180);
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = undefined;
      previewSequence += 1;
      previewLoading.value = false;
      return;
    }
    draftPreference.value = props.preference;
    draftOptions.value = normalizeDataGridExtractorOptions(props.options);
    draftVisibleCopyExtractors.value = normalizeVisibleDataGridCopyExtractors(props.visibleCopyExtractors);
    schedulePreview();
  },
  { immediate: true },
);

watch(
  [draftPreference, draftOptions],
  () => {
    if (props.open) schedulePreview();
  },
  { deep: true },
);

onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer);
  previewSequence += 1;
});

function save() {
  if (optionsError.value) return;
  emit("save", { preference: draftPreference.value, options: normalizeDataGridExtractorOptions(draftOptions.value), visibleCopyExtractors: [...draftVisibleCopyExtractors.value] });
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-[760px]">
      <DialogHeader
        ><DialogTitle>{{ t("grid.copyExtractorConfigure") }}</DialogTitle></DialogHeader
      >

      <div class="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
        <div class="space-y-3">
          <div class="space-y-1.5">
            <Label>{{ t("grid.copyExtractorDefaultFormat") }}</Label>
            <Select v-model="draftPreference">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="item in items" :key="item.value" :value="item.value" :disabled="item.disabled">{{ item.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <p v-if="draftExtractor === 'raw'" class="text-xs text-muted-foreground">{{ t("grid.copyExtractorRawHint") }}</p>

          <div v-if="draftExtractor && draftExtractor !== 'raw' && !isSql" class="space-y-1.5">
            <Label>{{ t("grid.copyExtractorValueFormat") }}</Label>
            <Select :model-value="draftOptions.valueFormat" @update:model-value="draftOptions = { ...draftOptions, valueFormat: $event as DataGridValueFormat }">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent
                ><SelectItem value="default">{{ t("grid.copyExtractorValueFormatDefault") }}</SelectItem
                ><SelectItem value="legacy">{{ t("grid.copyExtractorValueFormatLegacy") }}</SelectItem
                ><SelectItem value="display">{{ t("grid.copyExtractorValueFormatDisplay") }}</SelectItem
                ><SelectItem value="edit">{{ t("grid.copyExtractorValueFormatEdit") }}</SelectItem
                ><SelectItem value="native">{{ t("grid.copyExtractorValueFormatNative") }}</SelectItem></SelectContent
              >
            </Select>
          </div>

          <template v-if="isDsv">
            <div v-if="draftExtractor === 'dsv'" class="space-y-1.5">
              <Label>{{ t("grid.copyExtractorColumnSeparator") }}</Label>
              <Input :model-value="visibleSeparator(draftOptions.dsv.columnSeparator)" @update:model-value="updateDsv('columnSeparator', separatorValue(String($event)))" />
            </div>
            <div v-if="draftExtractor !== 'one-row'" class="space-y-1.5">
              <Label>{{ t("grid.copyExtractorRowSeparator") }}</Label>
              <Input :model-value="visibleSeparator(draftOptions.dsv.rowSeparator)" @update:model-value="updateDsv('rowSeparator', separatorValue(String($event)))" />
            </div>
            <div v-if="supportsCsvOptions" class="space-y-1.5">
              <Label>{{ t("grid.copyExtractorNullText") }}</Label>
              <Input :model-value="draftOptions.dsv.nullText" @update:model-value="updateDsv('nullText', String($event))" />
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="space-y-1.5">
                <Label>{{ t("grid.copyExtractorQuote") }}</Label>
                <Input maxlength="1" :model-value="draftOptions.dsv.quote" @update:model-value="updateDsv('quote', String($event))" />
              </div>
              <div class="space-y-1.5">
                <Label>{{ t("grid.copyExtractorQuotePolicy") }}</Label>
                <Select :model-value="draftOptions.dsv.quotePolicy" @update:model-value="updateDsv('quotePolicy', $event as DataGridExtractorOptions['dsv']['quotePolicy'])">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="minimal">{{ t("grid.copyExtractorQuoteMinimal") }}</SelectItem>
                    <SelectItem value="always">{{ t("grid.copyExtractorQuoteAlways") }}</SelectItem>
                    <SelectItem value="never">{{ t("grid.copyExtractorQuoteNever") }}</SelectItem>
                    <SelectItem value="strings">{{ t("grid.copyExtractorQuoteStrings") }}</SelectItem>
                    <SelectItem value="all-but-numbers">{{ t("grid.copyExtractorQuoteAllButNumbers") }}</SelectItem>
                    <SelectItem value="all-including-nulls">{{ t("grid.copyExtractorQuoteAllIncludingNulls") }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div v-if="supportsCsvOptions" class="space-y-1.5">
              <Label>{{ t("grid.copyExtractorHeaderPosition") }}</Label>
              <Select :model-value="draftOptions.dsv.headerPosition" @update:model-value="updateDsv('headerPosition', $event as DataGridExtractorOptions['dsv']['headerPosition'])">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent
                  ><SelectItem value="legacy">{{ t("grid.copyExtractorHeaderLegacy") }}</SelectItem
                  ><SelectItem value="none">{{ t("grid.copyExtractorHeaderNone") }}</SelectItem
                  ><SelectItem value="top">{{ t("grid.copyExtractorHeaderTop") }}</SelectItem
                  ><SelectItem value="bottom">{{ t("grid.copyExtractorHeaderBottom") }}</SelectItem></SelectContent
                >
              </Select>
            </div>
            <div v-if="supportsCsvOptions && draftOptions.dsv.headerPosition !== 'none'" class="grid grid-cols-2 gap-2">
              <div class="space-y-1.5">
                <Label>{{ t("grid.copyExtractorHeaderFormat") }}</Label
                ><Select :model-value="draftOptions.dsv.headerFormat" @update:model-value="updateDsv('headerFormat', $event as DataGridExtractorOptions['dsv']['headerFormat'])"
                  ><SelectTrigger><SelectValue /></SelectTrigger
                  ><SelectContent
                    ><SelectItem value="name">{{ t("grid.copyExtractorHeaderName") }}</SelectItem
                    ><SelectItem value="description">{{ t("grid.copyExtractorHeaderDescription") }}</SelectItem
                    ><SelectItem value="both">{{ t("grid.copyExtractorHeaderBoth") }}</SelectItem></SelectContent
                  ></Select
                >
              </div>
              <div class="space-y-1.5">
                <Label>{{ t("grid.copyExtractorHeaderCase") }}</Label
                ><Select :model-value="draftOptions.dsv.headerCase" @update:model-value="updateDsv('headerCase', $event as DataGridExtractorOptions['dsv']['headerCase'])"
                  ><SelectTrigger><SelectValue /></SelectTrigger
                  ><SelectContent
                    ><SelectItem value="preserve">{{ t("grid.copyExtractorHeaderPreserve") }}</SelectItem
                    ><SelectItem value="upper">{{ t("grid.copyExtractorHeaderUpper") }}</SelectItem
                    ><SelectItem value="lower">{{ t("grid.copyExtractorHeaderLower") }}</SelectItem></SelectContent
                  ></Select
                >
              </div>
            </div>
            <details v-if="supportsCsvOptions" class="space-y-2 rounded-md border p-3">
              <summary class="cursor-pointer text-sm font-medium">{{ t("common.advanced") }}</summary>
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.dsv.quoteNumericStrings" @change="updateDsv('quoteNumericStrings', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorQuoteNumericStrings") }}</label>
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.dsv.escapeFormulas" @change="updateDsv('escapeFormulas', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorEscapeFormulas") }}</label>
              <div class="space-y-1.5">
                <Label>{{ t("grid.copyExtractorLineFeedEscape") }}</Label
                ><Input :model-value="visibleSeparator(draftOptions.dsv.lineFeedEscapeString)" @update:model-value="updateDsv('lineFeedEscapeString', separatorValue(String($event)))" />
              </div>
              <div class="space-y-1.5">
                <Label>{{ t("grid.copyExtractorArrayFormat") }}</Label
                ><Select :model-value="draftOptions.dsv.arrayFormat" @update:model-value="updateDsv('arrayFormat', $event as DataGridExtractorOptions['dsv']['arrayFormat'])"
                  ><SelectTrigger><SelectValue /></SelectTrigger
                  ><SelectContent
                    ><SelectItem value="preserve">{{ t("grid.copyExtractorArrayPreserve") }}</SelectItem
                    ><SelectItem value="braces">{ }</SelectItem><SelectItem value="brackets">[ ]</SelectItem><SelectItem value="parentheses">( )</SelectItem></SelectContent
                  ></Select
                >
              </div>
              <div class="space-y-1.5">
                <Label>{{ t("grid.copyExtractorFormatNumbers") }}</Label
                ><Select :model-value="draftOptions.dsv.formatNumbers" @update:model-value="updateDsv('formatNumbers', $event as DataGridExtractorOptions['dsv']['formatNumbers'])"
                  ><SelectTrigger><SelectValue /></SelectTrigger
                  ><SelectContent
                    ><SelectItem value="inherit">{{ t("grid.copyExtractorFormatNumbersInherit") }}</SelectItem
                    ><SelectItem value="native">{{ t("grid.copyExtractorFormatNumbersNative") }}</SelectItem
                    ><SelectItem value="display">{{ t("grid.copyExtractorFormatNumbersDisplay") }}</SelectItem></SelectContent
                  ></Select
                >
              </div>
            </details>
          </template>

          <label v-if="isDsv && draftExtractor !== 'one-row'" class="flex items-center gap-2 text-sm"
            ><input type="checkbox" :checked="draftOptions.dsv.includeRowHeader" @change="updateDsv('includeRowHeader', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorIncludeRowHeader") }}</label
          >

          <template v-if="isSql">
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.sql.skipComputedColumns" @change="updateSql('skipComputedColumns', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorSkipComputed") }}</label>
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.sql.skipGeneratedColumns" @change="updateSql('skipGeneratedColumns', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorSkipGenerated") }}</label>
            <div v-if="draftExtractor === 'sql-inserts' || draftExtractor === 'sql-deletes-inserts'" class="space-y-1.5">
              <Label>{{ t("grid.copyExtractorExcludePrimaryKeys") }}</Label>
              <Select :model-value="draftOptions.sql.primaryKeyMode" @update:model-value="updateSql('primaryKeyMode', $event as DataGridExtractorOptions['sql']['primaryKeyMode'])">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="include">{{ t("grid.copyExtractorSqlInsertsWithPrimaryKeys") }}</SelectItem>
                  <SelectItem value="exclude-generated">{{ t("grid.copyExtractorSqlInsertsWithoutPrimaryKeys") }}</SelectItem>
                  <SelectItem value="exclude-all">{{ t("grid.copyExtractorSqlInsertsWithoutAllPrimaryKeys") }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.sql.includeDatabaseName" @change="updateSql('includeDatabaseName', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorIncludeDatabaseName") }}</label>
            <div v-if="draftExtractor === 'sql-inserts' || draftExtractor === 'sql-deletes-inserts'" class="space-y-1.5">
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.sql.quoteIdentifiers" @change="updateSql('quoteIdentifiers', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorQuoteIdentifiers") }}</label>
              <Label>{{ t("grid.copyExtractorTemporalFormat") }}</Label>
              <Select :model-value="draftOptions.sql.temporalFormat" @update:model-value="updateSql('temporalFormat', $event as DataGridExtractorOptions['sql']['temporalFormat'])">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="native">{{ t("grid.copyExtractorTemporalNative") }}</SelectItem>
                  <SelectItem value="string">{{ t("grid.copyExtractorTemporalString") }}</SelectItem>
                </SelectContent>
              </Select>
              <p v-if="draftOptions.sql.temporalFormat === 'string'" class="text-xs text-muted-foreground">{{ t("grid.copyExtractorTemporalStringHint") }}</p>
            </div>
            <div v-if="draftExtractor === 'sql-inserts' || draftExtractor === 'sql-deletes-inserts'" class="space-y-1.5">
              <Label>{{ t("grid.copyExtractorInsertMode") }}</Label>
              <Select :model-value="draftOptions.sql.insertMode" @update:model-value="updateSql('insertMode', $event as DataGridExtractorOptions['sql']['insertMode'])">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="merged">{{ t("grid.copyExtractorInsertMerged") }}</SelectItem>
                  <SelectItem value="row-by-row">{{ t("grid.copyExtractorInsertRowByRow") }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </template>

          <template v-if="isJson">
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.json.pretty" @change="updateJson('pretty', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorPrettyJson") }}</label>
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.json.camelCaseFieldNames" @change="updateJson('camelCaseFieldNames', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorCamelCaseJsonFields") }}</label>
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.json.valuesOnly" @change="updateJson('valuesOnly', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorValuesOnlyJsonArray") }}</label>
            <p v-if="draftOptions.json.valuesOnly" class="text-xs text-muted-foreground">{{ t("grid.copyExtractorValuesOnlyJsonArrayHint") }}</p>
          </template>

          <template v-if="isDbunit">
            <div class="space-y-1.5">
              <Label>{{ t("grid.copyDbunitTableName") }}</Label>
              <Input v-if="!sourceTableName" :model-value="draftOptions.dbunit.tableName" @update:model-value="updateDbunit('tableName', String($event))" />
              <p v-else class="rounded-md border bg-muted/30 px-2 py-1.5 text-sm">{{ sourceTableName }}</p>
              <p class="text-xs text-muted-foreground">{{ t("grid.copyDbunitTableNameHint") }}</p>
            </div>
            <div class="space-y-1.5">
              <Label>{{ t("grid.copyDbunitNullValue") }}</Label>
              <Input :model-value="draftOptions.dbunit.nullValueString" @update:model-value="updateDbunit('nullValueString', String($event))" />
            </div>
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.dbunit.upperCaseTableName" @change="updateDbunit('upperCaseTableName', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyDbunitUppercaseTable") }}</label>
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.dbunit.upperCaseColumnNames" @change="updateDbunit('upperCaseColumnNames', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyDbunitUppercaseColumns") }}</label>
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.dbunit.includeNullValues" @change="updateDbunit('includeNullValues', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyDbunitIncludeNulls") }}</label>
          </template>

          <template v-if="isPhp">
            <div class="space-y-1.5">
              <Label>{{ t("grid.copyPhpVariable") }}</Label>
              <Input :model-value="draftOptions.php.variableName || (sourceTableName && /^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceTableName) ? sourceTableName : 'data')" @update:model-value="updatePhp('variableName', String($event))" />
            </div>
            <div class="space-y-1.5">
              <Label>{{ t("grid.copyPhpArraySyntax") }}</Label>
              <Select :model-value="draftOptions.php.arraySyntax" @update:model-value="updatePhp('arraySyntax', $event as DataGridExtractorOptions['php']['arraySyntax'])">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="legacy">array()</SelectItem><SelectItem value="short">[]</SelectItem></SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <Label>{{ t("grid.copyPhpQuote") }}</Label>
              <Select :model-value="draftOptions.php.quoteChar" @update:model-value="updatePhp('quoteChar', $event as DataGridExtractorOptions['php']['quoteChar'])">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="'">'…'</SelectItem><SelectItem value='"'>"…"</SelectItem></SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <Label>{{ t("grid.copyPhpRowDelimiter") }}</Label>
              <Input :model-value="visibleSeparator(draftOptions.php.rowDelimiter)" @update:model-value="updatePhp('rowDelimiter', separatorValue(String($event)))" />
            </div>
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.php.formatDateISO" @change="updatePhp('formatDateISO', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyPhpIsoDates") }}</label>
          </template>

          <details class="space-y-2 border-t pt-3">
            <summary class="cursor-pointer text-sm font-medium">{{ t("grid.copyExtractorVisibleFormats") }}</summary>
            <div class="flex items-center justify-between gap-2">
              <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="draftVisibleCopyExtractors = [...DATA_GRID_DEFAULT_VISIBLE_COPY_EXTRACTORS]">{{ t("grid.copyExtractorRestoreVisibleFormats") }}</Button>
            </div>
            <label v-for="item in visibleItems" :key="item.value" class="flex items-center gap-2 text-sm">
              <input type="checkbox" :checked="draftVisibleCopyExtractors.includes(item.value as DataGridCopyExtractorId)" @change="toggleVisibleCopyExtractor(item.value as DataGridCopyExtractorId, ($event.target as HTMLInputElement).checked)" />{{ item.label }}
            </label>
          </details>
        </div>

        <div class="min-w-0 space-y-1.5">
          <Label>{{ t("grid.copyExtractorPreview") }}</Label>
          <div class="relative min-h-72 rounded-md border bg-muted/30">
            <pre class="max-h-[55vh] overflow-auto whitespace-pre p-3 font-mono text-xs">{{ previewError || previewText }}</pre>
            <span v-if="previewLoading" class="absolute right-2 top-2 text-xs text-muted-foreground">{{ t("common.loading") }}</span>
          </div>
          <p v-if="previewTruncatedRows" class="text-xs text-muted-foreground">{{ t("grid.copyExtractorPreviewTruncated", { count: previewTruncatedRows }) }}</p>
          <p v-for="warning in previewWarnings" :key="warning" class="text-xs text-amber-700 dark:text-amber-300">{{ warning }}</p>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">{{ t("common.cancel") }}</Button>
        <Button :disabled="!!optionsError" @click="save">{{ t("common.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
