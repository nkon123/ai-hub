import { describe, expect, it } from "vitest";
import { applyRuntimeEvent, initialStages, ollamaChatStages } from "./runStages";

describe("ollamaChatStages", () => {
  it("skips Knowledge and Tool stages for a successful Ollama-only chat", () => {
    expect(ollamaChatStages("succeeded")).toEqual({
      ready: "done",
      analyze: "done",
      knowledge_search: "skipped",
      tool_call: "skipped",
      answer_generate: "done",
    });
  });

  it("represents cancellation while Ollama is generating an answer", () => {
    expect(ollamaChatStages("cancelled").answer_generate).toBe("cancelled");
  });
});

describe("runStages / applyRuntimeEvent", () => {
  it("progresses through ready -> analyze -> knowledge_search -> answer_generate -> done on a normal success", () => {
    let s = initialStages();
    expect(s).toEqual({
      ready: "pending",
      analyze: "pending",
      knowledge_search: "pending",
      tool_call: "skipped",
      answer_generate: "pending",
    });

    s = applyRuntimeEvent(s, "run.started", {});
    expect(s.ready).toBe("active");

    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    expect(s.ready).toBe("done");
    expect(s.analyze).toBe("active");

    s = applyRuntimeEvent(s, "knowledge.search.started", { knowledge_id: "k1" });
    expect(s.analyze).toBe("done");
    expect(s.knowledge_search).toBe("active");

    s = applyRuntimeEvent(s, "knowledge.search.completed", { citation_count: 2 });
    expect(s.knowledge_search).toBe("done");
    expect(s.answer_generate).toBe("active");

    // citation.added carries no stage transition of its own.
    s = applyRuntimeEvent(s, "citation.added", { chunk_id: "c1" });
    expect(s.answer_generate).toBe("active");

    s = applyRuntimeEvent(s, "answer.delta", { delta: "hi" });
    expect(s.answer_generate).toBe("active");

    s = applyRuntimeEvent(s, "run.completed", { status: "SUCCEEDED", output: { answer: "hi" } });
    expect(s).toEqual({
      ready: "done",
      analyze: "done",
      knowledge_search: "done",
      tool_call: "skipped",
      answer_generate: "done",
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

    expect(s.ready).toBe("done");
    expect(s.analyze).toBe("done");
    expect(s.knowledge_search).toBe("done");
    expect(s.answer_generate).toBe("skipped");
  });

  it("marks the in-flight stage as error and any stage after it as skipped on run.failed", () => {
    let s = initialStages();
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    s = applyRuntimeEvent(s, "knowledge.search.started", {});
    // Search itself fails mid-flight (e.g. search-runtime unreachable) —
    // no knowledge.search.completed event, straight to run.failed.
    s = applyRuntimeEvent(s, "run.failed", { code: "INTERNAL_ERROR", message: "boom" });

    expect(s.ready).toBe("done");
    expect(s.analyze).toBe("done");
    expect(s.knowledge_search).toBe("error");
    expect(s.answer_generate).toBe("skipped");
  });

  it("fails fast at preflight when preflight.completed reports passed:false", () => {
    let s = initialStages();
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: false, checks: [] });
    expect(s.ready).toBe("error");
    expect(s.analyze).toBe("skipped");
    expect(s.knowledge_search).toBe("skipped");
    expect(s.answer_generate).toBe("skipped");
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

    expect(s.answer_generate).toBe("cancelled");
    expect(s.knowledge_search).toBe("done");
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
    expect(s.tool_call).toBe("skipped");
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
    expect(s.analyze).toBe("done");
    expect(s.tool_call).toBe("waiting");

    s = applyRuntimeEvent(s, "mcp.confirmation_resolved", {
      tool_name: "table_count.query",
      decision: "approve",
    });
    expect(s.tool_call).toBe("active");

    s = applyRuntimeEvent(s, "mcp.call.started", { tool_name: "table_count.query" });
    expect(s.tool_call).toBe("active");

    s = applyRuntimeEvent(s, "mcp.call.completed", { tool_name: "table_count.query", success: true });
    expect(s.tool_call).toBe("done");
    expect(s.answer_generate).toBe("active");

    s = applyRuntimeEvent(s, "run.completed", { status: "SUCCEEDED", output: {} });
    expect(s.tool_call).toBe("done");
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
    expect(s.tool_call).toBe("done");

    s = applyRuntimeEvent(s, "run.completed", { status: "INSUFFICIENT_EVIDENCE", output: { citations: [] } });
    expect(s.tool_call).toBe("done");
    expect(s.answer_generate).toBe("skipped");
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
    expect(expired.tool_call).toBe("error");

    const cancelledWhileWaiting = applyRuntimeEvent(waiting, "run.cancelled", { trace_id: "t1" });
    expect(cancelledWhileWaiting.tool_call).toBe("cancelled");
  });

  it("enters tool_call directly as 'active' via mcp.call.started when no confirmation pause occurs (NEVER-policy Tool)", () => {
    let s = initialStages();
    s = applyRuntimeEvent(s, "run.started", {});
    s = applyRuntimeEvent(s, "preflight.completed", { passed: true });
    s = applyRuntimeEvent(s, "mcp.call.started", { tool_name: "db_metadata.get_tables" });
    expect(s.tool_call).toBe("active");
    expect(s.analyze).toBe("done");

    s = applyRuntimeEvent(s, "mcp.call.completed", { tool_name: "db_metadata.get_tables", success: true });
    expect(s.tool_call).toBe("done");
  });
});
