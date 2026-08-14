// D06 대화/실행의 실행 상태 표시(준비/분석/지식 선택/지식 검색/Tool 실행/답변 생성) —
// 02-desktop-and-agent-runtime.md §D06의 단계를 services/agent-runtime의
// SSE 이벤트(workflow.py)로부터 파생하는 순수 상태 머신.
//
// agent-runtime은 이 단계들에 정확히 대응하는 이벤트를 보내지 않는다 —
// 실제로 방출되는 이벤트는 run.started / preflight.completed /
// knowledge.route.selected / knowledge.search.started|completed /
// citation.added / mcp.call.started|completed / mcp.confirmation_required|
// resolved|expired / answer.delta / run.completed|failed|cancelled 뿐이다.
// 아래 매핑은 그 이벤트 순서(workflow.py의 실제 실행 순서: INPUT_VALIDATE ->
// PREPARE -> ANALYZE(암묵적) -> KNOWLEDGE_ROUTE(agentic 선택, 후보를 보낸
// 턴만) -> KNOWLEDGE_SEARCH -> TOOL_CONFIRM(선택, §5.3 WAITING_FOR_USER) ->
// MCP_TOOL_CALL -> ANSWER_GENERATE -> OUTPUT_VALIDATE -> COMPLETE)를 기준으로
// 한 것이지, Runtime이 별도로 보장하는 계약이 아니다.
//
// KNOWLEDGE_ROUTE에는 전용 시작 이벤트가 없다 — `knowledge.route.selected`
// 하나가 그 단계 전체(시작+종료)를 대신한다. 이 화면이 실제로 후보
// (`knowledge_candidates`)를 보냈는지는 서버 이벤트가 아니라 이 화면 자신이
// 이미 알고 있으므로(무엇을 보냈는지는 클라이언트가 결정한다),
// `initialStages({ routingExpected })`로 그 사실을 미리 심어 둔다 —
// `preflight.completed`가 이 단계를 "active"로 밀어 넣는 것은 그 키가 이미
// 존재할 때뿐이다. 후보를 보내지 않은 턴은 이 키 자체가 없다("건너뜀"으로
// 회색 표시되는 게 아니라 아예 나타나지 않는다 — 요구사항: "선택하지 않은
// 턴에는 이 단계가 아예 보이면 안 된다").
//
// Desktop의 D06 화면은 정식 MCP Tool 선택 UI를 만들지 않는다(Service
// Registry가 없어 어떤 Service가 어떤 Tool을 허용하는지 조회할 방법이 없음 —
// open-decisions.md D-058) — 실제 통상 대화는 여전히 항상
// agent_profile=standard-agent이며 tool_call은 "skipped"로 남는다. D06의
// 확인 Panel(WAITING_FOR_USER) 자체를 실제로 검증하기 위한 "개발 확인용"
// 입력만 예외적으로 agent_profile=standard-db-agent + Tool 요청을 보낼 수
// 있게 하며(ChatScreen.tsx), 그 경로에서는 아래 mcp.* 이벤트들이 tool_call을
// 실제로 구동한다.

export type StageId = "ready" | "analyze" | "routing" | "knowledge_search" | "tool_call" | "answer_generate";

// "waiting" is distinct from "active" — it means the Run is parked in
// WAITING_FOR_USER (02-desktop-and-agent-runtime.md §5.3), not making
// progress on its own until a 승인/거부 decision arrives.
export type StageState = "pending" | "active" | "done" | "skipped" | "error" | "cancelled" | "waiting";

export const STAGE_ORDER: StageId[] = ["ready", "analyze", "routing", "knowledge_search", "tool_call", "answer_generate"];

// Noun labels — used for every state except "active" (see STAGE_ACTIVE_LABELS
// below for that one case), and as the fallback when a stage has no more
// specific active-voice phrasing of its own.
export const STAGE_LABELS: Record<StageId, string> = {
  ready: "준비",
  analyze: "분석",
  routing: "지식 선택",
  knowledge_search: "지식 검색",
  tool_call: "Tool 실행",
  answer_generate: "답변 생성",
};

