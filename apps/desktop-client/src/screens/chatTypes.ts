// Shared types between D06(ChatScreen)와 D07(RunDetailPanel) — one in-memory
// conversation turn plus everything captured about its Run, so the detail
// panel can be derived purely from client state without a second round trip
// (it does make one: a `getRun` refresh right after the terminal SSE event,
// to record the server's authoritative `completed_at`).
import type { Citation, PendingConfirmation, RunEventLogItem, RunResponse } from "../agentRuntime";
import type { StageMap } from "../runStages";
import type { InstalledAsset } from "../../electron/types";

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
