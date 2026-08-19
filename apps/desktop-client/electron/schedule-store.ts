// D14 "등록된 에이전트를 스케줄에 따라 수행" — Main-process-only persisted
// store (fs access), same lifecycle pattern as `ConversationStore`/
// `LocalToolStore`: single JSON file under `stateDir`, constructor creates
// the directory if missing, corrupted file => treat as empty (Desktop은
// 상태 파일 손상 시에도 종료되지 않는다).
//
// F("Tool 위험 확인 게이트")의 구조적 강제 지점이 이 파일이다 —
// `LocalToolStore.add()`가 `acknowledgedRisk`를 구조적으로 강제하는 것과
// 정확히 같은 자리: `saveWithToolRiskAck()`는 recipe가 Tool을 호출할 수
// 있는데 확인이 없으면 아무것도 쓰지 않는다. 렌더러의 확인 화면은 이 게이트를
// "보조"할 뿐 대체하지 않는다 — IPC를 우회해 `saveSchedule`을 직접 호출하는
// 어떤 코드도 이 검사를 피할 수 없다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nextRunAt } from "./schedule-time";
import type { ScheduleRecipe, ScheduleRecord, ScheduleRunOutcome, ScheduleSaveInput, ScheduleSaveResult } from "./types";

// 실사용 제보(2026-08-19) — "스케줄 등록한 에이전트에 타임아웃이 설정되어
// 있는 것 같은데, 설정할 수 있도록 해주고 기본 30분 정도로 해줘". 상한을
// 완전히 없애지 않는다(무제한 대기는 죽은 실행을 영원히 "실행 중"으로
// 붙잡아 두어 `runningScheduleId`가 다른 모든 스케줄을 영구히 막을 수
// 있다) — 6시간이면 이 앱의 실사용 시나리오(야간 배치성 질의/Tool 호출)를
// 넉넉히 덮으면서도 그 위험을 제한한다. 최소 1분은 "0분"처럼 사실상
// 즉시-타임아웃되는 무의미한 설정을 막는다.
export const DEFAULT_SCHEDULE_TIMEOUT_MINUTES = 30;
export const MIN_SCHEDULE_TIMEOUT_MINUTES = 1;
export const MAX_SCHEDULE_TIMEOUT_MINUTES = 360;

/** 이 레시피가 실행 시 로컬 Tool을 호출할 수 있는지 — F의 위험 확인 게이트가
 * 검사하는 유일한 신호. `localToolRouteActive`만 본다: `localAgentId`나
 * Knowledge 검색은 로컬에서 임의 코드를 실행하지 않는다(전자는 agent-runtime이
 * 중개하는 표준 Prompt 실행, 후자는 읽기 전용 검색이다). */
function isToolCapable(recipe: ScheduleRecipe): boolean {
  return recipe.localToolRouteActive === true;
}

/** 재확인이 필요한 변경인지(F 제약: "toolRouteActive를 끄기->켜기로 바꾸거나,
 * 질문 텍스트가 바뀌면 재확인이 필요하다. 이름만 바꾸거나 시간만 바꾸는
 * 사소한 편집은 재확인을 요구하지 않는다"). 신규 생성은 항상 재확인이
 * 필요하다(이전 확인이 있을 수 없다). */
function requiresReAcknowledgement(existing: ScheduleRecord | null, nextRecipe: ScheduleRecipe): boolean {
  if (!existing) return true;
  const turnedOn = !existing.recipe.localToolRouteActive && nextRecipe.localToolRouteActive;
  const questionChanged = existing.recipe.question !== nextRecipe.question;
  return turnedOn || questionChanged;
}

