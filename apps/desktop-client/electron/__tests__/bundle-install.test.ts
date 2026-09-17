// Integration tests for the full Offline Bundle import pipeline
// (`bundle-install.ts`), run against real ZIP fixtures — not just the pure
// functions in isolation — because a security control "verified" only by
// reading the code is not verified. Fixtures live in `__tests__/fixtures/`
// (see `generate.py` for how they were produced) and `valid-bundle.zip` is
// an unmodified copy of a real Offline Bundle produced by
// `services/distribution-service`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ASSET_TYPE_FOLDER,
  importBundle,
  resolveInstallRoot,
  type InstallRootLayout,
} from "../bundle-install";
import { InstalledAssetsStore } from "../installed-assets-store";
import type { ImportProgressEvent } from "../types";

const FIXTURES_DIR = path.join(__dirname, "fixtures");

let tmpRoot: string;
let layout: InstallRootLayout;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-test-"));
  layout = resolveInstallRoot(tmpRoot);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function run(fixtureName: string) {
  const events: ImportProgressEvent[] = [];
  return importBundle(path.join(FIXTURES_DIR, fixtureName), layout, (e) => events.push(e)).then((result) => ({
    result,
    events,
  }));
}

describe("importBundle — security-critical rejections", () => {
  it("rejects a zip-slip entry (path escaping the extraction root) and cleans up quarantine", async () => {
    const { result } = await run("zip-slip.zip");
    expect(result.outcome).toBe("FAILED");
    expect(result.failedStage).toBe("PATH_SAFETY");
    expect(result.retryable).toBe(false);

    // Nothing should have been extracted or installed.
    expect(fs.readdirSync(layout.quarantineDir)).toHaveLength(0);
    expect(fs.existsSync(path.join(layout.assetsDir))).toBe(true);
    expect(fs.readdirSync(layout.assetsDir)).toHaveLength(0);
    // And critically: no file was ever written outside the extraction root.
    expect(fs.existsSync(path.join(tmpRoot, "..", "evil.txt"))).toBe(false);
  });

  it("rejects an absolute-path entry", async () => {
    const { result } = await run("absolute-path.zip");
    expect(result.outcome).toBe("FAILED");
    expect(result.failedStage).toBe("PATH_SAFETY");
    expect(fs.existsSync("/etc/passwd-pwned")).toBe(false);
  });

  it("rejects an oversized/zip-bomb archive before extracting it", async () => {
    const { result } = await run("zip-bomb.zip");
    expect(result.outcome).toBe("FAILED");
    expect(result.failedStage).toBe("SIZE_CAP");
    // The bomb must never have been decompressed onto disk.
    expect(fs.readdirSync(layout.quarantineDir)).toHaveLength(0);
  });

  it("detects a tampered file via checksum mismatch", async () => {
    const { result } = await run("tampered-checksum.zip");
    expect(result.outcome).toBe("FAILED");
    expect(result.failedStage).toBe("CHECKSUM");
    expect(result.retryable).toBe(true);
  });
});

