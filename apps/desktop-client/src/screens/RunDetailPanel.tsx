// D07 실행 상세 — 대화 화면(D06)의 한 턴(Run)에 대한 진단 상세 보기.
//
// 모든 값은 (1) 이 화면이 이미 받은 SSE 이벤트 로그, (2) run.started로
// 에코된 요청 값, (3) 종료 직후 `GET /local/v1/runs/{id}`로 재확인한
// 서버 권위 상태(`serverRun`)에서만 만든다 — Runtime이 실제로 주지 않는
// 값(Prompt 식별자, 실제 모델명, Query Rewrite, Retry/Fallback 이력 등)은
// "미기재"로 명시하고 추측하지 않는다.
//
// 스펙(02-desktop-and-agent-runtime.md §D07)은 "일반 사용자와 진단 권한
// 사용자가 보는 상세 수준을 분리한다"고 요구하지만, Desktop Client에는
// 아직 어떤 역할/권한 모델도 없다(D-035와 동일한 공백) — 두 번째 단계를
// 지어내는 대신 단일(진단) 수준만 구현하고 그 공백을 상단 배너와
// open-decisions.md D-058에 기록한다.
import { AlertTriangle, Ban, CheckCircle2, Circle, Clock3, Loader2, MinusCircle, X, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Card, ErrorBanner } from "../ui";
import { formatDateTime } from "../format";
import { describeStage, STAGE_ORDER, type StageId, type StageState } from "../runStages";
import type { RunEventLogItem } from "../agentRuntime";
import type { ChatMessage } from "./chatTypes";

const STAGE_STATE_LABEL: Record<StageState, string> = {
  pending: "대기",
  active: "진행 중",
  waiting: "사용자 확인 대기",
  done: "완료",
  skipped: "건너뜀",
  error: "오류",
  cancelled: "취소됨",
};

const STAGE_STATE_TONE: Record<StageState, string> = {
  pending: "bg-slate-100 text-text-muted",
  active: "bg-brand-50 text-brand-700",
  waiting: "bg-warning/10 text-warning",
  done: "bg-success/10 text-success",
  skipped: "bg-slate-100 text-text-muted",
  error: "bg-danger/10 text-danger",
  cancelled: "bg-warning/10 text-warning",
};

function StageStateIcon({ state }: { state: StageState }) {
  switch (state) {
    case "done":
      return <CheckCircle2 size={15} className="text-success" />;
    case "active":
      return <Loader2 size={15} className="animate-spin text-brand-500" />;
    case "waiting":
      return <Clock3 size={15} className="text-warning" />;
    case "error":
      return <XCircle size={15} className="text-danger" />;
    case "cancelled":
      return <Ban size={15} className="text-warning" />;
    case "skipped":
      return <MinusCircle size={15} className="text-text-muted" />;
    default:
      return <Circle size={15} className="text-text-muted" />;
  }
}

function firstEventTime(eventLog: RunEventLogItem[], eventName: string): string | null {
  return eventLog.find((e) => e.event === eventName)?.receivedAt ?? null;
}

function lastEventTime(eventLog: RunEventLogItem[], eventNames: string[]): string | null {
  for (let i = eventLog.length - 1; i >= 0; i -= 1) {
    if (eventNames.includes(eventLog[i].event)) return eventLog[i].receivedAt;
  }
  return null;
}

const TERMINAL_EVENT_NAMES = ["run.completed", "run.failed", "run.cancelled"];

