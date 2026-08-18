import { describe, expect, it } from "vitest";
import type { ConversationRecord, InstalledAsset } from "../../electron/types";
import { initialStages } from "../runStages";
import type { ChatMessage } from "./chatTypes";
import {
  KNOWLEDGE_NOT_ACTIVATED_REASON,
  LEGACY_BUNDLE_KNOWLEDGE_ID_REASON,
  RECONCILE_SAME_CAUSE_NOTICE,
  RECONCILE_UNAVAILABLE_NOTICE,
  buildHistoryFromMessages,
  buildHubQueryPreview,
  chatMessageFromStoredTurn,
  describeKnowledgeRoute,
  describeToolRouteMcpToolsHint,
  describeToolRouteRejected,
  describeToolRouteSelected,
  groupExcludedKnowledgeByReason,
  groupKnowledgeRouteChoicesByReason,
  partitionInstalledKnowledgeByActivation,
  resolveActivatedKnowledgeIds,
  resolveExcludedRowText,
  resolveKnowledgeSelection,
  resolveReconcileCaption,
  resolveReconcileNotice,
  selectRegisteredLocalAgents,
  summarizeMcpToolConnections,
} from "./chatTypes";

function chatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-1",
    question: "질문",
    knowledgeIdUsed: "know-1",
    knowledgeLabelUsed: "재택근무 정책",
    serviceId: "service-1",
    agentProfile: "standard-agent",
    localAgentIdUsed: null,
    localAgentLabelUsed: null,
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
    knowledgeCandidateNameById: {},
    knowledgeRoute: null,
    toolRoute: null,
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

