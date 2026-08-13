"use client";

/**
 * P06 버전 관리 (01-portal-and-distribution.md §2 P06).
 *
 * 기능: 최신 승인 버전에서 새 초안 생성(SemVer 가이드 포함), Changelog 작성,
 * 자동검증 재실행, 이전 버전과 Manifest/Dependency/Permission Diff, 검토
 * 요청/취소, 승인 버전 수정 금지, Deprecated 버전의 대체 버전 표시.
 *
 * 이 화면은 Nav가 아니라 자산 상세(`/assets/[id]`)에서 진입한다 — CREATOR
 * 본인 소유 자산 범위로 제한되고(ADMIN은 전체), 서버가 소유자 검사를
 * 수행한다(portal_api.routers.assets._require_asset_owner). 여기서는 UX
 * 편의를 위한 클라이언트측 미러만 사용하고, 실제 권한은 서버 403으로
 * 최종 확인된다.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Download,
  GitCompare,
  Loader2,
  Lock,
  PackageOpen,
  PlusCircle,
  Send,
  ShieldQuestion,
  XCircle,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  FormField,
  LoadingState,
  PageHeader,
  ReasonDialog,
  StatusBadge,
  inputClass,
} from "../../../_components/ui";
import { formatDateTime } from "../../../_components/review-meta";
import { canCreateDistribution, useRole } from "../../../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

interface VersionOut {
  id: string;
  asset_id: string;
  version: string;
  status: string;
  manifest: Record<string, any>;
  created_at: string;
  updated_at: string;
  validation_status: "NOT_RUN" | "PASSED" | "FAILED";
  validation_errors: string[] | null;
  validated_at: string | null;
  approved_at: string | null;
  deprecated_at: string | null;
  retired_at: string | null;
  replacement_version_id: string | null;
  pending_review_id: string | null;
}

interface AssetDetail {
  id: string;
  type: string;
  name: string;
  owner_org: string;
  owner_creator_id: string;
  classification: string;
  created_at: string;
  updated_at: string;
  versions: VersionOut[];
}

// D-079 Feature 2: 반출 준비 상태 점검. 필드는
// packages/schemas/api/portal-openapi.yaml의 DistributionReadinessResponse와
// 정확히 일치한다.
interface DistributionReadinessCheck {
  id: string;
  status: "PASS" | "WARN" | "FAIL";
  message: string;
  remedy: string | null;
  activation_reason: string | null;
}

interface DistributionReadinessResult {
  version_id: string;
  ready: boolean;
  checks: DistributionReadinessCheck[];
  trace_id: string;
}

interface DiffEntryAdded {
  key: string;
  value: unknown;
}
interface DiffEntryRemoved {
  key: string;
  value: unknown;
}
interface DiffEntryChanged {
  key: string;
  from: unknown;
  to: unknown;
}
interface DiffSection {
  added: DiffEntryAdded[];
  removed: DiffEntryRemoved[];
  changed: DiffEntryChanged[];
}
interface VersionDiff {
  version_id: string;
  against_version_id: string;
  version: string;
  against_version: string;
  manifest: DiffSection;
  dependency: DiffSection;
  permission: DiffSection;
}

const MUTABLE_STATUSES = new Set(["DRAFT", "CHANGES_REQUESTED"]);
const SUBMITTABLE_STATUSES = new Set(["DRAFT", "CHANGES_REQUESTED"]);
const CANCELLABLE_STATUSES = new Set(["IN_REVIEW", "READY_FOR_REVIEW"]);

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const READINESS_STATUS_ICON: Record<
  DistributionReadinessCheck["status"],
  { icon: typeof CheckCircle2; className: string }
> = {
  PASS: { icon: CheckCircle2, className: "text-success" },
  WARN: { icon: AlertTriangle, className: "text-warning" },
  FAIL: { icon: XCircle, className: "text-danger" },
};

/**
 * D-079 Feature 2 — 반출 준비 상태 점검. 이 버전의 ZIP을 만들기 *전에*,
 * Desktop 설치 후 실제로 검색 가능(활성화)해질지 예측해 보여준다. 기존
 * 반출 흐름(AssetBundleDownloadAction)을 절대 막지 않는다 — FAIL이 있어도
 * 경고만 하고 사용자가 그대로 진행할 수 있게 둔다(브리프 요구사항).
 */
