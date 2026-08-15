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

  // D-084 후속(로컬 Tool을 대화 화면에서 실행) — ChatScreen.tsx는 이제 로컬
  // Tool 실행 UI(LocalToolInvokePanel)를 렌더링하므로 파일 전체에서
  // "LocalTool" 문자열을 금지할 수는 없다. 대신 이 변경이 실제로 지켜야 할
  // 것 — Run을 시작해 agent-runtime에 Payload를 보내는 코드 경로가 로컬
  // Tool을 절대 참조하지 않는다는 것 — 을 구체적으로 검증한다.
  describe("src/screens/ChatScreen.tsx: local-tool UI is wired in, but never into the run-starting payload", () => {
    const chatScreen = read("src/screens/ChatScreen.tsx");

    it("imports LocalToolInvokePanel only from the dedicated isolation-boundary module", () => {
      expect(chatScreen).toContain('from "./LocalToolInvokePanel"');
    });

    it("never imports local-tool identifiers from ../agentRuntime or ./chatTypes", () => {
      // 두 모듈에서 실제로 import해 오는 이름 목록에 로컬 Tool 관련 이름이
      // 전혀 없는지, import 구문 자체를 읽어 확인한다(전체 파일에서
      // "LocalTool" 문자열을 금지하는 대신, "어디서 왔는지"를 확인한다).
      const agentRuntimeImportMatch = chatScreen.match(/import\s*{([^}]*)}\s*from\s*"\.\.\/agentRuntime"/);
      const chatTypesImportMatch = chatScreen.match(/import\s*{([^}]*)}\s*from\s*"\.\/chatTypes"/);
      expect(agentRuntimeImportMatch).not.toBeNull();
      expect(chatTypesImportMatch).not.toBeNull();
      expect(agentRuntimeImportMatch?.[1] ?? "").not.toMatch(/localTool|LocalTool/);
      expect(chatTypesImportMatch?.[1] ?? "").not.toMatch(/localTool|LocalTool/);
    });

    it("the run-starting function (handleSend, up to startRun's call and its payload) never references local-tool identifiers", () => {
      // handleSend는 startRun(...)을 호출해 실제로 agent-runtime에 Run을
      // 만드는 유일한 지점이다 — 이 함수의 시작부터 startRun 호출과 그
      // Payload 객체가 끝나는 지점(runIdRef.current = created.id 대입 직전)
      // 까지의 소스 텍스트에 로컬 Tool 관련 식별자가 전혀 없어야, "채팅
      // 화면이 로컬 Tool UI를 갖게 됐다"는 사실이 "그 UI가 만든 값이
      // agent-runtime으로 흘러간다"를 절대 의미하지 않는다고 말할 수 있다.
      const start = chatScreen.indexOf("async function handleSend(");
      const end = chatScreen.indexOf("runIdRef.current = created.id");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const handleSendUpToStartRun = chatScreen.slice(start, end);
      expect(handleSendUpToStartRun).not.toContain("localTool");
      expect(handleSendUpToStartRun).not.toContain("LocalTool");
      expect(handleSendUpToStartRun).not.toContain("local-tool");
    });

    it("startRun is called from exactly one place, so the slice checked above is the whole payload path", () => {
      // 위 검사는 handleSend 안의 한 구간만 읽는다. 그 검사가 의미를 가지려면
      // "Run을 시작하는 곳이 거기 하나뿐"이라는 전제가 참이어야 한다 — 두 번째
      // 호출 지점이 생기면 검사 구간 밖에서 로컬 Tool이 Payload로 흘러들어도
      // 위 테스트는 통과해버린다. 그 전제를 여기서 직접 고정한다.
      const callSites = chatScreen.match(/\bstartRun\s*\(/g) ?? [];
      expect(callSites).toHaveLength(1);
      // 렌더러 전체로 넓혀도 호출 지점은 이 파일 하나여야 한다(정의부는
      // agentRuntime.ts의 `export async function startRun(`이므로 제외).
      const srcDir = path.join(ROOT, "src");
      const offenders: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
            const text = fs.readFileSync(full, "utf-8");
            const calls = (text.match(/\bstartRun\s*\(/g) ?? []).length;
            const defs = (text.match(/function\s+startRun\s*\(/g) ?? []).length;
            if (calls - defs > 0) offenders.push(path.relative(ROOT, full));
          }
        }
      };
      walk(srcDir);
      expect(offenders).toEqual(["src/screens/ChatScreen.tsx"]);
    });

    it("LocalToolInvokePanel.tsx never imports ../agentRuntime or ./chatTypes", () => {
      const source = read("src/screens/LocalToolInvokePanel.tsx");
      expect(source).not.toContain('from "../agentRuntime"');
      expect(source).not.toContain('from "./chatTypes"');
    });
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
