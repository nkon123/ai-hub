// D-079 desktop half — main-process orchestration. All HTTP happens in the
// pure `search-runtime-client.ts`; this file only does fs lookups + the
// InstalledAssetsStore round-trip, same split `bundle-install.ts` keeps from
// `bundle-verify.ts` (and `asset-management.ts` from its own pure helpers).
//
// The core rule this file exists to enforce: "설치됨" and "활성화됨" are two
// separately visible facts. Every attempt outcome — success AND failure — is
// persisted via `InstalledAssetsStore.updateActivation` before returning, so
// a failure the user doesn't see right now is still visible later on the
// 설치된 자산 화면. Only the two refusals with nothing to attempt (record not
// found, wrong asset type) skip persistence — there is no InstalledAsset
// record to attach a KnowledgeActivation to in the "not found" case, and a
// non-Knowledge record is never activatable to begin with.

import fs from "node:fs";
import path from "node:path";
import { assetInstallDir } from "./asset-management";
import type { InstallRootLayout } from "./bundle-install";
import type { InstalledAssetsStore } from "./installed-assets-store";
import {
  listLocalKnowledgeIndexes,
  registerLocalKnowledgeIndex,
  unregisterLocalKnowledgeIndex,
  type FetchLike,
  type LocalIndexEntry,
} from "./search-runtime-client";
import type {
  ActivateKnowledgeResult,
  DeactivateKnowledgeResult,
  InstalledAsset,
  KnowledgeActivation,
  ReconcileKnowledgeActivationsResult,
} from "./types";

