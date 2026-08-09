// D08 로컬 자산 관리 — fs 접근이 필요한 orchestration만 담당한다. 실제 판정
// 로직은 순수 모듈(`service-dependencies.ts`, `removal-guard.ts`,
// `asset-status.ts`)에 있고, 이 파일은 그 모듈들에 진짜 파일 데이터를 넣어
// 호출하는 역할만 한다 — `bundle-install.ts`가 `bundle-verify.ts`에 대해
// 갖는 관계와 동일한 구조.

import fs from "node:fs";
import path from "node:path";
import { checkChecksums, type RevocationEntry } from "./bundle-verify";
import { ASSET_TYPE_FOLDER, sha256OfFile, walkFiles, type InstallRootLayout } from "./bundle-install";
import { InstalledAssetsStore } from "./installed-assets-store";
import { ActiveVersionStore } from "./active-version-store";
import { computeAssetStatus } from "./asset-status";
import { findReferencingServices, parseServiceDefinition, type InstalledServiceBindings } from "./service-dependencies";
import { evaluateAssetRemoval, type ActivePointerInput } from "./removal-guard";
import { computeManifestDiff, manifestFileNameHint } from "./version-diff";
import type {
  ActivateVersionResult,
  AssetDependencyView,
  AssetManifestResult,
  AssetRemovalCheck,
  AssetStatus,
  AssetVersionDiffResponse,
  ChecksumVerification,
  InstalledAsset,
  InstalledAssetWithStatus,
  OrphanedInstallCleanupResult,
} from "./types";

export function assetInstallDir(layout: InstallRootLayout, assetType: string, assetId: string, version: string): string {
  const folder = ASSET_TYPE_FOLDER[assetType] ?? "agents";
  return path.join(layout.assetsDir, folder, assetId, version);
}

