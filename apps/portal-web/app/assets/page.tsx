"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Inbox, Plus, Search, Wrench } from "lucide-react";
import {
  Button,
  EmptyState,
  ErrorBanner,
  LoadingState,
  PageHeader,
  inputClass,
} from "../_components/ui";
import { useRole } from "../_components/role-context";
import { AssetList, assetDetailHref, type Asset } from "../_components/asset-list";

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
          <option value="mcp_server">MCP 서버</option>
          <option value="mcp_tool">MCP Tool (이전 방식)</option>
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

      <AssetList assets={assets} onSelect={(asset) => router.push(assetDetailHref(asset))} />
    </div>
  );
}
