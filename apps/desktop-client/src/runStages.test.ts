import { describe, expect, it } from "vitest";
import { applyRuntimeEvent, describeStage, initialStages, ollamaChatStages, STAGE_ORDER, type StageMap } from "./runStages";

describe("ollamaChatStages", () => {
  it("skips Knowledge and Tool stages for a successful Ollama-only chat", () => {
    expect(ollamaChatStages("succeeded")).toEqual({
      ready: { state: "done" },
      analyze: { state: "done" },
      knowledge_search: { state: "skipped" },
      tool_call: { state: "skipped" },
      answer_generate: { state: "done" },
    });
  });

  it("represents cancellation while Ollama is generating an answer", () => {
    expect(ollamaChatStages("cancelled").answer_generate.state).toBe("cancelled");
  });

  it("never carries a routing stage (Ollama-only never sends knowledge_candidates)", () => {
    expect(ollamaChatStages("running").routing).toBeUndefined();
  });
});

describe("initialStages", () => {
  it("omits the routing stage entirely when routingExpected is not set", () => {
    expect(initialStages().routing).toBeUndefined();
  });

  it("adds a pending routing stage when routingExpected is true", () => {
    expect(initialStages({ routingExpected: true }).routing).toEqual({ state: "pending" });
  });
});

describe("runStages / applyRuntimeEvent", () => {
  it("progresses through ready -> analyze -> knowledge_search -> answer_generate -> done on a normal success", () => {
    let s = initialStages();
    expect(s).toEqual({
      ready: { state: "pending" },
      analyze: { state: "pending" },
      knowledge_search: { state: "pending" },
      tool_call: { state: "skipped" },
      answer_generate: { state: "pending" },
    });

    s = applyRuntimeEvent(s, "run.started", {});
    expect(s.ready.state).toBe("active");

    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    expect(s.ready.state).toBe("done");
    expect(s.analyze.state).toBe("active");

    s = applyRuntimeEvent(s, "knowledge.search.started", { knowledge_id: "k1" });
    expect(s.analyze.state).toBe("done");
    expect(s.knowledge_search.state).toBe("active");

    s = applyRuntimeEvent(s, "knowledge.search.completed", { citation_count: 2 });
    expect(s.knowledge_search.state).toBe("done");
    expect(s.knowledge_search.detail).toBe("2건 확보");
    expect(s.answer_generate.state).toBe("active");

    s = applyRuntimeEvent(s, "answer.delta", { delta: "hi" });
    expect(s.answer_generate.state).toBe("active");

    s = applyRuntimeEvent(s, "run.completed", { status: "SUCCEEDED", output: { answer: "hi" } });
    expect(s).toEqual({
      ready: { state: "done" },
      analyze: { state: "done" },
      knowledge_search: { state: "done", evidenceCount: 2, detail: "2건 확보" },
      tool_call: { state: "skipped" },
      answer_generate: { state: "done" },
    });
  });

  it("marks answer_generate as skipped (never reached) on INSUFFICIENT_EVIDENCE, not done", () => {
    let s = initialStages();
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    s = applyRuntimeEvent(s, "knowledge.search.started", {});
    s = applyRuntimeEvent(s, "knowledge.search.completed", { citation_count: 0 });
    // agent-runtime's hallucination guard (D-036) never emits answer.delta at
    // all in this path — it jumps straight from knowledge.search.completed to
    // run.completed{status: INSUFFICIENT_EVIDENCE}.
    s = applyRuntimeEvent(s, "run.completed", { status: "INSUFFICIENT_EVIDENCE", output: { citations: [] } });

    expect(s.ready.state).toBe("done");
    expect(s.analyze.state).toBe("done");
    expect(s.knowledge_search.state).toBe("done");
    // citation_count: 0 was actually received (not absent) — an honest "0건".
    expect(s.knowledge_search.detail).toBe("0건 확보");
    expect(s.answer_generate.state).toBe("skipped");
  });

  it("marks the in-flight stage as error and any stage after it as skipped on run.failed", () => {
    let s = initialStages();
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    s = applyRuntimeEvent(s, "knowledge.search.started", {});
    // Search itself fails mid-flight (e.g. search-runtime unreachable) —
    // no knowledge.search.completed event, straight to run.failed.
    s = applyRuntimeEvent(s, "run.failed", { code: "INTERNAL_ERROR", message: "boom" });

    expect(s.ready.state).toBe("done");
    expect(s.analyze.state).toBe("done");
    expect(s.knowledge_search.state).toBe("error");
    expect(s.answer_generate.state).toBe("skipped");
  });

  it("fails fast at preflight when preflight.completed reports passed:false", () => {
    let s = initialStages();
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: false, checks: [] });
    expect(s.ready.state).toBe("error");
    expect(s.analyze.state).toBe("skipped");
    expect(s.knowledge_search.state).toBe("skipped");
    expect(s.answer_generate.state).toBe("skipped");
  });

  it("marks the in-flight stage as cancelled and downstream stages as skipped on run.cancelled", () => {
    let s = initialStages();
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    s = applyRuntimeEvent(s, "knowledge.search.started", {});
    s = applyRuntimeEvent(s, "knowledge.search.completed", {});
    // Mid answer generation — this is the D06 requirement "답변 생성 중에도
    // 취소가 가능해야 한다": cancellation must be representable from the
    // answer_generate stage too, not just earlier ones.
    s = applyRuntimeEvent(s, "answer.delta", { delta: "partial" });
    s = applyRuntimeEvent(s, "run.cancelled", { trace_id: "t1" });

    expect(s.answer_generate.state).toBe("cancelled");
    expect(s.knowledge_search.state).toBe("done");
  });

  it("ignores unknown event names without throwing", () => {
    const s = initialStages();
    const next = applyRuntimeEvent(s, "some.future.event", { anything: true });
    expect(next).toEqual(s);
  });

  it("keeps tool_call skipped throughout a knowledge-only run (no MCP tool UI in D06)", () => {
    let s = initialStages();
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    s = applyRuntimeEvent(s, "knowledge.search.started", {});
    s = applyRuntimeEvent(s, "knowledge.search.completed", {});
    s = applyRuntimeEvent(s, "run.completed", { status: "SUCCEEDED", output: {} });
    expect(s.tool_call.state).toBe("skipped");
  });

  it("parks tool_call in 'waiting' on mcp.confirmation_required, then 'active' on approve, then 'done' on success", () => {
    let s = initialStages();
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    s = applyRuntimeEvent(s, "mcp.confirmation_required", {
      tool_name: "table_count.query",
      summary: "'APP.INTERFACE_LOG' 테이블의 데이터 건수를 조회합니다.",
      deadline: "2026-01-01T00:00:00Z",
    });
    expect(s.analyze.state).toBe("done");
    expect(s.tool_call.state).toBe("waiting");

    s = applyRuntimeEvent(s, "mcp.confirmation_resolved", {
      tool_name: "table_count.query",
      decision: "approve",
    });
    expect(s.tool_call.state).toBe("active");

    s = applyRuntimeEvent(s, "mcp.call.started", { tool_name: "table_count.query" });
    expect(s.tool_call.state).toBe("active");

    s = applyRuntimeEvent(s, "mcp.call.completed", { tool_name: "table_count.query", success: true });
    expect(s.tool_call.state).toBe("done");
    expect(s.answer_generate.state).toBe("active");

    s = applyRuntimeEvent(s, "run.completed", { status: "SUCCEEDED", output: {} });
    expect(s.tool_call.state).toBe("done");
  });

  it("resolves tool_call to 'done' (not an error) on deny, and INSUFFICIENT_EVIDENCE leaves it 'done'", () => {
    let s = initialStages();
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    s = applyRuntimeEvent(s, "mcp.confirmation_required", {
      tool_name: "table_count.query",
      summary: "안내 문구",
      deadline: "2026-01-01T00:00:00Z",
    });
    s = applyRuntimeEvent(s, "mcp.confirmation_resolved", {
      tool_name: "table_count.query",
      decision: "deny",
    });
    expect(s.tool_call.state).toBe("done");

    s = applyRuntimeEvent(s, "run.completed", { status: "INSUFFICIENT_EVIDENCE", output: { citations: [] } });
    expect(s.tool_call.state).toBe("done");
    expect(s.answer_generate.state).toBe("skipped");
  });

  it("resolves tool_call (still 'waiting') to 'error'/'cancelled' if the Run fails/cancels while waiting (expiry, or cancel-while-waiting)", () => {
    let waiting = initialStages();
    waiting = applyRuntimeEvent(waiting, "run.started", {});
    waiting = applyRuntimeEvent(waiting, "preflight.completed", { passed: true });
    waiting = applyRuntimeEvent(waiting, "mcp.confirmation_required", {
      tool_name: "table_count.query",
      summary: "안내 문구",
      deadline: "2026-01-01T00:00:00Z",
    });

    const expired = applyRuntimeEvent(waiting, "run.failed", {
      code: "MCP_CONFIRMATION_TIMEOUT",
      message: "시간 초과",
    });
    expect(expired.tool_call.state).toBe("error");

    const cancelledWhileWaiting = applyRuntimeEvent(waiting, "run.cancelled", { trace_id: "t1" });
    expect(cancelledWhileWaiting.tool_call.state).toBe("cancelled");
  });

  it("enters tool_call directly as 'active' via mcp.call.started when no confirmation pause occurs (NEVER-policy Tool)", () => {
    let s = initialStages();
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    s = applyRuntimeEvent(s, "mcp.call.started", { tool_name: "db_metadata.get_tables" });
    expect(s.tool_call.state).toBe("active");
    expect(s.analyze.state).toBe("done");

    s = applyRuntimeEvent(s, "mcp.call.completed", { tool_name: "db_metadata.get_tables", success: true });
    expect(s.tool_call.state).toBe("done");
  });
});

