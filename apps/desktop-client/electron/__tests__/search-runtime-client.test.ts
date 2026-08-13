// D-079 — search-runtime의 Local Knowledge Index Registration 계약을 소비하는
// pure HTTP client. `portal-client.test.ts`와 동일한 관례: 실제 네트워크를
// 전혀 쓰지 않고 `fetchImpl` 주입만으로 성공/각 거부 사유/비-JSON 응답/
// 타임아웃(unreachable) 경로를 모두 검증한다.
import { describe, expect, it, vi } from "vitest";
import {
  listLocalKnowledgeIndexes,
  registerLocalKnowledgeIndex,
  unregisterLocalKnowledgeIndex,
} from "../search-runtime-client";
import type { FetchLike } from "../search-runtime-client";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function nonJsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error("not json");
    },
  } as unknown as Response;
}

// FastAPI's own default body for an unmatched route — never our Error
// Envelope shape (no `error.message`). This is exactly what a
// pre-D-079 search-runtime process returns for `/search/v1/local-indexes`,
// since that route does not exist in its routing table at all.
function bareNotFoundResponse(): Response {
  return jsonResponse(404, { detail: "Not Found" });
}

describe("registerLocalKnowledgeIndex", () => {
  it("POSTs the request body and maps a successful entry to camelCase", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        entry: {
          knowledge_id: "kb-1",
          index_path: "/install/knowledge/kb-1/1.0.0/index",
          source: "DESKTOP_OFFLINE_BUNDLE",
          label: "재택근무 정책 v1.0.0",
          registered_at: "2026-08-13T00:00:00.000Z",
        },
        trace_id: "t1",
      }),
    ) as unknown as FetchLike;

    const result = await registerLocalKnowledgeIndex(
      "http://127.0.0.1:8300",
      { knowledgeId: "kb-1", indexPath: "/install/knowledge/kb-1/1.0.0/index", label: "재택근무 정책 v1.0.0" },
      fetchImpl,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry).toEqual({
        knowledgeId: "kb-1",
        indexPath: "/install/knowledge/kb-1/1.0.0/index",
        source: "DESKTOP_OFFLINE_BUNDLE",
        label: "재택근무 정책 v1.0.0",
        registeredAt: "2026-08-13T00:00:00.000Z",
      });
    }

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8300/search/v1/local-indexes");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      knowledge_id: "kb-1",
      index_path: "/install/knowledge/kb-1/1.0.0/index",
      source: "DESKTOP_OFFLINE_BUNDLE",
      label: "재택근무 정책 v1.0.0",
      trace_id: null,
    });
  });

  it.each([
    "local_indexes_disabled",
    "path_outside_allowed_roots",
    "path_not_absolute",
    "path_not_a_directory",
    "knowledge_id_invalid",
    "index_meta_missing",
    "index_meta_unreadable",
    "index_meta_knowledge_id_mismatch",
    "bm25_missing",
    "bm25_legacy_pickle_only",
    "chroma_missing",
    "central_index_exists",
    "source_not_allowed",
    "label_too_long",
  ])("surfaces the %s refusal reason and the server's Korean message", async (reason) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: { code: "VALIDATION_ERROR", message: `한국어 거부 메시지: ${reason}`, details: { reason } } }),
    ) as unknown as FetchLike;

    const result = await registerLocalKnowledgeIndex(
      "http://127.0.0.1:8300",
      { knowledgeId: "kb-1", indexPath: "/x" },
      fetchImpl,
    );
    expect(result).toEqual({ ok: false, reason, message: `한국어 거부 메시지: ${reason}` });
  });

  it("falls back to reason 'unknown' when details.reason is missing or unrecognized", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { error: { code: "PERMISSION_DENIED", message: "권한이 없습니다." } }),
    ) as unknown as FetchLike;
    const result = await registerLocalKnowledgeIndex(
      "http://127.0.0.1:8300",
      { knowledgeId: "kb-1", indexPath: "/x" },
      fetchImpl,
    );
    expect(result).toEqual({ ok: false, reason: "unknown", message: "권한이 없습니다." });
  });

  it("never throws on a non-JSON error body — produces a usable Korean message instead", async () => {
    const fetchImpl = vi.fn(async () => nonJsonResponse(500)) as unknown as FetchLike;
    const result = await registerLocalKnowledgeIndex(
      "http://127.0.0.1:8300",
      { knowledgeId: "kb-1", indexPath: "/x" },
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown");
      expect(result.message).toContain("HTTP 500");
    }
  });

  it("never throws when search-runtime is unreachable — reason 'unreachable' with a Korean recovery hint", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as FetchLike;
    const result = await registerLocalKnowledgeIndex(
      "http://127.0.0.1:8300",
      { knowledgeId: "kb-1", indexPath: "/x" },
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unreachable");
      expect(result.message).toContain("search-runtime");
    }
  });

  it("gives a distinct timeout message on an AbortError, still reason 'unreachable'", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as FetchLike;
    const result = await registerLocalKnowledgeIndex(
      "http://127.0.0.1:8300",
      { knowledgeId: "kb-1", indexPath: "/x" },
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unreachable");
      expect(result.message).toContain("시간 내에");
    }
  });

  // 2026-08-13 실사용 진단: a bare HTTP 404 (no Error Envelope at all) means
  // the route itself doesn't exist on the running process — the strongest
  // signal that a pre-D-079 search-runtime is still up. This must map to its
  // own actionable reason, not the generic "unknown" HTTP-500-style message.
  it("maps a bare HTTP 404 (no Error Envelope) to 'activation_api_unavailable' with an actionable restart hint", async () => {
    const fetchImpl = vi.fn(async () => bareNotFoundResponse()) as unknown as FetchLike;
    const result = await registerLocalKnowledgeIndex(
      "http://127.0.0.1:8300",
      { knowledgeId: "kb-1", indexPath: "/x" },
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("activation_api_unavailable");
      expect(result.message).toContain("404");
      expect(result.message).toContain("재시작");
    }
  });

  it("treats a 200 response missing the entry field as reason 'unknown' rather than crashing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { trace_id: "t1" })) as unknown as FetchLike;
    const result = await registerLocalKnowledgeIndex(
      "http://127.0.0.1:8300",
      { knowledgeId: "kb-1", indexPath: "/x" },
      fetchImpl,
    );
    expect(result).toEqual({ ok: false, reason: "unknown", message: "search-runtime 응답 형식이 올바르지 않습니다." });
  });
});

