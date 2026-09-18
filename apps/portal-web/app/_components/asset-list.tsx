"use client";

/**
 * 자산 목록 렌더링과 유형 메타데이터의 단일 출처.
 *
 * 전체 카탈로그(`/assets`)와 유형별 목록(`/assets/knowledge`,
 * `/assets/prompts`, `/assets/mcp`)이 같은 카드를 그린다 — 아이콘·라벨·색과
 * "자산 하나를 눌렀을 때 어디로 가는가"가 화면마다 갈라지지 않도록 여기
 * 한 곳에만 둔다.
 */

import { BookOpen, Bot, Lightbulb, Server, Settings, Wrench, type LucideIcon } from "lucide-react";
import { Card, StatusBadge } from "./ui";

export interface AssetVersionSummary {
  id: string;
  version: string;
  status: string;
  created_at: string;
}

export interface Asset {
  id: string;
  type: string;
  name: string;
  owner_org: string;
  classification: string;
  created_at: string;
  versions: AssetVersionSummary[];
}

export const ASSET_TYPE_ICON: Record<string, LucideIcon> = {
  knowledge: BookOpen,
  agent: Bot,
  prompt: Lightbulb,
  mcp_tool: Wrench,
  mcp_server: Server,
  service: Settings,
};

export const ASSET_TYPE_LABEL: Record<string, string> = {
  knowledge: "Knowledge",
  agent: "Agent",
  prompt: "Prompt",
  mcp_tool: "MCP Tool",
  mcp_server: "MCP 서버",
  service: "AI Service",
};

export const ASSET_TYPE_TONE: Record<string, string> = {
  knowledge: "bg-asset-knowledge/10 text-asset-knowledge",
  mcp_tool: "bg-asset-tool/10 text-asset-tool",
  mcp_server: "bg-asset-tool/10 text-asset-tool",
  agent: "bg-asset-agent/10 text-asset-agent",
  prompt: "bg-asset-prompt/10 text-asset-prompt",
  service: "bg-asset-workflow/10 text-asset-workflow",
};

/** Knowledge 만 전용 상세(P06)가 있고, 나머지 유형은 버전 목록이 상세다. */
export function assetDetailHref(asset: Asset) {
  return asset.type === "knowledge" ? `/assets/${asset.id}` : `/assets/${asset.id}/versions`;
}

export function latestVersion(asset: Asset): AssetVersionSummary | undefined {
  return [...asset.versions].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )[0];
}

export function AssetList({
  assets,
  onSelect,
}: {
  assets: Asset[];
  onSelect: (asset: Asset) => void;
}) {
  return (
    <div className="grid gap-3">
      {assets.map((asset) => {
        const ver = latestVersion(asset);
        const TypeIcon = ASSET_TYPE_ICON[asset.type] ?? BookOpen;
        return (
          <Card key={asset.id} onClick={() => onSelect(asset)} className="flex items-center gap-4 px-5 py-4">
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                ASSET_TYPE_TONE[asset.type] ?? "bg-slate-100 text-text-muted"
              }`}
            >
              <TypeIcon size={19} strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-card-title font-semibold text-text-primary">{asset.name}</div>
              <div className="mt-0.5 text-caption text-text-secondary">
                {ASSET_TYPE_LABEL[asset.type] ?? asset.type} · {asset.owner_org} ·{" "}
                {new Date(asset.created_at).toLocaleDateString("ko-KR")}
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
  );
}
