import { describe, expect, it } from "vitest";
import type { ConversationRecord, InstalledAsset } from "../../electron/types";
import { initialStages } from "../runStages";
import type { ChatMessage } from "./chatTypes";
import {
  LEGACY_BUNDLE_KNOWLEDGE_ID_REASON,
  buildHistoryFromMessages,
  chatMessageFromStoredTurn,
  resolveKnowledgeSelection,
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
