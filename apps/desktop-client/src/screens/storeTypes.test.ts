import { describe, expect, it } from "vitest";
import type { InstalledAssetWithStatus, PortalCatalogAsset, PortalCatalogVersion } from "../../electron/types";
import {
  compareVersions,
  computeCatalogItemView,
  computeCatalogView,
  filterCatalogView,
  latestApprovedVersion,
  notInstallableReason,
  revokedInstallReason,
} from "./storeTypes";

/** D-072: every `PortalCatalogVersion` literal below must carry
 * `activeRevocation` — defaults to null (not effectively revoked) so
 * existing fixtures keep meaning "설치 가능한 평범한 버전" unless a test
 * explicitly overrides it. */
function catalogVersion(overrides: Partial<PortalCatalogVersion> = {}): PortalCatalogVersion {
  return {
    id: "v1",
    version: "1.0.0",
    status: "APPROVED",
    activeRevocation: null,
    ...overrides,
  };
}

function installedAsset(overrides: Partial<InstalledAssetWithStatus> = {}): InstalledAssetWithStatus {
  return {
    assetId: "asset-1",
    assetVersionId: "av-1",
    assetType: "knowledge",
    name: "재택근무 정책",
    version: "1.0.0",
    installedAt: "2026-01-01T00:00:00.000Z",
    sizeBytes: 100,
    bundleId: "bundle-1",
    status: "ACTIVE",
    ...overrides,
  };
}

function catalogAsset(overrides: Partial<PortalCatalogAsset> = {}): PortalCatalogAsset {
  return {
    id: "asset-1",
    type: "knowledge",
    name: "재택근무 정책",
    classification: "INTERNAL",
    versions: [catalogVersion({ id: "av-1", version: "1.0.0", status: "APPROVED" })],
    ...overrides,
  };
}

