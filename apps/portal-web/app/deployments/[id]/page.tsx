"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Copy,
  ExternalLink,
  Loader2,
  Lock,
  PauseCircle,
  PlayCircle,
  RotateCcw,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  LoadingState,
  ReasonDialog,
  StatusBadge,
  inputClass,
} from "../../_components/ui";
import {
  ACCESS_POLICY_LABEL,
  DEPLOYMENT_OPERATOR_ROLE_LABEL,
  ENVIRONMENT_LABEL,
  formatDateTime,
} from "../../_components/deployment-meta";
import { useRole } from "../../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";
const OPERATOR_ROLES = new Set(["RELEASE_MANAGER", "ADMIN"]);

interface DeploymentRevisionOut {
  id: string;
  deployment_id: string;
  revision_number: number;
  service_version_id: string;
  status: string;
  created_at: string;
  activated_at: string | null;
}

interface DeploymentOut {
  id: string;
  service_id: string;
  service_version_id: string;
  slug: string;
  environment: string;
  access_policy: string;
  status: string;
  target_orgs: string[] | null;
  target_roles: string[] | null;
  active_revision_id: string | null;
  deployment_url: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  active_revision: DeploymentRevisionOut | null;
  suspended_by: string | null;
  suspended_at: string | null;
  suspend_reason: string | null;
}

interface KnowledgeSummary {
  knowledge_id: string | null;
  asset_name: string | null;
}

interface RevisionSummary {
  id: string;
  revision_number: number;
  service_version_id: string;
  status: string;
  created_by: string;
  created_at: string;
  activated_at: string | null;
  knowledge: KnowledgeSummary[];
  model_alias: string | null;
}

interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
  code?: string | null;
}

