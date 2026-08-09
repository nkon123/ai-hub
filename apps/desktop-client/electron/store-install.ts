// 자산 스토어 설치 오케스트레이션 — "Portal에 Bundle 생성 요청 → 서버 폴링
// → 다운로드 → 기존 importBundle() 검증/설치" 순서를 조립한다.
//
// 절대 원칙(Task Brief): 이 파일은 압축을 풀거나 파일을 직접 검증하지
// 않는다. 다운로드한 바이트는 임시 파일로 한 번 저장된 뒤 오직
// `bundle-install.ts`의 `importBundle()`에만 전달된다 — 승인 버전 게이트,
// Revocation, Checksum, Zip Slip/Zip Bomb/실행파일 정책, 15단계 체크리스트를
// 포함한 기존 검증 전체가 그대로 적용된다. 이 파일이 별도의 두 번째 추출
// 경로를 만드는 순간 그것은 버그다.
import type { InstallRootLayout } from "./bundle-install";
import { importBundle as realImportBundle } from "./bundle-install";
import type { PortalApiResult, DistributionStatusView, CreateDistributionBody } from "./portal-client";
import type {
  ImportProgressEvent,
  ImportResult,
  StoreInstallProgressEvent,
  StoreInstallResult,
  StoreInstallStage,
} from "./types";

export interface StoreInstallTarget {
  assetType: string;
  assetId: string;
  /** `POST /api/v1/distributions`의 `root_id` — AssetVersion id(설치 가능한
   * 유일한 대상은 APPROVED 버전이며, 이 값의 선택은 호출자(`storeTypes.ts`의
   * 계산 결과)의 책임이지 이 파일의 책임이 아니다). */
  assetVersionId: string;
}

export interface PortalConnection {
  baseUrl: string;
  token: string;
}

/** 테스트가 네트워크/파일시스템 없이 전체 흐름을 검증할 수 있도록 하는
 * 의존성 주입 지점. 운영 배선(`main.ts`)은 `portal-client.ts`의 실제 HTTP
 * 함수와 실제 `importBundle`, 실제 `fs` 기반 임시 파일 helper를 사용한다. */
export interface StoreInstallDeps {
  requestDistribution: (
    baseUrl: string,
    token: string,
    body: CreateDistributionBody,
  ) => Promise<PortalApiResult<{ id: string; status: string }>>;
  getDistribution: (
    baseUrl: string,
    token: string,
    id: string,
  ) => Promise<PortalApiResult<DistributionStatusView>>;
  downloadDistribution: (baseUrl: string, token: string, id: string) => Promise<PortalApiResult<Buffer>>;
  /** 시그니처는 `bundle-install.ts`의 `importBundle`과 정확히 동일해야 한다
   * — 실제 배선에서 그 함수 자체를 그대로 넘긴다(재구현 금지). */
  importBundle: typeof realImportBundle;
  /** 다운로드한 바이트를 임시 파일로 저장하고 경로를 반환한다. */
  writeTempFile: (data: Buffer) => string;
  removeTempFile: (filePath: string) => void;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  maxPollAttempts: number;
}

/** 폴링 도중 사용자가 취소를 누르면 main.ts가 이 객체의 `cancelled`를
 * true로 바꾼다 — Promise 취소가 아니라 협조적 폴링 중단(다음 체크포인트에서
 * 확인)이다. 로컬 검증(`importBundle`) 단계 진입 후에는 더 이상 확인하지
 * 않는다(그 함수 자체가 취소를 지원하지 않고, 이미 다운로드된 바이트의
 * 검증을 중간에 끊는 것은 안전 이득이 없다). */
export interface CancelToken {
  cancelled: boolean;
}

const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cancelledResult(stage: StoreInstallStage): StoreInstallResult {
  return {
    outcome: "FAILED",
    failedStage: stage,
    message: "사용자가 설치를 취소했습니다.",
    cancelled: true,
    importResult: null,
    retryable: true,
  };
}

