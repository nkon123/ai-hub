// D-084 후속 2 — 채팅 질문으로 로컬 Tool을 자동 라우팅하는 기능의 핵심
// 안전 속성을 고정한다(Task Brief 검증 항목 3). 이 파일은 electron/node
// import가 없는 순수 모듈을 테스트하므로 실제 Electron/Ollama가 필요 없다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeLocalToolCall, validateLocalToolArgs, type LocalToolRouteCandidate } from "../local-tool-router";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const CANDIDATES: LocalToolRouteCandidate[] = [
  {
    id: "tool-1",
    toolName: "business_days_between",
    functionName: "business_days_between",
    inputSchema: {
      type: "object",
      properties: { start_date: { type: "string" }, end_date: { type: "string" } },
      required: ["start_date", "end_date"],
      additionalProperties: false,
    },
  },
];

function mockOllama(chatResponseContent: string): void {
  global.fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: "exaone3.5:7.8b" }] }), { status: 200 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ message: { content: chatResponseContent } }), { status: 200 }),
    ) as unknown as typeof fetch;
}

describe("routeLocalToolCall — fail-closed on every non-'ran' outcome", () => {
  it("never calls the LLM and reports no_candidates when there are zero candidates", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const result = await routeLocalToolCall("8월 17일과 8월 30일 사이 영업일 수는?", [], {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    expect(result).toEqual({ status: "no_candidates", toolId: null, toolName: null, args: null });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("reports declined_by_model when the model explicitly picks nothing", async () => {
    mockOllama(JSON.stringify({ tool_name: null, input: null }));
    const result = await routeLocalToolCall("오늘 날씨 어때?", CANDIDATES, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    expect(result.status).toBe("declined_by_model");
    expect(result.toolId).toBeNull();
  });

  it("reports unparseable and proposes nothing for garbage output", async () => {
    mockOllama("이건 JSON이 아닙니다");
    const result = await routeLocalToolCall("질문", CANDIDATES, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    expect(result.status).toBe("unparseable");
    expect(result.toolId).toBeNull();
  });

  it("never widens the candidate set — a tool name the model invents outside the candidate list is rejected", async () => {
    mockOllama(JSON.stringify({ tool_name: "rm_rf_everything", input: {} }));
    const result = await routeLocalToolCall("질문", CANDIDATES, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    expect(result.status).toBe("unknown_tool_name");
    expect(result.toolId).toBeNull();
  });

  it("reports error_or_timeout and proposes nothing when the LLM call rejects (e.g. AbortSignal timeout)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const result = await routeLocalToolCall("질문", CANDIDATES, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
      timeoutMs: 50,
    });
    expect(result.status).toBe("error_or_timeout");
    expect(result.toolId).toBeNull();
  });

  it("does not retry a schema validation failure — a single LLM call, and rejection returns schema_invalid without a second fetch", async () => {
    mockOllama(JSON.stringify({ tool_name: "business_days_between", input: { start_date: "2026-08-17" } }));
    const result = await routeLocalToolCall("8월 17일과 8월 30일 사이 영업일 수는?", CANDIDATES, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    expect(result.status).toBe("schema_invalid");
    expect(result.toolId).toBe("tool-1");
    expect(result.args).toBeNull();
    expect(result.schemaErrors).toEqual({ end_date: "필수 입력값이 빠졌습니다." });
    // 정확히 두 번(tags, chat)만 호출되고 검증 실패 후 세 번째 호출(재시도)이 없다.
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("proposes exactly the candidate + validated args on a well-formed model response ('ran')", async () => {
    mockOllama(
      JSON.stringify({
        tool_name: "business_days_between",
        input: { start_date: "2026-08-17", end_date: "2026-08-30" },
      }),
    );
    const result = await routeLocalToolCall("8월 17일과 8월 30일 사이 영업일 수는?", CANDIDATES, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    expect(result).toEqual({
      status: "ran",
      toolId: "tool-1",
      toolName: "business_days_between",
      args: { start_date: "2026-08-17", end_date: "2026-08-30" },
    });
  });

  it("routing prompt sent to Ollama contains only this turn's question and candidate name/schema — never history, citations, or prior tool results", async () => {
    mockOllama(JSON.stringify({ tool_name: null, input: null }));
    await routeLocalToolCall("8월 17일과 8월 30일 사이 영업일 수는?", CANDIDATES, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    const [, chatInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const body = JSON.parse(String(chatInit?.body)) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages).toHaveLength(2); // system + user, no history turns folded in
    expect(body.messages[1].content).toContain("8월 17일과 8월 30일 사이 영업일 수는?");
    expect(body.messages[1].content).toContain("business_days_between");
    // 이 함수는 history/citation 파라미터 자체를 받지 않는다 — 시그니처
    // 수준에서 이미 이 속성을 강제하지만, 실제 전송 payload에도 그런
    // 필드가 전혀 없다는 것을 직접 확인한다.
    const fullPayload = JSON.stringify(body);
    expect(fullPayload).not.toContain("citation");
    expect(fullPayload).not.toContain("history");
  });
});

describe("validateLocalToolArgs — schema-invalid args are never allowed through", () => {
  const schema = {
    type: "object",
    properties: {
      start_date: { type: "string" },
      count: { type: "integer" },
    },
    required: ["start_date"],
    additionalProperties: false,
  };

  it("accepts a fully valid object", () => {
    const result = validateLocalToolArgs(schema, { start_date: "2026-08-17", count: 3 });
    expect(result).toEqual({ ok: true, args: { start_date: "2026-08-17", count: 3 } });
  });

  it("rejects a missing required field", () => {
    const result = validateLocalToolArgs(schema, { count: 3 });
    expect(result.ok).toBe(false);
  });

  it("rejects a type mismatch", () => {
    const result = validateLocalToolArgs(schema, { start_date: 20260817 });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown extra field when additionalProperties is false", () => {
    const result = validateLocalToolArgs(schema, { start_date: "2026-08-17", extra: "x" });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object payload", () => {
    expect(validateLocalToolArgs(schema, "not an object").ok).toBe(false);
    expect(validateLocalToolArgs(schema, null).ok).toBe(false);
    expect(validateLocalToolArgs(schema, [1, 2]).ok).toBe(false);
  });
});
