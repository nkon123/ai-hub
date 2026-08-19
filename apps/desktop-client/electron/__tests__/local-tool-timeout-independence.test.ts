// 실사용 제보(2026-08-19) — 대화형 로컬 Tool 실행 타임아웃
// (`DesktopSettingsStore.localToolTimeoutMinutes`)과 스케줄별 실행 타임아웃
// (`ScheduleStore`/`ScheduleRecord.timeoutMinutes`)은 서로 다른 실행
// 경로(대화 대 무인 스케줄)의 서로 다른 상한이다 — 한쪽을 바꿔도 다른 쪽은
// 전혀 영향을 받지 않아야 한다는 것이 Task Brief의 명시적 요구사항이다. 두
// 저장소가 서로 다른 파일(`desktop-settings.json`/`schedules.json`)에
// 완전히 분리된 필드를 쓴다는 사실만으로는 "절대 서로 영향을 주지 않는다"는
// 계약이 회귀하지 않는다는 보장이 되지 않으므로, 실제로 한쪽을 바꿔도 다른
// 쪽 값이 그대로인지 여기서 직접 고정한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_TOOL_TIMEOUT_MINUTES, DesktopSettingsStore } from "../desktop-settings";
import { DEFAULT_SCHEDULE_TIMEOUT_MINUTES, ScheduleStore } from "../schedule-store";
import type { ScheduleRecipe } from "../types";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-local-tool-timeout-independence-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function recipe(): ScheduleRecipe {
  return {
    question: "이번 주 재고 현황을 요약해줘",
    knowledgeLookupActive: true,
    knowledgeIds: ["asset-1"],
    localToolRouteActive: false,
    localAgentId: null,
    chatModelAlias: "default-chat",
  };
}

describe("interactive local-tool timeout and per-schedule timeout are independent", () => {
  it("changing the interactive (D10) timeout does not change an existing schedule's timeoutMinutes", () => {
    const scheduleStore = new ScheduleStore(tmpDir);
    const saved = scheduleStore.saveWithToolRiskAck(
      { name: "매일 재고 요약", expression: { kind: "daily", hour: 9, minute: 0 }, recipe: recipe(), active: true, timeoutMinutes: 45 },
      { acknowledgedToolRisk: false },
    );
    expect(saved.ok).toBe(true);
    expect(saved.schedule?.timeoutMinutes).toBe(45);

    const desktopSettingsStore = new DesktopSettingsStore(tmpDir);
    const updated = desktopSettingsStore.update({ localToolTimeoutMinutes: 30 });
    expect(updated.ok).toBe(true);
    expect(updated.settings.localToolTimeoutMinutes).toBe(30);

    // The schedule's own timeout is untouched by the interactive setting change.
    const reread = scheduleStore.get(saved.schedule!.id);
    expect(reread?.timeoutMinutes).toBe(45);
  });

  it("changing a schedule's timeoutMinutes does not change the interactive (D10) setting", () => {
    const desktopSettingsStore = new DesktopSettingsStore(tmpDir);
    expect(desktopSettingsStore.getPublic().localToolTimeoutMinutes).toBe(DEFAULT_LOCAL_TOOL_TIMEOUT_MINUTES);

    const scheduleStore = new ScheduleStore(tmpDir);
    const saved = scheduleStore.saveWithToolRiskAck(
      { name: "매일 재고 요약", expression: { kind: "daily", hour: 9, minute: 0 }, recipe: recipe(), active: true, timeoutMinutes: 120 },
      { acknowledgedToolRisk: false },
    );
    expect(saved.ok).toBe(true);
    expect(saved.schedule?.timeoutMinutes).toBe(120);
    expect(saved.schedule?.timeoutMinutes).not.toBe(DEFAULT_SCHEDULE_TIMEOUT_MINUTES);

    // The interactive setting is untouched by the schedule's own timeout.
    expect(desktopSettingsStore.getPublic().localToolTimeoutMinutes).toBe(DEFAULT_LOCAL_TOOL_TIMEOUT_MINUTES);
  });
});
