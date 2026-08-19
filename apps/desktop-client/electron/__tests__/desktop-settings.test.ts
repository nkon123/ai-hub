// D01/D10 공용 설정 저장소. 핵심 검증 대상: (1) loopback 규칙이 저장 시점에도
// 다시 강제된다는 것, (2) 부분 업데이트가 all-or-nothing이라는 것, (3) 최대
// 동시 Run 수는 편집 가능한 필드가 아니라 항상 고정된 구조로 노출된다는 것.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_TOOL_TIMEOUT_MINUTES,
  DesktopSettingsStore,
  MAX_CONCURRENT_RUNS_VALUE,
  MAX_LOCAL_TOOL_TIMEOUT_MINUTES,
  MIN_LOCAL_TOOL_TIMEOUT_MINUTES,
} from "../desktop-settings";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-desktop-settings-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("DesktopSettingsStore", () => {
  it("starts with documented defaults, not an empty/unusable state", () => {
    const store = new DesktopSettingsStore(tmpDir);
    const settings = store.getPublic();
    expect(settings.clientDisplayName).toBeNull();
    expect(settings.siteId).toBeNull();
    expect(settings.ollamaBaseUrl).toBe("http://127.0.0.1:11434");
    expect(settings.ollamaAllowNonLoopback).toBe(false);
    expect(settings.chatModelAlias).toBe("default-chat");
    expect(settings.mcpServerAlias).toBe("oracle-connector");
    expect(settings.mcpServerUrl).toBe("http://127.0.0.1:8500");
    expect(settings.searchRuntimeBaseUrl).toBe("http://127.0.0.1:8300");
    expect(settings.setupCompletedAt).toBeNull();
    expect(settings.localToolTimeoutMinutes).toBe(DEFAULT_LOCAL_TOOL_TIMEOUT_MINUTES);
  });

  describe("실사용 제보(2026-08-19) — 대화형 로컬 Tool 실행 타임아웃", () => {
    it(`defaults to ${DEFAULT_LOCAL_TOOL_TIMEOUT_MINUTES} minutes`, () => {
      const store = new DesktopSettingsStore(tmpDir);
      expect(store.getPublic().localToolTimeoutMinutes).toBe(DEFAULT_LOCAL_TOOL_TIMEOUT_MINUTES);
    });

    it("normalizes a legacy settings file written before this field existed to the default", () => {
      fs.writeFileSync(
        path.join(tmpDir, "desktop-settings.json"),
        JSON.stringify({ chatModelAlias: "my-chat" }),
        "utf-8",
      );
      const settings = new DesktopSettingsStore(tmpDir).getPublic();
      expect(settings.localToolTimeoutMinutes).toBe(DEFAULT_LOCAL_TOOL_TIMEOUT_MINUTES);
    });

    it("persists a valid value within bounds", () => {
      const store = new DesktopSettingsStore(tmpDir);
      const result = store.update({ localToolTimeoutMinutes: 15 });
      expect(result.ok).toBe(true);
      expect(result.settings.localToolTimeoutMinutes).toBe(15);
      expect(new DesktopSettingsStore(tmpDir).getPublic().localToolTimeoutMinutes).toBe(15);
    });

    it(`rejects a value below the minimum (${MIN_LOCAL_TOOL_TIMEOUT_MINUTES})`, () => {
      const store = new DesktopSettingsStore(tmpDir);
      const result = store.update({ localToolTimeoutMinutes: MIN_LOCAL_TOOL_TIMEOUT_MINUTES - 1 });
      expect(result.ok).toBe(false);
      expect(store.getPublic().localToolTimeoutMinutes).toBe(DEFAULT_LOCAL_TOOL_TIMEOUT_MINUTES);
    });

    it(`rejects a value above the maximum (${MAX_LOCAL_TOOL_TIMEOUT_MINUTES})`, () => {
      const store = new DesktopSettingsStore(tmpDir);
      const result = store.update({ localToolTimeoutMinutes: MAX_LOCAL_TOOL_TIMEOUT_MINUTES + 1 });
      expect(result.ok).toBe(false);
      expect(store.getPublic().localToolTimeoutMinutes).toBe(DEFAULT_LOCAL_TOOL_TIMEOUT_MINUTES);
    });

    it("rejects a non-finite value (NaN) without saving", () => {
      const store = new DesktopSettingsStore(tmpDir);
      const result = store.update({ localToolTimeoutMinutes: Number.NaN });
      expect(result.ok).toBe(false);
      expect(store.getPublic().localToolTimeoutMinutes).toBe(DEFAULT_LOCAL_TOOL_TIMEOUT_MINUTES);
    });

    it("accepts the boundary values themselves", () => {
      const store = new DesktopSettingsStore(tmpDir);
      expect(store.update({ localToolTimeoutMinutes: MIN_LOCAL_TOOL_TIMEOUT_MINUTES }).ok).toBe(true);
      expect(store.update({ localToolTimeoutMinutes: MAX_LOCAL_TOOL_TIMEOUT_MINUTES }).ok).toBe(true);
    });
  });

  it("D-079: rejects a non-loopback search-runtime URL — no override exists for this field", () => {
    const store = new DesktopSettingsStore(tmpDir);
    const result = store.update({ searchRuntimeBaseUrl: "http://10.0.0.5:8300" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("loopback");
    expect(store.getPublic().searchRuntimeBaseUrl).toBe("http://127.0.0.1:8300");
  });

  it("D-079: persists a valid loopback search-runtime URL", () => {
    const store = new DesktopSettingsStore(tmpDir);
    const result = store.update({ searchRuntimeBaseUrl: "http://127.0.0.1:8399" });
    expect(result.ok).toBe(true);
    expect(result.settings.searchRuntimeBaseUrl).toBe("http://127.0.0.1:8399");
  });

  it("never exposes 최대 동시 Run 수 as a plain editable number — always the fixed/unenforced structure", () => {
    const store = new DesktopSettingsStore(tmpDir);
    expect(store.getPublic().maxConcurrentRuns).toEqual({
      value: MAX_CONCURRENT_RUNS_VALUE,
      enforced: false,
      reason: expect.stringContaining("open-decisions.md D-074"),
    });
  });

  it("persists client info across instances", () => {
    new DesktopSettingsStore(tmpDir).update({ clientDisplayName: "본사 1층 안내", siteId: "headquarters" });
    const reopened = new DesktopSettingsStore(tmpDir).getPublic();
    expect(reopened.clientDisplayName).toBe("본사 1층 안내");
    expect(reopened.siteId).toBe("headquarters");
  });

  it("rejects a non-loopback Ollama URL by default and saves nothing", () => {
    const store = new DesktopSettingsStore(tmpDir);
    const result = store.update({ ollamaBaseUrl: "http://10.0.0.5:11434" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("loopback");
    // Nothing was saved — the default is still in place.
    expect(store.getPublic().ollamaBaseUrl).toBe("http://127.0.0.1:11434");
  });

  it("accepts a non-loopback Ollama URL once the override is explicitly set in the same call", () => {
    const store = new DesktopSettingsStore(tmpDir);
    const result = store.update({ ollamaBaseUrl: "http://10.0.0.5:11434", ollamaAllowNonLoopback: true });
    expect(result.ok).toBe(true);
    expect(result.settings.ollamaBaseUrl).toBe("http://10.0.0.5:11434");
    expect(result.settings.ollamaAllowNonLoopback).toBe(true);
  });

  it("re-validates the existing stored URL against a newly-flipped override flag alone", () => {
    const store = new DesktopSettingsStore(tmpDir);
    store.update({ ollamaBaseUrl: "http://10.0.0.5:11434", ollamaAllowNonLoopback: true });
    // Flipping the override back off without changing the URL must fail —
    // the stored URL is no longer valid under the new (stricter) flag.
    const result = store.update({ ollamaAllowNonLoopback: false });
    expect(result.ok).toBe(false);
    expect(store.getPublic().ollamaBaseUrl).toBe("http://10.0.0.5:11434"); // unchanged
  });

  it("is all-or-nothing: an invalid field in a multi-field patch saves none of the fields", () => {
    const store = new DesktopSettingsStore(tmpDir);
    const result = store.update({ clientDisplayName: "구미 지점", mcpServerUrl: "not-a-url" });
    expect(result.ok).toBe(false);
    expect(store.getPublic().clientDisplayName).toBeNull();
  });

  it("loads an existing settings file that still has the removed embeddingModelAlias key", () => {
    // 2026-08-14에 `embeddingModelAlias`(아무 데도 전달되지 않던 자유 입력)를
    // 제거했다. 이미 그 키가 저장된 사용자 파일이 존재하므로, 그것을 읽을 때
    // 조용히 무시될 뿐 오류나 기본값 초기화로 이어지면 안 된다.
    fs.writeFileSync(
      path.join(tmpDir, "desktop-settings.json"),
      JSON.stringify({ chatModelAlias: "my-chat", embeddingModelAlias: "무시되어야 함", siteId: "SITE-1" }),
      "utf-8",
    );

    const settings = new DesktopSettingsStore(tmpDir).getPublic();

    expect(settings.chatModelAlias).toBe("my-chat");
    expect(settings.siteId).toBe("SITE-1");
    expect("embeddingModelAlias" in settings).toBe(false);
  });

  it("rejects blank model aliases", () => {
    const store = new DesktopSettingsStore(tmpDir);
    expect(store.update({ chatModelAlias: "   " }).ok).toBe(false);
    expect(store.update({ mcpServerAlias: "  " }).ok).toBe(false);
  });

  it("markSetupCompleted records a timestamp and isSetupCompleted reflects it", () => {
    const store = new DesktopSettingsStore(tmpDir);
    expect(store.isSetupCompleted()).toBe(false);
    const settings = store.markSetupCompleted();
    expect(settings.setupCompletedAt).not.toBeNull();
    expect(store.isSetupCompleted()).toBe(true);
  });

  it("treats a corrupted settings file as defaults rather than throwing", () => {
    const store = new DesktopSettingsStore(tmpDir);
    store.update({ clientDisplayName: "본사" });
    fs.writeFileSync(path.join(tmpDir, "desktop-settings.json"), "{not valid json", "utf-8");
    expect(() => store.getPublic()).not.toThrow();
    expect(store.getPublic().clientDisplayName).toBeNull();
  });
});
