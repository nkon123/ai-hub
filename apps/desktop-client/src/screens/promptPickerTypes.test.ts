import { describe, expect, it } from "vitest";
import {
  composePromptForComposer,
  describeRemainingPlaceholders,
  findPlaceholders,
  promptUseKey,
  readRecentPromptUses,
  recordPromptUse,
  sortPromptsByRecentUse,
  type PromptAssetEntry,
  type RecentPromptStorage,
} from "./promptPickerTypes";

function entry(name: string, assetId: string, version = "1.0.0"): PromptAssetEntry {
  return { assetId, version, name, installedAt: "2026-09-01T00:00:00Z" };
}

/** 던지지 않는 평범한 저장소. */
function fakeStorage(initial: string | null = null): RecentPromptStorage & { value: string | null } {
  return {
    value: initial,
    getItem() {
      return this.value;
    },
    setItem(_key: string, next: string) {
      this.value = next;
    },
  };
}

describe("promptUseKey", () => {
  it("버전이 다르면 다른 키다 — v1 사용 기록이 v2를 최근으로 올리면 안 된다", () => {
    expect(promptUseKey({ assetId: "a", version: "1.0.0" })).not.toBe(
      promptUseKey({ assetId: "a", version: "2.0.0" }),
    );
  });
});

describe("sortPromptsByRecentUse", () => {
  it("최근에 쓴 것을 쓴 순서대로 위에, 나머지는 이름순", () => {
    const prompts = [entry("다 프롬프트", "d"), entry("가 프롬프트", "a"), entry("나 프롬프트", "b")];
    const sorted = sortPromptsByRecentUse(prompts, [
      { key: "b@1.0.0", usedAt: "2026-09-10T10:00:00Z" },
      { key: "d@1.0.0", usedAt: "2026-09-09T10:00:00Z" },
    ]);
    expect(sorted.map((p) => p.assetId)).toEqual(["b", "d", "a"]);
    expect(sorted[0].lastUsedAt).toBe("2026-09-10T10:00:00Z");
    expect(sorted[2].lastUsedAt).toBeNull();
  });

  it("설치 목록에 없는 최근 기록은 항목을 만들어내지 않는다", () => {
    const sorted = sortPromptsByRecentUse(
      [entry("남은 것", "a")],
      [{ key: "지워진-자산@1.0.0", usedAt: "2026-09-10T10:00:00Z" }],
    );
    expect(sorted).toHaveLength(1);
    expect(sorted[0].assetId).toBe("a");
  });
});

describe("findPlaceholders", () => {
  it("중복 없이 등장 순서대로 모은다", () => {
    expect(findPlaceholders("{{question}} / {{ context_chunks }} / {{question}}")).toEqual([
      "question",
      "context_chunks",
    ]);
  });

  it("자리가 없으면 빈 배열", () => {
    expect(findPlaceholders("그냥 문장입니다.")).toEqual([]);
  });
});

describe("composePromptForComposer", () => {
  it("입력창에 쓰던 글을 {{question}} 자리에 넣는다 — 질문을 두 번 쓰게 하지 않는다", () => {
    const composed = composePromptForComposer("연차 이월 규정 알려줘", "## 질문\n{{question}}\n\n3줄로 요약");
    expect(composed.text).toBe("## 질문\n연차 이월 규정 알려줘\n\n3줄로 요약");
    expect(composed.questionFilled).toBe(true);
    expect(composed.remainingPlaceholders).toEqual([]);
  });

  it("입력창이 비어 있으면 {{question}} 자리를 지우지 않고 남긴다", () => {
    const composed = composePromptForComposer("   ", "## 질문\n{{question}}");
    expect(composed.text).toContain("{{question}}");
    expect(composed.questionFilled).toBe(false);
    expect(composed.remainingPlaceholders).toEqual(["question"]);
  });

  it("{{question}} 자리가 없으면 쓰던 글을 버리지 않고 뒤에 붙인다", () => {
    const composed = composePromptForComposer("연차 이월 규정 알려줘", "아래 질문에 3줄로 답해 주세요.");
    expect(composed.text).toBe("아래 질문에 3줄로 답해 주세요.\n\n연차 이월 규정 알려줘");
    expect(composed.questionFilled).toBe(false);
  });

  it("엔진이 채우던 자리({{context_chunks}})는 말없이 지우지 않고 남은 자리로 보고한다", () => {
    const composed = composePromptForComposer("질문", "## 참고\n{{context_chunks}}\n## 질문\n{{question}}");
    expect(composed.text).toContain("{{context_chunks}}");
    expect(composed.remainingPlaceholders).toEqual(["context_chunks"]);
  });
});

describe("describeRemainingPlaceholders", () => {
  it("남은 자리가 없으면 null", () => {
    expect(describeRemainingPlaceholders([])).toBeNull();
  });

  it("남은 자리를 그대로 이름으로 알려주고 자동으로 채워지지 않는다고 말한다", () => {
    const notice = describeRemainingPlaceholders(["context_chunks"]);
    expect(notice).toContain("{{context_chunks}}");
    expect(notice).toContain("자동으로 채워지지 않습니다");
  });
});

describe("최근 사용 기록", () => {
  it("맨 앞에 넣고 같은 키는 하나만 남긴다", () => {
    const storage = fakeStorage();
    recordPromptUse(storage, "a@1.0.0", "2026-09-01T00:00:00Z");
    recordPromptUse(storage, "b@1.0.0", "2026-09-02T00:00:00Z");
    const after = recordPromptUse(storage, "a@1.0.0", "2026-09-03T00:00:00Z");
    expect(after.map((u) => u.key)).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(after[0].usedAt).toBe("2026-09-03T00:00:00Z");
  });

  it("10건까지만 둔다", () => {
    const storage = fakeStorage();
    for (let i = 0; i < 15; i += 1) {
      recordPromptUse(storage, `p${i}@1.0.0`, `2026-09-01T00:00:${String(i).padStart(2, "0")}Z`);
    }
    expect(readRecentPromptUses(storage)).toHaveLength(10);
  });

  it("저장된 값이 손상돼도 빈 목록으로 degrade한다", () => {
    expect(readRecentPromptUses(fakeStorage("{쓰레기"))).toEqual([]);
    expect(readRecentPromptUses(fakeStorage('{"key":"a"}'))).toEqual([]);
    expect(readRecentPromptUses(fakeStorage('[{"key":1,"usedAt":2}]'))).toEqual([]);
  });

  it("저장소가 없거나 던져도 기능을 막지 않는다 — 프롬프트는 이미 입력창에 들어갔다", () => {
    expect(readRecentPromptUses(null)).toEqual([]);
    const throwing: RecentPromptStorage = {
      getItem() {
        throw new Error("접근 거부");
      },
      setItem() {
        throw new Error("저장소 가득 참");
      },
    };
    expect(readRecentPromptUses(throwing)).toEqual([]);
    expect(() => recordPromptUse(throwing, "a@1.0.0", "2026-09-01T00:00:00Z")).not.toThrow();
    expect(() => recordPromptUse(null, "a@1.0.0", "2026-09-01T00:00:00Z")).not.toThrow();
  });
});
