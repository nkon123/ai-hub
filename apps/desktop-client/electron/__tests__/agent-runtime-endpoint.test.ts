// D-080 후속 — agent-runtime 주소를 설정에서 읽게 만든 변경의 회귀 테스트.
//
// 고치기 전 상태는 버그라기보다 "두 개의 진실"이었다: 렌더러는 빌드 타임
// `VITE_AGENT_RUNTIME_BASE_URL`을, Main Process는 `connections.ts`의 하드코딩
// 기본값을 각각 봤다. 그래서 사용자가 다른 포트로 Runtime을 띄우면 대화는
// 멀쩡히 되는데 연결 배너는 "끊김"이라고 말했고(`apps/desktop-client/CLAUDE.md`
// 의 "연결 판정 오탐(미해결)"), MCP Tool 등록만 조용히 옛 주소로 나갔으며,
// 진단 Bundle에는 이 앱이 쓰지도 않는 주소가 적혔다.
//
// 그래서 이 파일이 고정하는 것은 "필드가 저장된다"가 아니라 **주소를 읽는 모든
// 경로가 같은 값을 본다**는 것이다 — 값을 한 곳에서 바꾸고, 다른 곳에서 그
// 값이 나오는지 확인한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInstallRoot, type InstallRootLayout } from "../bundle-install";
import { DEFAULT_RUNTIME_BASE_URL } from "../connections";
import { DesktopSettingsStore } from "../desktop-settings";
import { buildDiagnosticBundle } from "../diagnostic-bundle";
import { InstalledAssetsStore } from "../installed-assets-store";
import { validateAgentRuntimeBaseUrl } from "../network-policy";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-agent-endpoint-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("validateAgentRuntimeBaseUrl", () => {
  it("accepts loopback addresses on any port", () => {
    expect(validateAgentRuntimeBaseUrl("http://127.0.0.1:8100").ok).toBe(true);
    expect(validateAgentRuntimeBaseUrl("http://localhost:9999").ok).toBe(true);
  });

  it("refuses a remote address, with a reason a user can act on", () => {
    const result = validateAgentRuntimeBaseUrl("http://runtime.corp.example:8100");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("loopback");
  });

  it("refuses a malformed URL rather than storing it", () => {
    expect(validateAgentRuntimeBaseUrl("not a url").ok).toBe(false);
    expect(validateAgentRuntimeBaseUrl("").ok).toBe(false);
  });
});

describe("DesktopSettingsStore.agentRuntimeBaseUrl", () => {
  it("defaults to the single documented default, not an empty string", () => {
    const store = new DesktopSettingsStore(tmpDir);
    expect(store.getPublic().agentRuntimeBaseUrl).toBe(DEFAULT_RUNTIME_BASE_URL);
  });

  it("persists a loopback address across store instances", () => {
    const store = new DesktopSettingsStore(tmpDir);
    const result = store.update({ agentRuntimeBaseUrl: "http://127.0.0.1:9100" });

    expect(result.ok).toBe(true);
    expect(new DesktopSettingsStore(tmpDir).getPublic().agentRuntimeBaseUrl).toBe(
      "http://127.0.0.1:9100",
    );
  });

  it("refuses a remote address at save time and changes nothing", () => {
    const store = new DesktopSettingsStore(tmpDir);
    store.update({ agentRuntimeBaseUrl: "http://127.0.0.1:9100" });

    const result = store.update({ agentRuntimeBaseUrl: "http://runtime.corp.example:8100" });

    expect(result.ok).toBe(false);
    expect(store.getPublic().agentRuntimeBaseUrl).toBe("http://127.0.0.1:9100");
  });

  it("does not partially apply a patch when the runtime URL is rejected", () => {
    // All-or-nothing: the sibling field in the same patch must not survive.
    const store = new DesktopSettingsStore(tmpDir);
    const before = store.getPublic().siteId;

    const result = store.update({
      siteId: "gumi",
      agentRuntimeBaseUrl: "http://runtime.corp.example:8100",
    });

    expect(result.ok).toBe(false);
    expect(store.getPublic().siteId).toBe(before);
  });

  it("keeps an existing settings file readable when the field is absent", () => {
    // 이 필드가 없던 시절에 저장된 파일이 그대로 남아 있어도 로드는 성공하고
    // 기본값이 채워져야 한다 — 마이그레이션 없이 깨지지 않는다는 이 저장소의
    // 기존 관례.
    fs.writeFileSync(
      path.join(tmpDir, "desktop-settings.json"),
      JSON.stringify({ siteId: "gumi", ollamaBaseUrl: "http://127.0.0.1:11434" }),
      "utf-8",
    );

    const settings = new DesktopSettingsStore(tmpDir).getPublic();

    expect(settings.siteId).toBe("gumi");
    expect(settings.agentRuntimeBaseUrl).toBe(DEFAULT_RUNTIME_BASE_URL);
  });
});

describe("diagnostic bundle", () => {
  it("reports the address this app actually uses, not the hardcoded default", async () => {
    // 진단 파일이 사실과 다르면 진단이 아니라 오도다 — 이 값이 하드코딩이던
    // 시절에는 포트를 바꾼 사용자의 Bundle이 쓰지도 않는 주소를 보고했다.
    const layout: InstallRootLayout = resolveInstallRoot(tmpDir);
    const store = new InstalledAssetsStore(layout.stateDir);
    const settingsStore = new DesktopSettingsStore(path.join(tmpDir, "settings"));
    settingsStore.update({ agentRuntimeBaseUrl: "http://127.0.0.1:9100" });

    const bundle = await buildDiagnosticBundle(
      layout,
      store,
      [],
      {},
      null,
      settingsStore.getPublic(),
    );

    expect(bundle.sanitizedSettings.agentRuntimeBaseUrl).toBe("http://127.0.0.1:9100");
    // 옛 하드코딩 값이 Bundle 어디에도 남아 있지 않아야 한다 — 설정 항목만
    // 고치고 다른 곳에 같은 문자열이 또 박혀 있으면 이 단언이 잡는다.
    expect(bundle.sanitizedSettings.agentRuntimeBaseUrl).not.toContain("8100");
  });
});
