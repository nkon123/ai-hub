"use client";

import { useEffect, useState } from "react";
import { BookOpen, Inbox, Info } from "lucide-react";
import { Badge, Card, EmptyState, ErrorBanner, LoadingState, StatusBadge } from "../../../_components/ui";
import { useRole } from "../../../_components/role-context";
import type { KnowledgeAsset, KnowledgeInfo, SelectedKnowledge } from "./types";

// Absolute path pattern for the same portal-api, matching app/assets/[id]/page.tsx's
// NEXT_PUBLIC_API_BASE usage.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

function indexingReason(status: string | undefined): string {
  if (status === "FAILED") return "인덱싱 실패";
  if (status === "PENDING" || status === "RUNNING") return "인덱싱 대기 중";
  return "인덱싱되지 않음";
}

export function StepKnowledge({
  selected,
  onSelect,
}: {
  selected: SelectedKnowledge | null;
  onSelect: (value: SelectedKnowledge | null) => void;
}) {
  const { role } = useRole();
  const [assets, setAssets] = useState<KnowledgeAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [assetsError, setAssetsError] = useState<string | null>(null);

  const [activeAssetId, setActiveAssetId] = useState<string | null>(selected?.assetId ?? null);
  const [info, setInfo] = useState<KnowledgeInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setAssetsLoading(true);
      setAssetsError(null);
      try {
        const res = await fetch("/api/v1/assets?type=knowledge", {
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
  }, [role.token]);

  useEffect(() => {
    if (!activeAssetId) return;
    let cancelled = false;
    async function load() {
      setInfoLoading(true);
      setInfoError(null);
      setInfo(null);
      try {
        const res = await fetch(`${API_BASE}/api/v1/assets/${activeAssetId}/knowledge-info`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: KnowledgeInfo = await res.json();
        if (!cancelled) setInfo(data);
      } catch (e) {
        if (!cancelled) setInfoError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setInfoLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [activeAssetId, role.token]);

  function handlePickVersion(versionId: string, versionLabel: string) {
    if (!info) return;
    onSelect({
      assetId: info.id,
      assetName: info.name,
      ownerOrg: info.owner_org,
      classification: info.classification,
      versionId,
      versionLabel,
    });
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-card-title font-semibold text-text-primary">지식 선택</h2>
        <p className="text-body text-text-secondary">챗봇이 답변에 사용할 Knowledge 자산을 선택하세요.</p>
      </div>

      {assetsLoading && <LoadingState label="지식 자산 목록을 불러오는 중..." />}
      {assetsError && <ErrorBanner message={`지식 자산 목록을 불러오지 못했습니다: ${assetsError}`} />}
      {!assetsLoading && !assetsError && assets.length === 0 && (
        <EmptyState
          icon={<Inbox size={40} strokeWidth={1.5} />}
          title="등록된 Knowledge 자산이 없습니다."
          action={
            <a href="/knowledge/new" className="text-sm font-medium text-brand-600 hover:underline">
              첫 번째 지식을 등록하세요 →
            </a>
          }
        />
      )}

      {!assetsLoading && !assetsError && assets.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {assets.map((asset) => (
            <Card
              key={asset.id}
              onClick={() => {
                if (selected?.assetId !== asset.id) {
                  onSelect(null);
                }
                setActiveAssetId(asset.id);
              }}
              className={`flex items-center gap-3 px-4 py-3 ${
                activeAssetId === asset.id ? "border-brand-500 ring-1 ring-brand-500" : ""
              }`}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-asset-knowledge/10 text-asset-knowledge">
                <BookOpen size={18} strokeWidth={1.75} />
              </span>
              <div className="flex-1">
                <div className="text-body font-semibold text-text-primary">{asset.name}</div>
                <div className="mt-0.5 text-caption text-text-secondary">
                  {asset.owner_org} · {asset.classification}
                </div>
              </div>
              {selected?.assetId === asset.id && <Badge tone="success">선택됨</Badge>}
            </Card>
          ))}
        </div>
      )}

      {activeAssetId && (
        <div className="rounded-card border border-border bg-surface p-4 shadow-card">
          <h3 className="mb-3 text-card-title font-semibold text-text-primary">버전 선택</h3>
          {infoLoading && <LoadingState label="버전 정보를 불러오는 중..." />}
          {infoError && <ErrorBanner message={`버전 정보를 불러오지 못했습니다: ${infoError}`} />}
          {!infoLoading && !infoError && info && info.versions.length === 0 && (
            <p className="text-body text-text-muted">등록된 버전이 없습니다.</p>
          )}
          {!infoLoading && !infoError && info && info.versions.length > 0 && (
            <div className="grid gap-2">
              {info.versions.map((ver) => {
                const usable = ver.indexing_job !== null && ver.indexing_job.status === "COMPLETED";
                const isSelected = selected?.assetId === info.id && selected.versionId === ver.id;
                const isApproved = ver.status === "APPROVED";
                return (
                  <button
                    key={ver.id}
                    type="button"
                    disabled={!usable}
                    onClick={() => handlePickVersion(ver.id, ver.version)}
                    className={`flex items-center justify-between rounded-lg border px-3 py-2.5 text-left text-body transition ${
                      isSelected
                        ? "border-brand-500 bg-brand-50"
                        : usable
                        ? "border-border bg-surface hover:border-brand-300"
                        : "cursor-not-allowed border-border bg-slate-50 opacity-60"
                    }`}
                  >
                    <div>
                      <div className="font-medium text-text-primary">v{ver.version}</div>
                      {!usable && (
                        <div className="mt-0.5 text-caption text-text-muted">
                          {indexingReason(ver.indexing_job?.status)}
                        </div>
                      )}
                      {usable && !isApproved && (
                        <div className="mt-0.5 flex items-center gap-1 text-caption text-warning">
                          <Info size={11} />
                          Preview는 가능하지만, 게시하려면 이 버전이 검토·승인되어야 합니다.
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {ver.indexing_job && <StatusBadge status={ver.indexing_job.status} />}
                      <StatusBadge status={ver.status} />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
