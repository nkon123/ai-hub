// D09 연결 상태 — Ollama / Local Agent Runtime / Office MCP Server의 Health
// 확인. D01/D10(desktop-settings.ts)이 도입되기 전에는 세 Endpoint가 전부
// 하드코딩돼 있었다 — 이제 Ollama/MCP는 설정 저장소 값을 인자로 받고, 값이
// 없으면(설정 전, 또는 이 함수를 직접 호출하는 기존 테스트/호출부) 이전과
// 동일한 기본값으로 동작한다(D01/D10 작업 전 동작을 조금도 바꾸지 않는다).
// Local Agent Runtime은 D01 저장 설정 필드에는 없지만, 렌더러가 실제 대화에
// 사용하는 Vite 환경 설정을 호출 시점에 넘길 수 있도록 선택 인자로 받는다.
//
// CLAUDE.md: "Desktop은 Runtime 장애 시 종료되지 않고 복구 안내를 제공한다."
// Every check below is wrapped so a network failure never throws past this
// module — the worst outcome is `ok: false` with a Korean recovery hint.

import type { ConnectionStatus, OllamaModelsResult } from "./types";

const TIMEOUT_MS = 2500;

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_RUNTIME_BASE_URL = "http://127.0.0.1:8100";
export const DEFAULT_MCP_SERVER_URL = "http://127.0.0.1:8500";
export const DEFAULT_MCP_SERVER_ALIAS = "oracle-connector";

export interface ConnectionCheckSettings {
  ollamaBaseUrl?: string;
  runtimeBaseUrl?: string;
  mcpServerUrl?: string;
  mcpServerAlias?: string;
}

export type ChatConnectionState = "healthy" | "blocked" | "limited";

export interface ChatConnectionAssessment {
  state: ChatConnectionState;
  blockingFailures: ConnectionStatus[];
  featureFailures: ConnectionStatus[];
}

/**
 * 대화에 필수인 서비스와 선택 기능용 서비스를 한 곳에서 구분한다.
 * Local Agent Runtime과 Ollama 장애는 대화 자체를 막을 수 있지만, MCP 장애는
 * MCP Tool 질문만 제한하며 Knowledge 대화에는 영향을 주지 않는다.
 */
export function assessChatConnections(
  connections: readonly ConnectionStatus[],
  mode: "knowledge" | "ollama" = "knowledge",
): ChatConnectionAssessment {
  const blockingFailures = connections.filter(
    (connection) =>
      !connection.ok && (connection.id === "ollama" || (mode === "knowledge" && connection.id === "runtime")),
  );
  const featureFailures = connections.filter(
    (connection) =>
      !connection.ok && (connection.id === "mcp" || (mode === "ollama" && connection.id === "runtime")),
  );

  return {
    state: blockingFailures.length > 0 ? "blocked" : featureFailures.length > 0 ? "limited" : "healthy",
    blockingFailures,
    featureFailures,
  };
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkOllama(baseUrl: string): Promise<ConnectionStatus> {
  const startedAt = Date.now();
  const url = `${trimTrailingSlash(baseUrl)}/api/tags`;
  try {
    const res = await fetchWithTimeout(url, TIMEOUT_MS);
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return {
        id: "ollama",
        label: "Ollama",
        ok: false,
        detail: `응답 오류 (HTTP ${res.status})`,
        checkedAt: new Date().toISOString(),
        latencyMs,
        recoveryHint: "Ollama 서비스 상태를 확인한 뒤 다시 검사하세요.",
      };
    }
    return {
      id: "ollama",
      label: "Ollama",
      ok: true,
      detail: "정상 연결됨",
      checkedAt: new Date().toISOString(),
      latencyMs,
      recoveryHint: null,
    };
  } catch (err) {
    return {
      id: "ollama",
      label: "Ollama",
      ok: false,
      detail: err instanceof Error ? err.message : "연결 실패",
      checkedAt: new Date().toISOString(),
      latencyMs: null,
      recoveryHint: `Ollama가 실행 중인지 확인하세요 (설정된 주소: ${baseUrl}).`,
    };
  }
}

