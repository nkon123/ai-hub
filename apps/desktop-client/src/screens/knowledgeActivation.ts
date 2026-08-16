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

export interface NoFurtherActionTarget {
  assetId: string;
  assetType: "agent" | "prompt";
  name: string | null;
}

/** Agent/Prompt 자산은 이 저장소의 현재 아키텍처에서 설치 이후 별도
 * 활성화·연결 단계가 없다 — Desktop 채팅은 Agent Package의 Workflow를
 * 로딩해 실행하지 않고 Knowledge 검색과 (opt-in) MCP Tool 호출을 직접
 * 조합한다(D-078/D-083/D-084). 설치된 Agent/Prompt는 자산 관리(D08)에서
 * Manifest를 확인하거나 Service의 의존성으로 참조되는 용도로 쓰인다.
 * "설치됨"과 "쓸 수 있음"을 혼동하지 않도록, 아무 것도 더 필요하지 않다는
 * 사실 자체를 명시적으로 보여주기 위한 목록이다(Knowledge/MCP Tool처럼
 * 진행 중 상태를 갖지 않는다 — 있는 것과 없는 것을 같은 자리에서 구분). */
export function noFurtherActionTargets(installPlan: IncludedAssetSummary[]): NoFurtherActionTarget[] {
  return installPlan
    .filter(
      (item): item is IncludedAssetSummary & { asset_id: string; asset_type: "agent" | "prompt" } =>
        (item.asset_type === "agent" || item.asset_type === "prompt") && typeof item.asset_id === "string",
    )
    .map((item) => ({ assetId: item.asset_id, assetType: item.asset_type, name: item.name }));
}
