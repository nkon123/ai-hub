// D14 — scheduled-run local-tool path. Structurally separate from the
// interactive `electron/main.ts` `localTool:invoke` IPC handler: this module
// never touches `dialog.showMessageBox` and never consults
// `LocalToolStore`'s per-tool `approval`/hash-binding mechanism. That is an
// explicit product decision (Task Brief F), not an oversight — there is no
// human present to answer a native dialog when a schedule fires
// unattended, so the safety gate moves entirely to schedule
// creation/edit time (`ScheduleStore.saveWithToolRiskAck`, F's structural
// gate). Naming this function `invokeLocalToolForScheduledRun` (distinct
// from `runInvokeLocalTool`/interactive `localTool:invoke`) keeps the two
// paths visibly separate for a reviewer — grep for either name and you land
// in exactly one of these two call sites, never both.
//
// Tool SELECTION still goes through `routeLocalToolCall` (same pure routing
// module the chat auto-route path uses) — a scheduled recipe with
// `localToolRouteActive: true` proposes at most one tool call per fire,
// exactly like a live chat turn's auto-route branch, never a batch of calls.
import { routeLocalToolCall, type LocalToolRouteCandidate } from "./local-tool-router";
import { invokeLocalTool, type InvokeLocalToolTarget } from "./local-tool-runner";
import type { LocalTool, LocalToolInvocationResult, ScheduleLocalToolInvocationRecord } from "./types";

export interface ScheduledLocalToolOutcome {
  /** `true` only when a tool was actually selected AND ran successfully. A
   * recipe that (correctly) declines to call any tool this turn is still
   * `ok: true` with `invocation: null` — "no tool was needed" is success,
   * not failure (mirrors `local-tool-router.ts`'s own
   * "실패보다 누락이 안전합니다" rule). */
  ok: boolean;
  invocation: ScheduleLocalToolInvocationRecord | null;
  resultSummary: string | null;
  failureReason: string | null;
}

function summarizeInvocationResult(result: LocalToolInvocationResult): { ok: boolean; summary: string | null; failure: string | null } {
  switch (result.outcome) {
    case "success":
      return { ok: true, summary: typeof result.result === "string" ? result.result : JSON.stringify(result.result), failure: null };
    case "function_error":
      return { ok: false, summary: null, failure: `Tool 함수 오류: ${result.errorType} — ${result.errorMessage}` };
    case "nonzero_exit":
      return { ok: false, summary: null, failure: `Tool 프로세스가 비정상 종료했습니다 (exit ${result.exitCode}).` };
    case "timeout":
      return { ok: false, summary: null, failure: `Tool 실행이 ${result.timeoutMs}ms 안에 끝나지 않았습니다.` };
    case "oversized_output":
      return { ok: false, summary: null, failure: `Tool 출력이 허용 크기(${result.limitBytes} bytes)를 넘었습니다.` };
    case "spawn_error":
      return { ok: false, summary: null, failure: `Tool을 실행하지 못했습니다: ${result.message}` };
    case "interpreter_not_configured":
      return { ok: false, summary: null, failure: "Python 인터프리터 경로가 설정되지 않았습니다." };
    case "user_denied":
      // 스케줄 실행에서는 절대 발생하지 않는다(이 경로는 대화상자를 아예
      // 띄우지 않는다) — 타입 완전성을 위해서만 처리한다.
      return { ok: false, summary: null, failure: "실행이 거부되었습니다." };
    default:
      return { ok: false, summary: null, failure: "알 수 없는 실행 결과입니다." };
  }
}

/** 로컬 Ollama에게 이번 질문에 맞는 로컬 Tool을 최대 하나 제안받고(라우팅
 * 실패/거절/스키마 불일치는 전부 "Tool 없이 넘어감"으로 귀결 —
 * `local-tool-router.ts`의 규율 그대로), 제안이 있으면 승인 대화상자 없이
 * 즉시 실행한다(F — 스케줄 생성/수정 시점의 확인이 이 실행 시점의 확인을
 * 대신한다). `LocalToolStore.approval`은 이 경로에서 전혀 읽지 않는다 —
 * 그 필드는 대화형 실행 전용이다. */
export async function invokeLocalToolForScheduledRun(
  question: string,
  registeredTools: LocalTool[],
  options: { ollamaBaseUrl: string; chatModelAlias: string; interpreterPath: string | null; signal?: AbortSignal },
): Promise<ScheduledLocalToolOutcome> {
  const candidates: LocalToolRouteCandidate[] = registeredTools.map((tool) => ({
    id: tool.id,
    toolName: tool.toolName,
    functionName: tool.functionName,
    inputSchema: tool.inputSchema,
  }));

  const routed = await routeLocalToolCall(question, candidates, {
    baseUrl: options.ollamaBaseUrl,
    preferredModel: options.chatModelAlias,
  });

  if (routed.status !== "ran" || !routed.toolId || !routed.toolName || !routed.args) {
    // no_candidates / declined_by_model / unparseable / unknown_tool_name /
    // error_or_timeout / schema_invalid — 전부 "이번 실행은 Tool을 호출하지
    // 않았다"로 귀결된다. 이것은 실패가 아니다(Task Brief: 재시도해도 같은
    // 결과가 나올 거절을 실패로 취급하지 않는다) — Knowledge/일반 대화 결과가
    // 이 실행의 실제 답을 이미 담고 있을 수 있으므로 여기서는 그저 "Tool
    // 없음"만 보고한다.
    return { ok: true, invocation: null, resultSummary: null, failureReason: null };
  }

  const target = registeredTools.find((t) => t.id === routed.toolId);
  if (!target) {
    return { ok: false, invocation: null, resultSummary: null, failureReason: "라우팅된 Tool을 더 이상 찾을 수 없습니다." };
  }

  const invokeTarget: InvokeLocalToolTarget = {
    interpreterPath: options.interpreterPath,
    modulePath: target.filePath,
    functionName: target.functionName,
    args: routed.args,
  };
  const result = await invokeLocalTool(invokeTarget);
  const { ok, summary, failure } = summarizeInvocationResult(result);
  return {
    ok,
    invocation: { toolName: routed.toolName, args: routed.args },
    resultSummary: summary,
    failureReason: failure,
  };
}