export class ScheduleStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, "schedules.json");
  }

  private readAll(): ScheduleRecord[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      if (!Array.isArray(parsed)) return [];
      // 레거시 정규화 — `timeoutMinutes`가 없는(이 필드 도입 이전) 레코드는
      // 기본값으로 채운다(`local-tool-store.ts`의 `approval` 레거시 정규화와
      // 같은 스타일).
      return (parsed as ScheduleRecord[]).map((r) => ({
        ...r,
        timeoutMinutes: r.timeoutMinutes ?? DEFAULT_SCHEDULE_TIMEOUT_MINUTES,
      }));
    } catch {
      return [];
    }
  }

  private save(records: ScheduleRecord[]): void {
    fs.writeFileSync(this.filePath, JSON.stringify(records, null, 2), "utf-8");
  }

  list(): ScheduleRecord[] {
    return this.readAll();
  }

  get(id: string): ScheduleRecord | null {
    return this.readAll().find((r) => r.id === id) ?? null;
  }

  /** Create or edit, gated by F's Tool 위험 확인 requirement. `ack`이
   * `acknowledgedToolRisk: true`가 아니어도, recipe가 Tool을 호출할 수
   * 없거나 재확인이 필요 없는 사소한 편집이면 그대로 저장된다(스푸리어스
   * 확인 요구 금지). */
  saveWithToolRiskAck(input: ScheduleSaveInput, ack: { acknowledgedToolRisk: boolean }): ScheduleSaveResult {
    if (!input.name.trim()) {
      return { ok: false, schedule: null, error: "스케줄 이름을 입력하세요.", requiresToolRiskAck: false };
    }
    if (!input.recipe.question.trim()) {
      return { ok: false, schedule: null, error: "실행할 질문을 입력하세요.", requiresToolRiskAck: false };
    }
    const timeoutMinutes = input.timeoutMinutes ?? DEFAULT_SCHEDULE_TIMEOUT_MINUTES;
    if (
      !Number.isFinite(timeoutMinutes) ||
      timeoutMinutes < MIN_SCHEDULE_TIMEOUT_MINUTES ||
      timeoutMinutes > MAX_SCHEDULE_TIMEOUT_MINUTES
    ) {
      return {
        ok: false,
        schedule: null,
        error: `실행 타임아웃은 ${MIN_SCHEDULE_TIMEOUT_MINUTES}분에서 ${MAX_SCHEDULE_TIMEOUT_MINUTES}분 사이여야 합니다.`,
        requiresToolRiskAck: false,
      };
    }

    const all = this.readAll();
    const existing = input.id ? (all.find((r) => r.id === input.id) ?? null) : null;
    if (input.id && !existing) {
      return { ok: false, schedule: null, error: "스케줄을 찾을 수 없습니다.", requiresToolRiskAck: false };
    }

    const toolCapable = isToolCapable(input.recipe);
    const needsAck = toolCapable && requiresReAcknowledgement(existing, input.recipe);
    if (needsAck && ack.acknowledgedToolRisk !== true) {
      return {
        ok: false,
        schedule: null,
        error: "이 스케줄은 등록된 로컬 Tool을 사람의 확인 없이 호출할 수 있습니다 — 실행 위험을 확인해야 저장할 수 있습니다.",
        requiresToolRiskAck: true,
      };
    }

    const now = new Date().toISOString();
    let toolRiskAcknowledgedAt: string | null;
    if (!toolCapable) {
      toolRiskAcknowledgedAt = null;
    } else if (ack.acknowledgedToolRisk === true) {
      toolRiskAcknowledgedAt = now;
    } else {
      // needsAck was false here, so an earlier acknowledgement must exist.
      toolRiskAcknowledgedAt = existing?.toolRiskAcknowledgedAt ?? now;
    }

    let nextRun: string;
    try {
      nextRun = nextRunAt(input.expression, new Date()).toISOString();
    } catch (err) {
      return {
        ok: false,
        schedule: null,
        error: `스케줄 시각을 계산할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`,
        requiresToolRiskAck: false,
      };
    }

    const record: ScheduleRecord = existing
      ? {
          ...existing,
          name: input.name.trim(),
          expression: input.expression,
          recipe: input.recipe,
          active: input.active,
          toolRiskAcknowledgedAt,
          timeoutMinutes,
          updatedAt: now,
          nextRunAt: nextRun,
        }
      : {
          id: crypto.randomUUID(),
          name: input.name.trim(),
          expression: input.expression,
          recipe: input.recipe,
          active: input.active,
          toolRiskAcknowledgedAt,
          timeoutMinutes,
          createdAt: now,
          updatedAt: now,
          nextRunAt: nextRun,
          lastRunAt: null,
          lastRunOutcome: null,
        };

    const nextAll = existing ? all.map((r) => (r.id === record.id ? record : r)) : [...all, record];
    this.save(nextAll);
    return { ok: true, schedule: record, error: null, requiresToolRiskAck: false };
  }

  /** CLAUDE.md: 폐기는 확인과 사유를 요구한다. */
  remove(id: string, reason: string): { ok: boolean; error: string | null } {
    if (!reason || !reason.trim()) {
      return { ok: false, error: "삭제 사유를 입력해야 합니다." };
    }
    const all = this.readAll();
    if (!all.some((r) => r.id === id)) {
      return { ok: false, error: "스케줄을 찾을 수 없습니다." };
    }
    this.save(all.filter((r) => r.id !== id));
    return { ok: true, error: null };
  }

  /** 활성/비활성 전환 — 사소한 시간 필드 변경과 달리 실행 여부 자체를
   * 바꾸므로 CLAUDE.md의 "중단은 확인과 사유를 요구한다"를 따른다. */
  setActive(id: string, active: boolean, reason: string): { ok: boolean; error: string | null; schedule: ScheduleRecord | null } {
    if (!reason || !reason.trim()) {
      return { ok: false, error: "사유를 입력해야 합니다.", schedule: null };
    }
    const all = this.readAll();
    const idx = all.findIndex((r) => r.id === id);
    if (idx === -1) {
      return { ok: false, error: "스케줄을 찾을 수 없습니다.", schedule: null };
    }
    const now = new Date().toISOString();
    let record = { ...all[idx], active, updatedAt: now };
    // 다시 활성화할 때는 정지된 동안 쌓인 드리프트 없이 "지금부터의 다음
    // 실행"으로 새로 계산한다.
    if (active) {
      try {
        record = { ...record, nextRunAt: nextRunAt(record.expression, new Date()).toISOString() };
      } catch {
        // 계산 불가면 기존 nextRunAt을 그대로 둔다(활성화 자체는 막지 않음).
      }
    }
    all[idx] = record;
    this.save(all);
    return { ok: true, error: null, schedule: record };
  }

  /** 스케줄러가 실행/누락 처리 직후 호출한다 — recipe/이름/활성 여부는
   * 건드리지 않으므로 F의 위험 확인 게이트를 다시 거치지 않는다(타이밍
   * 필드만 바뀐다). */
  updateRunState(
    id: string,
    patch: { nextRunAt: string; lastRunAt?: string; lastRunOutcome?: ScheduleRunOutcome },
  ): ScheduleRecord | null {
    const all = this.readAll();
    const idx = all.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    const updated: ScheduleRecord = {
      ...all[idx],
      nextRunAt: patch.nextRunAt,
      lastRunAt: patch.lastRunAt ?? all[idx].lastRunAt,
      lastRunOutcome: patch.lastRunOutcome ?? all[idx].lastRunOutcome,
      updatedAt: new Date().toISOString(),
    };
    all[idx] = updated;
    this.save(all);
    return updated;
  }
}
