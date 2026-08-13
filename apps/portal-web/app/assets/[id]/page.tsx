"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ChevronLeft,
  GitBranch,
  Gauge,
  Loader2,
  Lock,
  PackageOpen,
  PauseCircle,
  Search,
  Send,
} from "lucide-react";
import {
  Badge,
  Button,
  ErrorBanner,
  FormField,
  LoadingState,
  ReasonDialog,
  StatusBadge,
  inputClass,
} from "../../_components/ui";
import { canCreateDistribution, useRole, type RoleDef } from "../../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

const EDITABLE_STATUSES = new Set(["DRAFT", "CHANGES_REQUESTED"]);
const SUBMITTABLE_STATUSES = new Set(["DRAFT", "CHANGES_REQUESTED"]);

interface ChunkPreview {
  chunk_id: string;
  section: string;
  page: number;
  title: string;
  excerpt: string;
  chunk_type: string;
  tags: string[];
}

interface IndexingJob {
  id: string;
  status: string;
  chunk_count: number | null;
  completed_at: string | null;
  index_path: string | null;
}

interface IndexMeta {
  knowledge_id: string;
  chunk_count: number;
  parent_count: number;
  document_count: number;
  collection_name: string;
  embed_model: string;
}

interface VersionInfo {
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

interface SearchConfig {
  method: string;
  vector_store: string;
  keyword_index: string;
  fusion: string;
  default_alpha: number;
  default_top_k: number;
}

interface KnowledgeInfo {
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

// 검색 품질 테스트 (D-079 Feature 1) — retrieval-level 진단, LLM 응답이
// 아니다. 필드는 packages/schemas/api/portal-openapi.yaml의
// SearchPreviewResponse와 정확히 일치한다.
interface SearchPreviewCitation {
  chunk_id: string;
  document_title: string | null;
  section: string | null;
  page: number | null;
  excerpt: string;
  score: number;
  similarity: number | null;
}

interface SearchPreviewDiagnostics {
  index_found: boolean;
  embed_model_applied: string | null;
  embed_model_source: string | null;
  min_relevance_score_applied: number;
  relevance_threshold_ignored: boolean;
  clearance_applied: string;
  asset_classification: string | null;
  no_result_reason: "INDEX_NOT_BUILT" | "CLASSIFICATION_ABOVE_CLEARANCE" | "NO_CITATIONS" | null;
  retry_without_threshold_available: boolean;
}

interface SearchPreviewResult {
  citations: SearchPreviewCitation[];
  diagnostics: SearchPreviewDiagnostics;
  trace_id: string;
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-body">
      <span className="w-44 shrink-0 text-text-secondary">{label}</span>
      <span className="break-all text-text-primary">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-surface shadow-card">
      <div className="border-b border-border px-5 py-3">
        <h2 className="text-card-title font-semibold text-text-primary">{title}</h2>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

/**
 * 검색 품질 테스트 (D-079 Feature 1) — "이 질문을 하면 실제로 무엇이
 * 검색되는가"를 승인 전에도 확인할 수 있는 retrieval-level 진단 패널.
 * 정적 청크 미리보기(위 Section)와 달리 실제 질의를 search-runtime에
 * 보낸다. LLM 답변이 아니다 — 그건 챗봇 Quick Create Wizard의 몫이다.
 *
 * 자산 상세 화면에 두는 이유: 이 화면은 이미 `selectedVer`(버전 선택
 * 상태)를 갖고 있고, Producer가 색인 정보/청크 미리보기를 보는 바로 그
 * 맥락에서 "그래서 검색이 실제로 되는가"를 이어서 확인하는 것이 자연스럽다
 * — Knowledge 품질 페이지(`/knowledge/[assetId]/quality`)는 평가
 * 데이터셋/Quality Gate 화면이라 단발성 질의 진단과 목적이 다르다.
 */
function SearchPreviewPanel({
  assetId,
  versionId,
  token,
}: {
  assetId: string;
  versionId: string;
  token: string;
}) {
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchPreviewResult | null>(null);
  // The threshold applied on the *first* (non-ignored) call — remembered so
  // that if a retry with ignore_relevance_threshold=true then finds
  // citations, we can name the exact threshold value that had filtered them
  // out. Never fabricated any earlier than that (see the router's brief).
  const [priorThreshold, setPriorThreshold] = useState<number | null>(null);

  async function runSearch(ignoreThreshold: boolean) {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/assets/${assetId}/versions/${versionId}/search-preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            query: query.trim(),
            top_k: topK,
            ignore_relevance_threshold: ignoreThreshold,
          }),
        }
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? `검색 미리보기에 실패했습니다. (HTTP ${res.status})`);
        return;
      }
      if (!ignoreThreshold) {
        setPriorThreshold(body.diagnostics.min_relevance_score_applied);
      }
      setResult(body);
    } catch {
      setError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setLoading(false);
    }
  }

  const thresholdCausedEmpty =
    !!result &&
    result.diagnostics.relevance_threshold_ignored &&
    result.citations.length > 0 &&
    priorThreshold !== null;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
        <FormField label="질문">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !loading && runSearch(false)}
            placeholder="예: 육아휴직은 몇 개월까지 사용할 수 있나요?"
            maxLength={1000}
            className={inputClass}
          />
        </FormField>
        <FormField label="결과 수 (top_k)">
          <input
            type="number"
            min={1}
            max={20}
            value={topK}
            onChange={(e) => setTopK(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
            className={inputClass}
          />
        </FormField>
      </div>
      <div className="flex justify-end">
        <Button size="sm" disabled={loading || !query.trim()} onClick={() => runSearch(false)}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          {loading ? "검색 중..." : "검색 실행"}
        </Button>
      </div>

      {error && <ErrorBanner message={error} />}

      {result && (
        <div className="space-y-3 border-t border-border pt-3">
          <div className="flex flex-wrap gap-1.5 text-caption text-text-secondary">
            <Badge tone="neutral">
              적용된 관련도 임계값: {result.diagnostics.min_relevance_score_applied}
            </Badge>
            {result.diagnostics.embed_model_applied && (
              <Badge tone="neutral">임베딩 모델: {result.diagnostics.embed_model_applied}</Badge>
            )}
            <Badge tone="neutral">Clearance: {result.diagnostics.clearance_applied}</Badge>
            {result.diagnostics.relevance_threshold_ignored && (
              <Badge tone="warning">관련도 필터 없이 검색됨</Badge>
            )}
          </div>

          {thresholdCausedEmpty && (
            <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-caption text-warning">
              관련도 임계값({priorThreshold})이 원래 검색 결과를 걸러냈습니다 — 필터를 끄자
              결과가 나타났습니다.
            </div>
          )}

          {result.citations.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
              {result.diagnostics.no_result_reason === "INDEX_NOT_BUILT" ? (
                <p className="text-body text-text-secondary">
                  이 버전은 아직 색인이 완성되지 않아 검색할 수 없습니다.
                </p>
              ) : result.diagnostics.no_result_reason === "CLASSIFICATION_ABOVE_CLEARANCE" ? (
                <>
                  <p className="text-body font-medium text-text-primary">
                    이 자산의 보안등급이 현재 검색에 적용되는 접근 등급보다 높아 정책상
                    차단되었습니다.
                  </p>
                  <p className="mt-1 text-caption text-text-secondary">
                    검색 품질 문제가 아닙니다 — 관련도 필터를 꺼도 결과는 달라지지
                    않습니다.
                  </p>
                  <div className="mt-3 flex flex-wrap justify-center gap-1.5 text-caption text-text-secondary">
                    <Badge tone="warning">
                      자산 보안등급: {result.diagnostics.asset_classification ?? "알 수 없음"}
                    </Badge>
                    <Badge tone="neutral">
                      적용된 접근 등급: {result.diagnostics.clearance_applied}
                    </Badge>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-body text-text-secondary">관련 결과가 없습니다.</p>
                  {result.diagnostics.retry_without_threshold_available && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-3"
                      disabled={loading}
                      onClick={() => runSearch(true)}
                    >
                      관련도 필터 없이 다시 검색
                    </Button>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {result.citations.map((c, idx) => (
                <div key={`${c.chunk_id}-${idx}`} className="rounded-lg border border-border bg-slate-50 p-3">
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-caption text-text-secondary">
                    {c.section && (
                      <span className="rounded border border-brand-200 bg-brand-50 px-2 py-0.5 text-xs text-brand-700">
                        {c.section}
                      </span>
                    )}
                    {!!c.page && (
                      <span className="rounded border border-border bg-surface px-2 py-0.5 text-xs">
                        p.{c.page}
                      </span>
                    )}
                    <span className="ml-auto rounded bg-slate-100 px-2 py-0.5 text-xs">
                      score {c.score.toFixed(3)}
                      {c.similarity !== null && ` · similarity ${c.similarity.toFixed(3)}`}
                    </span>
                  </div>
                  <p className="text-caption leading-relaxed text-text-secondary">{c.excerpt}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 검토 요청 / 중단 actions for the selected version. Buttons are always
 * rendered (never hidden) so the reason for unavailability is visible, per
 * CLAUDE.md: "호환되지 않는 선택지는 이유와 함께 비활성화한다."
 */
function VersionActions({
  version,
  assetId,
  ownerCreatorId,
  role,
  submitting,
  submitError,
  onSubmitReview,
  onOpenSuspend,
}: {
  version: VersionInfo;
  assetId: string;
  ownerCreatorId: string;
  role: RoleDef;
  submitting: boolean;
  submitError: string | null;
  onSubmitReview: () => void;
  onOpenSuspend: () => void;
}) {
  const router = useRouter();
  const isSubmittableStatus = SUBMITTABLE_STATUSES.has(version.status);
  const isOwner = role.userId === ownerCreatorId;
  const canSubmit = role.code === "ADMIN" || (role.code === "CREATOR" && isOwner);

  let submitDisabledReason: string | null = null;
  if (!isSubmittableStatus) {
    submitDisabledReason = `현재 상태(${version.status})의 버전은 검토를 요청할 수 없습니다.`;
  } else if (!canSubmit) {
    submitDisabledReason =
      role.code === "CREATOR"
        ? "본인이 소유한 자산만 검토 요청할 수 있습니다."
        : "자산 제작자(소유자) 또는 관리자만 검토를 요청할 수 있습니다.";
  }

  const canSuspend = role.code === "RELEASE_MANAGER" || role.code === "ADMIN";
  const isSuspendableStatus = version.status === "APPROVED";
  let suspendDisabledReason: string | null = null;
  if (!isSuspendableStatus) {
    suspendDisabledReason = "승인된(APPROVED) 버전만 중단할 수 있습니다.";
  } else if (!canSuspend) {
    suspendDisabledReason = "배포 관리자 또는 관리자만 버전을 중단할 수 있습니다.";
  }

  // Offline Bundle 요청 (P10 entry point) — mirrors the server's own gate
  // (portal_api routers/distributions.py: only APPROVED AssetVersion roots
  // are accepted) rather than inventing a separate rule here.
  const isExportableStatus = version.status === "APPROVED";
  const canExport = canCreateDistribution(role.code);
  let exportDisabledReason: string | null = null;
  if (!isExportableStatus) {
    exportDisabledReason = `승인되지 않은 버전은 반출할 수 없습니다 (현재: ${version.status}).`;
  } else if (!canExport) {
    exportDisabledReason = "자산 제작자 또는 관리자만 반출을 요청할 수 있습니다.";
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-body text-text-secondary">현재 상태</span>
        <StatusBadge status={version.status} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={submitting || !isSubmittableStatus || !canSubmit}
          onClick={onSubmitReview}
        >
          <Send size={14} />
          {submitting ? "요청 중..." : "검토 요청"}
        </Button>
        <Button size="sm" variant="danger" disabled={!isSuspendableStatus || !canSuspend} onClick={onOpenSuspend}>
          <PauseCircle size={14} />
          중단
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!isExportableStatus || !canExport}
          onClick={() =>
            router.push(`/assets/${assetId}/versions?versionId=${version.id}`)
          }
        >
          <PackageOpen size={14} />
          Desktop 설치 ZIP 받기
        </Button>
      </div>

      {(submitDisabledReason || suspendDisabledReason || exportDisabledReason) && (
        <div className="flex flex-col gap-1 text-caption text-text-secondary">
          {submitDisabledReason && (
            <span className="inline-flex items-center gap-1">
              <Lock size={12} />
              검토 요청 불가: {submitDisabledReason}
            </span>
          )}
          {suspendDisabledReason && (
            <span className="inline-flex items-center gap-1">
              <Lock size={12} />
              중단 불가: {suspendDisabledReason}
            </span>
          )}
          {exportDisabledReason && (
            <span className="inline-flex items-center gap-1">
              <Lock size={12} />
              설치 ZIP 생성 불가: {exportDisabledReason}
            </span>
          )}
        </div>
      )}

      {submitError && <ErrorBanner message={submitError} />}
    </div>
  );
}

export default function KnowledgeDetailPage() {
  const params = useParams();
  const router = useRouter();
  const assetId = params.id as string;
  const { role } = useRole();

  const [info, setInfo] = useState<KnowledgeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedVersionIdx, setSelectedVersionIdx] = useState(0);

  // Tag editing state
  const [tagInputs, setTagInputs] = useState<Record<string, string>>({});
  const [savingTag, setSavingTag] = useState<string | null>(null);
  const [tagActionError, setTagActionError] = useState<string | null>(null);

  // 검토 요청 (submit for review) state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // 중단 (suspend, RELEASE_MANAGER only) state
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [suspendError, setSuspendError] = useState<string | null>(null);

  async function fetchInfo() {
    try {
      const res = await fetch(`${API_BASE}/api/v1/assets/${assetId}/knowledge-info`, {
        headers: { Authorization: `Bearer ${role.token}` },
      });
      if (!res.ok) {
        if (res.status === 400) setError("이 자산은 Knowledge 유형이 아닙니다.");
        else if (res.status === 404) setError("자산을 찾을 수 없습니다.");
        else setError(`오류 ${res.status}`);
        return;
      }
      const data: KnowledgeInfo = await res.json();
      setInfo(data);
    } catch (e) {
      setError("서버에 연결할 수 없습니다.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, role.token]);

  async function safeJson(res: Response): Promise<any> {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  async function handleSubmitReview(versionId: string) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/asset-versions/${versionId}/submit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${role.token}` },
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setSubmitError(body?.error?.message ?? `검토 요청에 실패했습니다. (HTTP ${res.status})`);
        return;
      }
      await fetchInfo();
    } catch {
      setSubmitError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSuspend(reason: string, versionId: string) {
    setSuspending(true);
    setSuspendError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/asset-versions/${versionId}/suspend`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({ reason }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setSuspendError(body?.error?.message ?? `중단 처리에 실패했습니다. (HTTP ${res.status})`);
        return;
      }
      setSuspendOpen(false);
      await fetchInfo();
    } catch {
      setSuspendError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setSuspending(false);
    }
  }

  async function handleAddTag(versionId: string, chunkId: string, existingTags: string[]) {
    const input = (tagInputs[chunkId] ?? "").trim();
    if (!input) return;
    const newTag = input.slice(0, 64);
    if (existingTags.includes(newTag)) return;

    setSavingTag(chunkId);
    setTagActionError(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/assets/${assetId}/versions/${versionId}/chunk-tags`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${role.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ chunk_id: chunkId, tags: [...existingTags, newTag] }),
        }
      );
      if (res.ok) {
        setTagInputs((prev) => ({ ...prev, [chunkId]: "" }));
        await fetchInfo();
      } else {
        const body = await safeJson(res);
        setTagActionError(body?.error?.message ?? `태그 추가에 실패했습니다. (HTTP ${res.status})`);
      }
    } finally {
      setSavingTag(null);
    }
  }

  async function handleRemoveTag(versionId: string, chunkId: string, existingTags: string[], tag: string) {
    setSavingTag(chunkId);
    setTagActionError(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/assets/${assetId}/versions/${versionId}/chunk-tags`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${role.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ chunk_id: chunkId, tags: existingTags.filter((t) => t !== tag) }),
        }
      );
      if (res.ok) {
        await fetchInfo();
      } else {
        const body = await safeJson(res);
        setTagActionError(body?.error?.message ?? `태그 삭제에 실패했습니다. (HTTP ${res.status})`);
      }
    } finally {
      setSavingTag(null);
    }
  }

  if (loading) {
    return <LoadingState label="로딩 중..." />;
  }

  if (error || !info) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <ErrorBanner message={error ?? "알 수 없는 오류"} />
        <Button variant="secondary" onClick={() => router.push("/assets")}>
          목록으로
        </Button>
      </div>
    );
  }

  const selectedVer = info.versions[selectedVersionIdx];
  const isTagEditable = !!selectedVer && EDITABLE_STATUSES.has(selectedVer.status);

  return (
    <div className="max-w-5xl space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <button
            onClick={() => router.push("/assets")}
            className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
          >
            <ChevronLeft size={14} />
            목록으로
          </button>
          <h1 className="text-page-title font-bold text-text-primary">{info.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge tone="purple">Knowledge</Badge>
            <Badge>{info.classification}</Badge>
            <span className="text-caption text-text-secondary">{info.owner_org} · {info.owner_creator_id}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => router.push(`/assets/${assetId}/versions`)}
            >
              <GitBranch size={14} />
              버전 관리
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => router.push(`/knowledge/${assetId}/quality`)}
            >
              <Gauge size={14} />
              Knowledge 품질 보기
            </Button>
          </div>
          <p className="whitespace-nowrap text-caption text-text-muted">
            등록 {new Date(info.created_at).toLocaleDateString("ko-KR")}
          </p>
        </div>
      </div>

      {/* Version timeline */}
      <Section title="버전 히스토리">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {info.versions.map((ver, idx) => (
            <button
              key={ver.id}
              onClick={() => setSelectedVersionIdx(idx)}
              className={`shrink-0 rounded-lg border px-4 py-3 text-left text-body transition ${
                idx === selectedVersionIdx
                  ? "border-brand-500 bg-brand-50"
                  : "border-border bg-surface hover:border-brand-300"
              }`}
            >
              <div className="font-semibold text-text-primary">v{ver.version}</div>
              <div className="mt-0.5 flex gap-1">
                <StatusBadge status={ver.status} />
                {ver.indexing_job && <StatusBadge status={ver.indexing_job.status} />}
              </div>
              <div className="mt-1 text-caption text-text-muted">
                {new Date(ver.created_at).toLocaleDateString("ko-KR")}
              </div>
            </button>
          ))}
        </div>
      </Section>

      {selectedVer && (
        <Section title="버전 상태 및 작업">
          <VersionActions
            version={selectedVer}
            assetId={assetId}
            ownerCreatorId={info.owner_creator_id}
            role={role}
            submitting={submitting}
            submitError={submitError}
            onSubmitReview={() => handleSubmitReview(selectedVer.id)}
            onOpenSuspend={() => {
              setSuspendError(null);
              setSuspendOpen(true);
            }}
          />
        </Section>
      )}

      <ReasonDialog
        open={suspendOpen}
        title="버전 중단 확인"
        description="중단된 버전은 더 이상 신규 실행/게시에 사용되지 않습니다. 이 작업은 감사 로그에 기록됩니다."
        confirmLabel="중단"
        confirmVariant="danger"
        reasonLabel="중단 사유"
        reasonPlaceholder="중단 사유를 입력하세요 (필수)"
        submitting={suspending}
        error={suspendError}
        onConfirm={(reason) => selectedVer && handleSuspend(reason, selectedVer.id)}
        onCancel={() => {
          setSuspendOpen(false);
          setSuspendError(null);
        }}
      />

      {selectedVer && (
        <>
          {/* Indexing details */}
          <Section title="인덱싱 정보">
            {selectedVer.index_meta ? (
              <div className="space-y-2">
                <InfoRow label="임베딩 모델" value={selectedVer.index_meta.embed_model} />
                <InfoRow label="청킹 전략" value="Parent-Child (부모-자식 분할)" />
                <InfoRow
                  label="부모 청크 크기"
                  value="1,024 토큰 (overlap 없음)"
                />
                <InfoRow
                  label="자식 청크 크기"
                  value="256 토큰, overlap 32"
                />
                <InfoRow
                  label="총 청크 수"
                  value={`${selectedVer.index_meta.chunk_count}개`}
                />
                <InfoRow
                  label="부모 청크 수"
                  value={`${selectedVer.index_meta.parent_count}개`}
                />
                <InfoRow
                  label="처리 문서 수"
                  value={`${selectedVer.index_meta.document_count}개`}
                />
                <InfoRow
                  label="벡터 컬렉션"
                  value={<code className="rounded bg-slate-100 px-1 text-xs">{selectedVer.index_meta.collection_name}</code>}
                />
                {selectedVer.indexing_job?.completed_at && (
                  <InfoRow
                    label="완료 시각"
                    value={new Date(selectedVer.indexing_job.completed_at).toLocaleString("ko-KR")}
                  />
                )}
                {selectedVer.indexing_profile_ref?.name && (
                  <InfoRow
                    label="인덱싱 프로파일"
                    value={`${selectedVer.indexing_profile_ref.name} v${selectedVer.indexing_profile_ref.version}`}
                  />
                )}
              </div>
            ) : (
              <p className="text-body text-text-muted">
                {selectedVer.indexing_job?.status === "FAILED"
                  ? "인덱싱 실패 — 재시도가 필요합니다."
                  : selectedVer.indexing_job?.status === "PENDING" ||
                    selectedVer.indexing_job?.status === "RUNNING"
                  ? "인덱싱 진행 중입니다..."
                  : "아직 인덱싱되지 않았습니다."}
              </p>
            )}
          </Section>

          {/* Search capabilities */}
          <Section title="검색 방식">
            <div className="space-y-2">
              <InfoRow label="방식" value="하이브리드 검색 (벡터 + 키워드 융합)" />
              <InfoRow label="벡터 저장소" value={info.search_config.vector_store} />
              <InfoRow label="키워드 색인" value={info.search_config.keyword_index} />
              <InfoRow label="융합 알고리즘" value={info.search_config.fusion} />
              <InfoRow
                label="기본 Alpha (α)"
                value={`${info.search_config.default_alpha} (0=키워드만, 1=벡터만)`}
              />
              <InfoRow
                label="기본 Top-K"
                value={`${info.search_config.default_top_k}개`}
              />
            </div>
          </Section>

          {/* D-079 Feature 1: 검색 품질 테스트 */}
          <Section title="검색 품질 테스트 — 이 질문을 하면 실제로 무엇이 검색되는가">
            <SearchPreviewPanel assetId={assetId} versionId={selectedVer.id} token={role.token} />
          </Section>

          {/* Chunks with metadata and tags */}
          {selectedVer.chunks_preview.length > 0 && (
            <Section
              title={`청크 목록 (${selectedVer.chunks_preview.length}개)`}
            >
              <div className="space-y-3">
                {!isTagEditable && (
                  <p className="flex items-center gap-1.5 rounded-lg bg-slate-50 px-3 py-2 text-caption text-text-secondary">
                    <Lock size={12} />
                    현재 상태({selectedVer.status})의 버전은 태그를 수정할 수 없습니다. 새 버전을
                    등록하거나 검토에서 반려/수정 요청된 후 다시 편집하세요.
                  </p>
                )}
                {tagActionError && <ErrorBanner message={tagActionError} />}
                {selectedVer.chunks_preview.map((chunk) => (
                  <div
                    key={chunk.chunk_id}
                    className="rounded-lg border border-border bg-slate-50 p-4"
                  >
                    {/* Metadata tags row */}
                    <div className="mb-2 flex flex-wrap items-center gap-1.5">
                      {chunk.section && (
                        <span className="inline-flex items-center rounded border border-brand-200 bg-brand-50 px-2 py-0.5 text-xs text-brand-700">
                          섹션: {chunk.section}
                        </span>
                      )}
                      {chunk.page > 0 && (
                        <span className="inline-flex items-center rounded border border-border bg-surface px-2 py-0.5 text-xs text-text-secondary">
                          p.{chunk.page}
                        </span>
                      )}
                      {chunk.chunk_type && (
                        <span className="inline-flex items-center rounded border border-purple-200 bg-purple-50 px-2 py-0.5 text-xs text-purple-700">
                          {chunk.chunk_type}
                        </span>
                      )}
                      {chunk.title && (
                        <span className="inline-flex items-center rounded border border-border bg-surface px-2 py-0.5 text-xs text-text-secondary">
                          {chunk.title}
                        </span>
                      )}
                      {/* Custom tags */}
                      {chunk.tags.map((tag) => (
                        <span
                          key={tag}
                          className="group inline-flex items-center gap-1 rounded border border-green-200 bg-green-50 px-2 py-0.5 text-xs text-green-700"
                        >
                          {tag}
                          <button
                            onClick={() =>
                              handleRemoveTag(selectedVer.id, chunk.chunk_id, chunk.tags, tag)
                            }
                            disabled={savingTag === chunk.chunk_id || !isTagEditable}
                            className="ml-0.5 opacity-0 group-hover:opacity-100 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-0"
                            title={isTagEditable ? "태그 삭제" : "현재 상태의 버전은 수정할 수 없습니다."}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>

                    {/* Excerpt */}
                    <p className="text-caption leading-relaxed text-text-secondary line-clamp-3">
                      {chunk.excerpt}
                    </p>

                    {/* Add tag input */}
                    <div className="mt-2 flex gap-1.5">
                      <input
                        type="text"
                        placeholder={isTagEditable ? "태그 추가…" : "수정할 수 없는 버전입니다"}
                        value={tagInputs[chunk.chunk_id] ?? ""}
                        onChange={(e) =>
                          setTagInputs((prev) => ({
                            ...prev,
                            [chunk.chunk_id]: e.target.value,
                          }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && isTagEditable)
                            handleAddTag(selectedVer.id, chunk.chunk_id, chunk.tags);
                        }}
                        disabled={!isTagEditable}
                        className="h-7 flex-1 rounded border border-border bg-surface px-2 text-xs text-text-primary focus:border-brand-400 focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-text-muted"
                        maxLength={64}
                      />
                      <button
                        onClick={() =>
                          handleAddTag(selectedVer.id, chunk.chunk_id, chunk.tags)
                        }
                        disabled={
                          savingTag === chunk.chunk_id ||
                          !isTagEditable ||
                          !(tagInputs[chunk.chunk_id] ?? "").trim()
                        }
                        className="rounded bg-brand-600 px-3 py-1 text-xs text-white hover:bg-brand-700 disabled:opacity-40"
                      >
                        {savingTag === chunk.chunk_id ? "저장 중…" : "추가"}
                      </button>
                    </div>

                    {/* Chunk ID */}
                    <p className="mt-2 text-caption text-text-muted">
                      ID: <code>{chunk.chunk_id}</code>
                    </p>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