describe("importBundle — the real Offline Bundle", () => {
  it("passes every check and installs the Knowledge asset", async () => {
    const { result, events } = await run("valid-bundle.zip");

    expect(result.outcome).toBe("SUCCESS");
    expect(result.failedStage).toBeNull();
    expect(result.checks.every((c) => c.status === "PASS" || c.status === "WARN")).toBe(true);
    // Signature/Trust must be reported (D-016), never silently skipped.
    expect(result.checks.find((c) => c.id === "SIGNATURE_TRUST")?.status).toBe("WARN");
    expect(result.installPlan).toHaveLength(1);
    expect(result.installPlan[0].asset_type).toBe("knowledge");
    expect(events.length).toBeGreaterThan(0);

    // The asset actually landed under assets/knowledge/<id>/<version>/.
    const assetId = result.installPlan[0].asset_id!;
    const version = result.installPlan[0].version!;
    const installedDir = path.join(layout.assetsDir, "knowledge", assetId, version);
    expect(fs.existsSync(path.join(installedDir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(installedDir, "source", "remote-work-policy.md"))).toBe(true);
    expect(fs.existsSync(path.join(installedDir, "index", "bm25.pkl"))).toBe(true);

    // The install is recorded for D02's asset list.
    const store = new InstalledAssetsStore(layout.stateDir);
    const record = store.find("knowledge", assetId, version);
    expect(record).toBeDefined();
    expect(record?.name).toContain("재택근무");

    // Temp copies are cleaned up per §4.6 Rollback (success also cleans up).
    expect(fs.readdirSync(layout.quarantineDir)).toHaveLength(0);
  });

  it("D08: records per-file checksums so 'Checksum 재검사' has a real baseline to compare against", async () => {
    const { result } = await run("valid-bundle.zip");
    const assetId = result.installPlan[0].asset_id!;
    const version = result.installPlan[0].version!;
    const store = new InstalledAssetsStore(layout.stateDir);
    const record = store.find("knowledge", assetId, version)!;

    expect(record.fileChecksums).toBeDefined();
    expect(record.fileChecksums!["manifest.json"]).toMatch(/^[0-9a-f]{64}$/);
    expect(record.fileChecksums!["source/remote-work-policy.md"]).toMatch(/^[0-9a-f]{64}$/);
    // The recorded hash is the ACTUAL file's hash, not a placeholder.
    const actualHash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(layout.assetsDir, "knowledge", assetId, version, "manifest.json")))
      .digest("hex");
    expect(record.fileChecksums!["manifest.json"]).toBe(actualHash);
    expect(record.checksumVerification).toBeNull();
  });

  it("does not modify the original fixture file", async () => {
    const before = fs.readFileSync(path.join(FIXTURES_DIR, "valid-bundle.zip"));
    await run("valid-bundle.zip");
    const after = fs.readFileSync(path.join(FIXTURES_DIR, "valid-bundle.zip"));
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it("D-060: records assetVersionId as null for a legacy Bundle that predates the field", async () => {
    // valid-bundle.zip is a REAL Bundle produced before D-060 — its
    // included_assets[] has no asset_version_id key at all. The install
    // must not fabricate one (and must not fall back to asset_id).
    const { result } = await run("valid-bundle.zip");
    expect(result.outcome).toBe("SUCCESS");

    const assetId = result.installPlan[0].asset_id!;
    const version = result.installPlan[0].version!;
    const store = new InstalledAssetsStore(layout.stateDir);
    const record = store.find("knowledge", assetId, version);
    expect(record).toBeDefined();
    expect(record?.assetVersionId).toBeNull();
  });
});

describe("importBundle — D-060 AssetVersion id fix (real post-fix Bundle)", () => {
  it("records the AssetVersion id from a Bundle built after the fix, distinct from the Asset id", async () => {
    // valid-bundle-with-version-id.zip is a REAL Bundle built via
    // distribution_service.bundler AFTER the D-060 fix (see generate.py) —
    // its included_assets[] carries asset_version_id, deliberately
    // different from asset_id for every non-STANDARD_LOCAL_COPY item.
    const { result } = await run("valid-bundle-with-version-id.zip");
    expect(result.outcome).toBe("SUCCESS");

    const knowledgeItem = result.installPlan.find((i) => i.asset_type === "knowledge")!;
    expect(knowledgeItem.asset_version_id).toBeTruthy();
    expect(knowledgeItem.asset_version_id).not.toBe(knowledgeItem.asset_id);

    const store = new InstalledAssetsStore(layout.stateDir);
    const record = store.find("knowledge", knowledgeItem.asset_id!, knowledgeItem.version!);
    expect(record).toBeDefined();
    expect(record?.assetVersionId).toBe(knowledgeItem.asset_version_id);
    expect(record?.assetVersionId).not.toBe(record?.assetId);
  });
});

// ---------------------------------------------------------------------------
// D-096: MCP 서버 소스 코드 반출
// ---------------------------------------------------------------------------
// 실행 코드 검사는 압축을 풀기 전에 돌고, 그 예외는 Bundle 자신의 manifest 를
// 읽어야 판단할 수 있다. 그래서 순수 함수만 보지 않고 실제 ZIP 을
// `importBundle` 에 먹여, EXECUTABLE_POLICY 단계가 어떤 판정을 냈는지 본다.
// (그 뒤 단계에서 실패하는 것은 상관없다 — 여기서 보려는 것은 그 단계다.)

const MCP_ASSET_ID = "11111111-2222-3333-4444-555555555555";

function bundleManifestWith(includedAssets: unknown[]): string {
  return YAML.stringify({
    bundle_id: "b-test",
    created_at: new Date().toISOString(),
    requested_by: null,
    target_site_id: null,
    root_type: "mcp_server",
    root_id: MCP_ASSET_ID,
    included_assets: includedAssets,
    runtime_requirements: { os: "Windows 10/11 x64", python: ">=3.11", model_aliases: [] },
    install_order: [],
    forbidden_or_suspended_versions_present: false,
    total_installed_size_bytes: 0,
  });
}

function writeZip(name: string, files: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [arcname, content] of Object.entries(files)) {
    zip.addFile(arcname, Buffer.from(content, "utf-8"));
  }
  const dest = path.join(tmpRoot, name);
  zip.writeZip(dest);
  return dest;
}

