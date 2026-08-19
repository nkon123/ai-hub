// 실사용 제보(2026-08-19) — `electron/desktop-settings.ts`의 대화형 로컬
// Tool 실행 타임아웃 상/하한/기본값 상수는 렌더러(`src/screens/SettingsScreen.tsx`,
// `src/browserPreviewBridge.ts`)가 fs를 import하는 Main 전용 모듈을 직접
// import할 수 없어서(이 모듈 CLAUDE.md 코드 배치 규칙) 값을 복제해 둔
// 것이다. 세 곳이 갈라지면 화면의 min/max 힌트나 브라우저 개발 모드의 기본값이
// 실제 저장 게이트와 어긋난다 — `schedule-timeout-constants-sync.test.ts`와
// 동일한 "소스 텍스트를 읽어 검사" 방식으로 구조적으로 고정한다.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..", "..");

function extractConst(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  if (!match) throw new Error(`상수 ${name}을 찾지 못했습니다.`);
  return match[1];
}

describe("local tool timeout constants stay in sync across Main store and renderer copies", () => {
  const storeSource = fs.readFileSync(path.join(ROOT, "electron/desktop-settings.ts"), "utf-8");
  const settingsScreenSource = fs.readFileSync(path.join(ROOT, "src/screens/SettingsScreen.tsx"), "utf-8");
  const browserBridgeSource = fs.readFileSync(path.join(ROOT, "src/browserPreviewBridge.ts"), "utf-8");

  for (const name of [
    "DEFAULT_LOCAL_TOOL_TIMEOUT_MINUTES",
    "MIN_LOCAL_TOOL_TIMEOUT_MINUTES",
    "MAX_LOCAL_TOOL_TIMEOUT_MINUTES",
  ]) {
    it(`${name} matches between desktop-settings.ts and SettingsScreen.tsx`, () => {
      expect(extractConst(settingsScreenSource, name)).toBe(extractConst(storeSource, name));
    });
    it(`${name} matches between desktop-settings.ts and browserPreviewBridge.ts`, () => {
      expect(extractConst(browserBridgeSource, name)).toBe(extractConst(storeSource, name));
    });
  }
});
