// D-080 — pure parsing/validation of an installed MCP Tool asset's own
// `manifest.json` (`packages/schemas/manifests/mcp-tool-manifest.schema.json`)
// into exactly the fields agent-runtime's registration contract
// (`packages/schemas/api/mcp-tool-registration.schema.json`) needs. No fs/
// electron imports — fs reading stays in `asset-management.ts::readAssetManifest`
// (already used by D06's `buildKnowledgeCandidatesForChat` the same way);
// this file only decides whether the already-read JSON value is usable, per
// CLAUDE.md's "fs access stays in the main process; keep parsing/decision
// logic in pure, unit-tested functions."
//
// A manifest that is missing, unreadable, or missing a required field must
// produce an explicit, distinguishable failure — never a guessed
// registration (Task Brief §1). This module never falls back to a default
// for `server_alias`/`tool_name`/`risk_level`/`input_schema`: those are the
// exact fields the registration contract's safety boundary depends on
// (packages/schemas's `mcp-tool-registration.schema.json` top-level
// description, point 2 — a registration may only describe permission the
// Office Profile already granted, never widen it), so inventing one here
// would be worse than refusing.

export type McpToolManifestRefusalReason =
  | "manifest_not_object"
  | "manifest_type_mismatch"
  | "server_alias_missing"
  | "tool_name_missing"
  | "risk_level_not_read_only"
  | "input_schema_missing";

export interface McpToolManifestFailure {
  ok: false;
  reason: McpToolManifestRefusalReason;
  message: string;
}

/** The subset of the manifest this file's caller needs, already normalized
 * to the registration contract's own field names/casing (camelCase — the
 * HTTP client, `mcp-tool-registration-client.ts`, does the snake_case wire
 * mapping, exactly like `search-runtime-client.ts` does for D-079). */
export interface McpToolManifestFields {
  ok: true;
  toolName: string;
  serverAlias: string;
  riskLevel: "READ_ONLY";
  inputSchema: Record<string, unknown>;
  /** The manifest schema (`mcp-tool-manifest.schema.json`) has no
   * `confirmation_policy` field of its own — only `execution_guards.
   * requires_user_confirmation` (a boolean). This is the one place that gap
   * is bridged: `true` maps to the strictest policy (`ALWAYS`), `false`/
   * absent maps to the loosest (`NEVER`). The manifest schema cannot express
   * `ON_PARAMETER` today — a Package author who needs that granularity has
   * no way to declare it yet (documented here rather than silently losing
   * the distinction). */
  confirmationPolicy: "NEVER" | "ALWAYS";
  /** Human label for the registration's optional `label` field — the
   * manifest's own `name`, or `null` if absent/not a string (never
   * fabricated). */
  label: string | null;
}

export type McpToolManifestParseResult = McpToolManifestFields | McpToolManifestFailure;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses an already-read `manifest.json` value (from
 * `asset-management.ts::readAssetManifest`) into the fields D-080
 * registration needs, or an explicit failure reason. Never throws. */
export function parseMcpToolManifest(manifest: unknown): McpToolManifestParseResult {
  if (!isPlainObject(manifest)) {
    return {
      ok: false,
      reason: "manifest_not_object",
      message: "MCP Tool manifest.json 형식이 올바르지 않습니다(JSON 객체가 아님) — 다시 반입하세요.",
    };
  }
  if (manifest.type !== "mcp_tool") {
    return {
      ok: false,
      reason: "manifest_type_mismatch",
      message: `이 자산의 manifest.json이 mcp_tool 유형이 아닙니다(type: ${String(manifest.type)}).`,
    };
  }
  if (typeof manifest.server_alias !== "string" || !manifest.server_alias.trim()) {
    return {
      ok: false,
      reason: "server_alias_missing",
      message: "MCP Tool manifest.json에 server_alias가 없습니다 — 연결할 수 없습니다.",
    };
  }
  if (typeof manifest.tool_name !== "string" || !manifest.tool_name.trim()) {
    return {
      ok: false,
      reason: "tool_name_missing",
      message: "MCP Tool manifest.json에 tool_name이 없습니다 — 연결할 수 없습니다.",
    };
  }
  if (manifest.risk_level !== "READ_ONLY") {
    // 구현 원칙 8 — 이 PoC의 MCP Tool은 READ_ONLY만 등록 가능하다. Desktop이
    // 스스로 완화하지 않는다(fail closed) — 서버도 어차피 거절하지만, 여기서
    // 먼저 정직하게 실패해 잘못된 값을 보내지 않는다.
    return {
      ok: false,
      reason: "risk_level_not_read_only",
      message: `MCP Tool manifest.json의 risk_level이 READ_ONLY가 아닙니다(${String(manifest.risk_level)}) — 이 PoC는 READ_ONLY Tool만 연결할 수 있습니다.`,
    };
  }
  if (!isPlainObject(manifest.input_schema)) {
    return {
      ok: false,
      reason: "input_schema_missing",
      message: "MCP Tool manifest.json에 input_schema가 없습니다 — 연결할 수 없습니다.",
    };
  }

  const executionGuards = isPlainObject(manifest.execution_guards) ? manifest.execution_guards : null;
  const requiresConfirmation = executionGuards?.requires_user_confirmation === true;

  return {
    ok: true,
    toolName: manifest.tool_name.trim(),
    serverAlias: manifest.server_alias.trim(),
    riskLevel: "READ_ONLY",
    inputSchema: manifest.input_schema,
    confirmationPolicy: requiresConfirmation ? "ALWAYS" : "NEVER",
    label: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : null,
  };
}
