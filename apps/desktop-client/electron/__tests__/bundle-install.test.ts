// Integration tests for the full Offline Bundle import pipeline
// (`bundle-install.ts`), run against real ZIP fixtures — not just the pure
// functions in isolation — because a security control "verified" only by
// reading the code is not verified. Fixtures live in `__tests__/fixtures/`
// (see `generate.py` for how they were produced) and `valid-bundle.zip` is
// an unmodified copy of a real Offline Bundle produced by
// `services/distribution-service`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importBundle, resolveInstallRoot, type InstallRootLayout } from "../bundle-install";
import { InstalledAssetsStore } from "../installed-assets-store";
import type { ImportProgressEvent } from "../types";

const FIXTURES_DIR = path.join(__dirname, "fixtures");

let tmpRoot: string;
let layout: InstallRootLayout;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-test-"));
  layout = resolveInstallRoot(tmpRoot);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function run(fixtureName: string) {
  const events: ImportProgressEvent[] = [];
  return importBundle(path.join(FIXTURES_DIR, fixtureName), layout, (e) => events.push(e)).then((result) => ({
    result,
    events,
  }));
}

describe("importBundle — security-critical rejections", () => {
  it("rejects a zip-slip entry (path escaping the extraction root) and cleans up quarantine", async () => {
    const { result } = await run("zip-slip.zip");
    expect(result.outcome).toBe("FAILED");
    expect(result.failedStage).toBe("PATH_SAFETY");
    expect(result.retryable).toBe(false);

    // Nothing should have been extracted or installed.
    expect(fs.readdirSync(layout.quarantineDir)).toHaveLength(0);
    expect(fs.existsSync(path.join(layout.assetsDir))).toBe(true);
    expect(fs.readdirSync(layout.assetsDir)).toHaveLength(0);
    // And critically: no file was ever written outside the extraction root.
    expect(fs.existsSync(path.join(tmpRoot, "..", "evil.txt"))).toBe(false);
  });

  it("rejects an absolute-path entry", async () => {
    const { result } = await run("absolute-path.zip");
    expect(result.outcome).toBe("FAILED");
    expect(result.failedStage).toBe("PATH_SAFETY");
    expect(fs.existsSync("/etc/passwd-pwned")).toBe(false);
  });

  it("rejects an oversized/zip-bomb archive before extracting it", async () => {
    const { result } = await run("zip-bomb.zip");
    expect(result.outcome).toBe("FAILED");
    expect(result.failedStage).toBe("SIZE_CAP");
    // The bomb must never have been decompressed onto disk.
    expect(fs.readdirSync(layout.quarantineDir)).toHaveLength(0);
  });

  it("detects a tampered file via checksum mismatch", async () => {
    const { result } = await run("tampered-checksum.zip");
    expect(result.outcome).toBe("FAILED");
    expect(result.failedStage).toBe("CHECKSUM");
    expect(result.retryable).toBe(true);
  });
});

