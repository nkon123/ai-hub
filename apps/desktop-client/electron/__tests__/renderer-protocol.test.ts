import path from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_APP_ORIGIN, RENDERER_ENTRY_URL, resolveRendererAsset } from "../renderer-protocol";
import { DESKTOP_APP_ORIGIN as SUPERVISOR_ORIGIN } from "../runtime-supervisor";

const root = path.resolve("/opt/app.asar/dist/renderer");

describe("resolveRendererAsset (D-104)", () => {
  it("serves the entry page and built assets from the renderer folder", () => {
    expect(resolveRendererAsset(root, RENDERER_ENTRY_URL)).toBe(path.join(root, "index.html"));
    expect(resolveRendererAsset(root, `${DESKTOP_APP_ORIGIN}/`)).toBe(path.join(root, "index.html"));
    expect(resolveRendererAsset(root, `${DESKTOP_APP_ORIGIN}/assets/index-abc.js?v=1`)).toBe(path.join(root, "assets", "index-abc.js"));
    expect(resolveRendererAsset(root, `${DESKTOP_APP_ORIGIN}/assets/%ED%95%9C.png`)).toBe(path.join(root, "assets", "한.png"));
  });

  it("keeps literal dot segments inside the folder (URL parsing collapses them first)", () => {
    expect(resolveRendererAsset(root, `${DESKTOP_APP_ORIGIN}/../electron/main.js`)).toBe(path.join(root, "electron", "main.js"));
    expect(resolveRendererAsset(root, `${DESKTOP_APP_ORIGIN}/%2e%2e/electron/main.js`)).toBe(path.join(root, "electron", "main.js"));
  });

  it("refuses anything outside the renderer folder", () => {
    for (const url of [
      `${DESKTOP_APP_ORIGIN}/assets/%2e%2e%2f%2e%2e%2fpackage.json`,
      `${DESKTOP_APP_ORIGIN}/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json`,
      `${DESKTOP_APP_ORIGIN}/..%5c..%5cpackage.json`,
      `${DESKTOP_APP_ORIGIN}/%00index.html`,
      `${DESKTOP_APP_ORIGIN}/%E0%A4%A`,
    ]) {
      expect(resolveRendererAsset(root, url), url).toBeNull();
    }
  });

  it("refuses other hosts and schemes", () => {
    expect(resolveRendererAsset(root, "app://other/index.html")).toBeNull();
    expect(resolveRendererAsset(root, "file:///opt/app.asar/dist/renderer/index.html")).toBeNull();
    expect(resolveRendererAsset(root, "not a url")).toBeNull();
  });

  it("is the same origin the bundled runtime's CORS allows", () => {
    expect(SUPERVISOR_ORIGIN).toBe(DESKTOP_APP_ORIGIN);
  });
});
