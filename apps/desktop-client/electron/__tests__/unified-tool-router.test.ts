// D-089 후속 "로컬 Tool 자동 라우팅과 MCP Tool 자동 제안 통합"(2026-08-20
// 승인 설계)의 핵심 안전 속성을 고정한다. 이 파일은 electron/node import가
// 없는 순수 모듈(`unified-tool-router.ts`)을 테스트하므로 실제
// Electron/Ollama가 필요 없다(`local-tool-router.test.ts`와 같은 패턴).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildUnifiedToolCandidates,
  hasAnyUnifiedCandidates,
  resolveUnifiedPick,
  routeUnifiedToolCall,
  type UnifiedToolCandidate,
} from "../unified-tool-router";
import type { LocalToolRouteCandidate } from "../local-tool-router";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const LOCAL_CANDIDATES: LocalToolRouteCandidate[] = [
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

const MCP_TOOL_NAMES = ["table_count.query"];

function mockOllama(chatResponseContent: string): void {
  global.fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: "exaone3.5:7.8b" }] }), { status: 200 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ message: { content: chatResponseContent } }), { status: 200 }),
    ) as unknown as typeof fetch;
}

describe("buildUnifiedToolCandidates — merges local + MCP into one list", () => {
  it("combines both kinds and keeps their discriminants", () => {
    const candidates = buildUnifiedToolCandidates(LOCAL_CANDIDATES, MCP_TOOL_NAMES);
    expect(candidates).toEqual([
      {
        kind: "local",
        id: "tool-1",
        toolName: "business_days_between",
        functionName: "business_days_between",
        inputSchema: LOCAL_CANDIDATES[0].inputSchema,
      },
      { kind: "mcp", toolName: "table_count.query" },
    ]);
  });

  it("returns an empty list when both sources are empty", () => {
    expect(buildUnifiedToolCandidates([], [])).toEqual([]);
  });
});

describe("hasAnyUnifiedCandidates — Task Brief E: hide the toggle when nothing is offered", () => {
  it("false when both counts are zero", () => {
    expect(hasAnyUnifiedCandidates(0, 0)).toBe(false);
  });
  it("true when only local tools exist", () => {
    expect(hasAnyUnifiedCandidates(1, 0)).toBe(true);
  });
  it("true when only MCP tools exist", () => {
    expect(hasAnyUnifiedCandidates(0, 1)).toBe(true);
  });
  it("true when both exist", () => {
    expect(hasAnyUnifiedCandidates(2, 3)).toBe(true);
  });
});

