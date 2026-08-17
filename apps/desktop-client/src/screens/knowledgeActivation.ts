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
  assetType: "prompt";
  name: string | null;
}

/** Prompt 자산은 설치 이후 그 자체로는 별도 활성화·연결 단계가 없다 — 다른
 * 설치된 Agent가 이 Prompt를 짝으로 골라 등록할 때만 쓰인다(D-034 해석
 * 경로 4, `agentRegistrationGuidanceTargets` 참고). "설치됨"과 "쓸 수 있음"을
 * 혼동하지 않도록, 아무 것도 더 필요하지 않다는 사실 자체를 명시적으로
 * 보여주기 위한 목록이다.
 *
 * Agent는 더 이상 이 목록에 없다(2026-08-17 정정) — PR A(D-034 해석 경로 4)
 * 이전에는 Desktop 채팅이 설치된 Agent Package를 전혀 실행하지 않아 "설치
 * 외에 별도로 활성화·연결할 절차가 없습니다"가 사실이었지만, 지금은 설치된
 * Agent를 Prompt와 짝지어 agent-runtime에 등록해야 대화에서 실제로 선택해
 * 쓸 수 있다 — 아래 `agentRegistrationGuidanceTargets`가 그 사실과 다음
 * 행동을 안내한다. Desktop 채팅은 여전히 Agent Package의 `workflow.roles[]`를
 * 실행 그래프로 로딩하지 않는다(capabilities/limits/entry_role + 짝
 * Prompt의 template만 적용된다, PR A의 계약 docstring) — 이 목록/안내
 * 어디에도 "워크플로 실행"이라고 적지 않는다. */
export function noFurtherActionTargets(installPlan: IncludedAssetSummary[]): NoFurtherActionTarget[] {
  return installPlan
    .filter(
      (item): item is IncludedAssetSummary & { asset_id: string; asset_type: "prompt" } =>
        item.asset_type === "prompt" && typeof item.asset_id === "string",
    )
    .map((item) => ({ assetId: item.asset_id, assetType: item.asset_type, name: item.name }));
}

export interface AgentRegistrationGuidanceTarget {
  assetId: string;
  version: string;
  name: string | null;
}

/** D-034 해석 경로 4 이어 붙이기 — 방금 설치된 Agent는 여기서 자동으로
 * 등록을 시도하지 않는다(Knowledge/MCP Tool과 다른 점). 이유: 등록은
 * Agent+Prompt "짝"을 만드는 것이고, 어떤 Prompt와 짝지을지는 이름 유사도로
 * 추측할 수 없다(Task Brief 제약 C) — 사용자가 설치된 자산 화면에서 직접
 * Prompt를 골라야 한다. 이 목록은 그 사실과 다음 행동을 안내하는 용도일
 * 뿐이다(Knowledge/MCP Tool의 자동 시도 결과 표시와는 형태가 다르다). */
export function agentRegistrationGuidanceTargets(installPlan: IncludedAssetSummary[]): AgentRegistrationGuidanceTarget[] {
  return installPlan
    .filter(
      (item): item is IncludedAssetSummary & { asset_id: string; version: string; asset_type: "agent" } =>
        item.asset_type === "agent" && typeof item.asset_id === "string" && typeof item.version === "string",
    )
    .map((item) => ({ assetId: item.asset_id, version: item.version, name: item.name }));
}
