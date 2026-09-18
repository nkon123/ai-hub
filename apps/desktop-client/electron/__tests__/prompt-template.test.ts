import path from "path";
import { describe, expect, it } from "vitest";
import { summarizePromptManifest, templatePathWithinAsset } from "../prompt-template";

const VALID_MANIFEST = {
  schema_version: "1.0",
  id: "550e8400-e29b-41d4-a716-446655440020",
  type: "prompt",
  name: "표준 답변 프롬프트",
  version: "1.0.0",
  description: "Knowledge 검색 결과로 답변을 만드는 프롬프트",
  tags: ["standard", "korean"],
  template: { system: "당신은 사내 지식 기반 어시스턴트입니다.", file: "template.md", language: "ko" },
  variables: [
    { name: "question", type: "string", required: true, description: "사용자 질문" },
    { name: "context_chunks", type: "array", required: true },
  ],
};

describe("summarizePromptManifest", () => {
  it("본문 파일 이름·역할 지침·변수를 그대로 읽는다", () => {
    const summary = summarizePromptManifest(VALID_MANIFEST);
    expect(summary).not.toBeNull();
    expect(summary?.templateFile).toBe("template.md");
    expect(summary?.system).toContain("사내 지식");
    expect(summary?.variables.map((v) => v.name)).toEqual(["question", "context_chunks"]);
    expect(summary?.variables[1].required).toBe(true);
    expect(summary?.variables[1].description).toBeNull();
    expect(summary?.tags).toEqual(["standard", "korean"]);
  });

  it("프롬프트가 아닌 Manifest는 null — 고를 수 없는 것을 목록에 올리지 않는다", () => {
    expect(summarizePromptManifest({ ...VALID_MANIFEST, type: "knowledge" })).toBeNull();
    expect(summarizePromptManifest({ name: "type 없음" })).toBeNull();
  });

  it("객체가 아닌 값에도 던지지 않는다 — 설치된 파일은 이 앱이 만든 것이 아니다", () => {
    for (const value of [null, undefined, 42, "문자열", [1, 2, 3]]) {
      expect(summarizePromptManifest(value)).toBeNull();
    }
  });

  it("template/variables가 없거나 형이 달라도 빈 값으로 degrade한다", () => {
    const summary = summarizePromptManifest({ type: "prompt", name: "x", variables: "배열이 아님" });
    expect(summary?.system).toBeNull();
    expect(summary?.templateFile).toBeNull();
    expect(summary?.variables).toEqual([]);
  });

  it("이름 없는 변수 항목은 버린다", () => {
    const summary = summarizePromptManifest({
      type: "prompt",
      variables: [{ type: "string" }, { name: "ok", type: "string" }],
    });
    expect(summary?.variables.map((v) => v.name)).toEqual(["ok"]);
  });
});

describe("templatePathWithinAsset", () => {
  const assetDir = path.join("C:", "install", "assets", "prompts", "a1", "1.0.0");

  it("자산 폴더 안쪽 경로만 돌려준다", () => {
    expect(templatePathWithinAsset(assetDir, "template.md")).toBe(path.join(assetDir, "template.md"));
    expect(templatePathWithinAsset(assetDir, "nested/template.md")).toBe(
      path.join(assetDir, "nested", "template.md"),
    );
  });

  it("폴더를 벗어나는 경로는 거부한다 — Manifest 문자열로 임의 파일을 읽지 않는다", () => {
    expect(templatePathWithinAsset(assetDir, "../../../secrets.md")).toBeNull();
    expect(templatePathWithinAsset(assetDir, "..")).toBeNull();
    expect(templatePathWithinAsset(assetDir, path.join("nested", "..", "..", "escape.md"))).toBeNull();
  });

  it("절대 경로와 빈 값도 거부한다", () => {
    expect(templatePathWithinAsset(assetDir, path.join("C:", "Windows", "system.ini"))).toBeNull();
    expect(templatePathWithinAsset(assetDir, "/etc/passwd")).toBeNull();
    expect(templatePathWithinAsset(assetDir, null)).toBeNull();
    expect(templatePathWithinAsset(assetDir, "")).toBeNull();
  });
});