describe("resolveUnifiedPick — MCP-first tie-break is enforced in code, not just prompted", () => {
  const candidates: UnifiedToolCandidate[] = buildUnifiedToolCandidates(
    [
      {
        id: "tool-1",
        toolName: "duplicate_name",
        functionName: "duplicate_name",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    ["duplicate_name"],
  );

  it("returns null when the model picked nothing", () => {
    expect(resolveUnifiedPick(null, candidates)).toBeNull();
  });

  it("prefers the MCP candidate when the model correctly prefixes 'mcp:'", () => {
    const resolved = resolveUnifiedPick("mcp:duplicate_name", candidates);
    expect(resolved).toEqual({ kind: "mcp", candidate: { kind: "mcp", toolName: "duplicate_name" } });
  });

  it("still prefers MCP even if the model mistakenly prefixes 'local:' for a name that also matches an MCP candidate", () => {
    const resolved = resolveUnifiedPick("local:duplicate_name", candidates);
    expect(resolved?.kind).toBe("mcp");
  });

  it("still prefers MCP even with no prefix at all, when a same-named MCP candidate exists", () => {
    const resolved = resolveUnifiedPick("duplicate_name", candidates);
    expect(resolved?.kind).toBe("mcp");
  });

  it("falls back to the local candidate only when no MCP candidate shares the name", () => {
    const onlyLocal = buildUnifiedToolCandidates(
      [
        {
          id: "tool-2",
          toolName: "only_local",
          functionName: "only_local",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      ["duplicate_name"],
    );
    const resolved = resolveUnifiedPick("local:only_local", onlyLocal);
    expect(resolved).toEqual({
      kind: "local",
      candidate: { kind: "local", id: "tool-2", toolName: "only_local", functionName: "only_local", inputSchema: onlyLocal[0]!["inputSchema" as never] },
    });
  });

  it("returns null for a name matching neither a local nor an MCP candidate", () => {
    expect(resolveUnifiedPick("mcp:nonexistent", candidates)).toBeNull();
  });
});

describe("routeUnifiedToolCall — fail-closed on every non-'ran_*' outcome (D-089 규율 그대로 상속)", () => {
  it("never calls the LLM and reports no_candidates when there are zero candidates", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const result = await routeUnifiedToolCall("질문", [], {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    expect(result).toEqual({ status: "no_candidates", kind: null, toolId: null, toolName: null, args: null });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("reports declined_by_model when the model explicitly picks nothing", async () => {
    mockOllama(JSON.stringify({ pick: null, input: null }));
    const candidates = buildUnifiedToolCandidates(LOCAL_CANDIDATES, MCP_TOOL_NAMES);
    const result = await routeUnifiedToolCall("오늘 날씨 어때?", candidates, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    expect(result.status).toBe("declined_by_model");
    expect(result.kind).toBeNull();
  });

  it("reports unparseable for garbage output", async () => {
    mockOllama("이건 JSON이 아닙니다");
    const candidates = buildUnifiedToolCandidates(LOCAL_CANDIDATES, MCP_TOOL_NAMES);
    const result = await routeUnifiedToolCall("질문", candidates, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    expect(result.status).toBe("unparseable");
  });

  it("never widens the candidate set — a pick outside both lists is rejected", async () => {
    mockOllama(JSON.stringify({ pick: "mcp:rm_rf_everything", input: null }));
    const candidates = buildUnifiedToolCandidates(LOCAL_CANDIDATES, MCP_TOOL_NAMES);
    const result = await routeUnifiedToolCall("질문", candidates, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    expect(result.status).toBe("unknown_tool_name");
  });

  it("reports error_or_timeout and does not retry when the LLM call rejects", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const candidates = buildUnifiedToolCandidates(LOCAL_CANDIDATES, MCP_TOOL_NAMES);
    const result = await routeUnifiedToolCall("질문", candidates, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
      timeoutMs: 50,
    });
    expect(result.status).toBe("error_or_timeout");
  });

  it("does not retry a local schema validation failure — a single LLM call, rejection returns schema_invalid", async () => {
    mockOllama(
      JSON.stringify({ pick: "local:business_days_between", input: { start_date: "2026-08-17" } }),
    );
    const candidates = buildUnifiedToolCandidates(LOCAL_CANDIDATES, MCP_TOOL_NAMES);
    const result = await routeUnifiedToolCall("8월 17일과 8월 30일 사이 영업일 수는?", candidates, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    expect(result.status).toBe("schema_invalid");
    expect(result.kind).toBe("local");
    expect(result.toolId).toBe("tool-1");
    expect(result.args).toBeNull();
    expect(result.schemaErrors).toEqual({ end_date: "필수 입력값이 빠졌습니다." });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("ran_local: proposes exactly the local candidate + validated args on a well-formed response", async () => {
    mockOllama(
      JSON.stringify({
        pick: "local:business_days_between",
        input: { start_date: "2026-08-17", end_date: "2026-08-30" },
      }),
    );
    const candidates = buildUnifiedToolCandidates(LOCAL_CANDIDATES, MCP_TOOL_NAMES);
    const result = await routeUnifiedToolCall("8월 17일과 8월 30일 사이 영업일 수는?", candidates, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    expect(result).toEqual({
      status: "ran_local",
      kind: "local",
      toolId: "tool-1",
      toolName: "business_days_between",
      args: { start_date: "2026-08-17", end_date: "2026-08-30" },
    });
  });

  it("ran_mcp: never invents or carries an input object — the server re-derives the actual tool/args", async () => {
    mockOllama(JSON.stringify({ pick: "mcp:table_count.query", input: null }));
    const candidates = buildUnifiedToolCandidates(LOCAL_CANDIDATES, MCP_TOOL_NAMES);
    const result = await routeUnifiedToolCall("APP.INTERFACE_LOG 건수 알려줘", candidates, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    expect(result).toEqual({
      status: "ran_mcp",
      kind: "mcp",
      toolId: null,
      toolName: "table_count.query",
      args: null,
    });
  });

  it("MCP-first tie-break also holds end-to-end through routeUnifiedToolCall when both a local and MCP candidate share a name", async () => {
    mockOllama(JSON.stringify({ pick: "local:business_days_between", input: {} }));
    const candidates = buildUnifiedToolCandidates(LOCAL_CANDIDATES, ["business_days_between"]);
    const result = await routeUnifiedToolCall("질문", candidates, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    expect(result.status).toBe("ran_mcp");
    expect(result.kind).toBe("mcp");
    expect(result.toolName).toBe("business_days_between");
  });

  it("실사용 제보(2026-08-20) '채팅 입력하고 취소할 수 있어야해' — options.signal이 abort되면 status가 'cancelled'다, 'error_or_timeout'이 아니다", async () => {
    // 내부 타임아웃(50ms)이 훨씬 먼저 도달하지 않도록 충분히 크게 두고,
    // fetch 자체는 절대 스스로 끝나지 않는다 — 오직 signal abort로만
    // 끝나야 이 테스트가 "취소로 인한 cancelled"만 검증한다(타임아웃과
    // 뒤섞이면 이 테스트는 무효하다).
    const hangingFetch = vi.fn((_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;
    const candidates = buildUnifiedToolCandidates(LOCAL_CANDIDATES, MCP_TOOL_NAMES);
    const controller = new AbortController();
    const resultPromise = routeUnifiedToolCall("질문", candidates, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
      timeoutMs: 60_000,
      signal: controller.signal,
      fetchImpl: hangingFetch,
    });
    controller.abort();
    const result = await resultPromise;
    expect(result.status).toBe("cancelled");
    expect(result.kind).toBeNull();
    expect(result.toolId).toBeNull();
    expect(result.toolName).toBeNull();
    expect(result.args).toBeNull();
  });

  it("신뢰 대조 — 같은 abort raw가 signal 없이(내부 타임아웃만으로) 일어나면 여전히 'error_or_timeout'이지 'cancelled'가 아니다", async () => {
    // 위 테스트가 정말 signal 유무를 보는지 확인하는 대조군 — 이 테스트가
    // 실패하면 위 테스트가 signal과 무관하게 항상 'cancelled'를 내는
    // 무효한 회귀 테스트라는 뜻이다.
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const candidates = buildUnifiedToolCandidates(LOCAL_CANDIDATES, MCP_TOOL_NAMES);
    const result = await routeUnifiedToolCall("질문", candidates, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
      timeoutMs: 50,
    });
    expect(result.status).toBe("error_or_timeout");
  });

  it("routing prompt sent to Ollama contains only this turn's question and candidate names/schema — never history, citations, or prior tool results", async () => {
    mockOllama(JSON.stringify({ pick: null, input: null }));
    const candidates = buildUnifiedToolCandidates(LOCAL_CANDIDATES, MCP_TOOL_NAMES);
    await routeUnifiedToolCall("8월 17일과 8월 30일 사이 영업일 수는?", candidates, {
      baseUrl: "http://127.0.0.1:11434",
      preferredModel: "default-chat",
    });
    const [, chatInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const body = JSON.parse(String(chatInit?.body)) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages).toHaveLength(2); // system + user, no history turns folded in
    expect(body.messages[1].content).toContain("8월 17일과 8월 30일 사이 영업일 수는?");
    expect(body.messages[1].content).toContain("business_days_between");
    expect(body.messages[1].content).toContain("table_count.query");
    const fullPayload = JSON.stringify(body);
    expect(fullPayload).not.toContain("citation");
    expect(fullPayload).not.toContain("history");
  });
});
