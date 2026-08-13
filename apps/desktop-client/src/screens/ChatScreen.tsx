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
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, BookOpenCheck, Bot, Check, Copy, Download, FileSearch, Globe, Globe2, Info, ListChecks, MessageSquarePlus, RefreshCw, Send, Square, Trash2 } from "lucide-react";
import type { ConnectionStatus, ConversationSummary, ConversationTurnStatus, InstalledAssetWithStatus, OllamaModelsResult } from "../../electron/types";
import { assessChatConnections, checkAllConnections, DEFAULT_OLLAMA_BASE_URL } from "../../electron/connections";
import { chatWithOllama, DEFAULT_CHAT_MODEL_ALIAS } from "../../electron/ollama-chat";
import { getDesktopBridge } from "../bridge";
import { getBrowserSettingsBridge } from "../browserPreviewBridge";
import { formatDateTime } from "../format";
import { Button, EmptyState, ErrorBanner, LoadingState, ReasonConfirmDialog } from "../ui";
import {
  type Citation,
  type RunEventLogItem,
  AGENT_RUNTIME_BASE_URL,
  cancelRun,
  confirmRun,
  getRun,
  openRunEventStream,
  startRun,
} from "../agentRuntime";
import { applyRuntimeEvent, initialStages, ollamaChatStages } from "../runStages";
import {
  type ChatMessage,
  type ExcludedKnowledge,
  buildHistoryFromMessages,
  buildHubQueryPreview,
  buildMarkdown,
  chatMessageFromStoredTurn,
  downloadMarkdown,
  hasLowConfidenceCitation,
  mergeCitations,
  partitionInstalledKnowledgeByActivation,
  resolveReconcileNotice,
} from "./chatTypes";
import { RunDetailPanel } from "./RunDetailPanel";
import { ConfirmationPanel } from "./ConfirmationPanel";
import { getInstalledChatModels } from "./settingsTypes";

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

