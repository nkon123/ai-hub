// Shared parsing/gating helpers for Step 3 (registered Agent) and Step 6
// (registered Prompt) — both list assets via `GET /api/v1/assets?type=...`,
// which already returns every version's full manifest (portal-api's
// `AssetOut`/`AssetVersionOut`, `selectinload(Asset.versions)` — see
// routers/assets.py::list_assets), so no second per-asset detail fetch is
// needed here (unlike StepKnowledge.tsx, which needs a separate indexing
// status lookup).

import type {
  RegistryAgentManifest,
  RegistryAgentSelection,
  RegistryAsset,
  RegistryAssetVersion,
  RegistryPromptManifest,
  RegistryPromptSelection,
} from "./types";

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
