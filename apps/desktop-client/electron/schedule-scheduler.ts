// D14 "등록된 에이전트를 스케줄에 따라 수행" — Main-process timer loop.
//
// Lives entirely in Main because renderer timers die the moment the screen
// (or the whole renderer) unmounts (Task Brief A) — this class is
// instantiated once in `main.ts` and lives for the app's lifetime, not tied
// to any screen. It only runs while the Electron app itself is open; that
// limitation is surfaced in the UI (schedule list/empty-state copy), not
// here.
//
// No drift accumulation (Task Brief C): every tick recomputes `nextRunAt`
// fresh from "now" (or from the just-completed execution instant) via the
// pure `schedule-time.ts` function — this file never accumulates a fixed
// `setInterval` step as if it were wall-clock time.
//
// Missed runs (Task Brief D): on `start()`, any active schedule whose stored
// `nextRunAt` is already in the past is NOT executed — one aggregated
// "missed" history record is written per schedule (not one per missed
// occurrence) noting the time it was missed since, `nextRunAt` is
// recomputed from "now", and only then does the tick loop begin. One
// aggregated record (rather than N) is the documented choice here: an
// hourly schedule closed for three days would otherwise write ~72 near-
// identical rows that add no information beyond "the app was closed for a
// while" — the single record's `failureReason` says that honestly.
import { nextRunAt } from "./schedule-time";
import { runScheduledRecipeAgainstAgentRuntime } from "./schedule-agent-runtime";
import { invokeLocalToolForScheduledRun } from "./schedule-local-tool-runner";
import type { ScheduleHistoryStore } from "./schedule-history-store";
import { truncateResultSummary } from "./schedule-history-store";
import type { ScheduleStore } from "./schedule-store";
import type { LocalToolStore } from "./local-tool-store";
import type {
  ScheduleLocalToolInvocationRecord,
  ScheduleRecord,
  ScheduleRunOutcome,
  ScheduleToolRouteOutcome,
  ScheduleTrigger,
} from "./types";

const TICK_INTERVAL_MS = 20_000;

export interface SchedulerLoggerLike {
  info(module: string, message: string): void;
  warn(module: string, message: string): void;
  error(module: string, message: string): void;
}

export interface SchedulerDeps {
  scheduleStore: ScheduleStore;
  historyStore: ScheduleHistoryStore;
  localToolStore: LocalToolStore;
  getAgentRuntimeBaseUrl: () => string;
  getOllamaBaseUrl: () => string;
  getInterpreterPath: () => string | null;
  logger: SchedulerLoggerLike;
  /** Test-only clock override — production never passes this. */
  now?: () => Date;
  /** Test-only tick interval override. */
  tickIntervalMs?: number;
}