async function executablePolicyCheckFor(zipPath: string) {
  const result = await importBundle(zipPath, layout, () => {});
  return result.checks.find((c) => c.id === "EXECUTABLE_POLICY");
}

describe("importBundle — D-096 MCP 서버 소스", () => {
  const mcpItem = {
    asset_id: MCP_ASSET_ID,
    asset_version_id: "v-1",
    asset_type: "mcp_server",
    role: "root",
    name: "예제 서버",
    version: "1.0.0",
    required: true,
    status: "OK",
    size_bytes: 10,
  };

  it("lets an mcp_server asset carry its own source", async () => {
    const zipPath = writeZip("mcp-source.zip", {
      "bundle-manifest.yaml": bundleManifestWith([mcpItem]),
      [`assets/mcp-servers/${MCP_ASSET_ID}/manifest.json`]: "{}",
      [`assets/mcp-servers/${MCP_ASSET_ID}/source/server.py`]: "print('hi')\n",
    });
    const check = await executablePolicyCheckFor(zipPath);
    expect(check?.status).toBe("PASS");
    expect(check?.message).toContain("MCP 서버 소스");
  });

  it("rejects the same source when the Bundle declares no mcp_server asset", async () => {
    // 같은 파일, 같은 경로 — manifest 의 신고만 다르다.
    const zipPath = writeZip("mcp-source-undeclared.zip", {
      "bundle-manifest.yaml": bundleManifestWith([{ ...mcpItem, asset_type: "knowledge" }]),
      [`assets/mcp-servers/${MCP_ASSET_ID}/source/server.py`]: "print('hi')\n",
    });
    expect((await executablePolicyCheckFor(zipPath))?.status).toBe("FAIL");
  });

  it("rejects source that sits outside the declared asset's own directory", async () => {
    const zipPath = writeZip("mcp-source-elsewhere.zip", {
      "bundle-manifest.yaml": bundleManifestWith([mcpItem]),
      "assets/knowledge/other/source/evil.py": "print('hi')\n",
    });
    expect((await executablePolicyCheckFor(zipPath))?.status).toBe("FAIL");
  });

  it("rejects an unreadable bundle manifest rather than falling open", async () => {
    const zipPath = writeZip("mcp-source-bad-manifest.zip", {
      "bundle-manifest.yaml": ":\n  not: [valid",
      [`assets/mcp-servers/${MCP_ASSET_ID}/source/server.py`]: "print('hi')\n",
    });
    expect((await executablePolicyCheckFor(zipPath))?.status).toBe("FAIL");
  });

  it("still rejects a compiled or shell file inside the allowed directory", async () => {
    for (const [i, name] of ["x.pyc", "run.bat", "run.sh"].entries()) {
      const zipPath = writeZip(`mcp-source-bad-${i}.zip`, {
        "bundle-manifest.yaml": bundleManifestWith([mcpItem]),
        [`assets/mcp-servers/${MCP_ASSET_ID}/source/${name}`]: "x",
      });
      expect((await executablePolicyCheckFor(zipPath))?.status).toBe("FAIL");
    }
  });
});

describe("ASSET_TYPE_FOLDER", () => {
  it("keeps mcp_server on its own folder, matching the bundler (D-096)", () => {
    // 이 맵은 `services/distribution-service/.../bundler.py` 의
    // `_ASSET_TYPE_FOLDER` 를 손으로 맞춘 사본이다(양쪽 주석 참고). 갈라지면
    // MCP 서버 코드가 Bundle 에서는 한 폴더에, 여기서는 다른 폴더에 있게 되어
    // 설치는 되는데 파일을 못 찾는 형태로 조용히 깨진다. 같은 내용을 pin 하는
    // Python 쪽 테스트: tests/unit/distribution_service/test_bundler.py
    // ::test_mcp_server_assets_get_their_own_directory
    expect(ASSET_TYPE_FOLDER.mcp_server).toBe("mcp-servers");
    expect(Object.keys(ASSET_TYPE_FOLDER).sort()).toEqual([
      "agent",
      "knowledge",
      "mcp_server",
      "mcp_tool",
      "prompt",
      "service",
    ]);
  });
});

