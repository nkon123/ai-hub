// D08 로컬 자산 관리 — 순수 필터/정렬 로직. 렌더링과 분리해 Vitest로 검증한다
// (`chatTypes.ts`와 동일한 관례).
import type { AssetStatus, InstalledAssetWithStatus } from "../../electron/types";

export const ASSET_TYPE_OPTIONS = ["service", "agent", "knowledge", "prompt", "mcp_tool"] as const;
export type AssetTypeOption = (typeof ASSET_TYPE_OPTIONS)[number];

export const ASSET_STATUS_OPTIONS: AssetStatus[] = ["ACTIVE", "INACTIVE", "INVALID", "REVOKED"];

export interface AssetFilters {
  /** 빈 Set = 전체(필터 없음) — 스펙의 필터 카테고리(Service/Agent/Knowledge/
   * Prompt/MCP Config). */
  assetTypes: Set<string>;
  /** 빈 Set = 전체 — Active/Inactive/Invalid/Revoked. */
  statuses: Set<AssetStatus>;
}

export function emptyAssetFilters(): AssetFilters {
  return { assetTypes: new Set(), statuses: new Set() };
}

export function filterInstalledAssets(
  assets: InstalledAssetWithStatus[],
  filters: AssetFilters,
): InstalledAssetWithStatus[] {
  return assets.filter((a) => {
    if (filters.assetTypes.size > 0 && !filters.assetTypes.has(a.assetType)) return false;
    if (filters.statuses.size > 0 && !filters.statuses.has(a.status)) return false;
    return true;
  });
}

export type AssetSortKey = "version" | "sizeBytes" | "installedAt";
export type SortDirection = "asc" | "desc";

/** 스펙이 필터 항목으로 나열한 "버전, 크기, 설치일"을 실제로 비교 가능한 값
 * 3가지에 대한 정렬 기준으로 구현한다(범위 필터 UI 없이 정렬로 동일한 탐색
 * 목적을 달성) — semver 버전 문자열은 숫자 구간 단위로 비교한다. */
export function sortInstalledAssets(
  assets: InstalledAssetWithStatus[],
  key: AssetSortKey,
  direction: SortDirection = "desc",
): InstalledAssetWithStatus[] {
  const sorted = [...assets].sort((a, b) => {
    let cmp: number;
    if (key === "version") {
      cmp = a.version.localeCompare(b.version, undefined, { numeric: true });
    } else if (key === "sizeBytes") {
      cmp = a.sizeBytes - b.sizeBytes;
    } else {
      cmp = a.installedAt.localeCompare(b.installedAt);
    }
    return direction === "asc" ? cmp : -cmp;
  });
  return sorted;
}