export async function installFromStore(
  layout: InstallRootLayout,
  target: StoreInstallTarget,
  portal: PortalConnection,
  emit: (event: StoreInstallProgressEvent) => void,
  deps: StoreInstallDeps,
  cancelToken: CancelToken = { cancelled: false },
): Promise<StoreInstallResult> {
  function fail(stage: StoreInstallStage, message: string, retryable: boolean): StoreInstallResult {
    emit({ stage, status: "FAIL", message });
    return { outcome: "FAILED", failedStage: stage, message, cancelled: false, importResult: null, retryable };
  }

  if (cancelToken.cancelled) return cancelledResult("REQUEST");

  emit({ stage: "REQUEST", status: "SKIP", message: "Portal에 Bundle 생성을 요청하는 중입니다." });
  const created = await deps.requestDistribution(portal.baseUrl, portal.token, {
    root_type: "ASSET_VERSION",
    root_id: target.assetVersionId,
    mode: "OFFLINE_BUNDLE",
  });
  if (!created.ok) {
    return fail("REQUEST", created.message, created.code === "PORTAL_UNREACHABLE");
  }
  emit({ stage: "REQUEST", status: "PASS", message: "Bundle 생성 요청이 접수되었습니다." });

  if (cancelToken.cancelled) return cancelledResult("SERVER_BUILD");

  emit({ stage: "SERVER_BUILD", status: "SKIP", message: "서버에서 Bundle을 생성하는 중입니다." });
  let finalStatus: DistributionStatusView | null = null;
  for (let attempt = 0; attempt < deps.maxPollAttempts; attempt += 1) {
    if (cancelToken.cancelled) return cancelledResult("SERVER_BUILD");

    const polled = await deps.getDistribution(portal.baseUrl, portal.token, created.data.id);
    if (!polled.ok) {
      return fail("SERVER_BUILD", polled.message, polled.code === "PORTAL_UNREACHABLE");
    }
    if (TERMINAL_STATUSES.has(polled.data.status)) {
      finalStatus = polled.data;
      break;
    }
    await deps.sleep(deps.pollIntervalMs);
  }
  if (finalStatus === null) {
    return fail("SERVER_BUILD", "Bundle 생성이 시간 내에 완료되지 않았습니다. 잠시 후 다시 시도하세요.", true);
  }
  if (finalStatus.status !== "SUCCEEDED") {
    const message =
      finalStatus.errorMessage ?? `Bundle 생성에 실패했습니다 (${finalStatus.errorCode ?? finalStatus.status}).`;
    return fail("SERVER_BUILD", message, finalStatus.retryable ?? false);
  }
  emit({ stage: "SERVER_BUILD", status: "PASS", message: "Bundle 생성이 완료되었습니다." });

  if (cancelToken.cancelled) return cancelledResult("DOWNLOAD");

  emit({ stage: "DOWNLOAD", status: "SKIP", message: "Bundle을 다운로드하는 중입니다." });
  const downloaded = await deps.downloadDistribution(portal.baseUrl, portal.token, created.data.id);
  if (!downloaded.ok) {
    return fail("DOWNLOAD", downloaded.message, downloaded.code === "PORTAL_UNREACHABLE");
  }
  emit({ stage: "DOWNLOAD", status: "PASS", message: "Bundle 다운로드가 완료되었습니다." });

  // 이 지점부터는 취소를 더 이상 확인하지 않는다 — importBundle()은 이미
  // 로컬 디스크에 있는 바이트에 대해 안전 검증을 수행할 뿐이라 중단해도
  // 시간을 아끼지 못하고, 부분 설치 상태를 남길 위험만 생긴다.
  const tempFilePath = deps.writeTempFile(downloaded.data);
  try {
    const importResult: ImportResult = await deps.importBundle(tempFilePath, layout, (event: ImportProgressEvent) => {
      emit({ stage: event.stage, status: event.status, message: event.message });
    });
    if (importResult.outcome === "SUCCESS") {
      return {
        outcome: "SUCCESS",
        failedStage: null,
        message: "설치가 완료되었습니다.",
        cancelled: false,
        importResult,
        retryable: true,
      };
    }
    return {
      outcome: "FAILED",
      failedStage: (importResult.failedStage as StoreInstallStage | null) ?? null,
      message: "다운로드한 Bundle의 검증/설치에 실패했습니다.",
      cancelled: false,
      importResult,
      retryable: importResult.retryable,
    };
  } finally {
    deps.removeTempFile(tempFilePath);
  }
}
