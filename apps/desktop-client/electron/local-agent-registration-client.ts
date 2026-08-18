// D-034 해석 경로 4 desktop half — pure HTTP client for agent-runtime's Local
// Agent Package Activation contract
// (`packages/schemas/api/local-agent-registration.schema.json`, implemented
// in `services/agent-runtime`). Mirrors `mcp-tool-registration-client.ts`'s
// split for D-080 / `search-runtime-client.ts`'s for D-079: this is the ONLY
// module that speaks HTTP for this feature; `local-agent-registration.ts`
// does the InstalledAssetsStore round-trip and calls into this file.
//
// No fs/electron/node imports — `fetch` only — so this file can be imported
// safely from the renderer bundle too (same rule as the other two clients).
//
// Every exported function returns a discriminated result and never throws
// past this module — a network failure/timeout becomes `reason: "unreachable"`
// with a Korean recovery hint that names agent-runtime specifically, per
// CLAUDE.md ("Desktop은 Runtime 장애 시 종료되지 않고 복구 안내를 제공한다").
//
// THE BOUNDARY this file must never blur (schema's own top-level
// description, restated here because it governs what this client is allowed
// to send): the request body carries only `agent_asset_id`/`agent_version`/
// `prompt_asset_id`/`prompt_version`/`label`/`trace_id` — never a file path
// or directory name (root CLAUDE.md 코드 규칙: "사용자가 제공한 파일명으로
// 파일 경로를 만들지 않는다"). This client must never add one.

export type FetchLike = typeof fetch;

export interface LocalAgentRegistrationEntry {
  agentAssetId: string;
  agentVersion: string;
  promptAssetId: string;
  promptVersion: string;
  agentDir: string;
  promptDir: string;
  label: string | null;
  registeredAt: string;
}

/** Exactly the closed `details.reason` set documented on
 * `RegisterLocalAgentResponse` in the schema, plus three client-side ones —
 * none of these three are ever sent by the server, they are this file's own
 * diagnosis of an HTTP-level failure the Error Envelope shape cannot
 * represent: `"unreachable"` (network failure/timeout),
 * `"activation_api_unavailable"` (a bare HTTP 404 with no Error Envelope
 * body at all — same diagnosable shape the other two clients document), and
 * `"unknown"` (the server's Error Envelope was present but didn't carry a
 * recognized `details.reason`, or the body wasn't parseable at all — never
 * invent a more specific reason than the server actually gave). */
export type LocalAgentRefusalReason =
  | "local_agents_disabled"
  | "agent_asset_id_invalid"
  | "agent_version_invalid"
  | "prompt_asset_id_invalid"
  | "prompt_version_invalid"
  | "label_too_long"
  | "path_outside_allowed_roots"
  | "agent_install_not_found"
  | "prompt_install_not_found"
  | "agent_manifest_missing"
  | "prompt_manifest_missing"
  | "agent_manifest_unreadable"
  | "prompt_manifest_unreadable"
  | "agent_manifest_schema_invalid"
  | "prompt_manifest_schema_invalid"
  | "agent_manifest_id_mismatch"
  | "agent_manifest_version_mismatch"
  | "prompt_manifest_id_mismatch"
  | "prompt_manifest_version_mismatch"
  | "prompt_template_missing"
  | "unreachable"
  | "activation_api_unavailable"
  | "unknown";

const KNOWN_REASONS = new Set<string>([
  "local_agents_disabled",
  "agent_asset_id_invalid",
  "agent_version_invalid",
  "prompt_asset_id_invalid",
  "prompt_version_invalid",
  "label_too_long",
  "path_outside_allowed_roots",
  "agent_install_not_found",
  "prompt_install_not_found",
  "agent_manifest_missing",
  "prompt_manifest_missing",
  "agent_manifest_unreadable",
  "prompt_manifest_unreadable",
  "agent_manifest_schema_invalid",
  "prompt_manifest_schema_invalid",
  "agent_manifest_id_mismatch",
  "agent_manifest_version_mismatch",
  "prompt_manifest_id_mismatch",
  "prompt_manifest_version_mismatch",
  "prompt_template_missing",
]);

