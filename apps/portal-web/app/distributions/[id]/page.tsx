"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Download,
  Loader2,
  Lock,
  RotateCcw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import {
  Badge,
  Button,
  ErrorBanner,
  LoadingState,
  StatusBadge,
} from "../../_components/ui";
import {
  BUNDLE_STAGES,
  DISTRIBUTION_MODE_LABEL,
  ROOT_TYPE_LABEL,
  SIGNING_OMITTED_REASON,
  STAGE_LABEL,
  formatBytes,
  formatDateTime,
} from "../../_components/distribution-meta";
import { useRole } from "../../_components/role-context";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";
const POLL_INTERVAL_MS = 1500;
const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

interface IncludedAsset {
  asset_id: string | null;
  asset_type: string;
  role: string;
  name: string | null;
  version: string | null;
  required: boolean;
  status: string;
  size_bytes: number;
}

interface ManifestSummary {
  bundle_id: string;
  included: IncludedAsset[];
  install_order: string[];
  total_size_bytes: number;
  file_count: number;
}

interface DistributionDetail {
  id: string;
  root_type: string;
  root_id: string;
  mode: string;
  target_site_id: string | null;
  office_profile_version_id: string | null;
  requested_by: string;
  status: string;
  stage: string | null;
  error_code: string | null;
  error_message: string | null;
  affected_assets: string[] | null;
  retryable: boolean | null;
  bundle_object_id: string | null;
  bundle_size_bytes: number | null;
  bundle_checksum: string | null;
  manifest_summary: ManifestSummary | null;
  trace_id: string | null;
  created_at: string;
  updated_at: string;
}

type LoadState = "loading" | "ok" | "not_found" | "forbidden" | "error";

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Progress track across the stages the backend actually implements. SIGNING
 * (D-016) is intentionally never in this list — it is called out separately
 * below the track, not rendered as a step that would stay pending forever. */
