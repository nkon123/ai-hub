// D09 연결 상태 / D01 3-5단계 — connections.ts는 이제 하드코딩된 Endpoint가
// 아니라 인자로 받은 설정값을 실제로 사용해야 한다(D01/D10 도입 전 3
// Endpoint가 전부 `127.0.0.1:11434`/`127.0.0.1:8100`/`127.0.0.1:8500`로
// 고정돼 있던 것을 대체). global.fetch를 모의(mock)해 실제 호출 URL을
// 검증한다 — 실 서비스가 떠 있지 않아도 결정적으로 통과해야 한다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assessChatConnections, checkAllConnections, listOllamaModels } from "../connections";
import type { ConnectionId, ConnectionStatus } from "../types";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetchOk(): void {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })) as unknown as typeof fetch;
}

describe("checkAllConnections", () => {
  it("checks exactly four connections (runtime, ollama, mcp, search — D-079 이어 붙이기)", async () => {
    mockFetchOk();
    const results = await checkAllConnections();
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.id).sort()).toEqual(["mcp", "ollama", "runtime", "search"]);
  });

  it("falls back to the documented default endpoints when no settings are passed", async () => {
    mockFetchOk();
    await checkAllConnections();
    const calledUrls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calledUrls).toContain("http://127.0.0.1:8100/health");
    expect(calledUrls).toContain("http://127.0.0.1:11434/api/tags");
    expect(calledUrls).toContain("http://127.0.0.1:8500/health/live");
    expect(calledUrls).toContain("http://127.0.0.1:8300/health");
  });

  it("uses the configured Ollama/MCP endpoints instead of the hardcoded defaults", async () => {
    mockFetchOk();
    await checkAllConnections({
      ollamaBaseUrl: "http://127.0.0.1:22222",
      mcpServerUrl: "http://127.0.0.1:33333",
      mcpServerAlias: "custom-mcp",
    });
    const calledUrls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calledUrls).toContain("http://127.0.0.1:22222/api/tags");
    expect(calledUrls).toContain("http://127.0.0.1:33333/health/live");
    // Runtime endpoint falls back to the default when the caller has no override.
    expect(calledUrls).toContain("http://127.0.0.1:8100/health");
  });

  it("uses the configured runtime endpoint instead of the default", async () => {
    mockFetchOk();
    await checkAllConnections({ runtimeBaseUrl: "http://127.0.0.1:8102" });
    const calledUrls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(calledUrls).toContain("http://127.0.0.1:8102/health");
    expect(calledUrls).not.toContain("http://127.0.0.1:8100/health");
  });

  it("uses the configured search-runtime endpoint instead of the default", async () => {
    mockFetchOk();
    const results = await checkAllConnections({ searchRuntimeBaseUrl: "http://127.0.0.1:8301" });
    const calledUrls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(calledUrls).toContain("http://127.0.0.1:8301/health");
    expect(calledUrls).not.toContain("http://127.0.0.1:8300/health");
    const search = results.find((r) => r.id === "search");
    expect(search?.label).toBe("search-runtime");
  });

  it("labels the MCP connection with the configured alias", async () => {
    mockFetchOk();
    const results = await checkAllConnections({ mcpServerAlias: "gumi-mcp" });
    const mcp = results.find((r) => r.id === "mcp");
    expect(mcp?.label).toContain("gumi-mcp");
  });

  it("reports ok:false with a Korean recovery hint on network failure — never throws", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const results = await checkAllConnections();
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.recoveryHint).toBeTruthy();
    }
  });
});

function connection(id: ConnectionId, ok: boolean): ConnectionStatus {
  return {
    id,
    label: id,
    ok,
    detail: ok ? "정상 연결됨" : "연결 실패",
    checkedAt: "2026-08-11T00:00:00.000Z",
    latencyMs: ok ? 1 : null,
    recoveryHint: ok ? null : "서비스 상태를 확인하세요.",
  };
}

describe("assessChatConnections", () => {
  it("blocks chat when the runtime is unavailable", () => {
    const result = assessChatConnections([
      connection("runtime", false),
      connection("ollama", true),
      connection("mcp", true),
    ]);
    expect(result.state).toBe("blocked");
    expect(result.blockingFailures.map((item) => item.id)).toEqual(["runtime"]);
  });

  it("limits only MCP Tool features when only MCP is unavailable", () => {
    const result = assessChatConnections([
      connection("runtime", true),
      connection("ollama", true),
      connection("mcp", false),
    ]);
    expect(result.state).toBe("limited");
    expect(result.featureFailures.map((item) => item.id)).toEqual(["mcp"]);
    expect(result.blockingFailures).toEqual([]);
  });

  it("treats a runtime outage as a feature limitation in Ollama-only mode", () => {
    const result = assessChatConnections(
      [connection("runtime", false), connection("ollama", true), connection("mcp", true)],
      "ollama",
    );
    expect(result.state).toBe("limited");
    expect(result.blockingFailures).toEqual([]);
    expect(result.featureFailures.map((item) => item.id)).toEqual(["runtime"]);
  });

  it("reports healthy when every chat-related connection is available", () => {
    const result = assessChatConnections([
      connection("runtime", true),
      connection("ollama", true),
      connection("mcp", true),
      connection("search", true),
    ]);
    expect(result.state).toBe("healthy");
    expect(result.blockingFailures).toEqual([]);
    expect(result.featureFailures).toEqual([]);
  });

  // D-079 이어 붙이기: search-runtime 없이는 Stage 1 로컬 검색도, 활성화도
  // 불가능하므로 Knowledge 모드에서는 Local Agent Runtime과 동일하게 대화를
  // 막아야 한다(위 assessChatConnections 문서 참고).
  it("blocks Knowledge chat when search-runtime is unavailable", () => {
    const result = assessChatConnections([
      connection("runtime", true),
      connection("ollama", true),
      connection("mcp", true),
      connection("search", false),
    ]);
    expect(result.state).toBe("blocked");
    expect(result.blockingFailures.map((item) => item.id)).toEqual(["search"]);
  });

  it("treats a search-runtime outage as a feature limitation in Ollama-only mode (not yet depended on)", () => {
    const result = assessChatConnections(
      [connection("runtime", true), connection("ollama", true), connection("mcp", true), connection("search", false)],
      "ollama",
    );
    expect(result.state).toBe("limited");
    expect(result.blockingFailures).toEqual([]);
    expect(result.featureFailures.map((item) => item.id)).toEqual(["search"]);
  });
});

describe("listOllamaModels", () => {
  it("returns the installed model names reported by Ollama", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ models: [{ name: "exaone3.5:7.8b" }, { name: "qwen3-embedding:0.6b" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const result = await listOllamaModels("http://127.0.0.1:11434");
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["exaone3.5:7.8b", "qwen3-embedding:0.6b"]);
  });

  it("returns ok:false with an honest error when Ollama is unreachable — never fabricates a model list", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await listOllamaModels("http://127.0.0.1:11434");
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});
