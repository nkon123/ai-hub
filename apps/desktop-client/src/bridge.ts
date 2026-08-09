// Defensive accessor for the Electron preload bridge (M04).
//
// Screens MUST call getDesktopBridge() instead of touching `window.desktop`
// directly. The bridge is absent whenever the renderer runs outside the
// Desktop(Electron) shell — e.g. this Vite bundle opened directly in a
// browser tab for local development, or a preload script that failed to
// attach — and in that case screens must degrade to a calm "Desktop
// 런타임 필요" state instead of throwing. Per CLAUDE.md: "Desktop은 Runtime
// 장애 시 종료되지 않고 복구 안내를 제공한다."
import type { DesktopBridge } from "../electron/types";

export function getDesktopBridge(): DesktopBridge | null {
  return typeof window !== "undefined" && window.desktop ? window.desktop : null;
}
