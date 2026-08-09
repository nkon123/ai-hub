// D06 대화/실행의 실행 상태 표시(준비/분석/지식 검색/Tool 실행/답변 생성) —
// 02-desktop-and-agent-runtime.md §D06의 5단계를 services/agent-runtime의
// SSE 이벤트(workflow.py)로부터 파생하는 순수 상태 머신.
//
// agent-runtime은 이 5단계에 정확히 대응하는 이벤트를 보내지 않는다 —
// 실제로 방출되는 이벤트는 run.started / preflight.completed /
// knowledge.search.started|completed / citation.added / mcp.call.started|
// completed / mcp.confirmation_required|resolved|expired / answer.delta /
// run.completed|failed|cancelled 뿐이다. 아래 매핑은 그 이벤트 순서
// (workflow.py의 실제 실행 순서: INPUT_VALIDATE -> PREPARE ->
// ANALYZE(암묵적) -> KNOWLEDGE_SEARCH -> TOOL_CONFIRM(선택, §5.3
// WAITING_FOR_USER) -> MCP_TOOL_CALL -> ANSWER_GENERATE -> OUTPUT_VALIDATE
// -> COMPLETE)를 기준으로 한 것이지, Runtime이 별도로 보장하는 계약이 아니다.
//
// Desktop의 D06 화면은 정식 MCP Tool 선택 UI를 만들지 않는다(Service
// Registry가 없어 어떤 Service가 어떤 Tool을 허용하는지 조회할 방법이 없음 —
// open-decisions.md D-058) — 실제 통상 대화는 여전히 항상
// agent_profile=standard-agent이며 tool_call은 "skipped"로 남는다. D06의
// 확인 Panel(WAITING_FOR_USER) 자체를 실제로 검증하기 위한 "개발 확인용"
// 입력만 예외적으로 agent_profile=standard-db-agent + Tool 요청을 보낼 수
// 있게 하며(ChatScreen.tsx), 그 경로에서는 아래 mcp.* 이벤트들이 tool_call을
// 실제로 구동한다.

export type StageId = "ready" | "analyze" | "knowledge_search" | "tool_call" | "answer_generate";

// "waiting" is distinct from "active" — it means the Run is parked in
// WAITING_FOR_USER (02-desktop-and-agent-runtime.md §5.3), not making
// progress on its own until a 승인/거부 decision arrives.
export type StageState = "pending" | "active" | "done" | "skipped" | "error" | "cancelled" | "waiting";

export const STAGE_ORDER: StageId[] = ["ready", "analyze", "knowledge_search", "tool_call", "answer_generate"];

export const STAGE_LABELS: Record<StageId, string> = {
  ready: "준비",
  analyze: "분석",
  knowledge_search: "지식 검색",
  tool_call: "Tool 실행",
  answer_generate: "답변 생성",
};

export type StageMap = Record<StageId, StageState>;

export function initialStages(): StageMap {
  return {
    ready: "pending",
    analyze: "pending",
    knowledge_search: "pending",
    tool_call: "skipped",
    answer_generate: "pending",
  };
}

/** Marks whichever stage is currently "active" (or "waiting" — a Run can end
 * via timeout/cancel while parked in WAITING_FOR_USER) with `terminalState`,
 * and any stage after it in STAGE_ORDER that never started ("pending") as
 * "skipped" — used for every run-ending transition (success/failure/cancel). */
function terminateRun(stages: StageMap, terminalState: StageState): StageMap {
  const next = { ...stages };
  let pastActive = false;
  for (const id of STAGE_ORDER) {
    if (next[id] === "active" || next[id] === "waiting") {
      next[id] = terminalState;
      pastActive = true;
    } else if (pastActive && next[id] === "pending") {
      next[id] = "skipped";
    }
  }
  return next;
}

/** Transition into `tool_call` (either "waiting" for a confirmation pause,
 * or "active" for a NEVER-policy/pre-confirmed dispatch) — resolves whatever
 * came before it (`analyze`/`knowledge_search`, if still "active") to "done",
 * and un-does `knowledge.search.completed`'s optimistic `answer_generate`
 * promotion (MCP_TOOL_CALL runs *after* KNOWLEDGE_SEARCH but *before*
 * ANSWER_GENERATE in the pipeline — 02-...md §5.2). */
