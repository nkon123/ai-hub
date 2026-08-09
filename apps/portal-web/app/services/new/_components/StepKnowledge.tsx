"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, BookOpen, Inbox, Trash2 } from "lucide-react";
import {
  Badge,
  Card,
  EmptyState,
  ErrorBanner,
  FormField,
  LoadingState,
  StatusBadge,
  inputClass,
} from "../../../_components/ui";
import { useRole } from "../../../_components/role-context";
import { CLASSIFICATION_RANK } from "./types";
import type { Classification, KnowledgeAsset, KnowledgeBindingDraft, KnowledgeInfo } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

function usabilityReason(status: string, indexingStatus: string | undefined): string | undefined {
  if (status !== "APPROVED") return "승인되지 않은 버전은 연결할 수 없습니다 (게시 검증이 반드시 거부합니다).";
  if (indexingStatus !== "COMPLETED") {
    if (indexingStatus === "FAILED") return "인덱싱이 실패했습니다.";
    if (indexingStatus === "PENDING" || indexingStatus === "RUNNING") return "인덱싱이 진행 중입니다.";
    return "인덱싱되지 않았습니다.";
  }
  return undefined;
}

export function StepKnowledge({
  serviceClassification,
  bindings,
  onChange,
}: {
  serviceClassification: Classification;
  bindings: KnowledgeBindingDraft[];
  onChange: (next: KnowledgeBindingDraft[]) => void;
}) {
  const { role } = useRole();
  const [assets, setAssets] = useState<KnowledgeAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [assetsError, setAssetsError] = useState<string | null>(null);

  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
  const [info, setInfo] = useState<KnowledgeInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setAssetsLoading(true);
      setAssetsError(null);
      try {
        const res = await fetch(`${API_BASE}/api/v1/assets?type=knowledge`, {
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

  function isBound(versionId: string) {
    return bindings.some((b) => b.knowledgeVersionId === versionId);
  }

  function addBinding(versionId: string, versionLabel: string) {
    if (!info || isBound(versionId)) return;
    onChange([
      ...bindings,
      {
        knowledgeAssetId: info.id,
        knowledgeAssetName: info.name,
        knowledgeClassification: info.classification,
        knowledgeVersionId: versionId,
        knowledgeVersionLabel: versionLabel,
        contextTokenLimit: 4096,
      },
    ]);
  }

  function removeBinding(versionId: string) {
    onChange(bindings.filter((b) => b.knowledgeVersionId !== versionId));
  }

  function updateContextLimit(versionId: string, limit: number) {
    onChange(bindings.map((b) => (b.knowledgeVersionId === versionId ? { ...b, contextTokenLimit: limit } : b)));
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-card-title font-semibold text-text-primary">Knowledge 연결</h2>
        <p className="text-body text-text-secondary">
          Agent의 답변 Role(answerer)에 연결할 Knowledge를 1개 이상 선택하세요. 승인(APPROVED)되고 인덱싱이
          완료된 버전만 연결할 수 있습니다 — 게시 구성 검증(단계 8)이 이 조건을 그대로 다시 확인합니다.
        </p>
      </div>

      {bindings.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-body font-semibold text-text-primary">연결된 Knowledge ({bindings.length})</h3>
          {bindings.map((b) => (
            <div
              key={b.knowledgeVersionId}
              className="flex flex-wrap items-center gap-3 rounded-card border border-brand-200 bg-brand-50 px-4 py-3"
            >
              <BookOpen size={16} className="shrink-0 text-brand-600" />
              <div className="flex-1">
                <div className="text-body font-medium text-text-primary">
                  {b.knowledgeAssetName} <span className="text-text-muted">v{b.knowledgeVersionLabel}</span>
                </div>
                <div className="text-caption text-text-secondary">Role: answerer · Retrieval: default-korean</div>
              </div>
              <FormField label="최대 Context Token">
                <input
                  type="number"
                  min={0}
                  value={b.contextTokenLimit}
                  onChange={(e) => updateContextLimit(b.knowledgeVersionId, Number(e.target.value))}
                  className={`${inputClass} w-32`}
                />
              </FormField>
              <button
                type="button"
                onClick={() => removeBinding(b.knowledgeVersionId)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-danger hover:bg-danger/10"
                aria-label="연결 해제"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

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
              onClick={() => setActiveAssetId(asset.id)}
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
                const reason = usabilityReason(ver.status, ver.indexing_job?.status);
                const usable = !reason;
                const bound = isBound(ver.id);
                const classificationTooHigh =
                  usable &&
                  CLASSIFICATION_RANK[info.classification as Classification] >
                    CLASSIFICATION_RANK[serviceClassification];
                return (
                  <button
                    key={ver.id}
                    type="button"
                    disabled={!usable || bound}
                    onClick={() => addBinding(ver.id, ver.version)}
                    className={`flex items-center justify-between rounded-lg border px-3 py-2.5 text-left text-body transition ${
                      bound
                        ? "cursor-default border-success/30 bg-success/5"
                        : usable
                        ? "border-border bg-surface hover:border-brand-300"
                        : "cursor-not-allowed border-border bg-slate-50 opacity-60"
                    }`}
                  >
                    <div>
                      <div className="font-medium text-text-primary">v{ver.version}</div>
                      {!usable && <div className="mt-0.5 text-caption text-text-muted">{reason}</div>}
                      {classificationTooHigh && (
                        <div className="mt-0.5 flex items-center gap-1 text-caption text-warning">
                          <AlertTriangle size={11} />
                          이 Knowledge({info.classification})가 서비스 보안등급({serviceClassification})보다
                          높습니다. Portal API가 아직 강제하지는 않지만 권장하지 않습니다.
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {bound && <Badge tone="success">연결됨</Badge>}
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