type LoadState = "loading" | "ok" | "not_found" | "error";

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export default function DeploymentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const deploymentId = params.id as string;
  const { role } = useRole();

  const [deployment, setDeployment] = useState<DeploymentOut | null>(null);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 중단
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [suspendError, setSuspendError] = useState<string | null>(null);

  // 재개
  const [resumeConfirmOpen, setResumeConfirmOpen] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resumeChecks, setResumeChecks] = useState<ValidationCheck[] | null>(null);

  // 롤백
  const [rollbackTargetId, setRollbackTargetId] = useState("");
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  async function fetchAll() {
    setState("loading");
    setLoadErrorMessage(null);
    try {
      const [depRes, revRes] = await Promise.all([
        fetch(`${API_BASE}/api/v1/deployments/${deploymentId}`, {
          headers: { Authorization: `Bearer ${role.token}` },
        }),
        fetch(`${API_BASE}/api/v1/deployments/${deploymentId}/revisions?page_size=50`, {
          headers: { Authorization: `Bearer ${role.token}` },
        }),
      ]);

      if (depRes.status === 404) {
        setState("not_found");
        return;
      }
      if (!depRes.ok) {
        const body = await safeJson(depRes);
        throw new Error(body?.error?.message ?? `HTTP ${depRes.status}`);
      }
      const depData: DeploymentOut = await depRes.json();

      let revItems: RevisionSummary[] = [];
      if (revRes.ok) {
        const revData = await revRes.json();
        revItems = revData.items ?? [];
      }

      setDeployment(depData);
      setRevisions(revItems);
      setState("ok");
    } catch (e) {
      setLoadErrorMessage(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deploymentId, role.token]);

  async function handleCopy() {
    if (!deployment) return;
    try {
      await navigator.clipboard.writeText(deployment.deployment_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // best-effort; clipboard access can be denied in some contexts
    }
  }

  async function handleSuspend(reason: string) {
    setSuspending(true);
    setSuspendError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/deployments/${deploymentId}/suspend`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({ reason }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setSuspendError(
          body?.error?.message ??
            (res.status === 403
              ? `${DEPLOYMENT_OPERATOR_ROLE_LABEL}만 중단할 수 있습니다.`
              : `중단 처리에 실패했습니다. (HTTP ${res.status})`)
        );
        return;
      }
      setSuspendOpen(false);
      await fetchAll();
    } catch {
      setSuspendError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setSuspending(false);
    }
  }

  async function handleResume() {
    setResuming(true);
    setResumeError(null);
    setResumeChecks(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/deployments/${deploymentId}/resume`, {
        method: "POST",
        headers: { Authorization: `Bearer ${role.token}` },
      });
      const body = await safeJson(res);
      if (!res.ok) {
        if (res.status === 400 && body?.error?.code === "DEPLOYMENT_VALIDATION_FAILED") {
          const checks: ValidationCheck[] = body.error.details?.checks ?? [];
          setResumeChecks(checks.filter((c) => !c.passed));
          setResumeError(body.error.message ?? "게시 Gate 검증에 실패했습니다.");
        } else {
          setResumeError(
            body?.error?.message ??
              (res.status === 403
                ? `${DEPLOYMENT_OPERATOR_ROLE_LABEL}만 재개할 수 있습니다.`
                : `재개 처리에 실패했습니다. (HTTP ${res.status})`)
          );
        }
        return;
      }
      setResumeConfirmOpen(false);
      await fetchAll();
    } catch {
      setResumeError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setResuming(false);
    }
  }

  async function handleRollback(reason: string) {
    setRollingBack(true);
    setRollbackError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/deployments/${deploymentId}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({
          reason,
          target_revision_id: rollbackTargetId || undefined,
        }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setRollbackError(
          body?.error?.message ??
            (res.status === 403
              ? `${DEPLOYMENT_OPERATOR_ROLE_LABEL}만 롤백할 수 있습니다.`
              : `롤백 처리에 실패했습니다. (HTTP ${res.status})`)
        );
        return;
      }
      setRollbackOpen(false);
      setRollbackTargetId("");
      await fetchAll();
    } catch {
      setRollbackError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setRollingBack(false);
    }
  }

  if (state === "loading") return <LoadingState label="게시 상세를 불러오는 중..." />;

  if (state === "not_found") {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="font-medium text-text-primary">게시 정보를 찾을 수 없습니다.</p>
        <Button variant="secondary" onClick={() => router.push("/deployments")}>
          게시 관리로 돌아가기
        </Button>
      </div>
    );
  }

  if (state === "error" || !deployment) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <ErrorBanner message={loadErrorMessage ?? "알 수 없는 오류"} />
        <Button variant="secondary" onClick={() => router.push("/deployments")}>
          게시 관리로 돌아가기
        </Button>
      </div>
    );
  }

  const isOperator = OPERATOR_ROLES.has(role.code);
  const isActive = deployment.status === "ACTIVE";
  const isSuspended = deployment.status === "SUSPENDED";
  const hasMultipleRevisions = revisions.length >= 2;

  let suspendDisabledReason: string | null = null;
  if (!isActive) suspendDisabledReason = "활성(ACTIVE) 상태의 게시만 중단할 수 있습니다.";
  else if (!isOperator)
    suspendDisabledReason = `${DEPLOYMENT_OPERATOR_ROLE_LABEL} 역할이 필요합니다. 현재 역할: ${role.label}.`;

  let resumeDisabledReason: string | null = null;
  if (!isSuspended) resumeDisabledReason = "중단(SUSPENDED) 상태의 게시만 재개할 수 있습니다.";
  else if (!isOperator)
    resumeDisabledReason = `${DEPLOYMENT_OPERATOR_ROLE_LABEL} 역할이 필요합니다. 현재 역할: ${role.label}.`;

  let rollbackDisabledReason: string | null = null;
  if (!hasMultipleRevisions) rollbackDisabledReason = "이전 Revision이 없어 롤백할 수 없습니다.";
  else if (!isOperator)
    rollbackDisabledReason = `${DEPLOYMENT_OPERATOR_ROLE_LABEL} 역할이 필요합니다. 현재 역할: ${role.label}.`;

  const rollbackCandidates = revisions.filter((r) => r.id !== deployment.active_revision_id);

  return (
    <div className="max-w-3xl space-y-5">
      <button
        onClick={() => router.push("/deployments")}
        className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
      >
        <ChevronLeft size={14} />
        게시 관리로
      </button>

      <div>
        <h1 className="text-page-title font-bold text-text-primary">{deployment.slug}</h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <StatusBadge status={deployment.status} />
          <Badge tone="neutral">
            {ENVIRONMENT_LABEL[deployment.environment] ?? deployment.environment}
          </Badge>
        </div>
      </div>

      {/* 기본정보 */}
      <Card className="p-5">
        <h2 className="mb-3 text-card-title font-semibold text-text-primary">기본정보</h2>
        <dl className="space-y-2 text-sm">
          <Row label="Slug" value={deployment.slug} />
          <Row label="상태" value={<StatusBadge status={deployment.status} />} />
          <Row
            label="환경"
            value={ENVIRONMENT_LABEL[deployment.environment] ?? deployment.environment}
          />
          <Row
            label="접근 정책"
            value={ACCESS_POLICY_LABEL[deployment.access_policy] ?? deployment.access_policy}
          />
          <Row label="게시자" value={deployment.created_by} />
          <Row label="게시일" value={formatDateTime(deployment.created_at)} />
          <Row
            label="발급 URL"
            value={
              <div className="flex items-center gap-2">
                <code className="truncate rounded bg-slate-100 px-2 py-1 text-xs text-text-secondary">
                  {deployment.deployment_url}
                </code>
                <Button variant="secondary" size="sm" onClick={handleCopy}>
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? "복사됨" : "복사"}
                </Button>
              </div>
            }
          />
          <Row
            label="이 환경에서 열기"
            value={
              isActive ? (
                <Button variant="secondary" size="sm" href={`/chat/${deployment.slug}`} target="_blank" rel="noreferrer">
                  <ExternalLink size={12} />
                  열기 (데모용)
                </Button>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
                  <Lock size={12} />
                  현재 상태({deployment.status})에서는 열 수 없습니다. 활성 상태에서만 접속할 수
                  있습니다.
                </span>
              )
            }
          />
        </dl>
      </Card>

      {/* 중단 사유 */}
      {isSuspended && (
        <Card tone="danger" className="p-5">
          <h2 className="mb-3 flex items-center gap-1.5 text-card-title font-semibold text-danger">
            <AlertTriangle size={15} />
            중단 사유
          </h2>
          <dl className="space-y-2 text-body text-danger">
            <Row label="사유" value={deployment.suspend_reason ?? "-"} />
            <Row label="중단자" value={deployment.suspended_by ?? "-"} />
            <Row label="중단일" value={formatDateTime(deployment.suspended_at)} />
          </dl>
        </Card>
      )}

      {/* Revision 목록 */}
      <Card className="p-5">
        <h2 className="mb-3 text-card-title font-semibold text-text-primary">Revision 목록</h2>
        {revisions.length === 0 ? (
          <p className="text-body text-text-muted">Revision이 없습니다.</p>
        ) : (
          <ul className="space-y-2">
            {revisions.map((rev) => (
              <li
                key={rev.id}
                className="rounded-lg border border-border bg-slate-50 p-3 text-body"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-text-primary">Revision {rev.revision_number}</span>
                  <StatusBadge status={rev.status} />
                  {rev.id === deployment.active_revision_id && <Badge tone="success">현재 활성</Badge>}
                </div>
                <div className="mt-1 text-caption text-text-secondary">
                  생성자 {rev.created_by} · 생성일 {formatDateTime(rev.created_at)}
                  {rev.activated_at && ` · 활성화일 ${formatDateTime(rev.activated_at)}`}
                </div>
                {(rev.knowledge.length > 0 || rev.model_alias) && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {rev.knowledge.map((k, idx) => (
                      <Badge key={k.knowledge_id ?? idx} tone="purple">
                        {k.asset_name ?? k.knowledge_id ?? "지식 자산"}
                      </Badge>
                    ))}
                    {rev.model_alias && <Badge tone="info">모델: {rev.model_alias}</Badge>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Actions */}
      <Card className="p-5">
        <h2 className="mb-3 text-card-title font-semibold text-text-primary">운영 작업</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="danger"
            size="sm"
            disabled={!!suspendDisabledReason}
            onClick={() => {
              setSuspendError(null);
              setSuspendOpen(true);
            }}
          >
            <PauseCircle size={14} />
            중단
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!!resumeDisabledReason}
            onClick={() => {
              setResumeError(null);
              setResumeChecks(null);
              setResumeConfirmOpen(true);
            }}
          >
            <PlayCircle size={14} />
            재개
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!!rollbackDisabledReason}
            onClick={() => {
              setRollbackError(null);
              setRollbackOpen(true);
            }}
          >
            <RotateCcw size={14} />
            롤백
          </Button>
        </div>

        {hasMultipleRevisions && !rollbackDisabledReason && (
          <div className="mt-3">
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              롤백 대상 Revision (선택 안 하면 바로 이전 Revision으로 복구)
            </label>
            <select
              value={rollbackTargetId}
              onChange={(e) => setRollbackTargetId(e.target.value)}
              className={`${inputClass} w-auto`}
            >
              <option value="">(자동: 바로 이전 Revision)</option>
              {rollbackCandidates.map((r) => (
                <option key={r.id} value={r.id}>
                  Revision {r.revision_number} ({r.status}) · {formatDateTime(r.created_at)}
                </option>
              ))}
            </select>
          </div>
        )}

        {(suspendDisabledReason || resumeDisabledReason || rollbackDisabledReason) && (
          <div className="mt-3 flex flex-col gap-1 text-caption text-text-secondary">
            {suspendDisabledReason && (
              <span className="inline-flex items-center gap-1">
                <Lock size={12} />
                중단 불가: {suspendDisabledReason}
              </span>
            )}
            {resumeDisabledReason && (
              <span className="inline-flex items-center gap-1">
                <Lock size={12} />
                재개 불가: {resumeDisabledReason}
              </span>
            )}
            {rollbackDisabledReason && (
              <span className="inline-flex items-center gap-1">
                <Lock size={12} />
                롤백 불가: {rollbackDisabledReason}
              </span>
            )}
          </div>
        )}
      </Card>

      {/* 중단 다이얼로그 */}
      <ReasonDialog
        open={suspendOpen}
        title="게시 중단 확인"
        description="중단하면 사용자가 발급된 URL로 더 이상 접속할 수 없게 됩니다. 이 작업은 감사 로그에 기록됩니다."
        confirmLabel="중단"
        confirmVariant="danger"
        reasonLabel="중단 사유"
        reasonPlaceholder="중단 사유를 입력하세요 (필수)"
        submitting={suspending}
        error={suspendError}
        onConfirm={handleSuspend}
        onCancel={() => {
          setSuspendOpen(false);
          setSuspendError(null);
        }}
      />

      {/* 롤백 다이얼로그 */}
      <ReasonDialog
        open={rollbackOpen}
        title="게시 롤백 확인"
        description={
          rollbackTargetId
            ? `선택한 Revision(${
                rollbackCandidates.find((r) => r.id === rollbackTargetId)?.revision_number ?? ""
              })으로 복구합니다. 현재 활성 Revision은 대체(SUPERSEDED)됩니다.`
            : "바로 이전 Revision으로 복구합니다. 현재 활성 Revision은 대체(SUPERSEDED)됩니다."
        }
        confirmLabel="롤백"
        confirmVariant="secondary"
        reasonLabel="롤백 사유"
        reasonPlaceholder="롤백 사유를 입력하세요 (필수)"
        submitting={rollingBack}
        error={rollbackError}
        onConfirm={handleRollback}
        onCancel={() => {
          setRollbackOpen(false);
          setRollbackError(null);
        }}
      />

      {/* 재개 확인 (사유 불필요 — API가 body를 받지 않음) */}
      {resumeConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
          <div className="w-full max-w-md rounded-card bg-surface p-5 shadow-xl">
            <h3 className="text-card-title font-semibold text-text-primary">게시 재개 확인</h3>
            <p className="mt-1.5 text-body text-text-secondary">
              재개하면 사용자가 다시 발급된 URL로 접속할 수 있게 됩니다. 재개 전 현재 구성으로 게시
              Gate 검증을 다시 수행합니다.
            </p>

            {resumeError && (
              <div className="mt-3">
                <ErrorBanner message={resumeError} />
              </div>
            )}

            {resumeChecks && resumeChecks.length > 0 && (
              <div className="mt-3 space-y-2 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3">
                <p className="flex items-center gap-1.5 text-body font-semibold text-danger">
                  <AlertTriangle size={14} />
                  게시 Gate 검증 실패 항목
                </p>
                <ul className="space-y-1 text-body text-danger">
                  {resumeChecks.map((check) => (
                    <li key={check.name} className="list-disc pl-4">
                      {check.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="secondary"
                disabled={resuming}
                onClick={() => {
                  setResumeConfirmOpen(false);
                  setResumeError(null);
                  setResumeChecks(null);
                }}
              >
                취소
              </Button>
              <Button onClick={handleResume} disabled={resuming}>
                {resuming && <Loader2 size={14} className="animate-spin" />}
                재개
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-text-secondary">{label}</dt>
      <dd className="min-w-0 flex-1 text-text-primary">{value}</dd>
    </div>
  );
}
