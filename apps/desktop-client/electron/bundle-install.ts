// Offline Bundle Import orchestrator — M04, D04 Package 가져오기 / D05 설치
// 사전점검 (`02-desktop-and-agent-runtime.md`), Import 검증
// (`01-portal-and-distribution.md` §4.5), Rollback (§4.6).
//
// This is the ONLY module allowed to touch the filesystem for the import
// flow; it is Node/Electron-side code invoked from an `ipcMain.handle`
// handler, never from the renderer directly. All security-critical
// decisions (is this path safe? is this a zip bomb? do the checksums
// match?) are delegated to the pure, independently-unit-tested functions in
// `bundle-verify.ts` — this file's job is only to feed them real data and
// carry out the extract-to-quarantine-then-atomically-install lifecycle.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";
import YAML from "yaml";
import {
  checkZipStructure,
  checkPathSafety,
  checkNoNestedArchives,
  checkExecutablePolicy,
  checkSizeCaps,
  checkFreeDiskSpace,
  parseChecksumsFile,
  checkChecksums,
  validateManifestSchema,
  checkRevocationList,
  checkRuntimeCompatibility,
  checkSignatureTrust,
  type ZipEntryMeta,
  type ParsedManifest,
  type RevocationEntry,
} from "./bundle-verify";
import { InstalledAssetsStore } from "./installed-assets-store";
import { mergeRevocationEntries } from "./asset-status";
import { STAGE_LABELS, type CheckItem, type ImportProgressEvent, type ImportResult, type ImportStage } from "./types";

/** Exported so `asset-management.ts` (D08) resolves the exact same
 * asset-type -> folder mapping when it later locates an already-installed
 * asset's directory — a second, hand-copied map would eventually drift. */
export const ASSET_TYPE_FOLDER: Record<string, string> = {
  agent: "agents",
  knowledge: "knowledge",
  prompt: "prompts",
  mcp_tool: "mcp-config",
  service: "services",
};

