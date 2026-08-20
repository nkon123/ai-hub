// D-084 후속 — 대화(D06) 화면에서 로컬 Tool을 명시적으로 골라 실행한다.
//
// 이 파일이 존재하는 이유(경계 설계, `electron/__tests__/local-tool-isolation.test.ts`
// 참고): "채팅에서 로컬 Tool을 쓸 수 있게 하라"는 요구를 만족시키되, D-083
// TOOL_ROUTE/D-080 MCP Tool 등록이 지키는 "모델이 Tool을 고르지도, 인자를
// 만들지도 않는다"는 경계를 절대 넘지 않는다. 그래서 이 컴포넌트는:
//   1. `../agentRuntime`와 `./chatTypes`를 **전혀 import하지 않는다** — Run을
//      시작하거나 agent-runtime에 무언가를 보내는 코드 경로와 물리적으로
//      분리되어 있다. 이 파일이 실행하는 모든 것은 `bridge.invokeLocalTool`
//      IPC 호출 하나로 끝난다(Main Process가 매번 `dialog.showMessageBox`로
//      다시 승인을 묻는다 — `electron/main.ts`의 `localTool:invoke` 핸들러,
//      D-084 정정 이후 구조).
//   2. `LocalToolInvokePanel`(수동 경로)에서는 Tool 선택과 인자 입력이
//      **항상 사용자의 명시적 조작**이다 — 질문 텍스트를 읽어 자동으로
//      Tool이나 인자를 고르지 않는다.
//   3. 실행 결과는 이 컴포넌트가 스스로 그리지 않고 `onEntryStart`/
//      `onEntryFinish` 콜백으로만 부모(ChatScreen)에 알린다 — 대화창에
//      실제로 어떻게 그려지는지는 `LocalToolChatEntryCard`(같은 파일)가
//      맡고, ChatScreen은 그 카드를 Hub Tool/Knowledge 결과와 시각적으로
//      다르게(항상 "로컬 Tool (검토되지 않음)" 배지) 배치한다.
//
// D-084 후속 2 — "채팅에 질문을 입력하면 로컬 Tool 인자가 자동으로
// 채워지게" 요구(사용자 실사용 피드백, 두 번 재확인받은 의도적 예외). 이
// 파일에 `runResolvedLocalTool`/`LocalToolAutoRouteEntryCard`를 함께 둔
// 이유: 위 경계 (1)을 그대로 지키면서 자동화를 추가하려면 "Tool을
// 고르고 인자를 만드는" 로직이 여전히 agent-runtime/chatTypes와 물리적으로
// 분리된 자리에 있어야 하기 때문이다.
//   - Tool 선택+인자 추출은 `electron/local-tool-router.ts`(순수 HTTP,
//     agent-runtime을 전혀 모른다)가 로컬 Ollama에 **한 번만** 물어
//     제안받는다 — D-083 `tool_router.py`와 동일한 fail-closed 규율(그
//     모듈 docstring 참고).
//   - 실행 승인은 여전히 `bridge.invokeLocalTool`이 맡고, Main Process가
//     승인 여부를 판정한다 — 자동 라우팅이라는 이유로 승인을 낮추지는
//     않는다(구현 원칙 7). 다만 D-084 후속 3 이후, 자산 화면에서 내용
//     해시에 묶어 미리 허용해 둔 Tool은 대화상자 없이 실행된다(AI가 정한
//     인자여도 마찬가지다 — 그 위험은 D-089에 기록). 다만 이번에는 `{ aiSelected: true }`를
//     넘겨 그 대화상자 문구가 "Tool 선택과 인자 모두 AI가 정했다"는 사실을
//     밝히게 한다.
//   - 결과 카드(`LocalToolAutoRouteEntryCard`)는 "모델이 Tool이 필요
//     없다고 판단"/"후보 중 못 고름"/"골랐으나 검증 실패"/"사용자가 승인
//     거절"/"실행 성공"을 서로 다른 문구로 보여준다(Task Brief 요구사항 F).
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, FileCode2, Loader2, Sparkles, Terminal } from "lucide-react";
import type { DesktopBridge, LocalTool } from "../../electron/types";
import { Button, ErrorBanner, LoadingState, Modal } from "../ui";
import { formatDateTime } from "../format";
import { AnswerMarkdown } from "./AnswerMarkdown";
import {
  NOT_A_SANDBOX_NOTICE,
  buildLocalToolArgs,
  describeMcpToolsNoticeForEmptyState,
  fieldKindForSchemaType,
  formatArgsForConfirm,
  formatInvocationOutcome,
  initialFieldText,
  type InvocationOutcomeDisplay,
  type McpToolsSummaryForLocalToolEmptyState,
} from "./localToolsTypes";

