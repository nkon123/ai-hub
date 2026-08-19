// 실사용 제보(2026-08-19) — 스케줄 실행 이력 목록의 한 줄 요약 로직만 순수
// 함수로 테스트한다(`ScheduleHistoryDetailModal` 자체는 JSX 컴포넌트라 이
// 프로젝트의 vitest 환경(`environment: "node"`, DOM 없음)에서는 렌더링
// 테스트를 두지 않는다 — 이 모듈 CLAUDE.md의 기존 관례와 동일).
import { describe, expect, it } from "vitest";
import { describeToolRouteForList, summarizeForList } from "./scheduleHistoryDetail";

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

// 실사용 제보(2026-08-19) — "스케줄 수행 시 어떤 툴이 수행됐는지 모르겠어":
// 목록 한 줄에서 Tool 실행 여부/이름/미실행 사유를 구분해서 볼 수 있어야
// 한다 — 최소한 "자동선택 꺼짐" / "후보 없음" / "모델이 불필요 판단" /
// "검증 실패"가 서로 다른 문구로 보여야 한다.
describe("describeToolRouteForList", () => {
  it("names the tool when exactly one ran", () => {
    expect(describeToolRouteForList([{ toolName: "add_numbers", args: { a: 1, b: 2 } }], "ran")).toBe(
      "add_numbers 실행",
    );
  });

  it("counts and names multiple tools when more than one ran", () => {
    const result = describeToolRouteForList(
      [
        { toolName: "add_numbers", args: {} },
        { toolName: "lookup_sales", args: {} },
      ],
      "ran",
    );
    expect(result).toContain("2건");
    expect(result).toContain("add_numbers");
    expect(result).toContain("lookup_sales");
  });

  it("distinguishes route_inactive (recipe never enabled auto-routing) from other no-tool reasons", () => {
    expect(describeToolRouteForList([], "route_inactive")).toBe("Tool 미사용(자동선택 꺼짐)");
  });

  it("distinguishes no_candidates (routing enabled, nothing registered)", () => {
    expect(describeToolRouteForList([], "no_candidates")).toBe("Tool 미사용(등록된 Tool 없음)");
  });

  it("distinguishes declined_by_model (model judged no tool necessary)", () => {
    expect(describeToolRouteForList([], "declined_by_model")).toBe("Tool 미사용(모델이 불필요 판단)");
  });

  it("distinguishes schema_invalid (model picked a tool but its args failed validation)", () => {
    expect(describeToolRouteForList([], "schema_invalid")).toBe("Tool 미사용(입력값 검증 실패)");
  });

  it("does not guess a reason for legacy records missing toolRouteOutcome", () => {
    expect(describeToolRouteForList([], null)).toBe("Tool 실행 여부 확인 불가(이전 기록)");
  });
});