/** Task Brief 제약 B의 핵심 분기점: 이 배포가 allow-root
 * (`AGENT_RUNTIME_LOCAL_AGENT_ROOTS`)를 아예 설정하지 않았다는 뜻이며,
 * Desktop이 스스로 고칠 수 없는 배포 정책 상태다 — 재시도해도 운영자가
 * 그 환경 변수를 설정하기 전까지는 항상 같은 이유로 거절된다. */
export const LOCAL_AGENTS_DISABLED_REASON: LocalAgentRefusalReason = "local_agents_disabled";

export interface LocalAgentFailure {
  ok: false;
  reason: LocalAgentRefusalReason;
  /** 항상 한국어 — 화면에 그대로 표시 가능. Refusal은 서버의 Error Envelope
   * `error.message`(이미 사용자 대상 한국어 문장)를 그대로 쓴다 — 여기서
   * 별도 문구를 짓지 않는다(D-079/D-080 선례). `details.reason`은
   * 로직/Telemetry 전용으로만 쓴다. */
  message: string;
}

export interface RegisterLocalAgentSuccess {
  ok: true;
  entry: LocalAgentRegistrationEntry;
}
export type RegisterLocalAgentResult = RegisterLocalAgentSuccess | LocalAgentFailure;

export interface DeleteLocalAgentSuccess {
  ok: true;
  removed: boolean;
}
export type DeleteLocalAgentResult = DeleteLocalAgentSuccess | LocalAgentFailure;

export interface ListLocalAgentsSuccess {
  ok: true;
  entries: LocalAgentRegistrationEntry[];
  localAgentsEnabled: boolean;
}
export type ListLocalAgentsResult = ListLocalAgentsSuccess | LocalAgentFailure;

// D-079/D-080의 ACTIVATION_TIMEOUT_MS/REGISTRATION_TIMEOUT_MS 선례 — 등록은
// 서버측에서 두 Manifest를 읽고 스키마 검증까지 하는 실제 작업이라, 단순
// health ping보다 더 긴 별도 예산을 쓴다.
const REGISTRATION_TIMEOUT_MS = 8_000;

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

interface RawLocalAgentEntry {
  agent_asset_id?: unknown;
  agent_version?: unknown;
  prompt_asset_id?: unknown;
  prompt_version?: unknown;
  agent_dir?: unknown;
  prompt_dir?: unknown;
  label?: unknown;
  registered_at?: unknown;
}

/** Defensive mapping — the wire shape is caller-asserted by agent-runtime,
 * but this file never trusts a field's type blindly (mirrors the other two
 * clients' `mapEntry`). Missing/malformed fields fall back to a safe, honest
 * default rather than crashing. */
function mapEntry(raw: RawLocalAgentEntry): LocalAgentRegistrationEntry {
  return {
    agentAssetId: typeof raw.agent_asset_id === "string" ? raw.agent_asset_id : "",
    agentVersion: typeof raw.agent_version === "string" ? raw.agent_version : "",
    promptAssetId: typeof raw.prompt_asset_id === "string" ? raw.prompt_asset_id : "",
    promptVersion: typeof raw.prompt_version === "string" ? raw.prompt_version : "",
    agentDir: typeof raw.agent_dir === "string" ? raw.agent_dir : "",
    promptDir: typeof raw.prompt_dir === "string" ? raw.prompt_dir : "",
    label: typeof raw.label === "string" ? raw.label : null,
    registeredAt: typeof raw.registered_at === "string" ? raw.registered_at : "",
  };
}

/** Parses the common Error Envelope (07-data-api-contracts.md §10.2)
 * defensively — a non-JSON body or a missing/unrecognized `details.reason`
 * must still produce a usable Korean message rather than throwing. */
async function parseErrorEnvelope(res: Response): Promise<LocalAgentFailure> {
  try {
    const body = (await res.json()) as { error?: { message?: string; details?: { reason?: string } } };
    const rawReason = body?.error?.details?.reason;
    const message = body?.error?.message;
    if (typeof message === "string" && message) {
      const reason: LocalAgentRefusalReason =
        typeof rawReason === "string" && KNOWN_REASONS.has(rawReason)
          ? (rawReason as LocalAgentRefusalReason)
          : "unknown";
      return { ok: false, reason, message };
    }
  } catch {
    // 응답이 JSON이 아니거나 Envelope 형식이 아님 — 아래 기본 메시지로 대체.
  }
  return { ok: false, reason: "unknown", message: `agent-runtime 응답을 해석할 수 없습니다 (HTTP ${res.status}).` };
}

