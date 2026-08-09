// Shared types for the Knowledge chatbot preview wizard (Step 1-3).
// Mirrors the portal-api `/api/v1/assets` and `knowledge-info` response shapes
// (see apps/portal-web/app/assets/page.tsx and app/assets/[id]/page.tsx),
// plus the agent-runtime `/local/v1/runs` contract (services/agent-runtime, port 8100).

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

export interface IndexMeta {
  knowledge_id: string;
  chunk_count: number;
  parent_count: number;
  document_count: number;
  collection_name: string;
  embed_model: string;
}

export interface ChunkPreview {
  chunk_id: string;
  section: string;
  page: number;
  title: string;
  excerpt: string;
  chunk_type: string;
  tags: string[];
}

export interface VersionInfo {
  id: string;
  version: string;
  status: string;
  created_at: string;
  indexing_job: IndexingJob | null;
  index_meta: IndexMeta | null;
  indexing_profile_ref: Record<string, string>;
  chunks_preview: ChunkPreview[];
  source_documents: string[];
}

export interface SearchConfig {
  method: string;
  vector_store: string;
  keyword_index: string;
  fusion: string;
  default_alpha: number;
  default_top_k: number;
}

export interface KnowledgeInfo {
  id: string;
  type: string;
  name: string;
  classification: string;
  owner_org: string;
  owner_creator_id: string;
  created_at: string;
  versions: VersionInfo[];
  search_config: SearchConfig;
}

/** The knowledge asset + usable (COMPLETED) version chosen in Step 1. */
export interface SelectedKnowledge {
  assetId: string;
  assetName: string;
  ownerOrg: string;
  classification: string;
  versionId: string;
  versionLabel: string;
}

/** Local-only chatbot configuration from Step 2. Never persisted (no Registry yet). */
export interface ChatbotSettings {
  name: string;
  welcomeMessage: string;
  suggestedQuestions: string[];
  showCitations: boolean;
}

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

export interface ChatMessage {
  id: string;
  question: string;
  status: RunStatus;
  answer: string;
  citations: Citation[];
  errorMessage?: string;
  traceId?: string;
  runId?: string;
}
