import { describe, expect, it } from "vitest";
import { describeCitationChip } from "./chatTypes";
import type { Citation } from "../agentRuntime";

/**
 * 출처 칩이 "무엇이 검색됐는지"를 말하는지 고정한다.
 *
 * **왜 생겼나(2026-09-18 실사용)**: 칩이 **파일명만** 보여줘서, 같은 문서에서
 * 여러 조각이 걸리면 칩이 전부 같은 글자로 나왔다 — 근거가 몇 개 붙었는지는
 * 알아도 무엇을 근거로 답했는지는 알 수 없었다. 그래서 주제(섹션)를 앞세우고
 * 발췌 한 조각을 덧붙인다.
 */

function citation(overrides: Partial<Citation> = {}): Citation {
  return {
    chunk_id: "c1",
    parent_chunk_id: null,
    document_path: "docs/hr/인사규정.md",
    document_title: "인사규정.md",
    page: 0,
    section: "",
    excerpt: "",
    parent_context: "",
    score: 0.8,
    similarity: 0.7,
    ...overrides,
  };
}

describe("describeCitationChip", () => {
  it("섹션이 있으면 그것을 앞세우고 문서명을 뒤에 둔다 — 같은 문서의 조각들이 구분된다", () => {
    const first = describeCitationChip(citation({ section: "3.2 연차 이월" }));
    const second = describeCitationChip(citation({ section: "5.1 병가" }));
    expect(first.primary).toBe("3.2 연차 이월");
    expect(second.primary).toBe("5.1 병가");
    expect(first.primary).not.toBe(second.primary);
    expect(first.document).toBe("인사규정.md");
  });

  it("섹션이 없으면 문서명이 앞에 오고, 문서명을 두 번 쓰지 않는다", () => {
    const label = describeCitationChip(citation());
    expect(label.primary).toBe("인사규정.md");
    expect(label.document).toBeNull();
  });

  it("제목이 없으면 경로에서 파일명만 쓴다 — 칩 한 줄에 전체 경로가 들어가면 주제가 밀린다", () => {
    const posix = describeCitationChip(citation({ document_title: "", document_path: "a/b/정책.md" }));
    const windows = describeCitationChip(
      citation({ document_title: "", document_path: "C:\\docs\\정책.md" }),
    );
    expect(posix.primary).toBe("정책.md");
    expect(windows.primary).toBe("정책.md");
  });

  it("아무 이름도 없으면 지어내지 않는다", () => {
    const label = describeCitationChip(citation({ document_title: "", document_path: "" }));
    expect(label.primary).toBe("제목 없음");
  });

  it("발췌는 줄바꿈·연속 공백을 접어 한 줄 미리보기로 만든다", () => {
    const label = describeCitationChip(
      citation({ excerpt: "  연차는\n\n  익년 3월까지\t이월할 수 있다.  " }),
    );
    expect(label.preview).toBe("연차는 익년 3월까지 이월할 수 있다.");
  });

  it("긴 발췌는 잘라내되 잘렸다는 표시를 남긴다", () => {
    const long = "가".repeat(200);
    const label = describeCitationChip(citation({ excerpt: long }));
    expect(label.preview).not.toBeNull();
    expect(label.preview!.length).toBeLessThan(long.length);
    expect(label.preview!.endsWith("…")).toBe(true);
  });

  it("발췌가 없으면 미리보기를 만들지 않는다(빈 줄을 그리지 않게)", () => {
    expect(describeCitationChip(citation({ excerpt: "   " })).preview).toBeNull();
  });

  it("페이지는 있을 때만 표시한다 — 0을 p.0으로 쓰지 않는다", () => {
    expect(describeCitationChip(citation({ page: 12 })).page).toBe("p.12");
    expect(describeCitationChip(citation({ page: 0 })).page).toBeNull();
  });

  it("툴팁에는 잘리지 않은 문서명·섹션·페이지·발췌가 모두 들어간다", () => {
    const label = describeCitationChip(
      citation({ section: "3.2 연차 이월", page: 4, excerpt: "가".repeat(200) }),
    );
    expect(label.tooltip).toContain("인사규정.md");
    expect(label.tooltip).toContain("3.2 연차 이월");
    expect(label.tooltip).toContain("p.4");
    expect(label.tooltip).toContain("가".repeat(200));
  });

  it("섹션과 문서명이 같으면 같은 글자를 두 번 보여주지 않는다", () => {
    const label = describeCitationChip(citation({ section: "인사규정.md" }));
    expect(label.primary).toBe("인사규정.md");
    expect(label.document).toBeNull();
  });
});
