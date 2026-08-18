// 자산 스토어 — portal-api HTTP 클라이언트. 실제 네트워크를 전혀 쓰지 않고
// `fetchImpl` 주입만으로 성공/오류 Envelope/네트워크 단절 세 경로를 모두
// 검증한다 — "Portal 도달 불가는 폐쇄망에서 정상 상태이며 절대 크래시하지
// 않는다"는 요구사항의 핵심 증거.
import { describe, expect, it, vi } from "vitest";
import { createAsset, downloadDistribution, fetchCatalog, getDistribution, requestDistribution } from "../portal-client";
import type { FetchLike } from "../portal-client";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
  } as unknown as Response;
}

function bytesResponse(status: number, bytes: Uint8Array): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error("not json");
    },
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

describe("fetchCatalog", () => {
  it("maps a successful asset list response into PortalCatalogAsset[]", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        items: [
          {
            id: "a1",
            type: "knowledge",
            name: "재택근무 정책",
            classification: "INTERNAL",
            versions: [{ id: "v1", version: "1.0.0", status: "APPROVED" }],
          },
        ],
      }),
    ) as unknown as FetchLike;

    const result = await fetchCatalog("http://127.0.0.1:8003", "dev-user-token", fetchImpl);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe("재택근무 정책");
      // D-072: a version with no `active_revocation` in the response (this
      // fixture omits it entirely, matching the field's optionality on the
      // wire) must map to `activeRevocation: null`, never `undefined` —
      // `storeTypes.ts` branches on strict presence.
      expect(result.data[0].versions[0].activeRevocation).toBeNull();
    }
    // Authorization 헤더가 실제로 실렸는지, base URL 뒤 슬래시가 안전하게
    // 처리되는지 확인.
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8003/api/v1/assets?page_size=100");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer dev-user-token" });
  });

  it("D-072: maps an effective active_revocation (snake_case wire shape) into camelCase", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        items: [
          {
            id: "a1",
            type: "knowledge",
            name: "재택근무 정책",
            classification: "INTERNAL",
            versions: [
              {
                id: "v1",
                version: "1.0.0",
                status: "APPROVED",
                active_revocation: { effective_at: "2026-08-09T00:00:00Z", reason: "보안 취약점 발견" },
              },
            ],
          },
        ],
      }),
    ) as unknown as FetchLike;

    const result = await fetchCatalog("http://127.0.0.1:8003", "dev-user-token", fetchImpl);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0].versions[0].activeRevocation).toEqual({
        effectiveAt: "2026-08-09T00:00:00Z",
        reason: "보안 취약점 발견",
      });
    }
  });

  it("surfaces the portal-api error envelope's code/message on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { error: { code: "PERMISSION_DENIED", message: "권한이 없습니다.", trace_id: "t1" } }),
    ) as unknown as FetchLike;

    const result = await fetchCatalog("http://127.0.0.1:8003", "dev-user-token", fetchImpl);
    expect(result).toEqual({ ok: false, code: "PERMISSION_DENIED", message: "권한이 없습니다." });
  });

  it("never throws when the Portal is unreachable — returns a Korean PORTAL_UNREACHABLE result instead", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as FetchLike;

    const result = await fetchCatalog("http://127.0.0.1:9999", "dev-user-token", fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PORTAL_UNREACHABLE");
      expect(result.message).toContain("연결할 수 없습니다");
    }
  });

  it("gives a distinct timeout message on an AbortError", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as FetchLike;

    const result = await fetchCatalog("http://127.0.0.1:8003", "dev-user-token", fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PORTAL_UNREACHABLE");
      expect(result.message).toContain("시간 내에");
    }
  });

  it("falls back to a generic HTTP_<status> code when the error body isn't a valid envelope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { totally: "unexpected" })) as unknown as FetchLike;
    const result = await fetchCatalog("http://127.0.0.1:8003", "dev-user-token", fetchImpl);
    expect(result).toEqual({ ok: false, code: "HTTP_500", message: "Portal 응답 오류가 발생했습니다 (HTTP 500)." });
  });
});