describe("unregisterLocalKnowledgeIndex", () => {
  it("DELETEs the knowledge_id-scoped URL and returns removed:true", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { knowledge_id: "kb-1", removed: true, trace_id: "t1" })) as unknown as FetchLike;
    const result = await unregisterLocalKnowledgeIndex("http://127.0.0.1:8300", "kb-1", fetchImpl);
    expect(result).toEqual({ ok: true, removed: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8300/search/v1/local-indexes/kb-1");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("reports removed:false when nothing was registered — still ok:true (safe to call unconditionally)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { knowledge_id: "kb-1", removed: false, trace_id: "t1" })) as unknown as FetchLike;
    const result = await unregisterLocalKnowledgeIndex("http://127.0.0.1:8300", "kb-1", fetchImpl);
    expect(result).toEqual({ ok: true, removed: false });
  });

  it("never throws when unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as FetchLike;
    const result = await unregisterLocalKnowledgeIndex("http://127.0.0.1:8300", "kb-1", fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unreachable");
  });

  it("maps a bare HTTP 404 on DELETE to 'activation_api_unavailable' too", async () => {
    const fetchImpl = vi.fn(async () => bareNotFoundResponse()) as unknown as FetchLike;
    const result = await unregisterLocalKnowledgeIndex("http://127.0.0.1:8300", "kb-1", fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("activation_api_unavailable");
      expect(result.message).toContain("재시작");
    }
  });
});

describe("listLocalKnowledgeIndexes", () => {
  it("maps entries and local_indexes_enabled", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        entries: [
          {
            knowledge_id: "kb-1",
            index_path: "/x",
            source: "DESKTOP_OFFLINE_BUNDLE",
            label: null,
            registered_at: "2026-08-13T00:00:00.000Z",
          },
        ],
        local_indexes_enabled: true,
        trace_id: "t1",
      }),
    ) as unknown as FetchLike;
    const result = await listLocalKnowledgeIndexes("http://127.0.0.1:8300", fetchImpl);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.localIndexesEnabled).toBe(true);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].knowledgeId).toBe("kb-1");
    }
  });

  it("reports local_indexes_enabled:false — distinct from 'nothing activated yet'", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { entries: [], local_indexes_enabled: false, trace_id: "t1" })) as unknown as FetchLike;
    const result = await listLocalKnowledgeIndexes("http://127.0.0.1:8300", fetchImpl);
    expect(result).toEqual({ ok: true, entries: [], localIndexesEnabled: false });
  });

  it("never throws when unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as FetchLike;
    const result = await listLocalKnowledgeIndexes("http://127.0.0.1:8300", fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unreachable");
  });

  it("maps a bare HTTP 404 on GET to 'activation_api_unavailable' too", async () => {
    const fetchImpl = vi.fn(async () => bareNotFoundResponse()) as unknown as FetchLike;
    const result = await listLocalKnowledgeIndexes("http://127.0.0.1:8300", fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("activation_api_unavailable");
      expect(result.message).toContain("재시작");
    }
  });
});
