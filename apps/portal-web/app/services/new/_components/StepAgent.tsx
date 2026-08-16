"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, Check, Clock, Inbox, Layers, Search, ShieldCheck, Wrench } from "lucide-react";
import { Badge, Card, EmptyState, ErrorBanner, LoadingState, StatusBadge, inputClass } from "../../../_components/ui";
import { useRole } from "../../../_components/role-context";
import { AGENT_OPTIONS } from "./constants";
import { registryVersionUsabilityReason, toAgentSelection } from "./registryManifests";
import type { AgentSelection, RegistryAsset } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

// Only worth the extra chrome once there's actually something to filter —
// with 2 standard + a couple of registered agents, a search box would just
// be dead UI (root CLAUDE.md doesn't ask for filters that have nothing to do).
const FILTER_THRESHOLD = 5;

export function StepAgent({
  value,
  onChange,
}: {
  value: AgentSelection | null;
  onChange: (next: AgentSelection) => void;
}) {
  const { role } = useRole();
  const [assets, setAssets] = useState<RegistryAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; permission: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [expandedAssetId, setExpandedAssetId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_BASE}/api/v1/assets?type=agent`, {
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
          setError({
            message: e instanceof Error ? e.message : String(e),
            permission,
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [role.token]);

  // Latest version per asset drives the summary card (name/description) —
  // 업무 목적이 기술 id보다 먼저 보이도록 manifest의 name/description을 쓴다.
  const registeredCards = useMemo(
    () =>
      assets
        .map((asset) => {
          const sorted = [...asset.versions].sort((a, b) => b.created_at.localeCompare(a.created_at));
          const latest = sorted[0];
          return latest ? { asset, sorted, latest } : null;
        })
        .filter((x): x is { asset: RegistryAsset; sorted: RegistryAsset["versions"]; latest: RegistryAsset["versions"][number] } => x !== null),
    [assets]
  );

  const totalOptionCount = AGENT_OPTIONS.length + registeredCards.length;
  const showFilter = totalOptionCount > FILTER_THRESHOLD;

  const q = query.trim().toLowerCase();
  const filteredStandard = q ? AGENT_OPTIONS.filter((a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)) : AGENT_OPTIONS;
  const filteredRegistered = q
    ? registeredCards.filter(
        ({ asset, latest }) =>
          asset.name.toLowerCase().includes(q) ||
          (typeof latest.manifest?.description === "string" && (latest.manifest.description as string).toLowerCase().includes(q))
      )
    : registeredCards;

  function isRegistrySelected(assetId: string) {
    return value?.source === "registry" && value.assetId === assetId;
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-card-title font-semibold text-text-primary">Agent 선택</h2>
        <p className="text-body text-text-secondary">
          2개의 표준 Agent 또는 Portal에 등록·승인된 Agent 중 하나를 선택합니다. 한 Service에는 주 Agent 1개만
          허용됩니다.
        </p>
      </div>

      {showFilter && (
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Agent 이름/설명으로 검색..."
            className={`${inputClass} pl-9`}
          />
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {filteredStandard.map((agent) => {
          const selected = value?.source === "standard" && value.profileId === agent.id;
          return (
            <Card
              key={agent.id}
              onClick={() => onChange({ source: "standard", profileId: agent.id as "standard-agent" | "standard-db-agent" })}
              className={`flex flex-col gap-3 px-4 py-4 ${selected ? "border-brand-500 ring-1 ring-brand-500" : ""}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                    <Bot size={18} strokeWidth={1.75} />
                  </span>
                  <div>
                    <div className="text-body font-semibold text-text-primary">{agent.name}</div>
                    <div className="text-caption text-text-muted">표준 Agent · v{agent.manifestVersion}</div>
                  </div>
                </div>
                {selected && <Badge tone="success"><Check size={11} className="mr-0.5" />선택됨</Badge>}
              </div>

              <p className="text-body text-text-secondary">{agent.description}</p>

              <div className="flex flex-wrap gap-1.5">
                <Badge tone={agent.knowledgeRequired ? "brand" : "neutral"}>
                  <Layers size={11} className="mr-1" />
                  Knowledge {agent.knowledgeRequired ? "필수" : "선택"}
                </Badge>
                <Badge tone={agent.mcpAllowed ? "brand" : "neutral"}>
                  <Wrench size={11} className="mr-1" />
                  MCP Tool {agent.mcpAllowed ? "허용" : "미지원"}
                </Badge>
                <Badge tone="neutral">
                  <Clock size={11} className="mr-1" />
                  Timeout {agent.timeoutSeconds}s
                </Badge>
                <Badge tone="neutral">
                  <ShieldCheck size={11} className="mr-1" />
                  최대 MCP 호출 {agent.maxMcpCalls}회
                </Badge>
              </div>

              <div className="rounded-lg bg-slate-50 px-3 py-2 text-caption text-text-secondary">
                연결될 표준 Prompt: <span className="font-medium text-text-primary">{agent.prompt?.name}</span>
              </div>
            </Card>
          );
        })}

        {filteredRegistered.map(({ asset, sorted, latest }) => {
          const manifest = latest.manifest as Record<string, any>;
          const name = typeof manifest?.name === "string" ? manifest.name : asset.name;
          const description = typeof manifest?.description === "string" ? manifest.description : "";
          const knowledgeRequired = manifest?.capabilities?.knowledge_required === true;
          const mcpAllowed = manifest?.capabilities?.mcp_allowed === true;
          const selected = isRegistrySelected(asset.id);
          const expanded = expandedAssetId === asset.id;
          return (
            <Card
              key={asset.id}
              onClick={() => setExpandedAssetId(expanded ? null : asset.id)}
              className={`flex flex-col gap-3 px-4 py-4 ${selected ? "border-brand-500 ring-1 ring-brand-500" : ""}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-50 text-purple-700">
                    <Bot size={18} strokeWidth={1.75} />
                  </span>
                  <div>
                    <div className="text-body font-semibold text-text-primary">{name}</div>
                    <div className="text-caption text-text-muted">등록된 Agent · {sorted.length}개 버전</div>
                  </div>
                </div>
                {selected && <Badge tone="success"><Check size={11} className="mr-0.5" />선택됨</Badge>}
              </div>

              {description && <p className="text-body text-text-secondary">{description}</p>}

              <div className="flex flex-wrap gap-1.5">
                <Badge tone={knowledgeRequired ? "brand" : "neutral"}>
                  <Layers size={11} className="mr-1" />
                  Knowledge {knowledgeRequired ? "필수" : "선택"}
                </Badge>
                <Badge tone={mcpAllowed ? "brand" : "neutral"}>
                  <Wrench size={11} className="mr-1" />
                  MCP Tool {mcpAllowed ? "허용" : "미지원"}
                </Badge>
              </div>

              {expanded && (
                <div className="mt-1 space-y-1.5 border-t border-border pt-3" onClick={(e) => e.stopPropagation()}>
                  <p className="mb-1 text-caption font-semibold text-text-secondary">버전 선택</p>
                  {sorted.map((ver) => {
                    const reason = registryVersionUsabilityReason(ver.status);
                    const usable = !reason;
                    const verSelected = value?.source === "registry" && value.versionId === ver.id;
                    return (
                      <button
                        key={ver.id}
                        type="button"
                        disabled={!usable}
                        onClick={() => {
                          const selection = toAgentSelection(asset, ver);
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

      {loading && <LoadingState label="등록된 Agent 자산을 확인하는 중..." />}
      {error && !error.permission && (
        <ErrorBanner message={`등록된 Agent 목록을 불러오지 못했습니다: ${error.message}. 표준 Agent는 계속 선택할 수 있습니다.`} />
      )}
      {error && error.permission && (
        <ErrorBanner message="등록된 Agent 목록을 조회할 권한이 없습니다. 표준 Agent는 계속 선택할 수 있습니다." />
      )}
      {!loading && !error && registeredCards.length === 0 && (
        <EmptyState
          icon={<Inbox size={32} strokeWidth={1.5} />}
          title="아직 등록된 Agent 자산이 없습니다."
          description="표준 Agent는 위에서 계속 선택할 수 있습니다. Portal에 Agent를 등록하면 여기에 함께 나타납니다."
          action={
            <a href="/assets/new/agent" className="text-sm font-medium text-brand-600 hover:underline">
              Agent 등록하러 가기 →
            </a>
          }
        />
      )}
      {!loading && !error && q && filteredStandard.length === 0 && filteredRegistered.length === 0 && (
        <p className="text-body text-text-muted">검색어와 일치하는 Agent가 없습니다.</p>
      )}
    </div>
  );
}
