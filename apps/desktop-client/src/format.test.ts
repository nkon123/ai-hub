// 실사용 제보(2026-08-19) — `formatDurationMs`는 로컬 Tool 타임아웃 메시지에
// 원시 밀리초 대신 사람이 읽는 분/초 단위를 보여주기 위해 추가됐다
// (`schedule-local-tool-runner.ts`의 `describeTimeoutMs`와 같은 규칙, 다만
// 이 파일은 렌더러에서 쓸 수 있는 pure 사본이다).
import { describe, expect, it } from "vitest";
import { formatDurationMs } from "./format";

describe("formatDurationMs", () => {
  it("formats an exact multiple of a minute as N분", () => {
    expect(formatDurationMs(5 * 60_000)).toBe("5분");
    expect(formatDurationMs(60_000)).toBe("1분");
    expect(formatDurationMs(30 * 60_000)).toBe("30분");
  });

  it("formats anything that isn't an exact minute as N초", () => {
    expect(formatDurationMs(30_000)).toBe("30초");
    expect(formatDurationMs(300)).toBe("0초"); // rounds to nearest second
    expect(formatDurationMs(90_000)).toBe("90초"); // 1.5분 — not an exact minute, stays in seconds
  });
});
