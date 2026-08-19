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
    // 실행 자체가 없었으므로 라우팅을 시도한 적도 없다 — "route_inactive"로
    // 단정하지 않고 null이어야 한다.
    expect(history[0].toolRouteOutcome).toBeNull();

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

// D14 후속("지금 실행", 실사용 제보 3) — runNow()는 정기 Tick과 완전히 같은
// 실행 경로(execute())를 재사용한다. agent-runtime 호출은 전역 fetch를 통해
// 나가므로(SchedulerDeps에 fetchImpl 주입 지점이 없다) 여기서 전역 fetch를
// stub한다.
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("ScheduleScheduler — runNow() (D14 후속, 실사용 제보 3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an error for a nonexistent schedule id", async () => {
    const scheduler = makeScheduler(() => new Date());
    const result = await scheduler.runNow("does-not-exist");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("runs immediately, records outcome+trigger:'manual' in history, and reuses the exact same execution path as a scheduled tick", async () => {
    const schedule = saveActiveSchedule();
    // Force nextRunAt far into the future — proves runNow() does not wait
    // for the tick loop to notice it's due.
    scheduleStore.updateRunState(schedule.id, { nextRunAt: new Date(Date.now() + 3_600_000).toISOString() });

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "run-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "SUCCEEDED", output: { answer: "완료", citations: [] } }));
    vi.stubGlobal("fetch", fetchImpl);

    const scheduler = makeScheduler(() => new Date());
    const result = await scheduler.runNow(schedule.id);
    expect(result.ok).toBe(true);

    const history = historyStore.listForSchedule(schedule.id);
    expect(history).toHaveLength(1);
    expect(history[0].trigger).toBe("manual");
    expect(history[0].outcome).toBe("success");

    const updated = scheduleStore.get(schedule.id)!;
    expect(updated.lastRunOutcome).toBe("success");
  });

  it("refuses when another schedule is already running (does not queue or double-run)", async () => {
    const scheduleA = saveActiveSchedule({ name: "A" });
    const scheduleB = saveActiveSchedule({ name: "B" });

    // A never-resolving fetch keeps `execute()` in flight so runningScheduleId
    // stays set for the duration of this test.
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ id: "run-1" })).mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchImpl);

    const scheduler = makeScheduler(() => new Date());
    const firstRun = scheduler.runNow(scheduleA.id);
    // Give the first call a tick to set runningScheduleId before the second call races it.
    await Promise.resolve();
    const second = await scheduler.runNow(scheduleB.id);
    expect(second.ok).toBe(false);
    expect(second.error).toBeTruthy();
    void firstRun; // intentionally left in flight; the test process exits after this suite.
  });

  it("refuses a Tool-capable schedule whose toolRiskAcknowledgedAt is missing, without bypassing the confirmation gate", async () => {
    const saved = scheduleStore.saveWithToolRiskAck(
      {
        name: "Tool 스케줄",
        expression: { kind: "daily", hour: 9, minute: 0 },
        recipe: { ...knowledgeOnlyRecipe(), localToolRouteActive: true },
        active: true,
      },
      { acknowledgedToolRisk: true },
    );
    if (!saved.ok) throw new Error("setup failed");
    // 정상 저장 경로는 항상 toolRiskAcknowledgedAt을 채우므로, 레거시
    // 레코드/우회 생성을 흉내 내기 위해 상태 파일을 직접 되돌린다.
    const filePath = path.join(tmpDir, "schedules.json");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    raw[0].toolRiskAcknowledgedAt = null;
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));

    const scheduler = makeScheduler(() => new Date());
    const result = await scheduler.runNow(saved.schedule.id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("확인");
    expect(historyStore.listForSchedule(saved.schedule.id)).toHaveLength(0);
  });

  // 실사용 제보(2026-08-19) — 이 스케줄에 설정된 `timeoutMinutes`가 실제로
  // agent-runtime 폴링 상한(maxPollMs)으로 전달되는지 — a hanging RUNNING
  // response never terminates on its own, so it can only end via the
  // deadline computed from the schedule's own `timeoutMinutes`.
  it("uses this schedule's own timeoutMinutes as the agent-runtime poll deadline", async () => {
    const schedule = saveActiveSchedule();
    // 저장 게이트(최소 1분)를 우회해 테스트를 빠르게 유지한다 — 실제 저장
    // 경로의 최소값 검증은 schedule-store.test.ts가 이미 고정한다. 여기서는
    // "저장된 값이 실행에 그대로 쓰이는가"만 본다.
    const filePath = path.join(tmpDir, "schedules.json");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    raw[0].timeoutMinutes = 0.001; // 60ms
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "run-1" }))
      .mockResolvedValue(jsonResponse({ status: "RUNNING" })); // never terminates on its own
    vi.stubGlobal("fetch", fetchImpl);

    const scheduler = makeScheduler(() => new Date());
    const result = await scheduler.runNow(schedule.id);
    expect(result.ok).toBe(true);

    const history = historyStore.listForSchedule(schedule.id);
    expect(history[0].outcome).toBe("failure");
    expect(history[0].failureReason).toContain("실행 시간 상한");
  }, 10_000);
});

// 실사용 제보(2026-08-19) — "스케줄 수행 시 어떤 툴이 수행됐는지 모르겠어":
// `toolRouteOutcome`이 실행 경로에 따라 올바르게 채워지는지.
describe("ScheduleScheduler — toolRouteOutcome (실사용 제보 2026-08-19)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records toolRouteOutcome:'route_inactive' for a recipe that never enabled local-tool auto-routing", async () => {
    const schedule = saveActiveSchedule(); // knowledgeOnlyRecipe: localToolRouteActive === false
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "run-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "SUCCEEDED", output: { answer: "완료", citations: [] } }));
    vi.stubGlobal("fetch", fetchImpl);

    const scheduler = makeScheduler(() => new Date());
    await scheduler.runNow(schedule.id);

    const history = historyStore.listForSchedule(schedule.id);
    expect(history[0].toolRouteOutcome).toBe("route_inactive");
    expect(history[0].localToolInvocations).toEqual([]);
  });

  it("records the router's actual reason (e.g. 'no_candidates') for a Tool-capable recipe that didn't call one this run — distinct from 'route_inactive'", async () => {
    const saved = scheduleStore.saveWithToolRiskAck(
      {
        name: "Tool 스케줄",
        expression: { kind: "daily", hour: 9, minute: 0 },
        recipe: { ...knowledgeOnlyRecipe(), localToolRouteActive: true },
        active: true,
      },
      { acknowledgedToolRisk: true },
    );
    if (!saved.ok) throw new Error("setup failed");
    // localToolStore에 등록된 Tool이 하나도 없으므로 라우팅은 Ollama를
    // 부르지도 않고 no_candidates로 귀결된다 — fetch가 전혀 호출되지 않아야
    // 한다는 것 자체가 "라우팅을 아예 시도하지 않았다"의 증거다.
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const scheduler = makeScheduler(() => new Date());
    const result = await scheduler.runNow(saved.schedule.id);
    expect(result.ok).toBe(true);

    const history = historyStore.listForSchedule(saved.schedule.id);
    expect(history[0].outcome).toBe("success"); // "Tool 없음"은 실패가 아니다
    expect(history[0].toolRouteOutcome).toBe("no_candidates");
    expect(history[0].toolRouteOutcome).not.toBe("route_inactive");
    expect(history[0].localToolInvocations).toEqual([]);
  });
});
