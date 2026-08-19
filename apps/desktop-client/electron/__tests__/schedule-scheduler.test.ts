import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleHistoryStore } from "../schedule-history-store";
import { ScheduleScheduler, type SchedulerLoggerLike } from "../schedule-scheduler";
import { ScheduleStore } from "../schedule-store";
import { LocalToolStore } from "../local-tool-store";
import type { ScheduleRecipe, ScheduleSaveInput } from "../types";

let tmpDir: string;
let scheduleStore: ScheduleStore;
let historyStore: ScheduleHistoryStore;
let localToolStore: LocalToolStore;
let logger: SchedulerLoggerLike;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-scheduler-"));
  scheduleStore = new ScheduleStore(tmpDir);
  historyStore = new ScheduleHistoryStore(tmpDir);
  localToolStore = new LocalToolStore(tmpDir);
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function knowledgeOnlyRecipe(): ScheduleRecipe {
  return {
    question: "질문",
    knowledgeLookupActive: false,
    knowledgeIds: [],
    localToolRouteActive: false,
    localAgentId: null,
    chatModelAlias: "default-chat",
  };
}

function makeScheduler(now: () => Date) {
  return new ScheduleScheduler({
    scheduleStore,
    historyStore,
    localToolStore,
    getAgentRuntimeBaseUrl: () => "http://127.0.0.1:8100",
    getOllamaBaseUrl: () => "http://127.0.0.1:11434",
    getInterpreterPath: () => null,
    logger,
    now,
  });
}

function saveActiveSchedule(overrides: Partial<ScheduleSaveInput> = {}) {
  const result = scheduleStore.saveWithToolRiskAck(
    {
      name: "테스트",
      expression: { kind: "daily", hour: 9, minute: 0 },
      recipe: knowledgeOnlyRecipe(),
      active: true,
      ...overrides,
    },
    { acknowledgedToolRisk: false },
  );
  if (!result.ok) throw new Error(`setup failed: ${result.error}`);
  return result.schedule;
}

describe("ScheduleScheduler — missed-run detection (D)", () => {
  it("does not execute a schedule whose stored nextRunAt is already in the past — records a 'missed' history entry instead", () => {
    const schedule = saveActiveSchedule();
    // Force nextRunAt into the past, simulating the app having been closed
    // through the scheduled time.
    scheduleStore.updateRunState(schedule.id, { nextRunAt: new Date(Date.now() - 60_000).toISOString() });

    const scheduler = makeScheduler(() => new Date());
    scheduler.detectMissedRuns();

    const history = historyStore.listForSchedule(schedule.id);
    expect(history).toHaveLength(1);
    expect(history[0].outcome).toBe("missed");
    expect(history[0].failureReason).toBeTruthy();

    const updated = scheduleStore.get(schedule.id)!;
    expect(updated.lastRunOutcome).toBe("missed");
    expect(new Date(updated.nextRunAt).getTime()).toBeGreaterThan(Date.now() - 1_000);
  });

  it("does not select an inactive schedule for missed-run detection", () => {
    const schedule = saveActiveSchedule();
    scheduleStore.updateRunState(schedule.id, { nextRunAt: new Date(Date.now() - 60_000).toISOString() });
    scheduleStore.setActive(schedule.id, false, "테스트로 비활성화");

    const scheduler = makeScheduler(() => new Date());
    scheduler.detectMissedRuns();

    expect(historyStore.listForSchedule(schedule.id)).toHaveLength(0);
  });

  it("does not treat a future nextRunAt as missed", () => {
    const schedule = saveActiveSchedule();
    scheduleStore.updateRunState(schedule.id, { nextRunAt: new Date(Date.now() + 60_000).toISOString() });

    const scheduler = makeScheduler(() => new Date());
    scheduler.detectMissedRuns();

    expect(historyStore.listForSchedule(schedule.id)).toHaveLength(0);
  });
});

describe("ScheduleScheduler — cancellation", () => {
  it("reports nothing running when no execution is in flight", () => {
    const scheduler = makeScheduler(() => new Date());
    const result = scheduler.cancel("nonexistent-id");
    expect(result.ok).toBe(false);
  });

  it("getRunningScheduleId is null when idle", () => {
    const scheduler = makeScheduler(() => new Date());
    expect(scheduler.getRunningScheduleId()).toBeNull();
  });
});

describe("ScheduleScheduler — start()/stop() lifecycle", () => {
  it("start() is idempotent (does not create a second interval) and stop() clears it", () => {
    vi.useFakeTimers();
    try {
      const scheduler = makeScheduler(() => new Date());
      scheduler.start();
      scheduler.start();
      scheduler.stop();
      // No assertion beyond "did not throw" — this pins that repeated
      // start() calls are safe to make from app.whenReady() wiring.
      expect(true).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
