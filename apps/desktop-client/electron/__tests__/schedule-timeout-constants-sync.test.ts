// 실사용 제보(2026-08-19) — `electron/schedule-store.ts`의 타임아웃
// 상/하한/기본값 상수는 렌더러(`src/screens/ScheduleScreen.tsx`)가 fs/
// crypto/path를 import하는 Main 전용 모듈을 직접 import할 수 없어서
// (이 모듈 CLAUDE.md 코드 배치 규칙) 값을 복제해 둔 것이다. 두 값이 갈라지면
// 화면의 min/max 힌트가 실제 저장 게이트와 어긋난다 — 소스 텍스트를 그대로
// 읽어 세 상수가 항상 같은 값을 갖는지 구조적으로 고정한다
// (`local-tool-isolation.test.ts`와 같은 "코드 텍스트를 읽어 검사" 방식).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..", "..");

function extractConst(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  if (!match) throw new Error(`상수 ${name}을 찾지 못했습니다.`);
  return match[1];
}

describe("schedule timeout constants stay in sync between Main store and renderer screen", () => {
  const storeSource = fs.readFileSync(path.join(ROOT, "electron/schedule-store.ts"), "utf-8");
  const screenSource = fs.readFileSync(path.join(ROOT, "src/screens/ScheduleScreen.tsx"), "utf-8");

  for (const name of [
    "DEFAULT_SCHEDULE_TIMEOUT_MINUTES",
    "MIN_SCHEDULE_TIMEOUT_MINUTES",
    "MAX_SCHEDULE_TIMEOUT_MINUTES",
  ]) {
    it(`${name} matches between schedule-store.ts and ScheduleScreen.tsx`, () => {
      expect(extractConst(screenSource, name)).toBe(extractConst(storeSource, name));
    });
  }
});
