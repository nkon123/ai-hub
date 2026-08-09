// D08 로컬 자산 관리 — 필터에 쓰이는 Active/Inactive/Invalid/Revoked 상태 판정.
// 순수 함수만 포함(fs 없음). 호출자(`asset-management.ts`)가 revocation 목록과
// 설치 자산 레코드, 그리고 D12/D-068의 Active Pointer(`active-version-store.ts`)
// 조회 결과를 읽어 넘겨준다.
//
// **D-068 해소(D12 구현과 함께, 근거: `active-version-store.ts`)**: 설치
// 레이아웃에 이제 "Active Version"을 가리키는 실제 포인터가 존재한다(같은
// asset_id의 여러 버전이 나란히 설치된 채, 그중 하나만 `state/active-versions.json`에
// 기록됨). 이 함수는 그 포인터가 "이 assetId에 대해 실제로 기록돼 있을 때만"
// INACTIVE를 산출한다 — 포인터가 아예 없는 assetId(레거시 설치, 또는 아직
// D12에서 한 번도 전환한 적 없는 단일 버전 자산)는 여전히 근거 없이 INACTIVE를
// 지어내지 않고 ACTIVE로 취급한다(기존 원칙 그대로 유지).
import type { RevocationEntry } from "./bundle-verify";

export type AssetStatus = "ACTIVE" | "INACTIVE" | "INVALID" | "REVOKED";

export interface StatusInput {
  assetId: string;
  version: string;
  /** `undefined`/`null` = 아직 재검사한 적 없음(=REVOKED가 아니라면 ACTIVE로
   * 취급 — 재검사를 안 했다는 것이 곧 손상됐다는 뜻은 아니다). */
  checksumVerification?: { result: "PASS" | "FAIL" } | null;
}

export function computeAssetStatus(
  asset: StatusInput,
  revocationEntries: RevocationEntry[],
  /** 이 assetId에 대해 기록된 Active Pointer 버전 — `undefined`/`null`이면
   * "아직 포인터가 없음"(ACTIVE 취급, 위 docstring 참고). 값이 있고
   * `asset.version`과 다르면 이 버전은 INACTIVE다. */
  activeVersion?: string | null,
): AssetStatus {
  const revoked = revocationEntries.some(
    (r) => r.asset_id === asset.assetId && (r.version == null || r.version === asset.version),
  );
  if (revoked) return "REVOKED";
  if (asset.checksumVerification?.result === "FAIL") return "INVALID";
  if (activeVersion != null && activeVersion !== asset.version) return "INACTIVE";
  return "ACTIVE";
}

/** Bundle을 반입할 때마다 그 Bundle의 `policies/revocation-list.json` 항목을
 * 로컬에 누적 저장하기 위한 병합 — 나중에(별도 Import 없이) D08에서 상태를
 * 다시 계산할 수 있으려면 매 설치마다 이 목록을 영구 보관해야 한다. 같은
 * asset_id+version 키는 최신 값으로 덮어쓴다(재반입 시 최신 판단을 신뢰). */
export function mergeRevocationEntries(existing: RevocationEntry[], incoming: RevocationEntry[]): RevocationEntry[] {
  const byKey = new Map<string, RevocationEntry>();
  for (const entry of [...existing, ...incoming]) {
    if (!entry.asset_id) continue;
    byKey.set(`${entry.asset_id}::${entry.version ?? ""}`, entry);
  }
  return Array.from(byKey.values());
}
