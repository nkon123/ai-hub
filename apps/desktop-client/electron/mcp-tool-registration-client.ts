// D-080 desktop half — pure HTTP client for agent-runtime's MCP Tool
// Activation contract (`packages/schemas/api/mcp-tool-registration.schema.json`,
// implemented in `services/agent-runtime`). Mirrors `search-runtime-client.ts`'s
// split for D-079: this is the ONLY module that speaks HTTP for D-080;
// `mcp-tool-connection.ts` does the fs (manifest) lookups and calls into this
// file.
//
// No fs/electron/node imports — `fetch` only — so this file can be imported
// safely from the renderer bundle too (same rule as `search-runtime-client.ts`,
// `portal-client.ts`, `connections.ts`).
//
// Every exported function returns a discriminated result and never throws
// past this module — a network failure/timeout becomes `reason: "unreachable"`
// with a Korean recovery hint that names agent-runtime specifically, per
// CLAUDE.md ("Desktop은 Runtime 장애 시 종료되지 않고 복구 안내를 제공한다").
//
// THE SAFETY BOUNDARY this file must never blur (schema's own top-level
// description, restated here because it governs what this client is allowed
// to send): there is deliberately no endpoint/URL field anywhere in the
// request — the dispatch address always comes from the deployment's Office
// Profile server-side. This client must never add one.

export type FetchLike = typeof fetch;

/** `MCPConfirmationPolicy` — NEVER < ON_PARAMETER < ALWAYS (least to most
 * confirmation required), matching the schema's closed enum exactly. */
export type McpConfirmationPolicy = "NEVER" | "ON_PARAMETER" | "ALWAYS";

/** `MCPToolRiskLevel` — closed, single-value enum on purpose (this PoC's MCP
 * surface is read-only end to end, 구현 원칙 8). */
export type McpToolRiskLevel = "READ_ONLY";

export interface McpToolRegistrationEntry {
  toolName: string;
  serverAlias: string;
  inputSchema: Record<string, unknown>;
  confirmationPolicy: McpConfirmationPolicy;
  riskLevel: McpToolRiskLevel;
  label: string | null;
  registeredAt: string;
}

/** Exactly the reasons documented on `RegisterMcpToolResponse` in the schema,
 * plus three client-side ones — none of these three are ever sent by the
 * server, they are this file's own diagnosis of an HTTP-level failure the
 * Error Envelope shape cannot represent: `"unreachable"` (network failure/
 * timeout), `"activation_api_unavailable"` (a bare HTTP 404 with no Error
 * Envelope body at all — same diagnosable shape `search-runtime-client.ts`
 * documents for its own equivalent), and `"unknown"` (the server's Error
 * Envelope was present but didn't carry a recognized `details.reason`, or the
 * body wasn't parseable at all — never invent a more specific reason than the
 * server actually gave). */
export type McpToolRefusalReason =
  | "mcp_tool_registration_disabled"
  | "tool_name_invalid"
  | "risk_level_not_read_only"
  | "confirmation_policy_invalid"
  | "label_too_long"
  | "server_alias_not_in_profile"
  | "server_alias_not_allowed_for_registration"
  | "tool_not_in_server_allowlist"
  | "input_schema_invalid"
  | "input_schema_declares_identity_field"
  | "confirmation_policy_weaker_than_builtin"
  | "unreachable"
  | "activation_api_unavailable"
  | "unknown";

const KNOWN_REASONS = new Set<string>([
  "mcp_tool_registration_disabled",
  "tool_name_invalid",
  "risk_level_not_read_only",
  "confirmation_policy_invalid",
  "label_too_long",
  "server_alias_not_in_profile",
  "server_alias_not_allowed_for_registration",
  "tool_not_in_server_allowlist",
  "input_schema_invalid",
  "input_schema_declares_identity_field",
  "confirmation_policy_weaker_than_builtin",
]);

/** D-080's single most load-bearing distinction (Task Brief §3): this reason
 * means the operator has not opted this Office Profile alias into dynamic
 * registration at all — a deployment policy state, not a broken asset.
 * Retrying the exact same request will be refused identically until an
 * operator changes that policy. Exported so the main-process orchestrator
 * and the renderer can both branch on it without re-deriving the string. */
