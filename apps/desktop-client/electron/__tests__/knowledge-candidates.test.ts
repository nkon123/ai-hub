import { describe, expect, it } from "vitest";
import { buildKnowledgeCandidate, buildKnowledgeCandidates } from "../knowledge-candidates";
import type { AssetManifestResult } from "../types";

const AVAILABLE: (manifest: unknown) => AssetManifestResult = (manifest) => ({
  available: true,
  reason: null,
  manifest,
});
const MISSING: AssetManifestResult = {
  available: false,
  reason: "설치된 자산 폴더에 manifest.json이 없습니다 — 표준 구성 자산(D-034 STANDARD_LOCAL_COPY)이거나 이전 형식의 Bundle로 설치되었을 수 있습니다.",
  manifest: null,
};
const UNREADABLE: AssetManifestResult = {
  available: false,
  reason: "Manifest 파일 형식을 읽을 수 없습니다(손상되었을 수 있음).",
  manifest: null,
};

describe("buildKnowledgeCandidate", () => {
  it("returns null when the asset has no assetVersionId (D-060 legacy Bundle — never invents a knowledge_id)", () => {
    const result = buildKnowledgeCandidate(
      { assetVersionId: null, name: "이전 형식 Knowledge" },
      AVAILABLE({ description: "설명" }),
    );
    expect(result).toBeNull();
  });

  it("fills description/tags/classification from a present, well-formed manifest", () => {
    const result = buildKnowledgeCandidate(
      { assetVersionId: "av-1", name: "HR 정책 Knowledge" },
      AVAILABLE({ description: "휴가/재택근무 정책 문서 모음", tags: ["hr", "policy"], classification: "INTERNAL" }),
    );
    expect(result).toEqual({
      knowledge_id: "av-1",
      name: "HR 정책 Knowledge",
      description: "휴가/재택근무 정책 문서 모음",
      tags: ["hr", "policy"],
      classification: "INTERNAL",
    });
  });

  it("degrades to name-only when the manifest is missing (STANDARD_LOCAL_COPY/legacy Bundle) — never invents a description, never drops the Knowledge", () => {
    const result = buildKnowledgeCandidate({ assetVersionId: "av-2", name: "표준 구성 Knowledge" }, MISSING);
    expect(result).toEqual({ knowledge_id: "av-2", name: "표준 구성 Knowledge" });
  });

  it("degrades to name-only when the manifest file exists but is unreadable/corrupted", () => {
    const result = buildKnowledgeCandidate({ assetVersionId: "av-3", name: "손상된 Knowledge" }, UNREADABLE);
    expect(result).toEqual({ knowledge_id: "av-3", name: "손상된 Knowledge" });
  });

  it("degrades to name-only when the manifest JSON is not an object (defensive)", () => {
    const result = buildKnowledgeCandidate({ assetVersionId: "av-4", name: "이상한 Knowledge" }, AVAILABLE("not-an-object"));
    expect(result).toEqual({ knowledge_id: "av-4", name: "이상한 Knowledge" });
  });

  it("omits only the malformed field, keeping the well-formed ones (tags not an array)", () => {
    const result = buildKnowledgeCandidate(
      { assetVersionId: "av-5", name: "부분 손상 Knowledge" },
      AVAILABLE({ description: "설명", tags: "not-an-array", classification: "PUBLIC_INTERNAL" }),
    );
    expect(result).toEqual({
      knowledge_id: "av-5",
      name: "부분 손상 Knowledge",
      description: "설명",
      classification: "PUBLIC_INTERNAL",
    });
  });

  it("omits an empty/whitespace-only description rather than sending a blank string", () => {
    const result = buildKnowledgeCandidate({ assetVersionId: "av-6", name: "빈 설명 Knowledge" }, AVAILABLE({ description: "   " }));
    expect(result).toEqual({ knowledge_id: "av-6", name: "빈 설명 Knowledge" });
  });

  it("filters out non-string/blank tag entries but keeps the valid ones", () => {
    const result = buildKnowledgeCandidate(
      { assetVersionId: "av-7", name: "태그 혼합 Knowledge" },
      AVAILABLE({ tags: ["hr", "", 42, "  ", "policy"] }),
    );
    expect(result).toEqual({ knowledge_id: "av-7", name: "태그 혼합 Knowledge", tags: ["hr", "policy"] });
  });
});

describe("buildKnowledgeCandidates", () => {
  it("builds one candidate per asset, in order, when every asset has a usable id", () => {
    const assets = [
      { assetVersionId: "av-1", name: "A" },
      { assetVersionId: "av-2", name: "B" },
    ];
    const manifests = [AVAILABLE({ description: "설명 A" }), MISSING];
    expect(buildKnowledgeCandidates(assets, manifests)).toEqual([
      { knowledge_id: "av-1", name: "A", description: "설명 A" },
      { knowledge_id: "av-2", name: "B" },
    ]);
  });

  it("silently drops an asset with no assetVersionId rather than crashing or inventing an id", () => {
    const assets = [
      { assetVersionId: "av-1", name: "A" },
      { assetVersionId: null, name: "레거시 B" },
    ];
    const manifests = [AVAILABLE({ description: "설명 A" }), MISSING];
    expect(buildKnowledgeCandidates(assets, manifests)).toEqual([{ knowledge_id: "av-1", name: "A", description: "설명 A" }]);
  });

  it("returns an empty array for an empty input (no usable Knowledge at all)", () => {
    expect(buildKnowledgeCandidates([], [])).toEqual([]);
  });
});
