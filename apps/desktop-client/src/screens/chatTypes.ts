// Shared types between D06(ChatScreen)와 D07(RunDetailPanel) — one in-memory
// conversation turn plus everything captured about its Run, so the detail
// panel can be derived purely from client state without a second round trip
// (it does make one: a `getRun` refresh right after the terminal SSE event,
// to record the server's authoritative `completed_at`).
import type { Citation, ConversationTurnInput, PendingConfirmation, RunEventLogItem, RunResponse } from "../agentRuntime";
import type { StageMap } from "../runStages";
import type { ConversationRecord, InstalledAsset } from "../../electron/types";

export type ChatMessageStatus =
  | "running"
  | "waiting_for_user"
  | "succeeded"
  | "insufficient_evidence"
  | "failed"
  | "cancelled";

export interface ChatMessage {
  id: string;
  question: string;
  /** Knowledge id (AssetVersion UUID expected by agent-runtime) used for
   * this specific turn — captured per-message rather than read live off
   * screen state, so switching the Knowledge selector mid-conversation never
   * mislabels an in-flight or historical turn. */
  knowledgeIdUsed: string;
  knowledgeLabelUsed: string;
  serviceId: string;
  /** D-058/D-052: "standard-agent" for every normal D06 turn; only the
   * "개발 확인용" MCP trigger sets "standard-db-agent". Captured per-message
   * (not read live off screen state) for the same reason knowledgeIdUsed is —
   * and so D07 can display what was *actually* used for this turn. */
  agentProfile: "standard-agent" | "standard-db-agent";
  /** true when this turn bypasses Knowledge search and talks directly to Ollama. */
  ollamaOnly?: boolean;
  /** Actual installed Ollama model selected for this turn. */
  ollamaModel?: string;
  status: ChatMessageStatus;
  answer: string;
  citations: Citation[];
  stages: StageMap;
  eventLog: RunEventLogItem[];
  /** Non-null only while status === "waiting_for_user" — drives the D06
   * confirmation Panel (tool name, safe summary, deadline). */
  pendingConfirmation: PendingConfirmation | null;
  runId: string | null;
  traceId: string | null;
  /** Client-observed wall-clock timestamps — see agentRuntime.ts's
   * `RunEventLogItem.receivedAt` docstring on why these are not claimed to
   * be server-authoritative until `serverRun` is populated. */
  startedAt: string;
  completedAt: string | null;
  errorMessage?: string;
  errorCode?: string;
  /** Authoritative snapshot fetched via `GET /local/v1/runs/{id}` right
   * after a terminal SSE event — D07 prefers these timestamps/status/output
   * over the client-observed ones above whenever present. */
  serverRun: RunResponse | null;
  /** True only for a turn rehydrated from a saved conversation
   * (`chatMessageFromStoredTurn`) — this Run's own eventLog/citations/stages
   * were never persisted (only question+answer text was, see
   * `conversation-store.ts`), so D06/D07 must not offer actions that assume
   * a live Run exists (재시도/취소/상세 실행 보기's event timeline). */
  restored?: boolean;
  /** Only set on a restored turn — the number of citations the original
   * (unpersisted) Run had, shown as a plain count since the citations
   * themselves were not saved. */
  restoredCitationCount?: number;
  /** Every `"hub.query_sent"` SSE event this turn's Run has emitted so far —
   * the after-the-fact visibility guarantee for Stage 2 hub lookup consent,
   * complementing the before-the-fact preview `buildHubQueryPreview` powers
   * while the user is still typing. `query` is guaranteed by agent-runtime's
   * own enforced chokepoint to be built only from text the user typed —
   * never local document content — so it is safe to render verbatim. Always
   * `[]` for a restored turn (not persisted, same as `citations`/`eventLog`). */
  hubQueriesSent: Array<{ query: string; knowledgeIdsSearched: string[] }>;
}

// D-060: an installed Knowledge from a Bundle built before the fix has no
// AssetVersion id at all — asset_id (what those legacy Bundles carried) is
// the *parent Asset*'s id, and search-runtime/agent-runtime key Knowledge
// search strictly by AssetVersion id. Silently sending asset_id looks like a
// working chat that always returns zero results (INSUFFICIENT_EVIDENCE) —
// exactly the bug this reason string exists to prevent by refusing to guess.
export const LEGACY_BUNDLE_KNOWLEDGE_ID_REASON =
  "이 자산은 이전 형식의 Bundle이며 검증 가능한 Knowledge 식별자가 없습니다 — 최신 ZIP으로 다시 설치해야 대화할 수 있습니다.";

