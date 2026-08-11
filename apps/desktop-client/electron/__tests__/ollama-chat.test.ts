import { afterEach, describe, expect, it, vi } from "vitest";
import { chatWithOllama, isOllamaEmbeddingModel, selectOllamaChatModel } from "../ollama-chat";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("selectOllamaChatModel", () => {
  it("identifies embedding models so settings does not offer them for chat", () => {
    expect(isOllamaEmbeddingModel("qwen3-embedding:0.6b")).toBe(true);
    expect(isOllamaEmbeddingModel("wcamaralopes/bonsai-27b:latest")).toBe(false);
  });

  it("uses the configured chat model when its name matches an installed model", () => {
    expect(selectOllamaChatModel(["exaone3.5:7.8b", "qwen2.5:7b"], "qwen2.5:7b")).toBe("qwen2.5:7b");
  });

  it("falls back to the first non-embedding model for the default alias", () => {
    expect(selectOllamaChatModel(["qwen3-embedding:0.6b", "exaone3.5:7.8b"], "default-chat")).toBe(
      "exaone3.5:7.8b",
    );
  });

  it("does not use an embedding-only model for chat", () => {
    expect(selectOllamaChatModel(["qwen3-embedding:0.6b"], "default-chat")).toBeNull();
  });
});

describe("chatWithOllama", () => {
  it("sends prior turns and the new question to Ollama and returns the actual model", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [{ name: "exaone3.5:7.8b" }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ model: "exaone3.5:7.8b", message: { content: " 반갑습니다. " } }), {
          status: 200,
        }),
      ) as unknown as typeof fetch;

    const result = await chatWithOllama("http://127.0.0.1:11434/", "default-chat", {
      question: "오늘 어때?",
      history: [{ question: "안녕", answer: "안녕하세요" }],
    });

    expect(result).toEqual({ answer: "반갑습니다.", model: "exaone3.5:7.8b" });
    expect(global.fetch).toHaveBeenNthCalledWith(1, "http://127.0.0.1:11434/api/tags", {
      signal: undefined,
    });
    const [, chatInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(JSON.parse(String(chatInit?.body))).toMatchObject({
      model: "exaone3.5:7.8b",
      stream: false,
      messages: [
        { role: "user", content: "안녕" },
        { role: "assistant", content: "안녕하세요" },
        { role: "user", content: "오늘 어때?" },
      ],
    });
  });

  it("reports an honest error when no chat model is installed", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ models: [{ name: "qwen3-embedding:0.6b" }] }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      chatWithOllama("http://127.0.0.1:11434", "default-chat", { question: "안녕", history: [] }),
    ).rejects.toThrow("채팅 모델이 없습니다");
  });
});
