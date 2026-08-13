// D-079 desktop half — pure HTTP client for search-runtime's Local Knowledge
// Index Registration contract (`packages/schemas/api/knowledge-local-index.schema.json`,
// implemented in `services/search-runtime`). This is the ONLY module that
// speaks HTTP for D-079; `knowledge-activation.ts` does the fs lookups and
// calls into this file, same split `portal-client.ts` keeps from
// `store-install.ts`/`bundle-install.ts`.
//
// No fs/electron/node imports — `fetch` only — so this file can be imported
// safely from the renderer bundle too (same rule as `portal-client.ts`,
// `connections.ts`).
//
// Every exported function returns a discriminated result and never throws
// past this module — a network failure/timeout becomes `reason: "unreachable"`
// with a Korean recovery hint that names search-runtime specifically (not a
// generic "네트워크 오류" and never a raw stack trace), per CLAUDE.md ("Desktop은
// Runtime 장애 시 종료되지 않고 복구 안내를 제공한다").

export type FetchLike = typeof fetch;

export type LocalIndexSource = "DESKTOP_OFFLINE_BUNDLE";

export interface LocalIndexEntry {
  knowledgeId: string;
  indexPath: string;
  source: LocalIndexSource;
  label: string | null;
  registeredAt: string;
}

/** Exactly the reasons documented on `RegisterLocalIndexResponse` in the
 * schema, plus three client-side ones — none of these three are ever sent by
 * the server, they are this file's own diagnosis of an HTTP-level failure the
 * Error Envelope shape cannot represent:
 * `"unreachable"` (network failure/timeout), `"activation_api_unavailable"`
 * (a bare HTTP 404 with no Error Envelope body at all — see
 * `activationApiUnavailableFailure` below for why that specific shape means
 * something diagnosable, not just "unknown"), and `"unknown"` (the server's
 * Error Envelope was present but didn't carry a recognized `details.reason`,
 * or the body wasn't parseable at all — never invent a more specific reason
 * than the server actually gave). */
export type SearchRuntimeRefusalReason =
  | "local_indexes_disabled"
  | "path_outside_allowed_roots"
  | "path_not_absolute"
  | "path_not_a_directory"
  | "knowledge_id_invalid"
  | "index_meta_missing"
  | "index_meta_unreadable"
  | "index_meta_knowledge_id_mismatch"
  | "bm25_missing"
  | "bm25_legacy_pickle_only"
  | "chroma_missing"
  | "central_index_exists"
  | "source_not_allowed"
  | "label_too_long"
  | "unreachable"
  | "activation_api_unavailable"
  | "unknown";

const KNOWN_REASONS = new Set<string>([
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
]);

export interface SearchRuntimeFailure {
  ok: false;
  reason: SearchRuntimeRefusalReason;
  /** 항상 한국어 — 화면에 그대로 표시 가능. Refusal은 서버의 Error Envelope
   * `error.message`(이미 사용자 대상 한국어 문장)를 그대로 쓴다 — 여기서
   * 별도 문구를 짓지 않는다(Task Brief). `details.reason`은 로직/Telemetry
   * 전용으로만 쓴다. */
  message: string;
}

export interface RegisterLocalIndexSuccess {
  ok: true;
  entry: LocalIndexEntry;
}
export type RegisterLocalIndexResult = RegisterLocalIndexSuccess | SearchRuntimeFailure;

export interface UnregisterLocalIndexSuccess {
  ok: true;
  removed: boolean;
}
export type UnregisterLocalIndexResult = UnregisterLocalIndexSuccess | SearchRuntimeFailure;

export interface ListLocalIndexesSuccess {
  ok: true;
  entries: LocalIndexEntry[];
  localIndexesEnabled: boolean;
}
export type ListLocalIndexesResult = ListLocalIndexesSuccess | SearchRuntimeFailure;

// connections.ts's health-check timeout (2500ms) is tuned for a bare `GET
// /health` ping. Activation does real work server-side (open+validate
// index-meta.json, bm25, chroma) so it gets a longer, separately-named
// budget.
const ACTIVATION_TIMEOUT_MS = 8_000;

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
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

interface RawLocalIndexEntry {
  knowledge_id?: unknown;
  index_path?: unknown;
  source?: unknown;
  label?: unknown;
  registered_at?: unknown;
}

/** Defensive mapping — the wire shape is caller-asserted by search-runtime,
 * but this file never trusts a field's type blindly (mirrors
 * `portal-client.ts`'s snake_case->camelCase mapping style). Missing/
 * malformed fields fall back to a safe, honest default rather than crashing. */
function mapEntry(raw: RawLocalIndexEntry): LocalIndexEntry {
  return {
    knowledgeId: typeof raw.knowledge_id === "string" ? raw.knowledge_id : "",
    indexPath: typeof raw.index_path === "string" ? raw.index_path : "",
    // `LocalIndexSource` is a closed one-value enum today (schema's
    // `LocalIndexSource` definition) — no other value is possible on the
    // wire, so there is nothing else to map to.
    source: "DESKTOP_OFFLINE_BUNDLE",
    label: typeof raw.label === "string" ? raw.label : null,
    registeredAt: typeof raw.registered_at === "string" ? raw.registered_at : "",
  };
}

/** Parses the common Error Envelope (07-data-api-contracts.md §10.2)
 * defensively — a non-JSON body or a missing/unrecognized `details.reason`
 * must still produce a usable Korean message rather than throwing, per the
 * Task Brief. */