export const MCP_TOOL_REGISTRATION_DISABLED_REASON: McpToolRefusalReason = "mcp_tool_registration_disabled";

export interface McpToolFailure {
  ok: false;
  reason: McpToolRefusalReason;
  /** 항상 한국어 — 화면에 그대로 표시 가능. Refusal은 서버의 Error Envelope
   * `error.message`(이미 사용자 대상 한국어 문장)를 그대로 쓴다 — 여기서
   * 별도 문구를 짓지 않는다(D-079 선례를 그대로 따른다). `details.reason`은
   * 로직/Telemetry 전용으로만 쓴다. */
  message: string;
}

export interface RegisterMcpToolSuccess {
  ok: true;
  entry: McpToolRegistrationEntry;
}
export type RegisterMcpToolResult = RegisterMcpToolSuccess | McpToolFailure;

export interface DeregisterMcpToolSuccess {
  ok: true;
  removed: boolean;
}
export type DeregisterMcpToolResult = DeregisterMcpToolSuccess | McpToolFailure;

export interface ListMcpToolsSuccess {
  ok: true;
  entries: McpToolRegistrationEntry[];
  registrationEnabled: boolean;
}
export type ListMcpToolsResult = ListMcpToolsSuccess | McpToolFailure;

// D-079's ACTIVATION_TIMEOUT_MS precedent — registration does real
// server-side validation work (Office Profile lookup, JSON Schema check),
// so it gets the same longer, separately-named budget as a bare health
// ping would not need.
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

interface RawMcpToolEntry {
  tool_name?: unknown;
  server_alias?: unknown;
  input_schema?: unknown;
  confirmation_policy?: unknown;
  risk_level?: unknown;
  label?: unknown;
  registered_at?: unknown;
}

const KNOWN_CONFIRMATION_POLICIES = new Set<string>(["NEVER", "ON_PARAMETER", "ALWAYS"]);

/** Defensive mapping — the wire shape is caller-asserted by agent-runtime,
 * but this file never trusts a field's type blindly (mirrors
 * `search-runtime-client.ts`'s `mapEntry`). Missing/malformed fields fall
 * back to a safe, honest default rather than crashing. */
function mapEntry(raw: RawMcpToolEntry): McpToolRegistrationEntry {
  return {
    toolName: typeof raw.tool_name === "string" ? raw.tool_name : "",
    serverAlias: typeof raw.server_alias === "string" ? raw.server_alias : "",
    inputSchema:
      raw.input_schema && typeof raw.input_schema === "object" && !Array.isArray(raw.input_schema)
        ? (raw.input_schema as Record<string, unknown>)
        : {},
    confirmationPolicy:
      typeof raw.confirmation_policy === "string" && KNOWN_CONFIRMATION_POLICIES.has(raw.confirmation_policy)
        ? (raw.confirmation_policy as McpConfirmationPolicy)
        : "ALWAYS", // 알 수 없는 값을 가장 느슨한 정책으로 추정하지 않는다 — 가장 엄격한 값으로 fail-closed.
    // `MCPToolRiskLevel`은 오늘 닫힌 한 값짜리 enum이다(스키마의
    // `MCPToolRiskLevel` 정의) — 다른 값으로 매핑할 곳이 없다.
    riskLevel: "READ_ONLY",
    label: typeof raw.label === "string" ? raw.label : null,
    registeredAt: typeof raw.registered_at === "string" ? raw.registered_at : "",
  };
}

/** Parses the common Error Envelope (07-data-api-contracts.md §10.2)
 * defensively — a non-JSON body or a missing/unrecognized `details.reason`
 * must still produce a usable Korean message rather than throwing. */
async function parseErrorEnvelope(res: Response): Promise<McpToolFailure> {
  try {
    const body = (await res.json()) as { error?: { message?: string; details?: { reason?: string } } };
    const rawReason = body?.error?.details?.reason;
    const message = body?.error?.message;
    if (typeof message === "string" && message) {
      const reason: McpToolRefusalReason =
        typeof rawReason === "string" && KNOWN_REASONS.has(rawReason)
          ? (rawReason as McpToolRefusalReason)
          : "unknown";
      return { ok: false, reason, message };
    }
  } catch {
    // 응답이 JSON이 아니거나 Envelope 형식이 아님 — 아래 기본 메시지로 대체.
  }
  return { ok: false, reason: "unknown", message: `agent-runtime 응답을 해석할 수 없습니다 (HTTP ${res.status}).` };
}

