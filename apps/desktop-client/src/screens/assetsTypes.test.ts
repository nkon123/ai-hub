import { describe, expect, it } from "vitest";
import { emptyAssetFilters, filterInstalledAssets, sortInstalledAssets } from "./assetsTypes";
import type { InstalledAssetWithStatus } from "../../electron/types";

function asset(overrides: Partial<InstalledAssetWithStatus>): InstalledAssetWithStatus {
  return {
    assetId: "a1",
    assetVersionId: null,
    assetType: "knowledge",
    name: "재택근무 정책",
    version: "1.0.0",
    installedAt: "2026-08-01T00:00:00.000Z",
    sizeBytes: 100,
    bundleId: "b1",
    checksumVerification: null,
    status: "ACTIVE",
    ...overrides,
  };
}

describe("filterInstalledAssets", () => {
  const assets = [
    asset({ assetId: "know-1", assetType: "knowledge", status: "ACTIVE" }),
    asset({ assetId: "agent-1", assetType: "agent", status: "REVOKED" }),
    asset({ assetId: "svc-1", assetType: "service", status: "INVALID" }),
  ];

  it("returns every asset when no filter is set", () => {
    expect(filterInstalledAssets(assets, emptyAssetFilters())).toHaveLength(3);
  });

  it("filters by asset type", () => {
    const result = filterInstalledAssets(assets, { assetTypes: new Set(["knowledge"]), statuses: new Set() });
    expect(result.map((a) => a.assetId)).toEqual(["know-1"]);
  });

  it("filters by status", () => {
    const result = filterInstalledAssets(assets, { assetTypes: new Set(), statuses: new Set(["REVOKED"]) });
    expect(result.map((a) => a.assetId)).toEqual(["agent-1"]);
  });

  it("combines type and status filters (AND, not OR)", () => {
    const result = filterInstalledAssets(assets, {
      assetTypes: new Set(["service"]),
      statuses: new Set(["REVOKED"]), // svc-1 is INVALID, not REVOKED
    });
    expect(result).toEqual([]);
  });

  it("returns an empty result for INACTIVE — no asset is ever computed as INACTIVE today (D-068)", () => {
    const result = filterInstalledAssets(assets, { assetTypes: new Set(), statuses: new Set(["INACTIVE"]) });
    expect(result).toEqual([]);
  });
});

describe("sortInstalledAssets", () => {
  const assets = [
    asset({ assetId: "a", version: "1.2.0", sizeBytes: 300, installedAt: "2026-08-02T00:00:00.000Z" }),
    asset({ assetId: "b", version: "1.10.0", sizeBytes: 100, installedAt: "2026-08-01T00:00:00.000Z" }),
    asset({ assetId: "c", version: "1.3.0", sizeBytes: 200, installedAt: "2026-08-03T00:00:00.000Z" }),
  ];

  it("sorts by version numerically (1.10.0 after 1.3.0, not before)", () => {
    const result = sortInstalledAssets(assets, "version", "asc");
    expect(result.map((a) => a.assetId)).toEqual(["a", "c", "b"]);
  });

  it("sorts by size ascending", () => {
    const result = sortInstalledAssets(assets, "sizeBytes", "asc");
    expect(result.map((a) => a.assetId)).toEqual(["b", "c", "a"]);
  });

  it("sorts by install date descending (default)", () => {
    const result = sortInstalledAssets(assets, "installedAt");
    expect(result.map((a) => a.assetId)).toEqual(["c", "a", "b"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...assets];
    sortInstalledAssets(assets, "version");
    expect(assets).toEqual(copy);
  });
});
