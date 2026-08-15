"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowUpCircle,
  Check,
  ChevronLeft,
  Copy,
  ExternalLink,
  Loader2,
  Lock,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Trash2,
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
  retired_by: string | null;
  retired_at: string | null;
  retire_reason: string | null;
}

interface ServiceVersionSummary {
  id: string;
  version: string;
  status: string;
  created_at: string;
  approved_at: string | null;
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

  // 갱신(새 Service Version으로 재게시)
  const [serviceVersions, setServiceVersions] = useState<ServiceVersionSummary[]>([]);
  const [updateTargetId, setUpdateTargetId] = useState("");
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateChecks, setUpdateChecks] = useState<ValidationCheck[] | null>(null);

  // 폐기
  const [retireOpen, setRetireOpen] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [retireError, setRetireError] = useState<string | null>(null);

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

      // 갱신 대상 후보 — 같은 Service의 다른 Version만 (계약이 다른 Service의
      // Version을 거부하므로 화면에서도 애초에 보여주지 않는다). 이 조회가
      // 실패해도 상세 화면 전체를 오류로 만들지는 않고, 갱신 액션만 사유와
      // 함께 비활성화된다.
      let versionItems: ServiceVersionSummary[] = [];
      try {
        const svcRes = await fetch(`${API_BASE}/api/v1/services/${depData.service_id}`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (svcRes.ok) {
          const svcData = await svcRes.json();
          versionItems = svcData.versions ?? [];
        }
      } catch {
        versionItems = [];
      }

      setDeployment(depData);
      setRevisions(revItems);
      setServiceVersions(versionItems);
      setUpdateTargetId("");
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

  async function handleUpdate(reason: string) {
    if (!updateTargetId) return;
    setUpdating(true);
    setUpdateError(null);
    setUpdateChecks(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/deployments/${deploymentId}/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({
          service_version_id: updateTargetId,
          reason: reason.trim() || undefined,
        }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        if (res.status === 400 && body?.error?.code === "DEPLOYMENT_VALIDATION_FAILED") {
          // HOST-022 — 기존 Revision은 그대로 유지된다. 화면도 그렇게 말한다.
          const checks: ValidationCheck[] = body.error.details?.checks ?? [];
          setUpdateChecks(checks.filter((c) => !c.passed));
          setUpdateError(body.error.message ?? "갱신 Gate 검증에 실패했습니다.");
        } else {
          setUpdateError(
            body?.error?.message ??
              (res.status === 403
                ? `${DEPLOYMENT_OPERATOR_ROLE_LABEL}만 갱신할 수 있습니다.`
                : `갱신 처리에 실패했습니다. (HTTP ${res.status})`)
          );
        }
        return;
      }
      setUpdateOpen(false);
      await fetchAll();
    } catch {
      setUpdateError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setUpdating(false);
    }
  }

  async function handleRetire(reason: string) {
    setRetiring(true);
    setRetireError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/deployments/${deploymentId}/retire`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({ reason }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setRetireError(
          body?.error?.message ??
            (res.status === 403
              ? `${DEPLOYMENT_OPERATOR_ROLE_LABEL}만 폐기할 수 있습니다.`
              : `폐기 처리에 실패했습니다. (HTTP ${res.status})`)
        );
        return;
      }
      setRetireOpen(false);
      await fetchAll();
    } catch {
      setRetireError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setRetiring(false);
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
  const isRetired = deployment.status === "RETIRED";
  const hasMultipleRevisions = revisions.length >= 2;
  const roleNeeded = `${DEPLOYMENT_OPERATOR_ROLE_LABEL} 역할이 필요합니다. 현재 역할: ${role.label}.`;
  // 폐기는 되돌릴 수 없으므로 모든 운영 작업의 첫 번째 차단 사유다 —
  // 서버도 다섯 경로 전부에서 거절하며, 화면이 그 사실을 먼저 말한다.
  const retiredBlock = "폐기(RETIRED)된 게시는 되돌릴 수 없습니다. 새 게시를 만드세요.";

  let suspendDisabledReason: string | null = null;
  if (isRetired) suspendDisabledReason = retiredBlock;
  else if (!isActive) suspendDisabledReason = "활성(ACTIVE) 상태의 게시만 중단할 수 있습니다.";
  else if (!isOperator) suspendDisabledReason = roleNeeded;

  let resumeDisabledReason: string | null = null;
  if (isRetired) resumeDisabledReason = retiredBlock;
  else if (!isSuspended) resumeDisabledReason = "중단(SUSPENDED) 상태의 게시만 재개할 수 있습니다.";
  else if (!isOperator) resumeDisabledReason = roleNeeded;

  let rollbackDisabledReason: string | null = null;
  if (isRetired) rollbackDisabledReason = retiredBlock;
  else if (!hasMultipleRevisions)
    rollbackDisabledReason = "이전 Revision이 없어 롤백할 수 없습니다.";
  else if (!isOperator) rollbackDisabledReason = roleNeeded;

  const rollbackCandidates = revisions.filter((r) => r.id !== deployment.active_revision_id);

  // 갱신 후보: 같은 Service의 Version 중 지금 활성인 것을 제외한 것.
  const activeServiceVersionId =
    deployment.active_revision?.service_version_id ?? deployment.service_version_id;
  const updateCandidates = serviceVersions.filter((v) => v.id !== activeServiceVersionId);

  let updateDisabledReason: string | null = null;
  if (isRetired) updateDisabledReason = retiredBlock;
  else if (!isActive && !isSuspended)
    updateDisabledReason =
      "아직 게시된 적이 없습니다. 먼저 게시(publish)한 뒤에 새 버전으로 갱신할 수 있습니다.";
  else if (updateCandidates.length === 0)
    updateDisabledReason =
      "이 Service에 다른 Version이 없습니다. 새 Service Version을 먼저 만드세요.";
  else if (!isOperator) updateDisabledReason = roleNeeded;

  let retireDisabledReason: string | null = null;
  if (isRetired) retireDisabledReason = "이미 폐기된 게시입니다.";
  else if (!isActive && !isSuspended)
    retireDisabledReason = "게시된 적 없는 항목은 폐기할 수 없습니다.";
  else if (!isOperator) retireDisabledReason = roleNeeded;

  const updateTargetVersion = updateCandidates.find((v) => v.id === updateTargetId);

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

      {/* 폐기 사유 */}
      {isRetired && (
        <Card tone="danger" className="p-5">
          <h2 className="mb-3 flex items-center gap-1.5 text-card-title font-semibold text-danger">
            <Trash2 size={15} />
            폐기됨
          </h2>
          <p className="mb-3 text-body text-danger">
            이 게시는 폐기되어 되돌릴 수 없습니다. 발급된 URL은 더 이상 접속되지 않으며, 같은
            Slug는 다른 챗봇에 다시 사용되지 않도록 계속 예약된 상태로 남습니다.
          </p>
          <dl className="space-y-2 text-body text-danger">
            <Row label="사유" value={deployment.retire_reason ?? "-"} />
            <Row label="폐기자" value={deployment.retired_by ?? "-"} />
            <Row label="폐기일" value={formatDateTime(deployment.retired_at)} />
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
          <Button
            variant="secondary"
            size="sm"
            disabled={!!updateDisabledReason}
            onClick={() => {
              setUpdateError(null);
              setUpdateChecks(null);
              setUpdateOpen(true);
            }}
          >
            <ArrowUpCircle size={14} />
            새 버전으로 갱신
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={!!retireDisabledReason}
            onClick={() => {
              setRetireError(null);
              setRetireOpen(true);
            }}
          >
            <Trash2 size={14} />
            폐기
          </Button>
        </div>

        {!updateDisabledReason && (
          <div className="mt-3">
            <label
              htmlFor="update-target-version"
              className="mb-1 block text-xs font-medium text-text-secondary"
            >
              갱신할 Service Version (같은 Service의 다른 버전만 선택할 수 있습니다)
            </label>
            <select
              id="update-target-version"
              value={updateTargetId}
              onChange={(e) => setUpdateTargetId(e.target.value)}
              className={`${inputClass} w-auto`}
            >
              <option value="">(선택하세요)</option>
              {updateCandidates.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.version} ({v.status}) · {formatDateTime(v.created_at)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-caption text-text-secondary">
              갱신해도 Slug와 발급 URL은 그대로입니다. 검증에 실패하면 아무것도 바뀌지 않고 현재
              Revision이 계속 서비스됩니다.
            </p>
          </div>
        )}

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

        {(suspendDisabledReason ||
          resumeDisabledReason ||
          rollbackDisabledReason ||
          updateDisabledReason ||
          retireDisabledReason) && (
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
            {updateDisabledReason && (
              <span className="inline-flex items-center gap-1">
                <Lock size={12} />
                갱신 불가: {updateDisabledReason}
              </span>
            )}
            {retireDisabledReason && (
              <span className="inline-flex items-center gap-1">
                <Lock size={12} />
                폐기 불가: {retireDisabledReason}
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

      {/* 폐기 다이얼로그 */}
      <ReasonDialog
        open={retireOpen}
        title="게시 폐기 확인"
        description="폐기하면 되돌릴 수 없습니다. 재개·롤백·갱신·재게시 모두 불가능해지고, 발급된 URL은 영구히 접속되지 않습니다. Slug는 다른 챗봇이 물려받지 못하도록 계속 예약된 상태로 남고, Revision 이력은 감사를 위해 보존됩니다."
        confirmLabel="폐기"
        confirmVariant="danger"
        reasonLabel="폐기 사유"
        reasonPlaceholder="폐기 사유를 입력하세요 (필수)"
        submitting={retiring}
        error={retireError}
        onConfirm={handleRetire}
        onCancel={() => {
          setRetireOpen(false);
          setRetireError(null);
        }}
      />

      {/* 갱신 확인 (사유는 선택 — ReasonDialog는 사유를 필수로 요구하므로 별도 구현) */}
      {updateOpen && (
        <UpdateDialog
          targetLabel={
            updateTargetVersion
              ? `${updateTargetVersion.version} (${updateTargetVersion.status})`
              : null
          }
          slug={deployment.slug}
          submitting={updating}
          error={updateError}
          checks={updateChecks}
          onConfirm={handleUpdate}
          onCancel={() => {
            setUpdateOpen(false);
            setUpdateError(null);
            setUpdateChecks(null);
          }}
        />
      )}

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

function UpdateDialog({
  targetLabel,
  slug,
  submitting,
  error,
  checks,
  onConfirm,
  onCancel,
}: {
  targetLabel: string | null;
  slug: string;
  submitting: boolean;
  error: string | null;
  checks: ValidationCheck[] | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="w-full max-w-md rounded-card bg-surface p-5 shadow-xl">
        <h3 className="text-card-title font-semibold text-text-primary">게시 갱신 확인</h3>
        {targetLabel ? (
          <p className="mt-1.5 text-body text-text-secondary">
            <strong className="text-text-primary">{targetLabel}</strong> 버전을 새 Revision으로
            게시합니다. 발급 URL(<code className="text-xs">/chat/{slug}</code>)은 그대로이며, 현재
            활성 Revision은 대체(SUPERSEDED)됩니다.
          </p>
        ) : (
          <p className="mt-1.5 text-body text-danger">갱신할 Service Version을 먼저 선택하세요.</p>
        )}
        <p className="mt-2 text-caption text-text-secondary">
          갱신 전 게시 Gate 검증을 다시 수행합니다. 실패하면 아무것도 바뀌지 않고 현재 Revision이
          계속 서비스됩니다.
        </p>

        <div className="mt-4">
          <label
            htmlFor="update-reason"
            className="mb-1 block text-xs font-medium text-text-secondary"
          >
            갱신 사유 (선택)
          </label>
          <textarea
            id="update-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="감사 로그에 함께 기록됩니다"
            rows={3}
            disabled={submitting}
            className={inputClass}
          />
        </div>

        {error && (
          <div className="mt-3">
            <ErrorBanner message={error} />
          </div>
        )}

        {checks && checks.length > 0 && (
          <div className="mt-3 space-y-2 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3">
            <p className="flex items-center gap-1.5 text-body font-semibold text-danger">
              <AlertTriangle size={14} />
              게시 Gate 검증 실패 항목 — 기존 Revision이 그대로 유지됩니다
            </p>
            <ul className="space-y-1 text-body text-danger">
              {checks.map((check) => (
                <li key={check.name} className="list-disc pl-4">
                  {check.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={submitting}>
            취소
          </Button>
          <Button onClick={() => onConfirm(reason)} disabled={submitting || !targetLabel}>
            {submitting && <Loader2 size={14} className="animate-spin" />}
            갱신
          </Button>
        </div>
      </div>
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