function enterToolCall(stages: StageMap, toolCallState: "waiting" | "active"): StageMap {
  const next = { ...stages };
  if (next.analyze === "active") next.analyze = "done";
  if (next.knowledge_search === "active") next.knowledge_search = "done";
  if (next.answer_generate === "active") next.answer_generate = "pending";
  next.tool_call = toolCallState;
  return next;
}

/** Pure reducer: given the current stage map and one SSE event (name + parsed
 * JSON data), returns the next stage map. Unknown event names are a no-op —
 * new event types the Runtime might add later never crash this reducer, they
 * simply don't move the indicator (safer than guessing). */
export function applyRuntimeEvent(stages: StageMap, event: string, data: unknown): StageMap {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (event) {
    case "run.started":
      return { ...stages, ready: "active" };

    case "preflight.completed":
      if (d.passed === false) {
        return terminateRun(stages, "error");
      }
      return { ...stages, ready: "done", analyze: "active" };

    case "knowledge.search.started":
      return { ...stages, analyze: "done", knowledge_search: "active" };

    case "knowledge.search.completed":
      return {
        ...stages,
        knowledge_search: "done",
        answer_generate: stages.answer_generate === "pending" ? "active" : stages.answer_generate,
      };

    case "mcp.confirmation_required":
      // §5.3 RUNNING -> WAITING_FOR_USER: the Run is parked, waiting for an
      // explicit 승인/거부 decision (D06 확인 Panel).
      return enterToolCall(stages, "waiting");

    case "mcp.confirmation_resolved":
      if (d.decision === "approve") {
        // Dispatch is imminent — `mcp.call.started` will follow.
        return { ...stages, tool_call: "active" };
      }
      // Denial is a first-class outcome (D-052 후속): no further Tool event
      // will arrive, so resolve tool_call here rather than waiting for
      // run.completed/failed to catch a "waiting" stage that will never
      // change on its own again.
      return { ...stages, tool_call: "done" };

    case "mcp.call.started":
      // Reached directly (no confirmation pause) for a NEVER-policy Tool, or
      // one the caller had already pre-confirmed.
      return stages.tool_call === "active" ? stages : enterToolCall(stages, "active");

    case "mcp.call.completed":
      if (d.success === false) {
        // Leave tool_call "active" — the imminent `run.failed` event's
        // terminateRun() resolves it to "error" uniformly (same pattern
        // knowledge_search's failure path already relies on: no dedicated
        // failure event of its own, just no "completed" before run.failed).
        return stages;
      }
      return {
        ...stages,
        tool_call: "done",
        answer_generate: stages.answer_generate === "pending" ? "active" : stages.answer_generate,
      };

    case "answer.delta":
      // Idempotent: the first token flips whatever preceded it (analyze/
      // knowledge_search, in case they were still marked active — e.g. an
      // MCP-only path with no knowledge search at all) to "done" and enters
      // answer_generate; subsequent tokens are a no-op once already active.
      if (stages.answer_generate === "active") return stages;
      return terminateAllActiveInto(stages, "done", "answer_generate");

    case "run.completed":
      if (d.status === "INSUFFICIENT_EVIDENCE") {
        // The workflow's hallucination guard (D-036) terminates *before*
        // ANSWER_GENERATE ever runs when there is zero evidence — so that
        // stage was never reached and must read "skipped", not "done".
        const next = { ...stages };
        if (next.ready === "active") next.ready = "done";
        if (next.analyze === "active") next.analyze = "done";
        if (next.knowledge_search === "active") next.knowledge_search = "done";
        if (next.tool_call === "active" || next.tool_call === "waiting") next.tool_call = "done";
        if (next.answer_generate === "pending" || next.answer_generate === "active") {
          next.answer_generate = "skipped";
        }
        return next;
      }
      return terminateRun(stages, "done");

    case "run.failed":
      return terminateRun(stages, "error");

    case "run.cancelled":
      return terminateRun(stages, "cancelled");

    default:
      return stages;
  }
}

/** Helper for the `answer.delta` case: marks every currently-"active" stage
 * as `doneState` and activates `enter`. */
function terminateAllActiveInto(stages: StageMap, doneState: StageState, enter: StageId): StageMap {
  const next = { ...stages };
  for (const id of STAGE_ORDER) {
    if (next[id] === "active") next[id] = doneState;
  }
  next[enter] = "active";
  return next;
}
