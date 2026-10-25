import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend/api", () => ({ cancelTableExport: vi.fn() }));
vi.mock("@/lib/export/exportPath", () => ({ autoRevealExportedPathIfConfigured: vi.fn() }));
vi.mock("@/lib/schema/oracleRoutineDeploy", () => ({}));

function completion() {
  let finish!: (outcome: "settled" | "unknown") => void;
  const promise = new Promise<"settled" | "unknown">((resolve) => {
    finish = resolve;
  });
  return { run: vi.fn(() => promise), finish };
}

describe("export tracker queue", () => {
  beforeEach(() => vi.resetModules());

  it("shows waiting tasks without elapsed time and cancels them without backend calls", async () => {
    const { useExportTracker } = await import("../useExportTracker");
    const api = await import("@/lib/backend/api");
    const tracker = useExportTracker();
    const first = completion();
    tracker.submitExportTask(tracker.addTask("first", "csv", "first.csv"), "queued", first.run);
    const waiting = tracker.addTask("second", "csv", "second.csv");
    const second = completion();
    tracker.submitExportTask(waiting, "queued", second.run);

    expect(waiting.status).toBe("Queued");
    expect(waiting.startedAt).toBeUndefined();
    expect(tracker.activeCount.value).toBe(2);
    tracker.clearFinished();
    expect(tracker.tasks.value).toHaveLength(2);
    await tracker.cancelTask(waiting.exportId);
    expect(waiting.status).toBe("Cancelled");
    expect(api.cancelTableExport).not.toHaveBeenCalled();
    first.finish("settled");
    await Promise.resolve();
    expect(second.run).not.toHaveBeenCalled();
  });

  it("retains unknown operations as active and does not clear or release them", async () => {
    const { useExportTracker } = await import("../useExportTracker");
    const tracker = useExportTracker();
    const first = completion();
    const running = tracker.addTask("first", "csv", "first.csv");
    tracker.submitExportTask(running, "queued", first.run);
    const second = completion();
    tracker.submitExportTask(tracker.addTask("second", "csv", "second.csv"), "queued", second.run);
    first.finish("unknown");
    await Promise.resolve();

    expect(running.status).toBe("Unknown");
    expect(tracker.activeCount.value).toBe(2);
    tracker.clearFinished();
    expect(tracker.tasks.value).toHaveLength(2);
    expect(second.run).not.toHaveBeenCalled();
  });
});
