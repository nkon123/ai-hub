// D-104 — the packaged renderer is served from `app://desktop/` instead of
// `file://`. A `file://` document sends `Origin: null`, which agent-runtime's
// CORS rejects, and allowing `null` would let any web page (sandboxed iframe)
// call the local runtime. A privileged standard scheme gives the renderer a
// real, unique origin that the bundled runtime alone allows
// (docs/implementation-spec/11-desktop-packaging-and-distribution.md §6.1.4).
//
// The path mapping is a pure function so the traversal guard is unit-tested
// without Electron (`__tests__/renderer-protocol.test.ts`).

import path from "node:path";

export const APP_SCHEME = "app";
export const APP_HOST = "desktop";
export const DESKTOP_APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const RENDERER_ENTRY_URL = `${DESKTOP_APP_ORIGIN}/index.html`;

/** Maps an `app://desktop/...` request to a file under `rendererRoot`, or
 * null for any other host or any path that would leave the root. */
export function resolveRendererAsset(rendererRoot: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  const root = path.resolve(rendererRoot);
  const relative = pathname === "/" || pathname === "" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}
