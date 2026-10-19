import { readFileSync } from "node:fs";
import { createI18n } from "vue-i18n";
import { describe, expect, it } from "vitest";
import en from "../locales/en";
import es from "../locales/es";
import itLocale from "../locales/it";
import ja from "../locales/ja";
import ko from "../locales/ko";
import ptBR from "../locales/pt-BR";
import ru from "../locales/ru";
import th from "../locales/th";
import zhCN from "../locales/zh-CN";
import zhTW from "../locales/zh-TW";

const locales = [
  ["en", en, "Compile all", "Previous page", "Next page"],
  ["es", es, "Compilar todos", "Página anterior", "Página siguiente"],
  ["it", itLocale, "Compila tutto", "Pagina precedente", "Pagina successiva"],
  ["ja", ja, "すべてコンパイル", "前のページ", "次のページ"],
  ["ko", ko, "모두 컴파일", "이전 페이지", "다음 페이지"],
  ["pt-BR", ptBR, "Compilar tudo", "Página anterior", "Próxima página"],
  ["ru", ru, "Компилировать все", "Предыдущая страница", "Следующая страница"],
  ["th", th, "คอมไพล์ทั้งหมด", "หน้าก่อนหน้า", "หน้าถัดไป"],
  ["zh-CN", zhCN, "编译全部", "上一页", "下一页"],
  ["zh-TW", zhTW, "全部編譯", "上一頁", "下一頁"],
] as const;

const componentSource = readFileSync(new URL("../../components/objects/OracleInvalidObjectsDialog.vue", import.meta.url), "utf8");
const literalKeys = [...componentSource.matchAll(/t\(["'](processList\.oracleInvalidObjects\.[A-Za-z]+)["']/g)].map((match) => match[1]!);
const batchStatuses = ["pending", "unsupported", "valid", "still-invalid", "already-valid", "target-changed", "deleted", "failed", "unknown", "not-run"];

describe("invalid object dialog locale messages", () => {
  it.each(locales)("resolves all dialog messages in %s", (locale, messages, expectedCompileAll, expectedPreviousPage, expectedNextPage) => {
    const i18n = createI18n({ legacy: false, locale, fallbackLocale: false, messages: { [locale]: messages } });

    for (const key of literalKeys) {
      expect(i18n.global.t(key), `${locale}: ${key}`).not.toBe(key);
    }
    for (const status of batchStatuses) {
      const key = `processList.oracleInvalidObjects.batchStatus.${status}`;
      expect(i18n.global.t(key), `${locale}: ${key}`).not.toBe(key);
    }
    expect(i18n.global.t("processList.oracleInvalidObjects.compileAll")).toBe(expectedCompileAll);
    expect(i18n.global.t("processList.oracleInvalidObjects.batchPreviousPage")).toBe(expectedPreviousPage);
    expect(i18n.global.t("processList.oracleInvalidObjects.batchNextPage")).toBe(expectedNextPage);
  });
});