async function parseErrorEnvelope(res: Response): Promise<SearchRuntimeFailure> {
  try {
    const body = (await res.json()) as { error?: { message?: string; details?: { reason?: string } } };
    const rawReason = body?.error?.details?.reason;
    const message = body?.error?.message;
    if (typeof message === "string" && message) {
      const reason: SearchRuntimeRefusalReason =
        typeof rawReason === "string" && KNOWN_REASONS.has(rawReason)
          ? (rawReason as SearchRuntimeRefusalReason)
          : "unknown";
      return { ok: false, reason, message };
    }
  } catch {
    // 응답이 JSON이 아니거나 Envelope 형식이 아님 — 아래 기본 메시지로 대체.
  }
  return { ok: false, reason: "unknown", message: `search-runtime 응답을 해석할 수 없습니다 (HTTP ${res.status}).` };
}

/** 2026-08-13 실사용 진단: 사용자가 활성화를 눌렀는데 "search-runtime 응답을
 * 해석할 수 없습니다 (HTTP 404)"만 뜬 사고를 조사한 결과, 원인은 이
 * `/search/v1/local-indexes` 계약이 추가되기 전에 이미 떠 있던 구버전
 * search-runtime 프로세스였다(그 프로세스의 `/openapi.json`에는 `/health`와
 * `/search/v1/query`만 있었다) — 즉 이 URL 자체가 그 프로세스에 존재하지
 * 않는다. FastAPI가 미매칭 경로에 내는 순수 404는 이 파일의 Error Envelope
 * 파서가 이해하는 형식이 전혀 아니므로(`{"detail":"Not Found"}`, `error.message`
 * 없음) `parseErrorEnvelope`를 거치면 진짜 원인을 전혀 알려주지 못하는 일반
 * "unknown" 메시지로 뭉개진다. **정확한 진단은 아니다** — 이론상 다른 원인의
 * 404일 수도 있으므로 "가장 가능성 높은 원인"이라고만 말하고 단정하지
 * 않는다. */
function activationApiUnavailableFailure(): SearchRuntimeFailure {
  return {
    ok: false,
    reason: "activation_api_unavailable",
    message:
      "이 search-runtime에는 Knowledge 활성화 API(/search/v1/local-indexes)가 없습니다 (HTTP 404). " +
      "가장 가능성 높은 원인은 이 기능이 추가되기 전에 시작된 search-runtime 프로세스가 재시작 없이 " +
      "계속 실행 중인 것입니다 — search-runtime을 재시작한 뒤 다시 시도하세요.",
  };
}

function unreachableFailure(err: unknown): SearchRuntimeFailure {
  const isTimeout = err instanceof Error && err.name === "AbortError";
  return {
    ok: false,
    reason: "unreachable",
    message: isTimeout
      ? "search-runtime 응답이 시간 내에 오지 않았습니다. search-runtime이 실행 중인지 확인한 뒤 다시 시도하세요."
      : `search-runtime에 연결할 수 없습니다: ${err instanceof Error ? err.message : String(err)}. search-runtime이 실행 중인지, 주소가 올바른지 확인하세요.`,
  };
}

export interface RegisterLocalKnowledgeIndexInput {
  knowledgeId: string;
  indexPath: string;
  label?: string | null;
  traceId?: string | null;
}

export async function registerLocalKnowledgeIndex(
  baseUrl: string,
  input: RegisterLocalKnowledgeIndexInput,
  fetchImpl: FetchLike = fetch,
): Promise<RegisterLocalIndexResult> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${trimBaseUrl(baseUrl)}/search/v1/local-indexes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          knowledge_id: input.knowledgeId,
          index_path: input.indexPath,
          source: "DESKTOP_OFFLINE_BUNDLE",
          label: input.label ?? null,
          trace_id: input.traceId ?? null,
        }),
      },
      ACTIVATION_TIMEOUT_MS,
    );
    if (!res.ok) {
      if (res.status === 404) {
        return activationApiUnavailableFailure();
      }
      return await parseErrorEnvelope(res);
    }
    const body = (await res.json()) as { entry?: RawLocalIndexEntry };
    if (!body?.entry) {
      return { ok: false, reason: "unknown", message: "search-runtime 응답 형식이 올바르지 않습니다." };
    }
    return { ok: true, entry: mapEntry(body.entry) };
  } catch (err) {
    return unreachableFailure(err);
  }
}

export async function unregisterLocalKnowledgeIndex(
  baseUrl: string,
  knowledgeId: string,
  fetchImpl: FetchLike = fetch,
): Promise<UnregisterLocalIndexResult> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${trimBaseUrl(baseUrl)}/search/v1/local-indexes/${encodeURIComponent(knowledgeId)}`,
      { method: "DELETE" },
      ACTIVATION_TIMEOUT_MS,
    );
    if (!res.ok) {
      if (res.status === 404) {
        return activationApiUnavailableFailure();
      }
      return await parseErrorEnvelope(res);
    }
    const body = (await res.json()) as { removed?: unknown };
    return { ok: true, removed: body?.removed === true };
  } catch (err) {
    return unreachableFailure(err);
  }
}

export async function listLocalKnowledgeIndexes(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<ListLocalIndexesResult> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${trimBaseUrl(baseUrl)}/search/v1/local-indexes`,
      { method: "GET" },
      ACTIVATION_TIMEOUT_MS,
    );
    if (!res.ok) {
      if (res.status === 404) {
        return activationApiUnavailableFailure();
      }
      return await parseErrorEnvelope(res);
    }
    const body = (await res.json()) as { entries?: RawLocalIndexEntry[]; local_indexes_enabled?: unknown };
    return {
      ok: true,
      entries: Array.isArray(body?.entries) ? body.entries.map(mapEntry) : [],
      localIndexesEnabled: body?.local_indexes_enabled === true,
    };
  } catch (err) {
    return unreachableFailure(err);
  }
}