describe("routing stage (KNOWLEDGE_ROUTE / agentic Knowledge selection)", () => {
  it("does not appear at all when this turn never sent knowledge_candidates", () => {
    let s = initialStages(); // routingExpected not set
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    expect(s.routing).toBeUndefined();
    expect(STAGE_ORDER.filter((id) => s[id] !== undefined)).not.toContain("routing");

    // Even if a knowledge.route.selected event somehow arrived (it
    // shouldn't for a candidates-less turn), there is nothing to resolve.
    s = applyRuntimeEvent(s, "knowledge.route.selected", { status: "ran", selected: [], excluded: [] });
    expect(s.routing).toBeUndefined();
  });

  it("enters 'active' on preflight.completed when candidates were sent", () => {
    let s = initialStages({ routingExpected: true });
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    expect(s.routing?.state).toBe("active");
  });

  it("maps status 'ran' to 'done' with considered/selected counts from the payload", () => {
    let s = initialStages({ routingExpected: true });
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    s = applyRuntimeEvent(s, "knowledge.route.selected", {
      status: "ran",
      fallback_reason: null,
      selected: [{ knowledge_id: "k1", reason: "관련성 높음" }],
      excluded: [
        { knowledge_id: "k2", reason: "관련성 낮음" },
        { knowledge_id: "k3", reason: "관련성 낮음" },
      ],
    });
    expect(s.routing).toEqual({ state: "done", detail: "후보 3개 중 1개 선택" });
  });

  it("maps status 'skipped' to 'skipped' state, not 'done' — nothing was actually decided", () => {
    let s = initialStages({ routingExpected: true });
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    s = applyRuntimeEvent(s, "knowledge.route.selected", {
      status: "skipped",
      fallback_reason: null,
      selected: [{ knowledge_id: "k1", reason: "설치된 Knowledge가 적어 자동 선택 없이 전체 검색" }],
      excluded: [],
    });
    expect(s.routing?.state).toBe("skipped");
    expect(s.routing?.detail).toBe("자동 선택 없이 전체 1개 검색");
  });

  it("maps status 'fallback' to 'done' but the detail says selection failed and everything was searched", () => {
    let s = initialStages({ routingExpected: true });
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    s = applyRuntimeEvent(s, "knowledge.route.selected", {
      status: "fallback",
      fallback_reason: "LLM 호출 실패",
      selected: [
        { knowledge_id: "k1", reason: "자동 선택 실패로 전체 검색" },
        { knowledge_id: "k2", reason: "자동 선택 실패로 전체 검색" },
      ],
      excluded: [],
    });
    expect(s.routing?.state).toBe("done");
    expect(s.routing?.detail).toBe("자동 선택에 실패해 전체 2개를 검색했습니다");
  });

  it("resolves routing to 'done' with no invented count if knowledge.search.started arrives first (defensive ordering)", () => {
    let s = initialStages({ routingExpected: true });
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    s = applyRuntimeEvent(s, "knowledge.search.started", {});
    expect(s.routing).toEqual({ state: "done" });
  });

  it("terminates a still-active routing stage as 'error'/'cancelled' on run.failed/run.cancelled", () => {
    let base = initialStages({ routingExpected: true });
    base = applyRuntimeEvent(base, "run.started", {});
    base = applyRuntimeEvent(base, "preflight.completed", { passed: true });
    expect(base.routing?.state).toBe("active");

    const failed = applyRuntimeEvent(base, "run.failed", { code: "INTERNAL_ERROR", message: "boom" });
    expect(failed.routing?.state).toBe("error");

    const cancelled = applyRuntimeEvent(base, "run.cancelled", { trace_id: "t1" });
    expect(cancelled.routing?.state).toBe("cancelled");
  });
});

