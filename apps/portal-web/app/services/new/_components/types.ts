// Shared types for the general AI Service Composer wizard (P18, app/services/new).
//
// Every field here maps to a real property in
// packages/schemas/manifests/service-definition.schema.json — this wizard does
// NOT introduce wizard-only fields that have nowhere to be stored. See
// buildServiceDefinition.ts for the exact mapping and _components/README notes
// in page.tsx for the two schema-less spec steps (입력 정의/출력 정의) that are
// intentionally shown as disabled rather than silently dropped.

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
  agentId: AgentProfileId | null;
  knowledgeBindings: KnowledgeBindingDraft[];
  limits: LimitsDraft;
  targetUsers: TargetUsersDraft;
}
