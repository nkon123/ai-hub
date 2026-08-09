// D06 대화/실행.
//
// agent-runtime(services/agent-runtime, M05)은 별도 loopback HTTP 서비스라
// (electron/connections.ts가 이미 독립적으로 Health-check한다) 이 화면은
// `window.desktop` IPC 브릿지를 거치지 않고 `../agentRuntime`으로 agent-
// runtime을 직접 호출한다 — Import는 여전히 module 경계를 지킨다(다른
// 모듈의 내부 폴더를 직접 import하지 않음, CLAUDE.md 구현 원칙 2):
// agent-runtime의 Python 패키지가 아니라 그 공개 HTTP Wire Contract만
// 소비한다.
//
// 하나의 의도적 생략과 그 이유(open-decisions.md D-058에 기록):
// - 파일 첨부 UI: "Service가 파일을 허용할 때만 표시"해야 하는데, Desktop에는
//   아직 Service Definition을 조회할 방법이 전혀 없다(Registry 부재,
//   D-034). 근거 없이 항상 노출되는 가짜 파일 첨부 UI를 만들지 않는다.
//
// Tool 호출 확인 Panel(WAITING_FOR_USER, D-052 후속): 이 화면은 정식 MCP
// Tool 선택 UI를 만들지 않는다 — 위와 같은 이유(Service Registry 부재)로
// "이 Service가 어떤 Tool을 허용하는지" 자체를 조회할 방법이 없다. 대신
// devKnowledgeId와 동일한 성격의 "개발 확인용" 입력으로
// agent_profile=standard-db-agent + Tool 요청을 보낼 수 있게 해 확인 Panel
// 자체(승인/거부, 만료 시간)를 실제로 검증할 수 있게 한다 — 정식 제품
// UI가 아님을 라벨과 경고문으로 항상 명시한다.
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, Download, FileSearch, ListChecks, RefreshCw, Send, Square } from "lucide-react";
import type { ConnectionStatus, InstalledAssetWithStatus } from "../../electron/types";
import { checkAllConnections } from "../../electron/connections";
import { getDesktopBridge } from "../bridge";
import { Button, Card, EmptyState, ErrorBanner, LoadingState, PageHeader } from "../ui";
import {
  type Citation,
  type RunEventLogItem,
  cancelRun,
  confirmRun,
  getRun,
  openRunEventStream,
  startRun,
} from "../agentRuntime";
import { applyRuntimeEvent, initialStages } from "../runStages";
import {
  type ChatMessage,
  LEGACY_BUNDLE_KNOWLEDGE_ID_REASON,
  buildMarkdown,
  downloadMarkdown,
  hasLowConfidenceCitation,
  mergeCitations,
  resolveKnowledgeSelection,
} from "./chatTypes";
import { RunDetailPanel } from "./RunDetailPanel";
import { ConfirmationPanel } from "./ConfirmationPanel";

// D-034(Registry 생략)과 동일한 이유로 실제 Service Registry가 없다 — 선택된
// Knowledge별로 안정적인 문자열을 만들어 agent-runtime의
// `_derive_service_uuid`가 같은 Knowledge에 대해 항상 같은 UUID를 파생하게
// 한다(감사 로그에서 동일 논리 서비스로 상관관계를 가질 수 있도록, D-052와
// 동일한 절충).
const SERVICE_ID_PREFIX = "desktop-knowledge-chat";

// Local input styling — not promoted to ui.tsx (no shared text input/select
// primitive exists there yet, and this task's scope is D06/D07 screens, not
// growing the shared design-system surface). Mirrors
// apps/portal-web/app/_components/ui.tsx's `inputClass` value so both apps
// still read as one product.
const fieldClass =
  "w-full rounded-lg border border-border bg-white px-3 py-2.5 text-body text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50 disabled:text-text-muted";

function keyForInstalled(asset: InstalledAssetWithStatus): string {
  return `${asset.assetId}::${asset.version}`;
}