export interface KnowledgeSelection {
  /** Empty string when nothing usable is selected — same "falsy means no
   * selection" convention ChatScreen already used before this field existed. */
  knowledgeId: string;
  /** Non-null only when an asset IS selected but cannot be used as-is (D-060
   * legacy Bundle) — distinct from "nothing selected", which has no reason. */
  disabledReason: string | null;
}

/** Pure decision of what to actually send as `knowledge_id` for a selected
 * installed Knowledge asset — never falls back to `assetId` (see
 * LEGACY_BUNDLE_KNOWLEDGE_ID_REASON). Kept outside ChatScreen so it is
 * unit-testable without rendering React. */
export function resolveKnowledgeSelection(asset: InstalledAsset | null): KnowledgeSelection {
  if (!asset) return { knowledgeId: "", disabledReason: null };
  if (!asset.assetVersionId) {
    return { knowledgeId: "", disabledReason: LEGACY_BUNDLE_KNOWLEDGE_ID_REASON };
  }
  return { knowledgeId: asset.assetVersionId, disabledReason: null };
}

// D-079 이어 붙이기(activation-chat-wiring): "설치됨"과 "활성화됨"은 서로 다른
// 사실이다(electron/types.ts의 `InstalledAsset.activation` 문서 참고). 이전에는
// `resolveInstalledKnowledgeIds`가 assetVersionId만 확인하고 활성화 여부는
// 전혀 보지 않아, 활성화되지 않은(또는 활성화 실패한) Knowledge까지 그대로
// agent-runtime에 `knowledge_id`로 보내 조용히 Citation 0건을 만들었다 —
// D-079가 없애려던 바로 그 실패가 한 단계 위(Desktop 채팅)에서 재발한 것.
// 이 함수는 그 자리를 대신한다: 검색 가능한 것과 제외된 것을 사유와 함께
// 나눈다. 옛 함수는 제거했다 — "활성화 여부와 무관하게 id만" 필요한
// 정당한 호출자가 이제 없다(대화가 실제로 도달 가능한 id만 보내야 한다는
// 게 이 작업의 핵심 요구사항이므로, 남겨 두면 그 자체가 함정이 된다).

/** 채팅에서 실제로 검색 대상이 될 수 있는 Knowledge 하나. `T`를
 * `InstalledAsset`로 고정하지 않고 제네릭으로 둔 이유: 호출자가
 * `InstalledAssetWithStatus`(D08 `status` 필드가 추가된 형태)를 넘기면 그
 * 타입 그대로 돌려받아야, 화면이 다시 캐스팅 없이 `status`를 읽을 수 있다. */
export interface UsableKnowledge<T extends InstalledAsset = InstalledAsset> {
  knowledgeId: string;
  asset: T;
}

/** 채팅 검색 대상에서 제외된 Knowledge 하나와 그 사유(항상 한국어, 화면에
 * 그대로 표시 가능). */
export interface ExcludedKnowledge<T extends InstalledAsset = InstalledAsset> {
  asset: T;
  reason: string;
}

export interface KnowledgeActivationPartition<T extends InstalledAsset = InstalledAsset> {
  usable: UsableKnowledge<T>[];
  excluded: ExcludedKnowledge<T>[];
}

/** `activation` 필드가 없거나(미시도) 명시적으로 `null`(비활성화됨)인 경우
 * 공통으로 쓰는 사유 — `installed-assets-store.ts`의 `updateActivation` 문서가
 * 이미 밝힌 결정을 그대로 따른다: 두 경우 모두 화면에는 "활성화 안 됨"으로
 * 동일하게 보인다(그것이 정확한 사실이며, 굳이 구분해 봐야 사용자가 할 일은
 * 똑같이 "활성화"뿐이다). */
export const KNOWLEDGE_NOT_ACTIVATED_REASON =
  "이 Knowledge는 아직 검색에 활성화되지 않았습니다(활성화를 시도한 적이 없거나 비활성화된 상태입니다). 설치된 자산 화면에서 활성화할 수 있습니다.";

/** 지식 검색 자동화 + D-079 활성화 인지 — 설치된 모든 Knowledge를 실제로
 * 검색 가능한 것(usable)과 그럴 수 없는 것(excluded, 사유 포함)으로 나눈다.
 * `resolveKnowledgeSelection`의 D-060 판단(legacy Bundle)을 먼저 적용하고,
 * 그 다음에만 `activation.state`를 본다 — assetVersionId가 아예 없는
 * 자산은 활성화를 시도할 수조차 없었으므로 활성화 사유보다 D-060 사유가
 * 우선한다(실제로 `activateInstalledKnowledge`도 같은 순서로 거부한다). */