/** D-079/D-080의 `activationApiUnavailableFailure` 선례를 그대로 따른다 — 이
 * `/local/v1/local-agents` 계약이 추가되기 전에 이미 떠 있던 구버전
 * agent-runtime 프로세스일 가능성이 가장 높다는 진단이며, 단정하지 않는다. */
function activationApiUnavailableFailure(): LocalAgentFailure {
  return {
    ok: false,
    reason: "activation_api_unavailable",
    message:
      "agent-runtime을 재시작한 뒤 다시 시도하세요 — 가장 가능성 높은 원인은 Local Agent 등록 API" +
      "(/local/v1/local-agents)가 추가되기 전에 시작된 프로세스가 재시작 없이 계속 실행 중인 것입니다(HTTP 404).",
  };
}

function unreachableFailure(err: unknown): LocalAgentFailure {
  const isTimeout = err instanceof Error && err.name === "AbortError";
  return {
    ok: false,
    reason: "unreachable",
    message: isTimeout
      ? "agent-runtime이 실행 중인지 확인한 뒤 다시 시도하세요 — 응답이 시간 내에 오지 않았습니다."
      : `agent-runtime이 실행 중인지, 주소가 올바른지 확인하세요 — 연결할 수 없습니다: ${err instanceof Error ? err.message : String(err)}.`,
  };
}

export interface RegisterLocalAgentInput {
  agentAssetId: string;
  agentVersion: string;
  promptAssetId: string;
  promptVersion: string;
  label?: string | null;
  traceId?: string | null;
}

export async function registerLocalAgent(
  baseUrl: string,
  input: RegisterLocalAgentInput,
  fetchImpl: FetchLike = fetch,
): Promise<RegisterLocalAgentResult> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${trimBaseUrl(baseUrl)}/local/v1/local-agents`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_asset_id: input.agentAssetId,
          agent_version: input.agentVersion,
          prompt_asset_id: input.promptAssetId,
          prompt_version: input.promptVersion,
          label: input.label ?? null,
          trace_id: input.traceId ?? null,
        }),
      },
      REGISTRATION_TIMEOUT_MS,
    );
    if (!res.ok) {
      if (res.status === 404) {
        return activationApiUnavailableFailure();
      }
      return await parseErrorEnvelope(res);
    }
    const body = (await res.json()) as { entry?: RawLocalAgentEntry };
    if (!body?.entry) {
      return { ok: false, reason: "unknown", message: "agent-runtime 응답 형식이 올바르지 않습니다." };
    }
    return { ok: true, entry: mapEntry(body.entry) };
  } catch (err) {
    return unreachableFailure(err);
  }
}

export async function deleteLocalAgent(
  baseUrl: string,
  agentAssetId: string,
  fetchImpl: FetchLike = fetch,
): Promise<DeleteLocalAgentResult> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${trimBaseUrl(baseUrl)}/local/v1/local-agents/${encodeURIComponent(agentAssetId)}`,
      { method: "DELETE" },
      REGISTRATION_TIMEOUT_MS,
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

export async function listLocalAgents(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<ListLocalAgentsResult> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${trimBaseUrl(baseUrl)}/local/v1/local-agents`,
      { method: "GET" },
      REGISTRATION_TIMEOUT_MS,
    );
    if (!res.ok) {
      if (res.status === 404) return activationApiUnavailableFailure();
      return await parseErrorEnvelope(res);
    }
    const body = (await res.json()) as { entries?: unknown; local_agents_enabled?: unknown };
    if (!Array.isArray(body.entries) || typeof body.local_agents_enabled !== "boolean") {
      return { ok: false, reason: "unknown", message: "agent-runtime 응답 형식이 올바르지 않습니다." };
    }
    return {
      ok: true,
      entries: body.entries.map((entry) => mapEntry(isPlainEntry(entry) ? entry : {})),
      localAgentsEnabled: body.local_agents_enabled,
    };
  } catch (err) {
    return unreachableFailure(err);
  }
}

function isPlainEntry(value: unknown): value is RawLocalAgentEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
