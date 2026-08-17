"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Inbox,
  Lock,
  MessageSquareText,
  Search,
} from "lucide-react";
import {
  Badge,
  Card,
  EmptyState,
  ErrorBanner,
  LoadingState,
  StatusBadge,
  inputClass,
} from "../../../_components/ui";
import { useRole } from "../../../_components/role-context";
import {
  registryVersionUsabilityReason,
  toAgentSelection,
  toPromptSelection,
  type RegistryAsset,
} from "../../../_components/registryManifests";
import type { AgentChoice, RegistryPromptSelection } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

// Mirrors /services/new's StepAgent.tsx: a search box is only worth the extra
// chrome once there's actually something to filter.
const FILTER_THRESHOLD = 5;

export const STANDARD_AGENT_LABEL = "표준 Agent (Standard Knowledge Chat Agent)";

/**
 * StepPublish.tsx's collapsed-by-default "응답 Agent 변경 (고급)" section.
 * Quick Create's fast path (표준 Agent, unchanged) never touches this — it
 * only renders once expanded, and the collapsed summary line is the only
 * visual addition to the previous screen. Reuses the same
 * app/_components/registryManifests.ts helpers /services/new's StepAgent /
 * StepPrompt already use for the same APPROVED-only version gating, so a
 * DRAFT/IN_REVIEW Agent or Prompt is disabled with the same reason text in
 * both wizards.
 */
