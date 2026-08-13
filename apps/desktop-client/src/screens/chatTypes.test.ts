import { describe, expect, it } from "vitest";
import type { ConversationRecord, InstalledAsset } from "../../electron/types";
import { initialStages } from "../runStages";
import type { ChatMessage } from "./chatTypes";
import {
  KNOWLEDGE_NOT_ACTIVATED_REASON,
  LEGACY_BUNDLE_KNOWLEDGE_ID_REASON,
  RECONCILE_UNAVAILABLE_NOTICE,
  buildHistoryFromMessages,
  buildHubQueryPreview,
  chatMessageFromStoredTurn,
  partitionInstalledKnowledgeByActivation,
  resolveActivatedKnowledgeIds,
  resolveKnowledgeSelection,
  resolveReconcileNotice,
} from "./chatTypes";

function chatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-1",
    question: "질문",
    knowledgeIdUsed: "know-1",
    knowledgeLabelUsed: "재택근무 정책",
    serviceId: "service-1",
    agentProfile: "standard-agent",
    status: "succeeded",
    answer: "답변",
    citations: [],
    stages: initialStages(),
    eventLog: [],
    pendingConfirmation: null,
    runId: "run-1",
    traceId: "trace-1",
    startedAt: "2026-08-10T00:00:00.000Z",
    completedAt: "2026-08-10T00:00:01.000Z",
    serverRun: null,
    hubQueriesSent: [],
    ...overrides,
  };
}

function installedAsset(overrides: Partial<InstalledAsset> = {}): InstalledAsset {
  return {
    assetId: "asset-1",
    assetVersionId: "asset-version-1",
    assetType: "knowledge",
    name: "HR 정책 Knowledge",
    version: "1.0.0",
    installedAt: "2026-08-09T00:00:00.000Z",
    sizeBytes: 1234,
    bundleId: "bundle-1",
    ...overrides,
  };
}

describe("resolveKnowledgeSelection (D-060)", () => {
  it("returns an empty, non-disabled selection when nothing is selected", () => {
    expect(resolveKnowledgeSelection(null)).toEqual({ knowledgeId: "", disabledReason: null });
  });

  it("sends the AssetVersion id (not the Asset id) as knowledge_id when present", () => {
    const asset = installedAsset({ assetId: "asset-1", assetVersionId: "asset-version-1" });

    const selection = resolveKnowledgeSelection(asset);

    expect(selection).toEqual({ knowledgeId: "asset-version-1", disabledReason: null });
    // Regression guard: the two ids must never be conflated by this function.
    expect(selection.knowledgeId).not.toBe(asset.assetId);
  });

  it("refuses to fall back to assetId and reports the legacy-Bundle reason when assetVersionId is missing", () => {
    const legacyAsset = installedAsset({ assetId: "asset-1", assetVersionId: null });

    const selection = resolveKnowledgeSelection(legacyAsset);

    expect(selection.knowledgeId).toBe("");
    expect(selection.knowledgeId).not.toBe(legacyAsset.assetId);
    expect(selection.disabledReason).toBe(LEGACY_BUNDLE_KNOWLEDGE_ID_REASON);
  });
});

