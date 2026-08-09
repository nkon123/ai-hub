// D12 업데이트/복구 — 순수 로직(그룹핑/정렬/판정). 렌더링과 분리해 Vitest로
// 검증한다(`assetsTypes.ts`/`chatTypes.ts`와 동일한 관례).
import type { InstalledAssetWithStatus } from "../../electron/types";

export interface AssetVersionGroup {
  assetType: string;
  assetId: string;
  /** 그룹 내 아무 버전에서나 가져온 표시용 이름 — 모든 버전이 보통 같은
   * 이름을 쓰지만, 다르더라도(개명) Active 버전의 이름을 우선한다. */
  name: string;
  /** 버전 내림차순(semver 숫자 비교) — 최신 버전이 먼저 온다. */
  versions: InstalledAssetWithStatus[];
}

function versionCompareDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true });
}

/** 설치된 자산 목록을 (assetType, assetId) 기준으로 묶는다 — D12 화면이
 * "이 자산의 여러 버전 중 무엇을 Active로 할지" 다루려면 먼저 이 그룹핑이
 * 필요하다. 버전이 하나뿐인 그룹도 포함한다(전환할 대상은 없지만 여전히
 * "설치된 자산" 목록의 일부이므로 화면에서 그 사실을 보여줘야 한다). */
export function groupInstalledAssetsByAssetId(assets: InstalledAssetWithStatus[]): AssetVersionGroup[] {
  const groups = new Map<string, AssetVersionGroup>();
  for (const asset of assets) {
    const key = `${asset.assetType}::${asset.assetId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.versions.push(asset);
      if (asset.status === "ACTIVE") existing.name = asset.name;
    } else {
      groups.set(key, { assetType: asset.assetType, assetId: asset.assetId, name: asset.name, versions: [asset] });
    }
  }
  for (const group of groups.values()) {
    group.versions.sort((a, b) => versionCompareDesc(a.version, b.version));
  }
  return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** 그룹 안에서 실제로 전환/Rollback 대상이 될 수 있는(=버전이 2개 이상인)
 * 그룹만 남긴다 — 버전이 하나뿐인 자산은 Diff/전환 자체가 의미 없다. */
export function switchableGroups(groups: AssetVersionGroup[]): AssetVersionGroup[] {
  return groups.filter((g) => g.versions.length >= 2);
}

export function findActiveVersion(group: AssetVersionGroup): InstalledAssetWithStatus | null {
  return group.versions.find((v) => v.status === "ACTIVE") ?? null;
}

/** D12 "Active Pointer 전환" 버튼의 사용 가능 여부/사유 — `activateAssetVersion`
 * (`electron/asset-management.ts`)이 서버 측에서 실제로 강제하는 규칙을
 * 그대로 미러링한다(버튼이 허용하지 않는 선택을 서버가 뒤늦게 거부하는 게
 * 아니라, 애초에 같은 이유로 비활성화되어 있어야 한다). */
export function activateDisabledReason(asset: InstalledAssetWithStatus): string | null {
  if (asset.status === "ACTIVE") return "이미 Active 버전입니다.";
  if (asset.status === "REVOKED") return "회수(Revoked)된 버전은 Active로 전환할 수 없습니다.";
  if (asset.status === "INVALID") return "Checksum 재검사에 실패한(Invalid) 버전은 Active로 전환할 수 없습니다.";
  return null;
}

/** 버튼 라벨 결정: 대상 버전이 현재 Active 버전보다 semver상 낮으면(오래된
 * 버전으로 돌아가는 것이면) "Rollback"이라고 부르고, 그 외(활성 버전이
 * 아직 없거나, 대상이 더 최신 버전)에는 "전환"이라고 부른다 — 코드 경로는
 * 완전히 동일하다(`ActiveVersionStore.set`), 사용자에게 보여주는 문구만
 * 다르다.
 */
export function activationActionLabel(group: AssetVersionGroup, targetVersion: string): "전환" | "Rollback" {
  const active = findActiveVersion(group);
  if (!active) return "전환";
  return versionCompareDesc(targetVersion, active.version) > 0 ? "Rollback" : "전환";
}
