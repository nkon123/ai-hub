// Static registry stand-ins for the Composer wizard.
//
// D-034 (open-decisions.md): Agent and Prompt assets are NOT in the Portal
// Registry yet — they exist only as static config under
// services/agent-runtime/config/{standard-agent,standard-db-agent,
// standard-prompt,standard-db-prompt}/*.json. There is no
// `GET /api/v1/assets?type=agent` or `type=prompt` result to page through
// (verified live: both return `{items: [], total: 0}`), so Steps 3 and 6
// present these two known built-in options honestly, instead of pretending a
// registry lookup happened. The ids/versions below are copied byte-for-byte
// from those manifest files so agent_ref/prompt_bindings in the generated
// Service Definition point at the same ids the running agent-runtime (and
// hr-chatbot-service fixture) already use.

import type { AgentProfileId, Classification } from "./types";

export interface AgentOption {
  id: AgentProfileId;
  /** agent_ref.id — services/agent-runtime/config/{id}/agent-manifest.json's own `id`. */
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
  prompt: PromptOption;
}

export interface PromptOption {
  manifestId: string;
  manifestVersion: string;
  name: string;
  description: string;
  variables: { name: string; required: boolean; description: string }[];
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
