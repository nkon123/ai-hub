// 자산 스토어 — Portal 카탈로그 항목의 설치 상태를 계산하는 순수 로직.
// 렌더링과 분리해 Vitest로 검증한다(`assetsTypes.ts`/`chatTypes.ts`와 동일한
// 관례). 네트워크·Electron 의존성이 전혀 없다 — 브라우저에서도 그대로
// import 가능해야 한다(Bridge 없는 환경에서도 이 모듈 자체는 깨지지 않음).
import type { InstalledAssetWithStatus, PortalCatalogAsset, PortalCatalogVersion } from "../../electron/types";

export type CatalogInstallState = "INSTALLED" | "INSTALLABLE" | "UPDATE_AVAILABLE" | "NOT_INSTALLABLE";

export interface CatalogItemView {
  asset: PortalCatalogAsset;
  state: CatalogInstallState;
  /** 설치 대상이 될 버전(승인된 버전 중 최신) — `NOT_INSTALLABLE`이면 null. */
  installableVersion: PortalCatalogVersion | null;
  /** 현재 로컬에 설치된 버전 문자열 — 없으면 null. */
  installedVersion: string | null;
  /** `NOT_INSTALLABLE`일 때만 채워지는 한국어 사유 — CLAUDE.md: "호환되지
   * 않는 선택지는 이유와 함께 비활성화한다". 승인되지 않은 자산을 목록에서
   * 조용히 숨기지 않고 항상 사유와 함께 보여준다. */
  reason: string | null;
}

/** major.minor.patch(또는 그 이상/이하 구간 수)를 숫자 구간별로 비교한다.
 * 숫자로 파싱되지 않는 구간을 만나면 문자열 비교로 대체한다(버전 형식이
 * 어긋난 데이터라도 예외를 던지지 않음 — Desktop은 장애 시 종료되지
 * 않는다). */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".");
  const partsB = b.split(".");
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i += 1) {
    const rawA = partsA[i] ?? "0";
    const rawB = partsB[i] ?? "0";
    const numA = Number(rawA);
    const numB = Number(rawB);
    if (Number.isNaN(numA) || Number.isNaN(numB)) {
      return a.localeCompare(b);
    }
    if (numA !== numB) return numA - numB;
  }
  return 0;
}

function latestBy<T>(items: T[], versionOf: (item: T) => string): T | null {
  if (items.length === 0) return null;
  return items.reduce((best, item) => (compareVersions(versionOf(item), versionOf(best)) > 0 ? item : best));
}

export function latestApprovedVersion(versions: PortalCatalogVersion[]): PortalCatalogVersion | null {
  return latestBy(
    versions.filter((v) => v.status === "APPROVED"),
    (v) => v.version,
  );
}

// `security_policy.transitions.VersionStatus` 전체(APPROVED 제외)에 대한
// 한국어 사유 — 새 상태값이 추가되면 이 map에도 추가해야 하며, 누락 시
// 아래 `notInstallableReason`이 원문 상태 코드를 그대로 보여준다(추측해서
// 그럴듯한 문구를 지어내지 않는다).
const STATUS_REASON_KO: Record<string, string> = {
  DRAFT: "초안 상태",
  VALIDATING: "자동 검증 중",
  READY_FOR_REVIEW: "검토 대기 중",
  IN_REVIEW: "검토 진행 중",
  CHANGES_REQUESTED: "수정 요청 상태",
  REJECTED: "반려됨",
  SUSPENDED: "일시 중단(Suspended)됨",
  DEPRECATED: "지원 종료(Deprecated)됨",
  RETIRED: "폐기(Retired)됨",
};

/** 자산에 승인된 버전이 하나도 없을 때 보여줄 사유. 버전 중 semver상 가장
 * 높은 것을 기준으로 설명한다 — "최신 버전이 아직 승인되지 않았다"가
 * 사용자가 가장 궁금해할 정보이기 때문이다.
 *
 * 참고(D-072로 해소): 과거에는 긴급 회수(Revocation)가 `GET /api/v1/assets`
 * 응답에 전혀 포함되지 않아 이 함수가 회수 여부를 추측하지 않는 쪽을
 * 택했었다. 이제 portal-api가 `AssetVersionOut.active_revocation`(효력이
 * 이미 시작된 회수만, `AssetVersionRevocationSummary` 참고)을 채워 보내므로
 * 회수는 이 함수가 아니라 `computeCatalogItemView`가 `latestApprovedVersion`
 * 자체에서 직접 처리한다(그 버전을 설치 대상에서 완전히 제외하고 사유를
 * 채운다) — 여기서는 여전히 "승인된 버전이 아예 없다" 경우만 다룬다.
 */