describe("selectRegisteredLocalAgents (D-034 해석 경로 4 / D-087 — 대화 화면이 실제로 쓰는 후보 필터)", () => {
  it("returns empty for an empty list", () => {
    expect(selectRegisteredLocalAgents([])).toEqual([]);
  });

  it("includes an ACTIVE registration", () => {
    const active = installedAsset({
      assetId: "agent-1",
      assetType: "agent",
      localAgentRegistration: {
        state: "ACTIVE",
        checkedAt: "now",
        reason: null,
        message: null,
        promptAssetId: "prompt-1",
        promptVersion: "1.0.0",
        promptLabel: "HR 규정 Prompt",
      },
    });

    expect(selectRegisteredLocalAgents([active])).toEqual([active]);
  });

  it("excludes a FAILED registration whose paired Prompt was removed (D-087 — must never surface as a selectable candidate)", () => {
    const promptRemoved = installedAsset({
      assetId: "agent-1",
      assetType: "agent",
      localAgentRegistration: {
        state: "FAILED",
        checkedAt: "now",
        reason: "prompt_removed",
        message: '짝지어 등록했던 Prompt "HR 규정 Prompt"가 제거되어 이 Agent를 대화에 쓸 수 없습니다.',
        promptAssetId: null,
        promptVersion: null,
        promptLabel: null,
      },
    });

    expect(selectRegisteredLocalAgents([promptRemoved])).toEqual([]);
  });

  it("excludes an Agent that was never registered (field absent)", () => {
    const neverRegistered = installedAsset({ assetId: "agent-1", assetType: "agent" });

    expect(selectRegisteredLocalAgents([neverRegistered])).toEqual([]);
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

// 반복 설명 정리(2026-08-14) — 사용자가 실제로 본 화면: 활성화 안 됨
// 패널에 같은 ~3줄 설명(제외 사유 → 방금 누른 재시도의 feedback.message →
// reconcile 안내)이 세 번 찍혔다. 아래 세 그룹의 테스트가 그 중복 제거
// 로직을 검증한다 — 무엇이 보고되는지(어떤 자산이 왜 제외됐는지)는 항상
// 그대로 확인 가능해야 하고, 사유가 실제로 다르면 절대 하나로 뭉개지지
// 않아야 한다.
describe("groupExcludedKnowledgeByReason (반복 설명 정리)", () => {
  it("returns an empty group for no excluded assets", () => {
    expect(groupExcludedKnowledgeByReason([])).toEqual({ sharedReason: null, items: [] });
  });

  it("hoists the shared reason once when every excluded asset has the identical reason text (환경적 원인 — search-runtime 장애)", () => {
    const same = "search-runtime을 재시작한 뒤 다시 시도하세요 — Knowledge 활성화 API가 없습니다(HTTP 404).";
    const assetA = installedAsset({ assetId: "asset-a", assetVersionId: "av-a" });
    const assetB = installedAsset({ assetId: "asset-b", assetVersionId: "av-b" });

    const result = groupExcludedKnowledgeByReason([
      { asset: assetA, reason: same },
      { asset: assetB, reason: same },
    ]);

    expect(result.sharedReason).toBe(same);
    // Nothing about *which* assets were excluded is lost — both rows remain,
    // each simply carries reason: null (already stated once above).
    expect(result.items).toEqual([
      { asset: assetA, reason: null },
      { asset: assetB, reason: null },
    ]);
  });

  it("keeps each asset's own reason when reasons genuinely differ (no false collapsing of distinct causes)", () => {
    const assetA = installedAsset({ assetId: "asset-a", assetVersionId: "av-a" });
    const assetB = installedAsset({ assetId: "asset-b", assetVersionId: null });

    const result = groupExcludedKnowledgeByReason([
      { asset: assetA, reason: "search-runtime을 재시작하세요." },
      { asset: assetB, reason: LEGACY_BUNDLE_KNOWLEDGE_ID_REASON },
    ]);

    expect(result.sharedReason).toBeNull();
    expect(result.items).toEqual([
      { asset: assetA, reason: "search-runtime을 재시작하세요." },
      { asset: assetB, reason: LEGACY_BUNDLE_KNOWLEDGE_ID_REASON },
    ]);
  });

  it("a single excluded asset trivially counts as 'all share the same reason' and is hoisted", () => {
    const asset = installedAsset({ assetId: "asset-a", assetVersionId: "av-a" });

    const result = groupExcludedKnowledgeByReason([{ asset, reason: KNOWLEDGE_NOT_ACTIVATED_REASON }]);

    expect(result.sharedReason).toBe(KNOWLEDGE_NOT_ACTIVATED_REASON);
    expect(result.items).toEqual([{ asset, reason: null }]);
  });
});

describe("resolveExcludedRowText (활성화 재시도 결과와 저장된 사유의 중복 제거)", () => {
  it("shows only the stored reason when there is no retry feedback yet", () => {
    expect(resolveExcludedRowText("사유", null)).toEqual({ reasonText: "사유", feedbackText: null });
  });

  it("shows only the null reason (already hoisted to the panel) with no feedback", () => {
    expect(resolveExcludedRowText(null, null)).toEqual({ reasonText: null, feedbackText: null });
  });

  it("drops the reason and shows only the feedback when a failed retry repeats the identical stored reason text (the exact bug reported)", () => {
    const text = "search-runtime을 재시작한 뒤 다시 시도하세요 — Knowledge 활성화 API가 없습니다(HTTP 404).";

    const result = resolveExcludedRowText(text, { ok: false, message: text });

    expect(result).toEqual({ reasonText: null, feedbackText: text });
  });

  it("keeps both when a failed retry reports a genuinely different message than the stored reason", () => {
    const result = resolveExcludedRowText("이전 사유", { ok: false, message: "새로운 다른 실패 사유" });

    expect(result).toEqual({ reasonText: "이전 사유", feedbackText: "새로운 다른 실패 사유" });
  });

  it("always shows a successful retry's message even if it happens to match the (now stale) failure reason text", () => {
    // ok:true is never a duplicate of a FAILED reason in practice, but the
    // function must not accidentally suppress a success message.
    const result = resolveExcludedRowText("사유", { ok: true, message: "사유" });

    expect(result).toEqual({ reasonText: "사유", feedbackText: "사유" });
  });

  it("shows the feedback alone (reason already null/hoisted) without crashing when reason is null", () => {
    const result = resolveExcludedRowText(null, { ok: false, message: "재시도도 실패했습니다." });

    expect(result).toEqual({ reasonText: null, feedbackText: "재시도도 실패했습니다." });
  });
});

describe("resolveReconcileCaption (reconcile 안내와 위에서 이미 보여준 사유의 중복 제거)", () => {
  it("returns null when there is no reconcile notice", () => {
    expect(resolveReconcileCaption(null, ["사유"])).toBeNull();
  });

  it("shortens to the generic notice when the reconcile text matches an already-shown reason verbatim (the exact bug reported — same 404 hit twice)", () => {
    const text = "search-runtime을 재시작한 뒤 다시 시도하세요 — Knowledge 활성화 API가 없습니다(HTTP 404).";

    expect(resolveReconcileCaption(text, [text])).toBe(RECONCILE_SAME_CAUSE_NOTICE);
  });

  it("keeps the full text when the reconcile cause genuinely differs from what was already shown", () => {
    const shown = "search-runtime을 재시작한 뒤 다시 시도하세요.";
    const reconcile = "search-runtime에 이 Knowledge의 등록 정보가 없습니다.";

    expect(resolveReconcileCaption(reconcile, [shown])).toBe(reconcile);
  });

  it("matches against any of several already-shown reasons (mixed-reason panel), not just the first", () => {
    const text = "사유 B";

    expect(resolveReconcileCaption(text, ["사유 A", "사유 B", null])).toBe(RECONCILE_SAME_CAUSE_NOTICE);
  });

  it("ignores null entries in already-shown reasons and still returns the full text when nothing matches", () => {
    expect(resolveReconcileCaption("새 안내", [null, null])).toBe("새 안내");
  });
});

describe("groupKnowledgeRouteChoicesByReason (KNOWLEDGE_ROUTE 반복 설명 정리)", () => {
  it("returns an empty group for no choices", () => {
    expect(groupKnowledgeRouteChoicesByReason([], {})).toEqual({ sharedReason: null, items: [] });
  });

  it("hoists the shared reason once when every choice shares identical reason text (the skip/fallback case — _search_all always ties the same sentence to every id)", () => {
    const same = "후보 지식 자산 수가 적어 전체를 검색합니다.";
    const result = groupKnowledgeRouteChoicesByReason(
      [
        { knowledge_id: "kb-1", reason: same },
        { knowledge_id: "kb-2", reason: same },
      ],
      { "kb-1": "HR 정책", "kb-2": "IT 런북" },
    );
    expect(result.sharedReason).toBe(same);
    expect(result.items).toEqual([
      { knowledgeId: "kb-1", name: "HR 정책", reason: null },
      { knowledgeId: "kb-2", name: "IT 런북", reason: null },
    ]);
  });

  it("keeps each item's own reason when reasons genuinely differ (the real 'ran' case — the LLM reasons per candidate)", () => {
    const result = groupKnowledgeRouteChoicesByReason(
      [
        { knowledge_id: "kb-1", reason: "재택근무 정책 질문과 직접 관련됩니다." },
        { knowledge_id: "kb-2", reason: "IT 런북과는 무관합니다." },
      ],
      { "kb-1": "HR 정책", "kb-2": "IT 런북" },
    );
    expect(result.sharedReason).toBeNull();
    expect(result.items).toEqual([
      { knowledgeId: "kb-1", name: "HR 정책", reason: "재택근무 정책 질문과 직접 관련됩니다." },
      { knowledgeId: "kb-2", name: "IT 런북", reason: "IT 런북과는 무관합니다." },
    ]);
  });

  it("falls back to the raw id when nameById has no entry for it (defensive — should not normally happen)", () => {
    const result = groupKnowledgeRouteChoicesByReason([{ knowledge_id: "kb-unknown", reason: "사유" }], {});
    expect(result.items).toEqual([{ knowledgeId: "kb-unknown", name: "kb-unknown", reason: null }]);
  });
});

describe("describeKnowledgeRoute (KNOWLEDGE_ROUTE 세 상태 표시 — ran/skipped/fallback을 절대 섞어 말하지 않는다)", () => {
  const nameById = { "kb-1": "HR 정책 Knowledge", "kb-2": "IT 런북 Knowledge", "kb-3": "보안 정책 Knowledge" };

  it("status='ran' with a single selected id — trivially hoisted as its own shared reason (same convention as groupExcludedKnowledgeByReason)", () => {
    const result = describeKnowledgeRoute(
      {
        status: "ran",
        fallback_reason: null,
        selected: [{ knowledge_id: "kb-1", reason: "재택근무 정책 질문과 직접 관련됩니다." }],
        excluded: [
          { knowledge_id: "kb-2", reason: "질문과 관련이 없습니다." },
          { knowledge_id: "kb-3", reason: "질문과 관련이 없습니다." },
        ],
      },
      nameById,
    );
    expect(result.status).toBe("ran");
    expect(result.headline).toBe("관련 있는 지식 자산 1개를 자동으로 선택해 검색했습니다.");
    expect(result.sharedSelectedReason).toBe("재택근무 정책 질문과 직접 관련됩니다.");
    expect(result.selected).toEqual([{ knowledgeId: "kb-1", name: "HR 정책 Knowledge", reason: null }]);
    // 제외된 둘이 완전히 같은 사유를 공유하므로 한 번만 위로 뽑힌다.
    expect(result.sharedExcludedReason).toBe("질문과 관련이 없습니다.");
    expect(result.excluded).toEqual([
      { knowledgeId: "kb-2", name: "IT 런북 Knowledge", reason: null },
      { knowledgeId: "kb-3", name: "보안 정책 Knowledge", reason: null },
    ]);
  });

  it("status='ran' with two selected ids that genuinely differ — each keeps its own reason (the realistic multi-Knowledge case)", () => {
    const result = describeKnowledgeRoute(
      {
        status: "ran",
        fallback_reason: null,
        selected: [
          { knowledge_id: "kb-1", reason: "재택근무 정책 질문과 직접 관련됩니다." },
          { knowledge_id: "kb-3", reason: "보안 승인 절차도 함께 언급되어 관련 있습니다." },
        ],
        excluded: [{ knowledge_id: "kb-2", reason: "질문과 관련이 없습니다." }],
      },
      nameById,
    );
    expect(result.headline).toBe("관련 있는 지식 자산 2개를 자동으로 선택해 검색했습니다.");
    expect(result.sharedSelectedReason).toBeNull();
    expect(result.selected).toEqual([
      { knowledgeId: "kb-1", name: "HR 정책 Knowledge", reason: "재택근무 정책 질문과 직접 관련됩니다." },
      { knowledgeId: "kb-3", name: "보안 정책 Knowledge", reason: "보안 승인 절차도 함께 언급되어 관련 있습니다." },
    ]);
  });

  it("status='skipped' — headline explicitly denies that a selection happened, and there is nothing in excluded", () => {
    const result = describeKnowledgeRoute(
      {
        status: "skipped",
        fallback_reason: null,
        selected: [
          { knowledge_id: "kb-1", reason: "후보 지식 자산 수가 적어 전체를 검색합니다." },
          { knowledge_id: "kb-2", reason: "후보 지식 자산 수가 적어 전체를 검색합니다." },
        ],
        excluded: [],
      },
      nameById,
    );
    expect(result.status).toBe("skipped");
    expect(result.headline).toBe("설치된 Knowledge가 적어(2개) 자동 선택 없이 전체를 검색했습니다 — 선택이 이루어진 것은 아닙니다.");
    expect(result.sharedSelectedReason).toBe("후보 지식 자산 수가 적어 전체를 검색합니다.");
    expect(result.excluded).toEqual([]);
  });

  it("status='fallback' — headline says automatic selection failed (never looks like a successful choice), names the server's own cause", () => {
    const result = describeKnowledgeRoute(
      {
        status: "fallback",
        fallback_reason: "error_or_timeout",
        selected: [
          { knowledge_id: "kb-1", reason: "라우팅 호출에 실패하여 전체를 검색합니다." },
          { knowledge_id: "kb-2", reason: "라우팅 호출에 실패하여 전체를 검색합니다." },
          { knowledge_id: "kb-3", reason: "라우팅 호출에 실패하여 전체를 검색합니다." },
        ],
        excluded: [],
      },
      nameById,
    );
    expect(result.status).toBe("fallback");
    expect(result.headline).toBe("자동 선택에 실패해 전체 지식 자산 3개를 대신 검색했습니다.");
    expect(result.sharedSelectedReason).toBe("라우팅 호출에 실패하여 전체를 검색합니다.");
    expect(result.excluded).toEqual([]);
  });

  it("status='fallback' with an abstained (empty-selection) cause still fails open honestly, distinct from a real choice", () => {
    const result = describeKnowledgeRoute(
      {
        status: "fallback",
        fallback_reason: "abstained",
        selected: [{ knowledge_id: "kb-1", reason: "라우터가 아무 것도 선택하지 않아 전체를 검색합니다." }],
        excluded: [],
      },
      nameById,
    );
    expect(result.headline).toContain("자동 선택에 실패");
    expect(result.sharedSelectedReason).toBe("라우터가 아무 것도 선택하지 않아 전체를 검색합니다.");
  });
});

describe("describeToolRouteSelected (D-083 TOOL_ROUTE)", () => {
  it("status='ran' names the proposed tool and never claims it has already executed", () => {
    const result = describeToolRouteSelected({ status: "ran", reason: null, tool_name: "table_count.query" });
    expect(result.status).toBe("ran");
    expect(result.toolName).toBe("table_count.query");
    expect(result.headline).toContain("table_count.query");
    expect(result.headline).not.toContain("실행했습니다");
  });

  it("status='skipped' reads as 'nothing to choose from', not a failed choice", () => {
    const result = describeToolRouteSelected({
      status: "skipped",
      reason: "no_candidate_tools",
      tool_name: null,
    });
    expect(result.status).toBe("skipped");
    expect(result.toolName).toBeNull();
    expect(result.headline).toContain("후보");
  });

  it("status='no_tool' reads as the designed, normal outcome of a question needing no tool — not an error to retry", () => {
    const result = describeToolRouteSelected({
      status: "no_tool",
      reason: "declined_by_model",
      tool_name: null,
    });
    expect(result.status).toBe("no_tool");
    expect(result.toolName).toBeNull();
    expect(result.headline).not.toMatch(/오류|실패|다시 시도/);
  });

  it("never echoes the server's internal English reason code verbatim into the Korean headline", () => {
    const result = describeToolRouteSelected({
      status: "no_tool",
      reason: "unparseable",
      tool_name: null,
    });
    expect(result.headline).not.toContain("unparseable");
  });
});

describe("describeToolRouteRejected (D-083 TOOL_ROUTE preflight refusal)", () => {
  it("MCP_TOOL_NOT_FOUND gets its own explanatory message, not a generic one", () => {
    const result = describeToolRouteRejected({ tool_name: "table_count.query", code: "MCP_TOOL_NOT_FOUND" });
    expect(result.status).toBe("rejected");
    expect(result.toolName).toBe("table_count.query");
    expect(result.headline).toContain("찾을 수 없어");
  });

  it("MCP_INPUT_INVALID gets its own explanatory message, distinct from MCP_TOOL_NOT_FOUND's", () => {
    const result = describeToolRouteRejected({ tool_name: "table_count.query", code: "MCP_INPUT_INVALID" });
    expect(result.status).toBe("rejected");
    expect(result.headline).toContain("입력값");
    expect(result.headline).not.toBe(describeToolRouteRejected({ tool_name: "x", code: "MCP_TOOL_NOT_FOUND" }).headline);
  });

  it("an unknown code fails closed — shows the code rather than fabricating an explanation", () => {
    const result = describeToolRouteRejected({ tool_name: "x", code: "SOME_NEW_CODE" });
    expect(result.headline).toContain("SOME_NEW_CODE");
  });

  it("rejected reads distinctly from 'no_tool' — 'nothing happened' and 'something was proposed and blocked' must never look the same", () => {
    const noTool = describeToolRouteSelected({ status: "no_tool", reason: "declined_by_model", tool_name: null });
    const rejected = describeToolRouteRejected({ tool_name: "table_count.query", code: "MCP_INPUT_INVALID" });
    expect(rejected.status).not.toBe(noTool.status);
    expect(rejected.headline).not.toBe(noTool.headline);
  });
});

describe("summarizeMcpToolConnections / describeToolRouteMcpToolsHint (D-080/D-084 혼동 정정 — MCP Tool 쪽 절반)", () => {
  it("returns empty connected list and 0 not-connected count for no MCP Tool assets", () => {
    const summary = summarizeMcpToolConnections([]);
    expect(summary).toEqual({ connected: [], installedNotConnectedCount: 0 });
    expect(describeToolRouteMcpToolsHint(summary)).toBe("");
  });

  it("classifies ACTIVE and ALREADY_ACTIVE MCP Tools as connected, using the business name not tool_name", () => {
    const calculator = installedAsset({
      assetId: "asset-calc",
      assetType: "mcp_tool",
      name: "숫자 더하기",
      activation: ACTIVE,
    });
    const alreadyActive = installedAsset({
      assetId: "asset-already",
      assetType: "mcp_tool",
      name: "이미 연결된 Tool",
      activation: ALREADY_ACTIVE,
    });

    const summary = summarizeMcpToolConnections([calculator, alreadyActive]);

    expect(summary.connected).toEqual([calculator, alreadyActive]);
    expect(summary.installedNotConnectedCount).toBe(0);
    expect(describeToolRouteMcpToolsHint(summary)).toContain("숫자 더하기");
    expect(describeToolRouteMcpToolsHint(summary)).toContain("이미 연결된 Tool");
    expect(describeToolRouteMcpToolsHint(summary)).not.toContain("calculator.add");
  });

  it("counts an installed-but-not-connected MCP Tool separately from connected ones (installed !== usable)", () => {
    const connected = installedAsset({ assetId: "asset-connected", assetType: "mcp_tool", name: "연결됨", activation: ACTIVE });
    const notConnected = installedAsset({
      assetId: "asset-not-connected",
      assetType: "mcp_tool",
      name: "미연결",
      activation: FAILED("연결 실패"),
    });
    const neverConnected = installedAsset({ assetId: "asset-never", assetType: "mcp_tool", name: "미시도" });

    const summary = summarizeMcpToolConnections([connected, notConnected, neverConnected]);

    expect(summary.connected).toEqual([connected]);
    expect(summary.installedNotConnectedCount).toBe(2);
    const hint = describeToolRouteMcpToolsHint(summary);
    expect(hint).toContain("연결됨");
    expect(hint).toContain("2개");
    expect(hint).not.toContain("미연결");
    expect(hint).not.toContain("미시도");
  });

  it("reports only the not-connected count (no names) when nothing is connected yet", () => {
    const notConnected = installedAsset({ assetId: "asset-1", assetType: "mcp_tool", name: "설치만 됨", activation: null });

    const summary = summarizeMcpToolConnections([notConnected]);

    expect(summary.connected).toEqual([]);
    expect(summary.installedNotConnectedCount).toBe(1);
    expect(describeToolRouteMcpToolsHint(summary)).toContain("1개");
    expect(describeToolRouteMcpToolsHint(summary)).not.toContain("설치만 됨");
  });
});