function DistributionReadinessPanel({
  assetId,
  versionId,
}: {
  assetId: string;
  versionId: string;
}) {
  const { role } = useRole();
  const [result, setResult] = useState<DistributionReadinessResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `${API_BASE}/api/v1/assets/${assetId}/versions/${versionId}/distribution-readiness`,
          { headers: { Authorization: `Bearer ${role.token}` } }
        );
        const body = await safeJson(res);
        if (cancelled) return;
        if (!res.ok) {
          setError(body?.error?.message ?? `반출 준비 상태를 확인하지 못했습니다. (HTTP ${res.status})`);
          return;
        }
        setResult(body);
      } catch {
        if (!cancelled) setError("서버에 연결할 수 없습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [assetId, versionId, role.token]);

  if (loading) {
    return <p className="text-caption text-text-muted">반출 준비 상태를 확인하는 중...</p>;
  }
  if (error) {
    return <ErrorBanner message={error} />;
  }
  if (!result) return null;

  return (
    <div className="space-y-2">
      <div
        className={`rounded-lg border px-3 py-2 text-caption ${
          result.ready
            ? "border-success/30 bg-success/5 text-success"
            : "border-danger/30 bg-danger/5 text-danger"
        }`}
      >
        {result.ready
          ? "이 버전은 Desktop에서 정상적으로 활성화될 것으로 예상됩니다."
          : "이 상태로 반출하면 Desktop에서 활성화되지 않습니다 — 아래 실패 항목을 확인하세요. (반출 자체는 계속 진행할 수 있습니다.)"}
      </div>
      <ul className="space-y-1.5">
        {result.checks.map((check) => {
          const { icon: Icon, className } = READINESS_STATUS_ICON[check.status];
          return (
            <li key={check.id} className="flex items-start gap-2 text-caption">
              <Icon size={14} className={`mt-0.5 shrink-0 ${className}`} />
              <div>
                <span className={className}>{check.message}</span>
                {check.remedy && (
                  <div className="mt-0.5 text-text-muted">
                    조치: <code className="rounded bg-slate-100 px-1">{check.remedy}</code>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type BundleDownloadState =
  | { status: "idle" }
  | { status: "running"; message: string }
  | { status: "success"; message: string }
  | { status: "cancelled"; message: string }
  | { status: "error"; message: string };

function AssetBundleDownloadAction({
  assetName,
  version,
}: {
  assetName: string;
  version: VersionOut;
}) {
  const { role } = useRole();
  const controllerRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<BundleDownloadState>({ status: "idle" });
  const allowed = canCreateDistribution(role.code);
  const approved = version.status === "APPROVED";
  const canDownload = approved && allowed && state.status !== "running";
  const disabledReason = !approved
    ? `승인된 버전만 ZIP으로 받을 수 있습니다 (현재: ${version.status}).`
    : !allowed
      ? "자산 제작자 또는 관리자만 ZIP을 생성할 수 있습니다."
      : null;

  useEffect(() => () => controllerRef.current?.abort(), []);

  async function downloadBundle() {
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ status: "running", message: "설치 ZIP을 준비하고 있습니다..." });
    try {
      const createRes = await fetch(`${API_BASE}/api/v1/distributions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({
          root_type: "ASSET_VERSION",
          root_id: version.id,
          mode: "OFFLINE_BUNDLE",
        }),
        signal: controller.signal,
      });
      const created = await safeJson(createRes);
      if (!createRes.ok) {
        throw new Error(created?.error?.message ?? `ZIP 생성 요청에 실패했습니다. (HTTP ${createRes.status})`);
      }

      let completed = false;
      for (let attempt = 0; attempt < 600; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const statusRes = await fetch(`${API_BASE}/api/v1/distributions/${created.id}`, {
          headers: { Authorization: `Bearer ${role.token}` },
          signal: controller.signal,
        });
        const detail = await safeJson(statusRes);
        if (!statusRes.ok) {
          throw new Error(detail?.error?.message ?? `ZIP 상태를 확인하지 못했습니다. (HTTP ${statusRes.status})`);
        }
        if (detail.status === "FAILED" || detail.status === "CANCELLED") {
          throw new Error(detail.error_message ?? "설치 ZIP을 만들지 못했습니다.");
        }
        if (detail.status === "SUCCEEDED") {
          completed = true;
          break;
        }
        setState({
          status: "running",
          message: detail.stage ? `설치 ZIP 준비 중 · ${detail.stage}` : "설치 ZIP을 준비하고 있습니다...",
        });
      }
      if (!completed) throw new Error("ZIP 생성 시간이 초과되었습니다. 반출 요청 화면에서 작업 상태를 확인하세요.");

      setState({ status: "running", message: "ZIP을 내려받고 있습니다..." });
      const downloadRes = await fetch(`${API_BASE}/api/v1/distributions/${created.id}/download`, {
        headers: { Authorization: `Bearer ${role.token}` },
        signal: controller.signal,
      });
      if (!downloadRes.ok) {
        const body = await safeJson(downloadRes);
        throw new Error(body?.error?.message ?? `ZIP 다운로드에 실패했습니다. (HTTP ${downloadRes.status})`);
      }
      const blob = await downloadRes.blob();
      const disposition = downloadRes.headers.get("Content-Disposition") ?? "";
      const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? `${assetName}-${version.version}.zip`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      setState({ status: "success", message: "ZIP 다운로드를 시작했습니다. Desktop의 ‘ZIP 가져오기’에서 선택하세요." });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        setState({ status: "cancelled", message: "화면 대기를 중단했습니다. 서버의 ZIP 생성 작업은 계속될 수 있습니다." });
      } else {
        setState({ status: "error", message: error instanceof Error ? error.message : "ZIP 다운로드에 실패했습니다." });
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={canDownload ? "primary" : "secondary"}
          disabled={!canDownload}
          title={disabledReason ?? undefined}
          onClick={() => void downloadBundle()}
        >
          {state.status === "running" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {state.status === "running" ? "ZIP 준비 중" : "Desktop 설치 ZIP 받기"}
        </Button>
        {state.status === "running" && (
          <Button variant="secondary" size="sm" onClick={() => controllerRef.current?.abort()}>
            화면 대기 중단
          </Button>
        )}
      </div>
      {disabledReason && <p className="text-caption text-text-secondary">{disabledReason}</p>}
      {state.status === "running" && <p className="text-caption text-brand-700">{state.message}</p>}
      {state.status === "success" && <p className="text-caption text-success">{state.message}</p>}
      {state.status === "cancelled" && <p className="text-caption text-warning">{state.message}</p>}
      {state.status === "error" && <ErrorBanner message={state.message} />}
    </div>
  );
}

function bumpPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return version;
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "(없음)";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-surface shadow-card">
      <div className="border-b border-border px-5 py-3">
        <h2 className="text-card-title font-semibold text-text-primary">{title}</h2>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

export default function AssetVersionsPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const assetId = params.id as string;
  const { role } = useRole();

  const [info, setInfo] = useState<AssetDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [changelogDraft, setChangelogDraft] = useState("");
  const [savingChangelog, setSavingChangelog] = useState(false);
  const [changelogError, setChangelogError] = useState<string | null>(null);

  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const [showNewVersionForm, setShowNewVersionForm] = useState(false);
  const [newVersionStr, setNewVersionStr] = useState("");
  const [newVersionChangelog, setNewVersionChangelog] = useState("");
  const [creatingVersion, setCreatingVersion] = useState(false);
  const [createVersionError, setCreateVersionError] = useState<string | null>(null);

  const [diffAgainstId, setDiffAgainstId] = useState("");
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  async function fetchInfo(preserveSelection = true) {
    try {
      const res = await fetch(`${API_BASE}/api/v1/assets/${assetId}`, {
        headers: { Authorization: `Bearer ${role.token}` },
      });
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) {
        const body = await safeJson(res);
        setError(body?.error?.message ?? `오류 ${res.status}`);
        return;
      }
      const data: AssetDetail = await res.json();
      setInfo(data);
      setForbidden(false);
      setError(null);
      if (!preserveSelection || !data.versions.some((v) => v.id === selectedId)) {
        const requested = searchParams.get("versionId");
        const initial =
          (requested && data.versions.find((v) => v.id === requested)?.id) ??
          data.versions[0]?.id ??
          null;
        setSelectedId(initial);
      }
    } catch {
      setError("서버에 연결할 수 없습니다.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchInfo(false);
    if (searchParams.get("action") === "new") setShowNewVersionForm(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, role.token]);

  const selected = info?.versions.find((v) => v.id === selectedId) ?? null;

  useEffect(() => {
    setChangelogDraft(selected?.manifest?.changelog ?? "");
    setChangelogError(null);
    setValidateError(null);
    setSubmitError(null);
    setCancelError(null);
    setDiff(null);
    setDiffError(null);
    setDiffAgainstId("");
  }, [selectedId]);

  const isOwnerOrAdmin =
    role.code === "ADMIN" || (role.code === "CREATOR" && role.userId === info?.owner_creator_id);

  const latestApproved = useMemo(() => {
    if (!info) return null;
    const approved = info.versions.filter((v) => v.status === "APPROVED");
    if (approved.length === 0) return null;
    return approved.reduce((a, b) => (a.updated_at > b.updated_at ? a : b));
  }, [info]);

  function replacementLabel(replacementId: string | null): string | null {
    if (!replacementId || !info) return null;
    return info.versions.find((v) => v.id === replacementId)?.version ?? replacementId;
  }

  async function handleSaveChangelog() {
    if (!selected) return;
    setSavingChangelog(true);
    setChangelogError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/assets/${assetId}/versions/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({ changelog: changelogDraft }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setChangelogError(body?.error?.message ?? `저장에 실패했습니다. (HTTP ${res.status})`);
        return;
      }
      await fetchInfo();
    } catch {
      setChangelogError("서버에 연결할 수 없습니다.");
    } finally {
      setSavingChangelog(false);
    }
  }

  async function handleValidate() {
    if (!selected) return;
    setValidating(true);
    setValidateError(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/assets/${assetId}/versions/${selected.id}/validate`,
        { method: "POST", headers: { Authorization: `Bearer ${role.token}` } }
      );
      const body = await safeJson(res);
      if (!res.ok) {
        setValidateError(body?.error?.message ?? `자동검증에 실패했습니다. (HTTP ${res.status})`);
        return;
      }
      await fetchInfo();
    } catch {
      setValidateError("서버에 연결할 수 없습니다.");
    } finally {
      setValidating(false);
    }
  }

  async function handleSubmitReview() {
    if (!selected) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/asset-versions/${selected.id}/submit`, {
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
      setSubmitError("서버에 연결할 수 없습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancelReview(reason: string) {
    if (!selected?.pending_review_id) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/reviews/${selected.pending_review_id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({ reason }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setCancelError(body?.error?.message ?? `취소에 실패했습니다. (HTTP ${res.status})`);
        return;
      }
      setCancelOpen(false);
      await fetchInfo();
    } catch {
      setCancelError("서버에 연결할 수 없습니다.");
    } finally {
      setCancelling(false);
    }
  }

  async function handleCreateVersion() {
    setCreatingVersion(true);
    setCreateVersionError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/assets/${assetId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({
          version: newVersionStr.trim(),
          changelog: newVersionChangelog.trim() || undefined,
        }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setCreateVersionError(body?.error?.message ?? `새 버전 생성에 실패했습니다. (HTTP ${res.status})`);
        return;
      }
      setShowNewVersionForm(false);
      setNewVersionStr("");
      setNewVersionChangelog("");
      setSelectedId(body.id);
      await fetchInfo();
    } catch {
      setCreateVersionError("서버에 연결할 수 없습니다.");
    } finally {
      setCreatingVersion(false);
    }
  }

  async function handleRunDiff() {
    if (!selected || !diffAgainstId) return;
    setDiffLoading(true);
    setDiffError(null);
    setDiff(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/assets/${assetId}/versions/${selected.id}/diff?against=${diffAgainstId}`,
        { headers: { Authorization: `Bearer ${role.token}` } }
      );
      const body = await safeJson(res);
      if (!res.ok) {
        setDiffError(body?.error?.message ?? `Diff 조회에 실패했습니다. (HTTP ${res.status})`);
        return;
      }
      setDiff(body);
    } catch {
      setDiffError("서버에 연결할 수 없습니다.");
    } finally {
      setDiffLoading(false);
    }
  }

  if (loading) return <LoadingState label="버전 정보를 불러오는 중..." />;

  if (forbidden) {
    return (
      <div>
        <PageHeader title="버전 관리" />
        <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-border bg-surface px-6 py-16 text-center">
          <ShieldQuestion size={40} strokeWidth={1.5} className="mb-1 text-slate-300" />
          <p className="text-card-title font-medium text-text-primary">
            이 자산의 버전을 관리할 권한이 없습니다.
          </p>
          <p className="text-body text-text-secondary">
            본인이 소유한 자산만 버전을 관리할 수 있습니다. 현재 역할: {role.label}
          </p>
          <Button variant="secondary" className="mt-3" onClick={() => router.push(`/assets/${assetId}`)}>
            자산 상세로
          </Button>
        </div>
      </div>
    );
  }

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

  const otherVersions = info.versions.filter((v) => v.id !== selectedId);
  const canEdit = !!selected && isOwnerOrAdmin && MUTABLE_STATUSES.has(selected.status);
  const editDisabledReason = !isOwnerOrAdmin
    ? "본인이 소유한 자산만 수정할 수 있습니다."
    : selected && !MUTABLE_STATUSES.has(selected.status)
    ? `현재 상태(${selected.status})의 버전은 수정할 수 없습니다.`
    : null;

  const canSubmit = !!selected && isOwnerOrAdmin && SUBMITTABLE_STATUSES.has(selected.status);
  const submitDisabledReason = !isOwnerOrAdmin
    ? "본인이 소유한 자산만 검토를 요청할 수 있습니다."
    : selected && !SUBMITTABLE_STATUSES.has(selected.status)
    ? `현재 상태(${selected.status})의 버전은 검토를 요청할 수 없습니다.`
    : null;

  const canCancel =
    !!selected &&
    isOwnerOrAdmin &&
    CANCELLABLE_STATUSES.has(selected.status) &&
    !!selected.pending_review_id;
  const cancelDisabledReason = !isOwnerOrAdmin
    ? "본인이 요청한 검토만 취소할 수 있습니다."
    : selected && !CANCELLABLE_STATUSES.has(selected.status)
    ? "검토 대기/진행 중인 버전만 취소할 수 있습니다."
    : selected && !selected.pending_review_id
    ? "취소할 대기 중인 검토 요청이 없습니다."
    : null;

  const canCreateNewVersion = isOwnerOrAdmin && !!latestApproved;
  const newVersionDisabledReason = !isOwnerOrAdmin
    ? "본인이 소유한 자산만 새 버전을 만들 수 있습니다."
    : !latestApproved
    ? "승인된 버전이 없어 새 버전을 만들 수 없습니다."
    : null;

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
          title={`버전 관리 — ${info.name}`}
          description="새 버전 생성, Changelog 작성, 자동검증, 이전 버전과의 비교, 검토 요청/취소를 관리합니다."
          actions={
            <Button
              size="sm"
              disabled={!canCreateNewVersion}
              title={newVersionDisabledReason ?? undefined}
              onClick={() => setShowNewVersionForm((v) => !v)}
            >
              {!canCreateNewVersion && <Lock size={14} />}
              <PlusCircle size={14} />
              새 버전 만들기
            </Button>
          }
        />
      </div>

      {showNewVersionForm && (
        <Section title="새 버전 만들기">
          <div className="space-y-3">
            <p className="text-caption text-text-secondary">
              {latestApproved ? (
                <>
                  현재 최신 승인 버전은 <strong>v{latestApproved.version}</strong>입니다. 새 버전은
                  이보다 큰 SemVer(major.minor.patch)여야 합니다 — 예:{" "}
                  <code className="rounded bg-slate-100 px-1">
                    {bumpPatch(latestApproved.version)}
                  </code>
                  .
                </>
              ) : (
                "승인된 버전이 없어 새 버전을 만들 수 없습니다."
              )}
            </p>
            <FormField label="새 버전 (SemVer)" required>
              <input
                value={newVersionStr}
                onChange={(e) => setNewVersionStr(e.target.value)}
                placeholder={latestApproved ? bumpPatch(latestApproved.version) : "1.0.0"}
                disabled={!canCreateNewVersion || creatingVersion}
                className={inputClass}
              />
            </FormField>
            <FormField label="Changelog (선택)">
              <textarea
                value={newVersionChangelog}
                onChange={(e) => setNewVersionChangelog(e.target.value)}
                rows={2}
                disabled={!canCreateNewVersion || creatingVersion}
                className={inputClass}
              />
            </FormField>
            {createVersionError && <ErrorBanner message={createVersionError} />}
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowNewVersionForm(false)}
                disabled={creatingVersion}
              >
                취소
              </Button>
              <Button
                size="sm"
                disabled={!canCreateNewVersion || !newVersionStr.trim() || creatingVersion}
                onClick={handleCreateVersion}
              >
                {creatingVersion && <Loader2 size={14} className="animate-spin" />}
                만들기
              </Button>
            </div>
          </div>
        </Section>
      )}

      <Section title="버전 히스토리">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {info.versions.map((ver) => (
            <button
              key={ver.id}
              onClick={() => setSelectedId(ver.id)}
              className={`shrink-0 rounded-lg border px-4 py-3 text-left text-body transition ${
                ver.id === selectedId
                  ? "border-brand-500 bg-brand-50"
                  : "border-border bg-surface hover:border-brand-300"
              }`}
            >
              <div className="font-semibold text-text-primary">v{ver.version}</div>
              <div className="mt-0.5 flex gap-1">
                <StatusBadge status={ver.status} />
                {ver.validation_status === "FAILED" && <Badge tone="danger">검증 실패</Badge>}
              </div>
              <div className="mt-1 text-caption text-text-muted">
                {new Date(ver.created_at).toLocaleDateString("ko-KR")}
              </div>
            </button>
          ))}
        </div>
      </Section>

      {selected && (
        <>
          <Section title="버전 상태 및 검토">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-body text-text-secondary">현재 상태</span>
                <StatusBadge status={selected.status} />
                {selected.approved_at && (
                  <span className="text-caption text-text-muted">
                    승인: {formatDateTime(selected.approved_at)}
                  </span>
                )}
                {selected.deprecated_at && (
                  <span className="text-caption text-text-muted">
                    지원종료: {formatDateTime(selected.deprecated_at)}
                  </span>
                )}
              </div>

              {selected.status === "DEPRECATED" && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-caption text-warning">
                  {selected.replacement_version_id ? (
                    <>대체 버전: v{replacementLabel(selected.replacement_version_id)}</>
                  ) : (
                    "지정된 대체 버전이 없습니다."
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={!canSubmit || submitting}
                  title={submitDisabledReason ?? undefined}
                  onClick={handleSubmitReview}
                >
                  {submitting ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : !canSubmit ? (
                    <Lock size={14} />
                  ) : (
                    <Send size={14} />
                  )}
                  검토 요청
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={!canCancel}
                  title={cancelDisabledReason ?? undefined}
                  onClick={() => setCancelOpen(true)}
                >
                  {!canCancel && <Lock size={14} />}
                  <XCircle size={14} />
                  검토 요청 취소
                </Button>
              </div>

              <div className="border-t border-border pt-3">
                <div className="mb-2 flex items-center gap-2 text-body font-semibold text-text-primary">
                  <PackageOpen size={15} /> Desktop으로 가져가기
                </div>
                <div className="mb-3">
                  <DistributionReadinessPanel assetId={assetId} versionId={selected.id} />
                </div>
                <AssetBundleDownloadAction assetName={info.name} version={selected} />
              </div>

              {(submitDisabledReason || cancelDisabledReason) && (
                <div className="flex flex-col gap-1 text-caption text-text-secondary">
                  {submitDisabledReason && (
                    <span className="inline-flex items-center gap-1">
                      <Lock size={12} />
                      검토 요청 불가: {submitDisabledReason}
                    </span>
                  )}
                </div>
              )}
              {submitError && <ErrorBanner message={submitError} />}
            </div>
          </Section>

          <ReasonDialog
            open={cancelOpen}
            title="검토 요청 취소 확인"
            description="취소하면 이 버전은 다시 편집 가능한 상태(수정 요청)로 돌아갑니다. 이 작업은 감사 로그에 기록됩니다."
            confirmLabel="검토 요청 취소"
            confirmVariant="danger"
            reasonLabel="취소 사유"
            reasonPlaceholder="취소 사유를 입력하세요 (필수)"
            submitting={cancelling}
            error={cancelError}
            onConfirm={handleCancelReview}
            onCancel={() => {
              setCancelOpen(false);
              setCancelError(null);
            }}
          />

          <Section title="Changelog">
            <div className="space-y-3">
              <textarea
                value={changelogDraft}
                onChange={(e) => setChangelogDraft(e.target.value)}
                rows={3}
                disabled={!canEdit || savingChangelog}
                placeholder={canEdit ? "이 버전의 변경 내용을 입력하세요" : "수정할 수 없는 버전입니다"}
                className={inputClass}
              />
              {!canEdit && editDisabledReason && (
                <p className="flex items-center gap-1.5 text-caption text-text-secondary">
                  <Lock size={12} />
                  {editDisabledReason}
                </p>
              )}
              {changelogError && <ErrorBanner message={changelogError} />}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={!canEdit || savingChangelog}
                  onClick={handleSaveChangelog}
                >
                  {savingChangelog && <Loader2 size={14} className="animate-spin" />}
                  저장
                </Button>
              </div>
            </div>
          </Section>

          <Section title="자동검증">
            <div className="space-y-3">
              {selected.validation_status === "NOT_RUN" && (
                <p className="text-body text-text-muted">아직 자동검증을 실행하지 않았습니다.</p>
              )}
              {selected.validation_status === "PASSED" && (
                <div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-body text-success">
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
                  <span>
                    통과했습니다.
                    {selected.validated_at && (
                      <span className="block text-caption text-text-secondary">
                        검증 시각: {formatDateTime(selected.validated_at)}
                      </span>
                    )}
                  </span>
                </div>
              )}
              {selected.validation_status === "FAILED" && (
                <div>
                  <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-body text-danger">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                    <span>
                      검증에 실패했습니다.
                      {selected.validated_at && (
                        <span className="block text-caption text-text-secondary">
                          검증 시각: {formatDateTime(selected.validated_at)}
                        </span>
                      )}
                    </span>
                  </div>
                  {selected.validation_errors && (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-caption text-text-secondary">
                      {selected.validation_errors.map((err, idx) => (
                        <li key={idx}>{err}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {validateError && <ErrorBanner message={validateError} />}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canEdit || validating}
                  title={editDisabledReason ?? undefined}
                  onClick={handleValidate}
                >
                  {validating && <Loader2 size={14} className="animate-spin" />}
                  자동검증 재실행
                </Button>
              </div>
            </div>
          </Section>

          <Section title="이전 버전과 비교 (Manifest / Dependency / Permission)">
            <div className="space-y-4">
              {otherVersions.length === 0 ? (
                <p className="text-body text-text-muted">비교할 다른 버전이 없습니다.</p>
              ) : (
                <div className="flex flex-wrap items-end gap-2">
                  <FormField label="비교 대상 버전">
                    <select
                      value={diffAgainstId}
                      onChange={(e) => setDiffAgainstId(e.target.value)}
                      className={inputClass}
                    >
                      <option value="">선택하세요</option>
                      {otherVersions.map((v) => (
                        <option key={v.id} value={v.id}>
                          v{v.version} ({v.status})
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!diffAgainstId || diffLoading}
                    onClick={handleRunDiff}
                  >
                    {diffLoading ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <GitCompare size={14} />
                    )}
                    비교
                  </Button>
                </div>
              )}

              {diffError && <ErrorBanner message={diffError} />}

              {diff && (
                <div className="grid gap-4 sm:grid-cols-3">
                  <DiffSectionCard title="일반 항목 (Manifest)" section={diff.manifest} />
                  <DiffSectionCard title="의존성 (Dependency)" section={diff.dependency} />
                  <DiffSectionCard title="권한 (Permission)" section={diff.permission} />
                </div>
              )}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function DiffSectionCard({ title, section }: { title: string; section: DiffSection }) {
  const isEmpty =
    section.added.length === 0 && section.removed.length === 0 && section.changed.length === 0;
  return (
    <div className="rounded-lg border border-border bg-slate-50 p-3">
      <p className="mb-2 text-caption font-semibold text-text-primary">{title}</p>
      {isEmpty ? (
        <p className="text-caption text-text-muted">변경 없음</p>
      ) : (
        <div className="space-y-2 text-caption">
          {section.added.map((entry) => (
            <div key={`added-${entry.key}`} className="rounded border border-success/30 bg-success/5 px-2 py-1">
              <span className="font-medium text-success">+ {entry.key}</span>
              <div className="mt-0.5 break-all text-text-secondary">{renderValue(entry.value)}</div>
            </div>
          ))}
          {section.removed.map((entry) => (
            <div key={`removed-${entry.key}`} className="rounded border border-danger/30 bg-danger/5 px-2 py-1">
              <span className="font-medium text-danger">− {entry.key}</span>
              <div className="mt-0.5 break-all text-text-secondary">{renderValue(entry.value)}</div>
            </div>
          ))}
          {section.changed.map((entry) => (
            <div key={`changed-${entry.key}`} className="rounded border border-warning/30 bg-warning/5 px-2 py-1">
              <span className="font-medium text-warning">~ {entry.key}</span>
              <div className="mt-0.5 break-all text-text-secondary">
                {renderValue(entry.from)} → {renderValue(entry.to)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