describe("requestDistribution", () => {
  it("POSTs the OFFLINE_BUNDLE request body and returns the created id/status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(202, { id: "dist-1", status: "QUEUED" })) as unknown as FetchLike;
    const result = await requestDistribution(
      "http://127.0.0.1:8003",
      "dev-user-token",
      { root_type: "ASSET_VERSION", root_id: "av-1", mode: "OFFLINE_BUNDLE" },
      fetchImpl,
    );
    expect(result).toEqual({ ok: true, data: { id: "dist-1", status: "QUEUED" } });
    const [, init] = fetchImpl.mock.calls[0];
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      root_type: "ASSET_VERSION",
      root_id: "av-1",
      mode: "OFFLINE_BUNDLE",
    });
  });
});

describe("getDistribution", () => {
  it("maps snake_case fields to the camelCase DistributionStatusView", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        id: "dist-1",
        status: "FAILED",
        stage: "COLLECTING",
        error_code: "ASSET_VERSION_REVOKED",
        error_message: "긴급 회수(Revocation)된 버전입니다.",
        retryable: false,
      }),
    ) as unknown as FetchLike;

    const result = await getDistribution("http://127.0.0.1:8003", "dev-user-token", "dist-1", fetchImpl);
    expect(result).toEqual({
      ok: true,
      data: {
        id: "dist-1",
        status: "FAILED",
        stage: "COLLECTING",
        errorCode: "ASSET_VERSION_REVOKED",
        errorMessage: "긴급 회수(Revocation)된 버전입니다.",
        retryable: false,
      },
    });
  });
});

describe("downloadDistribution", () => {
  it("returns the raw bytes as a Buffer on success", async () => {
    const bytes = new TextEncoder().encode("PK\x03\x04fake-zip-bytes");
    const fetchImpl = vi.fn(async () => bytesResponse(200, bytes)) as unknown as FetchLike;

    const result = await downloadDistribution("http://127.0.0.1:8003", "dev-user-token", "dist-1", fetchImpl);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Buffer.isBuffer(result.data)).toBe(true);
      expect(result.data.equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it("surfaces ASSET_VERSION_REVOKED without downloading any bytes when the download itself is rejected", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, {
        error: { code: "ASSET_VERSION_REVOKED", message: "긴급 회수(Revocation)된 버전의 Bundle은 다운로드할 수 없습니다." },
      }),
    ) as unknown as FetchLike;

    const result = await downloadDistribution("http://127.0.0.1:8003", "dev-user-token", "dist-1", fetchImpl);
    expect(result).toEqual({
      ok: false,
      code: "ASSET_VERSION_REVOKED",
      message: "긴급 회수(Revocation)된 버전의 Bundle은 다운로드할 수 없습니다.",
    });
  });
});

