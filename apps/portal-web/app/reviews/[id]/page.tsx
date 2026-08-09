"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Check, ChevronLeft, RotateCcw, ShieldAlert, X } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  LoadingState,
  ReasonDialog,
  StatusBadge,
} from "../../_components/ui";
import {
  ASSET_TYPE_LABEL,
  DECISION_LABEL,
  STAGE_LABEL,
  STAGE_REQUIRED_ROLE_LABEL,
  STAGE_TONE,
  formatDateTime,
} from "../../_components/review-meta";
import { useRole, type RoleCode } from "../../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

interface ReviewOut {
  id: string;
  subject_type: string;
  subject_id: string;
  stage: string;
  status: string;
  requested_by: string;
  requested_at: string;
  assigned_to: string | null;
  policy_version: string | null;
  asset_name: string | null;
  asset_type: string | null;
  version_label: string | null;
}

interface HistoryEntry {
  stage: string;
  status: string;
  decision: string | null;
  reviewer_id: string | null;
  comments: string | null;
  decided_at: string | null;
}

interface ReviewDetail {
  review: ReviewOut;
  subject_summary: {
    asset_id?: string;
    version?: string;
    status?: string;
    manifest_type?: string;
    manifest_name?: string;
    changelog?: string;
  };
  history: HistoryEntry[];
}

interface DecisionResult {
  version_status: string;
  next_stage: string | null;
}

type LoadState = "loading" | "ok" | "forbidden" | "not_found" | "error";
type Decision = "APPROVE" | "REJECT" | "REQUEST_CHANGES";

