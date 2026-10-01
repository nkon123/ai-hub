import { describe, expect, it } from "vitest";
import { APP_TITLE, TITLE_BAR_HEIGHT, shouldRemoveAppMenu, windowChromeOptions } from "../window-chrome";

describe("windowChromeOptions", () => {
  it("hides the OS title bar and overlays a white bar's window buttons on Windows and Linux", () => {
    for (const platform of ["win32", "linux"] as const) {
      const options = windowChromeOptions(platform);
      expect(options.titleBarStyle).toBe("hidden");
      expect(options.titleBarOverlay).toEqual({ color: "#ffffff", symbolColor: "#334155", height: TITLE_BAR_HEIGHT });
      expect(options.trafficLightPosition).toBeUndefined();
    }
  });

  it("keeps macOS traffic lights, vertically centred in the bar", () => {
    const options = windowChromeOptions("darwin");
    expect(options.titleBarStyle).toBe("hidden");
    expect(options.titleBarOverlay).toBeUndefined();
    expect(options.trafficLightPosition?.y).toBe((TITLE_BAR_HEIGHT - 12) / 2);
  });
});

describe("shouldRemoveAppMenu", () => {
  it("removes the File/Edit menu bar on Windows and Linux", () => {
    expect(shouldRemoveAppMenu("win32")).toBe(true);
    expect(shouldRemoveAppMenu("linux")).toBe(true);
  });

  it("keeps the menu on macOS, where it carries the copy/paste shortcuts", () => {
    expect(shouldRemoveAppMenu("darwin")).toBe(false);
  });
});

it("names the app AIHUB Desktop", () => {
  expect(APP_TITLE).toBe("AIHUB Desktop");
});
