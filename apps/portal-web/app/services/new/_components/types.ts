// Shared types for the general AI Service Composer wizard (P18, app/services/new).
//
// Every field here maps to a real property in
// packages/schemas/manifests/service-definition.schema.json — this wizard does
// NOT introduce wizard-only fields that have nowhere to be stored. See
// buildServiceDefinition.ts for the exact mapping and _components/README notes
// in page.tsx for the two schema-less spec steps (입력 정의/출력 정의) that are
// intentionally shown as disabled rather than silently dropped.

// Registry Agent/Prompt asset types moved to app/_components/registryManifests.ts
// on 2026-08-17 (D-034 follow-up) so /chatbots/new can reuse them too.
// Re-exported here so every existing `from "./types"` import in this screen
// keeps working unchanged.
import type {
  RegistryAgentManifest,
  RegistryAgentSelection,
  RegistryAsset,
  RegistryAssetVersion,
  RegistryPromptManifest,
  RegistryPromptSelection,
} from "../../../_components/registryManifests";

export type {
  RegistryAgentManifest,
  RegistryAgentSelection,
  RegistryAsset,
  RegistryAssetVersion,
  RegistryPromptManifest,
  RegistryPromptSelection,
};

export type Classification = "PUBLIC_INTERNAL" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";

export const CLASSIFICATIONS: Classification[] = [
  "PUBLIC_INTERNAL",
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
];

export const CLASSIFICATION_LABEL: Record<Classification, string> = {
  PUBLIC_INTERNAL: "PUBLIC_INTERNAL — 사내 공개",
  INTERNAL: "INTERNAL — 사내 한정",
  CONFIDENTIAL: "CONFIDENTIAL — 기밀",
  RESTRICTED: "RESTRICTED — 제한",
};

/** Ascending sensitivity rank — matches the schema enum's declared order. */
export const CLASSIFICATION_RANK: Record<Classification, number> = {
  PUBLIC_INTERNAL: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
};

export type AuditLevel = "minimal" | "standard" | "full";

export const AUDIT_LEVEL_LABEL: Record<AuditLevel, string> = {
  minimal: "최소 — 성공/실패만 기록",
  standard: "표준 — 주요 단계 기록",
  full: "전체 — 상세 실행 기록",
};

// --- Step 1: 기본정보 ---

export interface BasicInfo {
  name: string;
  description: string;
  tags: string[];
  classification: Classification;
  ownerTeam: string;
}

// --- Step 2: 모델 정책 ---

export interface ModelPolicyDraft {
  modelAlias: string;
  fallbackAllowed: boolean;
  maxContextTokens: number;
}

// --- Step 3: Agent 선택 ---

export type AgentProfileId = "standard-agent" | "standard-db-agent";

/**
 * 2026-08-16 (D-034 관련): 이 Step은 더 이상 2개의 표준 Agent만 보여주지
 * 않는다. `services/agent-runtime/src/agent_runtime/manifests.py`의
 * `resolve_registry_agent_config`(모듈 docstring의 "resolution path 2")가
 * 이미 `registry_agent_version_id`/`registry_prompt_version_id`로 Portal
 * Registry에 등록된 APPROVED Agent+Prompt 자산 버전 쌍을 조회해 실제로
 * 실행할 수 있다 — agent-runtime/Contract 변경 없이. `AgentOption`(아래,
 * `constants.ts`가 소유)은 표준 Agent(`source: "standard"`)와 Registry
 * Agent(`source: "registry"`)를 같은 모양으로 표현해 이후 Step들이 하나의
 * 통일된 값만 소비하면 되게 한다 — 그 통일 전 단계의 "무엇을 선택 중인가"가
 * 바로 아래 `AgentSelection`/`RegistryPromptSelection`이다.
 *
 * `manifest.id`/`manifest.version`(Agent와 Prompt 둘 다)은 Manifest 자체의
 * `id`/`version` 필드다 — Service Definition의 `agent_ref`/`prompt_bindings`
 * 가 요구하는 값이며, Portal의 asset id/asset-version id와는 다른 값이다.
 * `RegistryAgentSelection.versionId`/`RegistryPromptSelection.versionId`는
 * Portal의 asset VERSION id — agent-runtime에 보낼
 * `registry_agent_version_id`/`registry_prompt_version_id` 값이다. 이 두
 * id 종류를 섞으면 안 된다(Preview 실행이 조용히 실패한다).
 */

export interface StandardAgentSelection {
  source: "standard";
  profileId: AgentProfileId;
}

/** Step 3's selection — either of the 2 built-in profiles (D-034 local
 * fallback, always executable) or a Portal-registered Agent asset version
 * (D-034 Registry resolution path 2, executable only once its paired Prompt
 * is also chosen in Step 6 and both are APPROVED). */
export type AgentSelection = StandardAgentSelection | RegistryAgentSelection;

// --- Step 4: Knowledge 연결 ---

export interface AssetVersionSummary {
  id: string;
  version: string;
  status: string;
  created_at: string;
}

export interface KnowledgeAsset {
  id: string;
  type: string;
  name: string;
  owner_org: string;
  classification: string;
  created_at: string;
  versions: AssetVersionSummary[];
}

export interface IndexingJob {
  id: string;
  status: string;
  chunk_count: number | null;
  completed_at: string | null;
  index_path: string | null;
}

export interface VersionInfo {
  id: string;
  version: string;
  status: string;
  created_at: string;
  indexing_job: IndexingJob | null;
}

export interface KnowledgeInfo {
  id: string;
  type: string;
  name: string;
  classification: string;
  owner_org: string;
  created_at: string;
  versions: VersionInfo[];
}

export interface KnowledgeBindingDraft {
  knowledgeAssetId: string;
  knowledgeAssetName: string;
  knowledgeClassification: string;
  knowledgeVersionId: string;
  knowledgeVersionLabel: string;
  contextTokenLimit: number;
}

// --- Step 7: 제한·보안 ---

export interface LimitsDraft {
  timeoutSeconds: number;
  maxMcpCalls: number;
  maxContextTokens: number;
  maxInputBytes: number;
  auditLevel: AuditLevel;
}

export interface TargetUsersDraft {
  orgs: string[];
  sites: string[];
  roles: string[];
}

// --- Step 8/10: 생성된 Service Definition (server round-trip) ---

export interface ServiceVersionOut {
  id: string;
  service_id: string;
  version: string;
  status: string;
  service_definition: Record<string, unknown>;
  created_at: string;
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
  code?: string | null;
}

export interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
}

// --- Step 9: Preview ---

export interface Citation {
  chunk_id: string;
  parent_chunk_id: string;
  document_path: string;
  document_title: string;
  page: number;
  section: string;
  excerpt: string;
  parent_context: string;
  score: number;
}

export type RunStatus = "running" | "succeeded" | "insufficient_evidence" | "failed" | "cancelled";

export interface PreviewMessage {
  id: string;
  question: string;
  status: RunStatus;
  answer: string;
  citations: Citation[];
  errorMessage?: string;
  traceId?: string;
  runId?: string;
}

// --- Full wizard state ---

export interface ComposerState {
  basicInfo: BasicInfo;
  modelPolicy: ModelPolicyDraft;
  agent: AgentSelection | null;
  /** Only meaningful when `agent.source === "registry"` — the 2 standard
   * profiles keep their fixed Prompt pairing (StepPrompt.tsx). */
  registryPrompt: RegistryPromptSelection | null;
  knowledgeBindings: KnowledgeBindingDraft[];
  limits: LimitsDraft;
  targetUsers: TargetUsersDraft;
}