function stageTiming(eventLog: RunEventLogItem[], stage: StageId): { start: string | null; end: string | null } {
  const terminal = lastEventTime(eventLog, TERMINAL_EVENT_NAMES);
  switch (stage) {
    case "ready":
      return { start: firstEventTime(eventLog, "run.started"), end: firstEventTime(eventLog, "preflight.completed") ?? terminal };
    case "analyze":
      return {
        start: firstEventTime(eventLog, "preflight.completed"),
        end:
          firstEventTime(eventLog, "knowledge.search.started") ??
          firstEventTime(eventLog, "mcp.confirmation_required") ??
          firstEventTime(eventLog, "mcp.call.started") ??
          firstEventTime(eventLog, "answer.delta") ??
          terminal,
      };
    case "routing":
      // No dedicated start event of its own — KNOWLEDGE_ROUTE runs
      // immediately after preflight, resolved entirely by
      // knowledge.route.selected (runStages.ts's module docstring).
      return { start: firstEventTime(eventLog, "preflight.completed"), end: firstEventTime(eventLog, "knowledge.route.selected") ?? terminal };
    case "knowledge_search":
      return { start: firstEventTime(eventLog, "knowledge.search.started"), end: firstEventTime(eventLog, "knowledge.search.completed") };
    case "tool_call":
      // §5.3 TOOL_CONFIRM actually starts at the confirmation pause (if any),
      // not at dispatch — `mcp.call.started` only fires after an approval
      // (or immediately, for a NEVER-policy/pre-confirmed Tool with no
      // pause at all).
      return {
        start: firstEventTime(eventLog, "mcp.confirmation_required") ?? firstEventTime(eventLog, "mcp.call.started"),
        end:
          firstEventTime(eventLog, "mcp.call.completed") ??
          firstEventTime(eventLog, "mcp.confirmation_resolved") ??
          terminal,
      };
    case "answer_generate":
      return { start: firstEventTime(eventLog, "answer.delta"), end: terminal };
    default:
      return { start: null, end: null };
  }
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}초`;
}

function durationLabel(start: string | null, end: string | null): string {
  if (!start || !end) return "-";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "-";
  return formatDurationMs(ms);
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="mt-0.5 break-all text-body text-text-primary">{value}</dd>
    </div>
  );
}

export function RunDetailPanel({ message, onClose }: { message: ChatMessage; onClose: () => void }) {
  const serverRun = message.serverRun;
  const startedAt = serverRun?.created_at ?? message.startedAt;
  const completedAt = serverRun?.completed_at ?? message.completedAt;
  const totalDuration = durationLabel(startedAt, completedAt);
  const finalStatus = serverRun?.status ?? message.status.toUpperCase();
  const errorCode = serverRun?.error?.code ?? message.errorCode ?? null;
  const errorMessage = serverRun?.error?.message ?? message.errorMessage ?? null;

  const mcpStarted = message.eventLog.filter((e) => e.event === "mcp.call.started");
  const mcpCompleted = message.eventLog.filter((e) => e.event === "mcp.call.completed");

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40">
      <div className="flex h-full w-full max-w-xl flex-col overflow-y-auto bg-background shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-border bg-surface px-6 py-4">
          <h2 className="text-card-title font-semibold text-text-primary">실행 상세</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-muted hover:bg-background hover:text-text-primary"
            aria-label="닫기"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-5 p-6">
          <div className="flex items-start gap-2 rounded-lg border border-border bg-slate-50 px-3 py-2.5 text-caption text-text-secondary">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-text-muted" />
            <span>
              Desktop Client에는 아직 사용자 역할/권한 모델이 없어 일반 사용자와 진단 권한 사용자의 상세 수준을
              분리하지 못합니다 — 이 화면은 항상 진단 상세 수준으로 표시됩니다(open-decisions.md D-058).
            </span>
          </div>

          <Card className="p-4">
            <h3 className="mb-3 text-body font-semibold text-text-primary">기본 정보</h3>
            <dl className="grid grid-cols-2 gap-3">
              <Field label="Run ID" value={message.runId ?? "미기재"} />
              <Field label="Trace ID" value={message.traceId ?? "미기재"} />
              <Field label="시작" value={startedAt ? formatDateTime(startedAt) : "미기재"} />
              <Field label="종료" value={completedAt ? formatDateTime(completedAt) : "실행 중"} />
              <Field label="총 소요시간" value={totalDuration} />
              <Field label="최종 상태" value={finalStatus} />
            </dl>
            {(errorCode || errorMessage) && (
              <div className="mt-3">
                <ErrorBanner message={`${errorMessage ?? "오류가 발생했습니다."}${errorCode ? ` (코드: ${errorCode})` : ""}`} />
              </div>
            )}
          </Card>

          <Card className="p-4">
            <h3 className="mb-3 text-body font-semibold text-text-primary">사용 구성</h3>
            <dl className="grid grid-cols-2 gap-3">
              <Field label="Service" value={message.serviceId} />
              <Field label="Agent Profile" value={message.agentProfile} />
              <Field label="Knowledge" value={`${message.knowledgeLabelUsed || "미기재"} (${message.knowledgeIdUsed})`} />
              <Field label="Prompt" value="미기재 (Run 응답/이벤트에 포함되지 않음)" />
              <Field label="모델 버전" value="미기재 (Run 응답/이벤트에 포함되지 않음)" />
            </dl>
          </Card>

          <Card className="p-4">
            <h3 className="mb-3 text-body font-semibold text-text-primary">Workflow 단계</h3>
            <div className="space-y-2">
              {STAGE_ORDER.filter((stage) => message.stages[stage] !== undefined).map((stage) => {
                // Guaranteed present by the filter above — "routing" is the
                // only stage that can be absent (this turn never sent
                // knowledge_candidates), and it was just filtered out.
                const entry = message.stages[stage] as (typeof message.stages)["ready"];
                const timing = stageTiming(message.eventLog, stage);
                return (
                  <div key={stage} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                    <div className="flex items-center gap-2">
                      <StageStateIcon state={entry.state} />
                      <span className="text-body text-text-primary">{describeStage(stage, entry)}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STAGE_STATE_TONE[entry.state]}`}>
                        {STAGE_STATE_LABEL[entry.state]}
                      </span>
                    </div>
                    <span className="text-caption text-text-muted">{durationLabel(timing.start, timing.end)}</span>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-caption text-text-muted">
              단계별 시각은 이 화면이 이벤트를 수신한 시각 기준입니다(서버가 개별 이벤트에 시각을 기록하지 않음).
            </p>
          </Card>

          <Card className="p-4">
            <h3 className="mb-1 text-body font-semibold text-text-primary">Query Rewrite / 민감정보 정책</h3>
            <p className="text-body text-text-secondary">미기재 (현재 Local Agent Runtime은 Query Rewrite를 수행하지 않습니다)</p>
          </Card>

          <Card className="p-4">
            <h3 className="mb-3 text-body font-semibold text-text-primary">
              Knowledge 검색 결과 ({message.citations.length}건)
            </h3>
            {message.citations.length === 0 ? (
              <p className="text-body text-text-muted">검색된 근거가 없습니다.</p>
            ) : (
              <ol className="space-y-2">
                {message.citations.map((c, idx) => (
                  <li key={c.chunk_id || idx} className="rounded-lg border border-border bg-slate-50 px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-text-secondary">
                        #{idx + 1} {c.document_title || c.document_path || "제목 없음"}
                        {c.section && <span className="font-normal"> · {c.section}</span>}
                      </span>
                      <span className="shrink-0 text-text-muted">
                        similarity {c.similarity !== null ? c.similarity.toFixed(4) : "미적용"} · score {c.score.toFixed(4)}
                      </span>
                    </div>
                    <p className="mt-1 text-text-secondary">{c.excerpt.length > 200 ? `${c.excerpt.slice(0, 200)}…` : c.excerpt}</p>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card className="p-4">
            <h3 className="mb-3 text-body font-semibold text-text-primary">MCP Tool 호출</h3>
            {mcpStarted.length === 0 ? (
              <p className="text-body text-text-muted">이 실행에서 호출된 MCP Tool이 없습니다.</p>
            ) : (
              <div className="space-y-2">
                {mcpStarted.map((startEvt, idx) => {
                  const data = startEvt.data as { tool_name?: string } | null;
                  const completedEvt = mcpCompleted[idx];
                  const completedData = completedEvt?.data as
                    | { success?: boolean; duration_ms?: number; row_count?: number; error_code?: string }
                    | null;
                  return (
                    <div key={startEvt.id} className="rounded-lg border border-border px-3 py-2 text-body">
                      <span className="font-medium text-text-primary">{data?.tool_name ?? "미기재"}</span>{" "}
                      <span className="text-text-secondary">
                        {completedData
                          ? `${completedData.success ? "성공" : `실패 (${completedData.error_code ?? "미기재"})`} · ${
                              completedData.duration_ms ?? "-"
                            }ms${completedData.row_count != null ? ` · ${completedData.row_count}행` : ""}`
                          : "진행 중"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <h3 className="mb-1 text-body font-semibold text-text-primary">Retry / Fallback 이력</h3>
            <p className="text-body text-text-secondary">미기재 (Runtime이 Retry/Fallback을 기록하지 않습니다)</p>
          </Card>

          <details className="rounded-card border border-border bg-surface p-4">
            <summary className="cursor-pointer text-body font-semibold text-text-primary">
              원본 이벤트 로그 ({message.eventLog.length}건)
            </summary>
            <div className="mt-3 space-y-1.5">
              {message.eventLog.map((e) => (
                <div key={e.id} className="rounded bg-slate-50 px-2 py-1 text-[11px] text-text-secondary">
                  <span className="font-mono text-text-muted">{formatDateTime(e.receivedAt)}</span>{" "}
                  <span className="font-semibold text-text-primary">{e.event}</span>
                </div>
              ))}
            </div>
          </details>

          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              닫기
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
