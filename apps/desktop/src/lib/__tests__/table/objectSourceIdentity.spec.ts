import { describe, expect, it } from "vitest";
import { assertSourceIdentity, beginSourceSave, captureSourceIdentity, freezeSourceIdentities, renewSourceIdentity } from "@/lib/table/objectSourceIdentity";

const identity = (name: string) => ({ connectionId: "identity-test", database: "ORCL", schema: "APP", objectType: "VIEW", name });

describe("object source identity", () => {
  it("atomically excludes saving and migration across all affected identities", () => {
    const first = captureSourceIdentity(identity("first"));
    const second = captureSourceIdentity(identity("second"));
    const release = beginSourceSave(second);
    expect(() => freezeSourceIdentities([first, second])).toThrow();
    expect(() => assertSourceIdentity(first)).not.toThrow();
    release();
    const migration = freezeSourceIdentities([first, second]);
    expect(() => beginSourceSave(first)).toThrow();
    migration.cancel();
    expect(() => assertSourceIdentity(first)).not.toThrow();
  });

  it("keeps dispatched revisions stale while explicit reload creates a fresh version", () => {
    const old = captureSourceIdentity(identity("renamed"));
    const migration = freezeSourceIdentities([old]);
    migration.markDispatched();
    migration.cancel();
    expect(() => assertSourceIdentity(old)).toThrow();
    expect(() => renewSourceIdentity(captureSourceIdentity(old))).toThrow();
    migration.finish();
    expect(() => renewSourceIdentity(old)).toThrow();
    const fresh = renewSourceIdentity(captureSourceIdentity(old));
    expect(() => assertSourceIdentity(fresh)).not.toThrow();
    expect(() => beginSourceSave(old)).toThrow();
  });

  it("does not conflate quoted case, owner, connection, database or object kind", () => {
    const target = identity("Mixed");
    const other = [
      { ...target, name: "MIXED" },
      { ...target, schema: "OTHER" },
      { ...target, connectionId: "other" },
      { ...target, database: "other" },
      { ...target, objectType: "TABLE" },
    ].map(captureSourceIdentity);
    const migration = freezeSourceIdentities([target]);
    for (const snapshot of other) expect(() => assertSourceIdentity(snapshot)).not.toThrow();
    migration.cancel();
  });
});
