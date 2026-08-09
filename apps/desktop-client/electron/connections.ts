// D09 연결 상태 — Ollama와 Local Agent Runtime의 Health 확인.
//
// CLAUDE.md: "Desktop은 Runtime 장애 시 종료되지 않고 복구 안내를 제공한다."
// Every check below is wrapped so a network failure never throws past this
// module — the worst outcome is `ok: false` with a Korean recovery hint.

import type { ConnectionStatus } from "./types";

const TIMEOUT_MS = 2500;

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkOllama(): Promise<ConnectionStatus> {
  const startedAt = Date.now();
  const url = "http://127.0.0.1:11434/api/tags";
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
      recoveryHint: "Ollama가 실행 중인지 확인하세요 (기본 주소: http://127.0.0.1:11434).",
    };
  }
}

async function checkRuntime(): Promise<ConnectionStatus> {
  const startedAt = Date.now();
  const url = "http://127.0.0.1:8100/health";
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
      recoveryHint: "Local Agent Runtime이 실행 중인지 확인하세요 (기본 주소: http://127.0.0.1:8100).",
    };
  }
}

export async function checkAllConnections(): Promise<ConnectionStatus[]> {
  const [runtime, ollama] = await Promise.all([checkRuntime(), checkOllama()]);
  return [runtime, ollama];
}
