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
  registerLocalKnowledgeIndex,
  unregisterLocalKnowledgeIndex,
  type FetchLike,
} from "./search-runtime-client";
import type { ActivateKnowledgeResult, DeactivateKnowledgeResult, KnowledgeActivation } from "./types";

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
      "이 설치 기록에는 검증된 AssetVersion 식별자가 없어 활성화할 수 없습니다(D-060). 최신 Bundle로 다시 설치하면 해결될 수 있습니다.",
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
      "설치된 자산에 index 폴더가 없어 활성화할 수 없습니다. 자산을 다시 설치하세요.",
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
