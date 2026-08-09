// Integration tests for the D08 fs-orchestrator (`asset-management.ts`)
// against a real temp install layout — mirrors `bundle-install.test.ts`'s
// approach (real files on disk, not mocked fs) because these are exactly the
// code paths CLAUDE.md's "제거 전 참조 중인 Service를 확인한다" rule depends
// on; verifying only the pure logic in isolation would miss a wrong file
// path or a wrong JSON shape breaking the real wiring.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importBundle, resolveInstallRoot, type InstallRootLayout } from "../bundle-install";
import { InstalledAssetsStore } from "../installed-assets-store";
import { ActiveVersionStore } from "../active-version-store";
import {
  activateAssetVersion,
  assetInstallDir,
  checkAssetRemoval,
  cleanupOrphanedInstalls,
  diffAssetVersions,
  getAssetDependencyView,
  listInstalledAssetsWithStatus,
  readAssetManifest,
  reverifyAssetChecksum,
} from "../asset-management";
import type { InstalledAsset } from "../types";

const FIXTURES_DIR = path.join(__dirname, "fixtures");

let tmpRoot: string;
let layout: InstallRootLayout;
let store: InstalledAssetsStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-asset-mgmt-"));
  layout = resolveInstallRoot(tmpRoot);
  store = new InstalledAssetsStore(layout.stateDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function installKnowledge(assetId: string, version: string, manifest: Record<string, unknown> | null = { id: assetId }) {
  const dir = assetInstallDir(layout, "knowledge", assetId, version);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest) {
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  }
  fs.writeFileSync(path.join(dir, "source.md"), "정책 원문");
  const asset: InstalledAsset = {
    assetId,
    assetVersionId: "av-1",
    assetType: "knowledge",
    name: "재택근무 정책",
    version,
    installedAt: new Date().toISOString(),
    sizeBytes: 100,
    bundleId: "bundle-1",
    checksumVerification: null,
  };
  store.upsert(asset);
  return dir;
}

function installService(assetId: string, version: string, definition: Record<string, unknown>) {
  const dir = assetInstallDir(layout, "service", assetId, version);
  fs.mkdirSync(dir, { recursive: true });
  // `id`/`version` are always derived from the function's own arguments —
  // never left to the caller to duplicate — so every test fixture is
  // guaranteed internally consistent with the folder it's written into.
  const fullDefinition = { ...definition, id: assetId, version };
  fs.writeFileSync(path.join(dir, "service-definition.json"), JSON.stringify(fullDefinition));
  const asset: InstalledAsset = {
    assetId,
    assetVersionId: null,
    assetType: "service",
    name: (definition.name as string) ?? assetId,
    version,
    installedAt: new Date().toISOString(),
    sizeBytes: 10,
    bundleId: "bundle-1",
    checksumVerification: null,
  };
  store.upsert(asset);
}

describe("readAssetManifest", () => {
  it("reads a Knowledge asset's manifest.json", () => {
    installKnowledge("know-1", "1.0.0", { id: "know-1", name: "재택근무 정책" });
    const result = readAssetManifest(layout, store.find("knowledge", "know-1", "1.0.0")!);
    expect(result.available).toBe(true);
    expect((result.manifest as { name: string }).name).toBe("재택근무 정책");
  });

  it("disables the action with a stated reason when the manifest file is missing (e.g. STANDARD_LOCAL_COPY)", () => {
    installKnowledge("know-2", "1.0.0", null);
    const result = readAssetManifest(layout, store.find("knowledge", "know-2", "1.0.0")!);
    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.manifest).toBeNull();
  });

  it("reads a Service asset's service-definition.json (different filename)", () => {
    installService("svc-1", "1.0.0", { id: "svc-1", name: "HR 챗봇", agent_ref: { id: "a1", version: "1.0.0" } });
    const result = readAssetManifest(layout, store.find("service", "svc-1", "1.0.0")!);
    expect(result.available).toBe(true);
    expect((result.manifest as { name: string }).name).toBe("HR 챗봇");
  });
});

