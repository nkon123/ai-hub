// D-084 hard requirement 1 (Task Brief): local tools must be STRUCTURALLY
// excluded from D-083 TOOL_ROUTE / D-080 MCP Tool registration — never
// reachable from agent-runtime, never referenced from the chat payload path,
// never sharing a store with Hub-installed assets. This is proven here by
// reading the actual source text of the relevant files and asserting the
// forbidden references are absent — not by a runtime flag that a future
// change could quietly flip. If someone later wires a local tool into
// `src/agentRuntime.ts` or `src/screens/chatTypes.ts`'s payload-building
// code, this test must fail.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..", "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
}

describe("D-084 local tool structural isolation", () => {
  it("local-tool-signature.ts never imports agent-runtime/MCP registration/installed-assets modules", () => {
    const source = read("electron/local-tool-signature.ts");
    expect(source).not.toContain("mcp-tool-registration-client");
    expect(source).not.toContain("agentRuntime");
    expect(source).not.toContain("installed-assets-store");
  });

  it("local-tool-store.ts never imports agent-runtime/MCP registration/installed-assets modules", () => {
    const source = read("electron/local-tool-store.ts");
    expect(source).not.toContain("mcp-tool-registration-client");
    expect(source).not.toContain("agentRuntime");
    expect(source).not.toContain("installed-assets-store");
  });

  it("local-tool-runner.ts never imports agent-runtime/MCP registration/installed-assets modules", () => {
    const source = read("electron/local-tool-runner.ts");
    expect(source).not.toContain("mcp-tool-registration-client");
    expect(source).not.toContain("agentRuntime");
    expect(source).not.toContain("installed-assets-store");
  });

  it("src/agentRuntime.ts never references local-tool identifiers", () => {
    const source = read("src/agentRuntime.ts");
    expect(source).not.toContain("localTool");
    expect(source).not.toContain("LocalTool");
    expect(source).not.toContain("local-tool");
  });

  it("src/screens/chatTypes.ts never references local-tool identifiers", () => {
    const source = read("src/screens/chatTypes.ts");
    expect(source).not.toContain("localTool");
    expect(source).not.toContain("LocalTool");
    expect(source).not.toContain("local-tool");
  });

  it("src/screens/ChatScreen.tsx never references local-tool identifiers", () => {
    const source = read("src/screens/ChatScreen.tsx");
    expect(source).not.toContain("localTool");
    expect(source).not.toContain("LocalTool");
    expect(source).not.toContain("local-tool");
  });

  it("LocalToolStore's persisted file name is distinct from InstalledAssetsStore's", () => {
    const localToolStoreSource = read("electron/local-tool-store.ts");
    const installedAssetsStoreSource = read("electron/installed-assets-store.ts");
    expect(localToolStoreSource).toContain("local-tools.json");
    expect(installedAssetsStoreSource).not.toContain("local-tools.json");
    expect(localToolStoreSource).not.toContain("installations.json");
  });

  it("mcp-tool-connection.ts (the D-080 registration path) never references local-tool identifiers", () => {
    const source = read("electron/mcp-tool-connection.ts");
    expect(source).not.toContain("localTool");
    expect(source).not.toContain("LocalTool");
  });
});

// D-084 hard requirement 2: every execution needs an explicit approval that
// the **Main Process itself** obtained. The renderer's confirm step in
// LocalToolsScreen is not sufficient — in Electron the trust boundary is the
// Main Process, so if only the renderer confirmed, any other code path that
// reaches the bridge could run the user's Python with their privileges and no
// approval. That is precisely the "승인되지 않은 임의 Python 실행" 구현 원칙 7
// forbids. The add-time risk acknowledgement (`riskAcknowledgedAt`) does NOT
// substitute: it is a remembered approval, so later calls would run unattended.
describe("D-084 execution approval is owned by the Main Process", () => {
  const main = read("electron/main.ts");
  const invokeHandler = main.slice(
    main.indexOf('ipcMain.handle(\n    "localTool:invoke"'),
    main.indexOf('app.whenReady()'),
  );

  it("the invoke handler exists and was located for inspection", () => {
    expect(invokeHandler).toContain("localTool:invoke");
  });

  it("asks the user via a native dialog before spawning anything", () => {
    expect(invokeHandler).toContain("dialog.showMessageBox");
    // The prompt must name the file and the arguments — approving a tool
    // without seeing what it will run on is not informed approval.
    expect(invokeHandler).toContain("tool.filePath");
    expect(invokeHandler).toContain("JSON.stringify(args");
  });

  it("returns user_denied without spawning when the user cancels", () => {
    const denyIndex = invokeHandler.indexOf('outcome: "user_denied"');
    const spawnIndex = invokeHandler.indexOf("runInvokeLocalTool");
    expect(denyIndex).toBeGreaterThan(-1);
    expect(spawnIndex).toBeGreaterThan(-1);
    // The denial path must come first — i.e. the spawn is unreachable unless
    // the dialog was answered with 실행.
    expect(denyIndex).toBeLessThan(spawnIndex);
  });
});