export class ScheduleScheduler {
  private readonly deps: SchedulerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private runningScheduleId: string | null = null;
  private runningAbort: AbortController | null = null;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Detects+records missed runs (D), then starts the recurring tick. Idempotent
   * — calling twice does not create a second interval. */
  start(): void {
    this.detectMissedRuns();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.tickIntervalMs ?? TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed separately from `start()` so tests (and app-start wiring) can
   * call it deterministically without waiting on the interval timer. */
  detectMissedRuns(): void {
    const now = this.now();
    for (const schedule of this.deps.scheduleStore.list()) {
      if (!schedule.active) continue;
      const due = new Date(schedule.nextRunAt);
      if (Number.isNaN(due.getTime()) || due.getTime() > now.getTime()) continue;

      this.deps.historyStore.append({
        scheduleId: schedule.id,
        timestamp: now.toISOString(),
        outcome: "missed",
        // "놓침"은 정의상 정기 Tick이 발견한 사실이다 — 수동 트리거는
        // 즉시 실행되므로 놓칠 수 없다.
        trigger: "scheduled",
        localToolInvocations: [],
        // 실행 자체가 없었으므로 로컬 Tool 라우팅을 시도한 적도 없다 —
        // "route_inactive"(레시피가 껐다)로 단정하지 않는다.
        toolRouteOutcome: null,
        resultSummary: null,
        resultTruncated: false,
        failureReason: `앱이 실행되지 않는 동안 ${schedule.nextRunAt}에 예정된 실행을 건너뛰었습니다.`,
      });
      this.deps.logger.warn("schedule", `스케줄 놓침 감지: ${schedule.id}`);

      let next: string;
      try {
        next = nextRunAt(schedule.expression, now).toISOString();
      } catch (err) {
        this.deps.logger.error("schedule", `다음 실행 시각 계산 실패(놓침 처리 후): ${schedule.id}`);
        continue;
      }
      this.deps.scheduleStore.updateRunState(schedule.id, {
        nextRunAt: next,
        lastRunAt: now.toISOString(),
        lastRunOutcome: "missed",
      });
    }
  }

  private async tick(): Promise<void> {
    if (this.runningScheduleId) return; // PoC 범위: 한 번에 하나만 실행한다.
    const now = this.now();
    const due = this.deps.scheduleStore
      .list()
      .find((s) => s.active && new Date(s.nextRunAt).getTime() <= now.getTime());
    if (!due) return;
    await this.execute(due, "scheduled");
  }

  /** 실사용 제보 3 — "지금 실행" 버튼이 호출하는 유일한 진입점. 정기 Tick과
   * 완전히 같은 실행 경로(`execute`)를 재사용한다(별도 경로를 새로 만들지
   * 않는다는 Task Brief 제약) — 차이는 `trigger: "manual"` 하나뿐이다.
   * F의 Tool 위험 확인 게이트를 우회하지 않는다: `toolRiskAcknowledgedAt`이
   * 없는 Tool-capable 스케줄은 정기 실행에서도 있을 수 없는 상태이지만(저장
   * 시점에 항상 강제되므로), 정식 저장 경로를 우회해 만들어졌거나 이 필드
   * 도입 이전 레코드일 가능성에 대비해 여기서도 다시 방어적으로 검사한다. */
  async runNow(scheduleId: string): Promise<{ ok: boolean; error: string | null }> {
    if (this.runningScheduleId) {
      return { ok: false, error: "다른 스케줄이 이미 실행 중입니다 — 완료된 뒤 다시 시도하세요." };
    }
    const schedule = this.deps.scheduleStore.get(scheduleId);
    if (!schedule) {
      return { ok: false, error: "스케줄을 찾을 수 없습니다." };
    }
    if (schedule.recipe.localToolRouteActive && !schedule.toolRiskAcknowledgedAt) {
      return {
        ok: false,
        error: "이 스케줄은 등록된 로컬 Tool을 호출할 수 있지만 실행 위험을 확인한 적이 없어 지금 실행할 수 없습니다 — 스케줄을 다시 저장하며 확인하세요.",
      };
    }
    await this.execute(schedule, "manual");
    return { ok: true, error: null };
  }

  private async execute(schedule: ScheduleRecord, trigger: ScheduleTrigger): Promise<void> {
    this.runningScheduleId = schedule.id;
    const abort = new AbortController();
    this.runningAbort = abort;
    const startedAt = this.now();

    try {
      let ok: boolean;
      let resultSummary: string | null = null;
      let failureReason: string | null = null;
      let localToolInvocations: ScheduleLocalToolInvocationRecord[] = [];
      // 실사용 제보(2026-08-19) — "어떤 툴이 수행됐는지 모르겠다": Tool
      // 자동선택이 아예 꺼진 레시피와, 켜져 있었지만 이번엔 라우팅이 아무
      // 것도 고르지 못한 레시피는 서로 다른 사실이다(`types.ts`의
      // `ScheduleToolRouteOutcome` 참고) — 여기서 그 둘을 구분해 채운다.
      let toolRouteOutcome: ScheduleToolRouteOutcome = "route_inactive";
      // 실사용 제보(2026-08-19) — 이 스케줄에 설정된 하나의 상한(분)을
      // agent-runtime 폴링 상한과 로컬 Tool 1회 호출 상한 양쪽에 그대로
      // 적용한다(별도 하위 상한을 만들지 않는다 — schedule-store.ts의
      // `timeoutMinutes` 필드 docstring 참고).
      const timeoutMs = schedule.timeoutMinutes * 60_000;

      if (schedule.recipe.localToolRouteActive) {
        const outcome = await invokeLocalToolForScheduledRun(
          schedule.recipe.question,
          this.deps.localToolStore.list(),
          {
            ollamaBaseUrl: this.deps.getOllamaBaseUrl(),
            chatModelAlias: schedule.recipe.chatModelAlias,
            interpreterPath: this.deps.getInterpreterPath(),
            signal: abort.signal,
            timeoutMs,
          },
        );
        ok = outcome.ok;
        resultSummary = outcome.resultSummary;
        failureReason = outcome.failureReason;
        toolRouteOutcome = outcome.toolRouteStatus;
        if (outcome.invocation) localToolInvocations = [outcome.invocation];
      } else {
        const result = await runScheduledRecipeAgainstAgentRuntime(
          this.deps.getAgentRuntimeBaseUrl(),
          schedule.recipe,
          { signal: abort.signal, maxPollMs: timeoutMs },
        );
        ok = result.ok;
        resultSummary = result.answer;
        failureReason = result.errorMessage;
      }

      const wasCancelled = abort.signal.aborted;
      const outcome: ScheduleRunOutcome = wasCancelled ? "cancelled" : ok ? "success" : "failure";
      const truncated =
        outcome === "success" && resultSummary ? truncateResultSummary(resultSummary) : null;

      this.deps.historyStore.append({
        scheduleId: schedule.id,
        timestamp: startedAt.toISOString(),
        outcome,
        trigger,
        localToolInvocations,
        toolRouteOutcome,
        resultSummary: truncated ? truncated.text : null,
        resultTruncated: truncated ? truncated.truncated : false,
        failureReason:
          outcome === "success"
            ? null
            : (failureReason ?? (wasCancelled ? "사용자가 실행을 중단했습니다." : "알 수 없는 오류입니다.")),
      });
      this.deps.logger[outcome === "success" ? "info" : "warn"](
        "schedule",
        `스케줄 실행 ${outcome}: ${schedule.id}`,
      );

      let next: string;
      try {
        next = nextRunAt(schedule.expression, this.now()).toISOString();
      } catch {
        next = schedule.nextRunAt;
      }
      this.deps.scheduleStore.updateRunState(schedule.id, {
        nextRunAt: next,
        lastRunAt: startedAt.toISOString(),
        lastRunOutcome: outcome,
      });
    } finally {
      this.runningScheduleId = null;
      this.runningAbort = null;
    }
  }

  /** Cancellation state (H) — aborts the in-flight scheduled run, if the
   * given `scheduleId` is the one currently running. */
  cancel(scheduleId: string): { ok: boolean; error: string | null } {
    if (this.runningScheduleId !== scheduleId || !this.runningAbort) {
      return { ok: false, error: "지금 실행 중인 스케줄이 아닙니다." };
    }
    this.runningAbort.abort();
    return { ok: true, error: null };
  }

  getRunningScheduleId(): string | null {
    return this.runningScheduleId;
  }
}