function StageProgress({ status, stage }: { status: string; stage: string | null }) {
  const currentIndex = stage ? BUNDLE_STAGES.indexOf(stage as (typeof BUNDLE_STAGES)[number]) : -1;
  const failed = status === "FAILED";

  return (
    <div>
      <div className="flex items-center">
        {BUNDLE_STAGES.map((s, idx) => {
          const isDone = !failed && (status === "SUCCEEDED" || idx < currentIndex || (idx === currentIndex && status !== "RUNNING"));
          const isFailedHere = failed && idx === currentIndex;
          const isActive = !failed && idx === currentIndex && status === "RUNNING";
          const isPending = !isDone && !isFailedHere && !isActive;

          return (
            <div key={s} className="flex flex-1 items-center last:flex-none">
              <div className="flex flex-col items-center gap-1.5">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-semibold ${
                    isFailedHere
                      ? "border-danger bg-danger/10 text-danger"
                      : isDone
                      ? "border-success bg-success text-white"
                      : isActive
                      ? "border-brand-500 bg-brand-50 text-brand-600"
                      : "border-border bg-surface text-text-muted"
                  }`}
                >
                  {isFailedHere ? (
                    <XCircle size={16} />
                  ) : isDone ? (
                    <Check size={16} />
                  ) : isActive ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    idx + 1
                  )}
                </div>
                <span
                  className={`whitespace-nowrap text-caption ${
                    isFailedHere ? "text-danger" : isPending ? "text-text-muted" : "text-text-primary"
                  }`}
                >
                  {STAGE_LABEL[s]}
                </span>
              </div>
              {idx < BUNDLE_STAGES.length - 1 && (
                <div
                  className={`mx-1.5 h-0.5 flex-1 ${
                    isDone && !isFailedHere ? "bg-success" : "bg-border"
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>
      {(status === "QUEUED" || (status === "RUNNING" && currentIndex < 0)) && (
        <p className="mt-3 flex items-center gap-1.5 text-caption text-text-secondary">
          <Loader2 size={12} className="animate-spin" />
          {status === "QUEUED" ? "대기열에서 처리를 기다리는 중입니다..." : "진행 중입니다..."}
        </p>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-caption text-text-muted">
        <Lock size={12} className="mt-0.5 shrink-0" />
        {SIGNING_OMITTED_REASON}
      </p>
    </div>
  );
}

export default function DistributionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const distributionId = params.id as string;
  const { role } = useRole();

  const [distribution, setDistribution] = useState<DistributionDetail | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchDetail = useCallback(
    async (isPoll: boolean) => {
      if (!isPoll) setState("loading");
      try {
        const res = await fetch(`${API_BASE}/api/v1/distributions/${distributionId}`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (res.status === 404) {
          setState("not_found");
          return;
        }
        if (res.status === 403) {
          setState("forbidden");
          return;
        }
        if (!res.ok) {
          const body = await safeJson(res);
          throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        }
        const data: DistributionDetail = await res.json();
        setDistribution(data);
        setState("ok");
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : String(e));
        setState("error");
      }
    },
    [distributionId, role.token]
  );

  useEffect(() => {
    fetchDetail(false);
  }, [fetchDetail]);

  // Poll while the job is still in progress; stop as soon as it reaches a
  // terminal state, and always clear the interval on unmount.
  useEffect(() => {
    if (!distribution || TERMINAL_STATUSES.has(distribution.status)) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = setInterval(() => fetchDetail(true), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [distribution?.status, fetchDetail]);

  async function handleDownload() {
    setDownloading(true);
    setDownloadError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/distributions/${distributionId}/download`, {
        headers: { Authorization: `Bearer ${role.token}` },
      });
      if (!res.ok) {
        const body = await safeJson(res);
        throw new Error(body?.error?.message ?? `다운로드에 실패했습니다. (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = /filename="?([^";]+)"?/.exec(disposition);
      const filename = match?.[1] ?? `bundle-${distributionId}.zip`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }

  if (state === "loading") {
    return <LoadingState label="반출 요청 정보를 불러오는 중..." />;
  }

  if (state === "not_found") {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <ErrorBanner message="반출 요청을 찾을 수 없습니다." />
        <Button variant="secondary" onClick={() => router.push("/distributions")}>
          목록으로
        </Button>
      </div>
    );
  }

  if (state === "forbidden") {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <ShieldAlert size={40} strokeWidth={1.5} className="text-slate-300" />
        <p className="font-medium text-text-primary">본인이 요청한 반출만 조회할 수 있습니다.</p>
        <p className="text-caption text-text-secondary">현재 역할: {role.label}</p>
        <Button variant="secondary" onClick={() => router.push("/distributions")}>
          목록으로
        </Button>
      </div>
    );
  }

  if (state === "error" || !distribution) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <ErrorBanner message={errorMessage ?? "알 수 없는 오류"} />
        <Button variant="secondary" onClick={() => router.push("/distributions")}>
          목록으로
        </Button>
      </div>
    );
  }

  const d = distribution;

  return (
    <div className="max-w-4xl space-y-5">
      <div>
        <button
          onClick={() => router.push("/distributions")}
          className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
        >
          <ChevronLeft size={14} />
          목록으로
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-page-title font-bold text-text-primary">반출 요청 상세</h1>
          <StatusBadge status={d.status} />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-caption text-text-secondary">
          <Badge tone="neutral">{ROOT_TYPE_LABEL[d.root_type] ?? d.root_type}</Badge>
          <span title={d.root_id}>{d.root_id}</span>
          <span>· {DISTRIBUTION_MODE_LABEL[d.mode] ?? d.mode}</span>
          {d.target_site_id && <span>· 대상 사업장 {d.target_site_id}</span>}
          <span>· 요청자 {d.requested_by}</span>
          <span>· {formatDateTime(d.created_at)}</span>
        </div>
      </div>

      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <h2 className="mb-4 text-card-title font-semibold text-text-primary">진행 상태</h2>
        <StageProgress status={d.status} stage={d.stage} />
      </div>

      {d.status === "SUCCEEDED" && d.manifest_summary && (
        <>
          <div className="rounded-card border border-success/30 bg-success/5 p-5">
            <div className="mb-3 flex items-center gap-2 font-semibold text-success">
              <Check size={18} />
              Bundle 생성 완료
            </div>
            <div className="grid gap-2 text-body sm:grid-cols-2">
              <div>
                <span className="text-text-secondary">전체 크기</span>{" "}
                <span className="font-medium text-text-primary">
                  {formatBytes(d.bundle_size_bytes ?? d.manifest_summary.total_size_bytes)}
                </span>
              </div>
              <div>
                <span className="text-text-secondary">파일 수</span>{" "}
                <span className="font-medium text-text-primary">{d.manifest_summary.file_count}개</span>
              </div>
              <div>
                <span className="text-text-secondary">설치 순서</span>{" "}
                <span className="font-medium text-text-primary">
                  {d.manifest_summary.install_order.join(" → ")}
                </span>
              </div>
            </div>
            <div className="mt-3 rounded-lg border border-border bg-surface px-3 py-2">
              <div className="text-caption text-text-secondary">Checksum (SHA-256)</div>
              <code className="break-all text-xs text-text-primary">{d.bundle_checksum}</code>
            </div>
            <div className="mt-4">
              <Button onClick={handleDownload} disabled={downloading}>
                <Download size={15} />
                {downloading ? "다운로드 준비 중..." : "Bundle 다운로드"}
              </Button>
            </div>
            {downloadError && (
              <div className="mt-3">
                <ErrorBanner message={downloadError} />
              </div>
            )}
          </div>

          <div className="rounded-card border border-border bg-surface p-5 shadow-card">
            <h2 className="mb-3 text-card-title font-semibold text-text-primary">
              포함 자산 ({d.manifest_summary.included.length}개)
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-body">
                <thead>
                  <tr className="border-b border-border text-caption text-text-secondary">
                    <th className="py-2 pr-3 font-medium">이름</th>
                    <th className="py-2 pr-3 font-medium">유형</th>
                    <th className="py-2 pr-3 font-medium">역할</th>
                    <th className="py-2 pr-3 font-medium">버전</th>
                    <th className="py-2 pr-3 font-medium">상태</th>
                    <th className="py-2 pr-3 font-medium">필수</th>
                    <th className="py-2 pl-3 text-right font-medium">크기</th>
                  </tr>
                </thead>
                <tbody>
                  {d.manifest_summary.included.map((item, idx) => (
                    <tr key={`${item.asset_id ?? "?"}-${idx}`} className="border-b border-border last:border-0">
                      <td className="py-2 pr-3 text-text-primary">{item.name ?? "-"}</td>
                      <td className="py-2 pr-3 text-text-secondary">{item.asset_type}</td>
                      <td className="py-2 pr-3 text-text-secondary">{item.role}</td>
                      <td className="py-2 pr-3 text-text-secondary">{item.version ?? "-"}</td>
                      <td className="py-2 pr-3">
                        <StatusBadge status={item.status} />
                      </td>
                      <td className="py-2 pr-3 text-text-secondary">{item.required ? "필수" : "선택"}</td>
                      <td className="py-2 pl-3 text-right text-text-secondary">
                        {formatBytes(item.size_bytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {d.status === "FAILED" && (
        <div className="rounded-card border border-danger/30 bg-danger/5 p-5">
          <div className="mb-3 flex items-center gap-2 font-semibold text-danger">
            <AlertTriangle size={18} />
            Bundle 생성 실패
          </div>
          <div className="space-y-2 text-body">
            <div>
              <span className="text-text-secondary">오류 코드</span>{" "}
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{d.error_code ?? "-"}</code>
            </div>
            <div>
              <span className="text-text-secondary">오류 메시지</span>{" "}
              <span className="text-text-primary">{d.error_message ?? "-"}</span>
            </div>
            {d.affected_assets && d.affected_assets.length > 0 && (
              <div>
                <span className="text-text-secondary">영향을 받은 자산</span>
                <ul className="mt-1 list-inside list-disc text-text-primary">
                  {d.affected_assets.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <span className="text-text-secondary">재시도 가능 여부</span>{" "}
              <span className="text-text-primary">
                {d.retryable === null ? "알 수 없음" : d.retryable ? "재시도 가능" : "재시도 불가"}
              </span>
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled
              title="재시도 API가 아직 구현되지 않았습니다."
            >
              <RotateCcw size={14} />
              재시도 (미구현)
            </Button>
          </div>
        </div>
      )}

      {(d.status === "QUEUED" || d.status === "RUNNING") && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="secondary"
            disabled
            title="취소 API가 아직 구현되지 않았습니다."
          >
            <XCircle size={14} />
            취소 (미구현)
          </Button>
        </div>
      )}

      {d.trace_id && (
        <p className="text-caption text-text-muted">Trace ID: {d.trace_id}</p>
      )}
    </div>
  );
}
