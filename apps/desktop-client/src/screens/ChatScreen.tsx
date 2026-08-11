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
import { AlertTriangle, Check, Copy, Download, FileSearch, Globe, ListChecks, MessageSquarePlus, RefreshCw, Send, Square, Trash2 } from "lucide-react";
import type { ConnectionStatus, ConversationSummary, ConversationTurnStatus, InstalledAssetWithStatus } from "../../electron/types";
import { checkAllConnections } from "../../electron/connections";
import { getDesktopBridge } from "../bridge";
import { formatDateTime } from "../format";
import { Button, EmptyState, ErrorBanner, LoadingState, ReasonConfirmDialog } from "../ui";
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
  buildHistoryFromMessages,
  buildHubQueryPreview,
  buildMarkdown,
  chatMessageFromStoredTurn,
  downloadMarkdown,
  hasLowConfidenceCitation,
  mergeCitations,
  resolveInstalledKnowledgeIds,
  resolveKnowledgeSelection,
} from "./chatTypes";
import { RunDetailPanel } from "./RunDetailPanel";
import { ConfirmationPanel } from "./ConfirmationPanel";

// D06 대화 보존 — 완료된 턴만 저장 대상이다(진행 중/대기 중 상태는 아직
// 결과가 확정되지 않았다). `agent_runtime.conversation`의 History 개념과
// 동일한 경계: 실패/취소된 턴은 후속 질문의 맥락(history)으로 보내지 않지만
// (chatTypes.ts의 `buildHistoryFromMessages` 참고), 사용자가 무엇을
// 시도했는지는 대화 기록에 남긴다.
const TERMINAL_CONVERSATION_STATUSES: ReadonlySet<ConversationTurnStatus> = new Set([
  "succeeded",
  "insufficient_evidence",
  "failed",
  "cancelled",
]);

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