/** D-079의 `activationApiUnavailableFailure` 선례를 그대로 따른다 — 이
 * `/local/v1/mcp-tools` 계약이 추가되기 전에 이미 떠 있던 구버전
 * agent-runtime 프로세스일 가능성이 가장 높다는 진단이며, 단정하지 않는다. */
function activationApiUnavailableFailure(): McpToolFailure {
  return {
    ok: false,
    reason: "activation_api_unavailable",
    message:
      "agent-runtime을 재시작한 뒤 다시 시도하세요 — 가장 가능성 높은 원인은 MCP Tool 연결 API" +
      "(/local/v1/mcp-tools)가 추가되기 전에 시작된 프로세스가 재시작 없이 계속 실행 중인 것입니다(HTTP 404).",
  };
}

function unreachableFailure(err: unknown): McpToolFailure {
  const isTimeout = err instanceof Error && err.name === "AbortError";
  return {
    ok: false,
    reason: "unreachable",
    message: isTimeout
      ? "agent-runtime이 실행 중인지 확인한 뒤 다시 시도하세요 — 응답이 시간 내에 오지 않았습니다."
      : `agent-runtime이 실행 중인지, 주소가 올바른지 확인하세요 — 연결할 수 없습니다: ${err instanceof Error ? err.message : String(err)}.`,
  };
}

export interface RegisterMcpToolInput {
  toolName: string;
  serverAlias: string;
  inputSchema: Record<string, unknown>;
  confirmationPolicy: McpConfirmationPolicy;
  riskLevel: McpToolRiskLevel;
  label?: string | null;
  traceId?: string | null;
}

export async function registerMcpTool(
  baseUrl: string,
  input: RegisterMcpToolInput,
  fetchImpl: FetchLike = fetch,
): Promise<RegisterMcpToolResult> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${trimBaseUrl(baseUrl)}/local/v1/mcp-tools`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool_name: input.toolName,
          server_alias: input.serverAlias,
          input_schema: input.inputSchema,
          confirmation_policy: input.confirmationPolicy,
          risk_level: input.riskLevel,
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
    const body = (await res.json()) as { entry?: RawMcpToolEntry };
    if (!body?.entry) {
      return { ok: false, reason: "unknown", message: "agent-runtime 응답 형식이 올바르지 않습니다." };
    }
    return { ok: true, entry: mapEntry(body.entry) };
  } catch (err) {
    return unreachableFailure(err);
  }
}

export async function deregisterMcpTool(
  baseUrl: string,
  toolName: string,
  fetchImpl: FetchLike = fetch,
): Promise<DeregisterMcpToolResult> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${trimBaseUrl(baseUrl)}/local/v1/mcp-tools/${encodeURIComponent(toolName)}`,
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

export async function listMcpTools(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<ListMcpToolsResult> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${trimBaseUrl(baseUrl)}/local/v1/mcp-tools`,
      { method: "GET" },
      REGISTRATION_TIMEOUT_MS,
    );
    if (!res.ok) {
      if (res.status === 404) return activationApiUnavailableFailure();
      return await parseErrorEnvelope(res);
    }
    const body = (await res.json()) as { entries?: unknown; mcp_tool_registration_enabled?: unknown };
    if (!Array.isArray(body.entries) || typeof body.mcp_tool_registration_enabled !== "boolean") {
      return { ok: false, reason: "unknown", message: "agent-runtime 응답 형식이 올바르지 않습니다." };
    }
    return {
      ok: true,
      entries: body.entries.map((entry) => mapEntry(isPlainEntry(entry) ? entry : {})),
      registrationEnabled: body.mcp_tool_registration_enabled,
    };
  } catch (err) {
    return unreachableFailure(err);
  }
}

function isPlainEntry(value: unknown): value is RawMcpToolEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
