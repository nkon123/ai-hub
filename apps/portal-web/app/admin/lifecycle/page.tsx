"use client";

/**
 * P16 수명주기/회수 (01-portal-and-distribution.md §2 P16).
 *
 * Actions per spec: 신규 다운로드 중단(기존 suspend 재사용), Deprecated +
 * 대체 버전 지정, Retired 처리, 긴급 Revocation. Every destructive action
 * requires a confirm dialog with a mandatory 사유 (CLAUDE.md UI 규칙) and
 * shows the 영향받는 Service·Bundle list (블라스트 반경) inside that dialog
 * before the operator can confirm. Incompatible actions render disabled with
 * their reason as a tooltip — same convention as `Tabs` in `_components/ui.tsx`.
 *
 * GET has no server-side status filter (mirrors `/deployments`'s own
 * documented rationale in `app/deployments/page.tsx`) — a single
 * generously-sized page is fetched and filtered client-side, acceptable at
 * this PoC's data scale.
 */

import { useEffect, useState } from "react";
import {
  Archive,
  ArrowRightLeft,
  Ban,
  History,
  Lock,
  Loader2,
  PauseCircle,
  ShieldAlert,
  ShieldOff,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  FormField,
  LoadingState,
  PageHeader,
  StatusBadge,
  inputClass,
} from "../../_components/ui";
import { formatDateTime } from "../../_components/deployment-meta";
import { ASSET_TYPE_LABEL } from "../../_components/review-meta";
import { canOperateLifecycle, canReadLifecycle, useRole } from "../../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";
const FETCH_PAGE_SIZE = 100;
const OPERATOR_ROLE_LABEL = "배포 관리자(RELEASE_MANAGER) 또는 관리자";

interface RevocationOut {
  id: string;
  version_id: string;
  reason: string;
  approver_id: string;
  effective_at: string;
  created_at: string;
  trace_id: string | null;
  effective: boolean;
}

interface LifecycleItem {
  id: string;
  asset_id: string;
  asset_name: string;
  asset_type: string;
  version: string;
  status: string;
  approved_at: string | null;
  deprecated_at: string | null;
  retired_at: string | null;
  replacement_version_id: string | null;
  replacement_version_label: string | null;
  active_revocation: RevocationOut | null;
}

interface ImpactService {
  service_id: string;
  service_name: string;
  service_version_id: string;
  version: string;
  status: string;
}
interface ImpactDeployment {
  deployment_id: string;
  slug: string;
  status: string;
}
interface ImpactDistribution {
  id: string;
  root_type: string;
  root_id: string;
  status: string;
}
interface ImpactSummary {
  version_id: string;
  services: ImpactService[];
  service_deployments: ImpactDeployment[];
  distribution_requests: ImpactDistribution[];
}

type LoadState = "loading" | "ok" | "forbidden" | "error";
type ActionType = "suspend" | "deprecate" | "retire" | "revoke" | "replacement";

