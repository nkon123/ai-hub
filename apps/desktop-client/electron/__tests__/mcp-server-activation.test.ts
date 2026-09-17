// D-096. 설치와 활성화가 별개라는 것, 그리고 활성화 실패가 설치 실패가
// 아니라는 것을 고정한다. 이 둘이 흐려지면 둘 중 하나가 일어난다: 활성화
// 실패가 설치를 되돌리거나(파일은 멀쩡한데 지워진다), 실패가 조용히
// 삼켜져 사용자가 "설치는 됐는데 왜 안 되지"를 원인 없이 마주한다 —
// 후자가 이 기능을 만들게 한 실제 피드백이다.
import { describe, expect, it } from "vitest";
import {
  activateInstalledMcpServer,
  needsInstallPath,
  serverAliasOf,
  type FetchLike,
} from "../mcp-server-activation";

const STDIO_MANIFEST = {
  server_alias: "hello-mcp",
  transport: { kind: "STDIO", interpreter: "python", entrypoint: "server.py" },
};

const HTTP_MANIFEST = {
  server_alias: "office-connector",
  transport: { kind: "HTTP", endpoint: "http://localhost:8500/mcp" },
};

function target(manifest: Record<string, unknown>) {
  return {
    assetId: "asset-1",
    version: "1.0.0",
    installPath: "C:\\install\\mcp-servers\\asset-1\\1.0.0\\source",
    manifest,
  };
}

function respondWith(status: number, body: unknown): { fetchImpl: FetchLike; calls: any[] } {
  const calls: any[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

describe("serverAliasOf / needsInstallPath", () => {
  it("reads the alias, and treats a blank one as absent", () => {
    expect(serverAliasOf(STDIO_MANIFEST)).toBe("hello-mcp");
    expect(serverAliasOf({ server_alias: "   " })).toBeNull();
    expect(serverAliasOf({})).toBeNull();
  });

  it("only stdio servers need an install path", () => {
    expect(needsInstallPath(STDIO_MANIFEST)).toBe(true);
    expect(needsInstallPath(HTTP_MANIFEST)).toBe(false);
    expect(needsInstallPath({})).toBe(false);
  });
});

describe("activateInstalledMcpServer", () => {
  it("sends the install path for a stdio server", async () => {
    const { fetchImpl, calls } = respondWith(200, {
      entry: { server_alias: "hello-mcp", tool_names: ["hello.echo", "hello.now"] },
    });
    const outcome = await activateInstalledMcpServer("http://localhost:8100", target(STDIO_MANIFEST), fetchImpl);

    expect(outcome.status).toBe("PASS");
    expect(outcome.message).toContain("기능 2개");
    expect(calls[0].url).toBe("http://localhost:8100/local/v1/mcp-servers");
    expect(calls[0].body.install_path).toBe(target(STDIO_MANIFEST).installPath);
    expect(calls[0].body.source).toBe("OFFLINE_BUNDLE");
  });

  it("does NOT send an install path for an HTTP server", async () => {
    // 실행하는 것이 없는데 경로를 보내면 실행과 무관한 경로 검사에 걸린다.
    const { fetchImpl, calls } = respondWith(200, { entry: { server_alias: "office-connector", tool_names: [] } });
    await activateInstalledMcpServer("http://localhost:8100", target(HTTP_MANIFEST), fetchImpl);
    expect(calls[0].body.install_path).toBeNull();
  });

  it("trims a trailing slash off the configured base URL", async () => {
    const { fetchImpl, calls } = respondWith(200, { entry: { server_alias: "hello-mcp", tool_names: [] } });
    await activateInstalledMcpServer("http://localhost:8100/", target(STDIO_MANIFEST), fetchImpl);
    expect(calls[0].url).toBe("http://localhost:8100/local/v1/mcp-servers");
  });

  it("turns a refusal into an action, not a translated reason", async () => {
    const { fetchImpl } = respondWith(400, {
      error: { code: "install_path_outside_allowed_roots" },
    });
    const outcome = await activateInstalledMcpServer("http://localhost:8100", target(STDIO_MANIFEST), fetchImpl);

    expect(outcome.status).toBe("WARN"); // 설치 실패가 아니다
    expect(outcome.reason).toBe("install_path_outside_allowed_roots");
    // 무엇을 해야 하는지 + 어느 경로인지가 함께 있어야 조치가 가능하다.
    expect(outcome.message).toContain("허용 목록에 추가");
    expect(outcome.message).toContain(target(STDIO_MANIFEST).installPath);
    // 기계용 사유를 그대로 노출하지 않는다.
    expect(outcome.message).not.toContain("install_path_outside_allowed_roots");
  });

  it("names the setting to turn on when registration is disabled", async () => {
    const { fetchImpl } = respondWith(403, {
      error: { code: "mcp_server_registration_disabled" },
    });
    const outcome = await activateInstalledMcpServer("http://localhost:8100", target(STDIO_MANIFEST), fetchImpl);
    expect(outcome.status).toBe("WARN");
    expect(outcome.message).toContain("등록");
  });

  it("does not throw when agent-runtime is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchLike;
    const outcome = await activateInstalledMcpServer("http://localhost:8100", target(STDIO_MANIFEST), fetchImpl);

    expect(outcome.status).toBe("WARN");
    expect(outcome.reason).toBe("agent_runtime_unreachable");
  });

  it("still reports an outcome when the refusal carries no reason code", async () => {
    const { fetchImpl } = respondWith(500, null);
    const outcome = await activateInstalledMcpServer("http://localhost:8100", target(STDIO_MANIFEST), fetchImpl);
    expect(outcome.status).toBe("WARN");
    expect(outcome.message).toContain("설치 자체는 완료");
  });
});
