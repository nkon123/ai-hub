// D08 로컬 자산 관리 — "제거 전 참조 중인 Service와 진행 중인 Run을 확인한다"
// (`02-desktop-and-agent-runtime.md` D08)의 실제 판정 로직. 순수 함수 —
// fs/네트워크 접근은 호출자(`asset-management.ts`)가 담당하고, 이 모듈은
// 이미 수집된 사실만으로 차단 여부를 결정한다.
//
// 두 근거의 신뢰 수준이 다르다는 점이 이 모듈의 핵심 설계 포인트:
//  - `referencingServices`는 로컬 파일(설치된 Service의
//    `service-definition.json`)에서 직접 읽은 사실이라 항상 확정적이다.
//  - `activeRunUsages`는 Local Agent Runtime(:8100)이 "이 Run이 어떤 자산을
//    쓰고 있는지" 조회할 수단을 아직 제공하지 않는다(Run 목록 API 없음,
//    Service Registry 미도입 — open-decisions.md D-058/D-070). 그래서 이
//    값은 `null`(조회 불가 — "실행 중인 Run 없음"으로 단정할 수 없음)과
//    `[]`(조회했고 실제로 없음)을 반드시 구분한다. `null`을 빈 배열처럼
//    취급하면 "확인했더니 안전하다"는 거짓 확신을 사용자에게 주게 된다.
export interface ActiveRunAssetUsage {
  runId: string;
  status: string;
  assetType: string;
  assetId: string;
  /** `null`이면 버전 무관하게 매칭(오늘 시점 이 필드를 채워 줄 실제 소스가
   * 없으므로 대부분 `null`이 된다 — 그래도 자산 유형+id만으로 보수적으로
   * 차단하는 편이 놓치는 것보다 안전하다). */
  version: string | null;
}

/** D12/D-068: whether `target` (a specific assetType+assetId+version) is
 * currently the Active Pointer for its assetId, and whether switching away
 * from it before removal is even possible (another installed version could
 * become the new active one). Both facts come from real data
 * (`active-version-store.ts` + `InstalledAssetsStore`) — this module only
 * decides what to do with them. */
export interface ActivePointerInput {
  isActiveVersion: boolean;
  /** True when at least one OTHER installed version of the same asset
   * exists and could be switched to. If this is the only installed version,
   * removing it removes the asset entirely — there is nothing to "switch to
   * first", so it is not blocked on this ground. */
  otherVersionsInstalled: boolean;
}

export interface RemovalGuardInput {
  target: import("./service-dependencies").AssetRef;
  referencingServices: import("./service-dependencies").ReferencingService[];
  /** `null` = Local Agent Runtime에서 조회 자체가 불가능했음(open-decisions.md
   * 참고). 빈 배열과 다르다 — 위 모듈 docstring 참고. */
  activeRunUsages: ActiveRunAssetUsage[] | null;
  /** `undefined`/`null` = Active Pointer 개념이 적용되지 않는 호출(레거시
   * 호출자 하위 호환용) — 이 축으로는 차단하지 않는다. D12/D08의 실제
   * 호출자는 항상 이 값을 채워 넘긴다. */
  activePointer?: ActivePointerInput | null;
}

export interface RemovalGuardResult {
  blocked: boolean;
  referencingServices: import("./service-dependencies").ReferencingService[];
  blockingRuns: ActiveRunAssetUsage[];
  /** `false`면 `activeRunUsages`가 `null`이었다는 뜻 — UI는 이때 "확인 결과
   * 없음(안전)"이 아니라 "확인 불가"로 표시해야 한다. */
  runCheckAvailable: boolean;
  /** 항상 채워지는 한국어 설명 — 차단/허용/확인불가 어느 경우든 이유를 함께
   *보여줘야 한다는 CLAUDE.md UI 규칙("호환되지 않는 선택지는 이유와 함께
   * 비활성화한다")을 제거 액션에도 동일하게 적용한다. */
  runCheckNote: string;
  /** True when this removal is blocked specifically because `target` is the
   * Active Version and another installed version exists to switch to first
   * (D12 "Active Pointer 전환"을 먼저 하라는 안내). */
  blockedByActiveVersion: boolean;
  /** Korean explanation for the active-version axis, or `null` when it does
   * not apply (no pointer concept for this call, or not the active version,
   * or it's the only installed version so removal just removes the asset). */
  activeVersionNote: string | null;
}

const RUN_CHECK_UNAVAILABLE_NOTE =
  "Local Agent Runtime이 현재 실행 중인 Run과 사용 중인 자산을 연결해 조회할 방법을 제공하지 않아(Service Registry 미도입) 자동으로 확인할 수 없습니다. 제거 전 진행 중인 대화가 없는지 직접 확인하세요(open-decisions.md D-070).";

function matchesTarget(usage: ActiveRunAssetUsage, target: import("./service-dependencies").AssetRef): boolean {
  if (usage.assetType !== target.assetType || usage.assetId !== target.assetId) return false;
  return usage.version === null || usage.version === target.version;
}

export function evaluateAssetRemoval(input: RemovalGuardInput): RemovalGuardResult {
  const blockingRuns = (input.activeRunUsages ?? []).filter((usage) => matchesTarget(usage, input.target));
  const runCheckAvailable = input.activeRunUsages !== null;

  const pointer = input.activePointer ?? null;
  const blockedByActiveVersion = Boolean(pointer?.isActiveVersion && pointer.otherVersionsInstalled);

  const blocked = input.referencingServices.length > 0 || blockingRuns.length > 0 || blockedByActiveVersion;

  let runCheckNote: string;
  if (!runCheckAvailable) {
    runCheckNote = RUN_CHECK_UNAVAILABLE_NOTE;
  } else if (blockingRuns.length > 0) {
    runCheckNote = `이 자산을 사용 중인 Run이 ${blockingRuns.length}건 있어 제거할 수 없습니다.`;
  } else {
    runCheckNote = "현재 이 자산을 사용 중인 것으로 확인되는 Run이 없습니다.";
  }

  let activeVersionNote: string | null = null;
  if (blockedByActiveVersion) {
    activeVersionNote =
      "이 버전은 현재 Active Version입니다. 다른 설치된 버전으로 먼저 전환한 뒤에 제거할 수 있습니다(D12 업데이트/복구).";
  } else if (pointer?.isActiveVersion) {
    activeVersionNote = "이 버전은 현재 Active Version이지만, 다른 설치된 버전이 없어 제거하면 이 자산 전체가 제거됩니다.";
  }

  return {
    blocked,
    referencingServices: input.referencingServices,
    blockingRuns,
    runCheckAvailable,
    runCheckNote,
    blockedByActiveVersion,
    activeVersionNote,
  };
}
