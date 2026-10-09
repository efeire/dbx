import { effectScope, shallowRef } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionBlockingMonitor } from "../useSessionBlockingMonitor";
import type { MonitorContext, SessionSnapshot } from "@/lib/database/sessionBlockingMonitor";
vi.mock("@/lib/backend/api", () => ({}));
const context = () => shallowRef<MonitorContext | null>({ connectionId: "one", database: "db", engine: "oracle" });
const sample = (): SessionSnapshot => ({ startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), sessions: [], edges: [], limitations: [] });
afterEach(() => vi.useRealTimers());
describe("session monitor lifetime", () => {
  it("discards previous connection responses and cancels the old request", async () => {
    const target = context();
    let finish!: (snapshot: SessionSnapshot) => void;
    const service = {
      collect: vi.fn().mockImplementation(
        () =>
          new Promise<SessionSnapshot>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const scope = effectScope();
    const state = scope.run(() => useSessionBlockingMonitor(target, service))!;
    const pending = state.refresh();
    const signal = service.collect.mock.calls[0][1] as AbortSignal;
    target.value = { ...target.value!, connectionId: "two" };
    finish(sample());
    await pending;
    expect(signal.aborted).toBe(true);
    expect(state.snapshot.value).toBeNull();
    expect(state.pending.value).toBe(false);
    scope.stop();
  });
  it("limits refresh frequency, marks old snapshots stale and stops automatic work on close", async () => {
    vi.useFakeTimers();
    const target = context();
    const service = { collect: vi.fn().mockImplementation(async () => sample()) };
    const scope = effectScope();
    const state = scope.run(() => useSessionBlockingMonitor(target, service))!;
    await state.refresh();
    await state.refresh();
    expect(service.collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.stale.value).toBe(true);
    state.autoRefresh.value = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.collect).toHaveBeenCalledTimes(2);
    target.value = null;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.collect).toHaveBeenCalledTimes(2);
    expect(state.snapshot.value).toBeNull();
    expect(state.autoRefresh.value).toBe(false);
    scope.stop();
  });
  it("retains the previous snapshot as stale when a refresh fails", async () => {
    vi.useFakeTimers();
    const service = { collect: vi.fn().mockResolvedValueOnce(sample()).mockRejectedValueOnce(new Error("ORA-01031 private")) };
    const scope = effectScope();
    const state = scope.run(() => useSessionBlockingMonitor(context(), service))!;
    await state.refresh();
    const previous = state.snapshot.value;
    await vi.advanceTimersByTimeAsync(5_000);
    await state.refresh();
    expect(state.snapshot.value).toBe(previous);
    expect(state.error.value).toBe("permission_denied");
    expect(state.stale.value).toBe(true);
    scope.stop();
  });
});
