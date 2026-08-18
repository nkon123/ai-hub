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

import { RETRIEVAL_PROFILE_REF, type AgentOption } from "./constants";
import type { ComposerState } from "./types";

/**
 * `agent`는 호출자(page.tsx)가 `resolveAgentOption(state.agent,
 * state.registryPrompt)`로 이미 계산해 넘긴다 — 표준 Agent든 Registry
 * Agent든 이 함수는 동일한 `AgentOption` 모양만 소비하고, 어느 쪽 출처인지는
 * `agent_ref`/`prompt_bindings`에 어떤 id가 들어가는지에만 영향을 준다
 * (`manifestId`/`manifestVersion` — Manifest 자체의 id/version. Registry
 * 실행에 필요한 `registry_agent_version_id`/`registry_prompt_version_id`는
 * 여기 들어가지 않는다 — 그건 Service Definition의 필드가 아니라
 * StepPreview.tsx가 `POST /local/v1/runs` 호출 시 별도로 보내는 값이다).
 */
export function buildServiceDefinition(
  state: ComposerState,
  agent: AgentOption,
  ownerOrg: string,
  creatorId: string,
  existingId?: string
): Record<string, unknown> {
  if (!agent.prompt) {
    throw new Error(
      "선택한 Agent에 연결된 Prompt가 없습니다. Registry Agent는 단계 6(Prompt 연결)에서 Prompt를 먼저 선택해야 합니다."
    );
  }
  const prompt = agent.prompt;

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
      { role_id: agent.roleId, prompt_id: prompt.manifestId, prompt_version: prompt.manifestVersion },
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