export function ChatScreen() {
  const bridge = getDesktopBridge();

  // --- Knowledge 자동 검색 대상(지식 검색 자동화) ---
  const [installedKnowledge, setInstalledKnowledge] = useState<InstalledAssetWithStatus[] | null>(null);
  const [installedError, setInstalledError] = useState<string | null>(null);
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

  // 지식 검색 자동화 — 더 이상 수동으로 하나만 고르지 않는다: 설치된 모든
  // Knowledge(Active 버전, 이전 형식 Bundle 제외 — D-060)를 대상으로 Stage 1
  // 로컬 검색을 자동 실행한다. `resolveInstalledKnowledgeIds`가
  // `resolveKnowledgeSelection`의 D-060 판단을 자산별로 그대로 재사용한다.
  const knowledgeIds = bridge
    ? resolveInstalledKnowledgeIds(installedKnowledge ?? [])
    : devKnowledgeId.trim()
      ? [devKnowledgeId.trim()]
      : [];
  // 하위 호환용 단일 id(agent-runtime의 기존 입력 검증 Gate) — 목록의 첫
  // 항목, 없으면 빈 문자열. `knowledge_ids`가 채워진 뒤로는 그 자체로는
  // 더 이상 의미가 없다(agentRuntime.ts StartRunParams 참고).
  const knowledgeId = knowledgeIds[0] ?? "";
  const hasUsableKnowledge = knowledgeIds.length > 0;
  const knowledgeLabel = bridge
    ? knowledgeIds.length === 0
      ? ""
      : knowledgeIds.length === 1
        ? (() => {
            const asset = (installedKnowledge ?? []).find(
              (a) => resolveKnowledgeSelection(a).knowledgeId === knowledgeIds[0],
            );
            return asset ? `${asset.name} v${asset.version}` : "지식 자산";
          })()
        : `여러 지식 자산 (${knowledgeIds.length}개)`
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

  // --- 허브 조회 동의(Stage 2) — 세션마다 기본 꺼짐, 저장하지 않는다("로컬에서
  // 조회하는 데이터를 허브에 넘기면 안 돼"는 제품 요구사항: 이 동의는
  // 편의를 위한 묵시적 허용이 아니라 매번 다시 확인하는 명시적 선택이어야
  // 한다). 켜져 있을 때만 `buildHubQueryPreview`로 실제 전송될 질의를
  // 미리 보여준다(§ 대화 입력 영역).
  const [allowHubLookup, setAllowHubLookup] = useState(false);

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

  // --- D06 대화 보존(Desktop 대화 고도화/멀티턴) — Electron 브릿지가 있을
  // 때만 동작한다(Main Process 저장소, `conversation-store.ts`). 브릿지가
  // 없는 개발용 Browser 검증 경로(devKnowledgeId)는 이 세션 전체가
  // in-memory로만 존재한다 — 오늘 동작과 동일하며, 회귀가 아니다.
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [deletingConversation, setDeletingConversation] = useState<ConversationSummary | null>(null);
  const [deleteConversationBusy, setDeleteConversationBusy] = useState(false);
  const [deleteConversationError, setDeleteConversationError] = useState<string | null>(null);
  // 이미 저장소에 반영한 턴을 다시 반영하지 않기 위한 표시 — 화면이 다시
  // 렌더링될 때마다 같은 턴을 중복 저장하지 않는다.
  const persistedTurnIdsRef = useRef<Set<string>>(new Set());

  const loadConversations = useCallback(async () => {
    if (!bridge) return;
    setConversationsError(null);
    try {
      setConversations(await bridge.listConversations());
    } catch (err) {
      setConversationsError(err instanceof Error ? err.message : "대화 목록을 불러오지 못했습니다.");
      setConversations([]);
    }
  }, [bridge]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

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
          case "hub.query_sent": {
            // 사후 가시성(after-the-fact) 보장 — Stage 2가 허브로 실제 전송한
            // 질의를 대화창에 그대로 보여준다. agent-runtime의 강제 지점이
            // 이 값이 사용자가 입력한 텍스트로만 구성되도록 보장하므로
            // 그대로 표시해도 안전하다(chatTypes.ts buildHubQueryPreview 참고).
            const data = item.data as { query?: string; knowledge_ids_searched?: string[] } | null;
            if (data?.query) {
              next = {
                ...next,
                hubQueriesSent: [
                  ...next.hubQueriesSent,
                  { query: data.query, knowledgeIdsSearched: data.knowledge_ids_searched ?? [] },
                ],
              };
            }
            break;
          }
          // "hub.search.completed"({citation_count})는 knowledge.search.completed와
          // 동일하게 별도 UI 없이 stages(applyRuntimeEvent)로만 조용히
          // 흡수된다 — 새 UI Chrome을 억지로 만들지 않는다.
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

  // 완료된(터미널 상태) 턴을 Main Process 저장소에 반영한다 — SSE 이벤트
  // 처리(`handleStreamEvent`)와 분리된 별도 effect인 이유: 취소
  // (`handleCancel`)·연결 끊김(`handleConnectionDropped`) 등 터미널 상태로
  // 가는 경로가 여러 곳이라, "메시지가 실제로 터미널 상태가 되었는가"라는
  // 하나의 조건만 지켜보는 편이 각 경로마다 저장 호출을 중복해 넣는 것보다
  // 안전하다. 대화당 동시 Run은 최대 1개뿐이므로(D-074, `MAX_CONCURRENT_
  // RUNS_VALUE`) 같은 렌더링에서 두 턴이 동시에 터미널이 되어 `currentConversationId`
  // 생성 경쟁이 생길 걱정은 없다.
  useEffect(() => {
    if (!bridge) return;
    for (const m of messages) {
      if (m.restored) continue; // 이미 저장소에서 읽어온 턴 — 다시 쓸 필요 없음
      if (!TERMINAL_CONVERSATION_STATUSES.has(m.status as ConversationTurnStatus)) continue;
      if (persistedTurnIdsRef.current.has(m.id)) continue;
      persistedTurnIdsRef.current.add(m.id);
      void persistTurn(m);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, bridge]);

  async function persistTurn(m: ChatMessage): Promise<void> {
    if (!bridge) return;
    try {
      let conversationId = currentConversationId;
      if (!conversationId) {
        const created = await bridge.createConversation(m.knowledgeIdUsed, m.knowledgeLabelUsed);
        conversationId = created.id;
        setCurrentConversationId(created.id);
      }
      await bridge.appendConversationTurn(conversationId, {
        question: m.question,
        answer: m.answer,
        status: m.status as ConversationTurnStatus,
        citationCount: m.citations.length,
      });
      await loadConversations();
    } catch {
      // 저장 실패가 진행 중인 대화 자체를 막지 않는다(CLAUDE.md: Runtime/상태
      // 장애 시 종료되지 않고 복구 안내) — 이 세션 안에서는 메시지가 여전히
      // 화면에 남아 있으므로 사용자는 대화를 계속할 수 있다. 다음 저장
      // 성공 시(또는 다음 대화 목록 새로고침 시) 자연히 다시 시도된다.
      setConversationsError("최근 대화를 저장하지 못했습니다 — 이 세션 안에서는 계속 사용할 수 있습니다.");
    }
  }

  async function handleSelectConversation(id: string): Promise<void> {
    if (!bridge) return;
    setSendError(null);
    try {
      const record = await bridge.getConversation(id);
      if (!record) {
        // 다른 경로에서 이미 삭제된 대화 — 목록을 새로고침해 정리한다.
        await loadConversations();
        return;
      }
      persistedTurnIdsRef.current = new Set(record.turns.map((t) => t.id));
      setMessages(record.turns.map((t) => chatMessageFromStoredTurn(t, record)));
      setCurrentConversationId(record.id);
    } catch (err) {
      setConversationsError(err instanceof Error ? err.message : "대화를 불러오지 못했습니다.");
    }
  }

  function handleNewConversation(): void {
    setCurrentConversationId(null);
    setMessages([]);
    setSendError(null);
  }

  function requestDeleteConversation(c: ConversationSummary): void {
    setDeletingConversation(c);
    setDeleteConversationError(null);
  }

  async function handleConfirmDeleteConversation(reason: string): Promise<void> {
    if (!bridge || !deletingConversation) return;
    setDeleteConversationBusy(true);
    setDeleteConversationError(null);
    try {
      const result = await bridge.deleteConversation(deletingConversation.id, reason);
      if (!result.ok) {
        setDeleteConversationError(result.error ?? "대화를 삭제하지 못했습니다.");
        return;
      }
      if (currentConversationId === deletingConversation.id) {
        handleNewConversation();
      }
      setDeletingConversation(null);
      await loadConversations();
    } catch (err) {
      setDeleteConversationError(err instanceof Error ? err.message : "대화를 삭제하지 못했습니다.");
    } finally {
      setDeleteConversationBusy(false);
    }
  }

  async function handleSend(text?: string) {
    const q = (text ?? question).trim();
    // 개발 확인용 MCP 모드는 knowledge_required=false Agent를 쓰므로
    // 검색 가능한 Knowledge 없이도 실행할 수 있다 — 그 외에는 검색 가능한
    // Knowledge가 최소 1개 있어야 한다(지식 검색 자동화 — 더 이상 "선택"을
    // 요구하지 않지만, 검색 대상 자체가 없으면 여전히 실행할 수 없다).
    if (!q || isRunning || (!hasUsableKnowledge && !mcpDevActive)) return;

    setSendError(null);
    setQuestion("");
    const id = crypto.randomUUID();
    const serviceId = `${SERVICE_ID_PREFIX}:${knowledgeId || "mcp-dev-trigger"}`;
    const agentProfile: ChatMessage["agentProfile"] = mcpDevActive ? "standard-db-agent" : "standard-agent";
    // Desktop 대화 고도화(멀티턴) — 지금까지의 완료된 턴을 agent-runtime에
    // `input.history`로 함께 보낸다(additive/optional, local-runtime-api.yaml
    // ConversationTurnInput). Electron 브릿지 유무와 무관하게 항상 동작한다
    // — 대화 "보존"(재시작 후 복원)은 Electron 전용이지만, 멀티턴 자체는
    // agent-runtime의 기능이라 브릿지 없는 개발용 Browser 검증 경로에서도
    // 그대로 작동해야 한다.
    const history = buildHistoryFromMessages(messages);
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
      hubQueriesSent: [],
    };
    setMessages((prev) => [...prev, newMessage]);
    setIsRunning(true);

    try {
      const created = await startRun({
        serviceId,
        knowledgeId,
        knowledgeIds,
        question: q,
        allowHubLookup,
        ...(history.length > 0 ? { history } : {}),
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

  const canSend = Boolean(question.trim()) && (hasUsableKnowledge || mcpDevActive) && !isRunning;
  const sendDisabledReason = isRunning
    ? "이미 실행 중입니다. 완료되거나 취소한 뒤 다시 시도하세요."
    : !hasUsableKnowledge && !mcpDevActive
      ? bridge && installedKnowledge !== null && installedKnowledge.length > 0
        ? "설치된 Knowledge를 모두 사용할 수 없습니다 — 다시 반출·설치해야 대화할 수 있습니다."
        : "대화할 수 있는 Knowledge가 없습니다 — 자산 허브 > 가져오기에서 Knowledge를 먼저 설치하세요."
      : !question.trim()
        ? "질문을 입력하세요."
        : null;

  // 허브로 실제 전송될 질의 미리보기 — 매 입력마다(질문 초안/이전 턴이
  // 바뀔 때마다) 다시 계산되어 최신 상태를 반영한다(chatTypes.ts
  // buildHubQueryPreview). 토글이 꺼져 있으면 전송될 것이 없으므로 계산하지
  // 않는다.
  const hubQueryPreview = allowHubLookup ? buildHubQueryPreview(question, messages) : "";

  const detailMessage = messages.find((m) => m.id === detailMessageId) ?? null;

  // 연결이 끊겨 대화가 제한될 수 있을 때(CLAUDE.md: "Desktop은 Runtime 장애
  // 시 종료되지 않고 복구 안내를 제공한다") — 상세 화면(설정 > 연결 상태)으로
  // 밀어내지 않고, 대화가 실제로 일어나는 이 화면에서 바로 그 사실과 복구
  // 힌트를 보여준다.
  const failedConnections = connections?.filter((c) => !c.ok) ?? [];

  // 상단 슬림 헤더용 — Ollama Desktop 앱처럼 모델/지식 상태를 한 줄로 요약한다.
  const knowledgeSummaryText = bridge
    ? installedKnowledge === null
      ? "지식 확인 중..."
      : knowledgeIds.length > 0
        ? `지식 ${knowledgeIds.length}개 사용 중`
        : installedKnowledge.length === 0
          ? "설치된 지식 없음"
          : "검색 가능한 지식 없음"
    : devKnowledgeId.trim()
      ? "개발용 Knowledge ID 사용 중"
      : "지식 없음 (개발자 옵션)";

  return (
    <div className="flex h-full flex-col">
      {/* 슬림 헤더 — Ollama Desktop 앱처럼 모델/지식 요약과 연결 상태만
          한 줄로 보여준다. Service/버전/연결 배지 상세는 자산 허브 > 설치된
          자산(D03 상세)과 설정 > 연결 상태로 옮겼다. */}
      <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="text-card-title font-semibold text-text-primary">채팅</h1>
          <span className="text-caption text-text-muted">· {knowledgeSummaryText}</span>
        </div>
        <div className="flex items-center gap-2">
          {connections === null ? (
            <span className="text-caption text-text-muted">연결 확인 중...</span>
          ) : (
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                failedConnections.length === 0 ? "bg-success/10 text-success" : "bg-danger/10 text-danger"
              }`}
              title={connections.map((c) => `${c.label}: ${c.ok ? "정상" : "오류"}`).join(" · ")}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${failedConnections.length === 0 ? "bg-success" : "bg-danger"}`} />
              {failedConnections.length === 0 ? "연결 정상" : "연결 문제"}
            </span>
          )}
          <Button variant="secondary" size="sm" onClick={() => void refreshConnections()} disabled={connectionsChecking}>
            <RefreshCw size={13} className={connectionsChecking ? "animate-spin" : ""} /> 연결 다시 확인
          </Button>
        </div>
      </div>

      {/* 연결 장애 복구 안내(CLAUDE.md 필수) — 대화가 실제로 막힐 수 있는
          상황이므로 배지 hover가 아니라 항상 보이는 배너로 보여준다. */}
      {failedConnections.length > 0 && (
        <div className="mb-3 shrink-0 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-body text-danger">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {failedConnections.map((c) => c.label).join(", ")} 연결이 끊어져 있어 대화가 제한될 수 있습니다.
              </p>
              <ul className="mt-1 space-y-0.5 text-caption">
                {failedConnections.map((c) => (
                  <li key={c.id}>
                    {c.label}: {c.detail}
                    {c.recoveryHint ? ` — ${c.recoveryHint}` : ""}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-caption text-text-secondary">설정 &gt; 연결 상태에서 자세히 확인할 수 있습니다.</p>
            </div>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-4">
        {/* 좌측 대화 목록 패널(Ollama Desktop 앱과 같은 구성) — D06 대화
            보존. Electron 브릿지가 있을 때만(대화 저장은 Main Process 전용). */}
        {bridge && (
          <div className="flex w-64 shrink-0 flex-col">
            <Button
              variant="secondary"
              onClick={handleNewConversation}
              disabled={isRunning}
              className="mb-3 w-full justify-center"
            >
              <MessageSquarePlus size={14} /> 새 대화
            </Button>
            <div className="flex-1 space-y-1 overflow-y-auto pr-1">
              {conversationsError && <ErrorBanner message={conversationsError} />}
              {conversations === null && !conversationsError && <LoadingState label="대화 목록을 불러오는 중..." />}
              {conversations !== null && conversations.length === 0 && !conversationsError && (
                <p className="px-1 py-6 text-center text-caption text-text-muted">아직 저장된 대화가 없습니다.</p>
              )}
              {conversations !== null &&
                conversations.map((c) => (
                  <div key={c.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void handleSelectConversation(c.id)}
                      disabled={isRunning}
                      className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-left text-caption transition-colors ${
                        currentConversationId === c.id
                          ? "border-brand-500 bg-brand-50 text-brand-700"
                          : "border-border bg-white text-text-secondary hover:bg-slate-50"
                      }`}
                    >
                      <span className="block truncate font-medium">{c.title}</span>
                      <span className="block truncate text-[11px] text-text-muted">
                        {c.knowledgeLabel} · 턴 {c.turnCount}개 · {formatDateTime(c.updatedAt)}
                      </span>
                    </button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => requestDeleteConversation(c)}
                      title="이 대화 삭제"
                      className="shrink-0 px-2"
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                ))}
            </div>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* 지식 검색 대상 상태 — 지식 검색 자동화: 설치된 모든
              Knowledge(Active 버전)를 자동으로 검색 대상으로 쓴다. 정상일
              때는 위 슬림 헤더 한 줄로 충분하므로, 여기서는 안내가 필요한
              경우(Loading/Empty/Error/경고)만 배너로 보여준다(CLAUDE.md:
              Loading/Empty/Error 상태 유지 — 다만 화면의 주인공은 메시지
              스레드와 입력창이어야 하므로 정상 상태에는 카드를 띄우지 않는다). */}
          {bridge && installedKnowledge === null && !installedError && (
            <div className="mb-3 shrink-0">
              <LoadingState label="설치된 Knowledge를 불러오는 중..." />
            </div>
          )}
          {bridge && installedError && (
            <div className="mb-3 shrink-0">
              <ErrorBanner message={installedError} />
            </div>
          )}
          {bridge && installedKnowledge !== null && installedKnowledge.length === 0 && !installedError && (
            <div className="mb-3 shrink-0">
              <EmptyState
                title="설치된 Knowledge가 없습니다"
                description="자산 허브 > 가져오기에서 Knowledge가 포함된 Offline Bundle을 먼저 반입하세요."
              />
            </div>
          )}
          {bridge && installedKnowledge !== null && installedKnowledge.length > 0 && knowledgeIds.length === 0 && (
            <div className="mb-3 shrink-0">
              <EmptyState
                title="검색 가능한 지식 자산이 없습니다"
                description="설치된 Knowledge가 모두 이전 형식의 Bundle입니다 — 다시 반출·설치해야 대화할 수 있습니다."
              />
            </div>
          )}
          {bridge && installedKnowledge !== null && installedKnowledge.some((a) => !a.assetVersionId) && (
            <p className="mb-3 flex shrink-0 items-start gap-1.5 text-caption text-warning">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {LEGACY_BUNDLE_KNOWLEDGE_ID_REASON} 대상:{" "}
              {installedKnowledge
                .filter((a) => !a.assetVersionId)
                .map((a) => `${a.name} v${a.version}`)
                .join(", ")}
            </p>
          )}

          {/* 개발 확인용 입력 — Service Registry가 아직 없어(D-034/D-058) 정식
              Knowledge/Tool 선택 UI를 만들 근거가 없다. 메인 흐름에서 빼고
              접이식 "개발자 옵션"으로 옮겼다(기본 접힘). Electron 브릿지가
              있으면(정식 빌드로 보이는 상태) 이 영역 자체가 없다 — 기존과
              동일한 노출 조건. */}
          {!bridge && (
            <details className="mb-4 shrink-0 rounded-card border border-warning/30 bg-warning/5">
              <summary className="cursor-pointer select-none px-4 py-2.5 text-caption font-semibold text-warning">
                개발자 옵션 — 실제 제품에는 노출되지 않습니다
              </summary>
              <div className="space-y-4 border-t border-warning/20 p-4">
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
                    Desktop(Electron) 런타임이 연결되어 있지 않을 때만 표시되는 개발용 입력입니다.
                  </p>
                </div>

                {/* Tool 호출 확인 Panel(WAITING_FOR_USER) 검증용. Service
                    Registry가 없어 정식 Tool 선택 UI를 만들 근거가 없다
                    (open-decisions.md D-058). */}
                <div>
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
                  </p>
                </div>
              </div>
            </details>
          )}

          {/* 대화 — 메시지 스레드와 입력창이 화면의 주인공이다. */}
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
                  description={
                    hasUsableKnowledge || mcpDevActive
                      ? "질문을 입력해 대화를 시작하세요."
                      : "대화할 수 있는 Knowledge가 없습니다. 먼저 Knowledge를 설치하세요."
                  }
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
              {/* 허브 조회 동의(Stage 2, D-078) — 절대 제거·축소·기본값
                  변경 금지. 기본 꺼짐, 세션마다 초기화(저장하지 않음).
                  "로컬에서 조회하는 데이터를 허브에 넘기면 안 돼": 이 동의는
                  편의를 위한 묵시적 허용이 아니라 매번 다시 확인하는 명시적
                  선택. 켜져 있을 때만 실제 전송될 질의를 미리 보여준다(사전
                  가시성) — 사후 가시성은 "hub.query_sent" 이벤트(ChatTurn
                  대화 내 안내문)가 보완한다. */}
              <div className="mb-3">
                <label className="flex items-center gap-2 text-caption font-medium text-text-secondary">
                  <input
                    type="checkbox"
                    checked={allowHubLookup}
                    onChange={(e) => setAllowHubLookup(e.target.checked)}
                    disabled={isRunning}
                  />
                  허브에도 물어보기 (로컬에서 찾지 못한 경우에만)
                </label>
                <p className="mt-1 text-caption text-text-muted">
                  기본적으로 꺼져 있습니다. 켜면 로컬에서 답을 찾지 못했을 때만, 사용자가 입력한 질문 텍스트만 허브로
                  전송됩니다 — 로컬 문서 내용은 전송되지 않습니다.
                </p>
                {allowHubLookup && (
                  <p className="mt-1.5 text-caption text-text-secondary">
                    허브로 전송될 질의 미리보기: &quot;{hubQueryPreview}&quot;
                  </p>
                )}
              </div>
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
        </div>
      </div>

      {citationDetail && <CitationDetailModal citation={citationDetail} onClose={() => setCitationDetail(null)} />}
      {detailMessage && <RunDetailPanel message={detailMessage} onClose={() => setDetailMessageId(null)} />}

      <ReasonConfirmDialog
        open={deletingConversation !== null}
        title={`'${deletingConversation?.title ?? ""}' 대화를 삭제할까요?`}
        description="삭제된 대화는 복구할 수 없습니다."
        confirmLabel="삭제"
        reasonLabel="삭제 사유"
        reasonPlaceholder="예: 더 이상 필요하지 않은 대화 정리"
        submitting={deleteConversationBusy}
        error={deleteConversationError}
        onConfirm={(reason) => void handleConfirmDeleteConversation(reason)}
        onCancel={() => {
          setDeletingConversation(null);
          setDeleteConversationError(null);
        }}
      />
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
        {message.restored && (
          <p className="text-[11px] text-text-muted">저장된 대화에서 복원됨 · 실행 상세 정보는 보존되지 않습니다.</p>
        )}
        <StageIndicator stages={message.stages} />

        {/* 허브 조회 사후 가시성 — "hub.query_sent" 이벤트가 도착할 때마다
            실제로 허브에 전송된 질의를 그대로 보여준다(agent-runtime의 강제
            지점이 사용자가 입력한 텍스트로만 구성되도록 보장하므로 그대로
            표시해도 안전하다). */}
        {message.hubQueriesSent.map((h, idx) => (
          <p key={idx} className="flex items-start gap-1.5 text-caption text-text-muted">
            <Globe size={13} className="mt-0.5 shrink-0" />
            허브에 질의를 전송했습니다: &quot;{h.query}&quot;
          </p>
        ))}

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

        {message.restored && (message.restoredCitationCount ?? 0) > 0 && (
          <p className="text-caption text-text-muted">
            출처 {message.restoredCitationCount}건 (복원된 대화에는 출처 상세 내용이 저장되지 않습니다)
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
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 font-semibold text-text-secondary">
                    {c.document_title || c.document_path || "제목 없음"}
                    {c.section && <span className="font-normal"> · {c.section}</span>}
                  </div>
                  {/* 두 단계 검색(지식 검색 자동화 + 허브 조회 동의) — 이
                      출처가 로컬/허브 중 어느 쪽 검색에서 나왔는지. 값이
                      없으면(과거 데이터) 로컬로 취급해 표시한다. */}
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      c.source === "hub" ? "bg-brand-50 text-brand-700" : "bg-slate-200 text-text-muted"
                    }`}
                  >
                    {c.source === "hub" ? "허브" : "로컬"}
                  </span>
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