// Active-voice progress phrasing, distinct register from the noun labels
// above — shown only while a stage is `active`, and only for stages that
// have something meaningful to narrate mid-flight. `ready`/`analyze`/
// `tool_call` deliberately have no entry here: there is nothing more
// specific to say while "active" than the noun label already says (요구사항:
// "Do not invent phrasing for states that have no meaningful progress").
export const STAGE_ACTIVE_LABELS: Partial<Record<StageId, string>> = {
  routing: "관련 지식을 찾고 있습니다",
  knowledge_search: "관련 지식에서 항목을 추출하고 있습니다",
  answer_generate: "답변을 작성하고 있습니다",
};

export interface StageEntry {
  state: StageState;
  /** Factual, number-bearing context to show alongside the label — set only
   * once the driving SSE event's payload actually carried the number(s);
   * never a guessed or zero-filled placeholder (absent data means no
   * `detail`, not a "0"). Populated for:
   * - `routing`: candidate counts from `knowledge.route.selected`.
   * - `knowledge_search`: evidence/citation tally from `citation.added`
   *   (running count) and `knowledge.search.completed` (server total). */
  detail?: string;
  /** `knowledge_search` only — the running evidence count backing `detail`,
   * kept as a plain number so the next `citation.added` can increment it
   * without parsing the rendered string back out. Not meant to be read by
   * callers directly; use `detail` for display. */
  evidenceCount?: number;
}

// `routing` is the one stage that may not exist at all for a given turn (the
// turn never sent `knowledge_candidates`) — every other stage is always
// present, so callers do not need null-checks for them.
type CoreStageId = Exclude<StageId, "routing">;
export type StageMap = Record<CoreStageId, StageEntry> & { routing?: StageEntry };

/** Renders the pill text for one stage: the in-progress phrasing while
 * `active` (falling back to the noun label for stages with no active-voice
 * phrasing of their own), or the noun label for every other state — with the
 * factual `detail` (if any) appended. Pure formatting; callers render the
 * returned string verbatim rather than re-deriving it. */
export function describeStage(stage: StageId, entry: StageEntry): string {
  const base = entry.state === "active" ? (STAGE_ACTIVE_LABELS[stage] ?? STAGE_LABELS[stage]) : STAGE_LABELS[stage];
  return entry.detail ? `${base} · ${entry.detail}` : base;
}

export function initialStages(options?: { routingExpected?: boolean }): StageMap {
  const stages: StageMap = {
    ready: { state: "pending" },
    analyze: { state: "pending" },
    knowledge_search: { state: "pending" },
    tool_call: { state: "skipped" },
    answer_generate: { state: "pending" },
  };
  // Only present when this turn actually sent `knowledge_candidates` — the
  // renderer knows this before the Run even starts (it built the request),
  // so it is threaded in here rather than guessed from an event.
  if (options?.routingExpected) {
    stages.routing = { state: "pending" };
  }
  return stages;
}

/** Knowledge 검색과 Tool 실행을 거치지 않는 Ollama 일반 대화 단계. */
export function ollamaChatStages(state: "running" | "succeeded" | "failed" | "cancelled"): StageMap {
  const answerState: StageState =
    state === "running" ? "active" : state === "succeeded" ? "done" : state === "failed" ? "error" : "cancelled";
  return {
    ready: { state: "done" },
    analyze: { state: "done" },
    knowledge_search: { state: "skipped" },
    tool_call: { state: "skipped" },
    answer_generate: { state: answerState },
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
    const entry = next[id];
    if (!entry) continue; // "routing" absent for this turn — nothing to terminate.
    if (entry.state === "active" || entry.state === "waiting") {
      next[id] = { ...entry, state: terminalState };
      pastActive = true;
    } else if (pastActive && entry.state === "pending") {
      next[id] = { ...entry, state: "skipped" };
    }
  }
  return next;
}

/** Transition into `tool_call` (either "waiting" for a confirmation pause,
 * or "active" for a NEVER-policy/pre-confirmed dispatch) — resolves whatever
 * came before it (`analyze`/`routing`/`knowledge_search`, if still "active")
 * to "done", and un-does `knowledge.search.completed`'s optimistic
 * `answer_generate` promotion (MCP_TOOL_CALL runs *after* KNOWLEDGE_SEARCH
 * but *before* ANSWER_GENERATE in the pipeline — 02-...md §5.2). */
