import { describe, expect, it } from "vitest";
import type { InstalledAsset } from "../../electron/types";
import { LEGACY_BUNDLE_KNOWLEDGE_ID_REASON, resolveKnowledgeSelection } from "./chatTypes";

function installedAsset(overrides: Partial<InstalledAsset> = {}): InstalledAsset {
  return {
    assetId: "asset-1",
    assetVersionId: "asset-version-1",
    assetType: "knowledge",
    name: "HR 정책 Knowledge",
    version: "1.0.0",
    installedAt: "2026-08-09T00:00:00.000Z",
    sizeBytes: 1234,
    bundleId: "bundle-1",
    ...overrides,
  };
}

describe("resolveKnowledgeSelection (D-060)", () => {
  it("returns an empty, non-disabled selection when nothing is selected", () => {
    expect(resolveKnowledgeSelection(null)).toEqual({ knowledgeId: "", disabledReason: null });
  });

  it("sends the AssetVersion id (not the Asset id) as knowledge_id when present", () => {
    const asset = installedAsset({ assetId: "asset-1", assetVersionId: "asset-version-1" });

    const selection = resolveKnowledgeSelection(asset);

    expect(selection).toEqual({ knowledgeId: "asset-version-1", disabledReason: null });
    // Regression guard: the two ids must never be conflated by this function.
    expect(selection.knowledgeId).not.toBe(asset.assetId);
  });

  it("refuses to fall back to assetId and reports the legacy-Bundle reason when assetVersionId is missing", () => {
    const legacyAsset = installedAsset({ assetId: "asset-1", assetVersionId: null });

    const selection = resolveKnowledgeSelection(legacyAsset);

    expect(selection.knowledgeId).toBe("");
    expect(selection.knowledgeId).not.toBe(legacyAsset.assetId);
    expect(selection.disabledReason).toBe(LEGACY_BUNDLE_KNOWLEDGE_ID_REASON);
  });
});