// Desktop Client PR2: 대화 -> Agent 초안 Portal 업로드가 쓰는 유일한 HTTP
// 호출. 항상 DRAFT를 만드는 `POST /api/v1/assets`만 부르는지(승인/게시로
// 이어지는 다른 엔드포인트는 절대 부르지 않는다), 서버의 업로드 상한
// 오류코드 4종·VALIDATION_ERROR(+details.errors)·PERMISSION_DENIED(403)를
// 뭉개지 않고 그대로 통과시키는지를 고정한다.
describe("createAsset", () => {
  it("POSTs multipart/form-data to /api/v1/assets with the manifest JSON and attached files, using Authorization but no manual Content-Type", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, { id: "v1", asset_id: "a1", version: "0.1.0", status: "DRAFT" }),
    ) as unknown as FetchLike;

    const result = await createAsset(
      "http://127.0.0.1:8003",
      "dev-user-token",
      { schema_version: "1.0", id: "a1", type: "prompt", name: "테스트 프롬프트" },
      [{ filename: "template.md", content: "# 시스템 프롬프트" }],
      fetchImpl,
    );

    expect(result).toEqual({ ok: true, data: { id: "v1", assetId: "a1", version: "0.1.0", status: "DRAFT" } });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8003/api/v1/assets");
    expect((init as RequestInit).method).toBe("POST");
    // Authorization만 명시한다 — multipart boundary가 포함된 Content-Type은
    // fetch가 FormData body로부터 스스로 채운다(직접 지정하면 boundary가
    // 깨진다).
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer dev-user-token" });
    const body = (init as RequestInit).body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const manifestField = JSON.parse(body.get("manifest") as string);
    expect(manifestField).toMatchObject({ type: "prompt", name: "테스트 프롬프트" });
    const fileField = body.get("files") as File;
    expect(fileField.name).toBe("template.md");
    expect(await fileField.text()).toBe("# 시스템 프롬프트");
  });

  it("sends no files when none are given (Agent manifest has no attachment)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, { id: "v2", asset_id: "a2", version: "0.1.0", status: "DRAFT" }),
    ) as unknown as FetchLike;

    await createAsset("http://127.0.0.1:8003", "dev-user-token", { type: "agent" }, [], fetchImpl);

    const [, init] = fetchImpl.mock.calls[0];
    const body = (init as RequestInit).body as FormData;
    expect(body.getAll("files")).toHaveLength(0);
  });

  it.each(["ASSET_UPLOAD_TOO_MANY_FILES", "ASSET_UPLOAD_EXTENSION_REJECTED", "ASSET_UPLOAD_FILE_TOO_LARGE", "ASSET_UPLOAD_REQUEST_TOO_LARGE"])(
    "passes through %s without rewriting the server's code or message",
    async (code) => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(400, { error: { code, message: `서버가 보낸 ${code} 메시지` } }),
      ) as unknown as FetchLike;

      const result = await createAsset("http://127.0.0.1:8003", "dev-user-token", { type: "agent" }, [], fetchImpl);
      expect(result).toEqual({ ok: false, code, message: `서버가 보낸 ${code} 메시지` });
    },
  );

  it("passes through VALIDATION_ERROR together with details.errors (field-level list)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Manifest가 스키마를 충족하지 않습니다.",
          details: { errors: ["'workflow' is a required property", "'risk_level' must be one of [...]"] },
        },
      }),
    ) as unknown as FetchLike;

    const result = await createAsset("http://127.0.0.1:8003", "dev-user-token", { type: "agent" }, [], fetchImpl);
    expect(result).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "Manifest가 스키마를 충족하지 않습니다.",
      details: { errors: ["'workflow' is a required property", "'risk_level' must be one of [...]"] },
    });
  });

  it("passes through a 403 PERMISSION_DENIED distinctly from other failures", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { error: { code: "PERMISSION_DENIED", message: "이 작업을 수행할 권한이 없습니다." } }),
    ) as unknown as FetchLike;

    const result = await createAsset("http://127.0.0.1:8003", "dev-user-token", { type: "agent" }, [], fetchImpl);
    expect(result).toEqual({ ok: false, code: "PERMISSION_DENIED", message: "이 작업을 수행할 권한이 없습니다." });
  });

  it("reports PORTAL_UNREACHABLE (not a crash) when the network call itself fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as FetchLike;

    const result = await createAsset("http://127.0.0.1:8003", "dev-user-token", { type: "agent" }, [], fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PORTAL_UNREACHABLE");
  });

  it("aborts the in-flight request when the caller's externalSignal is aborted (upload cancellation)", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }) as unknown as FetchLike;

    const promise = createAsset(
      "http://127.0.0.1:8003",
      "dev-user-token",
      { type: "agent" },
      [],
      fetchImpl,
      controller.signal,
    );
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PORTAL_UNREACHABLE");
  });
});