function enterToolCall(stages: StageMap, toolCallState: "waiting" | "active"): StageMap {
  const next = { ...stages };
  if (next.analyze.state === "active") next.analyze = { ...next.analyze, state: "done" };
  if (next.routing && next.routing.state === "active") next.routing = { ...next.routing, state: "done" };
  if (next.knowledge_search.state === "active") next.knowledge_search = { ...next.knowledge_search, state: "done" };
  if (next.answer_generate.state === "active") next.answer_generate = { ...next.answer_generate, state: "pending" };
  next.tool_call = { state: toolCallState };
  return next;
}

/** `knowledge.route.selected`'s payload — mirrors
 * `chatTypes.ts`'s `KnowledgeRouteEventData` (kept structurally compatible,
 * not imported, to avoid a renderer-module -> pure-module dependency). */
interface RouteSelectedPayload {
  status?: unknown;
  selected?: unknown;
  excluded?: unknown;
}

/** Resolves the `routing` stage from a `knowledge.route.selected` event.
 * Honest per-status mapping (요구사항 — never let a fallback look like a
 * successful selection):
 * - `"ran"`: an actual automatic selection happened -> "done".
 * - `"skipped"`: too few candidates to bother routing -> "skipped" (nothing
 *   was decided, so this is NOT "done").
 * - `"fallback"`: automatic selection failed -> "done" (the Run still
 *   proceeded), but the detail line says so plainly and says everything was
 *   searched instead.
 * Counts (candidates considered / selected) come only from the payload's own
 * `selected`/`excluded` arrays — if either is missing/malformed the stage
 * state still resolves honestly, just without a `detail` number. */
function resolveRouting(current: StageEntry, data: RouteSelectedPayload): StageEntry {
  const status = data.status;
  const selected = Array.isArray(data.selected) ? data.selected : null;
  const excluded = Array.isArray(data.excluded) ? data.excluded : null;
  const considered = selected && excluded ? selected.length + excluded.length : null;

  let state: StageState = current.state;
  let detail: string | undefined;
  if (status === "ran") {
    state = "done";
    if (selected && considered !== null) detail = `후보 ${considered}개 중 ${selected.length}개 선택`;
  } else if (status === "skipped") {
    state = "skipped";
    if (considered !== null) detail = `자동 선택 없이 전체 ${considered}개 검색`;
  } else if (status === "fallback") {
    state = "done";
    detail = considered !== null ? `자동 선택에 실패해 전체 ${considered}개를 검색했습니다` : "자동 선택에 실패해 전체를 검색했습니다";
  }
  return { state, detail };
}

/** Pure reducer: given the current stage map and one SSE event (name + parsed
 * JSON data), returns the next stage map. Unknown event names are a no-op —
 * new event types the Runtime might add later never crash this reducer, they
 * simply don't move the indicator (safer than guessing). */