describe("buildHistoryFromMessages (Desktop 대화 고도화/멀티턴)", () => {
  it("returns an empty array for no messages", () => {
    expect(buildHistoryFromMessages([])).toEqual([]);
  });

  it("includes only succeeded turns with a non-empty answer", () => {
    const messages = [
      chatMessage({ id: "1", question: "q1", answer: "a1", status: "succeeded" }),
      chatMessage({ id: "2", question: "q2", answer: "", status: "insufficient_evidence" }),
      chatMessage({ id: "3", question: "q3", answer: "실행 중 오류", status: "failed" }),
      chatMessage({ id: "4", question: "q4", answer: "", status: "cancelled" }),
      chatMessage({ id: "5", question: "q5", answer: "a5", status: "succeeded" }),
    ];

    expect(buildHistoryFromMessages(messages)).toEqual([
      { question: "q1", answer: "a1" },
      { question: "q5", answer: "a5" },
    ]);
  });

  it("preserves turn order (oldest first, matching in-memory message order)", () => {
    const messages = [
      chatMessage({ id: "1", question: "first", answer: "a" }),
      chatMessage({ id: "2", question: "second", answer: "b" }),
      chatMessage({ id: "3", question: "third", answer: "c" }),
    ];
    expect(buildHistoryFromMessages(messages).map((t) => t.question)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

describe("chatMessageFromStoredTurn (D06 대화 보존 — 재시작 후 복원)", () => {
  const conversation: Pick<ConversationRecord, "knowledgeId" | "knowledgeLabel"> = {
    knowledgeId: "know-1",
    knowledgeLabel: "재택근무 정책 v1.0.0",
  };

  it("rehydrates question/answer/status and marks the turn as restored", () => {
    const message = chatMessageFromStoredTurn(
      {
        id: "turn-1",
        question: "재택근무는 며칠까지 가능한가요?",
        answer: "주 최대 2일까지 가능합니다.",
        status: "succeeded",
        citationCount: 2,
        createdAt: "2026-08-10T00:00:00.000Z",
      },
      conversation,
    );

    expect(message.question).toBe("재택근무는 며칠까지 가능한가요?");
    expect(message.answer).toBe("주 최대 2일까지 가능합니다.");
    expect(message.status).toBe("succeeded");
    expect(message.knowledgeIdUsed).toBe("know-1");
    expect(message.knowledgeLabelUsed).toBe("재택근무 정책 v1.0.0");
    expect(message.restored).toBe(true);
    expect(message.restoredCitationCount).toBe(2);
    // No live Run backs a restored turn — nothing here should look re-runnable.
    expect(message.runId).toBeNull();
    expect(message.citations).toEqual([]);
    expect(message.eventLog).toEqual([]);
  });

  it("a restored turn is itself valid history input (round-trips through buildHistoryFromMessages)", () => {
    const message = chatMessageFromStoredTurn(
      {
        id: "turn-1",
        question: "q",
        answer: "a",
        status: "succeeded",
        citationCount: 0,
        createdAt: "2026-08-10T00:00:00.000Z",
      },
      conversation,
    );
    expect(buildHistoryFromMessages([message])).toEqual([{ question: "q", answer: "a" }]);
  });
});

const ACTIVE = { state: "ACTIVE" as const, checkedAt: "2026-08-13T00:00:00.000Z", reason: null, message: null, indexPath: "/idx" };
const ALREADY_ACTIVE = {
  state: "ALREADY_ACTIVE" as const,
  checkedAt: "2026-08-13T00:00:00.000Z",
  reason: "central_index_exists",
  message: "이 Knowledge는 이미 이 배포의 기본 색인 경로에 등록되어 있어 바로 검색 가능합니다.",
  indexPath: "/idx",
};
const FAILED = (message: string) => ({
  state: "FAILED" as const,
  checkedAt: "2026-08-13T00:00:00.000Z",
  reason: "index_dir_missing",
  message,
  indexPath: "/idx",
});

describe("partitionInstalledKnowledgeByActivation / resolveActivatedKnowledgeIds (D-079 이어 붙이기 — 활성화 인지 지식 검색)", () => {
  it("returns empty usable/excluded for an empty list", () => {
    expect(partitionInstalledKnowledgeByActivation([])).toEqual({ usable: [], excluded: [] });
    expect(resolveActivatedKnowledgeIds([])).toEqual([]);
  });

  it("treats a legacy-Bundle asset (no assetVersionId) as excluded with the D-060 reason, never as usable", () => {
    const legacyAsset = installedAsset({ assetId: "asset-legacy", assetVersionId: null, activation: ACTIVE });

    const result = partitionInstalledKnowledgeByActivation([legacyAsset]);

    expect(result.usable).toEqual([]);
    expect(result.excluded).toEqual([{ asset: legacyAsset, reason: LEGACY_BUNDLE_KNOWLEDGE_ID_REASON }]);
  });

  it("excludes a Knowledge that has never been activated (activation field absent) with the '미시도' reason", () => {
    const neverActivated = installedAsset({ assetId: "asset-1", assetVersionId: "av-1" });

    const result = partitionInstalledKnowledgeByActivation([neverActivated]);

    expect(result.usable).toEqual([]);
    expect(result.excluded).toEqual([{ asset: neverActivated, reason: KNOWLEDGE_NOT_ACTIVATED_REASON }]);
  });

  it("excludes a Knowledge that was explicitly deactivated (activation === null) the same as 'never attempted'", () => {
    const deactivated = installedAsset({ assetId: "asset-1", assetVersionId: "av-1", activation: null });

    const result = partitionInstalledKnowledgeByActivation([deactivated]);

    expect(result.excluded).toEqual([{ asset: deactivated, reason: KNOWLEDGE_NOT_ACTIVATED_REASON }]);
  });

  it("excludes a Knowledge whose activation failed and surfaces the server's own Korean message", () => {
    const failed = installedAsset({
      assetId: "asset-1",
      assetVersionId: "av-1",
      activation: FAILED("search-runtime이 이 경로를 거부했습니다."),
    });

    const result = partitionInstalledKnowledgeByActivation([failed]);

    expect(result.usable).toEqual([]);
    expect(result.excluded).toEqual([{ asset: failed, reason: "search-runtime이 이 경로를 거부했습니다." }]);
  });

  it("includes only ACTIVE Knowledge as usable, and resolveActivatedKnowledgeIds mirrors it", () => {
    const active1 = installedAsset({ assetId: "asset-1", assetVersionId: "av-1", activation: ACTIVE });
    const neverActivated = installedAsset({ assetId: "asset-2", assetVersionId: "av-2" });
    const active2 = installedAsset({ assetId: "asset-3", assetVersionId: "av-3", activation: ACTIVE });
    const legacy = installedAsset({ assetId: "asset-4", assetVersionId: null, activation: ACTIVE });
    const nonKnowledge = installedAsset({
      assetId: "asset-5",
      assetVersionId: "av-5",
      assetType: "agent",
      activation: ACTIVE,
    });

    const assets = [active1, neverActivated, active2, legacy, nonKnowledge];
    const result = partitionInstalledKnowledgeByActivation(assets);

    expect(result.usable).toEqual([
      { knowledgeId: "av-1", asset: active1 },
      { knowledgeId: "av-3", asset: active2 },
    ]);
    expect(result.excluded.map((e) => e.asset.assetId)).toEqual(["asset-2", "asset-4"]);
    expect(resolveActivatedKnowledgeIds(assets)).toEqual(["av-1", "av-3"]);
  });

  // central-index-exists-not-a-failure (2026-08-13 실사용 진단): search-runtime
  // refuses local registration for a knowledge_id that already exists under
  // its own central INDEX_BASE (reason "central_index_exists") — that
  // Knowledge is already searchable, so it must count as usable for chat,
  // exactly like a real ACTIVE registration, not as a failure.
  it("treats an ALREADY_ACTIVE Knowledge (central_index_exists) as usable, same as ACTIVE", () => {
    const alreadyActive = installedAsset({ assetId: "asset-1", assetVersionId: "av-1", activation: ALREADY_ACTIVE });

    const result = partitionInstalledKnowledgeByActivation([alreadyActive]);

    expect(result.usable).toEqual([{ knowledgeId: "av-1", asset: alreadyActive }]);
    expect(result.excluded).toEqual([]);
    expect(resolveActivatedKnowledgeIds([alreadyActive])).toEqual(["av-1"]);
  });
});

describe("buildHubQueryPreview (허브 질의 미리보기 — 로컬 문서 내용 제외)", () => {
  const LOCAL_ANSWER_MARKER = "로컬-문서-내용-마커-Z8f";

  it("never includes a prior turn's answer text, even when it contains local document content", () => {
    const messages = [
      chatMessage({ id: "1", question: "재택근무 정책이 뭐야?", answer: LOCAL_ANSWER_MARKER, status: "succeeded" }),
    ];

    const preview = buildHubQueryPreview("추가로 궁금한 점", messages);

    expect(preview).not.toContain(LOCAL_ANSWER_MARKER);
    expect(preview).toContain("재택근무 정책이 뭐야?");
    expect(preview).toContain("추가로 궁금한 점");
  });

  it("joins prior questions (oldest first) and the current draft, newline-separated", () => {
    const messages = [
      chatMessage({ id: "1", question: "질문1", answer: "답변1" }),
      chatMessage({ id: "2", question: "질문2", answer: "답변2" }),
    ];

    expect(buildHubQueryPreview("현재 입력", messages)).toBe("질문1\n질문2\n현재 입력");
  });

  it("returns an empty string when there is no history and no draft", () => {
    expect(buildHubQueryPreview("", [])).toBe("");
  });

  it("omits an empty draft rather than appending a trailing blank line", () => {
    const messages = [chatMessage({ id: "1", question: "질문1", answer: "답변1" })];

    expect(buildHubQueryPreview("   ", messages)).toBe("질문1");
  });
});

describe("resolveReconcileNotice (2026-08-13 실제 장애 재발 방지 — bridge.reconcileKnowledgeActivations is not a function)", () => {
  it("returns null (안내 없음) when the bridge confirms everything is still ACTIVE", async () => {
    const bridge = { reconcileKnowledgeActivations: async () => ({ checked: true, error: null }) };
    expect(await resolveReconcileNotice(bridge)).toBeNull();
  });

  it("surfaces the server's Korean error text when search-runtime could not be reached", async () => {
    const bridge = {
      reconcileKnowledgeActivations: async () => ({ checked: false, error: "search-runtime에 연결할 수 없습니다." }),
    };
    expect(await resolveReconcileNotice(bridge)).toBe("search-runtime에 연결할 수 없습니다.");
  });

  it("falls back to the standard notice when checked is false with no error text", async () => {
    const bridge = { reconcileKnowledgeActivations: async () => ({ checked: false, error: null }) };
    expect(await resolveReconcileNotice(bridge)).toBe(RECONCILE_UNAVAILABLE_NOTICE);
  });

  it("degrades to the standard notice — never throws — when the bridge has no such method at all (stale preload.js)", async () => {
    const bridge = {};
    await expect(resolveReconcileNotice(bridge)).resolves.toBe(RECONCILE_UNAVAILABLE_NOTICE);
  });

  it("degrades to the standard notice — never throws — when the bridge is null", async () => {
    await expect(resolveReconcileNotice(null)).resolves.toBe(RECONCILE_UNAVAILABLE_NOTICE);
  });

  it("degrades to the standard notice — never throws — when the call itself throws a plain value", async () => {
    const bridge = {
      reconcileKnowledgeActivations: async () => {
        throw "boom";
      },
    };
    await expect(resolveReconcileNotice(bridge)).resolves.toBe(RECONCILE_UNAVAILABLE_NOTICE);
  });

  it("surfaces the thrown Error's message when the call rejects with an Error", async () => {
    const bridge = {
      reconcileKnowledgeActivations: async () => {
        throw new Error("네트워크 시간 초과");
      },
    };
    expect(await resolveReconcileNotice(bridge)).toBe("네트워크 시간 초과");
  });
});
