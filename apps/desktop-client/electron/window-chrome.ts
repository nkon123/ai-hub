// 창 테두리(작업 표시줄) 설정 — 순수 함수라 Electron 없이 시험한다.
//
// 기본 창에는 OS 제목 줄과 "File Edit View …" 메뉴 줄이 있다. 이 앱은 둘 다 쓰지 않는다:
// 메뉴 항목이 하나도 앱 기능과 연결돼 있지 않고, 제목은 화면(렌더러)이 그린다.
// 그래서 OS 제목 줄을 숨기고(`titleBarStyle: "hidden"`) 최소·최대·닫기 버튼만 OS 가
// 흰 막대 위에 겹쳐 그리게 한다(`titleBarOverlay`). 막대의 나머지는 렌더러의 `TitleBar`.

export const APP_TITLE = "AIHUB Desktop";
/** 렌더러 TitleBar 의 높이와 같아야 한다 — 다르면 창 버튼이 막대 밖으로 어긋난다. */
export const TITLE_BAR_HEIGHT = 36;

export interface WindowChromeOptions {
  titleBarStyle: "hidden";
  titleBarOverlay?: { color: string; symbolColor: string; height: number };
  trafficLightPosition?: { x: number; y: number };
}

export function windowChromeOptions(platform: NodeJS.Platform): WindowChromeOptions {
  if (platform === "darwin") {
    // macOS 는 신호등 버튼을 왼쪽에 그린다. 막대 높이의 가운데에 맞춘다.
    return { titleBarStyle: "hidden", trafficLightPosition: { x: 14, y: (TITLE_BAR_HEIGHT - 12) / 2 } };
  }
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#ffffff", symbolColor: "#334155", height: TITLE_BAR_HEIGHT },
  };
}

/**
 * 앱 메뉴 줄을 없앨지. macOS 는 **없애지 않는다** — 그곳에서는 메뉴가 복사·붙여넣기·실행 취소
 * 단축키의 통로라, 지우면 입력창에서 Cmd+C/V 가 동작하지 않는다. Windows/Linux 는 웹 화면이
 * 단축키를 직접 처리하므로 지워도 된다.
 */
export function shouldRemoveAppMenu(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}
