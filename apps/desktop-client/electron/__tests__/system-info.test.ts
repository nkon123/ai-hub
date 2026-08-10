// D13 정보/보안. `summarizeOpenSourceNotices` is pure — tested with a fake
// resolver, no real `node_modules` access — while `buildSystemInfo` itself
// is exercised against a real temp install layout (mirrors
// `diagnostic-bundle.test.ts`'s approach for the same kind of orchestrator).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInstallRoot, type InstallRootLayout } from "../bundle-install";
import { buildSystemInfo, SUPPORTED_MANIFEST_SCHEMA_VERSION, summarizeOpenSourceNotices } from "../system-info";

describe("summarizeOpenSourceNotices", () => {
  it("resolves each declared dependency's installed version/license via the injected resolver", () => {
    const result = summarizeOpenSourceNotices({ react: "^18.3.1", yaml: "^2.5.0" }, (name) =>
      name === "react" ? { version: "18.3.1", license: "MIT" } : null,
    );
    expect(result.entries).toEqual([
      { name: "react", declaredRange: "^18.3.1", resolvedVersion: "18.3.1", license: "MIT" },
      { name: "yaml", declaredRange: "^2.5.0", resolvedVersion: null, license: null },
    ]);
    // Sorted alphabetically, not insertion order — a stable, predictable
    // table for the D13 UI.
    expect(result.entries.map((e) => e.name)).toEqual(["react", "yaml"]);
  });

  it("always marks the notice incomplete with a stated reason — never implies a full transitive OSS notice", () => {
    const result = summarizeOpenSourceNotices({}, () => null);
    expect(result.incomplete).toBe(true);
    expect(result.incompleteReason.length).toBeGreaterThan(0);
  });
});

let tmpRoot: string;
let layout: InstallRootLayout;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-system-info-"));
  layout = resolveInstallRoot(tmpRoot);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("buildSystemInfo", () => {
  it("reports the shared Manifest schema_version constant with its source", async () => {
    const info = await buildSystemInfo(layout);
    expect(info.schemaVersion.supportedVersion).toBe(SUPPORTED_MANIFEST_SCHEMA_VERSION);
    expect(info.schemaVersion.source.length).toBeGreaterThan(0);
  });

  it("reuses bundle-verify.ts's exact Signature/Trust wording rather than a second, drifting message", async () => {
    const info = await buildSystemInfo(layout);
    expect(info.trustStore.status).toBe("NOT_IMPLEMENTED");
    expect(info.trustStore.message).toContain("Signature");
  });

  it("reports zero known Revocation entries and no local-update timestamp when none was ever merged", async () => {
    const info = await buildSystemInfo(layout);
    expect(info.revocationList.knownEntryCount).toBe(0);
    expect(info.revocationList.lastLocalUpdateAt).toBeNull();
  });

  it("reflects a real revocation-list.json's entry count and file mtime once one exists", async () => {
    const revocationPath = path.join(layout.stateDir, "revocation-list.json");
    fs.writeFileSync(revocationPath, JSON.stringify([{ asset_id: "a1", version: "1.0.0", status: "REVOKED" }]));
    const info = await buildSystemInfo(layout);
    expect(info.revocationList.knownEntryCount).toBe(1);
    expect(info.revocationList.lastLocalUpdateAt).not.toBeNull();
  });

  it("resolves real data locations under the given install layout — an operator can find every path", async () => {
    const info = await buildSystemInfo(layout);
    expect(info.dataLocations.installRoot).toBe(layout.root);
    expect(info.dataLocations.assetsDir).toBe(layout.assetsDir);
    expect(info.dataLocations.stateDir).toBe(layout.stateDir);
    expect(info.dataLocations.logsDir).toBe(path.join(layout.stateDir, "logs"));
    expect(info.dataLocations.diagnosticsDir).toBe(path.join(layout.root, "diagnostics"));
  });

  it("resolves this app's own direct dependencies from the real package.json/node_modules (not a fabricated list)", async () => {
    const info = await buildSystemInfo(layout);
    expect(info.openSourceNotices.entries.length).toBeGreaterThan(0);
    const reactEntry = info.openSourceNotices.entries.find((e) => e.name === "react");
    expect(reactEntry).toBeDefined();
    expect(reactEntry!.resolvedVersion).toBeTruthy();
    expect(reactEntry!.license).toBeTruthy();
    expect(info.openSourceNotices.incomplete).toBe(true);
  });
});
