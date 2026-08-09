import { describe, expect, it } from "vitest";
import { evaluateAssetRemoval, type ActiveRunAssetUsage } from "../removal-guard";
import type { ReferencingService } from "../service-dependencies";

const TARGET = { assetType: "knowledge", assetId: "know-1", version: "1.0.0" };

const REFERENCING_SERVICE: ReferencingService = {
  assetId: "svc-1",
  name: "HR 정책 챗봇",
  version: "1.0.0",
  via: "knowledge_bindings",
};

const RUN_USING_TARGET: ActiveRunAssetUsage = {
  runId: "run-1",
  status: "RUNNING",
  assetType: "knowledge",
  assetId: "know-1",
  version: "1.0.0",
};

describe("evaluateAssetRemoval", () => {
  it("blocks removal when a Service references the asset (referenced-by-service)", () => {
    const result = evaluateAssetRemoval({
      target: TARGET,
      referencingServices: [REFERENCING_SERVICE],
      activeRunUsages: [], // Run check ran and found nothing — service alone must still block.
    });
    expect(result.blocked).toBe(true);
    expect(result.referencingServices).toEqual([REFERENCING_SERVICE]);
    expect(result.blockingRuns).toEqual([]);
    expect(result.runCheckAvailable).toBe(true);
  });

  it("blocks removal when a Run is actively using the asset (run-in-progress)", () => {
    const result = evaluateAssetRemoval({
      target: TARGET,
      referencingServices: [],
      activeRunUsages: [RUN_USING_TARGET],
    });
    expect(result.blocked).toBe(true);
    expect(result.referencingServices).toEqual([]);
    expect(result.blockingRuns).toEqual([RUN_USING_TARGET]);
    expect(result.runCheckAvailable).toBe(true);
    expect(result.runCheckNote).toContain("사용 중인 Run");
  });

  it("allows removal when nothing references the asset and no Run is using it (the allowed case)", () => {
    const result = evaluateAssetRemoval({
      target: TARGET,
      referencingServices: [],
      activeRunUsages: [],
    });
    expect(result.blocked).toBe(false);
    expect(result.runCheckAvailable).toBe(true);
  });

  it("does not block on a Run using a different asset", () => {
    const result = evaluateAssetRemoval({
      target: TARGET,
      referencingServices: [],
      activeRunUsages: [{ ...RUN_USING_TARGET, assetId: "know-2" }],
    });
    expect(result.blocked).toBe(false);
    expect(result.blockingRuns).toEqual([]);
  });

  it("does not block on a Run using the same asset id but a different version", () => {
    const result = evaluateAssetRemoval({
      target: TARGET,
      referencingServices: [],
      activeRunUsages: [{ ...RUN_USING_TARGET, version: "2.0.0" }],
    });
    expect(result.blocked).toBe(false);
  });

  it("treats a null version on the usage as version-agnostic (matches any installed version)", () => {
    const result = evaluateAssetRemoval({
      target: TARGET,
      referencingServices: [],
      activeRunUsages: [{ ...RUN_USING_TARGET, version: null }],
    });
    expect(result.blocked).toBe(true);
  });

  it("honestly reports the Run check as unavailable — never silently treats null as 'confirmed empty'", () => {
    const result = evaluateAssetRemoval({
      target: TARGET,
      referencingServices: [],
      activeRunUsages: null,
    });
    expect(result.runCheckAvailable).toBe(false);
    expect(result.blockingRuns).toEqual([]);
    // Unavailable Run data must not itself block removal — only a confirmed
    // reference or a confirmed active usage should.
    expect(result.blocked).toBe(false);
    expect(result.runCheckNote.length).toBeGreaterThan(0);
  });

  it("blocks on referencing Service even while the Run check is unavailable", () => {
    const result = evaluateAssetRemoval({
      target: TARGET,
      referencingServices: [REFERENCING_SERVICE],
      activeRunUsages: null,
    });
    expect(result.blocked).toBe(true);
    expect(result.runCheckAvailable).toBe(false);
  });
});

// D12/D-068: the Active Pointer axis — "you may not remove the active
// version while it is active without switching first."
describe("evaluateAssetRemoval — Active Pointer axis (D12/D-068)", () => {
  it("blocks removing the Active Version when another installed version could be switched to first", () => {
    const result = evaluateAssetRemoval({
      target: TARGET,
      referencingServices: [],
      activeRunUsages: [],
      activePointer: { isActiveVersion: true, otherVersionsInstalled: true },
    });
    expect(result.blocked).toBe(true);
    expect(result.blockedByActiveVersion).toBe(true);
    expect(result.activeVersionNote).toContain("Active Version");
  });

  it("allows removing the Active Version when it is the only installed version (removes the whole asset)", () => {
    const result = evaluateAssetRemoval({
      target: TARGET,
      referencingServices: [],
      activeRunUsages: [],
      activePointer: { isActiveVersion: true, otherVersionsInstalled: false },
    });
    expect(result.blocked).toBe(false);
    expect(result.blockedByActiveVersion).toBe(false);
    expect(result.activeVersionNote).toBeTruthy(); // still explains the situation, just doesn't block
  });

  it("allows removing a non-active (Inactive) version even when other versions exist", () => {
    const result = evaluateAssetRemoval({
      target: TARGET,
      referencingServices: [],
      activeRunUsages: [],
      activePointer: { isActiveVersion: false, otherVersionsInstalled: true },
    });
    expect(result.blocked).toBe(false);
    expect(result.blockedByActiveVersion).toBe(false);
    expect(result.activeVersionNote).toBeNull();
  });

  it("is backward compatible with callers that omit activePointer entirely (never blocks on this axis)", () => {
    const result = evaluateAssetRemoval({
      target: TARGET,
      referencingServices: [],
      activeRunUsages: [],
    });
    expect(result.blocked).toBe(false);
    expect(result.blockedByActiveVersion).toBe(false);
    expect(result.activeVersionNote).toBeNull();
  });

  it("combines with the referencing-Service block (either axis alone is sufficient to block)", () => {
    const result = evaluateAssetRemoval({
      target: TARGET,
      referencingServices: [REFERENCING_SERVICE],
      activeRunUsages: [],
      activePointer: { isActiveVersion: false, otherVersionsInstalled: true },
    });
    expect(result.blocked).toBe(true);
    expect(result.blockedByActiveVersion).toBe(false); // this axis alone didn't block it
  });
});
