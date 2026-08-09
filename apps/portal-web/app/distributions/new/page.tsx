"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bot, BookOpen, Info, Lightbulb, Lock, PackageOpen, Wrench } from "lucide-react";
import {
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
import { canCreateDistribution, useRole } from "../../_components/role-context";
import { OFFICE_SITES } from "../../_components/distribution-meta";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

interface AssetVersionItem {
  id: string;
  version: string;
  status: string;
  created_at: string;
}

interface AssetItem {
  id: string;
  type: string;
  name: string;
  owner_org: string;
  classification: string;
  versions: AssetVersionItem[];
}

// Root type is fixed to ASSET_VERSION for this screen — SERVICE_VERSION
// roots (AI Service Bundle export) live under a different entity
// (ServiceVersion, not Asset) with no equivalent picker UI yet; see the
// task report for this scope note.
const ASSET_TYPES: { value: string; label: string; icon: typeof BookOpen }[] = [
  { value: "knowledge", label: "Knowledge", icon: BookOpen },
  { value: "agent", label: "Agent", icon: Bot },
  { value: "prompt", label: "Prompt", icon: Lightbulb },
  { value: "mcp_tool", label: "MCP 도구", icon: Wrench },
];

function approvalReason(status: string): string {
  return `승인되지 않은 버전은 반출할 수 없습니다 (현재: ${status})`;
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function NewDistributionForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { role } = useRole();

  const presetAssetId = searchParams.get("assetId");
  const presetVersionId = searchParams.get("versionId");

  const [typeFilter, setTypeFilter] = useState("knowledge");
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [assetsError, setAssetsError] = useState<string | null>(null);

  const [presetAsset, setPresetAsset] = useState<AssetItem | null>(null);

  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [targetSiteId, setTargetSiteId] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const canSubmitRole = canCreateDistribution(role.code);

  // Single prioritized reason the submit button is disabled — CLAUDE.md UI 규칙:
  // "호환되지 않는 선택지는 이유와 함께 비활성화한다." Order mirrors how far the
  // user has progressed through the form: role -> asset -> version.
  let submitDisabledReason: string | null = null;
  if (!canSubmitRole) {
    submitDisabledReason = `현재 역할(${role.label})은 반출을 요청할 수 없습니다. 자산 제작자 또는 관리자로 전환하세요.`;
  } else if (!selectedAssetId) {
    submitDisabledReason = "반출 대상 자산을 선택하세요.";
  } else if (!selectedVersionId) {
    submitDisabledReason = "반출 대상 버전을 선택하세요.";
  }

  // Prefill from an asset detail page's "Offline Bundle 요청" action — that
  // asset's type may not match the default `knowledge` filter below, so it
  // is fetched directly rather than relying on the type-filtered list.
  useEffect(() => {
    if (!presetAssetId) return;
    let cancelled = false;
    async function loadPreset() {
      try {
        const res = await fetch(`${API_BASE}/api/v1/assets/${presetAssetId}`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (!res.ok) return;
        const asset: AssetItem = await res.json();
        if (cancelled) return;
        setTypeFilter(asset.type);
        setPresetAsset(asset);
        setSelectedAssetId(asset.id);
        if (
          presetVersionId &&
          asset.versions.some((v) => v.id === presetVersionId && v.status === "APPROVED")
        ) {
          setSelectedVersionId(presetVersionId);
        }
      } catch {
        // best-effort prefill only — the normal picker below still works.
      }
    }
    loadPreset();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetAssetId, presetVersionId, role.token]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setAssetsLoading(true);
      setAssetsError(null);
      try {
        const res = await fetch(`${API_BASE}/api/v1/assets?type=${typeFilter}&page_size=100`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setAssets(data.items ?? []);
      } catch (e) {
        if (!cancelled) setAssetsError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setAssetsLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [typeFilter, role.token]);

  // Prefer the freshly-fetched list row so version data stays current, but
  // fall back to the directly-fetched preset asset (e.g. its type's list
  // hasn't loaded yet, or it's on a later page than page_size=100 covers).
  const selectedAsset =
    assets.find((a) => a.id === selectedAssetId) ??
    (presetAsset?.id === selectedAssetId ? presetAsset : null);

  function handleSelectType(value: string) {
    setTypeFilter(value);
    setSelectedAssetId(null);
    setSelectedVersionId(null);
  }

  function handleSelectAsset(asset: AssetItem) {
    setSelectedAssetId(asset.id);
    setSelectedVersionId(null);
  }

  async function handleSubmit() {
    if (!selectedVersionId) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/distributions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.token}` },
        body: JSON.stringify({
          root_type: "ASSET_VERSION",
          root_id: selectedVersionId,
          mode: "OFFLINE_BUNDLE",
          target_site_id: targetSiteId || undefined,
        }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setSubmitError(body?.error?.message ?? `요청에 실패했습니다. (HTTP ${res.status})`);
        return;
      }
      router.push(`/distributions/${body.id}`);
    } catch {
      setSubmitError("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="반출 요청"
        description="승인된 자산 버전을 선택해 폐쇄망 반입용 Offline Bundle을 생성합니다."
      />

      <div className="space-y-6">
        <FormField label="자산 유형" required>
          <div className="flex flex-wrap gap-2">
            {ASSET_TYPES.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => handleSelectType(t.value)}
                  className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-body transition ${
                    typeFilter === t.value
                      ? "border-brand-500 bg-brand-50 text-brand-700"
                      : "border-border bg-surface text-text-secondary hover:border-brand-300"
                  }`}
                >
                  <Icon size={15} />
                  {t.label}
                </button>
              );
            })}
          </div>
        </FormField>

        <FormField label="반출 대상 자산" required>
          {assetsLoading && <LoadingState label="자산 목록을 불러오는 중..." />}
          {assetsError && <ErrorBanner message={`자산 목록을 불러오지 못했습니다: ${assetsError}`} />}
          {!assetsLoading && !assetsError && assets.length === 0 && (
            <EmptyState title="등록된 자산이 없습니다." />
          )}
          {!assetsLoading && !assetsError && assets.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {assets.map((asset) => (
                <Card
                  key={asset.id}
                  onClick={() => handleSelectAsset(asset)}
                  className={`px-4 py-3 ${
                    selectedAssetId === asset.id ? "border-brand-500 ring-1 ring-brand-500" : ""
                  }`}
                >
                  <div className="text-body font-semibold text-text-primary">{asset.name}</div>
                  <div className="mt-0.5 text-caption text-text-secondary">
                    {asset.owner_org} · {asset.classification}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </FormField>

        {selectedAsset && (
          <FormField label="반출 대상 버전" required>
            <div className="rounded-card border border-border bg-surface p-4 shadow-card">
              {selectedAsset.versions.length === 0 && (
                <p className="text-body text-text-muted">등록된 버전이 없습니다.</p>
              )}
              <div className="grid gap-2">
                {[...selectedAsset.versions]
                  .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                  .map((ver) => {
                    const approved = ver.status === "APPROVED";
                    const isSelected = selectedVersionId === ver.id;
                    return (
                      <button
                        key={ver.id}
                        type="button"
                        disabled={!approved}
                        onClick={() => setSelectedVersionId(ver.id)}
                        className={`flex items-center justify-between rounded-lg border px-3 py-2.5 text-left text-body transition ${
                          isSelected
                            ? "border-brand-500 bg-brand-50"
                            : approved
                            ? "border-border bg-surface hover:border-brand-300"
                            : "cursor-not-allowed border-border bg-slate-50 opacity-60"
                        }`}
                      >
                        <div>
                          <div className="font-medium text-text-primary">v{ver.version}</div>
                          {!approved && (
                            <div className="mt-0.5 flex items-center gap-1 text-caption text-text-muted">
                              <Lock size={11} />
                              {approvalReason(ver.status)}
                            </div>
                          )}
                        </div>
                        <StatusBadge status={ver.status} />
                      </button>
                    );
                  })}
              </div>
            </div>
          </FormField>
        )}

        <FormField label="배포 방식" required>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-brand-500 bg-brand-50 px-4 py-3">
              <div className="font-semibold text-text-primary">폐쇄망 반출용 Offline Bundle</div>
              <div className="mt-0.5 text-caption text-text-secondary">
                Checksum이 포함된 ZIP Bundle을 생성합니다.
              </div>
            </div>
            <div
              className="cursor-not-allowed rounded-lg border border-border bg-slate-50 px-4 py-3 opacity-60"
              title="온라인 단일 다운로드는 아직 지원하지 않습니다."
            >
              <div className="font-semibold text-text-secondary">온라인 단일 다운로드</div>
              <div className="mt-0.5 flex items-center gap-1 text-caption text-text-muted">
                <Lock size={11} />
                아직 지원하지 않습니다 (미구현)
              </div>
            </div>
          </div>
        </FormField>

        <FormField label="대상 사업장">
          <select
            value={targetSiteId}
            onChange={(e) => setTargetSiteId(e.target.value)}
            className={`${inputClass} w-auto`}
          >
            <option value="">미지정</option>
            {OFFICE_SITES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </FormField>

        <div className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/5 px-4 py-3 text-body text-text-secondary">
          <Info size={16} className="mt-0.5 shrink-0 text-info" />
          <span>
            예상 파일 크기, 포함 자산 목록, 라이선스·보안 경고는 사전 계산(Dry-run) 기능이 없어 이
            화면에서는 표시하지 않습니다. Bundle 생성이 끝나면 작업 상세 화면에서 실제 포함 자산,
            전체 크기, Checksum을 확인할 수 있습니다.
          </span>
        </div>

        {submitDisabledReason && (
          <div className="flex items-center gap-1.5 text-caption text-text-secondary">
            <Lock size={12} />
            {submitDisabledReason}
          </div>
        )}

        {submitError && <ErrorBanner message={submitError} />}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => router.push("/distributions")} disabled={submitting}>
            취소
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !!submitDisabledReason}
          >
            <PackageOpen size={15} />
            {submitting ? "요청 중..." : "반출 요청 제출"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function NewDistributionPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <NewDistributionForm />
    </Suspense>
  );
}
