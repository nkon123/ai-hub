// 자산 스토어 — portal-api(M02)와 통신하는 유일한 지점.
//
// 이 파일은 HTTP 호출과 응답 파싱만 담당한다 — 압축 해제·경로 안전성·
// Checksum·Manifest 검증은 절대 여기서 하지 않는다. 다운로드한 Bundle
// 바이트는 그대로 `store-install.ts`를 거쳐 기존 `bundle-install.ts`의
// `importBundle()`에 전달된다(그 함수가 이미 가진 15단계 검증을 재사용) —
// 이 파일이 바이트를 직접 열어보는 순간 그것은 두 번째(미검증) 설치
// 경로이자 버그다.
//
// `fetchImpl` 매개변수는 오직 테스트를 위한 의존성 주입 지점이다 — 운영
// 코드(`main.ts`)는 항상 기본값(전역 `fetch`, Node 18+ 내장)을 사용한다.
import type { PortalCatalogAsset } from "./types";

export type FetchLike = typeof fetch;

export interface PortalApiSuccess<T> {
  ok: true;
  data: T;
}
export interface PortalApiFailure {
  ok: false;
  /** portal-api Error Envelope(07-data-api-contracts.md §10.2)의 `code`,
   * 또는 네트워크 실패 시 `PORTAL_UNREACHABLE`. */
  code: string;
  /** 항상 한국어 — 화면에 그대로 표시 가능. */
  message: string;
}
export type PortalApiResult<T> = PortalApiSuccess<T> | PortalApiFailure;

const DEFAULT_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseErrorEnvelope(res: Response): Promise<{ code: string; message: string }> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.code && body?.error?.message) {
      return { code: body.error.code, message: body.error.message };
    }
  } catch {
    // 응답이 JSON이 아니거나 Envelope 형식이 아님 — 아래 기본 메시지로 대체.
  }
  return { code: `HTTP_${res.status}`, message: `Portal 응답 오류가 발생했습니다 (HTTP ${res.status}).` };
}

/** 폐쇄망에서는 Portal에 닿지 않는 것이 정상 상태다 — 이 경로로 들어오는
 * 모든 실패는 "고장"이 아니라 "지금은 연결할 수 없음"으로 표현하고, 항상
 * `PORTAL_UNREACHABLE` 코드로 통일해 호출자가 수동 가져오기 대안을
 * 안내할지 판단할 수 있게 한다. */
function networkFailure(err: unknown): PortalApiFailure {
  const isTimeout = err instanceof Error && err.name === "AbortError";
  return {
    ok: false,
    code: "PORTAL_UNREACHABLE",
    message: isTimeout
      ? "Portal 응답이 시간 내에 오지 않았습니다. Portal 서버 주소와 네트워크 연결을 확인하세요."
      : `Portal에 연결할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`,
  };
}

interface AssetListResponseShape {
  items: Array<{
    id: string;
    type: string;
    name: string;
    classification: string;
    versions: Array<{
      id: string;
      version: string;
      status: string;
      // D-072: null unless this version currently has an *effective*
      // revocation — see `AssetVersionRevocationSummary` in
      // portal-openapi.yaml.
      active_revocation?: { effective_at: string; reason: string | null } | null;
    }>;
  }>;
}

export async function fetchCatalog(
  baseUrl: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<PortalApiResult<PortalCatalogAsset[]>> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${trimBaseUrl(baseUrl)}/api/v1/assets?page_size=100`,
      { headers: authHeaders(token) },
      DEFAULT_TIMEOUT_MS,
    );
    if (!res.ok) {
      return { ok: false, ...(await parseErrorEnvelope(res)) };
    }
    const body = (await res.json()) as AssetListResponseShape;
    const assets: PortalCatalogAsset[] = (body.items ?? []).map((a) => ({
      id: a.id,
      type: a.type,
      name: a.name,
      classification: a.classification,
      versions: (a.versions ?? []).map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        activeRevocation: v.active_revocation
          ? { effectiveAt: v.active_revocation.effective_at, reason: v.active_revocation.reason }
          : null,
      })),
    }));
    return { ok: true, data: assets };
  } catch (err) {
    return networkFailure(err);
  }
}

export interface CreateDistributionBody {
  root_type: "ASSET_VERSION";
  root_id: string;
  mode: "OFFLINE_BUNDLE";
}

export async function requestDistribution(
  baseUrl: string,
  token: string,
  body: CreateDistributionBody,
  fetchImpl: FetchLike = fetch,
): Promise<PortalApiResult<{ id: string; status: string }>> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${trimBaseUrl(baseUrl)}/api/v1/distributions`,
      {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      DEFAULT_TIMEOUT_MS,
    );
    if (!res.ok) {
      return { ok: false, ...(await parseErrorEnvelope(res)) };
    }
    const data = (await res.json()) as { id: string; status: string };
    return { ok: true, data };
  } catch (err) {
    return networkFailure(err);
  }
}

export interface DistributionStatusView {
  id: string;
  status: string;
  stage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean | null;
}

interface DistributionStatusShape {
  id: string;
  status: string;
  stage?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  retryable?: boolean | null;
}

export async function getDistribution(
  baseUrl: string,
  token: string,
  id: string,
  fetchImpl: FetchLike = fetch,
): Promise<PortalApiResult<DistributionStatusView>> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${trimBaseUrl(baseUrl)}/api/v1/distributions/${id}`,
      { headers: authHeaders(token) },
      DEFAULT_TIMEOUT_MS,
    );
    if (!res.ok) {
      return { ok: false, ...(await parseErrorEnvelope(res)) };
    }
    const data = (await res.json()) as DistributionStatusShape;
    return {
      ok: true,
      data: {
        id: data.id,
        status: data.status,
        stage: data.stage ?? null,
        errorCode: data.error_code ?? null,
        errorMessage: data.error_message ?? null,
        retryable: data.retryable ?? null,
      },
    };
  } catch (err) {
    return networkFailure(err);
  }
}

export async function downloadDistribution(
  baseUrl: string,
  token: string,
  id: string,
  fetchImpl: FetchLike = fetch,
): Promise<PortalApiResult<Buffer>> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${trimBaseUrl(baseUrl)}/api/v1/distributions/${id}/download`,
      { headers: authHeaders(token) },
      DOWNLOAD_TIMEOUT_MS,
    );
    if (!res.ok) {
      return { ok: false, ...(await parseErrorEnvelope(res)) };
    }
    const arrayBuffer = await res.arrayBuffer();
    return { ok: true, data: Buffer.from(arrayBuffer) };
  } catch (err) {
    return networkFailure(err);
  }
}
