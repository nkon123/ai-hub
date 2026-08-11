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
      stream: false,
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

  const body = (await chatResponse.json()) as OllamaChatResponse;
  const answer = body.message?.content?.trim();
  if (!answer) {
    throw new Error("Ollama 응답에 답변 내용이 없습니다.");
  }
  return { answer, model: body.model?.trim() || model };
}
