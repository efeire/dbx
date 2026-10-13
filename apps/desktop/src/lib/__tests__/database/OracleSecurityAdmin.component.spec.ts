// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import en from "@/i18n/locales/en";

const mocks = vi.hoisted(() => ({ ensureConnected: vi.fn().mockResolvedValue(undefined), executeQuery: vi.fn() }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => (key.startsWith("oracleSecurity.") ? en.oracleSecurity[key.split(".")[1] as keyof typeof en.oracleSecurity] : key) }) }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ ensureConnected: mocks.ensureConnected }) }));
vi.mock("@/lib/backend/api", () => ({ executeQuery: mocks.executeQuery }));
vi.mock("@/components/ui/button", () => ({
  Button: defineComponent({
    setup:
      (_, { attrs, slots }) =>
      () =>
        h("button", attrs, slots.default?.()),
  }),
}));
vi.mock("@/components/ui/input", () => ({
  Input: defineComponent({
    props: ["modelValue"],
    emits: ["update:modelValue"],
    setup:
      (props, { attrs, emit }) =>
      () =>
        h("input", { ...attrs, value: props.modelValue, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) }),
  }),
}));
import OracleSecurityAdmin from "@/components/admin/OracleSecurityAdmin.vue";

const cleanup: (() => void)[] = [];
const mountedPages = new WeakMap<HTMLElement, { refresh: () => Promise<void> }>();
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.clearAllMocks();
});
async function settle() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await nextTick();
  }
}
function mount(db_type: "oracle" | "oceanbase-oracle" = "oracle") {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(OracleSecurityAdmin, { connection: { id: "oracle", db_type } as ConnectionConfig });
  mountedPages.set(host, app.mount(host) as unknown as { refresh: () => Promise<void> });
  cleanup.push(() => {
    app.unmount();
    host.remove();
  });
  return host;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe("Oracle security page", () => {
  it("loads the production reader, exposes limited visibility and filters object grants", async () => {
    mocks.executeQuery.mockImplementation(async (_connection: string, _database: string, sql: string) => {
      if (sql.includes("DBA_USERS")) throw new Error("ORA-01031");
      if (sql.includes("ALL_USERS") || sql.includes("FROM DUAL")) return { columns: ["USERNAME"], rows: [["Reader"]] };
      if (sql.includes("DBA_TAB_PRIVS"))
        return {
          columns: ["GRANTEE", "OWNER", "TABLE_NAME", "GRANTOR", "PRIVILEGE", "GRANTABLE"],
          rows: [
            ["Reader", "Owner", "T", "Owner", "SELECT", "NO"],
            ["Reader", "Other", "T", "Other", "UPDATE", "NO"],
            ["Reader", "Owner", "T", null, "DELETE", "NO"],
          ],
        };
      return { columns: [], rows: [] };
    });
    const host = mount();
    await settle();
    expect(host.textContent).toContain("Limited visibility");
    expect(host.textContent).toContain("Account status unavailable");
    expect(host.textContent).toContain("Other.T");
    expect(host.textContent).toContain("grantor: Unknown");
    const owner = host.querySelector('input[placeholder="Exact object owner"]') as HTMLInputElement;
    owner.value = "Owner";
    owner.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(host.textContent).toContain("Owner.T");
    expect(host.textContent).not.toContain("Other.T");
    expect(mocks.executeQuery.mock.calls.every((call) => /^SELECT\s/.test(call[2]))).toBe(true);
    expect(mocks.executeQuery.mock.calls.every((call) => call[5]?.maxRows === 10000)).toBe(true);
  });

  it("does not label failed dictionary reads as empty grants", async () => {
    mocks.executeQuery.mockRejectedValue(new Error("connection lost"));
    const host = mount();
    await settle();
    expect(host.querySelectorAll('[data-security-state="error"]').length).toBe(7);
    expect(host.textContent).toContain("Read failed");
    expect(host.textContent).not.toContain("Empty in visible scope");
    expect(host.textContent).not.toContain("No grants in the current visible result");
  });

  it("does not start dictionary reads after the page closes while connecting", async () => {
    let connected!: () => void;
    mocks.ensureConnected.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        connected = resolve;
      }),
    );
    mount();
    cleanup.splice(0).forEach((dispose) => dispose());
    connected();
    await settle();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });

  it("uses the OceanBase fallback dialect when opening a restricted connection", async () => {
    mocks.executeQuery.mockImplementation(async (_connection: string, _database: string, sql: string) => {
      if (/FROM DBA_/.test(sql)) throw new Error("ORA-00942");
      if (sql.includes("FROM USER_ROLE_PRIVS UNION") && !sql.startsWith("SELECT GRANTEE,")) throw new Error("ORA-00904");
      if (sql.includes("FROM ALL_COL_PRIVS") && !sql.startsWith("SELECT GRANTEE, OWNER,")) throw new Error("ORA-00904");
      return { columns: [], rows: [] };
    });
    const host = mount("oceanbase-oracle");
    await settle();
    expect(host.textContent).not.toContain("ORA-00904");
    expect(host.querySelectorAll('[data-security-state="error"]').length).toBe(0);
    expect(host.textContent).toContain("Limited visibility");
  });

  it("invalidates an old connection wait before issuing any queries", async () => {
    const old = deferred<void>();
    mocks.ensureConnected.mockImplementation((id: string) => (id === "old" ? old.promise : Promise.resolve()));
    mocks.executeQuery.mockResolvedValue({ columns: [], rows: [] });
    const connection = ref({ id: "old", db_type: "oracle" } as ConnectionConfig);
    const host = document.createElement("div");
    const app = createApp({ setup: () => () => h(OracleSecurityAdmin, { connection: connection.value }) });
    app.mount(host);
    cleanup.push(() => app.unmount());
    connection.value = { id: "new", db_type: "oceanbase-oracle" } as ConnectionConfig;
    await settle();
    old.resolve();
    await settle();
    expect(mocks.executeQuery.mock.calls).toHaveLength(7);
    expect(mocks.executeQuery.mock.calls.every(([id]) => id === "new")).toBe(true);
    mocks.ensureConnected.mockResolvedValue(undefined);
  });

  it("keeps the latest refresh and ignores old failures and fallback reads", async () => {
    const old = deferred<{ columns: string[]; rows: string[][] }>();
    mocks.executeQuery.mockReturnValue(old.promise);
    const host = mount();
    await settle();
    mocks.executeQuery.mockImplementation(async (_id: string, _db: string, sql: string) => ({ columns: ["USERNAME"], rows: sql.includes("FROM DUAL") || sql.includes("DBA_USERS") ? [["LATEST"]] : [] }));
    // Exposed refresh also covers callers that refresh while a load is pending.
    await mountedPages.get(host)!.refresh();
    await settle();
    const calls = mocks.executeQuery.mock.calls.length;
    old.reject(new Error("ORA-01031"));
    await settle();
    expect(mocks.executeQuery).toHaveBeenCalledTimes(calls);
    expect(host.textContent).toContain("LATEST");
    expect(host.textContent).not.toContain("ORA-01031");
  });

  it("preserves partial grants while indicating failed role visibility", async () => {
    mocks.executeQuery.mockImplementation(async (_id: string, _db: string, sql: string) => {
      if (sql.includes("DBA_ROLE_PRIVS")) throw new Error("connection lost");
      if (sql.includes("FROM DUAL") || sql.includes("DBA_USERS")) return { columns: ["USERNAME"], rows: [["Reader"]] };
      if (sql.includes("DBA_TAB_PRIVS")) return { columns: ["GRANTEE", "OWNER", "TABLE_NAME", "PRIVILEGE"], rows: [["Reader", "Owner", "T", "SELECT"]] };
      return { columns: [], rows: [] };
    });
    const host = mount();
    await settle();
    expect(host.textContent).toContain("Owner.T");
    expect(host.textContent).toContain("Grant sources are incomplete");
    expect(host.textContent).not.toContain("No grants in the current visible result");
  });

  it("shows a confirmed empty visible result after successful reads", async () => {
    mocks.executeQuery.mockResolvedValue({ columns: [], rows: [] });
    const host = mount();
    await settle();
    expect(host.textContent).toContain("No grants in the current visible result");
  });
});