interface DialogState {
  type: ActionType;
  row: LifecycleItem;
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function disabledReasonFor(action: ActionType, row: LifecycleItem, isOperator: boolean): string | null {
  if (!isOperator) return `${OPERATOR_ROLE_LABEL} 역할이 필요합니다.`;

  switch (action) {
    case "suspend":
      if (row.status !== "APPROVED") {
        return `현재 상태(${row.status})의 버전은 다운로드를 중단할 수 없습니다. APPROVED 상태만 중단할 수 있습니다.`;
      }
      return null;
    case "deprecate":
      if (row.status !== "APPROVED") {
        return `${row.status} 버전은 폐기할 수 없습니다. APPROVED 상태만 지원 종료(Deprecated) 처리할 수 있습니다.`;
      }
      return null;
    case "retire":
      if (row.status === "RETIRED") return "이미 Retired 상태입니다.";
      if (row.status !== "DEPRECATED") {
        return `${row.status} 버전은 Retired 처리할 수 없습니다. DEPRECATED 상태만 Retired 처리할 수 있습니다.`;
      }
      return null;
    case "replacement":
      if (row.status !== "DEPRECATED" && row.status !== "RETIRED") {
        return "지원 종료(DEPRECATED) 또는 폐기(RETIRED) 상태의 버전만 대체 버전을 지정할 수 있습니다.";
      }
      return null;
    case "revoke":
      if (!["APPROVED", "SUSPENDED", "DEPRECATED", "RETIRED"].includes(row.status)) {
        return "검토 중이거나 아직 배포되지 않은 버전은 긴급 회수 대상이 아닙니다.";
      }
      return null;
    default:
      return null;
  }
}

export default function LifecyclePage() {
  const { role } = useRole();
  const isOperator = canOperateLifecycle(role.code);

  const [items, setItems] = useState<LifecycleItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [reason, setReason] = useState("");
  const [approverId, setApproverId] = useState("");
  const [effectiveAt, setEffectiveAt] = useState("");
  const [replacementVersionId, setReplacementVersionId] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [impact, setImpact] = useState<ImpactSummary | null>(null);
  const [impactState, setImpactState] = useState<"idle" | "loading" | "ok" | "error">("idle");

  async function load() {
    setState("loading");
    setErrorMessage(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/asset-versions/lifecycle?page=1&page_size=${FETCH_PAGE_SIZE}`,
        { headers: { Authorization: `Bearer ${role.token}` } }
      );
      if (res.status === 403) {
        setState("forbidden");
        return;
      }
      if (!res.ok) {
        const body = await safeJson(res);
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setItems(data.items ?? []);
      setState("ok");
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role.token]);

  async function openDialog(type: ActionType, row: LifecycleItem) {
    setDialog({ type, row });
    setReason("");
    setApproverId("");
    setEffectiveAt("");
    setReplacementVersionId("");
    setTouched(false);
    setSubmitError(null);
    setImpact(null);

    if (canReadLifecycle(role.code)) {
      setImpactState("loading");
      try {
        const res = await fetch(`${API_BASE}/api/v1/asset-versions/${row.id}/impact`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (res.ok) {
          setImpact(await res.json());
          setImpactState("ok");
        } else {
          setImpactState("error");
        }
      } catch {
        setImpactState("error");
      }
    } else {
      setImpactState("idle");
    }
  }

  function closeDialog() {
    setDialog(null);
    setSubmitError(null);
  }

  const replacementCandidates = dialog
    ? items.filter(
        (i) => i.asset_id === dialog.row.asset_id && i.status === "APPROVED" && i.id !== dialog.row.id
      )
    : [];

  async function handleConfirm() {
    if (!dialog) return;
    setTouched(true);
    const trimmedReason = reason.trim();
    if (trimmedReason.length === 0) return;
    if (dialog.type === "revoke" && (!approverId.trim() || !effectiveAt)) return;
    if (dialog.type === "replacement" && !replacementVersionId) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      let res: Response;
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${role.token}`,
      };

      if (dialog.type === "suspend") {
        res = await fetch(`${API_BASE}/api/v1/asset-versions/${dialog.row.id}/suspend`, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason: trimmedReason }),
        });
      } else if (dialog.type === "deprecate") {
        res = await fetch(`${API_BASE}/api/v1/assets/${dialog.row.asset_id}/deprecate`, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason: trimmedReason }),
        });
        if (res.ok && replacementVersionId) {
          const deprecated = await res.json();
          await fetch(`${API_BASE}/api/v1/asset-versions/${deprecated.id}/replacement`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              replacement_version_id: replacementVersionId,
              reason: trimmedReason,
            }),
          });
        }
      } else if (dialog.type === "retire") {
        res = await fetch(`${API_BASE}/api/v1/asset-versions/${dialog.row.id}/retire`, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason: trimmedReason }),
        });
      } else if (dialog.type === "replacement") {
        res = await fetch(`${API_BASE}/api/v1/asset-versions/${dialog.row.id}/replacement`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            replacement_version_id: replacementVersionId,
            reason: trimmedReason,
          }),
        });
      } else {
        res = await fetch(`${API_BASE}/api/v1/asset-versions/${dialog.row.id}/revocations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            reason: trimmedReason,
            approver_id: approverId.trim(),
            effective_at: new Date(effectiveAt).toISOString(),
          }),
        });
      }

      if (!res.ok) {
        const body = await safeJson(res);
        setSubmitError(
          body?.error?.message ??
            (res.status === 403
              ? `${OPERATOR_ROLE_LABEL}만 수행할 수 있습니다.`
              : `처리에 실패했습니다. (HTTP ${res.status})`)
        );
        return;
      }

      closeDialog();
      await load();
    } catch {
      setSubmitError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setSubmitting(false);
    }
  }

  if (state === "loading") return <LoadingState label="수명주기 정보를 불러오는 중..." />;

  if (state === "forbidden") {
    return (
      <div>
        <PageHeader
          title="수명주기·회수"
          description="자산 버전의 중단·폐기·회수를 관리합니다."
        />
        <EmptyState
          icon={<ShieldAlert size={40} strokeWidth={1.5} />}
          title="이 역할에는 수명주기 화면 조회 권한이 없습니다."
          description={`현재 역할: ${role.label}. 배포 관리자, 감사자 또는 관리자로 전환해 보세요.`}
        />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div>
        <PageHeader title="수명주기·회수" />
        <ErrorBanner message={`수명주기 정보를 불러오지 못했습니다: ${errorMessage}`} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="수명주기·회수"
        description="자산 버전의 신규 다운로드 중단, 지원 종료(Deprecated), 폐기(Retired), 긴급 회수(Revocation)를 관리합니다."
      />

      {items.length === 0 && (
        <EmptyState icon={<History size={40} strokeWidth={1.5} />} title="등록된 자산 버전이 없습니다." />
      )}

      {items.length > 0 && (
        <div className="grid gap-3">
          {items.map((row) => {
            const suspendReason = disabledReasonFor("suspend", row, isOperator);
            const deprecateReason = disabledReasonFor("deprecate", row, isOperator);
            const retireReason = disabledReasonFor("retire", row, isOperator);
            const replacementReason = disabledReasonFor("replacement", row, isOperator);
            const revokeReason = disabledReasonFor("revoke", row, isOperator);

            return (
              <Card key={row.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-card-title font-semibold text-text-primary">
                        {row.asset_name}
                      </span>
                      <Badge tone="neutral">{ASSET_TYPE_LABEL[row.asset_type] ?? row.asset_type}</Badge>
                      <span className="text-caption text-text-muted">v{row.version}</span>
                      <StatusBadge status={row.status} />
                      {row.active_revocation && (
                        <Badge tone={row.active_revocation.effective ? "danger" : "warning"}>
                          {row.active_revocation.effective ? "회수됨" : "회수 예정"}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-secondary">
                      <span>승인: {formatDateTime(row.approved_at)}</span>
                      <span>지원종료: {formatDateTime(row.deprecated_at)}</span>
                      <span>폐기: {formatDateTime(row.retired_at)}</span>
                      {row.replacement_version_label && (
                        <span className="inline-flex items-center gap-1 text-brand-700">
                          <ArrowRightLeft size={12} />
                          대체 버전: v{row.replacement_version_label}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {row.active_revocation && (
                  <div
                    className={`mt-3 flex items-start gap-1.5 rounded-lg border px-3 py-2 text-caption ${
                      row.active_revocation.effective
                        ? "border-danger/30 bg-danger/5 text-danger"
                        : "border-warning/30 bg-warning/5 text-warning"
                    }`}
                  >
                    <ShieldOff size={13} className="mt-0.5 shrink-0" />
                    <span>
                      회수 사유: {row.active_revocation.reason} · 승인자:{" "}
                      {row.active_revocation.approver_id} · 효력 시각:{" "}
                      {formatDateTime(row.active_revocation.effective_at)}
                      {!row.active_revocation.effective && " (아직 효력 발생 전)"}
                    </span>
                  </div>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  <ActionButton
                    icon={<PauseCircle size={13} />}
                    label="다운로드 중단"
                    disabledReason={suspendReason}
                    onClick={() => openDialog("suspend", row)}
                  />
                  <ActionButton
                    icon={<Archive size={13} />}
                    label="Deprecated 처리"
                    disabledReason={deprecateReason}
                    onClick={() => openDialog("deprecate", row)}
                  />
                  <ActionButton
                    icon={<Ban size={13} />}
                    label="Retired 처리"
                    disabledReason={retireReason}
                    onClick={() => openDialog("retire", row)}
                  />
                  <ActionButton
                    icon={<ArrowRightLeft size={13} />}
                    label="대체 버전 지정"
                    disabledReason={replacementReason}
                    onClick={() => openDialog("replacement", row)}
                  />
                  <ActionButton
                    icon={<ShieldOff size={13} />}
                    label="긴급 회수"
                    variant="danger"
                    disabledReason={revokeReason}
                    onClick={() => openDialog("revoke", row)}
                  />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-8 overflow-y-auto">
          <div className="w-full max-w-lg rounded-card bg-surface p-5 shadow-xl">
            <h3 className="text-card-title font-semibold text-text-primary">
              {DIALOG_TITLE[dialog.type]}
            </h3>
            <p className="mt-1.5 text-body text-text-secondary">
              {dialog.row.asset_name} v{dialog.row.version} · {DIALOG_DESCRIPTION[dialog.type]}
            </p>

            {/* 영향받는 Service·Bundle — 확인 전 블라스트 반경 표시 */}
            {impactState === "loading" && (
              <div className="mt-3 flex items-center gap-2 text-caption text-text-muted">
                <Loader2 size={13} className="animate-spin" />
                영향받는 Service·Bundle을 확인하는 중...
              </div>
            )}
            {impactState === "error" && (
              <p className="mt-3 text-caption text-danger">
                영향받는 Service·Bundle을 확인하지 못했습니다. 신중히 진행하세요.
              </p>
            )}
            {impactState === "ok" && impact && (
              <div className="mt-3 rounded-lg border border-border bg-slate-50 p-3 text-caption">
                <p className="font-medium text-text-primary">영향받는 Service·Bundle</p>
                {impact.services.length === 0 &&
                impact.service_deployments.length === 0 &&
                impact.distribution_requests.length === 0 ? (
                  <p className="mt-1 text-text-secondary">참조하는 Service나 Bundle이 없습니다.</p>
                ) : (
                  <ul className="mt-1.5 space-y-1 text-text-secondary">
                    {impact.services.map((s) => (
                      <li key={s.service_version_id}>
                        서비스: {s.service_name} (v{s.version}, {s.status})
                      </li>
                    ))}
                    {impact.service_deployments.map((d) => (
                      <li key={d.deployment_id}>
                        게시: {d.slug} ({d.status})
                      </li>
                    ))}
                    {impact.distribution_requests.map((r) => (
                      <li key={r.id}>
                        Bundle 요청: {r.root_type} · {r.status}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {dialog.type === "replacement" || dialog.type === "deprecate" ? (
              <div className="mt-4">
                <FormField
                  label={dialog.type === "deprecate" ? "대체 버전 (선택)" : "대체 버전"}
                  required={dialog.type === "replacement"}
                  error={
                    touched && dialog.type === "replacement" && !replacementVersionId
                      ? "대체 버전을 선택하세요."
                      : undefined
                  }
                >
                  <select
                    value={replacementVersionId}
                    onChange={(e) => setReplacementVersionId(e.target.value)}
                    disabled={submitting}
                    className={inputClass}
                  >
                    <option value="">
                      {replacementCandidates.length === 0
                        ? "지정 가능한 승인된 버전이 없습니다"
                        : "선택 안 함"}
                    </option>
                    {replacementCandidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        v{c.version}
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>
            ) : null}

            {dialog.type === "revoke" && (
              <div className="mt-4 space-y-3">
                <FormField
                  label="승인자(approver_id)"
                  required
                  error={touched && !approverId.trim() ? "승인자를 입력하세요." : undefined}
                >
                  <input
                    value={approverId}
                    onChange={(e) => setApproverId(e.target.value)}
                    placeholder="예: release-manager@miracom.com"
                    disabled={submitting}
                    className={inputClass}
                  />
                </FormField>
                <FormField
                  label="효력 시각(effective_at)"
                  required
                  error={touched && !effectiveAt ? "효력 시각을 지정하세요." : undefined}
                >
                  <input
                    type="datetime-local"
                    value={effectiveAt}
                    onChange={(e) => setEffectiveAt(e.target.value)}
                    disabled={submitting}
                    className={inputClass}
                  />
                </FormField>
              </div>
            )}

            <div className="mt-4">
              <FormField
                label={DIALOG_REASON_LABEL[dialog.type]}
                required
                error={touched && reason.trim().length === 0 ? "사유를 입력하세요." : undefined}
              >
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  onBlur={() => setTouched(true)}
                  placeholder="사유를 입력하세요 (필수)"
                  rows={3}
                  disabled={submitting}
                  className={inputClass}
                />
              </FormField>
            </div>

            {submitError && (
              <div className="mt-3">
                <ErrorBanner message={submitError} />
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={closeDialog} disabled={submitting}>
                취소
              </Button>
              <Button
                variant={dialog.type === "revoke" ? "danger" : "primary"}
                onClick={handleConfirm}
                disabled={submitting}
              >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                {DIALOG_CONFIRM_LABEL[dialog.type]}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const DIALOG_TITLE: Record<ActionType, string> = {
  suspend: "신규 다운로드 중단 확인",
  deprecate: "Deprecated 처리 확인",
  retire: "Retired 처리 확인",
  replacement: "대체 버전 지정 확인",
  revoke: "긴급 회수(Revocation) 확인",
};

const DIALOG_DESCRIPTION: Record<ActionType, string> = {
  suspend: "중단하면 이 버전의 신규 다운로드/Bundle 생성이 즉시 차단됩니다. 이 작업은 감사 로그에 기록됩니다.",
  deprecate: "지원 종료로 표시합니다. 필요하면 대체 버전을 함께 지정할 수 있습니다.",
  retire: "폐기(Retired)는 최종 상태이며 되돌릴 수 없습니다.",
  replacement: "이 버전을 조회하는 사용자에게 안내할 후속 버전을 지정합니다.",
  revoke:
    "긴급 회수는 사유·승인자·효력 시각이 모두 필수입니다. 효력 시각이 지나면 신규 Bundle 생성과 기존 Bundle 다운로드가 즉시 차단됩니다.",
};

const DIALOG_REASON_LABEL: Record<ActionType, string> = {
  suspend: "중단 사유",
  deprecate: "지원 종료 사유",
  retire: "폐기 사유",
  replacement: "지정 사유",
  revoke: "회수 사유",
};

const DIALOG_CONFIRM_LABEL: Record<ActionType, string> = {
  suspend: "중단",
  deprecate: "Deprecated 처리",
  retire: "Retired 처리",
  replacement: "지정",
  revoke: "긴급 회수",
};

function ActionButton({
  icon,
  label,
  disabledReason,
  onClick,
  variant = "secondary",
}: {
  icon: React.ReactNode;
  label: string;
  disabledReason: string | null;
  onClick: () => void;
  variant?: "secondary" | "danger";
}) {
  const disabled = !!disabledReason;
  return (
    <Button
      variant={variant}
      size="sm"
      disabled={disabled}
      title={disabledReason ?? undefined}
      onClick={onClick}
    >
      {disabled ? <Lock size={12} /> : icon}
      {label}
    </Button>
  );
}