function readJsonIfExists(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 설치된 Service 의존 관계 로드
// ---------------------------------------------------------------------------

/** Reads every installed Service version's `service-definition.json` off
 * disk and parses its bindings. Never throws — an unreadable/malformed file
 * is simply skipped (it cannot block or unblock a removal either way, which
 * is the safe default for a file this module does not own). */
export function loadInstalledServiceDefinitions(
  layout: InstallRootLayout,
  store: InstalledAssetsStore,
): InstalledServiceBindings[] {
  const services = store.list().filter((a) => a.assetType === "service");
  const result: InstalledServiceBindings[] = [];
  for (const svc of services) {
    const defPath = path.join(assetInstallDir(layout, "service", svc.assetId, svc.version), "service-definition.json");
    const raw = readJsonIfExists(defPath);
    const parsed = raw !== null ? parseServiceDefinition(raw) : null;
    if (parsed) result.push(parsed);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Revocation 상태
// ---------------------------------------------------------------------------

export function loadRevocationEntries(layout: InstallRootLayout): RevocationEntry[] {
  const raw = readJsonIfExists(path.join(layout.stateDir, "revocation-list.json"));
  return Array.isArray(raw) ? (raw as RevocationEntry[]) : [];
}

export function computeStatusForAsset(
  asset: InstalledAsset,
  revocationEntries: RevocationEntry[],
  activeVersionStore?: ActiveVersionStore,
): AssetStatus {
  const activeVersion = activeVersionStore?.get(asset.assetType, asset.assetId) ?? null;
  return computeAssetStatus(
    { assetId: asset.assetId, version: asset.version, checksumVerification: asset.checksumVerification },
    revocationEntries,
    activeVersion,
  );
}

export function listInstalledAssetsWithStatus(layout: InstallRootLayout, store: InstalledAssetsStore): InstalledAssetWithStatus[] {
  const revocationEntries = loadRevocationEntries(layout);
  const activeVersionStore = new ActiveVersionStore(layout.stateDir);
  return store.list().map((asset) => ({ ...asset, status: computeStatusForAsset(asset, revocationEntries, activeVersionStore) }));
}

// ---------------------------------------------------------------------------
// 제거 전 확인 (참조 중인 Service / 진행 중인 Run)
// ---------------------------------------------------------------------------

/** D12/D-068: builds the `ActivePointerInput` fact `removal-guard.ts` needs —
 * whether `target` is the recorded Active Version for its assetId, and
 * whether another installed version of the same asset exists to switch to.
 *
 * When no pointer has ever been recorded for this assetId, EVERY installed
 * version is treated as "active" (mirrors `computeAssetStatus`'s "never
 * fabricate INACTIVE without evidence" rule). For the common case — exactly
 * one installed version — this changes nothing (there is no "other version"
 * to switch to, so removal is never blocked on this ground). For the rarer
 * legacy case of 2+ versions installed with no pointer ever set, this is a
 * deliberate tightening: since we cannot say which one is "really" active,
 * removal of ANY of them is blocked until the user explicitly activates one
 * via D12 — silently allowing removal of an undefined "active" version would
 * be the actual hole here, not this restriction. */
function loadActivePointerInput(
  store: InstalledAssetsStore,
  activeVersionStore: ActiveVersionStore,
  target: { assetType: string; assetId: string; version: string },
): ActivePointerInput {
  const activeVersion = activeVersionStore.get(target.assetType, target.assetId);
  const isActiveVersion = activeVersion == null || activeVersion === target.version;
  const otherVersionsInstalled = store
    .list()
    .some((a) => a.assetType === target.assetType && a.assetId === target.assetId && a.version !== target.version);
  return { isActiveVersion, otherVersionsInstalled };
}

export function checkAssetRemoval(
  layout: InstallRootLayout,
  store: InstalledAssetsStore,
  target: { assetType: string; assetId: string; version: string },
): AssetRemovalCheck {
  const referencingServices = findReferencingServices(target, loadInstalledServiceDefinitions(layout, store));
  const activeVersionStore = new ActiveVersionStore(layout.stateDir);
  const activePointer = loadActivePointerInput(store, activeVersionStore, target);
  // activeRunUsages는 항상 null이다 — Local Agent Runtime(:8100)이 "이 Run이
  // 어떤 자산을 쓰는지" 조회할 방법을 아직 제공하지 않는다(Run 목록 API
  // 없음, Service Registry 미도입). open-decisions.md D-070 참고. 이 값을
  // []로 두면 "확인했더니 없음"으로 오인되므로 반드시 null을 유지한다.
  const result = evaluateAssetRemoval({ target, referencingServices, activeRunUsages: null, activePointer });
  return {
    blocked: result.blocked,
    referencingServices: result.referencingServices,
    runCheckAvailable: result.runCheckAvailable,
    runCheckNote: result.runCheckNote,
    blockedByActiveVersion: result.blockedByActiveVersion,
    activeVersionNote: result.activeVersionNote,
  };
}

// ---------------------------------------------------------------------------
// 상세 Manifest 보기
// ---------------------------------------------------------------------------

const MANIFEST_FILE_BY_TYPE: Record<string, string> = {
  service: "service-definition.json",
};

export function readAssetManifest(layout: InstallRootLayout, asset: InstalledAsset): AssetManifestResult {
  const fileName = MANIFEST_FILE_BY_TYPE[asset.assetType] ?? "manifest.json";
  const filePath = path.join(assetInstallDir(layout, asset.assetType, asset.assetId, asset.version), fileName);
  const manifest = readJsonIfExists(filePath);
  if (manifest === null) {
    return {
      available: false,
      reason: fs.existsSync(filePath)
        ? "Manifest 파일 형식을 읽을 수 없습니다(손상되었을 수 있음)."
        : `설치된 자산 폴더에 ${fileName}이 없습니다 — 표준 구성 자산(D-034 STANDARD_LOCAL_COPY)이거나 이전 형식의 Bundle로 설치되었을 수 있습니다.`,
      manifest: null,
    };
  }
  return { available: true, reason: null, manifest };
}

// ---------------------------------------------------------------------------
// Checksum 재검사
// ---------------------------------------------------------------------------

export function reverifyAssetChecksum(
  layout: InstallRootLayout,
  store: InstalledAssetsStore,
  target: { assetType: string; assetId: string; version: string },
): { available: boolean; reason: string | null; result: ChecksumVerification | null } {
  const asset = store.find(target.assetType, target.assetId, target.version);
  if (!asset) {
    return { available: false, reason: "설치된 자산을 찾을 수 없습니다.", result: null };
  }
  if (!asset.fileChecksums || Object.keys(asset.fileChecksums).length === 0) {
    return {
      available: false,
      reason: "설치 당시 Checksum 정보가 저장되지 않아 재검사를 실행할 수 없습니다(이전 형식의 Bundle이거나 표준 구성 자산). 다시 반입하면 재검사가 가능합니다.",
      result: null,
    };
  }

  const dir = assetInstallDir(layout, target.assetType, target.assetId, target.version);
  const declared = new Map(Object.entries(asset.fileChecksums));
  const actual = new Map<string, string>();
  for (const filePath of walkFiles(dir)) {
    const relPath = path.relative(dir, filePath).split(path.sep).join("/");
    actual.set(relPath, sha256OfFile(filePath));
  }

  const check = checkChecksums(declared, actual);
  const verification: ChecksumVerification = {
    checkedAt: new Date().toISOString(),
    result: check.status === "PASS" ? "PASS" : "FAIL",
    mismatched: check.mismatched,
    missing: check.missing,
  };
  store.updateChecksumVerification(target.assetType, target.assetId, target.version, verification);
  return { available: true, reason: null, result: verification };
}

// ---------------------------------------------------------------------------
// 의존 관계 보기
// ---------------------------------------------------------------------------

const FORWARD_DEPENDENCY_UNAVAILABLE_NOTE =
  "Agent/Knowledge/Prompt/MCP Package Manifest는 구체적인 의존 Asset id를 선언하지 않습니다(역할별 요구 여부만 표시) — 실제 Knowledge/MCP/Prompt 연결은 이 자산을 사용하는 AI Service 쪽에 선언되어 있습니다. 아래는 이 자산을 참조하는 Service 목록입니다.";

export function getAssetDependencyView(
  layout: InstallRootLayout,
  store: InstalledAssetsStore,
  target: InstalledAsset,
): AssetDependencyView {
  const services = loadInstalledServiceDefinitions(layout, store);
  const referencedBy = findReferencingServices(
    { assetType: target.assetType, assetId: target.assetId, version: target.version },
    services,
  );

  if (target.assetType !== "service") {
    return { forward: [], forwardNote: FORWARD_DEPENDENCY_UNAVAILABLE_NOTE, referencedBy };
  }

  const own = services.find((s) => s.assetId === target.assetId && s.version === target.version);
  if (!own) {
    return {
      forward: [],
      forwardNote: "이 Service의 service-definition.json을 읽을 수 없어 의존 관계를 표시할 수 없습니다.",
      referencedBy,
    };
  }

  const forward: AssetDependencyView["forward"] = [];
  if (own.agentRef) {
    forward.push({
      label: "Agent",
      refType: "agent_ref",
      assetId: own.agentRef.id,
      version: own.agentRef.version,
      installed: store.find("agent", own.agentRef.id, own.agentRef.version) !== undefined,
    });
  }
  for (const b of own.knowledgeBindings) {
    forward.push({
      label: `Knowledge (${b.roleId || "역할 미지정"})`,
      refType: "knowledge_bindings",
      assetId: b.knowledgeId,
      version: b.knowledgeVersion,
      installed: store.find("knowledge", b.knowledgeId, b.knowledgeVersion) !== undefined,
    });
  }
  for (const b of own.mcpBindings) {
    forward.push({
      label: `MCP Tool (${b.roleId || "역할 미지정"})`,
      refType: "mcp_bindings",
      assetId: b.toolId,
      version: b.toolVersion,
      installed: store.find("mcp_tool", b.toolId, b.toolVersion) !== undefined,
    });
  }
  for (const b of own.promptBindings) {
    forward.push({
      label: `Prompt (${b.roleId || "역할 미지정"})`,
      refType: "prompt_bindings",
      assetId: b.promptId,
      version: b.promptVersion,
      installed: store.find("prompt", b.promptId, b.promptVersion) !== undefined,
    });
  }

  return { forward, forwardNote: null, referencedBy };
}

// ---------------------------------------------------------------------------
// D12 업데이트/복구
// ---------------------------------------------------------------------------

/** "현재와 새 버전 Diff" — 두 설치된 버전의 Manifest를 읽어 3축(Manifest/
 * Dependency/Permission)으로 비교한다. 둘 다 Manifest 파일이 없으면(둘 다
 * STANDARD_LOCAL_COPY) 비교 자체가 불가능함을 명시한다 — 빈 Diff("변경
 * 없음")로 보여주면 "확인했더니 차이가 없다"는 거짓 확신을 준다. */
export function diffAssetVersions(
  layout: InstallRootLayout,
  store: InstalledAssetsStore,
  target: { assetType: string; assetId: string; fromVersion: string; toVersion: string },
): AssetVersionDiffResponse {
  const fromAsset = store.find(target.assetType, target.assetId, target.fromVersion);
  const toAsset = store.find(target.assetType, target.assetId, target.toVersion);
  if (!fromAsset || !toAsset) {
    return { available: false, reason: "비교할 두 버전이 모두 설치되어 있어야 합니다.", diff: null };
  }

  const fromManifest = readAssetManifest(layout, fromAsset);
  const toManifest = readAssetManifest(layout, toAsset);
  if (!fromManifest.available && !toManifest.available) {
    return {
      available: false,
      reason: `두 버전 모두 ${manifestFileNameHint(target.assetType)}이 없어 비교할 수 없습니다(표준 구성 자산이거나 이전 형식의 Bundle).`,
      diff: null,
    };
  }

  const diff = computeManifestDiff(fromManifest.manifest, toManifest.manifest);
  return { available: true, reason: null, diff };
}

/** D12 "Active Pointer 전환" / "이전 버전 Rollback" — 대상 버전이 실제로
 * 설치돼 있고, Revoked/Invalid가 아닐 때만 전환을 허용한다(근거 없는 활성화
 * 금지 — REVOKED/INVALID 버전을 활성화하면 D08의 상태 표시 자체가 거짓이
 * 된다). */
export function activateAssetVersion(
  layout: InstallRootLayout,
  store: InstalledAssetsStore,
  target: { assetType: string; assetId: string; version: string },
): ActivateVersionResult {
  const asset = store.find(target.assetType, target.assetId, target.version);
  if (!asset) {
    return { ok: false, error: "설치된 자산을 찾을 수 없습니다." };
  }
  const revocationEntries = loadRevocationEntries(layout);
  const activeVersionStore = new ActiveVersionStore(layout.stateDir);
  const currentStatus = computeStatusForAsset(asset, revocationEntries, activeVersionStore);
  if (currentStatus === "REVOKED") {
    return { ok: false, error: "회수(Revoked)된 버전은 Active로 전환할 수 없습니다." };
  }
  if (currentStatus === "INVALID") {
    return { ok: false, error: "Checksum 재검사에 실패한(Invalid) 버전은 Active로 전환할 수 없습니다. 다시 반입하세요." };
  }
  if (currentStatus === "ACTIVE") {
    return { ok: false, error: "이미 Active 버전입니다." };
  }
  activeVersionStore.set(target.assetType, target.assetId, target.version);
  return { ok: true, error: null };
}

/** D12 "실패 설치 정리" — `InstalledAssetsStore`에 완결된 레코드가 없는 설치
 * 디렉터리를 제거한다. `bundle-install.ts::importBundle`의 설치 루프는 각
 * 항목의 파일 복사(`fs.cpSync`) 직후 그 자리에서 바로 `store.upsert`하므로,
 * Store에 레코드가 없는데 디렉터리만 존재한다는 것은 그 복사가 도중에
 * 실패했다는 뜻(디스크 공간 고갈, 권한 오류 등 — 사전 검사를 통과한 뒤
 * 드물게 발생)이지 정상적으로 설치가 끝난 상태가 아니다. 전체
 * `assets/` 트리를 훑으므로 특정 assetId를 몰라도(가져온 Bundle이 여러
 * 자산을 포함했을 수 있으므로) 동작하며, 멱등하다(정리할 것이 없으면
 * 아무것도 하지 않고 빈 배열을 반환). */
export function cleanupOrphanedInstalls(layout: InstallRootLayout, store: InstalledAssetsStore): OrphanedInstallCleanupResult {
  const removed: OrphanedInstallCleanupResult["removed"] = [];
  const installedKeys = new Set(store.list().map((a) => `${a.assetType}::${a.assetId}::${a.version}`));

  for (const [assetType, folder] of Object.entries(ASSET_TYPE_FOLDER)) {
    const typeDir = path.join(layout.assetsDir, folder);
    if (!fs.existsSync(typeDir)) continue;
    for (const assetIdEntry of fs.readdirSync(typeDir, { withFileTypes: true })) {
      if (!assetIdEntry.isDirectory()) continue;
      const assetId = assetIdEntry.name;
      const assetDir = path.join(typeDir, assetId);
      for (const versionEntry of fs.readdirSync(assetDir, { withFileTypes: true })) {
        if (!versionEntry.isDirectory()) continue;
        const version = versionEntry.name;
        if (installedKeys.has(`${assetType}::${assetId}::${version}`)) continue;
        fs.rmSync(path.join(assetDir, version), { recursive: true, force: true });
        removed.push({ assetType, assetId, version });
      }
    }
  }
  return { removed };
}
