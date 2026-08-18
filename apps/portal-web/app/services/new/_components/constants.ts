// The 2 built-in standard Agent/Prompt profiles for the Composer wizard, plus
// (2026-08-16) the glue that lets Steps 3/6 offer Portal Registry-registered
// Agent/Prompt asset versions alongside them.
//
// D-034 (open-decisions.md) originally noted that Agent/Prompt assets were
// NOT in the Portal Registry at all — only these 2 static configs under
// services/agent-runtime/config/{standard-agent,standard-db-agent,
// standard-prompt,standard-db-prompt}/*.json existed, and
// `GET /api/v1/assets?type=agent`/`type=prompt` always returned
// `{items: [], total: 0}`. That registration gap closed on 2026-08-16 (P05's
// structured Agent/Prompt forms) — but the *execution* side was still
// missing until this same date: agent-runtime's `manifests.py` already had
// an unused "resolution path 2" (`resolve_registry_agent_config`, wired
// through `POST /local/v1/runs`'s `registry_agent_version_id`/
// `registry_prompt_version_id`) that no UI ever called. `StepAgent.tsx` and
// `StepPrompt.tsx` now call `GET /api/v1/assets?type=agent`/`type=prompt`
// for real and let a registered, APPROVED Agent+Prompt pair be selected and
// actually Preview-run — see `resolveAgentOption()` below and
// `registryManifests.ts` for the parsing/gating helpers both steps share.
//
// The 2 standard options below still exist and still work exactly as
// before — the ids/versions are copied byte-for-byte from their manifest
// files so agent_ref/prompt_bindings in the generated Service Definition
// point at the same ids the running agent-runtime (and hr-chatbot-service
// fixture) already use. They remain the only Agent choice that needs no
// Registry round-trip and no APPROVED-version gate (D-034's local fallback,
// unchanged).

import type { AgentProfileId, AgentSelection, Classification, RegistryPromptSelection } from "./types";

/** Unified shape every downstream step (StepMcp/StepPrompt/StepLimits/
 * StepPreview/StepSummary/buildServiceDefinition) consumes, regardless of
 * whether the Agent came from the 2 built-in profiles or a Portal-registered
 * asset version (D-034 path 2, resolveAgentOption() below). `prompt` is only
 * absent for a registry Agent before Step 6 picks its paired Prompt — every
 * consumer that needs `prompt` runs at/after Step 6, where page.tsx already
 * gates progress on it being non-null (see page.tsx canGoNext case 6). */
export interface AgentOption {
  /** Stable React key / "selected" comparison — profileId for standard,
   * asset id for registry (a registry Agent asset has exactly one selectable
   * version at a time, so the asset id alone is enough to key on). */
  id: string;
  source: "standard" | "registry";
  /** agent_ref.id — the manifest's OWN `id` field, never the Portal asset_id
   * or asset-version id (those are different identifiers — see
   * `registryAgentVersionId` below for the one agent-runtime actually needs
   * for Registry resolution). */
  manifestId: string;
  manifestVersion: string;
  name: string;
  description: string;
  roleId: string;
  knowledgeRequired: boolean;
  mcpAllowed: boolean;
  maxContextTokens: number;
  timeoutSeconds: number;
  maxMcpCalls: number;
  /** Portal asset-VERSION id — set only for `source: "registry"`. This is
   * what `registry_agent_version_id` on `POST /local/v1/runs` needs
   * (agent-runtime's `manifests.py` resolution path 2), and is intentionally
   * NOT the same value as `manifestId` above. */
  registryAgentVersionId?: string;
  prompt?: PromptOption;
}

export interface PromptOption {
  manifestId: string;
  manifestVersion: string;
  name: string;
  description: string;
  variables: { name: string; required: boolean; description: string }[];
  /** Portal asset-VERSION id — set only when this Prompt came from the
   * Registry (Step 6's registered-Prompt picker), for the same reason
   * `AgentOption.registryAgentVersionId` exists. */
  registryPromptVersionId?: string;
}

const STANDARD_PROMPT: PromptOption = {
  manifestId: "550e8400-e29b-41d4-a716-446655440020",
  manifestVersion: "1.0.0",
  name: "Standard Knowledge Answer Prompt",
  description: "Knowledge 검색 결과를 바탕으로 한국어 답변을 생성하는 표준 프롬프트",
  variables: [
    { name: "question", required: true, description: "사용자 질문" },
    { name: "context_chunks", required: true, description: "Knowledge 검색 결과 청크 목록" },
  ],
};

const STANDARD_DB_PROMPT: PromptOption = {
  manifestId: "550e8400-e29b-41d4-a716-446655440021",
  manifestVersion: "1.0.0",
  name: "Standard Knowledge+DB Answer Prompt",
  description: "Knowledge 검색 결과와 읽기 전용 MCP Tool 조회 결과를 함께 근거로 삼는 프롬프트",
  variables: [
    { name: "question", required: true, description: "사용자 질문" },
    { name: "context_chunks", required: false, description: "Knowledge 검색 결과 청크 목록" },
    { name: "tool_results", required: false, description: "읽기 전용 MCP Tool 호출 결과 목록" },
  ],
};

