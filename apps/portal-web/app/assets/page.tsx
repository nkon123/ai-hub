"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Bot, Inbox, Lightbulb, Plus, Search, Settings, Wrench } from "lucide-react";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  LoadingState,
  PageHeader,
  StatusBadge,
  inputClass,
} from "../_components/ui";
import { useRole } from "../_components/role-context";

interface AssetVersion {
  id: string;
  version: string;
  status: string;
  created_at: string;
}

interface Asset {
  id: string;
  type: string;
  name: string;
  owner_org: string;
  classification: string;
  created_at: string;
  versions: AssetVersion[];
}

const TYPE_ICON: Record<string, typeof BookOpen> = {
  knowledge: BookOpen,
  agent: Bot,
  prompt: Lightbulb,
  mcp_tool: Wrench,
  service: Settings,
};

const TYPE_LABEL: Record<string, string> = {
  knowledge: "Knowledge",
  agent: "Agent",
  prompt: "Prompt",
  mcp_tool: "MCP Tool",
  service: "AI Service",
};

const TYPE_TONE: Record<string, string> = {
  knowledge: "bg-asset-knowledge/10 text-asset-knowledge",
  mcp_tool: "bg-asset-tool/10 text-asset-tool",
  agent: "bg-asset-agent/10 text-asset-agent",
  prompt: "bg-asset-prompt/10 text-asset-prompt",
  service: "bg-asset-workflow/10 text-asset-workflow",
};

export default function AssetsPage() {
  const router = useRouter();
  const { role } = useRole();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetchAssets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, query, role.token]);

  async function fetchAssets() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (typeFilter) params.set("type", typeFilter);
      if (query) params.set("q", query);
      const res = await fetch(`/api/v1/assets?${params}`, {
        headers: { Authorization: `Bearer ${role.token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAssets(data.items);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const latestVersion = (asset: Asset) =>
    asset.versions.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

  return (
    <div>
      <PageHeader
        title="자산 카탈로그"
        description="승인할 자산을 관리하고 Desktop 설치 ZIP을 받을 수 있습니다."
        actions={
          <>
            <Button href="/assets/new/mcp_tool" variant="secondary">
              <Wrench size={16} /> MCP Tool 등록
            </Button>
            <Button href="/knowledge/new">
              <Plus size={16} /> Knowledge 등록
            </Button>
          </>
        }
      />

      <div className="mb-6 flex gap-3">
        <div className="relative w-60">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            placeholder="자산 이름 검색..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={`${inputClass} pl-9`}
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className={`${inputClass} w-auto`}
        >
          <option value="">모든 유형</option>
          <option value="knowledge">Knowledge</option>
          <option value="agent">Agent</option>
          <option value="prompt">Prompt</option>
          <option value="mcp_tool">MCP 도구</option>
          <option value="service">서비스</option>
        </select>
      </div>

      {loading && <LoadingState />}
      {error && <ErrorBanner message={`오류: ${error}`} />}
      {!loading && !error && assets.length === 0 && (
        <EmptyState
          icon={<Inbox size={40} strokeWidth={1.5} />}
          title="등록된 자산이 없습니다."
          action={
            <a href="/knowledge/new" className="text-sm font-medium text-brand-600 hover:underline">
              첫 번째 지식을 등록하세요 →
            </a>
          }
        />
      )}

      <div className="grid gap-3">
        {assets.map((asset) => {
          const ver = latestVersion(asset);
          const TypeIcon = TYPE_ICON[asset.type] ?? BookOpen;
          return (
            <Card
              key={asset.id}
              onClick={() => router.push(asset.type === "knowledge" ? `/assets/${asset.id}` : `/assets/${asset.id}/versions`)}
              className="flex items-center gap-4 px-5 py-4"
            >
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${TYPE_TONE[asset.type] ?? "bg-slate-100 text-text-muted"}`}>
                <TypeIcon size={19} strokeWidth={1.75} />
              </span>
              <div className="flex-1">
                <div className="text-card-title font-semibold text-text-primary">{asset.name}</div>
                <div className="mt-0.5 text-caption text-text-secondary">
                  {TYPE_LABEL[asset.type] ?? asset.type} · {asset.owner_org} · {new Date(asset.created_at).toLocaleDateString("ko-KR")}
                </div>
              </div>
              {ver && (
                <div className="flex items-center gap-2">
                  <span className="text-caption text-text-secondary">v{ver.version}</span>
                  <StatusBadge status={ver.status} />
                </div>
              )}
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-text-secondary">
                {asset.classification}
              </span>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
