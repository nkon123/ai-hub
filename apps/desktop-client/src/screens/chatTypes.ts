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
}

// D-060: an installed Knowledge from a Bundle built before the fix has no
// AssetVersion id at all — asset_id (what those legacy Bundles carried) is
// the *parent Asset*'s id, and search-runtime/agent-runtime key Knowledge
// search strictly by AssetVersion id. Silently sending asset_id looks like a
// working chat that always returns zero results (INSUFFICIENT_EVIDENCE) —
// exactly the bug this reason string exists to prevent by refusing to guess.
export const LEGACY_BUNDLE_KNOWLEDGE_ID_REASON =
  "이 자산은 이전 형식의 Bundle로 설치되어 Knowledge 식별자가 없습니다 — 다시 반출·설치해야 대화할 수 있습니다.";

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
