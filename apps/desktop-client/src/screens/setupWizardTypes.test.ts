import { describe, expect, it } from "vitest";
import { computeDiskSpaceCheck, computeModelsCheck, computeOverallStatus } from "./setupWizardTypes";

describe("computeDiskSpaceCheck", () => {
  it("is SKIP before the check has run", () => {
    expect(computeDiskSpaceCheck(null, null).status).toBe("SKIP");
  });

  it("is FAIL when the disk space lookup itself errored", () => {
    expect(computeDiskSpaceCheck(null, "권한 오류").status).toBe("FAIL");
  });

  it("is PASS with plenty of free space", () => {
    const result = computeDiskSpaceCheck({ path: "/data", freeBytes: 50 * 1024 * 1024 * 1024 }, null);
    expect(result.status).toBe("PASS");
    expect(result.message).toContain("/data");
  });

  it("is WARN (not FAIL) when free space is low — never blocks setup outright", () => {
    const result = computeDiskSpaceCheck({ path: "/data", freeBytes: 100 * 1024 * 1024 }, null);
    expect(result.status).toBe("WARN");
  });
});

describe("computeModelsCheck", () => {
  it("is SKIP before the check has run", () => {
    expect(computeModelsCheck(null).status).toBe("SKIP");
  });

  it("is FAIL when Ollama is unreachable", () => {
    const result = computeModelsCheck({ ok: false, models: [], error: "연결 실패" });
    expect(result.status).toBe("FAIL");
  });

  it("is WARN when reachable but no models are installed — never fabricates a PASS", () => {
    const result = computeModelsCheck({ ok: true, models: [], error: null });
    expect(result.status).toBe("WARN");
  });

  it("is PASS and lists installed models when present", () => {
    const result = computeModelsCheck({ ok: true, models: ["exaone3.5:7.8b"], error: null });
    expect(result.status).toBe("PASS");
    expect(result.message).toContain("exaone3.5:7.8b");
  });
});

describe("computeOverallStatus", () => {
  it("is FAIL if any item is FAIL, regardless of the others", () => {
    expect(computeOverallStatus(["PASS", "WARN", "FAIL"])).toBe("FAIL");
  });

  it("is WARN if nothing failed but something is WARN or still SKIP", () => {
    expect(computeOverallStatus(["PASS", "WARN"])).toBe("WARN");
    expect(computeOverallStatus(["PASS", "SKIP"])).toBe("WARN");
  });

  it("is PASS only when everything passed", () => {
    expect(computeOverallStatus(["PASS", "PASS"])).toBe("PASS");
  });

  it("is SKIP for an empty list", () => {
    expect(computeOverallStatus([])).toBe("SKIP");
  });
});