async function checkRuntime(baseUrl: string): Promise<ConnectionStatus> {
  const startedAt = Date.now();
  const url = `${trimTrailingSlash(baseUrl)}/health`;
  try {
    const res = await fetchWithTimeout(url, TIMEOUT_MS);
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return {
        id: "runtime",
        label: "Local Agent Runtime",
        ok: false,
        detail: `응답 오류 (HTTP ${res.status})`,
        checkedAt: new Date().toISOString(),
        latencyMs,
        recoveryHint: "Local Agent Runtime 프로세스를 재시작하세요.",
      };
    }
    return {
      id: "runtime",
      label: "Local Agent Runtime",
      ok: true,
      detail: "정상 연결됨",
      checkedAt: new Date().toISOString(),
      latencyMs,
      recoveryHint: null,
    };
  } catch (err) {
    return {
      id: "runtime",
      label: "Local Agent Runtime",
      ok: false,
      detail: err instanceof Error ? err.message : "연결 실패",
      checkedAt: new Date().toISOString(),
      latencyMs: null,
      recoveryHint: `Local Agent Runtime이 실행 중인지 확인하세요 (설정된 주소: ${baseUrl}).`,
    };
  }
}

// office-mcp-server는 `/health`가 아니라 `/health/live`가 정식 API다
// (13-windows-local-setup.md §6.1, services/office-mcp-server/main.py).
async function checkMcp(baseUrl: string, alias: string): Promise<ConnectionStatus> {
  const startedAt = Date.now();
  const url = `${trimTrailingSlash(baseUrl)}/health/live`;
  const label = `Office MCP Server (${alias})`;
  try {
    const res = await fetchWithTimeout(url, TIMEOUT_MS);
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return {
        id: "mcp",
        label,
        ok: false,
        detail: `응답 오류 (HTTP ${res.status})`,
        checkedAt: new Date().toISOString(),
        latencyMs,
        recoveryHint: "office-mcp-server 프로세스 상태를 확인한 뒤 다시 검사하세요.",
      };
    }
    return {
      id: "mcp",
      label,
      ok: true,
      detail: "정상 연결됨",
      checkedAt: new Date().toISOString(),
      latencyMs,
      recoveryHint: null,
    };
  } catch (err) {
    return {
      id: "mcp",
      label,
      ok: false,
      detail: err instanceof Error ? err.message : "연결 실패",
      checkedAt: new Date().toISOString(),
      latencyMs: null,
      recoveryHint: `office-mcp-server가 실행 중인지 확인하세요 (설정된 주소: ${baseUrl}).`,
    };
  }
}

export async function checkAllConnections(settings?: ConnectionCheckSettings): Promise<ConnectionStatus[]> {
  const [runtime, ollama, mcp] = await Promise.all([
    checkRuntime(settings?.runtimeBaseUrl ?? DEFAULT_RUNTIME_BASE_URL),
    checkOllama(settings?.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL),
    checkMcp(settings?.mcpServerUrl ?? DEFAULT_MCP_SERVER_URL, settings?.mcpServerAlias ?? DEFAULT_MCP_SERVER_ALIAS),
  ]);
  return [runtime, ollama, mcp];
}

/** D01 4단계 "설치된 Chat/Embedding 모델 확인"이 쓰는 순수 조회 — `/api/tags`가
 * 보고하는 실제 설치된 모델 이름 그대로를 반환한다. Desktop은 "Alias -> 실제
 * model_id" 매핑을 모르므로(그 매핑은 agent-runtime의 Office Profile에만
 * 있다) Alias별 PASS/FAIL을 여기서 단정하지 않는다 — 호출자(마법사 UI)가
 * 목록을 보여주고 사용자가 직접 확인하게 한다. */
export async function listOllamaModels(baseUrl: string): Promise<OllamaModelsResult> {
  const url = `${trimTrailingSlash(baseUrl)}/api/tags`;
  try {
    const res = await fetchWithTimeout(url, TIMEOUT_MS);
    if (!res.ok) {
      return { ok: false, models: [], error: `Ollama 응답 오류 (HTTP ${res.status})` };
    }
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = Array.isArray(body.models)
      ? body.models.map((m) => m.name).filter((n): n is string => typeof n === "string")
      : [];
    return { ok: true, models, error: null };
  } catch (err) {
    return { ok: false, models: [], error: err instanceof Error ? err.message : "Ollama에 연결할 수 없습니다." };
  }
}