function ComposerToggle({
  id,
  label,
  description,
  icon,
  pressed,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  icon: ReactNode;
  pressed: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        aria-describedby={`${id}-tooltip`}
        disabled={disabled}
        onClick={() => onChange(!pressed)}
        className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors focus:outline-none focus:ring-2 focus:ring-brand-400 focus:ring-offset-2 ${
          pressed
            ? "border-brand-500 bg-brand-50 text-brand-700"
            : "border-border bg-white text-text-secondary hover:border-brand-300 hover:text-brand-700"
        } disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-text-muted`}
      >
        {icon}
      </button>
      <div
        id={`${id}-tooltip`}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-30 mb-2 w-72 translate-y-1 rounded-lg border border-slate-200 bg-slate-900 px-3 py-2.5 text-left text-xs text-slate-50 opacity-0 shadow-lg transition duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
      >
        <p className="font-semibold">{label}</p>
        <p className="mt-1 leading-5 text-slate-200">{description}</p>
      </div>
    </div>
  );
}

// D-079 이어 붙이기 — 검색 대상에서 제외된 Knowledge 한 건: 이름/버전, 제외
// 사유(항상 한국어), 그리고 그 자리에서 바로 다시 시도할 수 있는 활성화
// 버튼. 진행 중/성공/실패를 이 컴포넌트 하나로 함께 보여준다.
function ExcludedKnowledgeRow({
  asset,
  reason,
  busy,
  feedback,
  onActivate,
}: {
  asset: InstalledAssetWithStatus;
  reason: string;
  busy: boolean;
  feedback: { ok: boolean; message: string } | null;
  onActivate: () => void;
}) {
  return (
    <li className="rounded-lg border border-border bg-white px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-caption font-semibold text-text-primary">
            {asset.name} v{asset.version}
          </p>
          <p className="text-caption text-text-secondary">{reason}</p>
          {feedback && (
            <p className={`mt-1 text-caption ${feedback.ok ? "text-success" : "text-danger"}`}>{feedback.message}</p>
          )}
        </div>
        <Button variant="secondary" size="sm" onClick={onActivate} disabled={busy} className="shrink-0">
          {busy ? "활성화하는 중..." : "활성화"}
        </Button>
      </div>
    </li>
  );
}

export function ChatScreen({ onGoToInstalledAssets }: { onGoToInstalledAssets?: () => void } = {}) {
  const bridge = getDesktopBridge();
  const browserSettingsBridge = getBrowserSettingsBridge();
  const settingsBridge = bridge ?? browserSettingsBridge;
  const conversationBridge = bridge ?? browserSettingsBridge;

  // 설정 화면까지 이동하지 않아도 이번 대화에 사용할 모델을 바로 고른다.
  // 선택은 기존 Desktop/browser-preview 설정 저장소에 반영되므로 다음 대화의
  // 기본값으로도 이어진다.
  const [modelsResult, setModelsResult] = useState<OllamaModelsResult | null>(null);
  const [chatModelAlias, setChatModelAlias] = useState(DEFAULT_CHAT_MODEL_ALIAS);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  const loadChatModels = useCallback(async () => {
    if (!settingsBridge) return;
    setModelsLoading(true);
    setModelError(null);
    try {
      const settings = await settingsBridge.getDesktopSettings();
      const result = await settingsBridge.listOllamaModels(settings.ollamaBaseUrl);
      const installed = getInstalledChatModels(result);
      setModelsResult(result);
      setChatModelAlias(installed.includes(settings.chatModelAlias) ? settings.chatModelAlias : (installed[0] ?? settings.chatModelAlias));
      if (!result.ok) setModelError(result.error);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "Ollama 모델 목록을 불러오지 못했습니다.");
    } finally {
      setModelsLoading(false);
    }
  }, [settingsBridge]);

  useEffect(() => {
    void loadChatModels();
  }, [loadChatModels]);

  async function handleChatModelChange(model: string): Promise<void> {
    if (!settingsBridge) return;
    const previousModel = chatModelAlias;
    setChatModelAlias(model);
    setModelSaving(true);
    setModelError(null);
    try {
      const result = await settingsBridge.updateDesktopSettings({ chatModelAlias: model });
      if (!result.ok) {
        setChatModelAlias(previousModel);
        setModelError(result.error);
      }
    } catch (error) {
      setChatModelAlias(previousModel);
      setModelError(error instanceof Error ? error.message : "채팅 모델을 저장하지 못했습니다.");
    } finally {
      setModelSaving(false);
    }
  }

  // --- Knowledge 자동 검색 대상(지식 검색 자동화 + D-079 이어 붙이기: 활성화
  // 인지) ---
  const [installedKnowledge, setInstalledKnowledge] = useState<InstalledAssetWithStatus[] | null>(null);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [devKnowledgeId, setDevKnowledgeId] = useState("");
  const [useKnowledge, setUseKnowledge] = useState(false);
  // search-runtime에 물어 로컬 ACTIVE 상태가 여전히 맞는지 재확인한 결과 —
  // `checked:false`(도달 불가)일 때만 채워진다("확인 불가", 사실을 지어내지
  // 않는다). `null`이면 최근 확인이 정상이었거나 아직 확인 전이다.
  const [reconcileNotice, setReconcileNotice] = useState<string | null>(null);
  // D-079 이어 붙이기 — 채팅 화면에서 바로 활성화를 시도할 수 있게 한다
  // (설치된 자산 화면까지 가지 않아도 됨). 키는 `${assetType}::${assetId}::${version}`.
  const [activatingKey, setActivatingKey] = useState<string | null>(null);
  const [activationFeedback, setActivationFeedback] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});

  const loadInstalledKnowledge = useCallback(async () => {
    if (!bridge) return;
    setInstalledError(null);
    try {
      // D-079 이어 붙이기: 목록을 보여주기 전에 로컬 ACTIVE 상태가
      // search-runtime의 실제 등록 목록과 여전히 일치하는지 재확인한다 —
      // search-runtime이 다른 SEARCH_LOCAL_INDEX_ROOTS로 재시작되었거나
      // 레지스트리가 초기화되면 로컬만 "거짓 ACTIVE"로 남을 수 있다
      // (electron/knowledge-activation.ts의 reconcileInstalledKnowledgeActivations
      // 참고). search-runtime에 도달할 수 없으면 아무것도 바뀌지 않고
      // "확인 불가"만 알린다 — 네트워크 장애를 "등록 안 됨"으로 지어내지
      // 않는다. `resolveReconcileNotice`는 `bridge`가 이 메서드를 아예 갖고
      // 있지 않거나(예: 오래된 preload.js 빌드) 호출이 예외를 던져도 절대
      // throw하지 않는다 — 목록 로딩이 이 부가 기능 하나 때문에 화면 전체를
      // 무너뜨리면 안 된다(2026-08-13 실제 장애: 가드 없는 호출이
      // `TypeError: bridge.reconcileKnowledgeActivations is not a function`을
      // 던져 채팅 화면 전체가 죽었다).
      setReconcileNotice(await resolveReconcileNotice(bridge));
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

  function knowledgeAssetKey(asset: { assetType: string; assetId: string; version: string }): string {
    return `${asset.assetType}::${asset.assetId}::${asset.version}`;
  }

  async function handleActivateKnowledge(asset: InstalledAssetWithStatus): Promise<void> {
    if (!bridge) return;
    const key = knowledgeAssetKey(asset);
    setActivatingKey(key);
    setActivationFeedback((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const result = await bridge.activateInstalledKnowledge(asset.assetType, asset.assetId, asset.version);
      if (result.ok) {
        setActivationFeedback((prev) => ({ ...prev, [key]: { ok: true, message: "활성화되었습니다 — 이제 검색에 사용됩니다." } }));
      } else {
        const message = result.activation?.message ?? result.error ?? "활성화하지 못했습니다.";
        setActivationFeedback((prev) => ({ ...prev, [key]: { ok: false, message } }));
      }
      await loadInstalledKnowledge();
    } catch (err) {
      setActivationFeedback((prev) => ({
        ...prev,
        [key]: { ok: false, message: err instanceof Error ? err.message : "활성화 요청 중 오류가 발생했습니다." },
      }));
    } finally {
      setActivatingKey((cur) => (cur === key ? null : cur));
    }
  }

  // 지식 검색 자동화 + D-079 이어 붙이기 — 설치된 모든 Knowledge 중
  // 검색에 실제로 활성화된(activation.state === "ACTIVE") 것만 Stage 1
  // 로컬 검색 대상으로 쓴다. 이전 형식 Bundle(D-060)과 활성화되지 않은/
  // 실패한 Knowledge는 사유와 함께 `knowledgePartition.excluded`에 남는다.
  const knowledgePartition = bridge
    ? partitionInstalledKnowledgeByActivation(installedKnowledge ?? [])
    : { usable: [], excluded: [] as ExcludedKnowledge<InstalledAssetWithStatus>[] };
  const knowledgeIds = bridge
    ? knowledgePartition.usable.map((u) => u.knowledgeId)
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
            const usable = knowledgePartition.usable[0];
            return usable ? `${usable.asset.name} v${usable.asset.version}` : "지식 자산";
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
      // 저장된 설정의 Endpoint 로 검사한다. 기본값으로만 검사하면 사용자가
      // 설정 화면에서 주소를 바꿨을 때 멀쩡한 서비스를 "연결 끊김"으로
      // 표시하게 된다 — 이 저장소가 이미 한 번 겪은 오탐이며(`connections.ts`
      // 의 `DEFAULT_RUNTIME_BASE_URL` 주석), search-runtime 은 D-079 이후
      // Knowledge 대화의 필수 의존성이라 그 오탐이 곧바로 빨간 차단 배너로
      // 이어진다. 설정을 못 읽으면(브라우저 전용 모드 등) 기존처럼 기본값을
      // 쓴다 — 검사를 건너뛰지는 않는다.
      let endpoints: Parameters<typeof checkAllConnections>[0] = {
        runtimeBaseUrl: AGENT_RUNTIME_BASE_URL,
      };
      if (settingsBridge) {
        try {
          const settings = await settingsBridge.getDesktopSettings();
          endpoints = {
            ...endpoints,
            ollamaBaseUrl: settings.ollamaBaseUrl,
            mcpServerUrl: settings.mcpServerUrl,
            mcpServerAlias: settings.mcpServerAlias,
            searchRuntimeBaseUrl: settings.searchRuntimeBaseUrl,
          };
        } catch {
          // 설정 조회 실패는 연결 검사 자체를 막지 않는다.
        }
      }
      setConnections(await checkAllConnections(endpoints));
    } finally {
      setConnectionsChecking(false);
    }
  }, [settingsBridge]);
  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  // --- 허브 조회 동의(Stage 2) — 세션마다 기본 꺼짐, 저장하지 않는다("로컬에서
  // 조회하는 데이터를 허브에 넘기면 안 돼"는 제품 요구사항: 이 동의는
  // 편의를 위한 묵시적 허용이 아니라 매번 다시 확인하는 명시적 선택이어야
  // 한다). 켜져 있을 때만 `buildHubQueryPreview`로 실제 전송될 질의를
  // 미리 보여준다(§ 대화 입력 영역).
  const [allowHubLookup, setAllowHubLookup] = useState(false);
  const knowledgeLookupActive = useKnowledge && hasUsableKnowledge && !mcpDevActive;
  const hubLookupApplicable = knowledgeLookupActive;
  useEffect(() => {
    if (!hubLookupApplicable && allowHubLookup) setAllowHubLookup(false);
  }, [allowHubLookup, hubLookupApplicable]);
  // D-079 이어 붙이기: 검색 가능한 Knowledge가 하나도 없어졌는데(재확인으로
  // 다운그레이드되었거나, 사용자가 방금 비활성화한 경우 등) 토글만 "켜짐"
  // 상태로 남아 있으면, 곧바로 다시 검색 가능해진 것처럼 보여 혼란을 준다 —
  // 실제로는 이미 `knowledgeLookupActive`가 false가 되어 Ollama 일반 대화로
  // 조용히 넘어가므로 검색이 실행되지는 않지만(대화가 결과 없는 검색으로
  // 새지는 않는다), 토글 표시 자체는 사실과 맞춰 둔다.
  useEffect(() => {
    if (!hasUsableKnowledge && useKnowledge) setUseKnowledge(false);
  }, [hasUsableKnowledge, useKnowledge]);

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

  // --- D06 대화 보존(Desktop 대화 고도화/멀티턴) — Electron에서는 Main
  // Process 저장소, browser-preview에서는 해당 브라우저의 localStorage를
  // 사용한다. 일반 브라우저 모드에서는 저장 브릿지가 없으므로 세션 내에서만
  // 유지된다.
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
    if (!conversationBridge) return;
    setConversationsError(null);
    try {
      setConversations(await conversationBridge.listConversations());
    } catch (err) {
      setConversationsError(err instanceof Error ? err.message : "대화 목록을 불러오지 못했습니다.");
      setConversations([]);
    }
  }, [conversationBridge]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  const closeStreamRef = useRef<(() => void) | null>(null);
  const runIdRef = useRef<string | null>(null);
  const ollamaAbortRef = useRef<AbortController | null>(null);
  const cancelledOllamaMessageIdsRef = useRef<Set<string>>(new Set());

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
    if (!conversationBridge) return;
    for (const m of messages) {
      if (m.restored) continue; // 이미 저장소에서 읽어온 턴 — 다시 쓸 필요 없음
      if (!TERMINAL_CONVERSATION_STATUSES.has(m.status as ConversationTurnStatus)) continue;
      if (persistedTurnIdsRef.current.has(m.id)) continue;
      persistedTurnIdsRef.current.add(m.id);
      void persistTurn(m);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, conversationBridge]);

  async function persistTurn(m: ChatMessage): Promise<void> {
    if (!conversationBridge) return;
    try {
      let conversationId = currentConversationId;
      if (!conversationId) {
        const created = await conversationBridge.createConversation(m.knowledgeIdUsed, m.knowledgeLabelUsed);
        conversationId = created.id;
        setCurrentConversationId(created.id);
      }
      await conversationBridge.appendConversationTurn(conversationId, {
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
    if (!conversationBridge) return;
    setSendError(null);
    try {
      const record = await conversationBridge.getConversation(id);
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
    if (!conversationBridge || !deletingConversation) return;
    setDeleteConversationBusy(true);
    setDeleteConversationError(null);
    try {
      const result = await conversationBridge.deleteConversation(deletingConversation.id, reason);
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
    if (!q || isRunning) return;

    setSendError(null);
    setQuestion("");
    const id = crypto.randomUUID();
    const ollamaOnly = !knowledgeLookupActive && !mcpDevActive;
    const serviceId = ollamaOnly
      ? `${SERVICE_ID_PREFIX}:ollama-default`
      : `${SERVICE_ID_PREFIX}:${knowledgeId || "mcp-dev-trigger"}`;
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
      knowledgeLabelUsed: ollamaOnly ? "기본 Ollama 대화" : knowledgeLabel,
      serviceId,
      agentProfile,
      ollamaOnly,
      status: "running",
      answer: "",
      citations: [],
      stages: ollamaOnly ? ollamaChatStages("running") : initialStages(),
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
      if (ollamaOnly) {
        const input = { question: q, history };
        const controller = new AbortController();
        ollamaAbortRef.current = controller;
        const previewSettings = !bridge && browserSettingsBridge ? await browserSettingsBridge.getDesktopSettings() : null;
        const result = bridge
          ? await bridge.chatWithOllama(input)
          : await chatWithOllama(
              previewSettings?.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL,
              previewSettings?.chatModelAlias ?? DEFAULT_CHAT_MODEL_ALIAS,
              input,
              controller.signal,
            );
        if (cancelledOllamaMessageIdsRef.current.has(id)) {
          cancelledOllamaMessageIdsRef.current.delete(id);
          ollamaAbortRef.current = null;
          return;
        }
        patchMessage(id, {
          status: "succeeded",
          answer: result.answer,
          ollamaModel: result.model,
          knowledgeLabelUsed: `Ollama · ${result.model}`,
          stages: ollamaChatStages("succeeded"),
          completedAt: new Date().toISOString(),
        });
        setIsRunning(false);
        ollamaAbortRef.current = null;
        return;
      }

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
      const wasOllamaCancelled = cancelledOllamaMessageIdsRef.current.has(id);
      cancelledOllamaMessageIdsRef.current.delete(id);
      ollamaAbortRef.current = null;
      if (ollamaOnly && wasOllamaCancelled) {
        patchMessage(id, {
          status: "cancelled",
          stages: ollamaChatStages("cancelled"),
          completedAt: new Date().toISOString(),
        });
        setIsRunning(false);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      patchMessage(id, {
        status: "failed",
        errorMessage: `실행 요청에 실패했습니다: ${msg}`,
        ...(ollamaOnly ? { stages: ollamaChatStages("failed") } : {}),
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
    if (message.ollamaOnly) {
      cancelledOllamaMessageIdsRef.current.add(message.id);
      patchMessage(message.id, {
        status: "cancelled",
        stages: ollamaChatStages("cancelled"),
        completedAt: new Date().toISOString(),
      });
      setIsRunning(false);
      if (bridge) await bridge.cancelOllamaChat();
      else ollamaAbortRef.current?.abort();
      return;
    }
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

  const canSend = Boolean(question.trim()) && !isRunning && !modelSaving;
  const installedChatModels = getInstalledChatModels(modelsResult);
  const sendDisabledReason = isRunning
    ? "이미 실행 중입니다. 완료되거나 취소한 뒤 다시 시도하세요."
    : modelSaving
      ? "선택한 모델을 저장하는 중입니다."
    : !question.trim()
      ? "질문을 입력하세요."
      : null;

  // 허브로 실제 전송될 질의 미리보기 — 매 입력마다(질문 초안/이전 턴이
  // 바뀔 때마다) 다시 계산되어 최신 상태를 반영한다(chatTypes.ts
  // buildHubQueryPreview). 토글이 꺼져 있으면 전송될 것이 없으므로 계산하지
  // 않는다.
  const hubQueryPreview = allowHubLookup ? buildHubQueryPreview(question, messages) : "";

  const detailMessage = messages.find((m) => m.id === detailMessageId) ?? null;

  // 대화 필수 서비스 장애와 MCP 선택 기능 장애를 분리한다. 어떤 서비스가
  // 필수인지에 대한 지식은 connections.ts의 순수 헬퍼 한 곳에만 둔다.
  const connectionAssessment = assessChatConnections(
    connections ?? [],
    knowledgeLookupActive || mcpDevActive ? "knowledge" : "ollama",
  );
  const { blockingFailures, featureFailures } = connectionAssessment;

  // 상단 슬림 헤더용 — Ollama Desktop 앱처럼 모델/지식 상태를 한 줄로 요약한다.
  const knowledgeSummaryText = bridge
    ? knowledgeLookupActive
      ? `Ollama + 지식 ${knowledgeIds.length}개 검색`
      : "기본 Ollama 대화"
    : knowledgeLookupActive
      ? "Ollama + 개발용 Knowledge 검색"
      : "기본 Ollama 대화";

  return (
    <div className="flex h-full flex-col">
      {/* 슬림 헤더 — Ollama Desktop 앱처럼 모델/지식 요약과 연결 상태만
          한 줄로 보여준다. Service/버전/연결 배지 상세는 자산 허브 > 설치된
          자산(D03 상세)과 설정 > 연결 상태로 옮겼다. */}
      <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="text-card-title font-semibold text-text-primary">채팅</h1>
          <span className="text-caption text-text-muted">{knowledgeSummaryText}</span>
        </div>
        <div className="flex items-center gap-2">
          {connections === null ? (
            <span className="text-caption text-text-muted">연결 확인 중...</span>
          ) : (
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                connectionAssessment.state === "healthy"
                  ? "bg-success/10 text-success"
                  : connectionAssessment.state === "limited"
                    ? "bg-warning/10 text-warning"
                    : "bg-danger/10 text-danger"
              }`}
              title={connections.map((c) => `${c.label}: ${c.ok ? "정상" : "오류"}`).join(" · ")}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  connectionAssessment.state === "healthy"
                    ? "bg-success"
                    : connectionAssessment.state === "limited"
                      ? "bg-warning"
                      : "bg-danger"
                }`}
              />
              {connectionAssessment.state === "healthy"
                ? "연결 정상"
                : connectionAssessment.state === "limited"
                  ? "일부 기능 제한"
                  : "대화 연결 문제"}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refreshConnections()}
            disabled={connectionsChecking}
            title="연결 상태 다시 확인"
            aria-label="연결 상태 다시 확인"
            className="px-2"
          >
            <RefreshCw size={13} className={connectionsChecking ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      {/* 연결 장애 복구 안내(CLAUDE.md 필수) — 대화가 실제로 막힐 수 있는
          상황이므로 배지 hover가 아니라 항상 보이는 배너로 보여준다. */}
      {blockingFailures.length > 0 && (
        <div className="mb-3 shrink-0 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-body text-danger">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {blockingFailures.map((c) => c.label).join(", ")} 연결이 끊어져 있어 대화가 제한될 수 있습니다.
              </p>
              <ul className="mt-1 space-y-0.5 text-caption">
                {blockingFailures.map((c) => (
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

      {featureFailures.length > 0 && (
        <div
          className="mb-3 flex shrink-0 items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-caption text-warning"
          title={`${featureFailures.map((connection) => `${connection.label}: ${connection.detail}${connection.recoveryHint ? ` — ${connection.recoveryHint}` : ""}`).join("\n")}\n설정 > 연결 상태에서 자세히 확인할 수 있습니다.`}
        >
          <AlertTriangle size={14} className="shrink-0" />
          <span className="font-medium">Ollama 대화는 정상이며 Knowledge·Tool 일부 기능만 제한됩니다.</span>
          <Info size={13} className="ml-auto shrink-0" aria-label="마우스를 올리면 제한 사유를 확인할 수 있습니다." />
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-4">
        {/* 좌측 대화 목록 패널(Ollama Desktop 앱과 같은 구성) — D06 대화
            보존. Electron 브릿지가 있을 때만(대화 저장은 Main Process 전용). */}
        {conversationBridge && (
          <aside className="flex w-64 shrink-0 flex-col border-r border-border pr-3" aria-label="채팅 목록">
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
                      className="shrink-0 px-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                ))}
            </div>
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* 지식 검색 대상 상태 — 지식 검색 자동화 + D-079 이어 붙이기(활성화
              인지): "설치됨"과 "활성화됨"은 서로 다른 사실이다. 정상(=1개
              이상 활성화되어 있고 제외된 것이 없음)일 때는 위 슬림 헤더 한
              줄로 충분하므로, 여기서는 안내가 필요한 경우(Loading/Empty/
              Error/제외됨)만 배너로 보여준다(CLAUDE.md: Loading/Empty/Error
              상태 유지). 활성화된 게 하나도 없으면 검색이 결과를 낼 수 없는
              상태이므로 — 조용히 Ollama로만 넘어가지 않고 왜 그런지와 고치는
              방법(활성화 버튼)을 항상 함께 보여준다. */}
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
                title="기본 Ollama 모델로 대화합니다"
                description="Knowledge를 설치하면 사내 지식을 근거로 답변하고, 지금은 설치된 기본 채팅 모델로 일반 대화합니다."
              />
            </div>
          )}
          {bridge && installedKnowledge !== null && installedKnowledge.length > 0 && knowledgePartition.usable.length === 0 && (
            <div className="mb-3 shrink-0 rounded-card border border-danger/30 bg-danger/5 px-4 py-3 text-body text-danger">
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    설치된 Knowledge {installedKnowledge.length}개가 모두 검색에 활성화되지 않아 지금은 지식 검색을
                    실행할 수 없습니다 — 질문은 기본 Ollama 모델로만 답변됩니다. 아래에서 활성화하면 바로 검색에
                    쓸 수 있습니다.
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {knowledgePartition.excluded.map(({ asset, reason }) => (
                      <ExcludedKnowledgeRow
                        key={knowledgeAssetKey(asset)}
                        asset={asset}
                        reason={reason}
                        busy={activatingKey === knowledgeAssetKey(asset)}
                        feedback={activationFeedback[knowledgeAssetKey(asset)] ?? null}
                        onActivate={() => void handleActivateKnowledge(asset)}
                      />
                    ))}
                  </ul>
                  {onGoToInstalledAssets && (
                    <Button variant="secondary" size="sm" className="mt-2" onClick={onGoToInstalledAssets}>
                      설치된 자산 화면 열기
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
          {bridge && knowledgePartition.usable.length > 0 && knowledgePartition.excluded.length > 0 && (
            <details className="mb-3 shrink-0 rounded-card border border-warning/30 bg-warning/5">
              <summary className="cursor-pointer select-none px-4 py-2.5 text-caption font-semibold text-warning">
                Knowledge {knowledgePartition.usable.length}개 활성화됨 · {knowledgePartition.excluded.length}개
                검색에서 제외됨 (자세히)
              </summary>
              <div className="space-y-2 border-t border-warning/20 p-4">
                <ul className="space-y-1.5">
                  {knowledgePartition.excluded.map(({ asset, reason }) => (
                    <ExcludedKnowledgeRow
                      key={knowledgeAssetKey(asset)}
                      asset={asset}
                      reason={reason}
                      busy={activatingKey === knowledgeAssetKey(asset)}
                      feedback={activationFeedback[knowledgeAssetKey(asset)] ?? null}
                      onActivate={() => void handleActivateKnowledge(asset)}
                    />
                  ))}
                </ul>
                {onGoToInstalledAssets && (
                  <Button variant="secondary" size="sm" onClick={onGoToInstalledAssets}>
                    설치된 자산 화면 열기
                  </Button>
                )}
              </div>
            </details>
          )}
          {bridge && reconcileNotice && (
            <p className="mb-3 flex shrink-0 items-start gap-1.5 text-caption text-text-muted">
              <Info size={13} className="mt-0.5 shrink-0" />
              활성화 상태 확인 불가: {reconcileNotice}
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
                    knowledgeLookupActive
                      ? "보유 Knowledge를 근거로 답할 질문을 입력하세요."
                      : "질문을 입력하면 기본 Ollama 모델로 일반 대화를 시작합니다. 필요할 때 보유 Knowledge 검색을 켤 수 있습니다."
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

            <div className="mt-4 shrink-0 border-t border-border pt-3">
              <div className="mb-2 flex items-center gap-2">
                <ComposerToggle
                  id="knowledge-toggle"
                  label="보유 Knowledge에서 찾기"
                  description={
                    hasUsableKnowledge
                      ? "사내 지식에 근거한 답변이 필요할 때 켭니다. 끄면 선택한 Ollama 모델과 바로 대화합니다."
                      : installedKnowledge === null && bridge
                        ? "보유 Knowledge를 확인하는 중입니다. Ollama 일반 대화는 바로 사용할 수 있습니다."
                        : "검색 가능한 Knowledge가 없어 현재는 Ollama 일반 대화만 사용할 수 있습니다."
                  }
                  icon={<BookOpenCheck size={16} aria-hidden="true" />}
                  pressed={useKnowledge}
                  disabled={isRunning || !hasUsableKnowledge || mcpDevActive}
                  onChange={setUseKnowledge}
                />

                {/* 허브 조회 동의(Stage 2, D-078) — 기본 꺼짐과 세션별 초기화,
                    사용자 질문 텍스트만 전송하는 경계는 그대로 유지한다. 긴
                    설명은 제거하지 않고 hover/focus 툴팁으로 점진 공개한다. */}
                <ComposerToggle
                  id="hub-toggle"
                  label="허브에도 물어보기"
                  description={
                    hubLookupApplicable
                      ? "로컬 Knowledge에서 답을 찾지 못한 경우에만 사용자가 입력한 질문 텍스트를 허브로 전송합니다. 로컬 문서 내용은 전송되지 않습니다."
                      : "보유 Knowledge 검색을 먼저 켜야 사용할 수 있습니다. 기본적으로 꺼져 있으며 로컬 문서 내용은 허브로 전송되지 않습니다."
                  }
                  icon={<Globe2 size={16} aria-hidden="true" />}
                  pressed={allowHubLookup}
                  disabled={isRunning || !hubLookupApplicable}
                  onChange={setAllowHubLookup}
                />

                {settingsBridge ? (
                  <div className="ml-1 flex min-w-0 items-center gap-1.5 rounded-lg border border-border bg-white px-2.5 py-1.5">
                    <Bot size={14} className="shrink-0 text-brand-600" aria-hidden="true" />
                    <label htmlFor="chat-model-select" className="sr-only">채팅 모델</label>
                    <select
                      id="chat-model-select"
                      value={chatModelAlias}
                      onChange={(event) => void handleChatModelChange(event.target.value)}
                      disabled={modelsLoading || modelSaving || installedChatModels.length === 0 || isRunning}
                      className="max-w-64 min-w-0 bg-transparent text-caption font-medium text-text-primary outline-none disabled:text-text-muted"
                      title={modelError ?? "이 질문에 사용할 Ollama 모델"}
                    >
                      {installedChatModels.length === 0 ? (
                        <option value={chatModelAlias}>{modelsLoading ? "모델 확인 중..." : chatModelAlias}</option>
                      ) : (
                        installedChatModels.map((model) => <option key={model} value={model}>{model}</option>)
                      )}
                    </select>
                    {modelError && <Info size={13} className="shrink-0 text-warning" aria-label={modelError} />}
                  </div>
                ) : (
                  <span className="text-caption text-text-muted">Ollama · {chatModelAlias}</span>
                )}
                {knowledgeLookupActive && (
                  <span className="text-caption text-text-muted">Knowledge {knowledgeIds.length}개 검색</span>
                )}
              </div>

              {allowHubLookup && (
                <p className="mb-2 rounded-md bg-brand-50 px-2.5 py-1.5 text-caption text-brand-700">
                  허브 전송 미리보기: &quot;{hubQueryPreview}&quot;
                </p>
              )}
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
        {message.ollamaOnly && (
          <p className="text-[11px] text-text-muted">
            {message.ollamaModel ? `Ollama 일반 대화 · ${message.ollamaModel}` : "Ollama 일반 대화"}
          </p>
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
          {isTerminal && !message.ollamaOnly && (
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
