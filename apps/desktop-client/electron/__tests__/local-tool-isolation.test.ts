// D-084 hard requirement 1 (Task Brief): local tools must be STRUCTURALLY
// excluded from D-083 TOOL_ROUTE / D-080 MCP Tool registration — never
// reachable from agent-runtime, never referenced from the chat payload path,
// never sharing a store with Hub-installed assets. This is proven here by
// reading the actual source text of the relevant files and asserting the
// forbidden references are absent — not by a runtime flag that a future
// change could quietly flip. If someone later wires a local tool into
// `src/agentRuntime.ts` or `src/screens/chatTypes.ts`'s payload-building
// code, this test must fail.
//
// D-084 후속 2 (채팅 질문으로 로컬 Tool 인자 자동 채우기, 사용자 실사용
// 피드백 — 로컬 Tool을 D-083 TOOL_ROUTE에 태우지 말고 desktop-client 안에서
// 로컬 Ollama로 직접 라우팅하라는 명시적·재확인된 예외 요구): 아래
// "src/screens/ChatScreen.tsx: local-tool UI is wired in, but never into the
// run-starting payload" describe 블록의 한 검사(원래 "handleSend 함수 전체가
// LocalTool 식별자를 전혀 언급하지 않는다")는 이 변경으로 깨진다 —
// ChatScreen.tsx의 handleSend는 이제 자동 라우팅 분기(로컬 Tool 식별자를
// 다루는 `runLocalToolAutoRoute` 호출)를 포함해야 하기 때문이다. 그 검사는
// 지우지 않고 아래에서 **좁혔다**: 실제 보안 속성 — "`startRun`에 실리는
// Payload 객체 자체에는 로컬 Tool 식별자가 절대 들어가지 않는다" — 는
// 여전히 그대로 고정된다. 이것으로 충분한 이유: agent-runtime으로 나가는
// 유일한 경로는 `startRun(...)` 호출 하나이고(아래 두 번째 검사 "startRun is
// called from exactly one place"가 이미 이를 저장소 전체에서 강제한다),
// 로컬 Tool 자동 라우팅은 agent-runtime을 전혀 거치지 않는
// `electron/local-tool-router.ts`(로컬 Ollama에 직접 HTTP) +
// `bridge.invokeLocalTool`(Main Process IPC) 조합으로만 끝난다 — 그러므로
// handleSend 함수 몸체 어딘가에 "localTool" 문자열이 등장하는 것 자체는
// 안전성과 무관하고, `startRun`에 넘기는 Payload 객체 리터럴에 로컬 Tool
// 값이 섞여 드는지만이 실제로 지켜야 할 속성이다.
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

  // D-084 후속 2 — 채팅 질문으로 로컬 Tool을 자동 라우팅하는 새 모듈. 이
  // 파일이 로컬 Ollama에 직접(HTTP) 묻는 것과 D-083 `tool_router.py`가
  // agent-runtime 안에서 MCP Tool을 라우팅하는 것은 완전히 다른 경로라는
  // 사실을 이 테스트가 고정한다 — agent-runtime/MCP 등록/설치된 자산 저장소
  // 어디에도 이 파일이 닿지 않는다. fs/electron/node import가 없는 순수
  // HTTP 모듈이라는 사실도 함께 고정한다(main-process 전용 코드가 여기 섞여
  // 들면 렌더러 번들에 그대로 실린다 — 이 앱의 CLAUDE.md 코드 배치 규칙).
  it("local-tool-router.ts never imports agent-runtime/MCP registration/installed-assets modules and stays fs/electron-free", () => {
    const source = read("electron/local-tool-router.ts");
    expect(source).not.toContain("mcp-tool-registration-client");
    expect(source).not.toContain("agentRuntime");
    expect(source).not.toContain("installed-assets-store");
    expect(source).not.toMatch(/from ["']node:/);
    expect(source).not.toMatch(/from ["']electron["']/);
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

    // D-084 후속 2에서 좁힘(위 파일 상단 주석 참고) — 원래 이 검사는
    // handleSend 함수 전체(시작부터 startRun 호출까지)에서 "localTool"
    // 문자열을 금지했다. 지금 handleSend는 그 앞부분에 로컬 Tool 자동
    // 라우팅 분기(`runLocalToolAutoRoute` 호출, agent-runtime을 전혀 거치지
    // 않고 그 분기 자신의 `return`으로 끝난다)를 포함하므로 그 전제가 더는
    // 성립하지 않는다. 실제로 지켜야 하는 속성은 여전히 참이다 — agent-
    // runtime에 실제로 전달되는 것은 `startRun(...)` 호출의 Payload 객체
    // 리터럴 하나뿐이므로, 검사 범위를 그 호출 자체로 좁힌다.
    it("the startRun(...) call's payload literal never references local-tool identifiers", () => {
      const start = chatScreen.indexOf("const created = await startRun({");
      const end = chatScreen.indexOf("runIdRef.current = created.id");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const startRunPayload = chatScreen.slice(start, end);
      expect(startRunPayload).not.toContain("localTool");
      expect(startRunPayload).not.toContain("LocalTool");
      expect(startRunPayload).not.toContain("local-tool");
    });

    // 위 검사가 "핸들러 전체가 아니라 Payload 부분만" 본다는 좁힘이
    // 안전하려면, 로컬 Tool 자동 라우팅 분기가 실제로 그 Payload 호출에
    // 도달하기 전에 return한다는 사실이 참이어야 한다 — 그렇지 않으면 같은
    // 턴에서 로컬 Tool 식별자와 agent-runtime Payload가 뒤섞일 수 있다.
    // handleSend 함수 전체를 대상으로, 로컬 Tool 자동 라우팅을 시작하는
    // 지점(`runLocalToolAutoRoute` 호출)이 `startRun(...)` 호출보다 앞에
    // 있고, 그 사이에 이 분기를 끝내는 `return`이 있는지를 소스 텍스트로
    // 직접 고정한다.
    it("the local-tool auto-route branch in handleSend returns before reaching startRun's payload", () => {
      const handleSendStart = chatScreen.indexOf("async function handleSend(");
      const nextFunctionStart = chatScreen.indexOf("\n  async function handleConfirmDecision(");
      expect(handleSendStart).toBeGreaterThan(-1);
      expect(nextFunctionStart).toBeGreaterThan(handleSendStart);
      const handleSendBody = chatScreen.slice(handleSendStart, nextFunctionStart);
      const autoRouteCallIndex = handleSendBody.indexOf("handleLocalToolAutoRoute(");
      const startRunCallIndex = handleSendBody.indexOf("startRun({");
      expect(autoRouteCallIndex).toBeGreaterThan(-1);
      expect(startRunCallIndex).toBeGreaterThan(autoRouteCallIndex);
      const betweenAutoRouteAndStartRun = handleSendBody.slice(autoRouteCallIndex, startRunCallIndex);
      expect(betweenAutoRouteAndStartRun).toContain("return");
    });

    // D-089 후속(통합 Tool 라우팅) — 이번 턴이 통합 라우팅에서 "MCP"로
    // 판정된 경우에도(handleLocalToolAutoRoute가 "mcp"를 반환해 아래로
    // 흘러 내려온 경우) 위 payload literal 검사가 여전히 유효하다는 것을
    // 직접 고정한다: payload는 `turnMcpToolRouteForced`라는 지역 변수
    // (로컬 Tool 정보를 전혀 담지 않는 boolean)만 참조하고, 로컬 Tool
    // 식별자는 그 변수 이름에도, payload 리터럴 어디에도 등장하지 않는다.
    it("an MCP-picked turn's startRun payload only ever carries the boolean turnMcpToolRouteForced — never a local-tool identifier", () => {
      const start = chatScreen.indexOf("const created = await startRun({");
      const end = chatScreen.indexOf("runIdRef.current = created.id");
      const startRunPayload = chatScreen.slice(start, end);
      expect(startRunPayload).toContain("turnMcpToolRouteForced");
      expect(startRunPayload).not.toMatch(/localTool|LocalTool|local-tool/);
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

  // D-089 후속(통합 Tool 라우팅, 2026-08-20) — "선택은 합치고 실행은 합치지
  // 않는다"의 새 경계 지점. `unified-tool-router.ts`는 로컬 Tool 후보와
  // 연결된 MCP Tool 이름을 함께 받아 "이번 턴에 어느 쪽을 쓸지"만 결정하고,
  // agent-runtime이나 MCP 등록 모듈은 전혀 모른다 — 실제 실행은 여전히
  // 호출자(ChatScreen.tsx)가 kind로 분기한다.
  it("unified-tool-router.ts never imports agent-runtime/MCP registration/installed-assets modules and stays fs/electron-free", () => {
    const source = read("electron/unified-tool-router.ts");
    expect(source).not.toContain("mcp-tool-registration-client");
    expect(source).not.toContain("agentRuntime");
    expect(source).not.toContain("installed-assets-store");
    expect(source).not.toMatch(/from ["']node:/);
    expect(source).not.toMatch(/from ["']electron["']/);
  });

  // D-089 후속 — ChatScreen.tsx가 통합 라우터를 직접 import하는 것은
  // 허용된다(격리 경계는 "agent-runtime으로 나가는 Payload에 로컬 Tool
  // 식별자가 섞이지 않는다"이지, "ChatScreen이 이 모듈을 모른다"가 아니다).
  // 다만 그 import가 로컬 Tool 이름을 담은 채로 오지 않는지 확인한다.
  it("src/screens/ChatScreen.tsx imports the unified router only from electron/unified-tool-router, not electron/local-tool-router directly for routing", () => {
    const chatScreen = read("src/screens/ChatScreen.tsx");
    expect(chatScreen).toContain('from "../../electron/unified-tool-router"');
    expect(chatScreen).not.toContain('from "../../electron/local-tool-router"');
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

// D-084 후속 3 ("최초 한번만 승인", 2026-08-17) — a per-tool standing
// approval lets `localTool:invoke` skip the native dialog, but ONLY when the
// Main Process itself has just re-read the file and recomputed its hash to
// match a stored approval. These checks pin the source shape that makes that
// true — they don't replace the ipcMain.handle behavioral test above, they
// narrow the same handler slice further.
describe("D-084 후속 3 — standing execution approval is re-derived by the Main Process on every call, never trusted from the renderer", () => {
  const main = read("electron/main.ts");
  const invokeHandler = main.slice(
    main.indexOf('ipcMain.handle(\n    "localTool:invoke"'),
    main.indexOf("app.whenReady()"),
  );

  it("re-reads the file and recomputes the hash before deciding whether to skip the dialog", () => {
    // The IPC handler signature only ever receives (id, args, options) —
    // never a caller-supplied approval flag or hash. Grepping the handler's
    // own parameter list proves the renderer has no channel to assert
    // "already approved" into this decision.
    const handlerSignature = main.slice(
      main.indexOf('ipcMain.handle(\n    "localTool:invoke"'),
      main.indexOf("): Promise<LocalToolInvocationResult> =>") + 40,
    );
    expect(handlerSignature).not.toMatch(/approv/i);

    expect(invokeHandler).toContain("fs.readFileSync(tool.filePath");
    expect(invokeHandler).toContain("hashLocalToolSource(currentSource)");
  });

  it("only compares against the hash stored on the LocalTool record (tool.approval), not the file path alone", () => {
    expect(invokeHandler).toContain("tool.approval");
    expect(invokeHandler).toContain("storedApproval.approvedFileHash === currentHash");
  });

  it("shows a distinct notice when a stale (content-changed) approval is discarded", () => {
    expect(invokeHandler).toContain("파일 내용이 승인 이후 변경되어 이전 승인이 무효화되었습니다");
  });

  it("fails closed (never spawns) when the file can't be read, before any approval check matters", () => {
    const readFailureIndex = invokeHandler.indexOf("catch (err) {");
    const spawnIndex = invokeHandler.lastIndexOf("runInvokeLocalTool");
    expect(readFailureIndex).toBeGreaterThan(-1);
    expect(spawnIndex).toBeGreaterThan(readFailureIndex);
    expect(invokeHandler).toContain("파일을 읽을 수 없어 실행하지 않았습니다");
  });

  it("the dialog approval branch never calls the store's approve() — a per-run 실행 click is never promoted to a standing approval", () => {
    const dialogBranchStart = invokeHandler.indexOf("if (!approvalStillValid)");
    const dialogBranchEnd = invokeHandler.indexOf("} else {", dialogBranchStart);
    expect(dialogBranchStart).toBeGreaterThan(-1);
    expect(dialogBranchEnd).toBeGreaterThan(dialogBranchStart);
    const dialogBranch = invokeHandler.slice(dialogBranchStart, dialogBranchEnd);
    expect(dialogBranch).not.toContain(".approve(");
  });

  it("skips dialog.showMessageBox only inside the approvalStillValid branch", () => {
    const skipBranchStart = invokeHandler.indexOf("} else {");
    const skipBranchEnd = invokeHandler.indexOf("const interpreterPath", skipBranchStart);
    expect(skipBranchStart).toBeGreaterThan(-1);
    expect(skipBranchEnd).toBeGreaterThan(skipBranchStart);
    const skipBranch = invokeHandler.slice(skipBranchStart, skipBranchEnd);
    expect(skipBranch).not.toContain("dialog.showMessageBox");
  });
});

// The approve/revoke handlers themselves must derive the hash from a fresh
// Main-process file read too — never accept a hash the renderer computed and
// sent over IPC (the renderer can't be trusted to have read the real file,
// or the real current content of it).
describe("D-084 후속 3 — approve/revoke handlers are Main-process authoritative", () => {
  const main = read("electron/main.ts");

  it("approveExecution re-reads the file itself and only then calls store.approve with the freshly computed hash", () => {
    const start = main.indexOf('"localTool:approveExecution"');
    const end = main.indexOf('"localTool:revokeExecution"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = main.slice(start, end);
    expect(handler).toContain("fs.readFileSync(tool.filePath");
    expect(handler).toContain(".approve(id, hashLocalToolSource(source))");
    // No parameter carrying a caller-supplied hash/approval value.
    expect(handler).not.toMatch(/approveExecution["'],?\s*async \(_event, id: string, .*hash/i);
  });

  it("revokeExecution takes only an id — nothing the renderer asserts is trusted as the new state", () => {
    const start = main.indexOf('"localTool:revokeExecution"');
    const end = main.indexOf('ipcMain.handle(\n    "localTool:invoke"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = main.slice(start, end);
    expect(handler).toContain(".revoke(id)");
  });
});
