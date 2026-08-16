"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Inbox, Info, Lock, MessageSquareText } from "lucide-react";
import { Badge, Card, EmptyState, ErrorBanner, LoadingState, StatusBadge } from "../../../_components/ui";
import { useRole } from "../../../_components/role-context";
import { registryVersionUsabilityReason, toPromptSelection } from "./registryManifests";
import type { AgentOption } from "./constants";
import type { RegistryAsset, RegistryPromptSelection } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

/**
 * 표준 Agent는 여전히 고정 Prompt 표시만 한다(이 화면에서 편집 불가). Registry
 * Agent(2026-08-16, D-034 path 2)를 고른 경우에는 이 단계가 실제 선택 UI가
 * 된다 — 등록·승인된 Prompt 자산 버전 중 하나를 골라야 Preview 실행에 필요한
 * `registry_prompt_version_id`(agent-runtime `manifests.py`
 * `resolve_registry_agent_config`가 요구)와 `agent_ref`/`prompt_bindings`용
 * Prompt Manifest 자체 id/version이 모두 채워진다.
 */
export function StepPrompt({
  agent,
  isRegistryAgent,
  value,
  onChange,
}: {
  agent: AgentOption;
  isRegistryAgent: boolean;
  value: RegistryPromptSelection | null;
  onChange: (next: RegistryPromptSelection) => void;
}) {
  const { role } = useRole();
  const [assets, setAssets] = useState<RegistryAsset[]>([]);
  const [loading, setLoading] = useState(isRegistryAgent);
  const [error, setError] = useState<{ message: string; permission: boolean } | null>(null);
  const [expandedAssetId, setExpandedAssetId] = useState<string | null>(null);

  useEffect(() => {
    if (!isRegistryAgent) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_BASE}/api/v1/assets?type=prompt`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (!res.ok) {
          throw Object.assign(new Error(`HTTP ${res.status}`), { permission: res.status === 403 });
        }
        const data = await res.json();
        if (!cancelled) setAssets(data.items ?? []);
      } catch (e) {
        if (!cancelled) {
          const permission = (e as { permission?: boolean }).permission === true;
          setError({ message: e instanceof Error ? e.message : String(e), permission });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [isRegistryAgent, role.token]);

  const cards = useMemo(
    () =>
      assets
        .map((asset) => {
          const sorted = [...asset.versions].sort((a, b) => b.created_at.localeCompare(a.created_at));
          return sorted.length ? { asset, sorted } : null;
        })
        .filter((x): x is { asset: RegistryAsset; sorted: RegistryAsset["versions"] } => x !== null),
    [assets]
  );

  if (!isRegistryAgent) {
    // 표준 Agent — 기존 고정 표시 그대로.
    return (
      <div className="space-y-5">
        <div>
          <h2 className="mb-1 text-card-title font-semibold text-text-primary">Prompt 연결</h2>
          <p className="text-body text-text-secondary">
            표준 Agent는 Role에 표준 Prompt가 고정 연결됩니다. Prompt 본문은 이 화면에서 편집할 수 없습니다 —
            수정이 필요하면 새 Prompt 자산 버전을 만들어야 합니다.
          </p>
        </div>

        <div className="rounded-card border border-border bg-surface p-4 shadow-card">
          <div className="mb-2 flex items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-50 text-purple-700">
              <MessageSquareText size={18} strokeWidth={1.75} />
            </span>
            <div className="flex-1">
              <div className="text-body font-semibold text-text-primary">{agent.prompt?.name}</div>
              <div className="text-caption text-text-muted">Role: {agent.roleId} · v{agent.prompt?.manifestVersion}</div>
            </div>
            <Badge tone="neutral">
              <Lock size={11} className="mr-1" />
              고정
            </Badge>
          </div>
          <p className="text-body text-text-secondary">{agent.prompt?.description}</p>

          <div className="mt-3 border-t border-border pt-3">
            <p className="mb-1.5 text-caption font-semibold text-text-secondary">변수 Schema</p>
            <ul className="space-y-1">
              {agent.prompt?.variables.map((v) => (
                <li key={v.name} className="flex items-center gap-2 text-caption text-text-secondary">
                  <code className="rounded bg-slate-100 px-1.5 py-0.5">{v.name}</code>
                  {v.required && <Badge tone="warning">필수</Badge>}
                  <span>{v.description}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <p className="flex items-start gap-1.5 text-caption text-text-secondary">
          <Info size={12} className="mt-0.5 shrink-0" />
          이 Prompt는 선택한 Agent({agent.name})와 짝지어진 표준 Prompt이며 Agent를 바꾸면 자동으로 교체됩니다.
        </p>
      </div>
    );
  }

  // Registry Agent — 실제 선택 UI.
  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-card-title font-semibold text-text-primary">Prompt 연결</h2>
        <p className="text-body text-text-secondary">
          선택한 Agent(<strong>{agent.name}</strong>)는 Portal에 등록된 Agent라 표준 Prompt가 자동 연결되지
          않습니다. Role(<code className="rounded bg-slate-100 px-1 py-0.5">{agent.roleId}</code>)에 연결할
          Prompt를 승인(APPROVED)된 버전 중에서 직접 선택하세요.
        </p>
      </div>

      {value && (
        <div className="rounded-card border border-success/30 bg-success/5 p-4">
          <div className="mb-1 flex items-center gap-2 text-body font-semibold text-success">
            <Check size={15} />
            선택됨: {value.manifest.name} (v{value.manifest.version})
          </div>
          <p className="text-caption text-text-secondary">{value.manifest.description}</p>
        </div>
      )}

      {loading && <LoadingState label="등록된 Prompt 자산을 확인하는 중..." />}
      {error && !error.permission && (
        <ErrorBanner message={`등록된 Prompt 목록을 불러오지 못했습니다: ${error.message}.`} />
      )}
      {error && error.permission && (
        <ErrorBanner message="등록된 Prompt 목록을 조회할 권한이 없습니다." />
      )}
      {!loading && !error && cards.length === 0 && (
        <EmptyState
          icon={<Inbox size={32} strokeWidth={1.5} />}
          title="등록된 Prompt 자산이 없습니다."
          description="이 Agent를 계속 쓰려면 먼저 Prompt 자산을 등록·승인해야 합니다."
          action={
            <a href="/assets/new/prompt" className="text-sm font-medium text-brand-600 hover:underline">
              Prompt 등록하러 가기 →
            </a>
          }
        />
      )}

      {!loading && !error && cards.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {cards.map(({ asset, sorted }) => {
            const expanded = expandedAssetId === asset.id;
            const selected = value?.assetId === asset.id;
            return (
              <Card
                key={asset.id}
                onClick={() => setExpandedAssetId(expanded ? null : asset.id)}
                className={`flex flex-col gap-3 px-4 py-4 ${selected ? "border-brand-500 ring-1 ring-brand-500" : ""}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-50 text-purple-700">
                      <MessageSquareText size={18} strokeWidth={1.75} />
                    </span>
                    <div>
                      <div className="text-body font-semibold text-text-primary">{asset.name}</div>
                      <div className="text-caption text-text-muted">{sorted.length}개 버전</div>
                    </div>
                  </div>
                  {selected && <Badge tone="success"><Check size={11} className="mr-0.5" />선택됨</Badge>}
                </div>

                {expanded && (
                  <div className="mt-1 space-y-1.5 border-t border-border pt-3" onClick={(e) => e.stopPropagation()}>
                    <p className="mb-1 text-caption font-semibold text-text-secondary">버전 선택</p>
                    {sorted.map((ver) => {
                      const reason = registryVersionUsabilityReason(ver.status);
                      const usable = !reason;
                      const verSelected = value?.versionId === ver.id;
                      return (
                        <button
                          key={ver.id}
                          type="button"
                          disabled={!usable}
                          onClick={() => {
                            const selection = toPromptSelection(asset, ver);
                            if (selection) onChange(selection);
                          }}
                          className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-body transition ${
                            verSelected
                              ? "border-success/30 bg-success/5"
                              : usable
                              ? "border-border bg-surface hover:border-brand-300"
                              : "cursor-not-allowed border-border bg-slate-50 opacity-60"
                          }`}
                        >
                          <div>
                            <div className="font-medium text-text-primary">v{ver.version}</div>
                            {!usable && <div className="mt-0.5 text-caption text-text-muted">{reason}</div>}
                          </div>
                          <div className="flex items-center gap-1.5">
                            {verSelected && <Badge tone="success">선택됨</Badge>}
                            <StatusBadge status={ver.status} />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