export function partitionInstalledKnowledgeByActivation<T extends InstalledAsset>(
  assets: T[],
): KnowledgeActivationPartition<T> {
  const usable: UsableKnowledge<T>[] = [];
  const excluded: ExcludedKnowledge<T>[] = [];
  for (const asset of assets) {
    if (asset.assetType !== "knowledge") continue;
    const selection = resolveKnowledgeSelection(asset);
    if (!selection.knowledgeId) {
      excluded.push({ asset, reason: selection.disabledReason ?? LEGACY_BUNDLE_KNOWLEDGE_ID_REASON });
      continue;
    }
    if (asset.activation?.state === "ACTIVE") {
      usable.push({ knowledgeId: selection.knowledgeId, asset });
      continue;
    }
    if (asset.activation?.state === "FAILED") {
      excluded.push({ asset, reason: asset.activation.message ?? "활성화에 실패했습니다." });
      continue;
    }
    excluded.push({ asset, reason: KNOWLEDGE_NOT_ACTIVATED_REASON });
  }
  return { usable, excluded };
}

/** `partitionInstalledKnowledgeByActivation`의 usable 목록에서 id만 뽑는다 —
 * agent-runtime `startRun`의 `knowledgeIds` 입력이 필요로 하는 형태. */
export function resolveActivatedKnowledgeIds(assets: InstalledAsset[]): string[] {
  return partitionInstalledKnowledgeByActivation(assets).usable.map((u) => u.knowledgeId);
}

// D-079 이어 붙이기 — `reconcileKnowledgeActivations()`는 목록을 보여주기
// 전에 로컬 ACTIVE 상태가 search-runtime과 여전히 일치하는지 재확인하는
// "있으면 좋은" 부가 기능이다: 이 호출이 없거나 실패해도 설치된 Knowledge
// 목록 자체는 항상 떠야 한다(CLAUDE.md: Desktop은 Runtime 장애 시 종료되지
// 않고 복구 안내를 제공한다). 실제로 2026-08-13 런타임 버그가 이 규칙을
// 어겼다: `bridge.reconcileKnowledgeActivations()`를 가드 없이 호출해
// `TypeError: bridge.reconcileKnowledgeActivations is not a function`가
// 채팅 화면 전체를 무너뜨렸다 — Main process가 빌드한 `dist/electron/preload.js`가
// 이 메서드가 추가되기 전 버전으로 stale했기 때문이다. `window.desktop`은
// `global.d.ts`에서 무조건 완전한 `DesktopBridge`로 타입 선언되어 있어
// TypeScript가 이 어긋남을 컴파일 타임에 잡을 수 없다(preload.js는 별도
// 빌드 산출물이라 타입 검사 대상이 아니다). 이 함수는 "메서드가 아예 없음"과
// "호출은 됐지만 실패함"을 모두 같은 방식으로 다룬다: 조용히 성공한 것처럼
// 넘어가지 않고, search-runtime에 실제로 도달할 수 없을 때와 동일한
// "확인 불가" 안내로 degrade한다 — 절대로 throw하지 않는다.
export const RECONCILE_UNAVAILABLE_NOTICE =
  "search-runtime에 연결할 수 없어 활성화 상태를 확인하지 못했습니다.";

export interface ReconcileCapableBridge {
  reconcileKnowledgeActivations?: () => Promise<{ checked: boolean; error: string | null }>;
}

/** `bridge`가 `reconcileKnowledgeActivations`를 갖고 있지 않거나(오래된
 * preload.js) 호출이 예외를 던져도 이 함수는 절대 throw하지 않는다 — 항상
 * "표시할 안내 문구(또는 안내 없음)"만 돌려준다. 호출자는 이 결과와 무관하게
 * 설치된 Knowledge 목록을 계속 불러와야 한다. */
export async function resolveReconcileNotice(bridge: ReconcileCapableBridge | null): Promise<string | null> {
  if (!bridge || typeof bridge.reconcileKnowledgeActivations !== "function") {
    return RECONCILE_UNAVAILABLE_NOTICE;
  }
  try {
    const result = await bridge.reconcileKnowledgeActivations();
    return result.checked ? null : (result.error ?? RECONCILE_UNAVAILABLE_NOTICE);
  } catch (err) {
    return err instanceof Error ? err.message : RECONCILE_UNAVAILABLE_NOTICE;
  }
}

// --- D06 대화 보존 (Desktop 대화 고도화/멀티턴) ------------------------------

/** Builds the `history` sent to agent-runtime (`input.history`, additive/
 * optional — 04-knowledge-platform.md §3.4) from this screen's in-memory
 * turns. Only turns with status "succeeded" AND non-empty answer text count
 * as usable conversational context — a failed/cancelled/insufficient-
 * evidence turn has no real answer a follow-up could sensibly build on, and
 * including it would only add noise (or, worse, an explicit "근거를 찾지
 * 못했습니다" line) to what the model sees as prior context. Growth is
 * bounded server-side regardless of how many turns are sent (agent-runtime's
 * `AgentRuntimeSettings.max_history_turns`/`max_history_chars`) — this
 * function deliberately does not also cap it client-side, to keep the
 * bounding policy in exactly one place.
 */