export const AGENT_OPTIONS: AgentOption[] = [
  {
    id: "standard-agent",
    source: "standard",
    manifestId: "550e8400-e29b-41d4-a716-446655440010",
    manifestVersion: "1.0.0",
    name: "Standard Knowledge Chat Agent",
    description: "Knowledge 기반 Q&A를 수행하는 표준 챗봇 에이전트",
    roleId: "answerer",
    knowledgeRequired: true,
    mcpAllowed: false,
    maxContextTokens: 8192,
    timeoutSeconds: 60,
    maxMcpCalls: 0,
    prompt: STANDARD_PROMPT,
  },
  {
    id: "standard-db-agent",
    source: "standard",
    manifestId: "550e8400-e29b-41d4-a716-446655440011",
    manifestVersion: "1.0.0",
    name: "Standard Knowledge+DB Chat Agent",
    description:
      "Knowledge 검색과 함께 읽기 전용 MCP DB Metadata Tool을 명시적 Workflow로 호출할 수 있는 챗봇 에이전트",
    roleId: "answerer",
    knowledgeRequired: false,
    mcpAllowed: true,
    maxContextTokens: 8192,
    timeoutSeconds: 60,
    maxMcpCalls: 1,
    prompt: STANDARD_DB_PROMPT,
  },
];

/**
 * Resolve the wizard's Step 3(+6) selection into the unified `AgentOption`
 * shape every later step consumes — D-034 path 2 (open-decisions.md):
 * `services/agent-runtime/src/agent_runtime/manifests.py`'s
 * `resolve_registry_agent_config` already lets `POST /local/v1/runs` execute
 * a Portal-registered Agent+Prompt pair (APPROVED-only, schema-revalidated,
 * cached) via `registry_agent_version_id`/`registry_prompt_version_id` — no
 * agent-runtime/contract change was needed, only this wizard actually
 * offering the choice and wiring those two ids through
 * (StepPreview.tsx/buildServiceDefinition.ts). Returns `null` only when
 * nothing is selected yet; a registry Agent with no Prompt chosen yet still
 * resolves (with `prompt: undefined`) so Steps 4/5 can render.
 */
export function resolveAgentOption(
  agent: AgentSelection | null,
  registryPrompt: RegistryPromptSelection | null
): AgentOption | null {
  if (!agent) return null;

  if (agent.source === "standard") {
    return AGENT_OPTIONS.find((a) => a.id === agent.profileId) ?? null;
  }

  const prompt: PromptOption | undefined = registryPrompt
    ? {
        manifestId: registryPrompt.manifest.id,
        manifestVersion: registryPrompt.manifest.version,
        name: registryPrompt.manifest.name,
        description: registryPrompt.manifest.description,
        variables: registryPrompt.manifest.variables,
        registryPromptVersionId: registryPrompt.versionId,
      }
    : undefined;

  return {
    id: agent.assetId,
    source: "registry",
    manifestId: agent.manifest.id,
    manifestVersion: agent.manifest.version,
    name: agent.manifest.name,
    description: agent.manifest.description,
    roleId: agent.manifest.entryRole,
    knowledgeRequired: agent.manifest.knowledgeRequired,
    mcpAllowed: agent.manifest.mcpAllowed,
    maxContextTokens: agent.manifest.maxContextTokens,
    timeoutSeconds: agent.manifest.timeoutSeconds,
    maxMcpCalls: agent.manifest.maxMcpCalls,
    registryAgentVersionId: agent.versionId,
    prompt,
  };
}

// fixtures/valid/office-profile-default/office-profile.json — the only Office
// Profile in this PoC. model_aliases only has one chat alias; there is no
// selection endpoint, so this is presented as a single fixed option rather
// than a fabricated multi-choice dropdown.
export const MODEL_ALIAS = {
  alias: "default-chat",
  provider: "ollama",
  modelId: "exaone3.5:7.8b",
  maxContextTokens: 32768,
};

export const OFFICE_PROFILE_ORG = "miracom";
export const OFFICE_PROFILE_SITES = ["headquarters", "gumi"];

// The only Retrieval Profile referenced anywhere in this codebase's fixtures
// (fixtures/valid/hr-chatbot-service/service-definition.json). No registry
// endpoint exists to list alternatives, so it is fixed rather than offered as
// a fake choice.
export const RETRIEVAL_PROFILE_REF = { name: "default-korean", version: "1.0.0" };

export const DEFAULT_CLASSIFICATION: Classification = "INTERNAL";

// security_policy.roles.Role — packages/security-policy/src/security_policy/roles.py.
export const TARGET_USER_ROLES = [
  "USER",
  "CREATOR",
  "TECH_REVIEWER",
  "SECURITY_REVIEWER",
  "RELEASE_MANAGER",
  "AUDITOR",
  "ADMIN",
] as const;
