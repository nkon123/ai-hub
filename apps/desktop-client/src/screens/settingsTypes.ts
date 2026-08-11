import type { OllamaModelsResult } from "../../electron/types";
import { isOllamaEmbeddingModel } from "../../electron/ollama-chat";

export function getInstalledChatModels(result: OllamaModelsResult | null): string[] {
  return result?.ok === true ? result.models.filter((model) => !isOllamaEmbeddingModel(model)) : [];
}

export function getChatModelSelectionIssue(
  loading: boolean,
  result: OllamaModelsResult | null,
  selectedModel: string,
): string | null {
  if (loading || result === null) return "설치된 Ollama 모델을 확인하는 중입니다.";
  if (!result.ok) return "모델 목록을 불러온 뒤 저장할 수 있습니다.";
  const chatModels = getInstalledChatModels(result);
  if (chatModels.length === 0) {
    return "설치된 채팅 모델이 없습니다. Ollama에 모델을 설치한 뒤 다시 확인하세요.";
  }
  if (!chatModels.includes(selectedModel)) return "설치된 채팅 모델을 선택하세요.";
  return null;
}