/** 대화창에 표시되는 로컬 Tool 실행 한 건. `outcome === null`이면 아직
 * 실행/승인 대기 중이다(Loading 상태). `chatTypes.ts`의 `ChatMessage`와는
 * 의도적으로 별개의 타입이다 — 위 모듈 docstring 참고. */
export interface LocalToolChatEntry {
  id: string;
  toolId: string;
  functionName: string;
  filePath: string;
  args: Record<string, unknown>;
  startedAt: string;
  completedAt: string | null;
  outcome: InvocationOutcomeDisplay | null;
}

const OUTCOME_TONE_CLASS: Record<InvocationOutcomeDisplay["tone"], string> = {
  success: "border-success/30 bg-success/5 text-success",
  danger: "border-danger/30 bg-danger/5 text-danger",
  warning: "border-warning/30 bg-warning/5 text-warning",
  muted: "border-border bg-slate-50 text-text-secondary",
};

/** 실사용 제보(2026-08-20) — "로컬 Tool 결과가 마크다운으로 안 보인다".
 * 이 컴포넌트가 세 자리(수동 실행 카드/자동 라우팅 카드/수동 실행 완료
 * 모달)에서 반복해 쓰인다 — `formatInvocationOutcome`(`localToolsTypes.ts`)
 * 이 이미 문자열 결과와 구조적 결과를 `detailKind`로 구분해 뒀으므로, 여기서는
 * 그 판정을 그대로 따라 그리기만 한다. `detailKind`가 없으면(실패/취소/타임
 * 아웃 등 사람이 쓴 안내 문구) 지금까지와 같은 `<pre>` 표시를 유지한다 —
 * 구조적 텍스트를 마크다운으로 잘못 해석하지 않는다. */
function OutcomeDetail({ outcome }: { outcome: InvocationOutcomeDisplay }) {
  if (outcome.detailKind === "markdown") {
    return (
      <div className="mt-0.5 max-h-72 overflow-y-auto overflow-x-auto rounded border border-black/10 bg-white/60 px-2 py-1.5">
        <AnswerMarkdown source={outcome.detail} />
      </div>
    );
  }
  return <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap text-caption">{outcome.detail}</pre>;
}

/** 대화 스레드 안에 그려지는 카드 — Hub Tool 결과(ToolRoutePanel)나 Knowledge
 * Citation과 절대 같은 모양으로 보이면 안 된다(Task Brief 요구사항): 배지를
 * 항상 붙이고, 카드 자체를 대시 테두리(로컬/미검토임을 시각적으로 구분)로
 * 그린다. */
