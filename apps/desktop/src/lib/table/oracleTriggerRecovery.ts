import { loadBrowserAppState, saveBrowserAppState } from "@/lib/backend/browserAppStateStorage";
import { uuid } from "@/lib/common/utils";

export interface OracleTriggerRecoveryScope {
  connectionId: string;
  database: string;
  schema: string;
  name: string;
}
export interface OracleTriggerRecoveryEntry {
  id: string;
  savedAt: string;
  source: string;
  enabled: boolean;
}

function key(scope: OracleTriggerRecoveryScope): string {
  return `oracle-trigger-recovery:${JSON.stringify([scope.connectionId, scope.database, scope.schema, scope.name])}`;
}

export async function loadOracleTriggerRecovery(scope: OracleTriggerRecoveryScope): Promise<OracleTriggerRecoveryEntry[]> {
  const value = await loadBrowserAppState(key(scope));
  if (value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry.id !== "string" || typeof entry.savedAt !== "string" || typeof entry.source !== "string" || typeof entry.enabled !== "boolean")) throw new Error("Trigger recovery history could not be read; existing recovery data was preserved");
  return value;
}

const writes = new Map<string, Promise<unknown>>();

export async function preserveOracleTriggerRecovery(scope: OracleTriggerRecoveryScope, source: string, enabled: boolean): Promise<OracleTriggerRecoveryEntry> {
  const scopeKey = key(scope);
  const previous = writes.get(scopeKey) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    const entries = await loadOracleTriggerRecovery(scope);
    const entry: OracleTriggerRecoveryEntry = { id: uuid(), savedAt: new Date().toISOString(), source, enabled };
    await saveBrowserAppState(scopeKey, [...entries, entry]);
    return entry;
  });
  writes.set(scopeKey, pending);
  try { return await pending; }
  finally { if (writes.get(scopeKey) === pending) writes.delete(scopeKey); }
}
