import type { DesktopBridge } from "../electron/types";

declare global {
  interface Window {
    // Optional: only present inside the Electron shell's preload context.
    // A plain browser (e.g. `vite` dev server opened in a tab) never gets
    // this set. Always read it through `getDesktopBridge()` in `./bridge`
    // rather than asserting it non-null here.
    desktop?: DesktopBridge;
  }
}

export {};