describe("reverifyAssetChecksum", () => {
  it("is disabled with a reason when no baseline checksums were recorded at install time", () => {
    installKnowledge("know-3", "1.0.0");
    const result = reverifyAssetChecksum(layout, store, { assetType: "knowledge", assetId: "know-3", version: "1.0.0" });
    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("PASSes when on-disk files still match the recorded baseline", () => {
    const dir = installKnowledge("know-4", "1.0.0");
    const hash = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    store.upsert({
      ...store.find("knowledge", "know-4", "1.0.0")!,
      fileChecksums: {
        "manifest.json": hash(path.join(dir, "manifest.json")),
        "source.md": hash(path.join(dir, "source.md")),
      },
    });

    const result = reverifyAssetChecksum(layout, store, { assetType: "knowledge", assetId: "know-4", version: "1.0.0" });
    expect(result.available).toBe(true);
    expect(result.result?.result).toBe("PASS");
    // The verdict is persisted, not just returned once.
    expect(store.find("knowledge", "know-4", "1.0.0")?.checksumVerification?.result).toBe("PASS");
  });

  it("FAILs and reports the tampered file when on-disk content was modified after install", () => {
    const dir = installKnowledge("know-5", "1.0.0");
    const hash = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    store.upsert({
      ...store.find("knowledge", "know-5", "1.0.0")!,
      fileChecksums: {
        "manifest.json": hash(path.join(dir, "manifest.json")),
        "source.md": hash(path.join(dir, "source.md")),
      },
    });

    // Tamper with the file after install.
    fs.writeFileSync(path.join(dir, "source.md"), "변조된 내용");

    const result = reverifyAssetChecksum(layout, store, { assetType: "knowledge", assetId: "know-5", version: "1.0.0" });
    expect(result.available).toBe(true);
    expect(result.result?.result).toBe("FAIL");
    expect(result.result?.mismatched).toContain("source.md");
  });
});

describe("checkAssetRemoval — the D08 hard rule", () => {
  it("blocks removal when an installed Service references the asset (real, not advisory)", () => {
    installKnowledge("know-6", "1.0.0");
    installService("svc-2", "1.0.0", {
      id: "svc-2",
      name: "HR 정책 챗봇",
      agent_ref: { id: "a1", version: "1.0.0" },
      knowledge_bindings: [{ role_id: "primary", knowledge_id: "know-6", knowledge_version: "1.0.0" }],
    });

    const guard = checkAssetRemoval(layout, store, { assetType: "knowledge", assetId: "know-6", version: "1.0.0" });
    expect(guard.blocked).toBe(true);
    expect(guard.referencingServices).toEqual([{ assetId: "svc-2", name: "HR 정책 챗봇", via: "knowledge_bindings", version: "1.0.0" }]);
  });

  it("allows removal when no installed Service references the asset", () => {
    installKnowledge("know-7", "1.0.0");
    const guard = checkAssetRemoval(layout, store, { assetType: "knowledge", assetId: "know-7", version: "1.0.0" });
    expect(guard.blocked).toBe(false);
    expect(guard.referencingServices).toEqual([]);
  });

  it("always reports the Run check as unavailable today (no agent-runtime run-listing contract yet)", () => {
    installKnowledge("know-8", "1.0.0");
    const guard = checkAssetRemoval(layout, store, { assetType: "knowledge", assetId: "know-8", version: "1.0.0" });
    expect(guard.runCheckAvailable).toBe(false);
    expect(guard.runCheckNote).toBeTruthy();
  });
});

describe("getAssetDependencyView", () => {
  it("shows a Service's own bindings as forward dependencies, with installed-status resolved", () => {
    installKnowledge("know-9", "1.0.0");
    installService("svc-3", "1.0.0", {
      id: "svc-3",
      name: "HR 정책 챗봇",
      agent_ref: { id: "missing-agent", version: "1.0.0" },
      knowledge_bindings: [{ role_id: "primary", knowledge_id: "know-9", knowledge_version: "1.0.0" }],
    });

    const view = getAssetDependencyView(layout, store, store.find("service", "svc-3", "1.0.0")!);
    expect(view.forwardNote).toBeNull();
    const knowledgeDep = view.forward.find((d) => d.refType === "knowledge_bindings");
    expect(knowledgeDep?.installed).toBe(true);
    const agentDep = view.forward.find((d) => d.refType === "agent_ref");
    expect(agentDep?.installed).toBe(false);
  });

  it("shows referencedBy for a non-Service asset, with a note explaining forward deps are unavailable", () => {
    installKnowledge("know-10", "1.0.0");
    installService("svc-4", "1.0.0", {
      id: "svc-4",
      name: "HR 정책 챗봇",
      agent_ref: { id: "a1", version: "1.0.0" },
      knowledge_bindings: [{ role_id: "primary", knowledge_id: "know-10", knowledge_version: "1.0.0" }],
    });

    const view = getAssetDependencyView(layout, store, store.find("knowledge", "know-10", "1.0.0")!);
    expect(view.forward).toEqual([]);
    expect(view.forwardNote).toBeTruthy();
    expect(view.referencedBy).toEqual([{ assetId: "svc-4", name: "HR 정책 챗봇", version: "1.0.0", via: "knowledge_bindings" }]);
  });
});

describe("listInstalledAssetsWithStatus", () => {
  it("attaches a computed status to every installed asset", () => {
    installKnowledge("know-11", "1.0.0");
    const list = listInstalledAssetsWithStatus(layout, store);
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("ACTIVE");
  });

  it("reflects REVOKED once a revocation list is persisted to the state dir", () => {
    installKnowledge("know-12", "1.0.0");
    fs.writeFileSync(
      path.join(layout.stateDir, "revocation-list.json"),
      JSON.stringify([{ asset_id: "know-12", version: "1.0.0", status: "REVOKED" }]),
    );
    const list = listInstalledAssetsWithStatus(layout, store);
    expect(list.find((a) => a.assetId === "know-12")?.status).toBe("REVOKED");
  });

  // D12/D-068: this is the status filter finally producing INACTIVE now that
  // an Active Pointer actually exists (previously it never could — see the
  // module docstrings this closes).
  it("D-068 resolved: reports INACTIVE for a non-active version once an Active Pointer is recorded for that assetId", () => {
    installKnowledge("know-13", "1.0.0");
    installKnowledge("know-13", "2.0.0");
    new ActiveVersionStore(layout.stateDir).set("knowledge", "know-13", "2.0.0");

    const list = listInstalledAssetsWithStatus(layout, store);
    expect(list.find((a) => a.version === "1.0.0" && a.assetId === "know-13")?.status).toBe("INACTIVE");
    expect(list.find((a) => a.version === "2.0.0" && a.assetId === "know-13")?.status).toBe("ACTIVE");
  });
});

describe("checkAssetRemoval — Active Pointer axis (D12/D-068)", () => {
  it("blocks removing the Active Version while another installed version could be switched to first", () => {
    installKnowledge("know-20", "1.0.0");
    installKnowledge("know-20", "2.0.0");
    new ActiveVersionStore(layout.stateDir).set("knowledge", "know-20", "1.0.0");

    const guard = checkAssetRemoval(layout, store, { assetType: "knowledge", assetId: "know-20", version: "1.0.0" });
    expect(guard.blocked).toBe(true);
    expect(guard.blockedByActiveVersion).toBe(true);
    expect(guard.activeVersionNote).toBeTruthy();
  });

  it("allows removing the inactive (non-active) version freely", () => {
    installKnowledge("know-21", "1.0.0");
    installKnowledge("know-21", "2.0.0");
    new ActiveVersionStore(layout.stateDir).set("knowledge", "know-21", "1.0.0");

    const guard = checkAssetRemoval(layout, store, { assetType: "knowledge", assetId: "know-21", version: "2.0.0" });
    expect(guard.blocked).toBe(false);
    expect(guard.blockedByActiveVersion).toBe(false);
  });

  it("allows removing a single installed version even though it counts as 'active' (removes the whole asset)", () => {
    installKnowledge("know-22", "1.0.0");
    const guard = checkAssetRemoval(layout, store, { assetType: "knowledge", assetId: "know-22", version: "1.0.0" });
    expect(guard.blocked).toBe(false);
  });
});

describe("diffAssetVersions", () => {
  it("computes a Manifest diff between two installed versions of the same asset", () => {
    installKnowledge("know-30", "1.0.0", { id: "know-30", name: "재택근무 정책", classification: "INTERNAL" });
    installKnowledge("know-30", "2.0.0", { id: "know-30", name: "재택근무 정책 (개정)", classification: "INTERNAL" });

    const response = diffAssetVersions(layout, store, {
      assetType: "knowledge",
      assetId: "know-30",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
    });
    expect(response.available).toBe(true);
    expect(response.diff!.hasChanges).toBe(true);
    expect(response.diff!.entries.some((e) => e.field === "name")).toBe(true);
  });

  it("is unavailable with a stated reason when either version isn't actually installed", () => {
    installKnowledge("know-31", "1.0.0");
    const response = diffAssetVersions(layout, store, {
      assetType: "knowledge",
      assetId: "know-31",
      fromVersion: "1.0.0",
      toVersion: "9.9.9",
    });
    expect(response.available).toBe(false);
    expect(response.reason).toBeTruthy();
    expect(response.diff).toBeNull();
  });

  it("is unavailable with a stated reason when neither side has a readable manifest (both STANDARD_LOCAL_COPY)", () => {
    installKnowledge("know-32", "1.0.0", null);
    installKnowledge("know-32", "2.0.0", null);
    const response = diffAssetVersions(layout, store, {
      assetType: "knowledge",
      assetId: "know-32",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
    });
    expect(response.available).toBe(false);
    expect(response.reason).toBeTruthy();
  });
});

describe("activateAssetVersion", () => {
  it("D12 Active Pointer 전환: activates an inactive installed version", () => {
    installKnowledge("know-40", "1.0.0");
    installKnowledge("know-40", "2.0.0");
    new ActiveVersionStore(layout.stateDir).set("knowledge", "know-40", "1.0.0");

    const result = activateAssetVersion(layout, store, { assetType: "knowledge", assetId: "know-40", version: "2.0.0" });
    expect(result.ok).toBe(true);
    expect(new ActiveVersionStore(layout.stateDir).get("knowledge", "know-40")).toBe("2.0.0");
  });

  it("D12 Rollback: activating an older version again is the same call and works", () => {
    installKnowledge("know-41", "1.0.0");
    installKnowledge("know-41", "2.0.0");
    const avs = new ActiveVersionStore(layout.stateDir);
    avs.set("knowledge", "know-41", "2.0.0");

    const rollback = activateAssetVersion(layout, store, { assetType: "knowledge", assetId: "know-41", version: "1.0.0" });
    expect(rollback.ok).toBe(true);
    expect(avs.get("knowledge", "know-41")).toBe("1.0.0");
  });

  it("refuses to activate a REVOKED version (no guessing)", () => {
    installKnowledge("know-42", "1.0.0");
    installKnowledge("know-42", "2.0.0");
    fs.writeFileSync(
      path.join(layout.stateDir, "revocation-list.json"),
      JSON.stringify([{ asset_id: "know-42", version: "2.0.0", status: "REVOKED" }]),
    );
    new ActiveVersionStore(layout.stateDir).set("knowledge", "know-42", "1.0.0");

    const result = activateAssetVersion(layout, store, { assetType: "knowledge", assetId: "know-42", version: "2.0.0" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(new ActiveVersionStore(layout.stateDir).get("knowledge", "know-42")).toBe("1.0.0");
  });

  it("refuses to activate an already-active version", () => {
    installKnowledge("know-43", "1.0.0");
    const result = activateAssetVersion(layout, store, { assetType: "knowledge", assetId: "know-43", version: "1.0.0" });
    expect(result.ok).toBe(false);
  });

  it("refuses to activate a version that isn't installed", () => {
    installKnowledge("know-44", "1.0.0");
    const result = activateAssetVersion(layout, store, { assetType: "knowledge", assetId: "know-44", version: "9.9.9" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("cleanupOrphanedInstalls — D12 '실패 설치 정리'", () => {
  it("removes a version directory that has no corresponding InstalledAssetsStore record", () => {
    installKnowledge("know-50", "1.0.0");
    // Simulate a partially-failed install: a directory exists on disk (as if
    // fs.cpSync had started copying files for a new version) but the
    // install loop never reached `store.upsert` for it — exactly the state
    // an interrupted copy leaves behind.
    const orphanDir = assetInstallDir(layout, "knowledge", "know-50", "2.0.0");
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, "partial.txt"), "incomplete");

    const result = cleanupOrphanedInstalls(layout, store);
    expect(result.removed).toEqual([{ assetType: "knowledge", assetId: "know-50", version: "2.0.0" }]);
    expect(fs.existsSync(orphanDir)).toBe(false);
    // The good, fully-installed version is completely untouched.
    expect(fs.existsSync(assetInstallDir(layout, "knowledge", "know-50", "1.0.0"))).toBe(true);
    expect(store.find("knowledge", "know-50", "1.0.0")).toBeDefined();
  });

  it("is idempotent — a second run with nothing left to clean returns an empty list", () => {
    installKnowledge("know-51", "1.0.0");
    const orphanDir = assetInstallDir(layout, "knowledge", "know-51", "2.0.0");
    fs.mkdirSync(orphanDir, { recursive: true });

    const first = cleanupOrphanedInstalls(layout, store);
    expect(first.removed).toHaveLength(1);
    const second = cleanupOrphanedInstalls(layout, store);
    expect(second.removed).toEqual([]);
  });

  it("never removes a properly-installed version even with only one version present", () => {
    installKnowledge("know-52", "1.0.0");
    const result = cleanupOrphanedInstalls(layout, store);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(assetInstallDir(layout, "knowledge", "know-52", "1.0.0"))).toBe(true);
  });
});

// The core D12 safety property: a failed install must never leave the
// previously-working Active Version broken, and any partial artifacts from
// the failed attempt must be cleanable up afterwards without touching it.
// This drives `importBundle` for real (not a mock) against the same
// fixtures `bundle-install.test.ts` uses, exactly the pipeline D12 reuses.
describe("D12 safety property: a failed import never disturbs the previous Active Version", () => {
  it("leaves the existing installed+active Knowledge version, its files, and its Active Pointer completely intact after a failed CHECKSUM import", async () => {
    // Step 1: a real, successful install — this becomes the Active Version.
    const goodResult = await importBundle(path.join(FIXTURES_DIR, "valid-bundle.zip"), layout, () => {});
    expect(goodResult.outcome).toBe("SUCCESS");
    const assetId = goodResult.installPlan[0].asset_id!;
    const version = goodResult.installPlan[0].version!;

    const activeVersionStore = new ActiveVersionStore(layout.stateDir);
    activeVersionStore.set("knowledge", assetId, version);
    const installedDir = assetInstallDir(layout, "knowledge", assetId, version);
    const manifestBefore = fs.readFileSync(path.join(installedDir, "manifest.json"), "utf-8");

    // Step 2: attempt to import a bundle that fails verification (tampered
    // checksum — fails BEFORE the install loop ever runs, same as any other
    // pre-install-loop failure the 15-stage checklist can produce).
    const badResult = await importBundle(path.join(FIXTURES_DIR, "tampered-checksum.zip"), layout, () => {});
    expect(badResult.outcome).toBe("FAILED");

    // The previously-installed, active version is byte-for-byte untouched.
    expect(fs.readFileSync(path.join(installedDir, "manifest.json"), "utf-8")).toBe(manifestBefore);
    const record = new InstalledAssetsStore(layout.stateDir).find("knowledge", assetId, version);
    expect(record).toBeDefined();
    expect(record?.version).toBe(version);
    // The Active Pointer still points at it.
    expect(activeVersionStore.get("knowledge", assetId)).toBe(version);
    expect(
      listInstalledAssetsWithStatus(layout, new InstalledAssetsStore(layout.stateDir)).find(
        (a) => a.assetId === assetId && a.version === version,
      )?.status,
    ).toBe("ACTIVE");

    // "실패 설치 정리" is safe to run afterwards and finds nothing to do —
    // the failed attempt never touched assetsDir (it failed before the
    // install loop), so there is no orphan to clean up, and definitely
    // nothing is removed from the good version.
    const cleanup = cleanupOrphanedInstalls(layout, new InstalledAssetsStore(layout.stateDir));
    expect(cleanup.removed).toEqual([]);
    expect(fs.existsSync(installedDir)).toBe(true);
  });
});
