import { describe, expect, it } from "vitest";
import { computeManifestDiff, manifestFileNameHint } from "../version-diff";

describe("computeManifestDiff", () => {
  it("reports no changes for identical manifests", () => {
    const manifest = { name: "HR 챗봇", version: "1.0.0", classification: "INTERNAL" };
    const result = computeManifestDiff(manifest, manifest);
    expect(result.hasChanges).toBe(false);
    expect(result.entries).toEqual([]);
  });

  it("classifies a general field change into the 'manifest' axis", () => {
    const result = computeManifestDiff({ name: "구버전 이름" }, { name: "새 이름" });
    expect(result.hasChanges).toBe(true);
    expect(result.entries).toEqual([
      { axis: "manifest", field: "name", changeType: "changed", oldValue: "구버전 이름", newValue: "새 이름" },
    ]);
  });

  it("classifies knowledge_bindings/agent_ref/mcp_bindings/prompt_bindings changes into the 'dependency' axis", () => {
    const oldManifest = { agent_ref: { id: "a1", version: "1.0.0" } };
    const newManifest = { agent_ref: { id: "a1", version: "2.0.0" } };
    const result = computeManifestDiff(oldManifest, newManifest);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].axis).toBe("dependency");
    expect(result.entries[0].field).toBe("agent_ref");
  });

  it("classifies risk_level/capabilities/target_users/limits changes into the 'permission' axis", () => {
    const result = computeManifestDiff({ risk_level: "READ_ONLY" }, { risk_level: "READ_WRITE" });
    expect(result.entries[0].axis).toBe("permission");
  });

  it("reports an added field (present only in the new manifest)", () => {
    const result = computeManifestDiff({}, { tags: ["hr"] });
    expect(result.entries).toEqual([{ axis: "manifest", field: "tags", changeType: "added", oldValue: null, newValue: '["hr"]' }]);
  });

  it("reports a removed field (present only in the old manifest)", () => {
    const result = computeManifestDiff({ description: "설명" }, {});
    expect(result.entries).toEqual([
      { axis: "manifest", field: "description", changeType: "removed", oldValue: "설명", newValue: null },
    ]);
  });

  it("ignores build-time noise fields (created_at, manifest_hash) that always differ without a meaningful change", () => {
    const result = computeManifestDiff(
      { created_at: "2026-01-01T00:00:00Z", manifest_hash: "aaa", name: "동일" },
      { created_at: "2026-08-09T00:00:00Z", manifest_hash: "bbb", name: "동일" },
    );
    expect(result.hasChanges).toBe(false);
  });

  it("treats a missing manifest on either side as an empty object rather than throwing", () => {
    expect(() => computeManifestDiff(null, { name: "새 버전" })).not.toThrow();
    const result = computeManifestDiff(null, { name: "새 버전" });
    expect(result.entries).toEqual([{ axis: "manifest", field: "name", changeType: "added", oldValue: null, newValue: "새 버전" }]);
  });

  it("orders dependency and permission axis entries before general manifest entries", () => {
    const result = computeManifestDiff(
      { name: "old", agent_ref: { id: "a", version: "1.0.0" }, risk_level: "READ_ONLY" },
      { name: "new", agent_ref: { id: "a", version: "2.0.0" }, risk_level: "READ_WRITE" },
    );
    expect(result.entries.map((e) => e.axis)).toEqual(["dependency", "permission", "manifest"]);
  });

  it("truncates very long values instead of dumping the full content", () => {
    const longValue = "x".repeat(1000);
    const result = computeManifestDiff({ description: "짧음" }, { description: longValue });
    expect(result.entries[0].newValue!.length).toBeLessThan(longValue.length);
    expect(result.entries[0].newValue!.endsWith("…")).toBe(true);
  });
});

describe("manifestFileNameHint", () => {
  it("names service-definition.json for services", () => {
    expect(manifestFileNameHint("service")).toBe("service-definition.json");
  });

  it("names manifest.json for every other asset type", () => {
    expect(manifestFileNameHint("knowledge")).toBe("manifest.json");
    expect(manifestFileNameHint("agent")).toBe("manifest.json");
  });
});
