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
// Tool 호출 확인 Panel(WAITING_FOR_USER, D-052 후속): 일반 Service별 Tool
// 선택 UI는 아직 만들지 않는다(Service Registry 부재). 브라우저 Preview는
// 기존 개발용 입력만 제공한다. Electron에서는 예외적으로 Hub에서 설치되고
// agent-runtime 연결까지 확인된 `calculator.add` 샘플에만 닫힌 숫자 입력을
// 노출해, 설치→연결→실행의 데모 경로를 검증한다. 임의 Tool 이름이나 자유형
// JSON 입력을 받지 않는다.
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, BookOpenCheck, Bot, Check, Copy, Download, FileSearch, Globe, Globe2, Info, ListChecks, MessageSquarePlus, RefreshCw, Send, Sparkles, Square, Trash2, Wrench } from "lucide-react";
import type {
  ConnectionStatus,
  ConversationSummary,
  ConversationTurnStatus,
  InstalledAssetWithStatus,
  KnowledgeCandidate,
  LocalTool,
  OllamaModelsResult,
} from "../../electron/types";
import { assessChatConnections, checkAllConnections, DEFAULT_OLLAMA_BASE_URL } from "../../electron/connections";
import { chatWithOllama, DEFAULT_CHAT_MODEL_ALIAS } from "../../electron/ollama-chat";
import { getDesktopBridge } from "../bridge";
import { getBrowserSettingsBridge } from "../browserPreviewBridge";
import { formatDateTime } from "../format";
import { AgentDraftDialog } from "./AgentDraftDialog";
import { AnswerMarkdown } from "./AnswerMarkdown";
import { Button, ErrorBanner, LoadingState, ReasonConfirmDialog } from "../ui";
import {
  type Citation,
  type RunEventLogItem,
  getAgentRuntimeBaseUrl,
  setAgentRuntimeBaseUrl,
  cancelRun,
  confirmRun,
  getRun,
  openRunEventStream,
  startRun,
} from "../agentRuntime";
import { applyRuntimeEvent, describeStage, initialStages, ollamaChatStages, STAGE_ORDER } from "../runStages";
import {
  type ChatMessage,
  type ExcludedKnowledge,
  type KnowledgeRouteDisplay,
  type KnowledgeRouteEventData,
  type ToolRouteDisplay,
  type ToolRouteRejectedEventData,
  type ToolRouteSelectedEventData,
  RECONCILE_SAME_CAUSE_NOTICE,
  buildHistoryFromMessages,
  buildHubQueryPreview,
  buildMarkdown,
  chatMessageFromStoredTurn,
  describeKnowledgeRoute,
  describeToolRouteMcpToolsHint,
  describeToolRouteRejected,
  describeToolRouteSelected,
  downloadMarkdown,
  groupExcludedKnowledgeByReason,
  hasLowConfidenceCitation,
  mergeCitations,
  partitionInstalledKnowledgeByActivation,
  resolveExcludedRowText,
  resolveReconcileCaption,
  resolveReconcileNotice,
  summarizeMcpToolConnections,
} from "./chatTypes";
import { RunDetailPanel } from "./RunDetailPanel";
import { ConfirmationPanel } from "./ConfirmationPanel";
import { getInstalledChatModels } from "./settingsTypes";
// D-084 후속(로컬 Tool을 대화에서 실행) — 이 화면은 여기서만 로컬 Tool을
// 다룬다. `../agentRuntime`/`./chatTypes`(Run을 시작하고 agent-runtime에
// 보낼 Payload를 만드는 코드)는 로컬 Tool을 절대 참조하지 않는다 —
// `LocalToolInvokePanel.tsx`의 모듈 docstring과
// `electron/__tests__/local-tool-isolation.test.ts`가 이 경계를 강제한다.
import {
  LocalToolAutoRouteEntryCard,
  LocalToolChatEntryCard,
  LocalToolInvokePanel,
  runLocalToolAutoRoute,
  type LocalToolAutoRouteEntry,
  type LocalToolChatEntry,
} from "./LocalToolInvokePanel";

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
const CALCULATOR_SAMPLE_ASSET_ID = "8c1d2b2f-4be6-4dc4-948e-308df4903a32";

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
  activeLabel,
}: {
  id: string;
  label: string;
  description: string;
  icon: ReactNode;
  pressed: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  /** 켜져 있을 때 아이콘 옆에 붙는 짧은 상태 텍스트(예: "지식 3개"). 이
   *  화면에서 "지금 무엇이 켜져 있는가"를 알려주는 유일한 상시 표시이므로,
   *  꺼져 있을 때는 아이콘만 남겨 조용히 둔다(안내 문구 최소화, 2026-08-14). */
  activeLabel?: string;
}) {
  const showLabel = pressed && Boolean(activeLabel);
  return (
    <div className="group relative">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        aria-describedby={`${id}-tooltip`}
        disabled={disabled}
        onClick={() => onChange(!pressed)}
        className={`flex h-8 items-center justify-center gap-1.5 rounded-full border text-caption font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand-400 focus:ring-offset-1 ${
          showLabel ? "px-2.5" : "w-8"
        } ${
          pressed
            ? "border-brand-200 bg-brand-50 text-brand-700"
            : "border-transparent bg-slate-100 text-text-secondary hover:bg-slate-200 hover:text-text-primary"
        } disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-text-muted`}
      >
        {icon}
        {showLabel && <span className="whitespace-nowrap">{activeLabel}</span>}
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

// 이슈가 있을 때만 뜨는 한 줄 알림(2026-08-14 "안내 문구가 너무 많다"). 정상
// 상태를 설명하는 상시 배너는 이 화면에서 전부 걷어냈고, 남은 것은 사용자가
// 실제로 무언가를 해야 하거나 기능이 제한된 경우뿐이다. 긴 사유·복구 안내·
// 조치 버튼은 지우지 않고 `detail`에 넣어 접어 둔다 — 정보는 사라지지 않고
// 접힌다(CLAUDE.md: Runtime 장애 시 복구 안내 제공).
type NoticeTone = "danger" | "warning" | "info";

const NOTICE_TONE: Record<NoticeTone, string> = {
  danger: "border-danger/30 bg-danger/5 text-danger",
  warning: "border-warning/30 bg-warning/5 text-warning",
  info: "border-border bg-slate-50 text-text-secondary",
};

function Notice({ tone, title, detail }: { tone: NoticeTone; title: string; detail?: ReactNode }) {
  const icon = tone === "info" ? <Info size={13} className="shrink-0" /> : <AlertTriangle size={13} className="shrink-0" />;
  if (!detail) {
    return (
      <div
        role="status"
        className={`mb-2 flex shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-caption ${NOTICE_TONE[tone]}`}
      >
        {icon}
        <span className="min-w-0 flex-1">{title}</span>
      </div>
    );
  }
  return (
    <details className={`mb-2 shrink-0 rounded-lg border text-caption ${NOTICE_TONE[tone]}`}>
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 font-medium">
        {icon}
        <span className="min-w-0 flex-1">{title}</span>
        <span className="shrink-0 text-[11px] font-normal opacity-70">자세히</span>
      </summary>
      <div className="border-t border-border/60 px-3 py-2.5">{detail}</div>
    </details>
  );
}

// 대화 턴의 보조 동작(복사/다시 실행/상세) — 평소에는 보이지 않다가 턴에
// 마우스를 올리거나 키보드 포커스가 들어올 때만 나타난다.
function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-slate-100 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

// D-079 이어 붙이기 — 검색 대상에서 제외된 Knowledge 한 건: 이름/버전, 제외
// 사유(항상 한국어), 그리고 그 자리에서 바로 다시 시도할 수 있는 활성화
// 버튼. 진행 중/성공/실패를 이 컴포넌트 하나로 함께 보여준다.
//
// `reason`이 `null`인 것은 사유가 없다는 뜻이 아니라, 감싸는 패널이 이미
// 모든 제외 자산이 공유하는 그 사유를 상단에 한 번 적었다는 뜻이다
// (`groupExcludedKnowledgeByReason` 참고) — 이 행은 그때 이름/버전과
// 활성화 버튼만 보여준다. `resolveExcludedRowText`가 방금 누른 재시도
// 결과(`feedback`)가 표시 중인 사유와 글자 그대로 같은 경우도 걸러내
// 같은 문단이 두 번 찍히지 않게 한다(반복 정보-무손실 규칙: 사유 자체는
// 어디에도 사라지지 않고, 위치와 중복만 정리된다).
function ExcludedKnowledgeRow({
  asset,
  reason,
  busy,
  feedback,
  onActivate,
}: {
  asset: InstalledAssetWithStatus;
  reason: string | null;
  busy: boolean;
  feedback: { ok: boolean; message: string } | null;
  onActivate: () => void;
}) {
  const { reasonText, feedbackText } = resolveExcludedRowText(reason, feedback);
  return (
    <li className="rounded-lg border border-border bg-white px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-caption font-semibold text-text-primary">
            {asset.name} v{asset.version}
          </p>
          {reasonText && <p className="text-caption text-text-secondary">{reasonText}</p>}
          {feedbackText && (
            <p className={`mt-1 text-caption ${feedback?.ok ? "text-success" : "text-danger"}`}>{feedbackText}</p>
          )}
        </div>
        <Button variant="secondary" size="sm" onClick={onActivate} disabled={busy} className="shrink-0">
          {busy ? "활성화하는 중..." : "활성화"}
        </Button>
      </div>
    </li>
  );
}

// D06 KNOWLEDGE_ROUTE(agentic Knowledge 선택) 결과 — `describeKnowledgeRoute`
// (chatTypes.ts)가 세 `status`를 이미 정직하게 구분해 둔 것을 그대로
// 그린다. `"ran"`만 선택/제외 목록을 보여준다 — `"skipped"`/`"fallback"`은
// 목록 없이 한 줄 요약(+공유 사유)만 보여줘, 선택이 실제로 일어난 것처럼
// 보이지 않게 한다(요구사항).
function KnowledgeRoutePanel({ route }: { route: KnowledgeRouteDisplay }) {
  return (
    <div className="max-w-full rounded-lg border border-border bg-slate-50 px-3 py-2 text-[11px] text-text-secondary">
      <p
        className={`flex items-start gap-1.5 font-medium ${route.status === "fallback" ? "text-warning" : "text-text-primary"}`}
      >
        <ListChecks size={12} className="mt-0.5 shrink-0" />
        {route.headline}
      </p>
      {route.status !== "ran" && route.sharedSelectedReason && (
        <p className="mt-1 pl-[18px]">{route.sharedSelectedReason}</p>
      )}
      {route.status === "ran" && (
        <div className="mt-1 space-y-1.5 pl-[18px]">
          {route.sharedSelectedReason && <p>{route.sharedSelectedReason}</p>}
          <ul className="space-y-0.5">
            {route.selected.map((s) => (
              <li key={s.knowledgeId}>
                · {s.name}
                {s.reason ? ` — ${s.reason}` : ""}
              </li>
            ))}
          </ul>
          {route.excluded.length > 0 && (
            <>
              <p className="font-medium text-text-primary">제외된 지식 자산 {route.excluded.length}개</p>
              {route.sharedExcludedReason && <p>{route.sharedExcludedReason}</p>}
              <ul className="space-y-0.5">
                {route.excluded.map((e) => (
                  <li key={e.knowledgeId}>
                    · {e.name}
                    {e.reason ? ` — ${e.reason}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// D06 TOOL_ROUTE(D-083, agentic MCP Tool 선택) 결과 — `describeToolRouteSelected`/
// `describeToolRouteRejected`(chatTypes.ts)가 이미 정직하게 구분해 둔
// status를 그대로 그린다. `"no_tool"`은 오류처럼 보이지 않도록 중립 색으로,
// `"rejected"`만 경고 색으로 표시한다(제안이 있었지만 실행 전에 막혔다는
// 사실은 눈에 띄어야 한다 — "아무 일도 없었다"와 같아 보이면 안 된다).
function ToolRoutePanel({ route }: { route: ToolRouteDisplay }) {
  return (
    <div
      className={`max-w-full rounded-lg border px-3 py-2 text-[11px] ${
        route.status === "rejected"
          ? "border-warning/40 bg-warning/5 text-warning"
          : "border-border bg-slate-50 text-text-secondary"
      }`}
    >
      <p className="flex items-start gap-1.5 font-medium">
        <Wrench size={12} className="mt-0.5 shrink-0" />
        {route.headline}
      </p>
    </div>
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
  const [installedMcpTools, setInstalledMcpTools] = useState<InstalledAssetWithStatus[]>([]);
  const [installedError, setInstalledError] = useState<string | null>(null);
  // --- D-034 해석 경로 4 — 등록된 Local Agent Package. "설치됨"이 아니라
  // "등록됨"(localAgentRegistration?.state === "ACTIVE")만 대화에서 고를 수
  // 있게 한다 — Knowledge/MCP Tool과 동일한 "설치됨 ≠ 쓸 수 있음" 원칙.
  const [installedAgents, setInstalledAgents] = useState<InstalledAssetWithStatus[]>([]);
  // 이 배포가 allow-root(AGENT_RUNTIME_LOCAL_AGENT_ROOTS)를 아예 설정하지
  // 않았는지 — Task Brief 제약 B: Desktop이 스스로 고칠 수 없는 배포 정책
  // 상태이므로 "안 보임"으로 조용히 넘어가지 않고 왜, 무엇이 필요한지 보여준다.
  const [localAgentsEnabled, setLocalAgentsEnabled] = useState<boolean | null>(null);
  const [localAgentReconcileNotice, setLocalAgentReconcileNotice] = useState<string | null>(null);
  // Task Brief 제약 B — 관리자가 AGENT_RUNTIME_LOCAL_AGENT_ROOTS에 그대로
  // 복사해 넣을 수 있도록 이 PC의 실제 설치 경로를 보여준다.
  const [installRootPath, setInstallRootPath] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    bridge.getInstallRootPath().then(setInstallRootPath).catch(() => setInstallRootPath(null));
  }, [bridge]);
  // 빈 문자열 = 표준 Agent(기본, D06 불변) — 사용자가 명시적으로 고를 때만
  // 채워진다.
  const [selectedLocalAgentId, setSelectedLocalAgentId] = useState("");
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
      setInstalledMcpTools(all.filter((a) => a.assetType === "mcp_tool" && a.status !== "INACTIVE"));
      // D-034 해석 경로 4 이어 붙이기 — Knowledge와 같은 이유로 재확인
      // 후 목록을 반영한다: agent-runtime이 다른 AGENT_RUNTIME_LOCAL_AGENT_ROOTS로
      // 재시작되었거나 등록 레지스트리가 초기화되면 로컬만 "거짓 ACTIVE"로
      // 남을 수 있다. 이 호출 자체가 실패/부재해도(오래된 preload.js) 절대
      // throw하지 않는다 — 화면 전체를 무너뜨리지 않는다(2026-08-13 실제
      // 장애와 같은 위험, `resolveReconcileNotice`가 Knowledge 쪽에서 이미
      // 지키는 규칙을 여기서도 그대로 지킨다).
      try {
        const reconciled = await bridge.reconcileLocalAgentRegistrations();
        setLocalAgentReconcileNotice(reconciled.checked ? null : reconciled.error);
        setLocalAgentsEnabled(reconciled.localAgentsEnabled);
      } catch (err) {
        setLocalAgentReconcileNotice(
          err instanceof Error ? err.message : "agent-runtime에 연결할 수 없어 Local Agent 등록 상태를 확인하지 못했습니다.",
        );
        setLocalAgentsEnabled(null);
      }
      setInstalledAgents(all.filter((a) => a.assetType === "agent" && a.status !== "INACTIVE"));
    } catch (err) {
      setInstalledError(err instanceof Error ? err.message : "설치된 Knowledge 목록을 불러오지 못했습니다.");
      setInstalledKnowledge([]);
      setInstalledMcpTools([]);
      setInstalledAgents([]);
    }
  }, [bridge]);

  // 선택했던 Local Agent가 목록에서 사라지면(등록 해제/재확인으로 다운그레이드)
  // 선택을 표준 Agent로 되돌린다 — 사라진 선택이 그대로 남아 있으면 다음
  // 전송에서 서버가 LOCAL_AGENT_NOT_REGISTERED로 거절하기 전까지 사용자는
  // 아무것도 눈치채지 못한다.
  useEffect(() => {
    if (selectedLocalAgentId && !installedAgents.some((a) => a.assetId === selectedLocalAgentId && a.localAgentRegistration?.state === "ACTIVE")) {
      setSelectedLocalAgentId("");
    }
  }, [installedAgents, selectedLocalAgentId]);

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
  // 검색에 실제로 활성화된(activation.state === "ACTIVE" 또는
  // "ALREADY_ACTIVE" — 후자는 search-runtime의 중앙 색인에 이미 있어 로컬
  // 등록 없이도 검색되는 경우다) 것만 Stage 1 로컬 검색 대상으로 쓴다. 이전
  // 형식 Bundle(D-060)과 활성화되지 않은/실패한 Knowledge는 사유와 함께
  // `knowledgePartition.excluded`에 남는다.
  const knowledgePartition = bridge
    ? partitionInstalledKnowledgeByActivation(installedKnowledge ?? [])
    : { usable: [], excluded: [] as ExcludedKnowledge<InstalledAssetWithStatus>[] };
  // 반복 설명 정리(2026-08-14) — 제외된 자산이 전부 같은 사유(전형적으로
  // search-runtime 장애 같은 환경적 원인)를 공유하면 그 문장을 패널
  // 상단에서 한 번만 보여주고, 각 행은 이름/버전과 활성화 버튼만 갖는다.
  // 사유가 자산마다 다르면 `sharedReason`은 null이고 각 행이 그대로 자기
  // 사유를 보여준다 — 어느 쪽이든 어떤 자산이 왜 제외됐는지는 여전히 전부
  // 확인 가능하다(숨기는 게 아니라 위치를 정리하는 것).
  const groupedExclusion = groupExcludedKnowledgeByReason(knowledgePartition.excluded);
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

  // KNOWLEDGE_ROUTE 후보(agentic Knowledge 선택) — 검색 가능(usable)한
  // Knowledge마다 manifest.json을 읽어 이름/설명/태그/분류를 채운 후보
  // 목록을 미리 준비해 둔다(전송 시점에 매번 IPC 왕복하지 않도록). 설치된
  // Knowledge 목록이 바뀔 때(설치/제거/활성화)마다 다시 만든다. 실패해도
  // (bridge 없음, IPC 오류) 조용히 빈 배열로 남는다 — `handleSend`가 그 경우
  // 기존 `knowledgeIds` fan-out으로 그대로 대체한다(agent-runtime이
  // `knowledge_candidates`/`knowledge_ids` 어느 쪽을 받아도 검색 자체는
  // 항상 동작해야 한다 — CLAUDE.md: Runtime 장애 시 종료되지 않는다).
  const [knowledgeCandidates, setKnowledgeCandidates] = useState<KnowledgeCandidate[]>([]);
  const [knowledgeCandidatesError, setKnowledgeCandidatesError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) {
      setKnowledgeCandidates([]);
      setKnowledgeCandidatesError(null);
      return;
    }
    const usableAssets = partitionInstalledKnowledgeByActivation(installedKnowledge ?? []).usable.map((u) => u.asset);
    if (usableAssets.length === 0) {
      setKnowledgeCandidates([]);
      setKnowledgeCandidatesError(null);
      return;
    }
    let cancelled = false;
    bridge
      .getKnowledgeCandidates(usableAssets)
      .then((candidates) => {
        if (cancelled) return;
        setKnowledgeCandidates(candidates);
        setKnowledgeCandidatesError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        // 자동 선택을 못 쓰게 될 뿐(handleSend가 knowledge_ids fan-out으로
        // 대체한다) — 화면을 막지 않고 무슨 일이 있었는지만 조용히 알린다
        // (CLAUDE.md: 오류를 조용히 삼키지 않는다 — `if (!res.ok) return;` 금지).
        setKnowledgeCandidates([]);
        setKnowledgeCandidatesError(
          err instanceof Error ? err.message : "지식 자산 후보 정보를 불러오지 못해 자동 선택 없이 전체를 검색합니다.",
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, installedKnowledge]);

  const knowledgeCandidateNameById: Record<string, string> = Object.fromEntries(
    knowledgeCandidates.map((c) => [c.knowledge_id, c.name ?? c.knowledge_id]),
  );

  // --- MCP Tool 호출 확인. 브라우저 Preview에서는 기존 개발용 DB Tool을,
  // Electron에서는 Hub에서 설치되고 agent-runtime에 연결된 고정 계산기
  // 샘플만 노출한다. 임의 Tool 이름이나 자유형 JSON 입력을 받지 않는다.
  const [mcpDevEnabled, setMcpDevEnabled] = useState(false);
  const [mcpDevTool, setMcpDevTool] = useState<"calculator.add" | "table_count.query" | "db_metadata.get_columns">(
    "table_count.query",
  );
  const [mcpDevSchema, setMcpDevSchema] = useState("APP");
  const [mcpDevTable, setMcpDevTable] = useState("INTERFACE_LOG");
  const [calculatorA, setCalculatorA] = useState("1");
  const [calculatorB, setCalculatorB] = useState("2");
  const calculatorSampleConnected = installedMcpTools.some(
    (asset) =>
      asset.assetId === CALCULATOR_SAMPLE_ASSET_ID &&
      (asset.activation?.state === "ACTIVE" || asset.activation?.state === "ALREADY_ACTIVE"),
  );
  const mcpDevActive = mcpDevEnabled && (!bridge || calculatorSampleConnected);
  // D-080/D-084 혼동 정정 — "설치됨"과 "연결됨"을 구분해 렌치 토글 설명과
  // 로컬 Tool 빈 상태에 보여준다(chatTypes.ts의 모듈 주석 참고). 자산 스토어
  // 목록을 다시 부르지 않는다 — 이미 위에서 불러온 `installedMcpTools`를
  // 그대로 요약한다.
  const mcpToolConnectionSummary = summarizeMcpToolConnections(installedMcpTools);

  // --- D-083 TOOL_ROUTE 동의 — 허브 조회 토글(allowHubLookup)과 같은 모양의
  // 동의: 기본 꺼짐, 세션 간 영속하지 않음, 매 Run마다 명시적으로 다시
  // 보낸다. 켜지면 이번 턴은 (1) `input.tool_route = true`를 보내고 (2)
  // agent-runtime의 `standard-agent`는 `capabilities.mcp_allowed = false`라
  // 라우팅이 아예 실행되지 않으므로(config/standard-agent/agent-manifest.json)
  // `agentProfile: "standard-db-agent"`도 함께 보낸다 — 개발 확인용 명시적
  // Tool 호출(mcpDevActive)과 동일하게 이 Profile을 쓰지만, 이쪽은 어떤
  // Tool을 부를지 사용자가 아니라 AI가 이번 질문에서 고른다는 차이가 있다.
  // 개발 확인용 입력이 이미 명시적 `mcp_tool_request`를 보내는 중이면(D-083
  // 서버 규칙: 명시적 요청이 항상 우선) 이 토글은 아무 효과가 없으므로
  // "적용 불가"로 끄고 비활성화한다(허브 토글의 `hubLookupApplicable`과
  // 동일한 패턴).
  const [toolRouteEnabled, setToolRouteEnabled] = useState(false);
  const toolRouteApplicable = !mcpDevActive;
  const toolRouteActive = toolRouteEnabled && toolRouteApplicable;
  useEffect(() => {
    if (!toolRouteApplicable && toolRouteEnabled) setToolRouteEnabled(false);
  }, [toolRouteApplicable, toolRouteEnabled]);

  // --- D-034 해석 경로 4 — 등록된 Local Agent 선택. 개발 확인용 명시적 Tool
  // 호출(mcpDevActive)·TOOL_ROUTE 동의(toolRouteActive)는 둘 다
  // `agent_profile: "standard-db-agent"`를 명시적으로 보내는 경로다 —
  // `local_agent_id`가 있으면 서버가 `agent_profile`을 아예 읽지 않으므로
  // (agentRuntime.ts 주석) 셋을 동시에 켜면 사용자가 고른 것 중 무엇이
  // 실제로 적용됐는지 헷갈린다. 서로 배타적으로 둔다(CLAUDE.md: 호환되지
  // 않는 선택지는 이유와 함께 비활성화한다).
  // "설치됨"(installedAgents 전체)과 "등록됨/고를 수 있음"(registeredLocalAgents)은
  // 서로 다른 사실이다 — 아래 UI가 설치되어 있으나 등록 안 된 개수와 등록된
  // 목록을 각각 다른 자리에서 보여준다(Knowledge/MCP Tool과 동일한 원칙).
  const registeredLocalAgents = installedAgents.filter((a) => a.localAgentRegistration?.state === "ACTIVE");
  const selectedLocalAgent = registeredLocalAgents.find((a) => a.assetId === selectedLocalAgentId) ?? null;
  const localAgentActive = !!selectedLocalAgent;
  const localAgentSelectionDisabledReason =
    mcpDevActive || toolRouteActive
      ? "개발 확인용 Tool 호출/TOOL_ROUTE 동의가 켜져 있는 동안은 Local Agent를 선택할 수 없습니다 — 먼저 끄세요."
      : null;
  useEffect(() => {
    if (localAgentSelectionDisabledReason && selectedLocalAgentId) setSelectedLocalAgentId("");
  }, [localAgentSelectionDisabledReason, selectedLocalAgentId]);

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
        runtimeBaseUrl: getAgentRuntimeBaseUrl(),
      };
      if (settingsBridge) {
        try {
          const settings = await settingsBridge.getDesktopSettings();
          // 저장된 agent-runtime 주소를 실제 대화 호출에도 적용한 뒤 그 값
          // 그대로 검사한다(D-080 후속). 적용과 검사가 갈라지면 예전처럼
          // "대화는 되는데 연결 끊김" 오탐이 다시 생긴다 — 그래서 검사 대상은
          // 별도 변수가 아니라 `setAgentRuntimeBaseUrl`의 반환값이다.
          endpoints = {
            ...endpoints,
            runtimeBaseUrl: setAgentRuntimeBaseUrl(settings.agentRuntimeBaseUrl),
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
  const [agentDraftDialogOpen, setAgentDraftDialogOpen] = useState(false);
  // Tool 확인 Panel 처리 중(승인/거부 요청 In-flight) 및 그 요청 자체의 오류
  // — 메시지별로 추적해 두 개 이상의 Run이 동시에 대기 중이어도 서로
  // 간섭하지 않는다.
  const [confirmingMessageId, setConfirmingMessageId] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<Record<string, string>>({});

  // D-084 후속 — 대화창에 표시되는 로컬 Tool 실행 기록. agent-runtime으로
  // 보내지 않고(위 import 주석 참고) 이 화면의 로컬 상태로만 존재하며,
  // `messages`와 시간순으로 섞어 그린다(아래 `transcriptItems`).
  const [localToolEntries, setLocalToolEntries] = useState<LocalToolChatEntry[]>([]);
  function handleLocalToolEntryStart(entry: LocalToolChatEntry): void {
    setLocalToolEntries((prev) => [...prev, entry]);
  }
  function handleLocalToolEntryFinish(
    id: string,
    completedAt: string,
    outcome: LocalToolChatEntry["outcome"],
  ): void {
    setLocalToolEntries((prev) => prev.map((e) => (e.id === id ? { ...e, completedAt, outcome } : e)));
  }

  // D-084 후속 2 — 채팅 질문으로 로컬 Tool을 자동 선택/실행하는 기능
  // (사용자 실사용 피드백, 의도적 예외로 두 번 재확인받음). 기본 꺼짐,
  // 세션 간 영속하지 않음(허브 조회 토글·TOOL_ROUTE 동의 토글과 같은 모양,
  // `useState`로만 유지) — 등록된 로컬 Tool이 하나도 없으면 이 토글 자체를
  // 그리지 않는다(렌더 부분, 아래 §입력창). 개발 확인용 명시적 Tool
  // 호출/TOOL_ROUTE 동의/Local Agent 선택과는 서로 배타적으로 둔다 — 넷이
  // 동시에 켜지면 이번 턴에 무엇이 실제로 적용됐는지 사용자가 알 수 없다
  // (CLAUDE.md: 호환되지 않는 선택지는 이유와 함께 비활성화한다).
  const [registeredLocalTools, setRegisteredLocalTools] = useState<LocalTool[]>([]);
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .listLocalTools()
      .then((tools) => {
        if (!cancelled) setRegisteredLocalTools(tools);
      })
      .catch(() => {
        // 목록 조회 실패는 이 토글을 그냥 숨긴다(applicable=false) — 이미
        // "로컬 Tool" 버튼을 통한 수동 경로가 자체 오류 상태를 보여준다.
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);
  const [localToolRouteEnabled, setLocalToolRouteEnabled] = useState(false);
  const localToolRouteApplicable =
    !!bridge && registeredLocalTools.length > 0 && !mcpDevActive && !toolRouteActive && !localAgentActive;
  const localToolRouteActive = localToolRouteEnabled && localToolRouteApplicable;
  useEffect(() => {
    if (!localToolRouteApplicable && localToolRouteEnabled) setLocalToolRouteEnabled(false);
  }, [localToolRouteApplicable, localToolRouteEnabled]);

  // D-084 후속 2 — 대화창에 표시되는 자동 라우팅 기록. `localToolEntries`
  // (수동 실행)와 별개 배열이다 — 카드 모양이 다르고(Sparkles 아이콘, "AI
  // 자동 선택" 배지), 어떤 Tool도 정해지지 않은 채 끝나는 경우가 있어
  // `LocalToolChatEntry`의 필수 필드(functionName/filePath)를 채울 수 없기
  // 때문이다.
  const [localToolRouteEntries, setLocalToolRouteEntries] = useState<LocalToolAutoRouteEntry[]>([]);

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
          case "knowledge.route.selected": {
            // KNOWLEDGE_ROUTE(agentic Knowledge 선택) 결과 — 이 턴이 실제로
            // 보낸 후보의 id->이름 맵(`next.knowledgeCandidateNameById`,
            // 전송 시점 스냅샷)으로 사람이 읽을 이름을 붙인다. 세 status를
            // 절대 섞어 말하지 않는다(describeKnowledgeRoute 참고).
            const data = item.data as KnowledgeRouteEventData | null;
            if (data) {
              next = { ...next, knowledgeRoute: describeKnowledgeRoute(data, next.knowledgeCandidateNameById) };
            }
            break;
          }
          case "mcp.tool_route.selected": {
            // D-083 TOOL_ROUTE 결과 — 이 턴이 실제로 `tool_route: true`를
            // 보냈을 때만 발생한다. ran/skipped/no_tool을 절대 섞어 말하지
            // 않는다(describeToolRouteSelected 참고) — "no_tool"은 오류가
            // 아니라 설계된 정상 결과다.
            const data = item.data as ToolRouteSelectedEventData | null;
            if (data) {
              next = { ...next, toolRoute: describeToolRouteSelected(data) };
            }
            break;
          }
          case "mcp.tool_route.rejected": {
            // "ran"으로 제안된 Tool 호출이 스키마 검증에서 거절된 드문 경우
            // — 위에서 채워진 toolRoute("ran")를 이 결과로 대체한다. "아무
            // 일도 없었다"(no_tool)와 "제안됐지만 막혔다"(rejected)가 절대
            // 같아 보이면 안 된다(요구사항).
            const data = item.data as ToolRouteRejectedEventData | null;
            if (data) {
              next = { ...next, toolRoute: describeToolRouteRejected(data) };
            }
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

  // D-084 후속 2 — 로컬 Tool 자동 라우팅 한 턴을 처리한다. 이 함수는
  // `startRun`/agent-runtime을 절대 호출하지 않고 여기서 완결된다 —
  // 실제로 무엇을 하는지(로컬 Ollama에 한 번 묻고, 승인 후 실행)는
  // `runLocalToolAutoRoute`(LocalToolInvokePanel.tsx)에 있다. 이 함수는
  // 상태 갱신(전송 중 표시, 목록에 항목 추가/갱신)만 담당한다.
  async function handleLocalToolAutoRoute(q: string): Promise<void> {
    if (!bridge) return;
    setSendError(null);
    setQuestion("");
    setIsRunning(true);
    try {
      const settings = settingsBridge ? await settingsBridge.getDesktopSettings().catch(() => null) : null;
      await runLocalToolAutoRoute({
        bridge,
        question: q,
        ollamaBaseUrl: settings?.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL,
        preferredModel: settings?.chatModelAlias ?? DEFAULT_CHAT_MODEL_ALIAS,
        onStart: (entry) => setLocalToolRouteEntries((prev) => [...prev, entry]),
        onFinish: (entryId, completedAt, toolName, args, display) =>
          setLocalToolRouteEntries((prev) =>
            prev.map((e) => (e.id === entryId ? { ...e, completedAt, toolName, args, display } : e)),
          ),
      });
    } finally {
      setIsRunning(false);
    }
  }

  async function handleSend(text?: string) {
    const q = (text ?? question).trim();
    if (!q || isRunning) return;

    // D-084 후속 2 — 이 토글이 켜져 있으면 이번 턴은 완전히 다른 경로다:
    // agent-runtime을 전혀 거치지 않고 Desktop이 로컬 Ollama에 직접(한 번만)
    // 물어 로컬 Tool을 자동으로 고르고 실행한다(위 브리프 제약 A). 아래
    // agent-runtime Run 생성 Payload와는 물리적으로 분리된 함수에서 끝난다
    // — `electron/__tests__/local-tool-isolation.test.ts`의 "the local-tool
    // auto-route branch in handleSend returns before reaching startRun's
    // payload" 검사가 이 return을 직접 고정한다.
    if (localToolRouteActive) {
      await handleLocalToolAutoRoute(q);
      return;
    }

    if (
      bridge &&
      mcpDevActive &&
      (!calculatorA.trim() ||
        !calculatorB.trim() ||
        !Number.isFinite(Number(calculatorA)) ||
        !Number.isFinite(Number(calculatorB)))
    ) {
      setSendError("더할 두 숫자를 모두 올바르게 입력하세요.");
      return;
    }

    setSendError(null);
    setQuestion("");
    const id = crypto.randomUUID();
    // D-083: toolRouteActive는 명시적 Tool 요청 없이도(agentRuntime.ts에
    // `mcpTool`을 전혀 넘기지 않는다) agent-runtime을 거쳐야 한다 — Ollama
    // 직통 경로로 새면 TOOL_ROUTE 자체가 실행되지 않는다. D-034 해석 경로
    // 4(localAgentActive) 역시 agent-runtime을 거쳐야만 그 Agent+Prompt
    // 짝이 적용된다 — Ollama 직통 경로로 새면 표준 Agent와 구분되지 않는다.
    const ollamaOnly = !knowledgeLookupActive && !mcpDevActive && !toolRouteActive && !localAgentActive;
    const serviceId = ollamaOnly
      ? `${SERVICE_ID_PREFIX}:ollama-default`
      : `${SERVICE_ID_PREFIX}:${knowledgeId || "mcp-dev-trigger"}`;
    // standard-agent는 capabilities.mcp_allowed=false라 TOOL_ROUTE가 아예
    // 실행되지 않는다(config/standard-agent/agent-manifest.json) — toolRouteActive도
    // mcpDevActive와 같은 이유로 standard-db-agent가 필요하다. localAgentActive일
    // 때는 이 필드가 서버에서 아예 읽히지 않으므로(agentRuntime.ts 주석) 값
    // 자체는 의미가 없다 — ChatMessage 타입이 두 값만 허용해 placeholder로
    // "standard-agent"를 둔다(화면에는 이 필드를 직접 표시하지 않는다,
    // localAgentLabelUsed가 실제 표시를 담당).
    const agentProfile: ChatMessage["agentProfile"] =
      mcpDevActive || toolRouteActive ? "standard-db-agent" : "standard-agent";
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
      localAgentIdUsed: selectedLocalAgent?.assetId ?? null,
      localAgentLabelUsed: selectedLocalAgent?.name ?? null,
      ollamaOnly,
      status: "running",
      answer: "",
      citations: [],
      // KNOWLEDGE_ROUTE(agentic Knowledge 선택) 단계는 이번 턴이 실제로
      // `knowledge_candidates`를 보낼 때만 존재한다 — 무엇을 보낼지는
      // 여기서 이미 결정되어 있다(startRun 호출 시 그대로 재사용하는 같은
      // `knowledgeCandidates` 값, agentRuntime.ts).
      stages: ollamaOnly
        ? ollamaChatStages("running")
        : initialStages({ routingExpected: knowledgeCandidates.length > 0 }),
      eventLog: [],
      pendingConfirmation: null,
      runId: null,
      traceId: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      serverRun: null,
      hubQueriesSent: [],
      // KNOWLEDGE_ROUTE — 이번 턴에 실제로 보낼 후보의 id->이름 맵을 그대로
      // 캡처해 둔다(화면 상태가 그 사이 바뀌어도 SSE 이벤트가 도착했을 때
      // 엉뚱한 스냅샷을 참조하지 않도록, `knowledgeIdUsed`와 같은 이유).
      knowledgeCandidateNameById,
      knowledgeRoute: null,
      toolRoute: null,
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
        // KNOWLEDGE_ROUTE(agentic Knowledge 선택) — 비어 있으면 `startRun`이
        // 기존 `knowledgeIds` fan-out을 그대로 보낸다(agentRuntime.ts 참고,
        // 절대 둘 다 보내지 않는다).
        knowledgeCandidates,
        question: q,
        allowHubLookup,
        ...(history.length > 0 ? { history } : {}),
        // D-034 해석 경로 4 — 명시적으로 선택했을 때만 보낸다(기본은 항상
        // 표준 Agent, Task Brief 제약 D). localAgentActive는 위에서 이미
        // mcpDevActive/toolRouteActive와 배타적으로 유지된다(선택 시 두
        // 토글이 자동으로 꺼진다) — 셋이 동시에 보내지는 경로는 없다.
        ...(localAgentActive && selectedLocalAgent
          ? { localAgentId: selectedLocalAgent.assetId }
          : mcpDevActive
            ? {
                agentProfile: "standard-db-agent" as const,
                mcpTool: bridge ? "calculator.add" : mcpDevTool,
                mcpToolInput: bridge
                  ? { a: Number(calculatorA), b: Number(calculatorB) }
                  : { schema: mcpDevSchema.trim(), table: mcpDevTable.trim() },
                mcpConfirmed: false,
              }
            : toolRouteActive
              ? // D-083: 명시적 mcpTool은 절대 함께 보내지 않는다 — 무엇을 부를지
                // 사용자가 아니라 TOOL_ROUTE가 이번 질문에서 고르게 한다.
                { agentProfile: "standard-db-agent" as const, toolRoute: true }
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

  // "대화로 Agent 초안 만들기" 진입점 — 저장된 지난 대화를 복원해 보는 중인
  // 메시지(restored===true)는 citations/toolRoute/stages가 애초에 저장되지
  // 않은 값이라 근거로 쓸 수 없다(agent-draft.ts 문서 참고). 라이브 메시지가
  // 하나도 없으면 버튼을 비활성화하고 이유를 title/aria-label로 보여준다.
  const hasLiveMessagesForAgentDraft = messages.some((m) => m.restored !== true);

  const detailMessage = messages.find((m) => m.id === detailMessageId) ?? null;

  // 대화 필수 서비스 장애와 MCP 선택 기능 장애를 분리한다. 어떤 서비스가
  // 필수인지에 대한 지식은 connections.ts의 순수 헬퍼 한 곳에만 둔다.
  const connectionAssessment = assessChatConnections(
    connections ?? [],
    knowledgeLookupActive || mcpDevActive ? "knowledge" : "ollama",
  );
  const { blockingFailures, featureFailures } = connectionAssessment;

  // 연결 상태를 문장으로 설명하는 대신 점 하나로 보여주고, 어떤 서비스가 어떤
  // 상태인지는 hover(title)로 남긴다 — 이슈가 있을 때만 아래 Notice가 뜬다.
  const connectionTooltip = (connections ?? []).map((c) => `${c.label}: ${c.ok ? "정상" : "오류"}`).join(" · ");

  return (
    <div className="flex h-full flex-col">
      {/* 슬림 헤더 — 정상일 때는 상태 점 하나만 남긴다. 무엇을 근거로 답하는지
          (모델/지식)는 입력창의 토글이 그대로 보여주므로 여기서 다시 적지
          않는다. Service/버전/연결 상세는 자산 허브 > 설치된 자산(D03 상세)과
          설정 > 연결 상태에 있다. */}
      <div className="mb-2 flex shrink-0 items-center justify-between gap-2 px-1">
        <h1 className="text-card-title font-semibold text-text-primary">채팅</h1>
        <div className="flex items-center gap-1">
          {connections === null ? (
            <span
              role="status"
              aria-label="연결 확인 중"
              title="연결 확인 중..."
              className="h-2 w-2 animate-pulse rounded-full bg-slate-300"
            />
          ) : connectionAssessment.state === "healthy" ? (
            <span
              role="status"
              aria-label="연결 정상"
              title={`연결 정상 · ${connectionTooltip}`}
              className="h-2 w-2 rounded-full bg-success"
            />
          ) : (
            <span
              role="status"
              title={connectionTooltip}
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                connectionAssessment.state === "limited" ? "bg-warning/10 text-warning" : "bg-danger/10 text-danger"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  connectionAssessment.state === "limited" ? "bg-warning" : "bg-danger"
                }`}
              />
              {connectionAssessment.state === "limited" ? "일부 기능 제한" : "대화 연결 문제"}
            </span>
          )}
          <IconAction label="연결 상태 다시 확인" onClick={() => void refreshConnections()} disabled={connectionsChecking}>
            <RefreshCw size={13} className={connectionsChecking ? "animate-spin" : ""} />
          </IconAction>
          <IconAction
            label={
              hasLiveMessagesForAgentDraft
                ? "대화로 Agent 초안 만들기"
                : "이 세션에서 실제로 실행된 턴이 아직 없습니다"
            }
            onClick={() => setAgentDraftDialogOpen(true)}
            disabled={!hasLiveMessagesForAgentDraft}
          >
            <Sparkles size={13} />
          </IconAction>
        </div>
      </div>

      {/* 연결 장애 복구 안내(CLAUDE.md 필수) — 대화가 실제로 막힐 수 있는
          상황이므로 한 줄 알림으로 항상 보여주고, 서비스별 사유와 복구 방법은
          펼쳤을 때 그대로 나온다. */}
      {blockingFailures.length > 0 && (
        <Notice
          tone="danger"
          title={`${blockingFailures.map((c) => c.label).join(", ")} 연결이 끊어져 대화가 제한될 수 있습니다.`}
          detail={
            <>
              <ul className="space-y-0.5">
                {blockingFailures.map((c) => (
                  <li key={c.id}>
                    {c.label}: {c.detail}
                    {c.recoveryHint ? ` — ${c.recoveryHint}` : ""}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-text-secondary">설정 &gt; 연결 상태에서 자세히 확인할 수 있습니다.</p>
            </>
          }
        />
      )}

      {featureFailures.length > 0 && (
        <Notice
          tone="warning"
          title="Knowledge·Tool 일부 기능이 제한됩니다 (Ollama 대화는 정상)."
          detail={
            <>
              <ul className="space-y-0.5">
                {featureFailures.map((c) => (
                  <li key={c.id}>
                    {c.label}: {c.detail}
                    {c.recoveryHint ? ` — ${c.recoveryHint}` : ""}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-text-secondary">설정 &gt; 연결 상태에서 자세히 확인할 수 있습니다.</p>
            </>
          }
        />
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
                  // 삭제 버튼은 행 위에 겹쳐 놓는다(2026-08-14). 예전에는
                  // 옆 칸을 항상 차지한 채 `opacity-0`으로 숨어 있어서, 목록
                  // 오른쪽에 늘 빈 공간이 남았다. `group-focus-within`은
                  // 유지한다 — hover 전용으로 바꾸면 키보드만 쓰는 사용자는
                  // 대화를 삭제할 방법이 사라진다.
                  <div key={c.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => void handleSelectConversation(c.id)}
                      disabled={isRunning}
                      className={`w-full rounded-lg border px-3 py-2 text-left text-caption transition-colors ${
                        currentConversationId === c.id
                          ? "border-brand-500 bg-brand-50 text-brand-700"
                          : "border-border bg-white text-text-secondary hover:bg-slate-50"
                      }`}
                    >
                      {/* 겹쳐 놓은 버튼이 긴 제목을 가리지 않도록, 버튼이
                          보이는 동안에만 오른쪽 여백을 준다. */}
                      <span className="block truncate pr-0 font-medium transition-[padding] group-hover:pr-8 group-focus-within:pr-8">
                        {c.title}
                      </span>
                      <span className="block truncate text-[11px] text-text-muted transition-[padding] group-hover:pr-8 group-focus-within:pr-8">
                        {c.knowledgeLabel} · 턴 {c.turnCount}개 · {formatDateTime(c.updatedAt)}
                      </span>
                    </button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => requestDeleteConversation(c)}
                      title="이 대화 삭제"
                      aria-label={`'${c.title}' 대화 삭제`}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 px-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
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
              인지): "설치됨"과 "활성화됨"은 서로 다른 사실이다. 정상일 때(활성
              1개 이상 + 제외 없음)는 물론이고, Knowledge를 아직 하나도 설치하지
              않은 상태·불러오는 중처럼 사용자가 할 일이 없는 상태도 이제 아무
              배너를 띄우지 않는다(2026-08-14 "안내 문구가 너무 많다"). 그
              상태들은 입력창의 Knowledge 토글(비활성 + 사유 툴팁)과 빈 대화
              화면이 이미 말해 준다. 사용자가 실제로 조치해야 하는 경우 —
              불러오기 실패, 활성화된 게 하나도 없음, 일부 제외됨, 확인 불가 —
              만 한 줄 알림으로 남기고 사유·활성화 버튼은 펼침 안에 그대로
              둔다. */}
          {bridge && installedError && <Notice tone="danger" title={installedError} />}
          {/* KNOWLEDGE_ROUTE 후보 조립 실패 — 자동 선택 자체를 못 쓰게 될 뿐
              (전체를 검색하는 기존 방식으로 대체된다), 대화 자체를 막지
              않는다. usable Knowledge가 있을 때만 의미 있는 알림이다. */}
          {bridge && knowledgeLookupActive && knowledgeCandidatesError && (
            <Notice tone="info" title={knowledgeCandidatesError} />
          )}
          {bridge && installedKnowledge !== null && installedKnowledge.length > 0 && knowledgePartition.usable.length === 0 && (
            <Notice
              tone="danger"
              title={`설치된 Knowledge ${installedKnowledge.length}개가 모두 비활성 상태입니다 — 지금은 Ollama 일반 대화만 가능합니다.`}
              detail={
                <>
                  {groupedExclusion.sharedReason && <p className="mb-2">{groupedExclusion.sharedReason}</p>}
                  <ul className="space-y-1.5">
                    {groupedExclusion.items.map(({ asset, reason }) => (
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
                </>
              }
            />
          )}
          {bridge && knowledgePartition.usable.length > 0 && knowledgePartition.excluded.length > 0 && (
            <Notice
              tone="warning"
              title={`Knowledge ${knowledgePartition.excluded.length}개가 검색에서 제외됨 (${knowledgePartition.usable.length}개 사용 중)`}
              detail={
                <>
                  {groupedExclusion.sharedReason && (
                    <p className="mb-2 text-text-secondary">{groupedExclusion.sharedReason}</p>
                  )}
                  <ul className="space-y-1.5">
                    {groupedExclusion.items.map(({ asset, reason }) => (
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
                </>
              }
            />
          )}
          {bridge && reconcileNotice && (() => {
            const caption = resolveReconcileCaption(reconcileNotice, [
              groupedExclusion.sharedReason,
              ...groupedExclusion.items.map((i) => i.reason),
            ]);
            if (!caption) return null;
            const isShortened = caption === RECONCILE_SAME_CAUSE_NOTICE;
            return <Notice tone="info" title={isShortened ? caption : `활성화 상태 확인 불가: ${caption}`} />;
          })()}

          {/* D-034 해석 경로 4 — 등록된 Local Agent가 있을 때만 이 선택
              영역이 나타난다(정상 상태는 배너 없이 조용히, 2026-08-14 원칙).
              고를 때만 표준 Agent 대신 이 Agent+짝 Prompt의 capabilities/
              limits/template이 적용된다 — Desktop 채팅이 Workflow 그래프를
              로딩해 실행하는 것은 아니다(PR A 계약, 이 화면 어디에도 그렇게
              적지 않는다). */}
          {bridge && registeredLocalAgents.length > 0 && (
            <div className="mb-4 shrink-0 rounded-card border border-border bg-white p-4">
              <label className="mb-1.5 block text-caption font-semibold text-text-primary" htmlFor="local-agent-select">
                실행 Agent
              </label>
              <select
                id="local-agent-select"
                value={selectedLocalAgentId}
                onChange={(e) => setSelectedLocalAgentId(e.target.value)}
                disabled={isRunning || !!localAgentSelectionDisabledReason}
                title={localAgentSelectionDisabledReason ?? undefined}
                className={fieldClass}
              >
                <option value="">표준 Agent(기본)</option>
                {registeredLocalAgents.map((a) => (
                  <option key={a.assetId} value={a.assetId}>
                    {a.name} v{a.version}
                    {a.localAgentRegistration?.promptLabel ? ` · ${a.localAgentRegistration.promptLabel}` : ""}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-caption text-text-muted">
                {selectedLocalAgent
                  ? `이번 대화는 "${selectedLocalAgent.name}"${
                      selectedLocalAgent.localAgentRegistration?.promptLabel
                        ? ` (Prompt: ${selectedLocalAgent.localAgentRegistration.promptLabel})`
                        : ""
                    }로 실행됩니다.`
                  : "표준 Agent로 실행됩니다. 설치된 자산 화면에서 등록한 Local Agent를 선택하면 그 Agent의 역할/제한과 짝 Prompt가 대신 적용됩니다."}
              </p>
            </div>
          )}

          {/* Task Brief 제약 B — Desktop은 이 배포가 allow-root
              (AGENT_RUNTIME_LOCAL_AGENT_ROOTS)를 설정하지 않은 것을 스스로
              고칠 수 없다. 조용히 실패하지 않고, 이 PC의 실제 설치 경로를
              그대로 보여준다(관리자가 그대로 복사해 환경 변수에 넣을 수
              있도록) — 사용자가 실제로 설치한 Agent가 있을 때만 보여준다
              (정상 상태 배너 최소화 원칙: 아무 Agent도 설치하지 않은
              사용자에게는 의미 없는 알림이다). */}
          {bridge && installedAgents.length > 0 && localAgentsEnabled === false && (
            <Notice
              tone="info"
              title="이 배포는 로컬 설치 Agent 등록을 허용하지 않습니다"
              detail={
                <>
                  <p>
                    설치된 Agent를 대화에서 선택해 쓰려면 관리자가 이 PC의 agent-runtime에
                    <code className="mx-1 rounded bg-slate-100 px-1 py-0.5">AGENT_RUNTIME_LOCAL_AGENT_ROOTS</code>
                    환경 변수를 설정해야 합니다(이 PC가 스스로 설정할 수 없는 배포 단계 설정입니다).
                  </p>
                  {installRootPath && (
                    <p className="mt-1.5">
                      이 PC의 설치 경로: <code className="rounded bg-slate-100 px-1 py-0.5">{installRootPath}</code>
                    </p>
                  )}
                </>
              }
            />
          )}
          {bridge && localAgentReconcileNotice && (
            <Notice tone="info" title={`Local Agent 등록 상태 확인 불가: ${localAgentReconcileNotice}`} />
          )}

          {bridge && calculatorSampleConnected && (
            <div className="mb-4 shrink-0 rounded-card border border-brand-200 bg-brand-50/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-caption font-semibold text-brand-700">숫자 더하기 · 연결됨</p>
                  <p className="mt-0.5 text-caption text-text-muted">이번 메시지에서 사용할 때만 켜세요.</p>
                </div>
                <label className="flex items-center gap-2 text-caption font-medium text-text-primary">
                  <input
                    type="checkbox"
                    checked={mcpDevEnabled}
                    onChange={(e) => setMcpDevEnabled(e.target.checked)}
                    disabled={isRunning}
                  />
                  이 Tool 사용
                </label>
              </div>
                {mcpDevEnabled && (
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-caption text-text-muted" htmlFor="calculator-a">
                        첫 번째 숫자
                      </label>
                      <input
                        id="calculator-a"
                        type="number"
                        value={calculatorA}
                        onChange={(e) => setCalculatorA(e.target.value)}
                        className={fieldClass}
                        disabled={isRunning}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-caption text-text-muted" htmlFor="calculator-b">
                        두 번째 숫자
                      </label>
                      <input
                        id="calculator-b"
                        type="number"
                        value={calculatorB}
                        onChange={(e) => setCalculatorB(e.target.value)}
                        className={fieldClass}
                        disabled={isRunning}
                      />
                    </div>
                  </div>
                )}
                <p className="mt-2 text-caption text-text-muted">
                  Tool은 연결된 로컬 Runtime에서 실행되며 결과와 감사 Trace가 이번 대화에 기록됩니다.
                </p>
            </div>
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

            <div className="flex-1 space-y-5 overflow-y-auto pr-1">
              {messages.length === 0 && localToolEntries.length === 0 && localToolRouteEntries.length === 0 && (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                    <Bot size={22} aria-hidden="true" />
                  </div>
                  <p className="text-card-title font-semibold text-text-primary">무엇을 도와드릴까요?</p>
                  <p className="text-caption text-text-muted">
                    {knowledgeLookupActive
                      ? "보유 Knowledge를 근거로 답변합니다."
                      : "기본 Ollama 모델로 대화합니다."}
                  </p>
                </div>
              )}

              {/* D-084 후속 — 대화 턴과 로컬 Tool 실행 기록을 실제 발생 시각
                  순서로 섞어 그린다(둘 다 "대화창에서 일어난 일"이지만, 카드
                  자체는 아래에서 절대 같은 모양으로 그리지 않는다).
                  `showContextLabel` 계산은 로컬 Tool 항목과 무관하게 기존과
                  동일한 `messages` 배열 순서를 그대로 쓴다. */}
              {(
                [
                  ...messages.map((m) => ({ kind: "chat" as const, ts: m.startedAt, message: m })),
                  ...localToolEntries.map((e) => ({ kind: "localTool" as const, ts: e.startedAt, entry: e })),
                  ...localToolRouteEntries.map((e) => ({ kind: "localToolRoute" as const, ts: e.startedAt, entry: e })),
                ] as Array<
                  | { kind: "chat"; ts: string; message: ChatMessage }
                  | { kind: "localTool"; ts: string; entry: LocalToolChatEntry }
                  | { kind: "localToolRoute"; ts: string; entry: LocalToolAutoRouteEntry }
                >
              )
                .sort((a, b) => a.ts.localeCompare(b.ts))
                .map((item) => {
                  if (item.kind === "localTool") {
                    return <LocalToolChatEntryCard key={item.entry.id} entry={item.entry} />;
                  }
                  if (item.kind === "localToolRoute") {
                    return <LocalToolAutoRouteEntryCard key={item.entry.id} entry={item.entry} />;
                  }
                  const m = item.message;
                  const idx = messages.indexOf(m);
                  return (
                    <ChatTurn
                      key={m.id}
                      message={m}
                      // 어떤 모델/지식으로 답했는지는 매 턴 반복하지 않고 앞
                      // 턴과 달라졌을 때만 한 줄로 보여준다 — 한 대화 안에서
                      // Ollama 일반 대화와 지식 검색을 오갔다는 사실은
                      // 남기되, 같은 문구가 턴마다 다시 찍히지는 않는다.
                      showContextLabel={turnContextLabel(m) !== turnContextLabel(messages[idx - 1])}
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
                  );
                })}
            </div>

            {/* 입력창 — 토글/모델/전송을 하나의 카드 안에 넣어 화면 아래쪽
                덩어리를 하나로 줄인다. 보낼 수 없는 이유는 문단이 아니라 전송
                버튼의 title로만 남긴다. */}
            <div className="mt-3 shrink-0">
              <div className="rounded-2xl border border-border bg-white shadow-sm transition focus-within:border-brand-400 focus-within:ring-1 focus-within:ring-brand-400">
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
                  aria-label="질문"
                  className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-body text-text-primary placeholder:text-text-muted focus:outline-none disabled:text-text-muted"
                  disabled={isRunning}
                />
                <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
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
                    icon={<BookOpenCheck size={15} aria-hidden="true" />}
                    pressed={useKnowledge}
                    disabled={isRunning || !hasUsableKnowledge || mcpDevActive}
                    onChange={setUseKnowledge}
                    activeLabel={`지식 ${knowledgeIds.length}개`}
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
                    icon={<Globe2 size={15} aria-hidden="true" />}
                    pressed={allowHubLookup}
                    disabled={isRunning || !hubLookupApplicable}
                    onChange={setAllowHubLookup}
                    activeLabel="허브"
                  />

                  {/* D-083 TOOL_ROUTE 동의 — 허브 토글과 동일한 모양의 동의(기본
                      꺼짐, 세션 간 영속하지 않음). 켜면 이번 질문에 맞는 MCP
                      Tool을 AI가 하나 제안하고, 실행 전에는 항상 기존 확인
                      Panel(승인/거부)을 거친다 — 이 토글 자체는 실행을
                      허락하지 않고 "제안을 받아보겠다"만 허락한다. */}
                  <ComposerToggle
                    id="tool-route-toggle"
                    label="필요하면 Tool 자동 제안"
                    description={
                      toolRouteApplicable
                        ? `이 질문에 사내 시스템 조회가 필요해 보이면 AI가 호출할 Tool과 입력값을 제안합니다. 실행 전에는 항상 승인/거부를 다시 확인합니다.${describeToolRouteMcpToolsHint(mcpToolConnectionSummary)}`
                        : "개발 확인용 MCP Tool 호출이 켜져 있는 동안에는 사용할 수 없습니다 — 그 입력이 항상 우선합니다."
                    }
                    icon={<Wrench size={15} aria-hidden="true" />}
                    pressed={toolRouteEnabled}
                    disabled={isRunning || !toolRouteApplicable}
                    onChange={setToolRouteEnabled}
                    activeLabel="Tool 제안"
                  />

                  {/* D-084 — 로컬 Tool을 직접 골라 인자를 채우고 매번 새로
                      승인해야만 실행되는 수동 경로. 아래 토글(D-084 후속 2)은
                      같은 로컬 Tool을 대상으로 하지만 선택과 인자를 AI가
                      대신하는 별도 경로다 — 이 버튼은 그대로 남긴다(대체가
                      아니라 추가). */}
                  <LocalToolInvokePanel
                    bridge={bridge}
                    disabled={isRunning}
                    onEntryStart={handleLocalToolEntryStart}
                    onEntryFinish={handleLocalToolEntryFinish}
                    mcpToolsSummary={{
                      connectedNames: mcpToolConnectionSummary.connected.map((a) => a.name),
                      installedNotConnectedCount: mcpToolConnectionSummary.installedNotConnectedCount,
                    }}
                  />

                  {/* D-084 후속 2 — "채팅에 질문을 입력하면 로컬 Tool 인자가
                      자동으로 채워지게" 요구(실사용 피드백, 의도적 예외로 두
                      번 재확인받음). 등록된 로컬 Tool이 하나도 없으면 이
                      토글 자체를 그리지 않는다 — 무엇을 켜는지 알 수 없는
                      토글을 보여주지 않는다. 켜져 있을 때 후보로 쓰일 로컬
                      Tool 이름을 그대로 보여준다(무엇이 자동 실행될 수
                      있는지 모르는 상태를 만들지 않는다). 실행 전 네이티브
                      승인 여부는 이 토글이 아니라 각 Tool의 `approval`(D-084
                      후속 3, 자산 화면에서 내용 해시에 묶어 미리 허용)이
                      정한다 — 허용해 둔 Tool은 AI가 정한 인자로도 대화상자
                      없이 실행되므로, 후보 목록에 어느 쪽인지 표시한다. */}
                  {registeredLocalTools.length > 0 && (
                    <ComposerToggle
                      id="local-tool-route-toggle"
                      label="로컬 Tool 인자 자동 채우기"
                      description={
                        localToolRouteApplicable
                          ? `이 질문에 맞는 로컬 Tool과 입력값을 AI가 스스로 골라 채웁니다(후보: ${registeredLocalTools
                              .map((t) => (t.approval !== null ? `${t.toolName}(실행 허용됨)` : t.toolName))
                              .join(", ")}). 검토되지 않은 내 PC 코드입니다. ${
                              registeredLocalTools.some((t) => t.approval !== null)
                                ? "'실행 허용됨' 표시가 있는 Tool은 자산 > 로컬 Tool에서 미리 허용해 두었으므로 승인 대화상자 없이 바로 실행됩니다 — AI가 정한 인자도 그대로 실행됩니다. 나머지는 실행 전 네이티브 승인을 다시 거칩니다."
                                : "실행 전 Desktop 창의 네이티브 승인 대화상자를 매번 다시 거칩니다."
                            }`
                          : !bridge
                            ? "이 기능은 Desktop 앱에서만 사용할 수 있습니다."
                            : "개발 확인용 Tool 호출/Tool 자동 제안/Local Agent 선택이 켜져 있는 동안은 사용할 수 없습니다 — 먼저 끄세요."
                      }
                      icon={<Sparkles size={15} aria-hidden="true" />}
                      pressed={localToolRouteEnabled}
                      disabled={isRunning || !localToolRouteApplicable}
                      onChange={setLocalToolRouteEnabled}
                      activeLabel="로컬 Tool 자동"
                    />
                  )}

                  {settingsBridge ? (
                    <div className="flex min-w-0 items-center gap-1 rounded-full px-1.5 py-1 transition-colors hover:bg-slate-100">
                      <Bot size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
                      <label htmlFor="chat-model-select" className="sr-only">채팅 모델</label>
                      <select
                        id="chat-model-select"
                        value={chatModelAlias}
                        onChange={(event) => void handleChatModelChange(event.target.value)}
                        disabled={modelsLoading || modelSaving || installedChatModels.length === 0 || isRunning}
                        className="max-w-48 min-w-0 cursor-pointer appearance-none bg-transparent text-caption font-medium text-text-secondary outline-none disabled:cursor-not-allowed disabled:text-text-muted"
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

                  <button
                    type="button"
                    onClick={() => void handleSend()}
                    disabled={!canSend}
                    title={sendDisabledReason ?? "실행"}
                    aria-label="실행"
                    className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-500 text-white transition-colors hover:bg-brand-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                  >
                    <Send size={15} />
                  </button>
                </div>
              </div>

              {/* D-078 사전 가시성 — 허브 조회를 켠 동안에만, 실제로 전송될
                  질문 텍스트를 그대로 보여준다. */}
              {allowHubLookup && (
                <p className="mt-1.5 flex items-start gap-1.5 px-1 text-[11px] text-text-muted">
                  <Globe2 size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0">허브 전송 미리보기: &quot;{hubQueryPreview}&quot;</span>
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {citationDetail && <CitationDetailModal citation={citationDetail} onClose={() => setCitationDetail(null)} />}
      {detailMessage && <RunDetailPanel message={detailMessage} onClose={() => setDetailMessageId(null)} />}
      {agentDraftDialogOpen && (
        <AgentDraftDialog messages={messages} onClose={() => setAgentDraftDialogOpen(false)} />
      )}

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

// 턴 하나가 "무엇으로 답했는지"를 나타내는 짧은 문구. 같은 문구가 연속되면
// ChatScreen이 뒤쪽 턴에서는 표시하지 않는다(`showContextLabel`). 실행 중과
// 완료 후에 값이 달라지면 안 되므로(그러면 턴마다 같은 줄이 깜빡인다) 실제
// 응답 모델명은 여기 넣지 않고 `turnContextTitle`(hover)에만 둔다.
function turnContextLabel(message?: ChatMessage): string {
  if (!message) return "";
  const base = message.ollamaOnly ? "Ollama 일반 대화" : message.knowledgeLabelUsed || "지식 검색";
  // D-034 해석 경로 4 — 표준 Agent가 아니라 등록된 Local Agent로 실행된
  // 턴은 그 사실이 항상 보여야 한다(Task Brief 제약 D) — 매 턴 캡처된 값을
  // 그대로 쓴다(화면의 현재 선택이 바뀌어도 지난 턴의 표시가 바뀌지 않도록).
  const withAgent = message.localAgentLabelUsed ? `${base} · Agent: ${message.localAgentLabelUsed}` : base;
  return message.restored ? `저장된 대화 · ${withAgent}` : withAgent;
}

function turnContextTitle(message: ChatMessage): string | undefined {
  const parts = [
    message.ollamaModel ? `모델: ${message.ollamaModel}` : null,
    message.restored ? "저장된 대화에서 복원됨 — 실행 상세 정보는 보존되지 않습니다." : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function ChatTurn({
  message,
  showContextLabel,
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
  showContextLabel: boolean;
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
    <div className="group space-y-2">
      {showContextLabel && (
        <p className="text-center text-[11px] text-text-muted" title={turnContextTitle(message)}>
          {turnContextLabel(message)}
        </p>
      )}

      {/* 짧은 질문이 가로로 늘어나지 않도록 내용 너비(w-fit)로 둔다. */}
      <div className="ml-auto w-fit max-w-[80%] whitespace-pre-wrap rounded-2xl bg-brand-600 px-4 py-2.5 text-sm text-white">
        {message.question}
      </div>

      <div className="max-w-[90%] space-y-2">
        {/* 단계 표시는 실행 중일 때만 — 끝난 턴에서 5개 배지가 계속 남아 있을
            이유가 없다(상세는 "상세 실행 보기"에 그대로 있다). Ollama 일반
            대화는 단계가 사실상 없으므로 아래 진행 표시로 충분하다. */}
        {isInFlight && !message.ollamaOnly && <StageIndicator stages={message.stages} />}

        {/* KNOWLEDGE_ROUTE(agentic Knowledge 선택) 결과 — 이 턴이 후보를
            보냈고 라우팅이 실제로 돌았을 때만(스킵/실패 포함) 나타난다. 요구
            사항: 셋(ran/skipped/fallback)을 절대 섞어 말하지 않는다. */}
        {message.knowledgeRoute && <KnowledgeRoutePanel route={message.knowledgeRoute} />}

        {/* TOOL_ROUTE(D-083, agentic MCP Tool 선택) 결과 — 이 턴이 실제로
            `tool_route: true`를 보냈고 라우팅이 돌았을 때만 나타난다. */}
        {message.toolRoute && <ToolRoutePanel route={message.toolRoute} />}

        {/* 허브 조회 사후 가시성 — "hub.query_sent" 이벤트가 도착할 때마다
            실제로 허브에 전송된 질의를 그대로 보여준다(agent-runtime의 강제
            지점이 사용자가 입력한 텍스트로만 구성되도록 보장하므로 그대로
            표시해도 안전하다). */}
        {message.hubQueriesSent.map((h, idx) => (
          <p key={idx} className="flex items-start gap-1.5 text-[11px] text-text-muted">
            <Globe size={12} className="mt-0.5 shrink-0" />
            허브에 전송한 질의: &quot;{h.query}&quot;
          </p>
        ))}

        {message.status === "running" && (
          <div className="flex items-center gap-2 text-body text-text-secondary">
            <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-brand-400" />
            <span className="min-w-0">
              {message.answer ? <AnswerMarkdown source={message.answer} /> : "처리하는 중..."}
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
          <div className="text-body text-text-primary">
            {message.answer ? <AnswerMarkdown source={message.answer} /> : "답변이 없습니다."}
          </div>
        )}

        {message.status === "insufficient_evidence" && (
          <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-2.5 text-body text-warning">
            등록된 Knowledge에서 근거를 찾지 못했습니다.
          </div>
        )}

        {message.status === "cancelled" && (
          <p className="text-body text-text-muted">취소됨{message.traceId ? ` (Trace ID: ${message.traceId})` : ""}</p>
        )}

        {/* D-034 해석 경로 4 — 등록이 실행 도중 사라진 경우(재확인으로
            다운그레이드되기 전에 발생 가능한 경합, 또는 다른 프로세스가
            등록을 해제한 경우)를 표준 오류 배너로 뭉개지 않는다. 재시도해도
            같은 이유로 다시 실패한다는 사실과 다음 행동(재등록)을 그대로
            말한다 — 절대 표준 Agent로 조용히 대체되지 않는다(Task Brief
            제약 D). */}
        {message.status === "failed" && message.errorCode === "LOCAL_AGENT_NOT_REGISTERED" && (
          <Notice
            tone="warning"
            title={`등록된 Local Agent를 찾을 수 없습니다${message.localAgentLabelUsed ? ` (${message.localAgentLabelUsed})` : ""}.`}
            detail={
              <>
                <p>{message.errorMessage}</p>
                <p className="mt-1.5">
                  설치된 자산 화면에서 이 Agent를 다시 등록하세요 — 등록이 해제되었거나(다른 프로세스에서 해제,
                  agent-runtime 재시작 등) 아직 한 번도 등록되지 않았을 수 있습니다. 이 턴은 표준 Agent로 자동 대체되지
                  않았습니다.
                </p>
              </>
            }
          />
        )}
        {message.status === "failed" && message.errorCode !== "LOCAL_AGENT_NOT_REGISTERED" && (
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
          <p className="text-[11px] text-text-muted">
            출처 {message.restoredCitationCount}건 (복원된 대화에는 출처 상세 내용이 저장되지 않습니다)
          </p>
        )}

        {/* 출처는 제목 칩으로 접어 보여주고, 발췌/섹션은 클릭했을 때 모달에서
            본다. 로컬/허브 구분(D-078)은 칩 안에 그대로 남는다. */}
        {message.citations.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {message.citations.map((c, idx) => (
              <button
                key={c.chunk_id || idx}
                type="button"
                onClick={() => onCitationClick(c)}
                title={`${c.document_title || c.document_path || "제목 없음"}${c.section ? ` · ${c.section}` : ""} — ${c.source === "hub" ? "허브" : "로컬"} 검색 결과`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-white px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-slate-50"
              >
                <FileSearch size={11} className="shrink-0 text-text-muted" aria-hidden="true" />
                <span className="min-w-0 truncate">{c.document_title || c.document_path || "제목 없음"}</span>
                <span className={`shrink-0 font-semibold ${c.source === "hub" ? "text-brand-600" : "text-text-muted"}`}>
                  {c.source === "hub" ? "허브" : "로컬"}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* 보조 동작은 평소 숨기고 hover/포커스 때만 — 취소만 예외로 항상
            보인다(D06 규칙: 실행 중에는 언제나 취소할 수 있어야 한다). */}
        <div
          className={`flex flex-wrap items-center gap-1 ${
            isInFlight ? "" : "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          }`}
        >
          {isInFlight && (
            <Button variant="secondary" size="sm" onClick={onCancel}>
              <Square size={13} /> 취소
            </Button>
          )}
          {message.status === "failed" && (
            <Button variant="secondary" size="sm" onClick={onRerun} disabled={rerunDisabled}>
              <RefreshCw size={13} /> 재시도
            </Button>
          )}
          {isTerminal && message.status !== "failed" && (
            <IconAction label="동일 입력으로 다시 실행" onClick={onRerun} disabled={rerunDisabled}>
              <RefreshCw size={13} />
            </IconAction>
          )}
          {message.status === "succeeded" && (
            <>
              <IconAction label={copied ? "복사됨" : "결과 복사"} onClick={onCopy}>
                {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
              </IconAction>
              <IconAction label="Markdown 저장" onClick={onDownload}>
                <Download size={13} />
              </IconAction>
            </>
          )}
          {isTerminal && !message.ollamaOnly && (
            <IconAction label="상세 실행 보기" onClick={onOpenDetail}>
              <ListChecks size={13} />
            </IconAction>
          )}
        </div>
      </div>
    </div>
  );
}

// 라벨/순서는 runStages.ts가 유일한 출처다(예전에는 여기 로컬 복제본이
// 있었고, 그 두 벌이 갈라지는 게 문제였다 — 2026-08-14 정리).
function StageIndicator({ stages }: { stages: ChatMessage["stages"] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {STAGE_ORDER.filter((stage) => stages[stage] !== undefined).map((stage) => {
        // `routing`(유일하게 없을 수 있는 단계)은 위 filter가 이미 걸러냈다.
        const entry = stages[stage] as NonNullable<(typeof stages)[typeof stage]>;
        const tone =
          entry.state === "done"
            ? "bg-success/10 text-success"
            : entry.state === "active"
              ? "bg-brand-50 text-brand-700"
              : entry.state === "waiting"
                ? "bg-warning/10 text-warning"
                : entry.state === "error"
                  ? "bg-danger/10 text-danger"
                  : entry.state === "cancelled"
                    ? "bg-warning/10 text-warning"
                    : "bg-slate-100 text-text-muted";
        return (
          <span key={stage} className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${tone}`}>
            {describeStage(stage, entry)}
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
