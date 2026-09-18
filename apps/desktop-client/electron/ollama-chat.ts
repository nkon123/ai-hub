// Knowledge 자산이 없을 때 사용하는 기본 Ollama 일반 대화.
// fs/electron/node import가 없는 순수 HTTP 모듈이라 Main process와 브라우저
// 렌더러 검증 경로 양쪽에서 같은 모델 선택·응답 검증 규칙을 재사용한다.

import type { OllamaChatInput, OllamaChatResult } from "./types";

export const DEFAULT_CHAT_MODEL_ALIAS = "default-chat";

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

interface OllamaChatResponse {
  model?: string;
  message?: { content?: string };
}

/** Ollama가 모델을 메모리에 유지하는 시간.
 *
 * 기본값(5분)이면 대화가 잠깐 뜸한 사이 모델이 내려가고, 다음 질문의 첫
 * 글자가 모델 로딩 시간을 통째로 기다린다. agent-runtime 쪽도 같은 이유로
 * `AGENT_RUNTIME_OLLAMA_KEEP_ALIVE`(기본 30m)를 보낸다 — 이 값은 그 경로와
 * 맞춘 것이며, 두 프로세스가 같은 Ollama를 쓰므로 서로 다른 값을 보내면 뒤에
 * 부른 쪽이 이긴다. */
const KEEP_ALIVE = "30m";

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function isOllamaEmbeddingModel(model: string): boolean {
  return model.toLowerCase().includes("embed");
}

export function selectOllamaChatModel(models: readonly string[], preferredModel: string): string | null {
  const preferred = preferredModel.trim();
  if (preferred && models.includes(preferred)) return preferred;

  return models.find((model) => !isOllamaEmbeddingModel(model)) ?? null;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function chatWithOllama(
  baseUrl: string,
  preferredModel: string,
  input: OllamaChatInput,
  signal?: AbortSignal,
  /** 주면 스트리밍으로 받고 토큰이 올 때마다 부른다(화면에 바로 흘려보내기
   * 위한 것). 주지 않으면 예전처럼 완성된 답 하나를 돌려준다. */
  onDelta?: (delta: string) => void,
): Promise<OllamaChatResult> {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl);
  const tagsResponse = await fetch(`${normalizedBaseUrl}/api/tags`, { signal });
  if (!tagsResponse.ok) {
    throw new Error(`설치된 Ollama 모델을 확인하지 못했습니다: ${await readError(tagsResponse)}`);
  }

  const tags = (await tagsResponse.json()) as OllamaTagsResponse;
  const models = Array.isArray(tags.models)
    ? tags.models.map((model) => model.name).filter((name): name is string => typeof name === "string" && name.length > 0)
    : [];
  const model = selectOllamaChatModel(models, preferredModel);
  if (!model) {
    throw new Error("일반 대화에 사용할 Ollama 채팅 모델이 없습니다. 설정에서 채팅 모델 설치 상태를 확인하세요.");
  }

  const chatResponse = await fetch(`${normalizedBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      // `onDelta` 가 있으면 스트리밍한다. 없으면 예전처럼 한 번에 받는다 —
      // Agent 초안 생성(`agent-draft.ts`)처럼 화면에 흘려 보여줄 곳이 없는
      // 호출은 그대로 두기 위해서다.
      stream: Boolean(onDelta),
      keep_alive: KEEP_ALIVE,
      messages: [
        ...input.history.flatMap((turn) => [
          { role: "user", content: turn.question },
          { role: "assistant", content: turn.answer },
        ]),
        { role: "user", content: input.question },
      ],
    }),
  });
  if (!chatResponse.ok) {
    throw new Error(`Ollama가 답변을 생성하지 못했습니다: ${await readError(chatResponse)}`);
  }

  if (!onDelta) {
    const body = (await chatResponse.json()) as OllamaChatResponse;
    const answer = body.message?.content?.trim();
    if (!answer) {
      throw new Error("Ollama 응답에 답변 내용이 없습니다.");
    }
    return { answer, model: body.model?.trim() || model };
  }

  // --- 스트리밍 ------------------------------------------------------------
  //
  // 왜 필요했나(2026-09-18 실사용: "채팅 반응이 너무 느리다"): 이 경로는
  // `stream: false` 라 **답이 다 만들어질 때까지 화면에 아무것도 나오지
  // 않았다**. 로컬 모델이 수백 토큰을 만드는 동안 사용자는 빈 화면을 본다 —
  // 지식 검색을 켠 경로(agent-runtime)는 토큰을 흘려보내므로, 아무것도 안
  // 붙인 기본 대화가 오히려 더 느리게 느껴졌다.
  //
  // Ollama 의 스트리밍 응답은 NDJSON(줄 하나에 JSON 하나)이다. 줄이 chunk
  // 경계에서 잘릴 수 있으므로 버퍼에 모아 줄 단위로만 파싱한다.
  const reader = chatResponse.body?.getReader();
  if (!reader) {
    throw new Error("Ollama 응답을 읽지 못했습니다.");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let resolvedModel = model;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) continue;
        let parsed: OllamaChatResponse & { error?: string };
        try {
          parsed = JSON.parse(line);
        } catch {
          // 깨진 줄 하나 때문에 대화 전체를 실패시키지 않는다 — 이어지는
          // 줄이 정상이면 답변은 계속 쌓인다.
          continue;
        }
        if (typeof parsed.error === "string" && parsed.error) {
          throw new Error(`Ollama가 답변을 생성하지 못했습니다: ${parsed.error}`);
        }
        if (parsed.model) resolvedModel = parsed.model.trim() || resolvedModel;
        const delta = parsed.message?.content;
        if (delta) {
          answer += delta;
          onDelta(delta);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const trimmed = answer.trim();
  if (!trimmed) {
    throw new Error("Ollama 응답에 답변 내용이 없습니다.");
  }
  return { answer: trimmed, model: resolvedModel };
}