describe("importBundle — D-096 설치 후 MCP 서버 활성화", () => {
  // 활성화가 설치 파이프라인 안에서 실제로 불리는지, 그리고 실패했을 때
  // 설치를 되돌리지 않는지 — 순수 함수 테스트로는 둘 다 증명되지 않는다.
  it("does not activate anything for a Bundle with no mcp_server asset", async () => {
    const calls: unknown[] = [];
    const result = await importBundle(
      path.join(FIXTURES_DIR, "valid-bundle.zip"),
      layout,
      () => {},
      async (t) => {
        calls.push(t);
        return { status: "PASS" as const, message: "x", serverAlias: "x" };
      },
    );
    expect(result.outcome).toBe("SUCCESS");
    expect(calls).toHaveLength(0);
    // 시도하지 않았으면 단계 자체가 없어야 한다 — "활성화: 통과"가 거짓으로
    // 남으면 없는 서버가 떠 있는 것처럼 보인다.
    expect(result.checks.find((c) => c.id === "MCP_ACTIVATION")).toBeUndefined();
  });

  const mcpItem = {
    asset_id: MCP_ASSET_ID,
    asset_version_id: "v-1",
    asset_type: "mcp_server",
    role: "root",
    name: "예제 서버",
    version: "1.0.0",
    required: true,
    status: "OK",
    size_bytes: 10,
  };

  /** mcp_server 자산 하나가 든, 실제로 설치까지 도달하는 Bundle 을 만든다.
   * 체크섬을 진짜로 계산해 넣는다 — 대충 만든 Bundle 은 CHECKSUM 에서 멈춰
   * 활성화 단계에 도달하지 못하고, 그러면 이 테스트는 아무것도 증명하지 않는다. */
  function writeInstallableMcpBundle(name: string): string {
    const files: Record<string, string> = {
      [`assets/mcp-servers/${MCP_ASSET_ID}/manifest.json`]: JSON.stringify({
        type: "mcp_server",
        server_alias: "hello-mcp",
        transport: { kind: "STDIO", interpreter: "python", entrypoint: "server.py" },
      }),
      [`assets/mcp-servers/${MCP_ASSET_ID}/source/server.py`]: "print('hi')\n",
    };
    const checksums = Object.entries(files)
      .map(([arcname, content]) => [
        crypto.createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex"),
        arcname,
      ])
      .sort((a, b) => (a[1] < b[1] ? -1 : 1))
      .map(([hash, arcname]) => `${hash}  ${arcname}`)
      .join("\n");
    return writeZip(name, {
      ...files,
      "bundle-manifest.yaml": bundleManifestWith([mcpItem]),
      "checksums.sha256": `${checksums}\n`,
    });
  }

  it("activates an installed mcp_server and reports it as a check", async () => {
    const seen: any[] = [];
    const result = await importBundle(
      writeInstallableMcpBundle("mcp-installable.zip"),
      layout,
      () => {},
      async (t) => {
        seen.push(t);
        return { status: "PASS" as const, message: "'hello-mcp' 활성화됨", serverAlias: "hello-mcp" };
      },
    );

    expect(result.outcome).toBe("SUCCESS");
    // 설치된 코드가 있는 곳을 넘겨야 한다 — 매니페스트가 아니라 source/ 다.
    expect(seen).toHaveLength(1);
    expect(seen[0].installPath).toBe(
      path.join(layout.assetsDir, "mcp-servers", MCP_ASSET_ID, "1.0.0", "source"),
    );
    expect(seen[0].manifest.server_alias).toBe("hello-mcp");
    expect(result.checks.find((c) => c.id === "MCP_ACTIVATION")?.status).toBe("PASS");
  });

  it("a refused activation is a WARN — the files stay installed", async () => {
    const result = await importBundle(
      writeInstallableMcpBundle("mcp-installable-refused.zip"),
      layout,
      () => {},
      async () => ({
        status: "WARN" as const,
        message: "허용 목록에 추가해 달라고 요청하세요",
        serverAlias: "hello-mcp",
      }),
    );

    expect(result.outcome).toBe("SUCCESS");
    expect(result.failedStage).toBeNull();
    const check = result.checks.find((c) => c.id === "MCP_ACTIVATION");
    expect(check?.status).toBe("WARN");
    expect(check?.message).toContain("허용 목록");
    // 활성화가 거부됐다고 설치를 되돌리지 않는다.
    expect(
      fs.existsSync(
        path.join(layout.assetsDir, "mcp-servers", MCP_ASSET_ID, "1.0.0", "source", "server.py"),
      ),
    ).toBe(true);
  });

  it("works with no activator at all (does not pretend to have tried)", async () => {
    const { result } = await run("valid-bundle.zip");
    expect(result.outcome).toBe("SUCCESS");
    expect(result.checks.find((c) => c.id === "MCP_ACTIVATION")).toBeUndefined();
  });
});