describe("compareVersions", () => {
  it("orders numerically, not lexicographically", () => {
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("treats a missing trailing segment as 0", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBeGreaterThan(0);
  });

  it("falls back to string comparison instead of throwing on non-numeric segments", () => {
    expect(() => compareVersions("1.a.0", "1.b.0")).not.toThrow();
  });
});

describe("latestApprovedVersion", () => {
  it("returns null when there is no APPROVED version", () => {
    expect(
      latestApprovedVersion([
        catalogVersion({ id: "v1", version: "1.0.0", status: "DRAFT" }),
        catalogVersion({ id: "v2", version: "2.0.0", status: "REJECTED" }),
      ]),
    ).toBeNull();
  });

  it("picks the highest-semver APPROVED version, ignoring a newer but unapproved one", () => {
    const result = latestApprovedVersion([
      catalogVersion({ id: "v1", version: "1.0.0", status: "APPROVED" }),
      catalogVersion({ id: "v2", version: "2.0.0", status: "IN_REVIEW" }), // 최신이지만 미승인 — 절대 선택되면 안 됨
      catalogVersion({ id: "v3", version: "1.5.0", status: "APPROVED" }),
    ]);
    expect(result?.version).toBe("1.5.0");
  });
});

describe("filterCatalogView", () => {
  const views = computeCatalogView(
    [
      catalogAsset({ id: "knowledge-1", name: "재택근무 정책", type: "knowledge" }),
      catalogAsset({ id: "mcp-1", name: "DB 메타데이터", type: "mcp_tool" }),
      catalogAsset({ id: "agent-1", name: "규정 안내 Agent", type: "agent" }),
      catalogAsset({ id: "prompt-1", name: "질의 재작성 Prompt", type: "prompt" }),
    ],
    [],
  );

  it("filters Knowledge and MCP Tool without hiding other types from the all view", () => {
    expect(filterCatalogView(views, { query: "", assetType: "knowledge" }).map((v) => v.asset.id)).toEqual([
      "knowledge-1",
    ]);
    expect(filterCatalogView(views, { query: "", assetType: "mcp_tool" }).map((v) => v.asset.id)).toEqual([
      "mcp-1",
    ]);
    expect(filterCatalogView(views, { query: "", assetType: "all" })).toHaveLength(4);
  });

  it("filters Agent and Prompt the same way as Knowledge/MCP Tool", () => {
    expect(filterCatalogView(views, { query: "", assetType: "agent" }).map((v) => v.asset.id)).toEqual([
      "agent-1",
    ]);
    expect(filterCatalogView(views, { query: "", assetType: "prompt" }).map((v) => v.asset.id)).toEqual([
      "prompt-1",
    ]);
  });

  it("matches names case-insensitively and trims the query", () => {
    expect(filterCatalogView(views, { query: "  db ", assetType: "all" }).map((v) => v.asset.id)).toEqual(["mcp-1"]);
  });
});

describe("notInstallableReason", () => {
  it("reports 'no versions' when the asset has none", () => {
    expect(notInstallableReason([])).toContain("등록된 버전이 없습니다");
  });

  it("names the latest version and a Korean label for every non-APPROVED status", () => {
    const statuses = [
      "DRAFT",
      "VALIDATING",
      "READY_FOR_REVIEW",
      "IN_REVIEW",
      "CHANGES_REQUESTED",
      "REJECTED",
      "SUSPENDED",
      "DEPRECATED",
      "RETIRED",
    ];
    for (const status of statuses) {
      const reason = notInstallableReason([catalogVersion({ id: "v1", version: "1.0.0", status })]);
      expect(reason).toContain("v1.0.0");
      expect(reason).not.toContain("알 수 없는 상태");
    }
  });

  it("never throws on an unrecognized status — labels it explicitly instead of guessing", () => {
    const reason = notInstallableReason([catalogVersion({ id: "v1", version: "1.0.0", status: "SOMETHING_NEW" })]);
    expect(reason).toContain("알 수 없는 상태(SOMETHING_NEW)");
  });
});

describe("revokedInstallReason", () => {
  it("includes the server-provided reason when present", () => {
    const version = catalogVersion({
      version: "1.0.0",
      activeRevocation: { effectiveAt: "2026-08-09T00:00:00Z", reason: "보안 취약점 발견" },
    });
    const reason = revokedInstallReason(version);
    expect(reason).toContain("v1.0.0");
    expect(reason).toContain("긴급 회수");
    expect(reason).toContain("보안 취약점 발견");
  });

  it("does not fabricate a reason when the server masked it (role-gated, D-072)", () => {
    const version = catalogVersion({
      version: "1.0.0",
      activeRevocation: { effectiveAt: "2026-08-09T00:00:00Z", reason: null },
    });
    const reason = revokedInstallReason(version);
    expect(reason).toContain("v1.0.0");
    expect(reason).toContain("긴급 회수");
    expect(reason).not.toContain("null");
    expect(reason).toContain("관리자에게 문의");
  });
});

describe("computeCatalogItemView", () => {
  it("is NOT_INSTALLABLE with a reason when no version is APPROVED", () => {
    const asset = catalogAsset({
      versions: [catalogVersion({ id: "v1", version: "1.0.0", status: "SUSPENDED" })],
    });
    const view = computeCatalogItemView(asset, []);
    expect(view.state).toBe("NOT_INSTALLABLE");
    expect(view.installableVersion).toBeNull();
    expect(view.reason).toContain("일시 중단");
  });

  it("D-072: is NOT_INSTALLABLE with a reason when the latest APPROVED version is effectively revoked", () => {
    const asset = catalogAsset({
      versions: [
        catalogVersion({
          id: "v1",
          version: "1.0.0",
          status: "APPROVED",
          activeRevocation: { effectiveAt: "2026-08-09T00:00:00Z", reason: "보안 취약점 발견" },
        }),
      ],
    });
    const view = computeCatalogItemView(asset, []);
    expect(view.state).toBe("NOT_INSTALLABLE");
    expect(view.installableVersion).toBeNull();
    expect(view.reason).toContain("긴급 회수");
    expect(view.reason).toContain("보안 취약점 발견");
  });

  it("D-072: a future-dated revocation (activeRevocation null) does not block installation", () => {
    // portal-api only ever populates `active_revocation` for a revocation
    // whose `effective_at` has already passed — a future-dated one leaves
    // it null. This test guards the Desktop side of that contract: it must
    // trust `activeRevocation === null` and never re-derive "future vs
    // past" itself from data it doesn't have.
    const asset = catalogAsset({
      versions: [catalogVersion({ id: "v1", version: "1.0.0", status: "APPROVED", activeRevocation: null })],
    });
    const view = computeCatalogItemView(asset, []);
    expect(view.state).toBe("INSTALLABLE");
    expect(view.installableVersion?.version).toBe("1.0.0");
    expect(view.reason).toBeNull();
  });

  it("D-072: does not fall back to an older APPROVED version when the latest one is revoked", () => {
    const asset = catalogAsset({
      versions: [
        catalogVersion({ id: "v1", version: "1.0.0", status: "APPROVED", activeRevocation: null }),
        catalogVersion({
          id: "v2",
          version: "2.0.0",
          status: "APPROVED",
          activeRevocation: { effectiveAt: "2026-08-09T00:00:00Z", reason: "보안 취약점 발견" },
        }),
      ],
    });
    const view = computeCatalogItemView(asset, []);
    // Must show the asset as blocked, not silently install v1.0.0 instead —
    // dodging a visible revocation this way would be worse than showing
    // nothing.
    expect(view.state).toBe("NOT_INSTALLABLE");
    expect(view.installableVersion).toBeNull();
    expect(view.reason).toContain("v2.0.0");
  });

  it("is INSTALLABLE when APPROVED and nothing is installed", () => {
    const view = computeCatalogItemView(catalogAsset(), []);
    expect(view.state).toBe("INSTALLABLE");
    expect(view.installableVersion?.version).toBe("1.0.0");
    expect(view.installedVersion).toBeNull();
    expect(view.reason).toBeNull();
  });

  it("is INSTALLED when the installed version matches the latest APPROVED version", () => {
    const view = computeCatalogItemView(catalogAsset(), [installedAsset({ version: "1.0.0" })]);
    expect(view.state).toBe("INSTALLED");
  });

  it("is UPDATE_AVAILABLE when a newer APPROVED version exists than what's installed", () => {
    const asset = catalogAsset({
      versions: [
        catalogVersion({ id: "v1", version: "1.0.0", status: "APPROVED" }),
        catalogVersion({ id: "v2", version: "2.0.0", status: "APPROVED" }),
      ],
    });
    const view = computeCatalogItemView(asset, [installedAsset({ version: "1.0.0" })]);
    expect(view.state).toBe("UPDATE_AVAILABLE");
    expect(view.installableVersion?.version).toBe("2.0.0");
    expect(view.installedVersion).toBe("1.0.0");
  });

  it("does not confuse installs of a different asset type with the same id", () => {
    const asset = catalogAsset({ type: "agent", id: "shared-id" });
    const installed = [installedAsset({ assetType: "knowledge", assetId: "shared-id", version: "1.0.0" })];
    const view = computeCatalogItemView(asset, installed);
    // agent 자산은 knowledge로 설치된 것과 매칭되면 안 된다 — 여전히 설치 가능해야 함.
    expect(view.state).toBe("INSTALLABLE");
  });

  it("never auto-selects a newer unapproved version even if the user already has an older APPROVED one installed", () => {
    const asset = catalogAsset({
      versions: [
        catalogVersion({ id: "v1", version: "1.0.0", status: "APPROVED" }),
        catalogVersion({ id: "v2", version: "2.0.0", status: "IN_REVIEW" }),
      ],
    });
    const view = computeCatalogItemView(asset, [installedAsset({ version: "1.0.0" })]);
    expect(view.state).toBe("INSTALLED");
    expect(view.installableVersion?.version).toBe("1.0.0");
  });
});

describe("computeCatalogView", () => {
  it("maps every asset independently and preserves order", () => {
    const assets = [catalogAsset({ id: "a" }), catalogAsset({ id: "b", versions: [] })];
    const views = computeCatalogView(assets, []);
    expect(views.map((v) => v.asset.id)).toEqual(["a", "b"]);
    expect(views[0].state).toBe("INSTALLABLE");
    expect(views[1].state).toBe("NOT_INSTALLABLE");
  });
});
