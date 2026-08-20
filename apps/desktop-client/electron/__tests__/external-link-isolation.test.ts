// D-093 hard requirement: `shell.openExternal` is a newly-introduced
// capability in this repository (it did not exist before this change) and
// root CLAUDE.md 구현 원칙 7 forbids "승인되지 않은 임의 Python 실행, 외부
// URL, Package 설치 기능" — D-093 grants an explicit, narrow exception for
// exactly one address (https://ollama.com/download). This file pins that the
// exception stays narrow: no code path lets the renderer choose which URL
// gets opened.
//
// Deliberately a SEPARATE file from `local-tool-isolation.test.ts` (per Task
// Brief instruction) — that file is D-084's local-tool isolation boundary
// and is not touched here.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..", "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
}

describe("D-093 external link opening stays scoped to the one approved address", () => {
  it("shell.openExternal is called from exactly one place in the whole electron/ directory", () => {
    const electronDir = path.join(ROOT, "electron");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf-8");
          if (text.includes("openExternal(")) offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(electronDir);
    expect(offenders).toEqual(["electron/main.ts"]);
  });

  it("main.ts's openExternal call is given the OLLAMA_DOWNLOAD_URL constant, never a variable/argument", () => {
    const main = read("electron/main.ts");
    const callIndex = main.indexOf("shell.openExternal(");
    expect(callIndex).toBeGreaterThan(-1);
    const callSite = main.slice(callIndex, callIndex + "shell.openExternal(OLLAMA_DOWNLOAD_URL)".length + 5);
    expect(callSite).toContain("shell.openExternal(OLLAMA_DOWNLOAD_URL)");
  });

  it("the external:openOllamaDownloadPage IPC handler declares no parameters other than the unused event", () => {
    const main = read("electron/main.ts");
    const handlerStart = main.indexOf('"external:openOllamaDownloadPage"');
    expect(handlerStart).toBeGreaterThan(-1);
    // Grab the handler's arrow-function signature line(s) up to the opening brace.
    const signature = main.slice(handlerStart, main.indexOf("{", handlerStart + 40) + 1);
    // Only `async ()` or `async (): Promise<...> =>` shapes are allowed — no
    // named parameter that could carry a caller-supplied URL/string.
    expect(signature).toMatch(/async\s*\(\s*\)\s*:/);
  });

  it("DesktopBridge's openOllamaDownloadPage takes no arguments (electron/types.ts)", () => {
    const types = read("electron/types.ts");
    const declIndex = types.indexOf("openOllamaDownloadPage(");
    expect(declIndex).toBeGreaterThan(-1);
    const decl = types.slice(declIndex, types.indexOf(")", declIndex) + 1);
    expect(decl).toBe("openOllamaDownloadPage()");
  });

  it("preload.ts's bridge method takes no arguments and forwards to the fixed channel", () => {
    const preload = read("electron/preload.ts");
    const declIndex = preload.indexOf("openOllamaDownloadPage:");
    expect(declIndex).toBeGreaterThan(-1);
    const decl = preload.slice(declIndex, preload.indexOf("=>", declIndex));
    expect(decl).toMatch(/openOllamaDownloadPage:\s*\(\s*\)\s*:/);
    expect(preload.slice(declIndex, declIndex + 300)).toContain('ipcRenderer.invoke("external:openOllamaDownloadPage")');
  });

  it("no other general-purpose 'open any URL' bridge method exists (no openExternalUrl/openUrl/openLink taking a url arg)", () => {
    const types = read("electron/types.ts");
    expect(types).not.toMatch(/open(External)?Url\s*\(\s*url/i);
    expect(types).not.toMatch(/openLink\s*\(\s*url/i);
  });
});