export interface KnowledgeActivationTarget {
  assetType: string;
  assetId: string;
  version: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function failedActivation(reason: string, message: string, indexPath: string | null): KnowledgeActivation {
  return { state: "FAILED", checkedAt: nowIso(), reason, message, indexPath };
}

/** D-079 이어 붙이기(central-index-exists-not-a-failure, 2026-08-13 실사용
 * 진단): search-runtime이 `central_index_exists`로 등록을 거부한 경우
 * 전용 — 이 Knowledge는 search-runtime의 중앙 INDEX_BASE에 이미 있어 별도
 * 등록 없이도 검색된다(서버 쪽 설계 불변식, 절대 바꾸지 않는다). `FAILED`와
 * 구분되는 별도 state로 저장해야 화면이 "활성화 실패"라는 거짓 알람을
 * 보여주지 않는다 — `electron/types.ts`의 `KnowledgeActivation` 문서 참고. */
function alreadyActiveActivation(message: string, indexPath: string | null): KnowledgeActivation {
  return { state: "ALREADY_ACTIVE", checkedAt: nowIso(), reason: "central_index_exists", message, indexPath };
}

/**
 * Looks up the installed record, verifies it is Knowledge with a real
 * AssetVersion id and an index folder on disk, then registers that folder
 * with search-runtime. Persists the outcome (ACTIVE or FAILED) either way.
 */
export async function activateInstalledKnowledge(
  layout: InstallRootLayout,
  store: InstalledAssetsStore,
  searchRuntimeBaseUrl: string,
  target: KnowledgeActivationTarget,
  fetchImpl?: FetchLike,
): Promise<ActivateKnowledgeResult> {
  const asset = store.find(target.assetType, target.assetId, target.version);
  if (!asset) {
    return { ok: false, activation: null, error: "설치된 자산을 찾을 수 없습니다." };
  }
  if (asset.assetType !== "knowledge") {
    // MCP Tool 활성화(agent-runtime/Office Profile 실행 레지스트리 연결)는
    // D-079의 나머지 절반이며 이번 범위에 포함되지 않는다 — Desktop이 아직
    // 시도조차 하지 않는다는 것을 명시적으로 알린다.
    return { ok: false, activation: null, error: "이 자산 유형은 활성화 대상이 아닙니다." };
  }

  // D-060의 핵심 교훈: assetVersionId가 없을 때 assetId로 대신하지 않는다.
  // `recoverLegacyKnowledgeAssetVersionIds`(asset-management.ts)가 체크섬으로
  // 검증 가능한 경우에만 이 값을 복구하며, 그 복구가 실패한 레코드는 여기서
  // "시도 자체가 불가능함"으로 명확히 실패 처리한다.
  if (!asset.assetVersionId) {
    const activation = failedActivation(
      "asset_version_id_missing",
      "최신 Bundle로 다시 설치하세요 — 이 설치 기록에는 검증된 AssetVersion 식별자가 없어 활성화할 수 없습니다(D-060).",
      null,
    );
    store.updateActivation(target.assetType, target.assetId, target.version, activation);
    return { ok: false, activation, error: null };
  }

  const indexDir = path.join(assetInstallDir(layout, "knowledge", target.assetId, target.version), "index");
  let indexDirExists = false;
  try {
    indexDirExists = fs.existsSync(indexDir) && fs.statSync(indexDir).isDirectory();
  } catch {
    indexDirExists = false;
  }
  if (!indexDirExists) {
    const activation = failedActivation(
      "index_dir_missing",
      "자산을 다시 설치하세요 — 설치된 자산에 index 폴더가 없어 활성화할 수 없습니다.",
      indexDir,
    );
    store.updateActivation(target.assetType, target.assetId, target.version, activation);
    return { ok: false, activation, error: null };
  }

  const result = await registerLocalKnowledgeIndex(
    searchRuntimeBaseUrl,
    { knowledgeId: asset.assetVersionId, indexPath: indexDir, label: `${asset.name} v${asset.version}` },
    fetchImpl,
  );

  if (!result.ok) {
    if (result.reason === "central_index_exists") {
      // 실패가 아니라 "이미 검색 가능함" — 위 alreadyActiveActivation 참고.
      // ok: true로 반환한다: 사용자 관점에서 이 Knowledge는 지금 채팅에서
      // 바로 검색 가능하고, 그것이 "활성화"가 하려던 일 그 자체다.
      const activation = alreadyActiveActivation(result.message, indexDir);
      store.updateActivation(target.assetType, target.assetId, target.version, activation);
      return { ok: true, activation, error: null };
    }
    const activation = failedActivation(result.reason, result.message, indexDir);
    store.updateActivation(target.assetType, target.assetId, target.version, activation);
    return { ok: false, activation, error: null };
  }

  const activation: KnowledgeActivation = {
    state: "ACTIVE",
    checkedAt: nowIso(),
    reason: null,
    message: null,
    indexPath: result.entry.indexPath || indexDir,
  };
  store.updateActivation(target.assetType, target.assetId, target.version, activation);
  return { ok: true, activation, error: null };
}

/**
 * Unregisters from search-runtime, then always clears the local activation
 * state — even when the remote call fails/times out. A user must be able to
 * cleanly uninstall or retry activation regardless of whether search-runtime
 * happens to be reachable right now (CLAUDE.md: "Desktop은 Runtime 장애 시
 * 종료되지 않고 복구 안내를 제공한다").
 */
export async function deactivateInstalledKnowledge(
  store: InstalledAssetsStore,
  searchRuntimeBaseUrl: string,
  target: KnowledgeActivationTarget,
  fetchImpl?: FetchLike,
): Promise<DeactivateKnowledgeResult> {
  const asset = store.find(target.assetType, target.assetId, target.version);
  if (!asset) {
    return { ok: false, remoteWarning: null, error: "설치된 자산을 찾을 수 없습니다." };
  }
  if (asset.assetType !== "knowledge") {
    return { ok: false, remoteWarning: null, error: "이 자산 유형은 활성화 대상이 아닙니다." };
  }

  let remoteWarning: string | null = null;
  if (asset.assetVersionId) {
    const result = await unregisterLocalKnowledgeIndex(searchRuntimeBaseUrl, asset.assetVersionId, fetchImpl);
    if (!result.ok) {
      remoteWarning = `search-runtime에서 등록 해제를 확인하지 못했습니다: ${result.message} 로컬 활성화 상태는 정리되었습니다.`;
    }
  }

  store.updateActivation(target.assetType, target.assetId, target.version, null);
  return { ok: true, remoteWarning, error: null };
}

// --- D-079 이어 붙이기: 활성화 상태 재확인(reconcile) ---------------------------
// 로컬에 저장된 `activation.state === "ACTIVE"`는 시점 스냅샷일 뿐이다 —
// search-runtime이 다른 `SEARCH_LOCAL_INDEX_ROOTS`로 재시작되었거나 등록
// 레지스트리 파일이 초기화되면, 로컬은 여전히 ACTIVE라고 믿지만 실제로는
// 검색되지 않는 "거짓 ACTIVE"가 생긴다. 이 절이 그 어긋남을 바로잡는다.

export interface ActivationDowngrade {
  assetType: string;
  assetId: string;
  version: string;
  activation: KnowledgeActivation;
}

/** 순수 비교 로직 — fs/네트워크 없음, 단위 테스트 대상.
 *
 * `serverEntries === null`은 "서버에 물어봤지만 응답을 알 수 없음"(도달 불가
 * 포함)을 뜻한다 — 이 경우 절대 아무것도 낮추지 않는다(`checked: false`):
 * 네트워크 장애를 "등록 안 됨"이라는 사실로 둔갑시키면 그 자체가 거짓
 * 정보를 지어내는 것이다(CLAUDE.md). 서버 목록을 실제로 받았을 때만
 * (`checked: true`) 로컬 ACTIVE 중 그 목록에 없는 것을 FAILED로 낮춘다.
 *
 * `serverLocalIndexesEnabled === false`(계약의 `local_indexes_enabled`)는
 * "등록이 사라졌다"가 아니라 "이 배포는 활성화 기능 자체를 켜지 않았다"는
 * 뜻이다(search-runtime에 `SEARCH_LOCAL_INDEX_ROOTS` 미설정). 두 경우 모두
 * 로컬 ACTIVE는 거짓이므로 낮추는 것은 같지만, **안내가 달라야 한다** —
 * 전자에 "다시 활성화하세요"라고 말하면 사용자는 반드시 다시 실패하는 행동을
 * 하게 된다. 계약이 이 플래그를 따로 돌려주는 이유가 정확히 이 구분이다.
 *
 * `state: "ALREADY_ACTIVE"`(central_index_exists)는 이 비교에서 의도적으로
 * 건드리지 않는다 — 이런 자산은 search-runtime에 로컬 등록을 시도조차
 * 하지 않았으므로(등록 자체가 거부됐다) `listLocalKnowledgeIndexes`가 돌려주는
 * `serverEntries`(로컬 등록 목록)에 애초에 나타날 수 없는 것이 정상이고,
 * 검색은 여전히 search-runtime의 중앙 INDEX_BASE가 서빙한다. 아래 `!==
 * "ACTIVE"` 검사가 이 state를 자동으로 건너뛴다 — `"ALREADY_ACTIVE"`를
 * 로컬 등록 목록과 비교해 "없으니 낮춘다"고 하면 방금 고친 거짓 실패
 * 알람을 reconcile 경로에서 그대로 재도입하는 것이다. */
export function computeActivationReconcile(
  installed: readonly InstalledAsset[],
  serverEntries: readonly LocalIndexEntry[] | null,
  serverLocalIndexesEnabled = true,
): { downgrades: ActivationDowngrade[]; checked: boolean } {
  if (serverEntries === null) {
    return { downgrades: [], checked: false };
  }
  const registeredIds = new Set(serverEntries.map((e) => e.knowledgeId));
  const downgrades: ActivationDowngrade[] = [];
  for (const asset of installed) {
    if (asset.assetType !== "knowledge") continue;
    if (asset.activation?.state !== "ACTIVE") continue; // ALREADY_ACTIVE never downgraded — see docstring above.
    if (!asset.assetVersionId) continue; // ACTIVE without an id should not happen, but never guess.
    if (registeredIds.has(asset.assetVersionId)) continue;
    downgrades.push({
      assetType: asset.assetType,
      assetId: asset.assetId,
      version: asset.version,
      activation: {
        state: "FAILED",
        checkedAt: nowIso(),
        reason: serverLocalIndexesEnabled ? "not_registered_on_server" : "local_indexes_disabled",
        message: serverLocalIndexesEnabled
          ? "다시 활성화하세요 — search-runtime에 이 Knowledge의 등록 정보가 없습니다(search-runtime이 다른 설정으로 재시작되었거나 등록이 초기화되었을 수 있습니다)."
          : "관리자에게 이 PC의 설치 경로를 SEARCH_LOCAL_INDEX_ROOTS 허용 목록에 추가하도록 요청하세요 — 연결된 search-runtime이 설치 자산 활성화를 허용하지 않도록 설정되어 있어(SEARCH_LOCAL_INDEX_ROOTS 미설정) 다시 활성화해도 같은 이유로 거절됩니다.",
        indexPath: asset.activation.indexPath,
      },
    });
  }
  return { downgrades, checked: true };
}

/** Main-process 오케스트레이션 — search-runtime에 실제로 등록된 목록을
 * 받아와 위 순수 비교를 수행하고, 낮출 것이 있으면 저장한다. search-runtime에
 * 도달할 수 없으면 아무것도 바꾸지 않고 `checked:false`+서버가 준 한국어
 * 메시지를 그대로 반환한다("확인 불가" — 사실을 지어내지 않는다). */
export async function reconcileInstalledKnowledgeActivations(
  store: InstalledAssetsStore,
  searchRuntimeBaseUrl: string,
  fetchImpl?: FetchLike,
): Promise<ReconcileKnowledgeActivationsResult> {
  const listResult = await listLocalKnowledgeIndexes(searchRuntimeBaseUrl, fetchImpl);
  if (!listResult.ok) {
    return { checked: false, downgradedCount: 0, error: listResult.message };
  }
  const installed = store.list();
  const { downgrades, checked } = computeActivationReconcile(
    installed,
    listResult.entries,
    listResult.localIndexesEnabled,
  );
  for (const d of downgrades) {
    store.updateActivation(d.assetType, d.assetId, d.version, d.activation);
  }
  return { checked, downgradedCount: downgrades.length, error: null };
}
