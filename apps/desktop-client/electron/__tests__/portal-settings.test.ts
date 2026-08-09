// 자산 스토어 — Portal 연결 설정 저장소. 핵심 검증 대상: `getPublic()`이
// 절대 Token 원문을 반환하지 않는다는 것(diagnostic-bundle.test.ts의 신규
// 테스트와 함께 이 보장을 이중으로 확인한다).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PortalSettingsStore } from "../portal-settings";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-portal-settings-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PortalSettingsStore", () => {
  it("starts unconfigured", () => {
    const store = new PortalSettingsStore(tmpDir);
    expect(store.getPublic()).toEqual({ baseUrl: null, tokenConfigured: false, tokenUpdatedAt: null });
    expect(store.getToken()).toBeNull();
    expect(store.getBaseUrl()).toBeNull();
  });

  it("persists the base URL across instances", () => {
    new PortalSettingsStore(tmpDir).setBaseUrl("http://127.0.0.1:8000");
    const reopened = new PortalSettingsStore(tmpDir);
    expect(reopened.getBaseUrl()).toBe("http://127.0.0.1:8000");
    expect(reopened.getPublic().baseUrl).toBe("http://127.0.0.1:8000");
  });

  it("never returns the raw token from getPublic() — only tokenConfigured + tokenUpdatedAt", () => {
    const store = new PortalSettingsStore(tmpDir);
    const RAW_TOKEN = "dev-user-token-super-secret";
    const publicSettings = store.setToken(RAW_TOKEN);

    expect(publicSettings).not.toHaveProperty("token");
    expect(JSON.stringify(publicSettings)).not.toContain(RAW_TOKEN);
    expect(publicSettings.tokenConfigured).toBe(true);
    expect(publicSettings.tokenUpdatedAt).not.toBeNull();

    // Only the internal accessor (never IPC/renderer-facing) can see the value.
    expect(store.getToken()).toBe(RAW_TOKEN);
  });

  it("persists the token to disk across instances but getPublic() still never exposes it", () => {
    const RAW_TOKEN = "dev-admin-token-also-secret";
    new PortalSettingsStore(tmpDir).setToken(RAW_TOKEN);

    const reopened = new PortalSettingsStore(tmpDir);
    expect(reopened.getToken()).toBe(RAW_TOKEN);
    expect(reopened.getPublic().tokenConfigured).toBe(true);
    expect(JSON.stringify(reopened.getPublic())).not.toContain(RAW_TOKEN);
  });

  it("clearToken() removes the token but keeps the base URL", () => {
    const store = new PortalSettingsStore(tmpDir);
    store.setBaseUrl("http://127.0.0.1:8000");
    store.setToken("dev-user-token");

    const cleared = store.clearToken();
    expect(cleared.tokenConfigured).toBe(false);
    expect(cleared.tokenUpdatedAt).toBeNull();
    expect(cleared.baseUrl).toBe("http://127.0.0.1:8000");
    expect(store.getToken()).toBeNull();
  });

  it("treats a corrupted settings file as unconfigured rather than throwing", () => {
    const store = new PortalSettingsStore(tmpDir);
    store.setBaseUrl("http://127.0.0.1:8000");
    const filePath = path.join(tmpDir, "portal-settings.json");
    fs.writeFileSync(filePath, "{not valid json", "utf-8");

    expect(() => store.getPublic()).not.toThrow();
    expect(store.getPublic()).toEqual({ baseUrl: null, tokenConfigured: false, tokenUpdatedAt: null });
  });

  it("treats blank input as clearing the field", () => {
    const store = new PortalSettingsStore(tmpDir);
    store.setBaseUrl("   ");
    expect(store.getBaseUrl()).toBeNull();
  });
});