export function ChatScreen() {
  const bridge = getDesktopBridge();

  // --- Knowledge 선택 ---
  const [installedKnowledge, setInstalledKnowledge] = useState<InstalledAssetWithStatus[] | null>(null);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [selectedInstalledKey, setSelectedInstalledKey] = useState<string>("");
  const [devKnowledgeId, setDevKnowledgeId] = useState("");

  const loadInstalledKnowledge = useCallback(async () => {
    if (!bridge) return;
    setInstalledError(null);
    try {
      const all = await bridge.listInstalledAssets();
      // D12/D-068: only offer the Active Version of each installed
      // Knowledge — an INACTIVE version (superseded via D12's "Active
      // Pointer 전환") must not be selectable here, or a conversation could
      // silently search against a version the operator has already moved
      // away from. REVOKED/INVALID are left visible (out of this change's
      // scope — D08 is the screen that surfaces those).
      setInstalledKnowledge(all.filter((a) => a.assetType === "knowledge" && a.status !== "INACTIVE"));
    } catch (err) {
      setInstalledError(err instanceof Error ? err.message : "설치된 Knowledge 목록을 불러오지 못했습니다.");
      setInstalledKnowledge([]);
    }
  }, [bridge]);

  useEffect(() => {
    void loadInstalledKnowledge();
  }, [loadInstalledKnowledge]);

  const selectedInstalled = (installedKnowledge ?? []).find((a) => keyForInstalled(a) === selectedInstalledKey) ?? null;
  // D-060: never send selectedInstalled.assetId as knowledge_id — the search
  // index keys Knowledge by AssetVersion id, not Asset id. resolveKnowledgeSelection
  // is the single place that decides this (and refuses to guess when a legacy
  // Bundle installed the asset without an AssetVersion id at all).
  const knowledgeSelection = resolveKnowledgeSelection(bridge ? selectedInstalled : null);
  const knowledgeId = bridge ? knowledgeSelection.knowledgeId : devKnowledgeId.trim();
  const knowledgeLabel = bridge
    ? selectedInstalled
      ? `${selectedInstalled.name} v${selectedInstalled.version}`
      : ""
    : devKnowledgeId.trim()
      ? `Knowledge ID ${devKnowledgeId.trim()}`
      : "";

  // --- MCP Tool 호출(개발 확인용) — Service Registry가 없어(D-034/D-058)
  // 정식 Tool 선택 UI를 만들 근거가 없다. 확인 Panel(WAITING_FOR_USER) 자체를
  // 검증하기 위한 개발용 트리거만 제공하며, Electron 브릿지가 있을 때(정식
  // 빌드로 보이는 상태)는 숨긴다 — devKnowledgeId와 동일한 노출 조건.
  const [mcpDevEnabled, setMcpDevEnabled] = useState(false);
  const [mcpDevTool, setMcpDevTool] = useState<"table_count.query" | "db_metadata.get_columns">(
    "table_count.query",
  );
  const [mcpDevSchema, setMcpDevSchema] = useState("APP");
  const [mcpDevTable, setMcpDevTable] = useState("INTERFACE_LOG");
  const mcpDevActive = !bridge && mcpDevEnabled;

  // --- 연결 상태 ---
  const [connections, setConnections] = useState<ConnectionStatus[] | null>(null);
  const [connectionsChecking, setConnectionsChecking] = useState(false);
  const refreshConnections = useCallback(async () => {
    setConnectionsChecking(true);
    try {
      setConnections(await checkAllConnections());
    } finally {
      setConnectionsChecking(false);
    }
  }, []);
  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  // --- 대화 ---
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [citationDetail, setCitationDetail] = useState<Citation | null>(null);
  const [detailMessageId, setDetailMessageId] = useState<string | null>(null);
  // Tool 확인 Panel 처리 중(승인/거부 요청 In-flight) 및 그 요청 자체의 오류
  // — 메시지별로 추적해 두 개 이상의 Run이 동시에 대기 중이어도 서로
  // 간섭하지 않는다.
  const [confirmingMessageId, setConfirmingMessageId] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<Record<string, string>>({});

  const closeStreamRef = useRef<(() => void) | null>(null);
  const runIdRef = useRef<string | null>(null);

  // 화면을 벗어나거나 언마운트될 때 진행 중인 Run을 고아 상태로 남기지 않는다.
  useEffect(() => {
    return () => {
      closeStreamRef.current?.();
      closeStreamRef.current = null;
      if (runIdRef.current) {
        void cancelRun(runIdRef.current);
        runIdRef.current = null;
      }
    };
  }, []);

  function patchMessage(id: string, patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m)),
    );
  }

  function finishRun(messageId: string) {
    closeStreamRef.current?.();
    closeStreamRef.current = null;
    const runId = runIdRef.current;
    runIdRef.current = null;
    setIsRunning(false);
    if (runId) {
      // 종료 직후 서버 권위 상태(정확한 completed_at 등)를 한 번 더 확인해
      // D07에서 사용한다 — 실패해도 조용히 무시(이미 SSE로 받은 값으로 충분).
      getRun(runId)
        .then((serverRun) => patchMessage(messageId, { serverRun }))
        .catch(() => {});
    }
  }

  function handleStreamEvent(messageId: string, item: RunEventLogItem) {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        let next: ChatMessage = {
          ...m,
          eventLog: [...m.eventLog, item],
          stages: applyRuntimeEvent(m.stages, item.event, item.data),
        };
        switch (item.event) {
          case "citation.added": {
            next = { ...next, citations: mergeCitations(next.citations, [item.data as Citation]) };
            break;
          }
          case "mcp.confirmation_required": {
            const data = item.data as { tool_name?: string; summary?: string; deadline?: string } | null;
            if (data?.tool_name && data.summary && data.deadline) {
              next = {
                ...next,
                status: "waiting_for_user",
                pendingConfirmation: { tool_name: data.tool_name, summary: data.summary, deadline: data.deadline },
              };
            }
            break;
          }
          case "mcp.confirmation_resolved": {
            // 승인/거부 모두 대기 상태를 벗어난다 — 다음 이벤트(mcp.call.*
            // 또는 곧바로 run.completed/failed)가 실제 진행 상태를 이어간다.
            next = { ...next, status: "running", pendingConfirmation: null };
            break;
          }
          case "mcp.confirmation_expired": {
            // run.failed가 곧바로 뒤따르며 errorMessage/errorCode를 채운다 —
            // 여기서는 대기 Panel만 먼저 걷어낸다.
            next = { ...next, pendingConfirmation: null };
            break;
          }
          case "answer.delta": {
            const data = item.data as { delta?: string } | null;
            next = { ...next, answer: next.answer + (data?.delta ?? "") };
            break;
          }
          case "run.completed": {
            const data = item.data as
              | { status?: string; output?: { answer?: string; citations?: Citation[] } }
              | null;
            const status = data?.status === "INSUFFICIENT_EVIDENCE" ? "insufficient_evidence" : "succeeded";
            const finalAnswer = next.answer || data?.output?.answer || "";
            const mergedCitations = data?.output?.citations?.length
              ? mergeCitations(next.citations, data.output.citations)
              : next.citations;
            next = {
              ...next,
              status,
              answer: finalAnswer,
              citations: mergedCitations,
              completedAt: item.receivedAt,
              pendingConfirmation: null,
            };
            break;
          }
          case "run.failed": {
            const data = item.data as { code?: string; message?: string; trace_id?: string } | null;
            next = {
              ...next,
              status: "failed",
              errorMessage: data?.message ?? "실행 중 오류가 발생했습니다.",
              errorCode: data?.code,
              traceId: data?.trace_id ?? next.traceId,
              completedAt: item.receivedAt,
              pendingConfirmation: null,
            };
            break;
          }
          case "run.cancelled": {
            const data = item.data as { trace_id?: string } | null;
            next = {
              ...next,
              status: "cancelled",
              traceId: data?.trace_id ?? next.traceId,
              completedAt: item.receivedAt,
              pendingConfirmation: null,
            };
            break;
          }
          default:
            break;
        }
        return next;
      }),
    );

    if (item.event === "run.completed" || item.event === "run.failed" || item.event === "run.cancelled") {
      finishRun(messageId);
    }
  }

  function handleConnectionDropped(messageId: string) {
    patchMessage(messageId, (m) =>
      m.status === "running" || m.status === "waiting_for_user"
        ? {
            status: "failed",
            errorMessage: "실시간 연결이 끊어졌습니다. 다시 시도해 주세요.",
            completedAt: new Date().toISOString(),
            pendingConfirmation: null,
          }
        : {},
    );
    finishRun(messageId);
  }

  async function handleSend(text?: string) {
    const q = (text ?? question).trim();
    // 개발 확인용 MCP 모드는 knowledge_required=false Agent를 쓰므로
    // Knowledge 선택 없이도 실행할 수 있다 — 그 외에는 기존과 동일하게
    // Knowledge 선택이 필수다.
    if (!q || isRunning || (!knowledgeId && !mcpDevActive)) return;

    setSendError(null);
    setQuestion("");
    const id = crypto.randomUUID();
    const serviceId = `${SERVICE_ID_PREFIX}:${knowledgeId || "mcp-dev-trigger"}`;
    const agentProfile: ChatMessage["agentProfile"] = mcpDevActive ? "standard-db-agent" : "standard-agent";
    const newMessage: ChatMessage = {
      id,
      question: q,
      knowledgeIdUsed: knowledgeId,
      knowledgeLabelUsed: knowledgeLabel,
      serviceId,
      agentProfile,
      status: "running",
      answer: "",
      citations: [],
      stages: initialStages(),
      eventLog: [],
      pendingConfirmation: null,
      runId: null,
      traceId: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      serverRun: null,
    };
    setMessages((prev) => [...prev, newMessage]);
    setIsRunning(true);

    try {
      const created = await startRun({
        serviceId,
        knowledgeId,
        question: q,
        ...(mcpDevActive
          ? {
              agentProfile: "standard-db-agent" as const,
              mcpTool: mcpDevTool,
              mcpToolInput: { schema: mcpDevSchema.trim(), table: mcpDevTable.trim() },
              mcpConfirmed: false,
            }
          : {}),
      });
      runIdRef.current = created.id;
      patchMessage(id, { runId: created.id, traceId: created.trace_id });
      closeStreamRef.current = openRunEventStream(
        created.id,
        (item) => handleStreamEvent(id, item),
        () => handleConnectionDropped(id),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patchMessage(id, {
        status: "failed",
        errorMessage: `실행 요청에 실패했습니다: ${msg}`,
        completedAt: new Date().toISOString(),
      });
      setIsRunning(false);
    }
  }

  async function handleConfirmDecision(message: ChatMessage, decision: "approve" | "deny") {
    if (!message.runId) return;
    setConfirmingMessageId(message.id);
    setConfirmError((prev) => ({ ...prev, [message.id]: "" }));
    try {
      await confirmRun(message.runId, decision);
      // 실제 상태 전이(RUNNING 복귀, mcp.confirmation_resolved 등)는 이미
      // 열려 있는 SSE 스트림으로 도착한다 — 여기서는 요청 자체의 성공/실패만
      // 다룬다.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setConfirmError((prev) => ({ ...prev, [message.id]: msg }));
    } finally {
      setConfirmingMessageId((cur) => (cur === message.id ? null : cur));
    }
  }

  async function handleCancel(message: ChatMessage) {
    if (!message.runId) return;
    // 취소는 답변 생성 중에도 항상 호출 가능해야 한다(D06 규칙) — 서버가
    // 토큰 스트리밍 루프 중에도 cancel_event를 확인하므로 별도 분기가
    // 필요 없다. UI는 run.cancelled 이벤트가 도착한 뒤 실제로 갱신된다.
    await cancelRun(message.runId);
  }

  function handleCopy(message: ChatMessage) {
    navigator.clipboard
      .writeText(message.answer)
      .then(() => {
        setCopiedId(message.id);
        setTimeout(() => setCopiedId((cur) => (cur === message.id ? null : cur)), 1500);
      })
      .catch(() => setSendError("클립보드에 복사하지 못했습니다."));
  }

  function handleDownload(message: ChatMessage) {
    downloadMarkdown(`knowledge-chat-${message.id.slice(0, 8)}.md`, buildMarkdown(message));
  }

  const canSend = Boolean(question.trim()) && (Boolean(knowledgeId) || mcpDevActive) && !isRunning;
  const sendDisabledReason = isRunning
    ? "이미 실행 중입니다. 완료되거나 취소한 뒤 다시 시도하세요."
    : bridge && knowledgeSelection.disabledReason
      ? knowledgeSelection.disabledReason
      : !knowledgeId && !mcpDevActive
        ? "대화할 Knowledge를 먼저 선택하세요."
        : !question.trim()
          ? "질문을 입력하세요."
          : null;

  const detailMessage = messages.find((m) => m.id === detailMessageId) ?? null;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Knowledge 대화"
        description="등록·설치된 Knowledge를 바탕으로 실시간 대화를 실행합니다."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void refreshConnections()} disabled={connectionsChecking}>
            <RefreshCw size={13} className={connectionsChecking ? "animate-spin" : ""} /> 연결 다시 확인
          </Button>
        }
      />

      {/* 상단: Service 이름·버전·현재 모델·연결 상태 (D06) */}
      <Card className="mb-4 shrink-0 p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-body">
          <div>
            <span className="text-caption text-text-muted">Service</span>
            <p className="font-medium text-text-primary">Knowledge 대화 (PoC)</p>
          </div>
          <div>
            <span className="text-caption text-text-muted">버전</span>
            <p className="font-medium text-text-primary">- (Service Registry 없음)</p>
          </div>
          <div>
            <span className="text-caption text-text-muted">현재 모델</span>
            <p className="font-medium text-text-primary">미기재</p>
          </div>
          <div className="ml-auto flex gap-2">
            {connections === null ? (
              <span className="text-caption text-text-muted">연결 상태 확인 중...</span>
            ) : (
              connections.map((c) => (
                <span
                  key={c.id}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    c.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"
                  }`}
                  title={c.detail}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${c.ok ? "bg-success" : "bg-danger"}`} />
                  {c.label}
                </span>
              ))
            )}
          </div>
        </div>
      </Card>

      {/* Knowledge 선택 */}
      <Card className="mb-4 shrink-0 p-4">
        {bridge ? (
          <div>
            <label className="mb-1.5 block text-caption font-medium text-text-secondary" htmlFor="knowledge-select">
              대화할 Knowledge
            </label>
            {installedKnowledge === null && !installedError && <LoadingState label="설치된 Knowledge를 불러오는 중..." />}
            {installedError && <ErrorBanner message={installedError} />}
            {installedKnowledge !== null && installedKnowledge.length === 0 && !installedError && (
              <EmptyState
                title="설치된 Knowledge가 없습니다"
                description="가져오기 화면에서 Knowledge가 포함된 Offline Bundle을 먼저 반입하세요."
              />
            )}
            {installedKnowledge !== null && installedKnowledge.length > 0 && (
              <>
                <select
                  id="knowledge-select"
                  value={selectedInstalledKey}
                  onChange={(e) => setSelectedInstalledKey(e.target.value)}
                  className={fieldClass}
                >
                  <option value="">선택하세요</option>
                  {installedKnowledge.map((a) => {
                    // D-060: a Bundle installed before the fix has no
                    // AssetVersion id — disable it in the picker itself
                    // (not just at send-time) so the reason is visible where
                    // the user is choosing, and it can never be silently
                    // sent as-is.
                    const disabled = !a.assetVersionId;
                    return (
                      <option key={keyForInstalled(a)} value={keyForInstalled(a)} disabled={disabled}>
                        {a.name} v{a.version}
                        {disabled ? " (다시 반출·설치 필요)" : ""}
                      </option>
                    );
                  })}
                </select>
                {installedKnowledge.some((a) => !a.assetVersionId) && (
                  <p className="mt-2 flex items-start gap-1.5 text-caption text-warning">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    {LEGACY_BUNDLE_KNOWLEDGE_ID_REASON} 대상:{" "}
                    {installedKnowledge
                      .filter((a) => !a.assetVersionId)
                      .map((a) => `${a.name} v${a.version}`)
                      .join(", ")}
                  </p>
                )}
                {knowledgeSelection.disabledReason && (
                  <p className="mt-2 flex items-start gap-1.5 text-caption text-danger">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    {knowledgeSelection.disabledReason}
                  </p>
                )}
              </>
            )}
          </div>
        ) : (
          <div>
            <label className="mb-1.5 block text-caption font-medium text-warning" htmlFor="dev-knowledge-id">
              개발 확인용 — Knowledge ID 직접 입력
            </label>
            <input
              id="dev-knowledge-id"
              value={devKnowledgeId}
              onChange={(e) => setDevKnowledgeId(e.target.value)}
              placeholder="AssetVersion UUID (예: d9e660b7-ca76-4f46-899e-2e1621bac139)"
              className={`${fieldClass} border-warning/40`}
            />
            <p className="mt-1.5 text-caption text-text-muted">
              Desktop(Electron) 런타임이 연결되어 있지 않을 때만 표시되는 개발용 입력입니다 — 실제 제품에는 노출되지
              않습니다.
            </p>
          </div>
        )}
      </Card>

      {/* Tool 호출 확인 Panel(WAITING_FOR_USER) 검증용 — 개발 확인용, Electron
          브릿지가 있으면(정식 빌드로 보이는 상태) 숨긴다. Service Registry가
          없어 정식 Tool 선택 UI를 만들 근거가 없다(open-decisions.md D-058). */}
      {!bridge && (
        <Card className="mb-4 shrink-0 p-4">
          <label className="flex items-center gap-2 text-caption font-medium text-warning">
            <input
              type="checkbox"
              checked={mcpDevEnabled}
              onChange={(e) => setMcpDevEnabled(e.target.checked)}
              disabled={isRunning}
            />
            개발 확인용 — MCP Tool 호출 포함(Tool 확인 Panel 검증)
          </label>
          {mcpDevEnabled && (
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-caption text-text-muted" htmlFor="mcp-dev-tool">
                  Tool
                </label>
                <select
                  id="mcp-dev-tool"
                  value={mcpDevTool}
                  onChange={(e) => setMcpDevTool(e.target.value as typeof mcpDevTool)}
                  className={fieldClass}
                  disabled={isRunning}
                >
                  <option value="table_count.query">table_count.query (확인 필요)</option>
                  <option value="db_metadata.get_columns">db_metadata.get_columns (자동 승인)</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-caption text-text-muted" htmlFor="mcp-dev-schema">
                  Schema
                </label>
                <input
                  id="mcp-dev-schema"
                  value={mcpDevSchema}
                  onChange={(e) => setMcpDevSchema(e.target.value)}
                  className={`${fieldClass} border-warning/40`}
                  disabled={isRunning}
                />
              </div>
              <div>
                <label className="mb-1 block text-caption text-text-muted" htmlFor="mcp-dev-table">
                  Table
                </label>
                <input
                  id="mcp-dev-table"
                  value={mcpDevTable}
                  onChange={(e) => setMcpDevTable(e.target.value)}
                  className={`${fieldClass} border-warning/40`}
                  disabled={isRunning}
                />
              </div>
            </div>
          )}
          <p className="mt-2 text-caption text-text-muted">
            {mcpDevTool === "table_count.query"
              ? "table_count.query는 §8.4 ON_PARAMETER 정책 — 실행 전 확인 Panel(승인/거부)이 표시됩니다."
              : "db_metadata.get_columns는 §8.4 NEVER 정책 — 확인 없이 바로 실행됩니다."}
            {" "}실제 제품에는 노출되지 않는 개발용 입력입니다.
          </p>
        </Card>
      )}

      {/* 대화 */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {sendError && (
          <div className="mb-3 shrink-0">
            <ErrorBanner message={sendError} />
          </div>
        )}

        <div className="flex-1 space-y-4 overflow-y-auto pr-1">
          {messages.length === 0 && (
            <EmptyState
              title="아직 대화가 없습니다"
              description={knowledgeId ? "질문을 입력해 대화를 시작하세요." : "먼저 대화할 Knowledge를 선택하세요."}
            />
          )}

          {messages.map((m) => (
            <ChatTurn
              key={m.id}
              message={m}
              onCancel={() => void handleCancel(m)}
              onRerun={() => void handleSend(m.question)}
              onCopy={() => handleCopy(m)}
              onDownload={() => handleDownload(m)}
              onApprove={() => void handleConfirmDecision(m, "approve")}
              onDeny={() => void handleConfirmDecision(m, "deny")}
              confirmBusy={confirmingMessageId === m.id}
              confirmError={confirmError[m.id] || null}
              copied={copiedId === m.id}
              rerunDisabled={isRunning}
              onCitationClick={setCitationDetail}
              onOpenDetail={() => setDetailMessageId(m.id)}
            />
          ))}
        </div>

        <div className="mt-4 shrink-0 border-t border-border pt-4">
          <div className="flex gap-2">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder="질문을 입력하세요..."
              rows={2}
              className={`${fieldClass} resize-none`}
              disabled={isRunning}
            />
            <Button onClick={() => void handleSend()} disabled={!canSend} title={sendDisabledReason ?? undefined}>
              <Send size={15} /> 실행
            </Button>
          </div>
          {sendDisabledReason && !isRunning && (
            <p className="mt-1.5 text-caption text-text-muted">{sendDisabledReason}</p>
          )}
        </div>
      </div>

      {citationDetail && <CitationDetailModal citation={citationDetail} onClose={() => setCitationDetail(null)} />}
      {detailMessage && <RunDetailPanel message={detailMessage} onClose={() => setDetailMessageId(null)} />}
    </div>
  );
}

