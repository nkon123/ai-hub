// D-079 — pure helper shared by ImportScreen/StoreScreen: which items of a
// just-completed install plan are Knowledge assets worth attempting
// activation for. No network/Electron dependency (same convention as
// `storeTypes.ts`/`assetsTypes.ts`) so this is directly Vitest-able.
import type { IncludedAssetSummary } from "../../electron/types";

export interface KnowledgeActivationTarget {
  assetId: string;
  version: string;
  /** Display name for the inline activation status line — falls back to
   * `assetId` in the UI when this is null (Bundle 매니페스트가 이름을 담지
   * 않는 STANDARD_LOCAL_COPY 등). */
  name: string | null;
}

export interface McpToolConnectionTarget {
  assetId: string;
  version: string;
  name: string | null;
}

/** `IncludedAssetSummary.asset_id`/`.version` are nullable on the wire (D-060:
 * a STANDARD_LOCAL_COPY item, or a Bundle built before the field existed) —
 * an item missing either can never be looked up as an installed record, so
 * it is simply not a candidate for activation (never guessed at). */
export function knowledgeActivationTargets(installPlan: IncludedAssetSummary[]): KnowledgeActivationTarget[] {
  return installPlan
    .filter((item): item is IncludedAssetSummary & { asset_id: string; version: string } =>
      item.asset_type === "knowledge" && typeof item.asset_id === "string" && typeof item.version === "string",
    )
    .map((item) => ({ assetId: item.asset_id, version: item.version, name: item.name }));
}

/** 설치 직후 MCP Tool도 같은 한 번의 흐름에서 agent-runtime에 연결한다.
 * 누락된 식별자는 Knowledge와 마찬가지로 추측하지 않고 제외한다. */
export function mcpToolConnectionTargets(installPlan: IncludedAssetSummary[]): McpToolConnectionTarget[] {
  return installPlan
    .filter((item): item is IncludedAssetSummary & { asset_id: string; version: string } =>
      item.asset_type === "mcp_tool" && typeof item.asset_id === "string" && typeof item.version === "string",
    )
    .map((item) => ({ assetId: item.asset_id, version: item.version, name: item.name }));
}
