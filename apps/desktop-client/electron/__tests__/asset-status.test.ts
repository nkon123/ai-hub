import { describe, expect, it } from "vitest";
import { computeAssetStatus, mergeRevocationEntries } from "../asset-status";
import type { RevocationEntry } from "../bundle-verify";

describe("computeAssetStatus", () => {
  it("returns ACTIVE by default (no revocation, no failed verification)", () => {
    expect(computeAssetStatus({ assetId: "a1", version: "1.0.0" }, [])).toBe("ACTIVE");
  });

  it("returns REVOKED when the asset+version appears in the revocation list", () => {
    const entries: RevocationEntry[] = [{ asset_id: "a1", version: "1.0.0", status: "REVOKED" }];
    expect(computeAssetStatus({ assetId: "a1", version: "1.0.0" }, entries)).toBe("REVOKED");
  });

  it("does not revoke a different version of the same asset id", () => {
    const entries: RevocationEntry[] = [{ asset_id: "a1", version: "1.0.0", status: "REVOKED" }];
    expect(computeAssetStatus({ assetId: "a1", version: "2.0.0" }, entries)).toBe("ACTIVE");
  });

  it("revokes every version when the revocation entry has a null version (asset-wide)", () => {
    const entries: RevocationEntry[] = [{ asset_id: "a1", version: null, status: "REVOKED" }];
    expect(computeAssetStatus({ assetId: "a1", version: "9.9.9" }, entries)).toBe("REVOKED");
  });

  it("returns INVALID when the last checksum reverification failed", () => {
    expect(
      computeAssetStatus({ assetId: "a1", version: "1.0.0", checksumVerification: { result: "FAIL" } }, []),
    ).toBe("INVALID");
  });

  it("REVOKED takes priority over a failed checksum verification", () => {
    const entries: RevocationEntry[] = [{ asset_id: "a1", version: "1.0.0", status: "REVOKED" }];
    expect(
      computeAssetStatus({ assetId: "a1", version: "1.0.0", checksumVerification: { result: "FAIL" } }, entries),
    ).toBe("REVOKED");
  });

  it("a passed checksum verification still yields ACTIVE", () => {
    expect(
      computeAssetStatus({ assetId: "a1", version: "1.0.0", checksumVerification: { result: "PASS" } }, []),
    ).toBe("ACTIVE");
  });

  // D-068/D12: the Active Pointer axis.
  it("returns ACTIVE when no Active Pointer has ever been recorded for this assetId (never fabricates INACTIVE)", () => {
    expect(computeAssetStatus({ assetId: "a1", version: "2.0.0" }, [], undefined)).toBe("ACTIVE");
    expect(computeAssetStatus({ assetId: "a1", version: "2.0.0" }, [], null)).toBe("ACTIVE");
  });

  it("returns ACTIVE when this version IS the recorded Active Pointer", () => {
    expect(computeAssetStatus({ assetId: "a1", version: "2.0.0" }, [], "2.0.0")).toBe("ACTIVE");
  });

  it("returns INACTIVE when a different version is the recorded Active Pointer", () => {
    expect(computeAssetStatus({ assetId: "a1", version: "1.0.0" }, [], "2.0.0")).toBe("INACTIVE");
  });

  it("REVOKED takes priority over the Active Pointer axis", () => {
    const entries: RevocationEntry[] = [{ asset_id: "a1", version: "1.0.0", status: "REVOKED" }];
    expect(computeAssetStatus({ assetId: "a1", version: "1.0.0" }, entries, "1.0.0")).toBe("REVOKED");
  });

  it("INVALID (failed checksum) takes priority over the Active Pointer axis", () => {
    expect(
      computeAssetStatus(
        { assetId: "a1", version: "1.0.0", checksumVerification: { result: "FAIL" } },
        [],
        "1.0.0",
      ),
    ).toBe("INVALID");
  });
});

describe("mergeRevocationEntries", () => {
  it("dedupes by asset_id+version, preferring the later (incoming) entry", () => {
    const existing: RevocationEntry[] = [{ asset_id: "a1", version: "1.0.0", status: "SUSPENDED" }];
    const incoming: RevocationEntry[] = [{ asset_id: "a1", version: "1.0.0", status: "REVOKED" }];
    const merged = mergeRevocationEntries(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("REVOKED");
  });

  it("keeps distinct asset_id+version pairs separate", () => {
    const existing: RevocationEntry[] = [{ asset_id: "a1", version: "1.0.0", status: "REVOKED" }];
    const incoming: RevocationEntry[] = [{ asset_id: "a2", version: "1.0.0", status: "REVOKED" }];
    expect(mergeRevocationEntries(existing, incoming)).toHaveLength(2);
  });

  it("skips entries with no asset_id", () => {
    const incoming: RevocationEntry[] = [{ asset_id: null, version: "1.0.0", status: "REVOKED" }];
    expect(mergeRevocationEntries([], incoming)).toHaveLength(0);
  });
});
