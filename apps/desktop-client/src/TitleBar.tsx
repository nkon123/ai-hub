import { APP_TITLE, TITLE_BAR_HEIGHT } from "../electron/window-chrome";

/**
 * 창 맨 위의 흰 막대. OS 제목 줄과 "File Edit View" 메뉴 줄을 없앴으므로(electron/window-chrome.ts)
 * 앱 이름은 여기서 보여준다. 최소·최대·닫기 버튼은 OS 가 이 막대 오른쪽 위에 겹쳐 그린다 —
 * 그 자리를 비워 두려고 오른쪽에는 아무것도 놓지 않는다. 막대 전체가 드래그 영역이다.
 */
export function TitleBar() {
  // macOS 는 신호등 버튼이 왼쪽에 있어서 이름을 그 오른쪽으로 민다.
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  return (
    <div
      role="presentation"
      className="app-drag flex shrink-0 select-none items-center border-b border-border bg-white"
      style={{ height: TITLE_BAR_HEIGHT, paddingLeft: isMac ? 78 : 14 }}
    >
      <span className="text-sm font-semibold tracking-tight text-text-primary">{APP_TITLE}</span>
    </div>
  );
}
