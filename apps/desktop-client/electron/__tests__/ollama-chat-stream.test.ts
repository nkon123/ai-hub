import { describe, expect, it, vi } from "vitest";
import { chatWithOllama } from "../ollama-chat";

/**
 * 기본 대화(지식·도구를 아무것도 켜지 않은 턴)의 **스트리밍** 경로.
 *
 * 왜 생겼나(2026-09-18 실사용: "채팅 반응이 너무 느리다"): 이 경로는
 * agent-runtime 을 거치지 않아 SSE `answer.delta` 가 없고, `stream: false` 로
 * 받아서 **답이 다 만들어질 때까지 화면에 아무것도 나오지 않았다**. 로컬
 * 모델에서는 그 시간이 통째로 빈 화면이라, 아무것도 안 붙인 기본 대화가
 * 지식 검색을 켠 경로보다 오히려 느리게 느껴졌다.
 *
 * Ollama 의 스트리밍 응답은 NDJSON 이고 줄이 chunk 경계에서 잘린다 — 여기서
 * 고정하는 것은 "잘린 줄을 이어 붙여 파싱한다"와 "깨진 줄 하나가 대화 전체를
 * 실패시키지 않는다"이다.
 */

function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function tagsResponse(): Response {
  return new Response(JSON.stringify({ models: [{ name: "exaone3.5:7.8b" }] }), { status: 200 });
}

function line(content: string, done = false): string {
  return JSON.stringify({ model: "exaone3.5:7.8b", message: { content }, done }) + "\n";
}

describe("chatWithOllama — 스트리밍", () => {
  it("토큰이 오는 대로 콜백을 부르고, 합친 답을 돌려준다", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(tagsResponse())
      .mockResolvedValueOnce(
        streamingResponse([line("안녕"), line("하세"), line("요", true)]),
      ) as unknown as typeof fetch;

    const deltas: string[] = [];
    const result = await chatWithOllama(
      "http://127.0.0.1:11434",
      "default-chat",
      { question: "hi", history: [] },
      undefined,
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(["안녕", "하세", "요"]);
    expect(result.answer).toBe("안녕하세요");
    expect(result.model).toBe("exaone3.5:7.8b");
  });

  it("chunk 경계에서 잘린 줄을 이어 붙여 파싱한다", async () => {
    const whole = line("반갑") + line("습니다", true);
    const cut = Math.floor(whole.length / 3);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(tagsResponse())
      .mockResolvedValueOnce(
        streamingResponse([whole.slice(0, cut), whole.slice(cut, cut + 5), whole.slice(cut + 5)]),
      ) as unknown as typeof fetch;

    const deltas: string[] = [];
    const result = await chatWithOllama(
      "http://127.0.0.1:11434",
      "default-chat",
      { question: "hi", history: [] },
      undefined,
      (delta) => deltas.push(delta),
    );

    expect(result.answer).toBe("반갑습니다");
    expect(deltas.join("")).toBe("반갑습니다");
  });

  it("깨진 줄 하나 때문에 대화 전체를 실패시키지 않는다", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(tagsResponse())
      .mockResolvedValueOnce(
        streamingResponse([line("정상"), "{깨진 줄\n", line(" 계속", true)]),
      ) as unknown as typeof fetch;

    const result = await chatWithOllama(
      "http://127.0.0.1:11434",
      "default-chat",
      { question: "hi", history: [] },
      undefined,
      () => undefined,
    );

    expect(result.answer).toBe("정상 계속");
  });

  it("스트림 안의 error 필드는 그대로 실패로 올린다 — 빈 답으로 조용히 끝내지 않는다", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(tagsResponse())
      .mockResolvedValueOnce(
        streamingResponse([JSON.stringify({ error: "model runner has unexpectedly stopped" }) + "\n"]),
      ) as unknown as typeof fetch;

    await expect(
      chatWithOllama(
        "http://127.0.0.1:11434",
        "default-chat",
        { question: "hi", history: [] },
        undefined,
        () => undefined,
      ),
    ).rejects.toThrow("model runner has unexpectedly stopped");
  });

  it("토큰이 하나도 오지 않으면 실패로 끝낸다", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(tagsResponse())
      .mockResolvedValueOnce(streamingResponse([line("", true)])) as unknown as typeof fetch;

    await expect(
      chatWithOllama(
        "http://127.0.0.1:11434",
        "default-chat",
        { question: "hi", history: [] },
        undefined,
        () => undefined,
      ),
    ).rejects.toThrow("답변 내용이 없습니다");
  });

  it("스트리밍 요청에는 stream:true 와 keep_alive 가 실린다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tagsResponse())
      .mockResolvedValueOnce(streamingResponse([line("응", true)]));
    global.fetch = fetchMock as unknown as typeof fetch;

    await chatWithOllama(
      "http://127.0.0.1:11434",
      "default-chat",
      { question: "hi", history: [] },
      undefined,
      () => undefined,
    );

    const [, init] = fetchMock.mock.calls[1];
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.stream).toBe(true);
    expect(body.keep_alive).toBe("30m");
  });

  it("콜백을 주지 않으면 예전처럼 한 번에 받는다(Agent 초안 등 다른 호출자 보호)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tagsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ model: "exaone3.5:7.8b", message: { content: " 한 번에 " } }), {
          status: 200,
        }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await chatWithOllama("http://127.0.0.1:11434", "default-chat", {
      question: "hi",
      history: [],
    });

    expect(result.answer).toBe("한 번에");
    const [, init] = fetchMock.mock.calls[1];
    expect(JSON.parse(String((init as RequestInit).body)).stream).toBe(false);
  });
});
