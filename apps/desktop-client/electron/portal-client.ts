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
  /** portal-api Error Envelope의 `details` 그대로 — 지금 실제로 채워지는
   * 것은 `VALIDATION_ERROR`의 `details.errors`(필드별 오류 목록, Manifest
   * Schema 검증 실패 시)뿐이다. 다른 오류 코드는 대체로 details가 없다. */
  details?: { errors?: unknown[] } & Record<string, unknown>;
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
  /** 사용자가 명시적으로 취소했을 때만 넘긴다(Agent 초안 Portal 업로드
   * 취소 — `createAsset`만 이 인자를 실제로 쓴다). timeout Abort와 같은
   * 내부 controller로 합쳐 걸기만 하고, 이 함수는 취소와 timeout을
   * 구분하지 않는다 — 호출자가 자신의 취소 의도(ref)로 구분한다. */
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

async function parseErrorEnvelope(
  res: Response,
): Promise<{ code: string; message: string; details?: Record<string, unknown> }> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    if (body?.error?.code && body?.error?.message) {
      return { code: body.error.code, message: body.error.message, details: body.error.details };
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

// ---------------------------------------------------------------------------
// D06 대화 -> Agent 초안 Portal 업로드 — Desktop Client PR2. `POST
// /api/v1/assets`는 항상 DRAFT 버전을 만든다(portal-api가 강제하는 동작이며
// 이 함수가 별도로 검증하지 않는다) — 승인/게시로 이어지는 어떤 다른
// 엔드포인트도 이 파일은 호출하지 않는다.
// ---------------------------------------------------------------------------

export interface CreateAssetFile {
  /** 사용자가 입력한 파일명이 아니라 항상 호출자가 고정한 이름이다(Prompt
   * Manifest의 `template.file`과 일치해야 함 — `agent-draft.ts`의
   * `AGENT_DRAFT_TEMPLATE_FILE_NAME`). */
  filename: string;
  /** UTF-8 텍스트 콘텐츠만 다룬다 — 이 함수의 현재 유일한 호출자(Agent 초안
   * 업로드)가 첨부하는 파일은 `template.md` 하나뿐이다. */
  content: string;
}

export interface CreateAssetResult {
  id: string;
  assetId: string;
  version: string;
  status: string;
}

/** `POST /api/v1/assets` — multipart/form-data로 Manifest(JSON 문자열
 * `manifest` Form 필드)와 첨부 파일(`files`)을 함께 보낸다. 업로드
 * 상한(`ASSET_UPLOAD_TOO_MANY_FILES`/`ASSET_UPLOAD_EXTENSION_REJECTED`/
 * `ASSET_UPLOAD_FILE_TOO_LARGE`/`ASSET_UPLOAD_REQUEST_TOO_LARGE`)·스키마
 * 검증 실패(`VALIDATION_ERROR`, `details.errors`)·권한 부족
 * (`PERMISSION_DENIED`, HTTP 403)는 모두 `parseErrorEnvelope`가 그대로
 * 통과시킨다 — 이 함수는 코드/메시지를 뭉개거나 재작성하지 않는다. 호출자가
 * `code`로 분기해 사용자에게 원인을 그대로 보여준다.
 *
 * `externalSignal`은 사용자가 명시적으로 업로드를 취소했을 때만 넘긴다 —
 * 타임아웃과 같은 내부 메커니즘(`fetchWithTimeout`)에 합쳐 건다. */
export async function createAsset(
  baseUrl: string,
  token: string,
  manifest: Record<string, unknown>,
  files: CreateAssetFile[],
  fetchImpl: FetchLike = fetch,
  externalSignal?: AbortSignal,
): Promise<PortalApiResult<CreateAssetResult>> {
  try {
    const form = new FormData();
    form.append("manifest", JSON.stringify(manifest));
    for (const file of files) {
      form.append("files", new Blob([file.content], { type: "text/markdown" }), file.filename);
    }
    const res = await fetchWithTimeout(
      fetchImpl,
      `${trimBaseUrl(baseUrl)}/api/v1/assets`,
      // Content-Type을 직접 지정하지 않는다 — FormData를 body로 넘기면
      // fetch가 boundary를 포함한 multipart Content-Type을 스스로 채운다.
      { method: "POST", headers: authHeaders(token), body: form },
      DEFAULT_TIMEOUT_MS,
      externalSignal,
    );
    if (!res.ok) {
      return { ok: false, ...(await parseErrorEnvelope(res)) };
    }
    const data = (await res.json()) as { id: string; asset_id: string; version: string; status: string };
    return {
      ok: true,
      data: { id: data.id, assetId: data.asset_id, version: data.version, status: data.status },
    };
  } catch (err) {
    return networkFailure(err);
  }
}