export function buildHistoryFromMessages(messages: ChatMessage[]): ConversationTurnInput[] {
  return messages
    .filter((m) => m.status === "succeeded" && m.answer.trim().length > 0)
    .map((m) => ({ question: m.question, answer: m.answer }));
}

/** Pure TS mirror of agent-runtime's `build_hub_query`
 * (services/agent-runtime/src/agent_runtime/hub_query.py) — powers the
 * consent-preview UI (허브로 전송될 질의 미리보기) so the user can see exactly
 * what would be sent to the hub BEFORE it goes, matching the after-the-fact
 * `"hub.query_sent"` SSE event's guarantee byte-for-byte.
 *
 * SECURITY (product requirement — "로컬에서 조회하는 데이터를 허브에 넘기면
 * 안 돼"): reads only every prior turn's `.question` text, NEVER `.answer` —
 * an answer may echo back local document content Stage 1 search retrieved,
 * which must never reach the hub. This is the same exclusion
 * `build_hub_query` enforces server-side; both sides must never drift. */
export function buildHubQueryPreview(question: string, messages: ChatMessage[]): string {
  const priorQuestions = messages.map((m) => m.question.trim()).filter((q) => q.length > 0);
  const draft = question.trim();
  const parts = draft.length > 0 ? [...priorQuestions, draft] : priorQuestions;
  return parts.join("\n");
}

/** Reconstructs a read-only, terminal `ChatMessage` from a persisted
 * conversation turn (`ConversationStore`'s on-disk shape) — used to restore
 * a saved conversation into this screen's `messages` state on selection.
 * Deliberately minimal: citations/eventLog/stages are NOT persisted (see
 * `conversation-store.ts`'s module docstring for why — only question+answer
 * text is kept), so a restored turn shows its answer text but not its
 * original citation list or step timeline; `citationCount` is shown as a
 * plain count instead. `knowledgeIdUsed`/`agentProfile` are filled from the
 * conversation's own record, since a restored turn is never re-sent as-is. */
const RESTORED_STAGES: StageMap = {
  ready: "done",
  analyze: "done",
  knowledge_search: "done",
  tool_call: "skipped",
  answer_generate: "done",
};

export function chatMessageFromStoredTurn(
  turn: ConversationRecord["turns"][number],
  conversation: Pick<ConversationRecord, "knowledgeId" | "knowledgeLabel">,
): ChatMessage {
  return {
    id: turn.id,
    question: turn.question,
    knowledgeIdUsed: conversation.knowledgeId,
    knowledgeLabelUsed: conversation.knowledgeLabel,
    serviceId: "",
    agentProfile: "standard-agent",
    status: turn.status,
    answer: turn.answer,
    citations: [],
    stages: RESTORED_STAGES,
    eventLog: [],
    pendingConfirmation: null,
    runId: null,
    traceId: null,
    startedAt: turn.createdAt,
    completedAt: turn.createdAt,
    serverRun: null,
    restored: true,
    restoredCitationCount: turn.citationCount,
    hubQueriesSent: [],
  };
}

export function mergeCitations(existing: Citation[], incoming: Citation[]): Citation[] {
  const seen = new Set(existing.map((c) => c.chunk_id));
  const extra = incoming.filter((c) => !seen.has(c.chunk_id));
  return [...existing, ...extra];
}

/** D06 "경고" — a citation whose vector similarity (D-046) is present but
 * below the mid-confidence line, or absent entirely (a BM25-only match with
 * relevance filtering off). Derived only from data the search already
 * returned — not a fabricated confidence score. */
export function hasLowConfidenceCitation(citations: Citation[]): boolean {
  return citations.some((c) => c.similarity !== null && c.similarity < 0.5);
}

export function buildMarkdown(message: ChatMessage): string {
  const lines: string[] = [];
  lines.push(`# 질문`, "", message.question, "");
  lines.push(`# 답변`, "", message.answer || "_(답변 없음)_", "");
  if (message.citations.length > 0) {
    lines.push(`# 출처`, "");
    message.citations.forEach((c, idx) => {
      const title = c.document_title || c.document_path || "제목 없음";
      const section = c.section ? ` · ${c.section}` : "";
      lines.push(`${idx + 1}. ${title}${section}`);
      if (c.excerpt) lines.push(`   > ${c.excerpt.replace(/\n/g, " ")}`);
    });
    lines.push("");
  }
  lines.push(`---`, `Run ID: ${message.runId ?? "미기재"}`, `Trace ID: ${message.traceId ?? "미기재"}`);
  return lines.join("\n");
}

export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