describe("evidence count (citation.added / knowledge.search.completed)", () => {
  it("builds a running tally from citation.added, one at a time", () => {
    let s = initialStages();
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    s = applyRuntimeEvent(s, "knowledge.search.started", {});
    expect(s.knowledge_search.detail).toBeUndefined();

    s = applyRuntimeEvent(s, "citation.added", { chunk_id: "c1" });
    expect(s.knowledge_search.evidenceCount).toBe(1);
    expect(s.knowledge_search.detail).toBe("1건 확보");

    s = applyRuntimeEvent(s, "citation.added", { chunk_id: "c2" });
    expect(s.knowledge_search.evidenceCount).toBe(2);
    expect(s.knowledge_search.detail).toBe("2건 확보");
  });

  it("never shows a count before any has actually been received (absent, not zero)", () => {
    const s = initialStages();
    expect(s.knowledge_search.detail).toBeUndefined();
    expect(s.knowledge_search.evidenceCount).toBeUndefined();
  });

  it("prefers the server's exact citation_count over the running tally on knowledge.search.completed", () => {
    let s = initialStages();
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    s = applyRuntimeEvent(s, "knowledge.search.started", {});
    s = applyRuntimeEvent(s, "citation.added", { chunk_id: "c1" });
    s = applyRuntimeEvent(s, "knowledge.search.completed", { citation_count: 5 });
    expect(s.knowledge_search.detail).toBe("5건 확보");
    expect(s.knowledge_search.evidenceCount).toBe(5);
  });
});

