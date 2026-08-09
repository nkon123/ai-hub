"use client";

/**
 * P12 Knowledge 품질 (`/knowledge/:assetId/quality`).
 *
 * Sources composition data (Source 문서 수/버전, Parsed/Parent/Child 수,
 * Chunk 전략, Embedding 모델, Vector/BM25/Hybrid 설정) from the existing
 * `GET /api/v1/assets/{id}/knowledge-info` (already built for the asset
 * detail page — see `app/assets/[id]/page.tsx`) and metrics/gate/per-case
 * detail from the new Evaluation API (`app/_components` has no dedicated
 * evaluation types yet, defined locally below). Fields this screen cannot
 * source from either endpoint (chunk 크기, embedding 차원 — never persisted
 * anywhere, see docs/implementation-spec/open-decisions.md D-055/D-056 for
 * the related PoC decisions) render as "미기재", never a fabricated number.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle,
  ChevronLeft,
  ClipboardList,
  Info,
  Loader2,
  Lock,
  PlayCircle,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  LoadingState,
  PageHeader,
  ReasonDialog,
  StatusBadge,
} from "../../../_components/ui";
import { canRecordEvaluationNote, canRunEvaluation, useRole } from "../../../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";
const POLL_INTERVAL_MS = 1500;
const IN_PROGRESS_STATUSES = new Set(["PENDING", "RUNNING"]);
const NOT_RECORDED = "미기재";

// --- Types mirroring packages/schemas/api/portal-openapi.yaml (evaluations) ---

interface IndexMeta {
  chunk_count: number;
  parent_count: number;
  document_count: number;
  embed_model: string;
  chunking_strategy?: string;
  collection_name: string;
}

interface VersionInfo {
  id: string;
  version: string;
  status: string;
  created_at: string;
  index_meta: IndexMeta | null;
  source_documents: string[];
  indexing_job: { status: string | null } | null;
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
  name: string;
  classification: string;
  owner_creator_id: string;
  versions: VersionInfo[];
  search_config: SearchConfig;
}

interface EvaluationSummary {
  id: string;
  asset_version_id: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  error_message?: string | null;
  dataset_id?: string | null;
  dataset_version?: string | null;
  dataset_review_status?: string | null;
  evaluated_at?: string | null;
  gate_passed?: boolean | null;
  run_id?: string | null;
  requested_by: string;
  created_at: string;
  completed_at?: string | null;
}

interface EvaluationMetrics {
  case_count: number;
  cases_with_ground_truth: number;
  recall_at_1: number;
  recall_at_5: number;
  mrr: number;
  no_result_rate: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  avg_context_tokens: number;
  forbidden_hit_rate: number;
}

interface GateCheck {
  name: string;
  passed: boolean;
  actual: number;
  threshold: number;
  comparison: string;
  message: string;
}

interface EvaluationCaseResult {
  case_id: string;
  question: string;
  expected_document_ids: string[];
  retrieved_document_ids: string[];
  hit_at_1: boolean;
  hit_at_5: boolean;
  latency_ms: number;
  forbidden_hit: boolean;
  tags: string[];
}

interface EvaluationComparison {
  available: boolean;
  reason?: string | null;
  baseline_asset_version_id?: string | null;
  recall_at_1_delta?: number | null;
  recall_at_5_delta?: number | null;
  mrr_delta?: number | null;
  latency_p95_delta_ms?: number | null;
  no_result_rate_delta?: number | null;
  improved_case_ids: string[];
  regressed_case_ids: string[];
  new_case_ids: string[];
  removed_case_ids: string[];
  recommendation?: string | null;
  blocking_reasons: string[];
}

interface EvaluationNote {
  id: string;
  author_id: string;
  author_role: string;
  reason: string;
  created_at: string;
}

interface EvaluationDetail extends EvaluationSummary {
  source_masking_note: string;
  retrieval_settings: { top_k: number; alpha: number; knowledge_version: string } | null;
  metrics: EvaluationMetrics | null;
  gate: { passed: boolean; checks: GateCheck[] } | null;
  per_case: EvaluationCaseResult[];
  comparison: EvaluationComparison;
  known_limitations: string[];
  notes: EvaluationNote[];
}

function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined ? NOT_RECORDED : `${(v * 100).toFixed(1)}%`;
}
function fmtMs(v: number | null | undefined): string {
  return v === null || v === undefined ? NOT_RECORDED : `${Math.round(v)}ms`;
}
function fmtDelta(v: number | null | undefined, pct = true): string {
  if (v === null || v === undefined) return NOT_RECORDED;
  const s = pct ? `${(v * 100).toFixed(1)}%p` : `${Math.round(v)}ms`;
  return v > 0 ? `+${s}` : s;
}
function fmtDate(v: string | null | undefined): string {
  return v ? new Date(v).toLocaleString("ko-KR") : NOT_RECORDED;
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-surface shadow-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-card-title font-semibold text-text-primary">{title}</h2>
        {right}
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  const isMissing = value === NOT_RECORDED;
  return (
    <div className="flex justify-between gap-3 border-b border-border/60 py-1.5 text-body last:border-0">
      <span className="text-text-secondary">{label}</span>
      <span className={isMissing ? "text-text-muted" : "font-medium text-text-primary"}>{value}</span>
    </div>
  );
}

export default function KnowledgeQualityPage() {
  const params = useParams();
  const router = useRouter();
  const assetId = params.assetId as string;
  const { role } = useRole();

  const [info, setInfo] = useState<KnowledgeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedVersionIdx, setSelectedVersionIdx] = useState(0);

  const [evaluations, setEvaluations] = useState<EvaluationSummary[] | null>(null);
  const [evaluationsLoading, setEvaluationsLoading] = useState(false);
  const [evaluationsError, setEvaluationsError] = useState<string | null>(null);
  const [selectedEvaluationId, setSelectedEvaluationId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EvaluationDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [noteOpen, setNoteOpen] = useState(false);
  const [noteSubmitting, setNoteSubmitting] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function safeJson(res: Response): Promise<any> {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  const fetchInfo = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/assets/${assetId}/knowledge-info`, {
        headers: { Authorization: `Bearer ${role.token}` },
      });
      if (!res.ok) {
        if (res.status === 400) setError("이 자산은 Knowledge 유형이 아닙니다.");
        else if (res.status === 403) setError("이 Knowledge를 조회할 권한이 없습니다.");
        else if (res.status === 404) setError("자산을 찾을 수 없습니다.");
        else setError(`오류 (HTTP ${res.status})`);
        return;
      }
      setInfo(await res.json());
    } catch {
      setError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, role.token]);

  useEffect(() => {
    fetchInfo();
  }, [fetchInfo]);

  const selectedVersion = info?.versions[selectedVersionIdx] ?? null;

  const fetchEvaluations = useCallback(
    async (versionId: string, autoSelectLatest: boolean) => {
      setEvaluationsLoading(true);
      setEvaluationsError(null);
      try {
        const res = await fetch(
          `${API_BASE}/api/v1/assets/${assetId}/versions/${versionId}/evaluations`,
          { headers: { Authorization: `Bearer ${role.token}` } }
        );
        if (!res.ok) {
          if (res.status === 403) setEvaluationsError("이 Knowledge의 평가 결과를 조회할 권한이 없습니다.");
          else if (res.status === 404)
            setEvaluationsError(
              "이 버전의 평가 결과를 찾을 수 없습니다. 평가 기능이 아직 제공되지 않았거나 버전이 존재하지 않습니다."
            );
          else setEvaluationsError(`오류 (HTTP ${res.status})`);
          return;
        }
        const body = await res.json();
        const items: EvaluationSummary[] = body.items ?? [];
        setEvaluations(items);
        if (autoSelectLatest) {
          setSelectedEvaluationId(items.length > 0 ? items[0].id : null);
        }
      } catch {
        setEvaluationsError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
      } finally {
        setEvaluationsLoading(false);
      }
    },
    [assetId, role.token]
  );

  useEffect(() => {
    if (!selectedVersion) return;
    setEvaluations(null);
    setEvaluationsError(null);
    setDetail(null);
    fetchEvaluations(selectedVersion.id, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersion?.id, role.token]);

  const fetchDetail = useCallback(
    async (evaluationId: string) => {
      setDetailError(null);
      try {
        const res = await fetch(`${API_BASE}/api/v1/evaluations/${evaluationId}`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (!res.ok) {
          const body = await safeJson(res);
          setDetailError(body?.error?.message ?? `평가 결과를 불러오지 못했습니다. (HTTP ${res.status})`);
          return;
        }
        const body: EvaluationDetail = await res.json();
        setDetail(body);
        return body;
      } catch {
        setDetailError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
      }
    },
    [role.token]
  );

  useEffect(() => {
    if (selectedEvaluationId) fetchDetail(selectedEvaluationId);
    else setDetail(null);
  }, [selectedEvaluationId, fetchDetail]);

  // Poll while PENDING/RUNNING — 긴 Job의 진행 상태를 반영 (CLAUDE.md UI 규칙).
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (!selectedEvaluationId || !detail) return;
    if (!IN_PROGRESS_STATUSES.has(detail.status)) return;

    pollRef.current = setInterval(async () => {
      const updated = await fetchDetail(selectedEvaluationId);
      if (updated && !IN_PROGRESS_STATUSES.has(updated.status) && selectedVersion) {
        fetchEvaluations(selectedVersion.id, false);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEvaluationId, detail?.status]);

  async function handleRunEvaluation() {
    if (!selectedVersion) return;
    setRunning(true);
    setRunError(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/assets/${assetId}/versions/${selectedVersion.id}/evaluations`,
        { method: "POST", headers: { Authorization: `Bearer ${role.token}` } }
      );
      const body = await safeJson(res);
      if (!res.ok) {
        setRunError(body?.error?.message ?? `평가 실행에 실패했습니다. (HTTP ${res.status})`);
        return;
      }
      setSelectedEvaluationId(body.id);
      await fetchEvaluations(selectedVersion.id, false);
    } catch {
      setRunError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setRunning(false);
    }
  }

  async function handleAddNote(reason: string) {
    if (!selectedEvaluationId) return;
    setNoteSubmitting(true);
    setNoteError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/evaluations/${selectedEvaluationId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({ reason }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setNoteError(body?.error?.message ?? `사유 기록에 실패했습니다. (HTTP ${res.status})`);
        return;
      }
      setNoteOpen(false);
      await fetchDetail(selectedEvaluationId);
    } catch {
      setNoteError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setNoteSubmitting(false);
    }
  }

  if (loading) return <LoadingState label="Knowledge 품질 정보를 불러오는 중..." />;

  if (error || !info) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <ErrorBanner message={error ?? "알 수 없는 오류"} />
        <Button variant="secondary" onClick={() => router.push(`/assets/${assetId}`)}>
          자산 상세로
        </Button>
      </div>
    );
  }

  const isOwner = role.userId === info.owner_creator_id;
  const canRun = canRunEvaluation(role.code) && (role.code !== "CREATOR" || isOwner);
  let runDisabledReason: string | null = null;
  if (!selectedVersion) {
    runDisabledReason = "평가할 버전이 없습니다.";
  } else if (selectedVersion.indexing_job?.status !== "COMPLETED") {
    runDisabledReason = "이 버전은 아직 인덱싱이 완료되지 않았습니다.";
  } else if (!canRun) {
    runDisabledReason =
      role.code === "CREATOR"
        ? "본인이 소유한 Knowledge만 평가를 실행할 수 있습니다."
        : "기술/보안 검토자 또는 관리자만 평가를 실행할 수 있습니다.";
  }

  const inProgress = detail ? IN_PROGRESS_STATUSES.has(detail.status) : false;
  const canNote = canRecordEvaluationNote(role.code);

  return (
    <div className="max-w-5xl space-y-5">
      <div>
        <button
          onClick={() => router.push(`/assets/${assetId}`)}
          className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
        >
          <ChevronLeft size={14} />
          자산 상세로
        </button>
        <PageHeader
          title={`${info.name} — Knowledge 품질`}
          description="검색 품질 지표, 평가 질문별 결과, 이전 버전 대비 변화를 확인합니다."
          actions={
            <div className="flex flex-col items-end gap-1">
              <Button onClick={handleRunEvaluation} disabled={running || !!runDisabledReason}>
                {running ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={14} />}
                {running ? "요청 중..." : "평가 실행"}
              </Button>
              {runDisabledReason && (
                <span className="inline-flex items-center gap-1 text-caption text-text-muted">
                  <Lock size={12} />
                  {runDisabledReason}
                </span>
              )}
            </div>
          }
        />
      </div>

      {runError && <ErrorBanner message={runError} />}

      {/* Version selector */}
      <Section title="버전 선택">
        <div className="flex flex-wrap gap-2">
          {info.versions.map((v, idx) => (
            <button
              key={v.id}
              onClick={() => setSelectedVersionIdx(idx)}
              className={`rounded-lg border px-3 py-2 text-left text-body transition ${
                idx === selectedVersionIdx
                  ? "border-brand-500 bg-brand-50"
                  : "border-border bg-surface hover:border-brand-300"
              }`}
            >
              <div className="font-semibold text-text-primary">v{v.version}</div>
              <StatusBadge status={v.status} />
            </button>
          ))}
        </div>
      </Section>

      {selectedVersion && (
        <Section title="Source·Index 구성">
          <div className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
            <Field label="Source 문서 수" value={selectedVersion.source_documents?.length ?? NOT_RECORDED} />
            <Field label="Source 버전" value={`v${selectedVersion.version}`} />
            <Field
              label="Parsed 문서 수"
              value={selectedVersion.index_meta?.document_count ?? NOT_RECORDED}
            />
            <Field label="Parent 청크 수" value={selectedVersion.index_meta?.parent_count ?? NOT_RECORDED} />
            <Field label="Child 청크 수" value={selectedVersion.index_meta?.chunk_count ?? NOT_RECORDED} />
            <Field
              label="Chunk 전략"
              value={selectedVersion.index_meta?.chunking_strategy ?? NOT_RECORDED}
            />
            <Field label="Chunk 크기" value={NOT_RECORDED} />
            <Field label="Embedding 모델" value={selectedVersion.index_meta?.embed_model ?? NOT_RECORDED} />
            <Field label="Embedding 차원" value={NOT_RECORDED} />
            <Field label="Vector Store" value={info.search_config.vector_store} />
            <Field label="키워드 색인 (BM25)" value={info.search_config.keyword_index} />
            <Field
              label="Hybrid 융합"
              value={`${info.search_config.fusion} (α=${info.search_config.default_alpha})`}
            />
          </div>
        </Section>
      )}

      {/* Evaluation list: loading / failed / loaded-but-empty / loaded 상태를 명확히 구분한다. */}
      {evaluationsLoading && <LoadingState label="평가 이력을 불러오는 중..." />}

      {!evaluationsLoading && evaluationsError && <ErrorBanner message={evaluationsError} />}

      {!evaluationsLoading && !evaluationsError && evaluations !== null && evaluations.length === 0 && (
        <EmptyState
          icon={<ClipboardList size={32} />}
          title="아직 실행된 평가가 없습니다"
          description="평가를 실행하면 Recall/MRR/지연시간과 질문별 검색 결과를 확인할 수 있습니다."
        />
      )}

      {!evaluationsLoading && !evaluationsError && evaluations !== null && evaluations.length > 0 && (
        <Section title="평가 이력 (최신순)">
          <div className="flex flex-wrap gap-2">
            {evaluations.map((e) => (
              <button
                key={e.id}
                onClick={() => setSelectedEvaluationId(e.id)}
                className={`rounded-lg border px-3 py-2 text-left text-caption transition ${
                  e.id === selectedEvaluationId
                    ? "border-brand-500 bg-brand-50"
                    : "border-border bg-surface hover:border-brand-300"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <StatusBadge status={e.status} />
                  {e.status === "COMPLETED" && (
                    <Badge tone={e.gate_passed ? "success" : "danger"}>
                      Gate {e.gate_passed ? "PASS" : "FAIL"}
                    </Badge>
                  )}
                </div>
                <div className="mt-1 text-text-muted">{fmtDate(e.created_at)}</div>
              </button>
            ))}
          </div>
        </Section>
      )}

      {detailError && <ErrorBanner message={detailError} />}

      {detail && (
        <>
          {inProgress && (
            <Section title="평가 진행 상태">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-body text-text-secondary">
                  <Loader2 size={16} className="animate-spin" />
                  {detail.status === "PENDING" ? "평가 대기 중..." : "검색 실행 및 지표 계산 중..."}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled
                  title="평가 실행은 아직 취소를 지원하지 않습니다."
                >
                  취소
                </Button>
              </div>
            </Section>
          )}

          {detail.status === "FAILED" && (
            <Section title="평가 실패">
              <ErrorBanner
                message={detail.error_message ?? "평가 실행 중 알 수 없는 오류가 발생했습니다."}
              />
              <p className="mt-2 text-caption text-text-muted">재시도하려면 "평가 실행"을 다시 눌러주세요.</p>
            </Section>
          )}

          {detail.status === "COMPLETED" && detail.metrics && detail.gate && (
            <>
              {detail.source_masking_note && (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-slate-50 px-4 py-2.5 text-caption text-text-secondary">
                  <Info size={14} />
                  {detail.source_masking_note}
                </div>
              )}

              <Section title="검색 품질 지표">
                <div className="grid grid-cols-2 gap-x-8 gap-y-1 sm:grid-cols-3">
                  <Field label="Recall@1" value={fmtPct(detail.metrics.recall_at_1)} />
                  <Field label="Recall@5" value={fmtPct(detail.metrics.recall_at_5)} />
                  <Field label="MRR" value={detail.metrics.mrr.toFixed(3)} />
                  <Field label="검색 P50" value={fmtMs(detail.metrics.latency_p50_ms)} />
                  <Field label="검색 P95" value={fmtMs(detail.metrics.latency_p95_ms)} />
                  <Field label="검색 결과 없음 비율" value={fmtPct(detail.metrics.no_result_rate)} />
                </div>
              </Section>

              <Section
                title="Quality Gate"
                right={<Badge tone={detail.gate.passed ? "success" : "danger"}>{detail.gate.passed ? "PASS" : "FAIL"}</Badge>}
              >
                <div className="space-y-2">
                  {detail.gate.checks.map((c) => (
                    <div key={c.name} className="flex items-start gap-2 text-body">
                      <Badge tone={c.passed ? "success" : "danger"}>{c.passed ? "PASS" : "FAIL"}</Badge>
                      <span className="text-text-secondary">{c.message}</span>
                    </div>
                  ))}
                  {!detail.gate.passed && canNote && (
                    <div className="pt-2">
                      <Button variant="secondary" size="sm" onClick={() => setNoteOpen(true)}>
                        기준 미달 사유 기록
                      </Button>
                    </div>
                  )}
                  {!detail.gate.passed && !canNote && (
                    <p className="flex items-center gap-1 pt-1 text-caption text-text-muted">
                      <Lock size={12} />
                      기술/보안 검토자 또는 관리자만 기준 미달 사유를 기록할 수 있습니다.
                    </p>
                  )}
                </div>
              </Section>

              {detail.notes.length > 0 && (
                <Section title="검토 사유 기록">
                  <div className="space-y-2">
                    {detail.notes.map((n) => (
                      <div key={n.id} className="rounded-lg border border-border bg-slate-50 p-3 text-body">
                        <div className="flex items-center gap-2 text-caption text-text-secondary">
                          <span className="font-medium">{n.author_id}</span>
                          <Badge>{n.author_role}</Badge>
                          <span>{fmtDate(n.created_at)}</span>
                        </div>
                        <p className="mt-1 text-text-primary">{n.reason}</p>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              <Section title={`평가 질문별 결과 (${detail.per_case.length}개)`}>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-caption">
                    <thead>
                      <tr className="border-b border-border text-text-secondary">
                        <th className="py-1.5 pr-3">질문</th>
                        <th className="py-1.5 pr-3">기대 문서</th>
                        <th className="py-1.5 pr-3">검색 결과 문서</th>
                        <th className="py-1.5 pr-3">Hit@1</th>
                        <th className="py-1.5 pr-3">Hit@5</th>
                        <th className="py-1.5 pr-3">금지 문서</th>
                        <th className="py-1.5">지연</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.per_case.map((c) => (
                        <tr key={c.case_id} className="border-b border-border/60 align-top">
                          <td className="max-w-xs py-1.5 pr-3 text-text-primary">{c.question}</td>
                          <td className="py-1.5 pr-3 text-text-secondary">
                            {c.expected_document_ids.length > 0 ? c.expected_document_ids.join(", ") : "—"}
                          </td>
                          <td className="py-1.5 pr-3 text-text-secondary">
                            {c.retrieved_document_ids.length > 0 ? c.retrieved_document_ids.join(", ") : "—"}
                          </td>
                          <td className="py-1.5 pr-3">
                            <Badge tone={c.hit_at_1 ? "success" : "neutral"}>{c.hit_at_1 ? "적중" : "미적중"}</Badge>
                          </td>
                          <td className="py-1.5 pr-3">
                            <Badge tone={c.hit_at_5 ? "success" : "neutral"}>{c.hit_at_5 ? "적중" : "미적중"}</Badge>
                          </td>
                          <td className="py-1.5 pr-3">
                            {c.forbidden_hit ? <Badge tone="danger">오검색</Badge> : <span className="text-text-muted">—</span>}
                          </td>
                          <td className="py-1.5 text-text-secondary">{c.latency_ms}ms</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>

              <Section title="이전 버전 대비 변화">
                {detail.comparison.available ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-x-8 gap-y-1 sm:grid-cols-3">
                      <Field label="Recall@1 변화" value={fmtDelta(detail.comparison.recall_at_1_delta)} />
                      <Field label="Recall@5 변화" value={fmtDelta(detail.comparison.recall_at_5_delta)} />
                      <Field label="MRR 변화" value={fmtDelta(detail.comparison.mrr_delta, false)} />
                      <Field
                        label="P95 지연 변화"
                        value={fmtDelta(detail.comparison.latency_p95_delta_ms, false)}
                      />
                    </div>
                    <p className="text-body text-text-secondary">
                      개선된 질문 {detail.comparison.improved_case_ids.length}개 · 퇴행한 질문{" "}
                      {detail.comparison.regressed_case_ids.length}개
                    </p>
                    <div className="flex items-center gap-2">
                      <span className="text-body font-medium text-text-primary">권고:</span>
                      <Badge tone={detail.comparison.recommendation === "승인 권고" ? "success" : "danger"}>
                        {detail.comparison.recommendation}
                      </Badge>
                    </div>
                    {detail.comparison.blocking_reasons.length > 0 && (
                      <ul className="list-inside list-disc text-caption text-danger">
                        {detail.comparison.blocking_reasons.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : (
                  <p className="flex items-start gap-2 text-body text-text-secondary">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-text-muted" />
                    {detail.comparison.reason ?? "비교할 수 없습니다."}
                  </p>
                )}
              </Section>

              <Section title="알려진 제한사항">
                <ul className="list-inside list-disc space-y-1 text-body text-text-secondary">
                  {detail.known_limitations.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </Section>
            </>
          )}
        </>
      )}

      <ReasonDialog
        open={noteOpen}
        title="기준 미달 사유 기록"
        description="이 평가의 Quality Gate 미달 사유를 기록합니다. 기록된 사유는 이 화면에 계속 표시됩니다."
        confirmLabel="기록"
        reasonLabel="기준 미달 사유"
        reasonPlaceholder="예: Recall@5가 기준(80%)에 미달하여 재인덱싱이 필요합니다."
        submitting={noteSubmitting}
        error={noteError}
        onConfirm={handleAddNote}
        onCancel={() => {
          setNoteOpen(false);
          setNoteError(null);
        }}
      />
    </div>
  );
}
