// D-096 "다시 활성화". 이 기능의 존재 이유는 "설정을 고친 뒤 자산을 다시
// 설치하지 않고 재시도한다"이므로, 검증해야 할 것도 그것이다: 설치된 파일을
// 건드리지 않고, 설치 직후와 같은 경로를 보내고, 결과를 기록에 남긴다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInstallRoot, type InstallRootLayout } from "../bundle-install";
import { InstalledAssetsStore } from "../installed-assets-store";
import { reactivateInstalledMcpServer } from "../mcp-server-connection";
import type { FetchLike } from "../mcp-server-activation";

const ASSET_ID = "aaaa1111-bbbb-2222-cccc-333333333333";
const VERSION = "1.0.0";

let tmpRoot: string;
let layout: InstallRootLayout;
let store: InstalledAssetsStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-reactivate-"));
  layout = resolveInstallRoot(tmpRoot);
  store = new InstalledAssetsStore(layout.stateDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function installMcpServerAsset(manifest: unknown = {
  type: "mcp_server",
  server_alias: "hello-mcp",
  transport: { kind: "STDIO", interpreter: "python", entrypoint: "server.py" },
}) {
  const dir = path.join(layout.assetsDir, "mcp-servers", ASSET_ID, VERSION);
  fs.mkdirSync(path.join(dir, "source"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest), "utf-8");
  fs.writeFileSync(path.join(dir, "source", "server.py"), "print('hi')\n", "utf-8");
  store.upsert({
    assetType: "mcp_server",
    assetId: ASSET_ID,
    assetVersionId: null,
    version: VERSION,
    name: "예제 서버",
    installedAt: new Date().toISOString(),
    sizeBytes: 10,
    activation: {
      state: "FAILED",
      checkedAt: new Date().toISOString(),
      reason: "install_path_outside_allowed_roots",
      message: "허용 목록에 추가해 달라고 요청하세요",
      indexPath: null,
    },
  });
  return dir;
}

function respondWith(status: number, body: unknown): { fetchImpl: FetchLike; calls: any[] } {
  const calls: any[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

describe("reactivateInstalledMcpServer", () => {
  it("retries with the same install path the automatic activation uses", async () => {
    const dir = installMcpServerAsset();
    const { fetchImpl, calls } = respondWith(200, {
      entry: { server_alias: "hello-mcp", tool_names: ["hello.echo"] },
    });

    const result = await reactivateInstalledMcpServer(
      layout,
      store,
      "http://localhost:8100",
      { assetId: ASSET_ID, version: VERSION },
      fetchImpl,
    );

    expect(result.ok).toBe(true);
    expect(calls[0].body.install_path).toBe(path.join(dir, "source"));
    // 기록이 FAILED -> ACTIVE 로 바뀌어야 목록이 달라진다.
    expect(store.find("mcp_server", ASSET_ID, VERSION)?.activation?.state).toBe("ACTIVE");
  });

  it("does not touch the installed files", async () => {
    const dir = installMcpServerAsset();
    const { fetchImpl } = respondWith(400, { error: { code: "interpreter_not_configured" } });

    await reactivateInstalledMcpServer(
      layout,
      store,
      "http://localhost:8100",
      { assetId: ASSET_ID, version: VERSION },
      fetchImpl,
    );

    // 이 기능의 요점 — 재설치 없이 재시도한다.
    expect(fs.existsSync(path.join(dir, "source", "server.py"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(true);
  });

  it("records a repeated refusal with its action text", async () => {
    installMcpServerAsset();
    const { fetchImpl } = respondWith(400, { error: { code: "interpreter_not_configured" } });

    const result = await reactivateInstalledMcpServer(
      layout,
      store,
      "http://localhost:8100",
      { assetId: ASSET_ID, version: VERSION },
      fetchImpl,
    );

    expect(result.ok).toBe(false);
    const activation = store.find("mcp_server", ASSET_ID, VERSION)?.activation;
    expect(activation?.state).toBe("FAILED");
    expect(activation?.reason).toBe("interpreter_not_configured");
    expect(activation?.message).toContain("실행할 프로그램");
  });

  it("reports a missing record without writing anything", async () => {
    const { fetchImpl, calls } = respondWith(200, {});
    const result = await reactivateInstalledMcpServer(
      layout,
      store,
      "http://localhost:8100",
      { assetId: "not-installed", version: VERSION },
      fetchImpl,
    );

    expect(result.ok).toBe(false);
    // 시도할 것이 없었으므로 호출도 기록도 없다.
    expect(calls).toHaveLength(0);
    expect(result.activation).toBeNull();
  });

  it("reports an unreadable manifest as a recorded failure", async () => {
    installMcpServerAsset();
    fs.writeFileSync(
      path.join(layout.assetsDir, "mcp-servers", ASSET_ID, VERSION, "manifest.json"),
      "{ not json",
      "utf-8",
    );
    const { fetchImpl, calls } = respondWith(200, {});

    const result = await reactivateInstalledMcpServer(
      layout,
      store,
      "http://localhost:8100",
      { assetId: ASSET_ID, version: VERSION },
      fetchImpl,
    );

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0); // 읽지 못한 매니페스트를 보내지 않는다
    expect(store.find("mcp_server", ASSET_ID, VERSION)?.activation?.reason).toBe(
      "manifest_unreadable",
    );
  });

  it("sends no install path for an HTTP server", async () => {
    installMcpServerAsset({
      type: "mcp_server",
      server_alias: "office-connector",
      transport: { kind: "HTTP", endpoint: "http://localhost:8500/mcp" },
    });
    const { fetchImpl, calls } = respondWith(200, {
      entry: { server_alias: "office-connector", tool_names: [] },
    });

    await reactivateInstalledMcpServer(
      layout,
      store,
      "http://localhost:8100",
      { assetId: ASSET_ID, version: VERSION },
      fetchImpl,
    );

    expect(calls[0].body.install_path).toBeNull();
  });
});