export function notInstallableReason(versions: PortalCatalogVersion[]): string {
  if (versions.length === 0) return "등록된 버전이 없습니다.";
  const latest = latestBy(versions, (v) => v.version)!;
  const label = STATUS_REASON_KO[latest.status] ?? `알 수 없는 상태(${latest.status})`;
  return `승인된 버전이 없습니다 — 최신 버전(v${latest.version})이 ${label} 상태입니다.`;
}

/** D-072: 설치 대상이 될 승인된 버전이 실제로는 긴급 회수(Revocation)된
 * 경우의 사유 — `reason`이 서버에서 마스킹되어(role에 따라, 카탈로그
 * 조회 권한만으로는 사유 열람 불가) null일 수 있으므로 그 경우까지
 * 정직하게 문구를 나눈다(없는 사유를 지어내지 않는다). */
export function revokedInstallReason(version: PortalCatalogVersion): string {
  const base = `승인된 버전(v${version.version})이 긴급 회수(Revocation)되어 설치할 수 없습니다.`;
  const reason = version.activeRevocation?.reason;
  return reason ? `${base} 사유: ${reason}` : `${base} 사유는 관리자에게 문의하세요.`;
}

export function computeCatalogItemView(
  asset: PortalCatalogAsset,
  installed: InstalledAssetWithStatus[],
): CatalogItemView {
  const installableVersion = latestApprovedVersion(asset.versions);
  const installedMatches = installed.filter((i) => i.assetType === asset.type && i.assetId === asset.id);
  const installedLatest = latestBy(installedMatches, (i) => i.version);

  if (!installableVersion) {
    return {
      asset,
      state: "NOT_INSTALLABLE",
      installableVersion: null,
      installedVersion: installedLatest?.version ?? null,
      reason: notInstallableReason(asset.versions),
    };
  }

  if (installableVersion.activeRevocation) {
    // D-072: the latest APPROVED version has been emergency-revoked.
    // Deliberately do NOT fall back to an older APPROVED version here —
    // silently installing a superseded version to dodge a visible
    // revocation would be worse than showing nothing (CLAUDE.md: "호환되지
    // 않는 선택지는 이유와 함께 비활성화한다"). Show the whole asset as
    // blocked, with the reason, exactly like the "no approved version"
    // case above.
    return {
      asset,
      state: "NOT_INSTALLABLE",
      installableVersion: null,
      installedVersion: installedLatest?.version ?? null,
      reason: revokedInstallReason(installableVersion),
    };
  }

  if (!installedLatest) {
    return { asset, state: "INSTALLABLE", installableVersion, installedVersion: null, reason: null };
  }

  const cmp = compareVersions(installedLatest.version, installableVersion.version);
  if (cmp >= 0) {
    return {
      asset,
      state: "INSTALLED",
      installableVersion,
      installedVersion: installedLatest.version,
      reason: null,
    };
  }
  return {
    asset,
    state: "UPDATE_AVAILABLE",
    installableVersion,
    installedVersion: installedLatest.version,
    reason: null,
  };
}

export function computeCatalogView(
  assets: PortalCatalogAsset[],
  installed: InstalledAssetWithStatus[],
): CatalogItemView[] {
  return assets.map((asset) => computeCatalogItemView(asset, installed));
}

/** 스토어 화면의 유형 필터 값. `PortalCatalogAsset.type`이 실제로 가질 수
 * 있는 값(agent/knowledge/mcp_tool/prompt — Service는 별도 테이블이라
 * `GET /api/v1/assets` 카탈로그에 나타나지 않는다) 중 "전체"를 제외한
 * 모든 값을 열거한다. 필터 버튼이 늘어나는 대신, "전체" 탭은 이 값들을
 * 넘어서는 자산도 항상 포함한다(새 asset_type이 서버에 추가돼도 "전체"에서
 * 조용히 사라지지 않는다). */
export const STORE_ASSET_TYPE_FILTERS = ["knowledge", "agent", "prompt", "mcp_tool"] as const;
export type StoreAssetTypeFilter = "all" | (typeof STORE_ASSET_TYPE_FILTERS)[number];

export function filterCatalogView(
  views: CatalogItemView[],
  filters: { query: string; assetType: StoreAssetTypeFilter },
): CatalogItemView[] {
  const query = filters.query.trim().toLocaleLowerCase("ko-KR");
  return views.filter((view) => {
    if (filters.assetType !== "all" && view.asset.type !== filters.assetType) return false;
    if (!query) return true;
    return view.asset.name.toLocaleLowerCase("ko-KR").includes(query);
  });
}
