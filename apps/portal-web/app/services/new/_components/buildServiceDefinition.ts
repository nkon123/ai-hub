// Pure mapping from wizard state -> a service-definition.schema.json-shaped
// object. No field here is invented: every key matches
// packages/schemas/manifests/service-definition.schema.json's
// `additionalProperties: false` object shapes exactly (verified by hand
// against the schema before writing this wizard). In particular:
//   - there is no input/output schema field anywhere in the Service
//     Definition, so Steps 7/8 of the spec (입력 정의/출력 정의) have no
//     home here — see page.tsx's PLACEHOLDER_STEPS for how that is surfaced.
//   - mcp_bindings stays [] always: Step "MCP Tool 연결" never produces a
//     binding in this build (see StepMcp.tsx for why).
//   - chatbot_config is intentionally omitted — the schema documents it as
//     "Present only for Knowledge Chatbot Quick Create services", which this
//     general Composer is not.

import { AGENT_OPTIONS, RETRIEVAL_PROFILE_REF } from "./constants";
import type { AgentProfileId, ComposerState } from "./types";

export function buildServiceDefinition(
  state: ComposerState,
  ownerOrg: string,
  creatorId: string,
  existingId?: string
): Record<string, unknown> {
  const agent = AGENT_OPTIONS.find((a) => a.id === state.agentId);
  if (!agent) {
    throw new Error("Agent를 먼저 선택해야 Service Definition을 생성할 수 있습니다.");
  }

  const tags = state.basicInfo.tags.map((t) => t.trim()).filter(Boolean);
  const description = state.basicInfo.description.trim();
  const team = state.basicInfo.ownerTeam.trim();

  const owner: Record<string, string> = { org: ownerOrg, creator_id: creatorId };
  if (team) owner.team = team;

  const knowledge_bindings = state.knowledgeBindings.map((b) => ({
    role_id: agent.roleId,
    knowledge_id: b.knowledgeVersionId,
    knowledge_version: b.knowledgeVersionLabel,
    retrieval_profile_ref: RETRIEVAL_PROFILE_REF,
    context_token_limit: b.contextTokenLimit,
  }));

  const target_users: Record<string, string[]> = {};
  if (state.targetUsers.orgs.length) target_users.orgs = state.targetUsers.orgs;
  if (state.targetUsers.sites.length) target_users.sites = state.targetUsers.sites;
  if (state.targetUsers.roles.length) target_users.roles = state.targetUsers.roles;

  const definition: Record<string, unknown> = {
    schema_version: "1.0",
    id: existingId ?? crypto.randomUUID(),
    type: "service",
    name: state.basicInfo.name.trim(),
    version: "1.0.0",
    owner,
    classification: state.basicInfo.classification,
    created_at: new Date().toISOString(),
    agent_ref: { id: agent.manifestId, version: agent.manifestVersion },
    knowledge_bindings,
    mcp_bindings: [],
    prompt_bindings: [
      { role_id: agent.roleId, prompt_id: agent.prompt.manifestId, prompt_version: agent.prompt.manifestVersion },
    ],
    model_policy: {
      model_alias: state.modelPolicy.modelAlias,
      fallback_allowed: state.modelPolicy.fallbackAllowed,
      max_context_tokens: state.modelPolicy.maxContextTokens,
    },
    limits: {
      timeout_seconds: state.limits.timeoutSeconds,
      max_mcp_calls: state.limits.maxMcpCalls,
      max_context_tokens: state.limits.maxContextTokens,
      max_input_bytes: state.limits.maxInputBytes,
      audit_level: state.limits.auditLevel,
    },
  };

  if (description) definition.description = description;
  if (tags.length) definition.tags = tags;
  if (Object.keys(target_users).length) definition.target_users = target_users;

  return definition;
}

export function agentProfileFromId(id: AgentProfileId) {
  const agent = AGENT_OPTIONS.find((a) => a.id === id);
  if (!agent) throw new Error(`알 수 없는 agent id: ${id}`);
  return agent;
}
