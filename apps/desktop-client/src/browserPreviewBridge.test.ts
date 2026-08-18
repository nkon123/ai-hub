import { afterEach, describe, expect, it } from "vitest";
import {
  applyBrowserPreviewSettingsPatch,
  createDefaultBrowserPreviewSettings,
  getBrowserSettingsBridge,
} from "./browserPreviewBridge";

function installPreviewWindow(): void {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktop: undefined,
      location: { search: "?desktop-preview=1" },
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    },
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("browser preview settings", () => {
  it("uses safe local defaults", () => {
    const settings = createDefaultBrowserPreviewSettings();
    expect(settings.ollamaBaseUrl).toBe("http://127.0.0.1:11434");
    expect(settings.ollamaAllowNonLoopback).toBe(false);
    expect(settings.chatModelAlias).toBe("default-chat");
  });

  it("stores the selected installed chat model name", () => {
    const current = createDefaultBrowserPreviewSettings();
    const result = applyBrowserPreviewSettingsPatch(current, { chatModelAlias: "qwen3:8b" });
    expect(result.ok).toBe(true);
    expect(result.settings.chatModelAlias).toBe("qwen3:8b");
    expect(result.settings.updatedAt).not.toBeNull();
  });

  it("rejects a remote Ollama URL unless explicitly allowed", () => {
    const current = createDefaultBrowserPreviewSettings();
    const result = applyBrowserPreviewSettingsPatch(current, { ollamaBaseUrl: "http://ollama.internal:11434" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("loopback");
    expect(result.settings).toEqual(current);
  });

  it("applies no fields when one field in a patch is invalid", () => {
    const current = createDefaultBrowserPreviewSettings();
    const result = applyBrowserPreviewSettingsPatch(current, {
      clientDisplayName: "개발 PC",
      chatModelAlias: "   ",
    });
    expect(result.ok).toBe(false);
    expect(result.settings).toEqual(current);
    expect(result.settings.clientDisplayName).toBeNull();
  });

  it("persists browser-preview conversations for the chat list", async () => {
    installPreviewWindow();
    const bridge = getBrowserSettingsBridge();
    expect(bridge).not.toBeNull();

    const created = await bridge!.createConversation("", "기본 Ollama 대화");
    await bridge!.appendConversationTurn(created.id, {
      question: "월간 보고서 초안을 만들어줘",
      answer: "초안을 작성했습니다.",
      status: "succeeded",
      citationCount: 0,
    });

    const conversations = await bridge!.listConversations();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      title: "월간 보고서 초안을 만들어줘",
      knowledgeLabel: "기본 Ollama 대화",
      turnCount: 1,
    });
    expect((await bridge!.getConversation(created.id))?.turns[0].answer).toBe("초안을 작성했습니다.");
  });
});

// 이 세 메서드는 예전에 `BrowserSettingsBridge`가 `Pick<DesktopBridge, ...>`
// 허용목록이었을 때 빠져 있던 것들이다 — 화면이 `bridge.reconcileKnowledgeActivations()`를
// 가드 없이 호출해 `TypeError: ... is not a function`으로 채팅 화면 전체가
// 무너진 실제 장애(2026-08-13)의 원인. 지금은 `BrowserSettingsBridge`가
// `DesktopBridge` 그 자체이므로 이 메서드들이 존재하지 않으면 `pnpm typecheck`가
// 실패한다 — 아래 테스트는 "존재"뿐 아니라 "정직하게 실패를 돌려주고 절대
// 성공을 지어내지 않는다"는 런타임 동작까지 검증한다.
describe("browser preview D-079 Knowledge 활성화 stubs (Desktop 런타임 필요)", () => {
  it("activateInstalledKnowledge refuses honestly instead of throwing or faking success", async () => {
    installPreviewWindow();
    const bridge = getBrowserSettingsBridge();
    const result = await bridge!.activateInstalledKnowledge("knowledge", "asset-1", "1.0.0");
    expect(result.ok).toBe(false);
    expect(result.activation).toBeNull();
    expect(result.error).toContain("Desktop 앱에서 실행하세요");
  });

  it("deactivateInstalledKnowledge refuses honestly instead of throwing or faking success", async () => {
    installPreviewWindow();
    const bridge = getBrowserSettingsBridge();
    const result = await bridge!.deactivateInstalledKnowledge("knowledge", "asset-1", "1.0.0");
    expect(result.ok).toBe(false);
    expect(result.remoteWarning).toBeNull();
    expect(result.error).toContain("Desktop 앱에서 실행하세요");
  });

  it("reconcileKnowledgeActivations reports checked:false instead of throwing or faking a clean reconcile", async () => {
    installPreviewWindow();
    const bridge = getBrowserSettingsBridge();
    const result = await bridge!.reconcileKnowledgeActivations();
    expect(result.checked).toBe(false);
    expect(result.downgradedCount).toBe(0);
    expect(result.error).toContain("Desktop 앱에서 실행하세요");
  });

  it("listInstalledAssets returns an honest empty list (browser preview has no filesystem)", async () => {
    installPreviewWindow();
    const bridge = getBrowserSettingsBridge();
    expect(await bridge!.listInstalledAssets()).toEqual([]);
  });
});