// Stage -> the single role (besides ADMIN) allowed to decide it
// (mirrors security_policy.review.STAGE_PERMISSION).
const STAGE_DECIDER_ROLE: Record<string, RoleCode> = {
  TECHNICAL: "TECH_REVIEWER",
  SECURITY: "SECURITY_REVIEWER",
  RELEASE: "RELEASE_MANAGER",
};

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export default function ReviewDetailPage() {
  const params = useParams();
  const router = useRouter();
  const reviewId = params.id as string;
  const { role } = useRole();

  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);

  const [openDecision, setOpenDecision] = useState<Decision | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [result, setResult] = useState<DecisionResult | null>(null);

  async function fetchDetail() {
    setState("loading");
    setLoadErrorMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/reviews/${reviewId}`, {
        headers: { Authorization: `Bearer ${role.token}` },
      });
      if (res.status === 403) {
        setState("forbidden");
        return;
      }
      if (res.status === 404) {
        setState("not_found");
        return;
      }
      if (!res.ok) {
        const body = await safeJson(res);
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      const data: ReviewDetail = await res.json();
      setDetail(data);
      setState("ok");
    } catch (e) {
      setLoadErrorMessage(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  useEffect(() => {
    fetchDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId, role.token]);

  async function handleDecide(reason: string) {
    if (!openDecision || !detail) return;
    setSubmitting(true);
    setDecisionError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/reviews/${reviewId}/decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({ decision: openDecision, comments: reason }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        if (res.status === 409) {
          setDecisionError(body?.error?.message ?? "이미 처리된 검토 요청입니다.");
        } else if (res.status === 403) {
          setDecisionError(
            body?.error?.message ??
              `이 단계는 ${STAGE_REQUIRED_ROLE_LABEL[detail.review.stage] ?? "담당 검토자"}만 결정할 수 있습니다.`
          );
        } else {
          setDecisionError(body?.error?.message ?? `처리에 실패했습니다. (HTTP ${res.status})`);
        }
        setSubmitting(false);
        return;
      }
      setResult({ version_status: body.version_status, next_stage: body.next_stage });
      setOpenDecision(null);
      setSubmitting(false);
    } catch {
      setDecisionError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
      setSubmitting(false);
    }
  }

  if (state === "loading") return <LoadingState label="검토 상세를 불러오는 중..." />;

  if (state === "forbidden") {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <ShieldAlert size={40} className="text-slate-300" strokeWidth={1.5} />
        <p className="font-medium text-text-primary">이 역할에는 검토 열람 권한이 없습니다.</p>
        <p className="text-body text-text-secondary">
          현재 역할: {role.label}. 상단의 개발용 역할 전환에서 검토 권한이 있는 역할로 전환하세요.
        </p>
        <Button variant="secondary" onClick={() => router.push("/reviews")}>
          검토함으로 돌아가기
        </Button>
      </div>
    );
  }

  if (state === "not_found") {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="font-medium text-text-primary">검토 요청을 찾을 수 없습니다.</p>
        <Button variant="secondary" onClick={() => router.push("/reviews")}>
          검토함으로 돌아가기
        </Button>
      </div>
    );
  }

  if (state === "error" || !detail) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <ErrorBanner message={loadErrorMessage ?? "알 수 없는 오류"} />
        <Button variant="secondary" onClick={() => router.push("/reviews")}>
          검토함으로 돌아가기
        </Button>
      </div>
    );
  }

  const { review, subject_summary, history } = detail;
  const requiredRole = STAGE_DECIDER_ROLE[review.stage];
  const roleCanDecideStage = role.code === "ADMIN" || role.code === requiredRole;
  const isPending = review.status === "PENDING";
  const canDecide = isPending && roleCanDecideStage && !result;

  let disabledReason: string | null = null;
  if (!isPending && !result) {
    disabledReason = "이미 처리된 검토 요청입니다.";
  } else if (!roleCanDecideStage && !result) {
    disabledReason = `이 단계(${STAGE_LABEL[review.stage] ?? review.stage})는 ${
      STAGE_REQUIRED_ROLE_LABEL[review.stage] ?? "담당 검토자"
    }만 결정할 수 있습니다. 현재 역할: ${role.label}.`;
  }

  return (
    <div className="max-w-3xl space-y-5">
      <button
        onClick={() => router.push("/reviews")}
        className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
      >
        <ChevronLeft size={14} />
        검토함으로
      </button>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-page-title font-bold text-text-primary">
            {review.asset_name ?? "(알 수 없는 대상)"}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge>{ASSET_TYPE_LABEL[review.asset_type ?? ""] ?? review.asset_type ?? "-"}</Badge>
            {review.version_label && <Badge tone="neutral">v{review.version_label}</Badge>}
            <Badge tone={STAGE_TONE[review.stage] ?? "neutral"}>
              {STAGE_LABEL[review.stage] ?? review.stage}
            </Badge>
            <StatusBadge status={review.status} />
          </div>
        </div>
      </div>

      {/* 기본정보 */}
      <Card className="p-5">
        <h2 className="mb-3 text-card-title font-semibold text-text-primary">기본정보</h2>
        <dl className="space-y-2 text-sm">
          <Row label="제출자" value={review.requested_by} />
          <Row label="요청일" value={formatDateTime(review.requested_at)} />
          <Row label="검토 단계" value={STAGE_LABEL[review.stage] ?? review.stage} />
          {subject_summary.changelog && <Row label="변경 목적" value={subject_summary.changelog} />}
        </dl>
      </Card>

      {/* Manifest 요약 */}
      <Card className="p-5">
        <h2 className="mb-3 text-card-title font-semibold text-text-primary">
          {review.subject_type === "SERVICE_VERSION" ? "서비스 버전 요약" : "자산 버전 요약"}
        </h2>
        <dl className="space-y-2 text-sm">
          <Row
            label="유형"
            value={
              review.subject_type === "SERVICE_VERSION"
                ? "AI Service"
                : ASSET_TYPE_LABEL[subject_summary.manifest_type ?? ""] ??
                  subject_summary.manifest_type ??
                  "-"
            }
          />
          <Row label="이름" value={subject_summary.manifest_name ?? "-"} />
          <Row label="버전" value={subject_summary.version ?? "-"} />
          <Row label="현재 상태" value={<StatusBadge status={subject_summary.status ?? "-"} />} />
        </dl>
      </Card>

      {/* 이전 검토 의견 */}
      <Card className="p-5">
        <h2 className="mb-3 text-card-title font-semibold text-text-primary">이전 검토 의견</h2>
        {history.length === 0 ? (
          <p className="text-body text-text-muted">검토 이력이 없습니다.</p>
        ) : (
          <ul className="space-y-3">
            {history.map((h, idx) => (
              <li key={idx} className="rounded-lg border border-border bg-slate-50 p-3 text-body">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge tone={STAGE_TONE[h.stage] ?? "neutral"}>{STAGE_LABEL[h.stage] ?? h.stage}</Badge>
                  {h.decision ? (
                    <Badge tone={h.decision === "REJECT" ? "danger" : h.decision === "APPROVE" ? "success" : "warning"}>
                      {DECISION_LABEL[h.decision] ?? h.decision}
                    </Badge>
                  ) : (
                    <Badge tone="neutral">결정 대기중</Badge>
                  )}
                  {h.reviewer_id && <span className="text-caption text-text-secondary">{h.reviewer_id}</span>}
                  {h.decided_at && (
                    <span className="text-caption text-text-muted">{formatDateTime(h.decided_at)}</span>
                  )}
                </div>
                {h.comments && <p className="text-text-secondary">{h.comments}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 결과 또는 액션 */}
      {result ? (
        <div className="space-y-3 rounded-card border border-success/30 bg-success/5 p-5">
          <div className="flex items-center gap-2 text-body font-semibold text-success">
            <Check size={16} />
            처리가 완료되었습니다.
          </div>
          <p className="text-body text-success">
            버전 상태: <StatusBadge status={result.version_status} />
            {result.next_stage && (
              <>
                {" "}
                — 다음 단계: <Badge tone={STAGE_TONE[result.next_stage] ?? "neutral"}>
                  {STAGE_LABEL[result.next_stage] ?? result.next_stage}
                </Badge>
              </>
            )}
            {!result.next_stage && result.version_status === "APPROVED" && " — 모든 단계 승인 완료"}
          </p>
          <Button variant="secondary" size="sm" onClick={() => router.push("/reviews")}>
            검토함으로 돌아가기
          </Button>
        </div>
      ) : (
        <Card className="p-5">
          <h2 className="mb-3 text-card-title font-semibold text-text-primary">검토 결정</h2>
          {disabledReason && (
            <p className="mb-3 rounded-lg bg-warning/5 px-3 py-2 text-caption text-warning">{disabledReason}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!canDecide}
              onClick={() => {
                setDecisionError(null);
                setOpenDecision("APPROVE");
              }}
            >
              <Check size={15} />
              승인
            </Button>
            <Button
              variant="secondary"
              disabled={!canDecide}
              onClick={() => {
                setDecisionError(null);
                setOpenDecision("REQUEST_CHANGES");
              }}
            >
              <RotateCcw size={15} />
              수정 요청
            </Button>
            <Button
              variant="danger"
              disabled={!canDecide}
              onClick={() => {
                setDecisionError(null);
                setOpenDecision("REJECT");
              }}
            >
              <X size={15} />
              반려
            </Button>
          </div>
        </Card>
      )}

      <ReasonDialog
        open={openDecision !== null}
        title={
          openDecision
            ? `${STAGE_LABEL[review.stage] ?? review.stage} ${DECISION_LABEL[openDecision]} 확인`
            : ""
        }
        description={`이 결정은 ${
          review.subject_type === "SERVICE_VERSION" ? "서비스" : "자산"
        } 버전의 상태를 변경하며 감사 로그에 기록됩니다. ${
          openDecision === "REJECT" ? "반려하면 이 버전은 더 이상 재제출할 수 없습니다." : ""
        }`}
        confirmLabel={openDecision ? DECISION_LABEL[openDecision] : "확인"}
        confirmVariant={openDecision === "REJECT" ? "danger" : "primary"}
        reasonLabel="검토 의견"
        reasonPlaceholder="검토 의견을 입력하세요 (필수)"
        submitting={submitting}
        error={decisionError}
        onConfirm={handleDecide}
        onCancel={() => {
          setOpenDecision(null);
          setDecisionError(null);
        }}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-text-secondary">{label}</dt>
      <dd className="text-text-primary">{value}</dd>
    </div>
  );
}