export function AdvancedAgentSection({
  agentChoice,
  onAgentChoiceChange,
  registryPrompt,
  onRegistryPromptChange,
  disabled,
}: {
  agentChoice: AgentChoice;
  onAgentChoiceChange: (next: AgentChoice) => void;
  registryPrompt: RegistryPromptSelection | null;
  onRegistryPromptChange: (next: RegistryPromptSelection) => void;
  disabled: boolean;
}) {
  const { role } = useRole();
  const [expanded, setExpanded] = useState(false);

  const [agentAssets, setAgentAssets] = useState<RegistryAsset[]>([]);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentError, setAgentError] = useState<{ message: string; permission: boolean } | null>(null);
  const [expandedAgentAssetId, setExpandedAgentAssetId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [promptAssets, setPromptAssets] = useState<RegistryAsset[]>([]);
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptError, setPromptError] = useState<{ message: string; permission: boolean } | null>(null);
  const [expandedPromptAssetId, setExpandedPromptAssetId] = useState<string | null>(null);

  const isRegistryAgent = agentChoice.source === "registry";

  // Load registered Agents once the section is first expanded.
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    async function load() {
      setAgentLoading(true);
      setAgentError(null);
      try {
        const res = await fetch(`${API_BASE}/api/v1/assets?type=agent`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (!res.ok) {
          throw Object.assign(new Error(`HTTP ${res.status}`), { permission: res.status === 403 });
        }
        const data = await res.json();
        if (!cancelled) setAgentAssets(data.items ?? []);
      } catch (e) {
        if (!cancelled) {
          const permission = (e as { permission?: boolean }).permission === true;
          setAgentError({ message: e instanceof Error ? e.message : String(e), permission });
        }
      } finally {
        if (!cancelled) setAgentLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [expanded, role.token]);

  // Load registered Prompts only once a registry Agent is actually chosen —
  // matching /services/new's StepPrompt.tsx (no unnecessary fetch for the
  // standard Agent path).
  useEffect(() => {
    if (!isRegistryAgent) return;
    let cancelled = false;
    async function load() {
      setPromptLoading(true);
      setPromptError(null);
      try {
        const res = await fetch(`${API_BASE}/api/v1/assets?type=prompt`, {
          headers: { Authorization: `Bearer ${role.token}` },
        });
        if (!res.ok) {
          throw Object.assign(new Error(`HTTP ${res.status}`), { permission: res.status === 403 });
        }
        const data = await res.json();
        if (!cancelled) setPromptAssets(data.items ?? []);
      } catch (e) {
        if (!cancelled) {
          const permission = (e as { permission?: boolean }).permission === true;
          setPromptError({ message: e instanceof Error ? e.message : String(e), permission });
        }
      } finally {
        if (!cancelled) setPromptLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [isRegistryAgent, role.token]);

  const agentCards = useMemo(
    () =>
      agentAssets
        .map((asset) => {
          const sorted = [...asset.versions].sort((a, b) => b.created_at.localeCompare(a.created_at));
          return sorted.length ? { asset, sorted } : null;
        })
        .filter((x): x is { asset: RegistryAsset; sorted: RegistryAsset["versions"] } => x !== null),
    [agentAssets]
  );

  const promptCards = useMemo(
    () =>
      promptAssets
        .map((asset) => {
          const sorted = [...asset.versions].sort((a, b) => b.created_at.localeCompare(a.created_at));
          return sorted.length ? { asset, sorted } : null;
        })
        .filter((x): x is { asset: RegistryAsset; sorted: RegistryAsset["versions"] } => x !== null),
    [promptAssets]
  );

  const totalOptionCount = 1 + agentCards.length;
  const showFilter = totalOptionCount > FILTER_THRESHOLD;
  const q = query.trim().toLowerCase();
  const filteredAgentCards = q
    ? agentCards.filter(
        ({ asset, sorted }) =>
          asset.name.toLowerCase().includes(q) ||
          (typeof sorted[0]?.manifest?.description === "string" &&
            (sorted[0].manifest.description as string).toLowerCase().includes(q))
      )
    : agentCards;

  const selectedAgentLabel =
    agentChoice.source === "standard" ? STANDARD_AGENT_LABEL : `${agentChoice.assetName} (v${agentChoice.versionLabel})`;

  function selectStandard() {
    onAgentChoiceChange({ source: "standard" });
  }

  return (
    <div className="rounded-card border border-border bg-surface">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="flex items-center gap-1.5 text-body font-medium text-text-primary">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          응답 Agent 변경 (고급)
        </span>
        <span className="text-caption text-text-muted">현재 선택: {selectedAgentLabel}</span>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-border px-4 py-4">
          <p className="text-caption text-text-secondary">
            기본값은 표준 Agent입니다. Portal에 등록·승인(APPROVED)된 Agent로 바꿀 수 있으며, Agent를 바꾸면
            그 Agent와 짝지어 응답할 Prompt도 함께 선택해야 합니다.
          </p>

          {showFilter && (
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Agent 이름/설명으로 검색..."
                className={`${inputClass} pl-9`}
                disabled={disabled}
              />
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Card
              onClick={disabled ? undefined : selectStandard}
              className={`flex flex-col gap-2 px-4 py-4 ${
                agentChoice.source === "standard" ? "border-brand-500 ring-1 ring-brand-500" : ""
              } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                    <Bot size={18} strokeWidth={1.75} />
                  </span>
                  <div>
                    <div className="text-body font-semibold text-text-primary">Standard Knowledge Chat Agent</div>
                    <div className="text-caption text-text-muted">표준 Agent · v1.0.0</div>
                  </div>
                </div>
                {agentChoice.source === "standard" && (
                  <Badge tone="success">
                    <Check size={11} className="mr-0.5" />
                    선택됨
                  </Badge>
                )}
              </div>
              <p className="text-body text-text-secondary">등록된 Knowledge를 근거로 답변하는 기본 Agent입니다. Registry 등록 없이 항상 실행됩니다.</p>
            </Card>

            {filteredAgentCards.map(({ asset, sorted }) => {
              const selected = agentChoice.source === "registry" && agentChoice.assetId === asset.id;
              const cardExpanded = expandedAgentAssetId === asset.id;
              const description = typeof sorted[0]?.manifest?.description === "string" ? (sorted[0].manifest.description as string) : "";
              return (
                <Card
                  key={asset.id}
                  onClick={disabled ? undefined : () => setExpandedAgentAssetId(cardExpanded ? null : asset.id)}
                  className={`flex flex-col gap-2 px-4 py-4 ${selected ? "border-brand-500 ring-1 ring-brand-500" : ""} ${
                    disabled ? "cursor-not-allowed opacity-60" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-50 text-purple-700">
                        <Bot size={18} strokeWidth={1.75} />
                      </span>
                      <div>
                        <div className="text-body font-semibold text-text-primary">{asset.name}</div>
                        <div className="text-caption text-text-muted">등록된 Agent · {sorted.length}개 버전</div>
                      </div>
                    </div>
                    {selected && (
                      <Badge tone="success">
                        <Check size={11} className="mr-0.5" />
                        선택됨
                      </Badge>
                    )}
                  </div>
                  {description && <p className="text-body text-text-secondary">{description}</p>}

                  {cardExpanded && (
                    <div className="mt-1 space-y-1.5 border-t border-border pt-3" onClick={(e) => e.stopPropagation()}>
                      <p className="mb-1 text-caption font-semibold text-text-secondary">버전 선택</p>
                      {sorted.map((ver) => {
                        const reason = registryVersionUsabilityReason(ver.status);
                        const usable = !reason;
                        const verSelected = agentChoice.source === "registry" && agentChoice.versionId === ver.id;
                        return (
                          <button
                            key={ver.id}
                            type="button"
                            disabled={!usable || disabled}
                            onClick={() => {
                              const selection = toAgentSelection(asset, ver);
                              if (selection) onAgentChoiceChange(selection);
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

          {agentLoading && <LoadingState label="등록된 Agent 자산을 확인하는 중..." />}
          {agentError && !agentError.permission && (
            <ErrorBanner message={`등록된 Agent 목록을 불러오지 못했습니다: ${agentError.message}. 표준 Agent는 계속 선택할 수 있습니다.`} />
          )}
          {agentError && agentError.permission && (
            <ErrorBanner message="등록된 Agent 목록을 조회할 권한이 없습니다. 표준 Agent는 계속 선택할 수 있습니다." />
          )}
          {!agentLoading && !agentError && agentCards.length === 0 && (
            <EmptyState
              icon={<Inbox size={28} strokeWidth={1.5} />}
              title="아직 등록된 Agent 자산이 없습니다."
              description="표준 Agent는 계속 선택할 수 있습니다. Portal에 Agent를 등록하면 여기에 함께 나타납니다."
              action={
                <a href="/assets/new/agent" className="text-sm font-medium text-brand-600 hover:underline">
                  Agent 등록하러 가기 →
                </a>
              }
            />
          )}
          {!agentLoading && !agentError && q && filteredAgentCards.length === 0 && agentCards.length > 0 && (
            <p className="text-body text-text-muted">검색어와 일치하는 Agent가 없습니다.</p>
          )}

          {isRegistryAgent && (
            <div className="space-y-3 border-t border-border pt-4">
              <div>
                <h4 className="mb-1 text-body font-semibold text-text-primary">Prompt 선택 (필수)</h4>
                <p className="text-caption text-text-secondary">
                  등록된 Agent를 선택하면 표준 Prompt가 자동 연결되지 않습니다. 이 Agent와 짝지어 응답을 생성할
                  Prompt를 승인(APPROVED)된 버전 중에서 선택하세요. 선택하지 않으면 게시할 수 없습니다.
                </p>
              </div>

              {registryPrompt && (
                <div className="rounded-lg border border-success/30 bg-success/5 px-3 py-2">
                  <div className="flex items-center gap-1.5 text-body font-semibold text-success">
                    <Check size={13} />
                    선택됨: {registryPrompt.manifest.name} (v{registryPrompt.manifest.version})
                  </div>
                </div>
              )}

              {promptLoading && <LoadingState label="등록된 Prompt 자산을 확인하는 중..." />}
              {promptError && !promptError.permission && (
                <ErrorBanner message={`등록된 Prompt 목록을 불러오지 못했습니다: ${promptError.message}.`} />
              )}
              {promptError && promptError.permission && (
                <ErrorBanner message="등록된 Prompt 목록을 조회할 권한이 없습니다." />
              )}
              {!promptLoading && !promptError && promptCards.length === 0 && (
                <EmptyState
                  icon={<Inbox size={28} strokeWidth={1.5} />}
                  title="등록된 Prompt 자산이 없습니다."
                  description="이 Agent를 쓰려면 먼저 Prompt 자산을 등록·승인해야 합니다."
                  action={
                    <a href="/assets/new/prompt" className="text-sm font-medium text-brand-600 hover:underline">
                      Prompt 등록하러 가기 →
                    </a>
                  }
                />
              )}

              {!promptLoading && !promptError && promptCards.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {promptCards.map(({ asset, sorted }) => {
                    const cardExpanded = expandedPromptAssetId === asset.id;
                    const selected = registryPrompt?.assetId === asset.id;
                    return (
                      <Card
                        key={asset.id}
                        onClick={disabled ? undefined : () => setExpandedPromptAssetId(cardExpanded ? null : asset.id)}
                        className={`flex flex-col gap-2 px-4 py-3 ${selected ? "border-brand-500 ring-1 ring-brand-500" : ""} ${
                          disabled ? "cursor-not-allowed opacity-60" : ""
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-purple-50 text-purple-700">
                              <MessageSquareText size={16} strokeWidth={1.75} />
                            </span>
                            <div>
                              <div className="text-body font-semibold text-text-primary">{asset.name}</div>
                              <div className="text-caption text-text-muted">{sorted.length}개 버전</div>
                            </div>
                          </div>
                          {selected && (
                            <Badge tone="success">
                              <Check size={11} className="mr-0.5" />
                              선택됨
                            </Badge>
                          )}
                        </div>

                        {cardExpanded && (
                          <div className="mt-1 space-y-1.5 border-t border-border pt-3" onClick={(e) => e.stopPropagation()}>
                            <p className="mb-1 text-caption font-semibold text-text-secondary">버전 선택</p>
                            {sorted.map((ver) => {
                              const reason = registryVersionUsabilityReason(ver.status);
                              const usable = !reason;
                              const verSelected = registryPrompt?.versionId === ver.id;
                              return (
                                <button
                                  key={ver.id}
                                  type="button"
                                  disabled={!usable || disabled}
                                  onClick={() => {
                                    const selection = toPromptSelection(asset, ver);
                                    if (selection) onRegistryPromptChange(selection);
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
          )}

          {!isRegistryAgent && (
            <p className="flex items-center gap-1.5 text-caption text-text-muted">
              <Lock size={11} />
              표준 Agent는 고정된 표준 Prompt로 응답합니다.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