export function applyRuntimeEvent(stages: StageMap, event: string, data: unknown): StageMap {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (event) {
    case "run.started":
      return { ...stages, ready: { state: "active" } };

    case "preflight.completed":
      if (d.passed === false) {
        return terminateRun(stages, "error");
      }
      return {
        ...stages,
        ready: { state: "done" },
        analyze: { state: "active" },
        // KNOWLEDGE_ROUTE has no dedicated start event of its own — it runs
        // between preflight and knowledge.search.started, so it enters
        // "active" here too, but only for turns that actually sent
        // candidates (the `routing` key only exists then).
        ...(stages.routing ? { routing: { state: "active" as const } } : {}),
      };

    case "knowledge.route.selected":
      // No `routing` key means this turn never sent `knowledge_candidates` —
      // the stage must not appear at all, so there is nothing to resolve.
      if (!stages.routing) return stages;
      return { ...stages, routing: resolveRouting(stages.routing, d as RouteSelectedPayload) };

    case "knowledge.search.started":
      return {
        ...stages,
        analyze: { state: "done" },
        // Defensive: normally `knowledge.route.selected` has already
        // resolved `routing` by the time search starts. If it somehow
        // hasn't (unexpected event ordering), don't leave the indicator
        // spinning forever — resolve it "done" with no invented count.
        ...(stages.routing && stages.routing.state === "active" ? { routing: { state: "done" as const } } : {}),
        knowledge_search: { state: "active" },
      };

    case "citation.added": {
      // Running evidence tally while knowledge_search is in flight — each
      // citation.added is one more piece of evidence actually gathered.
      const count = (stages.knowledge_search.evidenceCount ?? 0) + 1;
      return {
        ...stages,
        knowledge_search: { ...stages.knowledge_search, evidenceCount: count, detail: `${count}건 확보` },
      };
    }

    case "knowledge.search.completed": {
      // Prefer the server's own citation_count (exact total) over the
      // client-side running tally; fall back to the tally if the payload
      // didn't carry one, and to no number at all if neither is known.
      const citationCount = typeof d.citation_count === "number" ? d.citation_count : stages.knowledge_search.evidenceCount;
      return {
        ...stages,
        knowledge_search: {
          state: "done",
          evidenceCount: citationCount,
          detail: citationCount !== undefined ? `${citationCount}건 확보` : undefined,
        },
        answer_generate: stages.answer_generate.state === "pending" ? { state: "active" } : stages.answer_generate,
      };
    }

    case "mcp.confirmation_required":
      // §5.3 RUNNING -> WAITING_FOR_USER: the Run is parked, waiting for an
      // explicit 승인/거부 decision (D06 확인 Panel).
      return enterToolCall(stages, "waiting");

    case "mcp.confirmation_resolved":
      if (d.decision === "approve") {
        // Dispatch is imminent — `mcp.call.started` will follow.
        return { ...stages, tool_call: { state: "active" } };
      }
      // Denial is a first-class outcome (D-052 후속): no further Tool event
      // will arrive, so resolve tool_call here rather than waiting for
      // run.completed/failed to catch a "waiting" stage that will never
      // change on its own again.
      return { ...stages, tool_call: { state: "done" } };

    case "mcp.call.started":
      // Reached directly (no confirmation pause) for a NEVER-policy Tool, or
      // one the caller had already pre-confirmed.
      return stages.tool_call.state === "active" ? stages : enterToolCall(stages, "active");

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
        tool_call: { state: "done" },
        answer_generate: stages.answer_generate.state === "pending" ? { state: "active" } : stages.answer_generate,
      };

    case "answer.delta":
      // Idempotent: the first token flips whatever preceded it (analyze/
      // routing/knowledge_search, in case they were still marked active —
      // e.g. an MCP-only path with no knowledge search at all) to "done" and
      // enters answer_generate; subsequent tokens are a no-op once already
      // active.
      if (stages.answer_generate.state === "active") return stages;
      return terminateAllActiveInto(stages, "done", "answer_generate");

    case "run.completed":
      if (d.status === "INSUFFICIENT_EVIDENCE") {
        // The workflow's hallucination guard (D-036) terminates *before*
        // ANSWER_GENERATE ever runs when there is zero evidence — so that
        // stage was never reached and must read "skipped", not "done".
        const next = { ...stages };
        if (next.ready.state === "active") next.ready = { ...next.ready, state: "done" };
        if (next.analyze.state === "active") next.analyze = { ...next.analyze, state: "done" };
        if (next.routing && next.routing.state === "active") next.routing = { ...next.routing, state: "done" };
        if (next.knowledge_search.state === "active") next.knowledge_search = { ...next.knowledge_search, state: "done" };
        if (next.tool_call.state === "active" || next.tool_call.state === "waiting") {
          next.tool_call = { ...next.tool_call, state: "done" };
        }
        if (next.answer_generate.state === "pending" || next.answer_generate.state === "active") {
          next.answer_generate = { ...next.answer_generate, state: "skipped" };
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
    const entry = next[id];
    if (entry && entry.state === "active") next[id] = { ...entry, state: doneState };
  }
  const enterEntry = next[enter];
  if (enterEntry) next[enter] = { ...enterEntry, state: "active" };
  return next;
}