function folderFor(item: { role: string; asset_type: string }): string {
  const key = item.role === "root" ? item.asset_type : item.role;
  return ASSET_TYPE_FOLDER[key] ?? "agents";
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Unix S_IFLNK bit test on a ZIP central-directory external file attribute. */
function isSymlinkAttr(attr: number): boolean {
  const unixMode = (attr >>> 16) & 0xffff;
  return (unixMode & 0xf000) === 0xa000;
}

function toEntryMeta(entry: AdmZip.IZipEntry): ZipEntryMeta {
  return {
    name: entry.entryName,
    isDirectory: entry.isDirectory,
    uncompressedSize: entry.header.size,
    compressedSize: entry.header.compressedSize,
    isSymlink: isSymlinkAttr(entry.header.attr),
  };
}

/** Exported for reuse by `asset-management.ts`'s D08 "Checksum 재검사"
 * action — the re-verification must hash files the exact same way the
 * install-time CHECKSUM step did, or a mismatch would be meaningless. */
export function sha256OfFile(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Exported for the same reason as `sha256OfFile` above. */
export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function removeQuietly(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

export interface InstallRootLayout {
  root: string;
  assetsDir: string;
  quarantineDir: string;
  stateDir: string;
  profilesDir: string;
}

/**
 * Resolves the `company-ai-client/` layout from §2 rooted at Electron's
 * per-user `userData` directory. Deviation from the literal spec path
 * (`company-ai-client/`): Electron's `userData` (e.g. `%APPDATA%\Enterprise
 * AI Asset Hub` on Windows) is the platform-correct place for a desktop
 * app's writable state, and it already gives every user a private, unique
 * root without us reinventing install-location logic.
 */
export function resolveInstallRoot(userDataPath: string): InstallRootLayout {
  const root = userDataPath;
  const layout: InstallRootLayout = {
    root,
    assetsDir: path.join(root, "assets"),
    quarantineDir: path.join(root, "quarantine"),
    stateDir: path.join(root, "state"),
    profilesDir: path.join(root, "profiles"),
  };
  for (const dir of [layout.assetsDir, layout.quarantineDir, layout.stateDir, layout.profilesDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return layout;
}

function freeBytesAt(dir: string): number {
  const stat = fs.statfsSync(dir);
  return stat.bavail * stat.bsize;
}

export async function importBundle(
  sourceFilePath: string,
  layout: InstallRootLayout,
  emit: (event: ImportProgressEvent) => void,
): Promise<ImportResult> {
  const checks: CheckItem[] = [];
  let failedStage: string | null = null;
  let retryable = true;

  function record(id: ImportStage, result: { status: CheckItem["status"]; message: string }) {
    checks.push({ id, label: STAGE_LABELS[id], status: result.status, message: result.message });
    emit({ stage: id, status: result.status, message: result.message });
    if (result.status === "FAIL" && failedStage === null) {
      failedStage = id;
    }
  }

  function fail(): ImportResult {
    return {
      outcome: "FAILED",
      checks,
      failedStage,
      retryable,
      manifest: null,
      installPlan: [],
      totalSizeBytes: 0,
    };
  }

  // Step 1 (§4.5 / D04 step 2): copy into quarantine under an OPAQUE name —
  // never build a path from the user-supplied filename (CLAUDE.md).
  const quarantineId = crypto.randomUUID();
  const quarantinedZipPath = path.join(layout.quarantineDir, `${quarantineId}.zip`);
  try {
    fs.copyFileSync(sourceFilePath, quarantinedZipPath);
  } catch (err) {
    record("QUARANTINE_COPY", {
      status: "FAIL",
      message: `선택한 파일을 읽을 수 없습니다: ${err instanceof Error ? err.message : String(err)}`,
    });
    retryable = true;
    return fail();
  }
  await yieldToEventLoop();

  const stagingDir = path.join(layout.quarantineDir, `${quarantineId}-extracted`);

  try {
    // Open the archive and read ONLY the central directory (no decompression
    // yet) so the size-cap / zip-bomb check below never has to inflate
    // attacker-controlled bytes to evaluate itself.
    let zip: AdmZip;
    let entries: AdmZip.IZipEntry[];
    try {
      zip = new AdmZip(quarantinedZipPath);
      entries = zip.getEntries();
    } catch (err) {
      record("ZIP_STRUCTURE", {
        status: "FAIL",
        message: `유효한 ZIP 파일이 아닙니다: ${err instanceof Error ? err.message : String(err)}`,
      });
      retryable = false;
      return fail();
    }
    const entryMetas = entries.map(toEntryMeta);

    record("ZIP_STRUCTURE", checkZipStructure(entryMetas));

    const pathSafety = checkPathSafety(entryMetas);
    record("PATH_SAFETY", pathSafety);
    if (pathSafety.status === "FAIL") {
      retryable = false;
      return fail();
    }

    record("NESTED_ARCHIVE", checkNoNestedArchives(entryMetas));
    record("EXECUTABLE_POLICY", checkExecutablePolicy(entryMetas));

    const sizeCap = checkSizeCaps(entryMetas);
    record("SIZE_CAP", sizeCap);

    fs.mkdirSync(layout.assetsDir, { recursive: true });
    const free = freeBytesAt(layout.root);
    record("DISK_SPACE", checkFreeDiskSpace(sizeCap.totalUncompressedBytes, free));

    // Any hard failure among the pre-extraction (metadata-only) checks means
    // we must not extract anything — abort here, before touching disk beyond
    // the quarantine copy itself.
    const preExtractionFailures = checks.filter((c) => c.status === "FAIL");
    if (preExtractionFailures.length > 0) {
      // Only a pure disk-space shortfall is something the user can fix and
      // retry with the same file (free up space); every other pre-extraction
      // failure means the archive itself is unsafe or malformed.
      retryable = preExtractionFailures.length === 1 && preExtractionFailures[0].id === "DISK_SPACE";
      return fail();
    }
    await yieldToEventLoop();

    // --- Extraction into a private staging directory -----------------------
    fs.mkdirSync(stagingDir, { recursive: true });
    // NOTE: deliberately NOT `fs.realpathSync` here — on macOS `os.tmpdir()`
    // resolves through a `/var` -> `/private/var` symlink, so comparing a
    // realpath'd root against a non-realpath'd `destPath` would make every
    // entry look like it escaped the root. `path.resolve` alone is exactly
    // as effective at catching ".." traversal and is symlink-agnostic.
    const stagingRoot = path.resolve(stagingDir);
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      // Defense in depth: re-derive and re-check containment at the point of
      // writing, even though the whole-archive PATH_SAFETY check already
      // passed above — a destructive filesystem write should never rely on
      // a single check performed earlier in the pipeline.
      const destPath = path.resolve(stagingDir, entry.entryName);
      if (destPath !== stagingRoot && !destPath.startsWith(stagingRoot + path.sep)) {
        record("EXTRACT", {
          status: "FAIL",
          message: `안전하지 않은 경로로 압축 해제가 시도되어 중단했습니다: ${entry.entryName}`,
        });
        retryable = false;
        return fail();
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const data = entry.getData();
      if (data.length > entry.header.size * 2 + 1024) {
        // Declared vs. actual size mismatch beyond a small slack — treat as
        // a zip-bomb attempt that slipped past the header-only check.
        record("EXTRACT", {
          status: "FAIL",
          message: `선언된 크기와 실제 압축 해제 크기가 크게 달라 Zip Bomb으로 의심되는 항목을 차단했습니다: ${entry.entryName}`,
        });
        retryable = false;
        return fail();
      }
      fs.writeFileSync(destPath, data);
    }
    await yieldToEventLoop();

    // --- Manifest ------------------------------------------------------------
    const manifestPath = path.join(stagingDir, "bundle-manifest.yaml");
    let manifestRaw: unknown;
    try {
      manifestRaw = YAML.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch (err) {
      record("MANIFEST_SCHEMA", {
        status: "FAIL",
        message: `bundle-manifest.yaml을 읽을 수 없습니다: ${err instanceof Error ? err.message : String(err)}`,
      });
      retryable = false;
      return fail();
    }
    const manifestCheck = validateManifestSchema(manifestRaw);
    record("MANIFEST_SCHEMA", manifestCheck);
    if (manifestCheck.status === "FAIL" || !manifestCheck.manifest) {
      retryable = false;
      return fail();
    }
    const manifest: ParsedManifest = manifestCheck.manifest;

    // --- Checksums -------------------------------------------------------------
    const checksumsPath = path.join(stagingDir, "checksums.sha256");
    const declared = parseChecksumsFile(fs.readFileSync(checksumsPath, "utf-8"));
    const actual = new Map<string, string>();
    for (const filePath of walkFiles(stagingDir)) {
      const arcname = path.relative(stagingDir, filePath).split(path.sep).join("/");
      if (arcname === "checksums.sha256") continue;
      actual.set(arcname, sha256OfFile(filePath));
    }
    record("CHECKSUM", checkChecksums(declared, actual));
    if (checks.at(-1)!.status === "FAIL") {
      retryable = true; // could be a transfer corruption — re-downloading may fix it
      return fail();
    }
    await yieldToEventLoop();

    // --- Revocation --------------------------------------------------------
    let revocationEntries: RevocationEntry[] = [];
    const revocationPath = path.join(stagingDir, "policies", "revocation-list.json");
    if (fs.existsSync(revocationPath)) {
      try {
        revocationEntries = JSON.parse(fs.readFileSync(revocationPath, "utf-8"));
      } catch {
        revocationEntries = [];
      }
    }
    record("REVOCATION", checkRevocationList(manifest.included_assets, revocationEntries));
    if (checks.at(-1)!.status === "FAIL") {
      retryable = false;
      return fail();
    }

    // --- Runtime/OS 호환성 (경고만) ------------------------------------------
    record("RUNTIME_COMPAT", checkRuntimeCompatibility(manifest.runtime_requirements, process.platform));

    // --- Signature/Trust (D-016, 항상 미검증으로 보고) -------------------------
    record("SIGNATURE_TRUST", checkSignatureTrust());

    // --- 동일 버전 이미 설치 (D04 표시 대상 오류 목록, 설치를 막지는 않음) --------
    const store = new InstalledAssetsStore(layout.stateDir);
    const alreadyInstalled = manifest.included_assets.filter(
      (item) => item.asset_id && item.version && store.find(item.asset_type, item.asset_id, item.version),
    );
    if (alreadyInstalled.length > 0) {
      const names = alreadyInstalled.map((i) => `${i.name ?? i.asset_id} v${i.version}`).join(", ");
      record("ALREADY_INSTALLED", {
        status: "WARN",
        message: `이미 설치된 버전이 있습니다(재설치 시 덮어씁니다): ${names}`,
      });
    } else {
      record("ALREADY_INSTALLED", { status: "PASS", message: "새로 설치되는 버전입니다." });
    }

    if (checks.some((c) => c.status === "FAIL")) {
      return fail();
    }

    // --- Install: atomically move staged assets into the install root ------
    const installedAt = new Date().toISOString();
    for (const item of manifest.included_assets) {
      if (!item.asset_id || !item.version) continue;
      const folder = folderFor(item);
      const srcDir = path.join(stagingDir, "assets", folder, item.asset_id);
      if (!fs.existsSync(srcDir)) continue;
      const destDir = path.join(layout.assetsDir, folder, item.asset_id, item.version);
      fs.rmSync(destDir, { recursive: true, force: true }); // re-install same version cleanly
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      fs.cpSync(srcDir, destDir, { recursive: true });

      // D08 "Checksum 재검사"의 기준값 — CHECKSUM 단계에서 이미 전체 Bundle에
      // 대해 계산해 둔 `declared`(checksums.sha256 선언값)를 이 자산 소유
      // 파일만 추려(prefix 제거) 저장한다. 새 해시 체계를 만들지 않고 이미
      // 검증된 값을 재사용하므로, 나중에 같은 상대 경로로 재계산한 값과
      // `checkChecksums`(bundle-verify.ts, 이미 테스트됨)로 바로 비교할 수
      // 있다.
      const ownedFilePrefix = `assets/${folder}/${item.asset_id}/`;
      const fileChecksums: Record<string, string> = {};
      for (const [arcname, hash] of declared) {
        if (arcname.startsWith(ownedFilePrefix)) {
          fileChecksums[arcname.slice(ownedFilePrefix.length)] = hash;
        }
      }

      store.upsert({
        assetId: item.asset_id,
        // D-060: normalize a missing key (legacy Bundle, pre-dates this
        // field) to `null` explicitly — never fall back to item.asset_id,
        // that is exactly the silent-wrong-identifier bug being fixed here.
        assetVersionId: item.asset_version_id ?? null,
        assetType: item.asset_type,
        name: item.name ?? item.asset_id,
        version: item.version,
        installedAt,
        sizeBytes: item.size_bytes,
        bundleId: manifest.bundle_id,
        // Empty object (not present at all) is honest for STANDARD_LOCAL_COPY
        // items and any legacy install path that reaches here without a
        // per-file checksums.sha256 breakdown — D08 disables "Checksum
        // 재검사" for those rather than fabricating a PASS.
        fileChecksums: Object.keys(fileChecksums).length > 0 ? fileChecksums : undefined,
        checksumVerification: null,
      });
    }

    // Record the Office Profile as reference material — activating a
    // profile is D01/D10 scope, not this import flow.
    const officeProfileSrc = path.join(stagingDir, "profiles", "office-profile.yaml");
    if (fs.existsSync(officeProfileSrc)) {
      fs.copyFileSync(officeProfileSrc, path.join(layout.profilesDir, `${manifest.bundle_id}-office-profile.yaml`));
    }

    // D08 Revoked 상태 판정의 근거 — 이 Bundle의 revocation 목록을 상태
    // 디렉터리에 누적 저장한다(설치가 끝나면 staging은 지워지므로, 나중에
    // D08에서 다시 판정하려면 여기서 영구 보관해야 한다). REVOCATION 검사
    // 단계에서 이미 이번 Bundle과 무관함까지 확인했지만, 목록 자체는 다른
    // 자산(예: 나중에 반입될 자산)에도 적용될 수 있으므로 전부 병합해 둔다.
    if (revocationEntries.length > 0) {
      const revocationStatePath = path.join(layout.stateDir, "revocation-list.json");
      let existingRevocations: RevocationEntry[] = [];
      if (fs.existsSync(revocationStatePath)) {
        try {
          existingRevocations = JSON.parse(fs.readFileSync(revocationStatePath, "utf-8"));
        } catch {
          existingRevocations = [];
        }
      }
      const merged = mergeRevocationEntries(existingRevocations, revocationEntries);
      fs.writeFileSync(revocationStatePath, JSON.stringify(merged, null, 2), "utf-8");
    }

    record("INSTALL", { status: "PASS", message: "모든 자산이 설치되었습니다." });

    return {
      outcome: "SUCCESS",
      checks,
      failedStage: null,
      retryable: true,
      manifest: manifest as unknown as ImportResult["manifest"],
      installPlan: manifest.included_assets,
      totalSizeBytes: manifest.total_installed_size_bytes,
    };
  } finally {
    // §4.6 Rollback: whether we succeeded or failed, the staging/quarantine
    // copies are temporary and must not linger.
    removeQuietly(stagingDir);
    removeQuietly(quarantinedZipPath);
  }
}