function ChatTurn({
  message,
  onCancel,
  onRerun,
  onCopy,
  onDownload,
  onApprove,
  onDeny,
  confirmBusy,
  confirmError,
  copied,
  rerunDisabled,
  onCitationClick,
  onOpenDetail,
}: {
  message: ChatMessage;
  onCancel: () => void;
  onRerun: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onApprove: () => void;
  onDeny: () => void;
  confirmBusy: boolean;
  confirmError: string | null;
  copied: boolean;
  rerunDisabled: boolean;
  onCitationClick: (c: Citation) => void;
  onOpenDetail: () => void;
}) {
  const isInFlight = message.status === "running" || message.status === "waiting_for_user";
  const isTerminal = !isInFlight;
  const lowConfidence = message.status === "succeeded" && hasLowConfidenceCitation(message.citations);

  return (
    <div className="space-y-2">
      <div className="ml-auto max-w-[80%] rounded-xl bg-brand-600 px-4 py-2.5 text-sm text-white">{message.question}</div>

      <div className="max-w-[90%] space-y-2">
        <StageIndicator stages={message.stages} />

        {message.status === "running" && (
          <div className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-2.5">
            <span className="flex items-center gap-2 text-body text-text-muted">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand-400" />
              {message.answer ? message.answer : "처리하는 중..."}
            </span>
          </div>
        )}

        {message.status === "waiting_for_user" && message.pendingConfirmation && (
          <ConfirmationPanel
            pending={message.pendingConfirmation}
            busy={confirmBusy}
            error={confirmError}
            onApprove={onApprove}
            onDeny={onDeny}
          />
        )}

        {message.status === "succeeded" && (
          <div className="whitespace-pre-wrap rounded-xl border border-border bg-surface px-4 py-2.5 text-body text-text-primary">
            {message.answer || "답변이 없습니다."}
          </div>
        )}

        {message.status === "insufficient_evidence" && (
          <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-2.5 text-body text-warning">
            등록된 Knowledge에서 근거를 찾지 못했습니다.
          </div>
        )}

        {message.status === "cancelled" && (
          <div className="rounded-xl border border-border bg-slate-50 px-4 py-2.5 text-body text-text-secondary">
            취소됨{message.traceId ? ` (Trace ID: ${message.traceId})` : ""}
          </div>
        )}

        {message.status === "failed" && (
          <ErrorBanner
            message={`${message.errorMessage ?? "실행 중 오류가 발생했습니다."}${
              message.errorCode ? ` (코드: ${message.errorCode})` : ""
            }${message.traceId ? ` · Trace ID: ${message.traceId}` : ""}`}
          />
        )}

        {lowConfidence && (
          <p className="flex items-start gap-1.5 text-caption text-warning">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            관련성이 낮은 근거가 포함되어 있어 답변의 정확도가 낮을 수 있습니다.
          </p>
        )}

        {message.citations.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-caption font-medium text-text-muted">출처</p>
            {message.citations.map((c, idx) => (
              <button
                key={c.chunk_id || idx}
                type="button"
                onClick={() => onCitationClick(c)}
                className="block w-full rounded-lg border border-border bg-slate-50 px-3 py-2 text-left text-xs hover:bg-slate-100"
              >
                <div className="font-semibold text-text-secondary">
                  {c.document_title || c.document_path || "제목 없음"}
                  {c.section && <span className="font-normal"> · {c.section}</span>}
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {isInFlight && (
            // D06 규칙: 답변 생성 중은 물론, Tool 확인을 기다리는 동안에도
            // 취소는 항상 가능해야 한다.
            <Button variant="secondary" size="sm" onClick={onCancel}>
              <Square size={13} /> 취소
            </Button>
          )}
          {isTerminal && (
            <Button variant="secondary" size="sm" onClick={onRerun} disabled={rerunDisabled}>
              {message.status === "failed" ? "재시도" : "동일 입력으로 다시 실행"}
            </Button>
          )}
          {message.status === "succeeded" && (
            <>
              <Button variant="secondary" size="sm" onClick={onCopy}>
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "복사됨" : "결과 복사"}
              </Button>
              <Button variant="secondary" size="sm" onClick={onDownload}>
                <Download size={13} /> Markdown 저장
              </Button>
            </>
          )}
          {isTerminal && (
            <Button variant="secondary" size="sm" onClick={onOpenDetail}>
              <ListChecks size={13} /> 상세 실행 보기
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

const STAGE_ORDER_LOCAL = ["ready", "analyze", "knowledge_search", "tool_call", "answer_generate"] as const;
const STAGE_LABELS_LOCAL: Record<(typeof STAGE_ORDER_LOCAL)[number], string> = {
  ready: "준비",
  analyze: "분석",
  knowledge_search: "지식 검색",
  tool_call: "Tool 실행",
  answer_generate: "답변 생성",
};

function StageIndicator({ stages }: { stages: ChatMessage["stages"] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {STAGE_ORDER_LOCAL.map((stage) => {
        const state = stages[stage];
        const tone =
          state === "done"
            ? "bg-success/10 text-success"
            : state === "active"
              ? "bg-brand-50 text-brand-700"
              : state === "waiting"
                ? "bg-warning/10 text-warning"
                : state === "error"
                  ? "bg-danger/10 text-danger"
                  : state === "cancelled"
                    ? "bg-warning/10 text-warning"
                    : "bg-slate-100 text-text-muted";
        return (
          <span key={stage} className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${tone}`}>
            {STAGE_LABELS_LOCAL[stage]}
          </span>
        );
      })}
    </div>
  );
}

function CitationDetailModal({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  // D06 규칙: "원문 접근 권한이 없으면 발췌를 표시하지 않는다." Desktop
  // Client에는 아직 어떤 역할/권한 모델도 없어(D-035와 동일한 공백) 이 검사를
  // 수행할 방법이 없다 — 없는 권한 모델을 지어내는 대신 항상 표시하고 이
  // 공백을 open-decisions.md D-058에 기록한다.
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="w-full max-w-lg rounded-card bg-surface p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="flex items-center gap-2">
            <FileSearch size={18} className="text-brand-500" />
            <h3 className="text-card-title font-semibold text-text-primary">
              {citation.document_title || citation.document_path || "제목 없음"}
            </h3>
          </div>
        </div>
        {citation.section && <p className="mb-2 text-caption text-text-muted">섹션: {citation.section}</p>}
        <p className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-body text-text-secondary">
          {citation.excerpt || "발췌 내용이 없습니다."}
        </p>
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            닫기
          </Button>
        </div>
      </div>
    </div>
  );
}
