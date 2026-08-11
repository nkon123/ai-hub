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
