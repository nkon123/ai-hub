// 실사용 제보(2026-08-19) — 스케줄 실행 이력 목록의 한 줄 요약 로직만 순수
// 함수로 테스트한다(`ScheduleHistoryDetailModal` 자체는 JSX 컴포넌트라 이
// 프로젝트의 vitest 환경(`environment: "node"`, DOM 없음)에서는 렌더링
// 테스트를 두지 않는다 — 이 모듈 CLAUDE.md의 기존 관례와 동일).
import { describe, expect, it } from "vitest";
import { summarizeForList } from "./scheduleHistoryDetail";

describe("summarizeForList", () => {
  it("returns short text unchanged", () => {
    expect(summarizeForList("완료했습니다.")).toBe("완료했습니다.");
  });

  it("uses only the first non-empty line of a multi-paragraph result", () => {
    const text = "\n\n이메일 요약입니다.\n\n1. 첫 번째 항목\n2. 두 번째 항목";
    expect(summarizeForList(text)).toBe("이메일 요약입니다.");
  });

  it("truncates an overly long single line with an ellipsis", () => {
    const text = "x".repeat(500);
    const result = summarizeForList(text, 140);
    expect(result.length).toBe(141);
    expect(result.endsWith("…")).toBe(true);
  });

  it("does not throw on an empty string", () => {
    expect(summarizeForList("")).toBe("");
  });
});