describe("describeStage", () => {
  it("uses the active-voice phrasing while active, for stages that have one", () => {
    expect(describeStage("routing", { state: "active" })).toBe("관련 지식을 찾고 있습니다");
    expect(describeStage("knowledge_search", { state: "active" })).toBe("관련 지식에서 항목을 추출하고 있습니다");
    expect(describeStage("answer_generate", { state: "active" })).toBe("답변을 작성하고 있습니다");
  });

  it("falls back to the noun label while active for stages with no active-voice phrasing (no invented text)", () => {
    expect(describeStage("ready", { state: "active" })).toBe("준비");
    expect(describeStage("analyze", { state: "active" })).toBe("분석");
    expect(describeStage("tool_call", { state: "active" })).toBe("Tool 실행");
  });

  it("uses the noun label (never the active phrasing) for every non-active state", () => {
    expect(describeStage("knowledge_search", { state: "done" })).toBe("지식 검색");
    expect(describeStage("routing", { state: "skipped" })).toBe("지식 선택");
    expect(describeStage("answer_generate", { state: "pending" })).toBe("답변 생성");
  });

  it("appends the detail line, when present, after the label", () => {
    expect(describeStage("knowledge_search", { state: "active", detail: "2건 확보" })).toBe(
      "관련 지식에서 항목을 추출하고 있습니다 · 2건 확보",
    );
    expect(describeStage("routing", { state: "done", detail: "후보 3개 중 1개 선택" })).toBe(
      "지식 선택 · 후보 3개 중 1개 선택",
    );
  });
});

// Type-only sanity check: StageMap's core keys are always present without a
// null-check, only `routing` is optional. If this ever fails to compile, the
// StageMap contract this whole module (and every consumer) relies on broke.
function _typeCheck(s: StageMap): void {
  const _ready: "pending" | "active" | "done" | "skipped" | "error" | "cancelled" | "waiting" = s.ready.state;
  void _ready;
}
void _typeCheck;
