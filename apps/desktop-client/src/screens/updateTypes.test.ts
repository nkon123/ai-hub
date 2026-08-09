import { describe, expect, it } from "vitest";
import {
  activateDisabledReason,
  activationActionLabel,
  findActiveVersion,
  groupInstalledAssetsByAssetId,
  switchableGroups,
  type AssetVersionGroup,
} from "./updateTypes";
import type { InstalledAssetWithStatus } from "../../electron/types";

function asset(overrides: Partial<InstalledAssetWithStatus> & { assetId: string; version: string }): InstalledAssetWithStatus {
  return {
    assetVersionId: null,
    assetType: "knowledge",
    name: "재택근무 정책",
    installedAt: "2026-01-01T00:00:00Z",
    sizeBytes: 100,
    bundleId: "bundle-1",
    checksumVerification: null,
    status: "ACTIVE",
    ...overrides,
  };
}

describe("groupInstalledAssetsByAssetId", () => {
  it("groups multiple installed versions of the same asset together", () => {
    const groups = groupInstalledAssetsByAssetId([
      asset({ assetId: "know-1", version: "1.0.0", status: "INACTIVE" }),
      asset({ assetId: "know-1", version: "2.0.0", status: "ACTIVE" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].versions.map((v) => v.version)).toEqual(["2.0.0", "1.0.0"]); // descending
  });

  it("keeps distinct assetIds as separate groups, even of the same assetType", () => {
    const groups = groupInstalledAssetsByAssetId([
      asset({ assetId: "know-1", version: "1.0.0" }),
      asset({ assetId: "know-2", version: "1.0.0" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("keeps a single-version asset as its own group (nothing to switch, but still listed)", () => {
    const groups = groupInstalledAssetsByAssetId([asset({ assetId: "know-1", version: "1.0.0" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].versions).toHaveLength(1);
  });

  it("treats distinct assetTypes with the same assetId as separate groups", () => {
    const groups = groupInstalledAssetsByAssetId([
      asset({ assetId: "shared-id", version: "1.0.0", assetType: "knowledge" }),
      asset({ assetId: "shared-id", version: "1.0.0", assetType: "agent" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("prefers the Active version's name when versions were renamed across releases", () => {
    const groups = groupInstalledAssetsByAssetId([
      asset({ assetId: "know-1", version: "1.0.0", name: "구 이름", status: "INACTIVE" }),
      asset({ assetId: "know-1", version: "2.0.0", name: "새 이름", status: "ACTIVE" }),
    ]);
    expect(groups[0].name).toBe("새 이름");
  });
});

describe("switchableGroups", () => {
  it("excludes groups with only one installed version", () => {
    const groups: AssetVersionGroup[] = groupInstalledAssetsByAssetId([
      asset({ assetId: "know-1", version: "1.0.0" }),
      asset({ assetId: "know-2", version: "1.0.0" }),
      asset({ assetId: "know-2", version: "2.0.0", status: "INACTIVE" }),
    ]);
    const result = switchableGroups(groups);
    expect(result).toHaveLength(1);
    expect(result[0].assetId).toBe("know-2");
  });
});

describe("findActiveVersion", () => {
  it("finds the version marked ACTIVE within a group", () => {
    const groups = groupInstalledAssetsByAssetId([
      asset({ assetId: "know-1", version: "1.0.0", status: "INACTIVE" }),
      asset({ assetId: "know-1", version: "2.0.0", status: "ACTIVE" }),
    ]);
    expect(findActiveVersion(groups[0])?.version).toBe("2.0.0");
  });

  it("returns null when nothing in the group is ACTIVE (e.g. all Revoked)", () => {
    const groups = groupInstalledAssetsByAssetId([asset({ assetId: "know-1", version: "1.0.0", status: "REVOKED" })]);
    expect(findActiveVersion(groups[0])).toBeNull();
  });
});

describe("activateDisabledReason", () => {
  it("is null (allowed) for an INACTIVE version", () => {
    expect(activateDisabledReason(asset({ assetId: "know-1", version: "1.0.0", status: "INACTIVE" }))).toBeNull();
  });

  it("gives a reason for ACTIVE/REVOKED/INVALID", () => {
    expect(activateDisabledReason(asset({ assetId: "know-1", version: "1.0.0", status: "ACTIVE" }))).toBeTruthy();
    expect(activateDisabledReason(asset({ assetId: "know-1", version: "1.0.0", status: "REVOKED" }))).toBeTruthy();
    expect(activateDisabledReason(asset({ assetId: "know-1", version: "1.0.0", status: "INVALID" }))).toBeTruthy();
  });
});

describe("activationActionLabel", () => {
  it("labels switching to a newer version as '전환'", () => {
    const groups = groupInstalledAssetsByAssetId([
      asset({ assetId: "know-1", version: "1.0.0", status: "ACTIVE" }),
      asset({ assetId: "know-1", version: "2.0.0", status: "INACTIVE" }),
    ]);
    expect(activationActionLabel(groups[0], "2.0.0")).toBe("전환");
  });

  it("labels switching back to an older version as 'Rollback'", () => {
    const groups = groupInstalledAssetsByAssetId([
      asset({ assetId: "know-1", version: "1.0.0", status: "INACTIVE" }),
      asset({ assetId: "know-1", version: "2.0.0", status: "ACTIVE" }),
    ]);
    expect(activationActionLabel(groups[0], "1.0.0")).toBe("Rollback");
  });

  it("labels as '전환' when there is no currently active version to compare against", () => {
    const groups = groupInstalledAssetsByAssetId([asset({ assetId: "know-1", version: "1.0.0", status: "REVOKED" })]);
    expect(activationActionLabel(groups[0], "1.0.0")).toBe("전환");
  });
});
