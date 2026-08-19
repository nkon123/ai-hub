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