export function LocalToolChatEntryCard({ entry }: { entry: LocalToolChatEntry }) {
  const outcome = entry.outcome;
  return (
    <div className="max-w-full rounded-lg border border-dashed border-slate-300 bg-slate-50/70 px-3 py-2.5 text-[11px] text-text-secondary">
      <div className="flex flex-wrap items-center gap-1.5 font-medium text-text-primary">
        <Terminal size={12} className="shrink-0" />
        <span className="truncate">{entry.functionName}</span>
        <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
          로컬 Tool (검토되지 않음)
        </span>
      </div>
      <p className="mt-1 break-all text-[10px] text-text-muted">{entry.filePath}</p>
      <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded border border-border bg-white px-2 py-1.5 text-[10px] text-text-secondary">
        {formatArgsForConfirm(entry.args)}
      </pre>
      {outcome === null ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-text-muted">
          <Loader2 size={11} className="animate-spin" /> 실행 승인을 기다리는 중...
        </p>
      ) : (
        <div className={`mt-1.5 rounded border px-2 py-1.5 ${OUTCOME_TONE_CLASS[outcome.tone]}`}>
          <p className="font-semibold">{outcome.title}</p>
          <OutcomeDetail outcome={outcome} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// D-084 후속 2 — 자동 라우팅(질문 -> Tool+인자 자동 제안 -> 승인 -> 실행).
// ---------------------------------------------------------------------------

/** 채팅창 입력 하나로 트리거된 자동 라우팅 한 건. `display === null`이면
 * 아직 진행 중이다(라우팅 호출 또는 승인/실행 대기). `toolName`/`args`는
 * 실제로 Tool이 정해졌을 때만(라우팅 성공, 스키마 검증 실패, 실행) 채워
 * 진다 — "Tool이 필요 없다고 판단"/"후보 중 못 고름" 케이스는 둘 다
 * `null`로 남는다(둘 다 어떤 Tool도 정해지지 않았다는 같은 사실이다). */
export interface LocalToolAutoRouteEntry {
  id: string;
  question: string;
  toolName: string | null;
  args: Record<string, unknown> | null;
  startedAt: string;
  completedAt: string | null;
  display: InvocationOutcomeDisplay | null;
  /** 실사용 제보(2026-08-20) "채팅 입력하고 취소할 수 있어야해" 후속 —
   * 실제 로컬 Tool 실행이 시작될 때만(`runResolvedLocalTool`이
   * `bridge.invokeLocalTool`을 부르기 직전) 채워진다. `display === null`인
   * 동안에만 의미가 있다 — `bridge.cancelLocalToolInvocation(invocationId)`에
   * 그대로 넘기면 이 실행을 중단할 수 있다(수동 실행 패널의 `requestCancel`과
   * 정확히 같은 메커니즘). `null`이면(Tool이 아직 선택되지 않았거나 이미
   * 끝남) 취소 대상이 없다는 뜻이다. */
  invocationId: string | null;
}

/** 자동 라우팅 카드 — 수동 실행 카드(`LocalToolChatEntryCard`)와 다른
 * 아이콘(Sparkles, "AI가 자동 선택"임을 표시)과 배지 문구를 쓴다. Task
 * Brief 요구사항 F: "Tool 불필요"/"후보 중 못 고름"/"검증 실패"/"승인
 * 거절"/"실행 성공"을 절대 하나의 "실패"로 뭉개지 않는다 — 그 구분은
 * `runResolvedLocalTool`이 만든 `display.title`에 이미 담겨 있고, 이
 * 카드는 그것을 그대로 보여줄 뿐이다(같은 카드를 다른 오해로 재사용하지
 * 않는다). */
export function LocalToolAutoRouteEntryCard({
  entry,
  onCancel,
  cancelling,
}: {
  entry: LocalToolAutoRouteEntry;
  /** 실사용 제보(2026-08-20) 후속 — 실제 실행 중일 때(`display === null &&
   * entry.invocationId`)만 호출 가능하게 부모(ChatScreen)가 넘긴다. 부모가
   * 이 카드를 아직 지원하지 않으면(구조상 항상 넘기지만 방어적으로) 생략해도
   * 카드는 깨지지 않고 그냥 버튼을 그리지 않는다 — D06 규칙(취소 버튼은
   * hover로 숨기지 않고 항상 보인다)은 버튼이 존재할 때의 표시 방식에
   * 적용되고, 존재 여부 자체는 이 prop이 결정한다. */
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  const { display } = entry;
  const showCancel = display === null && Boolean(entry.invocationId) && Boolean(onCancel);
  return (
    <div className="max-w-full rounded-lg border border-dashed border-brand-200 bg-brand-50/40 px-3 py-2.5 text-[11px] text-text-secondary">
      <div className="flex flex-wrap items-center gap-1.5 font-medium text-text-primary">
        <Sparkles size={12} className="shrink-0" />
        <span className="truncate">{entry.toolName ?? "로컬 Tool 자동 라우팅"}</span>
        <span className="rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700">
          로컬 Tool · AI 자동 선택 (검토되지 않음)
        </span>
      </div>
      {entry.args && (
        <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded border border-border bg-white px-2 py-1.5 text-[10px] text-text-secondary">
          {formatArgsForConfirm(entry.args)}
        </pre>
      )}
      {display === null ? (
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-text-muted">
            <Loader2 size={11} className="animate-spin" /> 어떤 Tool을 쓸지 확인하고, 필요하면 승인을 기다리는 중...
          </p>
          {showCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              className="shrink-0 rounded-full border border-danger/30 bg-danger/5 px-2.5 py-1 text-[10px] font-semibold text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {cancelling ? "중단하는 중..." : "실행 중단"}
            </button>
          )}
        </div>
      ) : (
        <div className={`mt-1.5 rounded border px-2 py-1.5 ${OUTCOME_TONE_CLASS[display.tone]}`}>
          <p className="font-semibold">{display.title}</p>
          <OutcomeDetail outcome={display} />
        </div>
      )}
    </div>
  );
}

// D-089 후속(통합 Tool 라우팅) — "로컬 Tool 또는 MCP Tool 중 무엇을 쓸지"는
// 더 이상 이 파일이 결정하지 않는다(`electron/unified-tool-router.ts`가
// 로컬+MCP 후보를 함께 놓고 그 판단을 한 번의 LLM 호출로 끝낸다, MCP 우선
// tie-break도 거기서 코드로 강제된다). 이 파일은 그 판단이 "로컬"로 끝났을
// 때 실제 실행 한 건만 담당한다 — 라우팅을 여기서 다시 하지 않는다(같은
// 질문에 Ollama를 두 번 묻지 않기 위해서이기도 하다).

/** 이미 확정된 로컬 Tool 선택(id/이름/검증된 args)을 실행한다. 승인은
 * 여전히 Main Process가 맡는다(위 모듈 docstring 2번) — 이 함수는 그 결과를
 * `onStart`/`onFinish` 콜백으로 부모에 알리기만 한다. 절대 throw하지
 * 않는다 — 실패는 `onFinish`로 전달되는 `display` 값으로 귀결된다.
 *
 * 실사용 제보(2026-08-20) 후속 — `id`/`startedAt`을 생략하면(기존 동작)
 * 새로 만든다. `ChatScreen.tsx`는 이제 라우팅을 시작하기 전에 이미 만든
 * placeholder의 id/전송 시각을 넘겨, 이 항목이 그 placeholder와 정확히
 * 같은 위치에서 이어지게 한다(질문이 두 번 그려지지 않게 하는 핵심 —
 * `chatThreadMerge.ts` 참고).
 *
 * 실사용 제보(2026-08-20) "채팅 입력하고 취소할 수 있어야해" 후속(취소) —
 * 수동 실행 패널의 `execute()`와 정확히 같은 방식으로 `invocationId`를
 * 스스로 만들어(`crypto.randomUUID()`) `bridge.invokeLocalTool`에 넘긴다.
 * 이 id는 `onStart`가 받는 entry의 `invocationId` 필드로도 그대로 전달되어,
 * 호출자가 `bridge.cancelLocalToolInvocation(invocationId)`로 이 실행을
 * 중단할 수 있게 한다. */
export async function runResolvedLocalTool(params: {
  bridge: DesktopBridge;
  question: string;
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
  id?: string;
  startedAt?: string;
  onStart: (entry: LocalToolAutoRouteEntry) => void;
  onFinish: (
    id: string,
    completedAt: string,
    toolName: string | null,
    args: Record<string, unknown> | null,
    display: InvocationOutcomeDisplay,
  ) => void;
}): Promise<void> {
  const { bridge, question, toolId, toolName, args, onStart, onFinish } = params;
  const id = params.id ?? crypto.randomUUID();
  const startedAt = params.startedAt ?? new Date().toISOString();
  const invocationId = crypto.randomUUID();
  onStart({ id, question, toolName, args, startedAt, completedAt: null, display: null, invocationId });
  const finish = (display: InvocationOutcomeDisplay) => onFinish(id, new Date().toISOString(), toolName, args, display);

  try {
    // 사용자가 대화상자에서 거절하면 `formatInvocationOutcome`이
    // "실행하지 않았습니다"로, 실행 중 중단하면 "실행을 중단했습니다"로
    // 정직하게 보여준다(둘 다 실패가 아니다 — `formatInvocationOutcome`의
    // `user_denied`/`cancelled` 분기 참고).
    const invocation = await bridge.invokeLocalTool(toolId, args, { aiSelected: true, invocationId });
    finish(formatInvocationOutcome(invocation));
  } catch (err) {
    finish({
      tone: "danger",
      title: "자동 Tool 실행 실패",
      detail: err instanceof Error ? err.message : "알 수 없는 오류입니다.",
    });
  }
}

type PanelStep = "closed" | "selecting" | "filling" | "confirming" | "invoking" | "done";

export function LocalToolInvokePanel({
  bridge,
  disabled,
  onEntryStart,
  onEntryFinish,
  mcpToolsSummary,
}: {
  /** `null`이면(Electron 런타임 밖 — 브라우저 개발 모드) 실행 경로 자체가
   * 없다 — Permission 상태(버튼은 보이되 비활성 + 사유)로 표시한다. */
  bridge: DesktopBridge | null;
  disabled?: boolean;
  onEntryStart: (entry: LocalToolChatEntry) => void;
  onEntryFinish: (id: string, completedAt: string, outcome: InvocationOutcomeDisplay) => void;
  /** D-080/D-084 혼동 정정 — 사용자가 자산 스토어에서 MCP Tool을
   * 설치·연결했다면, "등록된 로컬 Tool이 없습니다" 빈 상태가 그 사실을
   * 가리는 것처럼 읽힌다(방금 설치한 게 왜 없다고 하는지 오해). 부모
   * (`ChatScreen.tsx`)가 이미 알고 있는 MCP Tool 연결 사실(이름/개수)만
   * 순수 데이터로 받는다 — 이 컴포넌트는 `./chatTypes`를 import하지
   * 않는다(구조적 격리, `local-tool-isolation.test.ts` 참고). 생략하면
   * (`undefined`) MCP Tool 정보를 모르는 것으로 취급해 원래 빈 상태
   * 문구만 보여준다. */
  mcpToolsSummary?: McpToolsSummaryForLocalToolEmptyState;
}) {
  const [step, setStep] = useState<PanelStep>("closed");
  const [tools, setTools] = useState<LocalTool[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<LocalTool | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const [lastOutcome, setLastOutcome] = useState<InvocationOutcomeDisplay | null>(null);
  // 실사용 제보(2026-08-19) — 실행 중 취소. `execute()`가 생성한 id를
  // `bridge.invokeLocalTool(..., { invocationId })`로 넘기고, 취소 버튼은
  // 같은 id로 `bridge.cancelLocalToolInvocation`을 부른다. `null`이면(취소
  // 대상이 아직 없거나 이미 끝남) 취소 버튼을 보이지 않는다.
  const [invokingId, setInvokingId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    if (!bridge) return;
    setTools(null);
    setListError(null);
    try {
      setTools(await bridge.listLocalTools());
    } catch (err) {
      setListError(err instanceof Error ? err.message : "로컬 Tool 목록을 불러오지 못했습니다.");
      setTools([]);
    }
  }, [bridge]);

  useEffect(() => {
    if (step === "selecting") void load();
  }, [step, load]);

  function open() {
    if (!bridge) return;
    setStep("selecting");
  }

  function close() {
    setStep("closed");
    setSelectedTool(null);
    setFormValues({});
    setFieldErrors({});
    setInvokeError(null);
    setLastOutcome(null);
    setInvokingId(null);
    setCancelling(false);
  }

  function selectTool(tool: LocalTool) {
    setSelectedTool(tool);
    const initial: Record<string, string> = {};
    for (const param of tool.parameters) initial[param.name] = initialFieldText(param);
    setFormValues(initial);
    setFieldErrors({});
    setStep("filling");
  }

  function proceedToConfirm() {
    if (!selectedTool) return;
    const built = buildLocalToolArgs(selectedTool, formValues);
    if (!built.ok) {
      setFieldErrors(built.errors ?? {});
      return;
    }
    setFieldErrors({});
    setStep("confirming");
  }

  async function execute() {
    if (!bridge || !selectedTool) return;
    const built = buildLocalToolArgs(selectedTool, formValues);
    if (!built.ok) {
      setStep("filling");
      setFieldErrors(built.errors ?? {});
      return;
    }
    const args = built.args ?? {};
    const entryId = crypto.randomUUID();
    // 취소 대상 id — `entryId`(대화창 카드 식별자)와 별개로 둔다: Main
    // Process가 이 id로 실행 중인 프로세스를 추적한다
    // (`electron/main.ts`의 `runningLocalToolInvocations`).
    const invocationId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    setStep("invoking");
    setInvokeError(null);
    setInvokingId(invocationId);
    setCancelling(false);
    onEntryStart({
      id: entryId,
      toolId: selectedTool.id,
      functionName: selectedTool.functionName,
      filePath: selectedTool.filePath,
      args,
      startedAt,
      completedAt: null,
      outcome: null,
    });
    try {
      // 실제 승인 대화상자와 subprocess spawn은 전부 Main Process
      // (`electron/main.ts`의 `localTool:invoke` 핸들러)가 맡는다 — 여기서는
      // 결과를 기다렸다가 그대로 옮겨 적을 뿐이다.
      const result = await bridge.invokeLocalTool(selectedTool.id, args, { invocationId });
      const outcome = formatInvocationOutcome(result);
      const completedAt = new Date().toISOString();
      setLastOutcome(outcome);
      onEntryFinish(entryId, completedAt, outcome);
      setStep("done");
    } catch (err) {
      const outcome: InvocationOutcomeDisplay = {
        tone: "danger",
        title: "실행 요청 실패",
        detail: err instanceof Error ? err.message : "알 수 없는 오류입니다.",
      };
      const completedAt = new Date().toISOString();
      setInvokeError(outcome.detail);
      setLastOutcome(outcome);
      onEntryFinish(entryId, completedAt, outcome);
      setStep("done");
    } finally {
      setInvokingId(null);
      setCancelling(false);
    }
  }

  // 실사용 제보(2026-08-19) — 실행 중 중단. Main Process가 실제로 spawn된
  // 프로세스를 SIGKILL로 종료한다(`electron/local-tool-runner.ts`) — 이
  // 호출이 끝난 뒤에도 위 `execute()`의 `await bridge.invokeLocalTool(...)`가
  // `{ outcome: "cancelled" }`로 정상 해결되며, 그 결과가 이 실행의 최종
  // 결과로 그대로 기록된다(오류가 아니다).
  async function requestCancel() {
    if (!bridge || !invokingId) return;
    setCancelling(true);
    try {
      const result = await bridge.cancelLocalToolInvocation(invokingId);
      if (!result.ok) {
        // 이미 끝났거나 알 수 없는 실행 — 조용히 무시하지 않고 그대로
        // 알린다. `execute()`가 곧 실제 최종 결과로 화면을 갱신한다.
        setInvokeError(result.error ?? "취소 요청이 실패했습니다.");
        setCancelling(false);
      }
    } catch (err) {
      setInvokeError(err instanceof Error ? err.message : "취소 요청 중 오류가 발생했습니다.");
      setCancelling(false);
    }
  }

  const modalOpen = step !== "closed";
  const modalTitle =
    step === "selecting"
      ? "로컬 Tool 실행 — 선택"
      : selectedTool
        ? `로컬 Tool 실행: ${selectedTool.functionName}`
        : "로컬 Tool 실행";

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={disabled || !bridge}
        title={
          !bridge
            ? "로컬 Tool 실행은 Desktop 앱에서만 사용할 수 있습니다."
            : disabled
              ? "이미 실행 중입니다."
              : "내 PC에 등록해 둔 Python Tool을 골라 실행합니다."
        }
        aria-label="로컬 Tool 실행"
        className="flex h-8 items-center justify-center gap-1.5 rounded-full border border-transparent bg-slate-100 px-2.5 text-caption font-medium text-text-secondary transition-colors hover:bg-slate-200 hover:text-text-primary disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-text-muted"
      >
        <FileCode2 size={15} aria-hidden="true" />
        로컬 Tool
      </button>

      <Modal open={modalOpen} title={modalTitle} onClose={close}>
        {step === "selecting" && (
          <div className="space-y-3">
            {tools === null && !listError && <LoadingState label="로컬 Tool 목록을 불러오는 중..." />}
            {listError && <ErrorBanner message={listError} />}
            {tools !== null && tools.length === 0 && !listError && (
              <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-caption text-text-secondary">
                <p>등록된 로컬 Tool이 없습니다. 자산 허브 &gt; 로컬 Tool에서 먼저 Python 파일을 추가하세요.</p>
                {mcpToolsSummary &&
                  (() => {
                    const notice = describeMcpToolsNoticeForEmptyState(mcpToolsSummary);
                    return notice ? <p className="mt-2 text-text-muted">{notice}</p> : null;
                  })()}
              </div>
            )}
            {tools !== null && tools.length > 0 && (
              <ul className="space-y-1.5">
                {tools.map((tool) => (
                  <li key={tool.id}>
                    <button
                      type="button"
                      onClick={() => selectTool(tool)}
                      className="w-full rounded-lg border border-border px-3 py-2 text-left transition-colors hover:border-brand-300 hover:bg-brand-50"
                    >
                      <span className="flex items-center gap-1.5 text-body font-semibold text-text-primary">
                        <FileCode2 size={13} className="shrink-0" /> {tool.functionName}
                      </span>
                      <span className="mt-0.5 block truncate text-caption text-text-muted">{tool.filePath}</span>
                      <span className="mt-0.5 block text-caption text-text-secondary">
                        파라미터 {tool.parameters.length}개 · 추가됨 {formatDateTime(tool.addedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end">
              <Button variant="secondary" onClick={close}>
                취소
              </Button>
            </div>
          </div>
        )}

        {step === "filling" && selectedTool && (
          <div className="space-y-3">
            {selectedTool.parameters.length === 0 ? (
              <p className="text-caption text-text-secondary">이 Tool은 인자가 없습니다.</p>
            ) : (
              <div className="space-y-2">
                {selectedTool.parameters.map((param) => {
                  const kind = fieldKindForSchemaType(param.schemaType);
                  return (
                    <div key={param.name}>
                      <label
                        className="mb-1 block text-caption font-semibold text-text-muted"
                        htmlFor={`chat-local-tool-arg-${param.name}`}
                      >
                        {param.name} ({param.schemaType}){param.required && <span className="text-danger"> *</span>}
                      </label>
                      {kind === "boolean" ? (
                        <select
                          id={`chat-local-tool-arg-${param.name}`}
                          value={formValues[param.name] ?? "false"}
                          onChange={(e) => setFormValues((prev) => ({ ...prev, [param.name]: e.target.value }))}
                          className="h-10 w-full rounded-lg border border-border px-3 text-sm text-text-primary"
                        >
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : kind === "json" ? (
                        <textarea
                          id={`chat-local-tool-arg-${param.name}`}
                          value={formValues[param.name] ?? ""}
                          onChange={(e) => setFormValues((prev) => ({ ...prev, [param.name]: e.target.value }))}
                          placeholder="JSON 값 (예: [1, 2, 3])"
                          rows={2}
                          className="w-full rounded-lg border border-border px-3 py-2 text-sm text-text-primary"
                        />
                      ) : (
                        <input
                          id={`chat-local-tool-arg-${param.name}`}
                          type={kind === "number" ? "number" : "text"}
                          value={formValues[param.name] ?? ""}
                          onChange={(e) => setFormValues((prev) => ({ ...prev, [param.name]: e.target.value }))}
                          className="h-10 w-full rounded-lg border border-border px-3 text-sm text-text-primary"
                        />
                      )}
                      {fieldErrors[param.name] && (
                        <p className="mt-1 text-caption text-danger">{fieldErrors[param.name]}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={close}>
                취소
              </Button>
              <Button variant="primary" onClick={proceedToConfirm}>
                다음: 확인
              </Button>
            </div>
          </div>
        )}

        {step === "confirming" && selectedTool && (
          <div className="space-y-3">
            <p className="text-body text-text-primary">다음 파일을, 다음 인자로 실행합니다:</p>
            <p className="break-all rounded-lg border border-border bg-slate-50 px-3 py-2 font-mono text-caption text-text-primary">
              {selectedTool.filePath}
            </p>
            <pre className="overflow-x-auto rounded-lg border border-border bg-slate-50 px-3 py-2 text-caption text-text-primary">
              {formatArgsForConfirm(buildLocalToolArgs(selectedTool, formValues).args ?? {})}
            </pre>
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-caption text-warning">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{NOT_A_SANDBOX_NOTICE}</span>
            </div>
            <p className="text-caption text-text-muted">
              이 Tool이 자산 &gt; 로컬 Tool에서 미리 실행 허용되어 있지 않다면, 실행을 누르면 Desktop 앱이 별도의
              승인 대화상자를 다시 띄웁니다 — 거기서 취소해도 이 Tool은 실행되지 않습니다. 매번 묻지 않게 하려면
              자산 &gt; 로컬 Tool에서 먼저 허용해 두세요.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setStep("filling")}>
                돌아가기
              </Button>
              <Button variant="danger" onClick={() => void execute()}>
                실행
              </Button>
            </div>
          </div>
        )}

        {step === "invoking" && (
          <div className="space-y-3">
            <LoadingState label="승인 대화상자가 뜨면 확인하고 실행하는 중... (Desktop 앱 창을 확인하세요)" />
            {invokeError && <ErrorBanner message={invokeError} />}
            <div className="flex justify-end">
              <Button variant="danger" onClick={() => void requestCancel()} disabled={!invokingId || cancelling}>
                {cancelling ? "중단하는 중..." : "실행 중단"}
              </Button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="space-y-3">
            {invokeError && <ErrorBanner message={invokeError} />}
            {lastOutcome && (
              <div className={`rounded-lg border px-3 py-3 ${OUTCOME_TONE_CLASS[lastOutcome.tone]}`}>
                <p className="font-semibold">{lastOutcome.title}</p>
                <OutcomeDetail outcome={lastOutcome} />
              </div>
            )}
            <p className="text-caption text-text-muted">결과가 대화창에도 기록되었습니다.</p>
            <div className="flex justify-end">
              <Button variant="primary" onClick={close}>
                닫기
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