describe("importBundle — the real Offline Bundle", () => {
  it("passes every check and installs the Knowledge asset", async () => {
    const { result, events } = await run("valid-bundle.zip");

    expect(result.outcome).toBe("SUCCESS");
    expect(result.failedStage).toBeNull();
    expect(result.checks.every((c) => c.status === "PASS" || c.status === "WARN")).toBe(true);
    // Signature/Trust must be reported (D-016), never silently skipped.
    expect(result.checks.find((c) => c.id === "SIGNATURE_TRUST")?.status).toBe("WARN");
    expect(result.installPlan).toHaveLength(1);
    expect(result.installPlan[0].asset_type).toBe("knowledge");
    expect(events.length).toBeGreaterThan(0);

    // The asset actually landed under assets/knowledge/<id>/<version>/.
    const assetId = result.installPlan[0].asset_id!;
    const version = result.installPlan[0].version!;
    const installedDir = path.join(layout.assetsDir, "knowledge", assetId, version);
    expect(fs.existsSync(path.join(installedDir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(installedDir, "source", "remote-work-policy.md"))).toBe(true);
    expect(fs.existsSync(path.join(installedDir, "index", "bm25.pkl"))).toBe(true);

    // The install is recorded for D02's asset list.
    const store = new InstalledAssetsStore(layout.stateDir);
    const record = store.find("knowledge", assetId, version);
    expect(record).toBeDefined();
    expect(record?.name).toContain("재택근무");

    // Temp copies are cleaned up per §4.6 Rollback (success also cleans up).
    expect(fs.readdirSync(layout.quarantineDir)).toHaveLength(0);
  });

  it("D08: records per-file checksums so 'Checksum 재검사' has a real baseline to compare against", async () => {
    const { result } = await run("valid-bundle.zip");
    const assetId = result.installPlan[0].asset_id!;
    const version = result.installPlan[0].version!;
    const store = new InstalledAssetsStore(layout.stateDir);
    const record = store.find("knowledge", assetId, version)!;

    expect(record.fileChecksums).toBeDefined();
    expect(record.fileChecksums!["manifest.json"]).toMatch(/^[0-9a-f]{64}$/);
    expect(record.fileChecksums!["source/remote-work-policy.md"]).toMatch(/^[0-9a-f]{64}$/);
    // The recorded hash is the ACTUAL file's hash, not a placeholder.
    const actualHash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(layout.assetsDir, "knowledge", assetId, version, "manifest.json")))
      .digest("hex");
    expect(record.fileChecksums!["manifest.json"]).toBe(actualHash);
    expect(record.checksumVerification).toBeNull();
  });

  it("does not modify the original fixture file", async () => {
    const before = fs.readFileSync(path.join(FIXTURES_DIR, "valid-bundle.zip"));
    await run("valid-bundle.zip");
    const after = fs.readFileSync(path.join(FIXTURES_DIR, "valid-bundle.zip"));
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it("D-060: records assetVersionId as null for a legacy Bundle that predates the field", async () => {
    // valid-bundle.zip is a REAL Bundle produced before D-060 — its
    // included_assets[] has no asset_version_id key at all. The install
    // must not fabricate one (and must not fall back to asset_id).
    const { result } = await run("valid-bundle.zip");
    expect(result.outcome).toBe("SUCCESS");

    const assetId = result.installPlan[0].asset_id!;
    const version = result.installPlan[0].version!;
    const store = new InstalledAssetsStore(layout.stateDir);
    const record = store.find("knowledge", assetId, version);
    expect(record).toBeDefined();
    expect(record?.assetVersionId).toBeNull();
  });
});

describe("importBundle — D-060 AssetVersion id fix (real post-fix Bundle)", () => {
  it("records the AssetVersion id from a Bundle built after the fix, distinct from the Asset id", async () => {
    // valid-bundle-with-version-id.zip is a REAL Bundle built via
    // distribution_service.bundler AFTER the D-060 fix (see generate.py) —
    // its included_assets[] carries asset_version_id, deliberately
    // different from asset_id for every non-STANDARD_LOCAL_COPY item.
    const { result } = await run("valid-bundle-with-version-id.zip");
    expect(result.outcome).toBe("SUCCESS");

    const knowledgeItem = result.installPlan.find((i) => i.asset_type === "knowledge")!;
    expect(knowledgeItem.asset_version_id).toBeTruthy();
    expect(knowledgeItem.asset_version_id).not.toBe(knowledgeItem.asset_id);

    const store = new InstalledAssetsStore(layout.stateDir);
    const record = store.find("knowledge", knowledgeItem.asset_id!, knowledgeItem.version!);
    expect(record).toBeDefined();
    expect(record?.assetVersionId).toBe(knowledgeItem.asset_version_id);
    expect(record?.assetVersionId).not.toBe(record?.assetId);
  });
});
