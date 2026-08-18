// Shared Registry Agent/Prompt asset types + parsing/gating helpers.
//
// Originally lived under app/services/new/_components/ (Service Composer
// Step 3/Step 6 — registered Agent/registered Prompt). Moved here on
// 2026-08-17 (D-034 follow-up) so /chatbots/new's Quick Create "응답 Agent
// 변경 (고급)" section can reuse it too, without app/chatbots/new/_components
// importing across another screen's `_components` directory (root CLAUDE.md
// module-boundary rule — screen directories don't import each other's
// `_components`; app/_components is the shared home both already use for
// ui.tsx/role-context.tsx). Moving only — no behavior change; see
// app/services/new/_components/types.ts for the re-exports that keep that
// screen's existing imports working.
//
// Both screens list assets via `GET /api/v1/assets?type=...`, which already
// returns every version's full manifest (portal-api's
// `AssetOut`/`AssetVersionOut`, `selectinload(Asset.versions)` — see
// routers/assets.py::list_assets), so no second per-asset detail fetch is
// needed here (unlike StepKnowledge.tsx, which needs a separate indexing
// status lookup).

/** Any asset type's list/detail item shape from `GET /api/v1/assets?type=...`
 * — `AssetOut` in portal-api's schemas.py. Each version already carries its
 * full parsed `manifest`, so no second per-asset detail fetch is needed
 * (unlike Knowledge, which needs a separate indexing-status lookup). */
export interface RegistryAssetVersion {
  id: string;
  version: string;
  status: string;
  created_at: string;
  manifest: Record<string, unknown>;
}

export interface RegistryAsset {
  id: string;
  type: string;
  name: string;
  owner_org: string;
  classification: string;
  created_at: string;
  versions: RegistryAssetVersion[];
}

/** Parsed subset of an APPROVED Agent asset version's manifest — everything
 * downstream steps need. `entryRole` drives `knowledge_bindings[].role_id`/
 * `prompt_bindings[].role_id` for a registered Agent (there is no fixed
 * "answerer" role like the built-in standard profiles use). */
export interface RegistryAgentManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  entryRole: string;
  knowledgeRequired: boolean;
  mcpAllowed: boolean;
  maxContextTokens: number;
  timeoutSeconds: number;
  maxMcpCalls: number;
}

export interface RegistryAgentSelection {
  source: "registry";
  assetId: string;
  assetName: string;
  versionId: string;
  versionLabel: string;
  status: string;
  manifest: RegistryAgentManifest;
}

/** Parsed subset of an APPROVED Prompt asset version's manifest. */
export interface RegistryPromptManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  variables: { name: string; required: boolean; description: string }[];
}

export interface RegistryPromptSelection {
  assetId: string;
  assetName: string;
  versionId: string;
  versionLabel: string;
  status: string;
  manifest: RegistryPromptManifest;
}

/** Root CLAUDE.md UI rule: "호환되지 않는 선택지는 이유와 함께 비활성화한다."
 * Mirrors StepKnowledge.tsx's `usabilityReason` — only APPROVED versions are
 * selectable, because agent-runtime's Registry resolution path 2 refuses
 * anything else (`AGENT_VERSION_NOT_APPROVED`/`PROMPT_VERSION_NOT_APPROVED`).
 * This client-side gate is a UX nicety on top of that server-side refusal,
 * not a replacement for it. */
export function registryVersionUsabilityReason(status: string): string | undefined {
  if (status === "APPROVED") return undefined;
  return `승인되지 않아 실행할 수 없습니다 (버전 상태: ${status}).`;
}

export function parseAgentManifest(version: RegistryAssetVersion): RegistryAgentManifest | null {
  const m = version.manifest as Record<string, any>;
  const id = m?.id;
  const manifestVersion = m?.version;
  const name = m?.name;
  const entryRole = m?.workflow?.entry_role;
  const knowledgeRequired = m?.capabilities?.knowledge_required;
  const mcpAllowed = m?.capabilities?.mcp_allowed;
  if (
    typeof id !== "string" ||
    typeof manifestVersion !== "string" ||
    typeof name !== "string" ||
    typeof entryRole !== "string" ||
    typeof knowledgeRequired !== "boolean" ||
    typeof mcpAllowed !== "boolean"
  ) {
    return null;
  }
  return {
    id,
    version: manifestVersion,
    name,
    description: typeof m?.description === "string" ? m.description : "",
    entryRole,
    knowledgeRequired,
    mcpAllowed,
    maxContextTokens: typeof m?.limits?.max_context_tokens === "number" ? m.limits.max_context_tokens : 8192,
    timeoutSeconds: typeof m?.limits?.timeout_seconds === "number" ? m.limits.timeout_seconds : 60,
    maxMcpCalls: typeof m?.limits?.max_mcp_calls === "number" ? m.limits.max_mcp_calls : mcpAllowed ? 1 : 0,
  };
}

export function parsePromptManifest(version: RegistryAssetVersion): RegistryPromptManifest | null {
  const m = version.manifest as Record<string, any>;
  const id = m?.id;
  const manifestVersion = m?.version;
  const name = m?.name;
  if (typeof id !== "string" || typeof manifestVersion !== "string" || typeof name !== "string") {
    return null;
  }
  const rawVariables = Array.isArray(m?.variables) ? m.variables : [];
  return {
    id,
    version: manifestVersion,
    name,
    description: typeof m?.description === "string" ? m.description : "",
    variables: rawVariables
      .filter((v: unknown) => typeof v === "object" && v !== null && typeof (v as any).name === "string")
      .map((v: any) => ({
        name: v.name,
        required: v.required !== false,
        description: typeof v.description === "string" ? v.description : "",
      })),
  };
}

export function toAgentSelection(asset: RegistryAsset, version: RegistryAssetVersion): RegistryAgentSelection | null {
  const manifest = parseAgentManifest(version);
  if (!manifest) return null;
  return {
    source: "registry",
    assetId: asset.id,
    assetName: asset.name,
    versionId: version.id,
    versionLabel: version.version,
    status: version.status,
    manifest,
  };
}

export function toPromptSelection(asset: RegistryAsset, version: RegistryAssetVersion): RegistryPromptSelection | null {
  const manifest = parsePromptManifest(version);
  if (!manifest) return null;
  return {
    assetId: asset.id,
    assetName: asset.name,
    versionId: version.id,
    versionLabel: version.version,
    status: version.status,
    manifest,
  };
}
