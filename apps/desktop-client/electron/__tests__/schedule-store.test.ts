import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduleStore } from "../schedule-store";
import type { ScheduleRecipe, ScheduleSaveInput } from "../types";

let tmpDir: string;
let store: ScheduleStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-store-"));
  store = new ScheduleStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function knowledgeOnlyRecipe(question = "이번 달 정책 요약을 알려줘"): ScheduleRecipe {
  return {
    question,
    knowledgeLookupActive: true,
    knowledgeIds: ["asset-1"],
    localToolRouteActive: false,
    localAgentId: null,
    chatModelAlias: "default-chat",
  };
}

function toolCapableRecipe(question = "최신 매출 집계를 조회해줘"): ScheduleRecipe {
  return {
    question,
    knowledgeLookupActive: false,
    knowledgeIds: [],
    localToolRouteActive: true,
    localAgentId: null,
    chatModelAlias: "default-chat",
  };
}

function saveInput(recipe: ScheduleRecipe, overrides: Partial<ScheduleSaveInput> = {}): ScheduleSaveInput {
  return {
    name: "테스트 스케줄",
    expression: { kind: "daily", hour: 9, minute: 0 },
    recipe,
    active: true,
    ...overrides,
  };
}

describe("ScheduleStore — Tool risk acknowledgement gate (F)", () => {
  it("saves a Knowledge-only (non-tool-capable) recipe without requiring any acknowledgement", () => {
    const result = store.saveWithToolRiskAck(saveInput(knowledgeOnlyRecipe()), { acknowledgedToolRisk: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schedule.toolRiskAcknowledgedAt).toBeNull();
    }
  });

  it("refuses to create a tool-capable schedule without acknowledgement", () => {
    const result = store.saveWithToolRiskAck(saveInput(toolCapableRecipe()), { acknowledgedToolRisk: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.requiresToolRiskAck).toBe(true);
    }
    expect(store.list()).toHaveLength(0);
  });

  it("creates a tool-capable schedule when acknowledged, recording toolRiskAcknowledgedAt", () => {
    const result = store.saveWithToolRiskAck(saveInput(toolCapableRecipe()), { acknowledgedToolRisk: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schedule.toolRiskAcknowledgedAt).not.toBeNull();
    }
  });

  it("editing only the schedule's name/timing does not require re-acknowledgement", () => {
    const created = store.saveWithToolRiskAck(saveInput(toolCapableRecipe()), { acknowledgedToolRisk: true });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const edited = store.saveWithToolRiskAck(
      saveInput(toolCapableRecipe(), { id: created.schedule.id, name: "새 이름", expression: { kind: "hourly", minute: 15 } }),
      { acknowledgedToolRisk: false },
    );
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.schedule.name).toBe("새 이름");
      // Acknowledgement carries forward from the original creation.
      expect(edited.schedule.toolRiskAcknowledgedAt).toBe(created.schedule.toolRiskAcknowledgedAt);
    }
  });

  it("editing the question text on a tool-capable schedule requires re-acknowledgement", () => {
    const created = store.saveWithToolRiskAck(saveInput(toolCapableRecipe("원래 질문")), { acknowledgedToolRisk: true });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const rejected = store.saveWithToolRiskAck(
      saveInput(toolCapableRecipe("바뀐 질문"), { id: created.schedule.id }),
      { acknowledgedToolRisk: false },
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.requiresToolRiskAck).toBe(true);

    const accepted = store.saveWithToolRiskAck(
      saveInput(toolCapableRecipe("바뀐 질문"), { id: created.schedule.id }),
      { acknowledgedToolRisk: true },
    );
    expect(accepted.ok).toBe(true);
  });

  it("turning localToolRouteActive from off to on requires re-acknowledgement", () => {
    const created = store.saveWithToolRiskAck(saveInput(knowledgeOnlyRecipe()), { acknowledgedToolRisk: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const turnedOn: ScheduleRecipe = { ...knowledgeOnlyRecipe(), localToolRouteActive: true };
    const rejected = store.saveWithToolRiskAck(saveInput(turnedOn, { id: created.schedule.id }), {
      acknowledgedToolRisk: false,
    });
    expect(rejected.ok).toBe(false);

    const accepted = store.saveWithToolRiskAck(saveInput(turnedOn, { id: created.schedule.id }), {
      acknowledgedToolRisk: true,
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.schedule.toolRiskAcknowledgedAt).not.toBeNull();
  });

  it("turning localToolRouteActive from on to off does not require re-acknowledgement (risk surface shrinks)", () => {
    const created = store.saveWithToolRiskAck(saveInput(toolCapableRecipe()), { acknowledgedToolRisk: true });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const turnedOff: ScheduleRecipe = { ...toolCapableRecipe(), localToolRouteActive: false };
    const result = store.saveWithToolRiskAck(saveInput(turnedOff, { id: created.schedule.id }), {
      acknowledgedToolRisk: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.schedule.toolRiskAcknowledgedAt).toBeNull();
  });
});

describe("ScheduleStore — CRUD and reason-required actions", () => {
  it("rejects removal without a reason", () => {
    const created = store.saveWithToolRiskAck(saveInput(knowledgeOnlyRecipe()), { acknowledgedToolRisk: false });
    if (!created.ok) throw new Error("setup failed");
    const result = store.remove(created.schedule.id, "");
    expect(result.ok).toBe(false);
    expect(store.list()).toHaveLength(1);
  });

  it("removes with a reason", () => {
    const created = store.saveWithToolRiskAck(saveInput(knowledgeOnlyRecipe()), { acknowledgedToolRisk: false });
    if (!created.ok) throw new Error("setup failed");
    const result = store.remove(created.schedule.id, "더 이상 필요하지 않음");
    expect(result.ok).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("setActive requires a reason and updates nextRunAt on reactivation", () => {
    const created = store.saveWithToolRiskAck(saveInput(knowledgeOnlyRecipe()), { acknowledgedToolRisk: false });
    if (!created.ok) throw new Error("setup failed");
    const rejected = store.setActive(created.schedule.id, false, "");
    expect(rejected.ok).toBe(false);
    const deactivated = store.setActive(created.schedule.id, false, "일시 중단");
    expect(deactivated.ok).toBe(true);
    expect(deactivated.schedule?.active).toBe(false);
    const reactivated = store.setActive(created.schedule.id, true, "다시 시작");
    expect(reactivated.ok).toBe(true);
    expect(reactivated.schedule?.active).toBe(true);
  });

  it("survives a corrupted state file by treating it as empty", () => {
    fs.writeFileSync(path.join(tmpDir, "schedules.json"), "{not valid json", "utf-8");
    const freshStore = new ScheduleStore(tmpDir);
    expect(freshStore.list()).toEqual([]);
  });
});

// 실사용 제보(2026-08-19) — "스케줄 등록한 에이전트에 타임아웃이 설정되어
// 있는 것 같은데, 설정할 수 있도록 해주고 기본 30분 정도로 해줘".
describe("ScheduleStore — timeoutMinutes", () => {
  it("defaults to 30 minutes when not provided", () => {
    const result = store.saveWithToolRiskAck(saveInput(knowledgeOnlyRecipe()), { acknowledgedToolRisk: false });
    if (!result.ok) throw new Error("setup failed");
    expect(result.schedule.timeoutMinutes).toBe(30);
  });

  it("accepts an explicit value within bounds", () => {
    const result = store.saveWithToolRiskAck(saveInput(knowledgeOnlyRecipe(), { timeoutMinutes: 90 }), {
      acknowledgedToolRisk: false,
    });
    if (!result.ok) throw new Error("setup failed");
    expect(result.schedule.timeoutMinutes).toBe(90);
  });

  it("rejects a value below the minimum", () => {
    const result = store.saveWithToolRiskAck(saveInput(knowledgeOnlyRecipe(), { timeoutMinutes: 0 }), {
      acknowledgedToolRisk: false,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a value above the maximum", () => {
    const result = store.saveWithToolRiskAck(saveInput(knowledgeOnlyRecipe(), { timeoutMinutes: 361 }), {
      acknowledgedToolRisk: false,
    });
    expect(result.ok).toBe(false);
  });

  it("normalizes a legacy record written before this field existed to 30 minutes", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const legacy = [
      {
        id: "s1",
        name: "레거시",
        expression: { kind: "daily", hour: 9, minute: 0 },
        recipe: knowledgeOnlyRecipe(),
        active: true,
        toolRiskAcknowledgedAt: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        nextRunAt: "2026-08-02T09:00:00.000Z",
        lastRunAt: null,
        lastRunOutcome: null,
        // timeoutMinutes 필드 자체가 없다(이 필드 도입 이전 레코드).
      },
    ];
    fs.writeFileSync(path.join(tmpDir, "schedules.json"), JSON.stringify(legacy));
    const freshStore = new ScheduleStore(tmpDir);
    expect(freshStore.get("s1")?.timeoutMinutes).toBe(30);
  });
});
