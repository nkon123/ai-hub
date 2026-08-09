// D01/D10 — URL validation for Desktop 설정. Pure functions (no fs/electron
// imports) so both the wizard and the settings screen's IPC handlers share
// exactly one judgment about what counts as a valid endpoint, and so this
// file can be unit-tested directly with vitest (같은 원칙: `bundle-verify.ts`
// 순수 함수를 `bundle-install.ts` 오케스트레이션에서 분리한 것과 동일).
//
// 핵심 규칙(02-desktop-and-agent-runtime.md §D01 필드): "Ollama Base URL;
// 기본은 loopback만 허용" — 이것은 기본값이 아니라 보안 규칙이다. 이 파일은
// 그 규칙을 실제로 강제한다: loopback이 아닌 주소는 `allowNonLoopback`을
// 명시적으로 켜지 않는 한 거부된다(조용히 허용하지 않는다).

export interface UrlValidationResult {
  ok: boolean;
  error: string | null;
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

/** `true` only for a hostname that never leaves the local machine. Used both
 * to enforce the Ollama loopback rule and to explain *why* a URL was
 * rejected (never a bare "invalid URL"). */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

function parseHttpUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "주소를 입력하세요." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "올바른 URL 형식이 아닙니다 (예: http://127.0.0.1:11434)." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "http 또는 https 프로토콜만 허용됩니다." };
  }
  return { ok: true, url: parsed };
}

/** Ollama Base URL 검증 — loopback이 아니면 `allowNonLoopback`이 명시적으로
 * true일 때만 통과시킨다. 이 함수가 "허용"을 반환하지 않는 한 어떤 호출자도
 * 그 URL을 저장해서는 안 된다(main.ts의 IPC 핸들러가 저장 직전에 이 함수를
 * 다시 호출해 방어적으로 이중 검사한다 — bundle-install.ts의 경로 안전성
 * 재검사와 같은 원칙). */
export function validateOllamaBaseUrl(raw: string, allowNonLoopback: boolean): UrlValidationResult {
  const parsedResult = parseHttpUrl(raw);
  if (!parsedResult.ok) return { ok: false, error: parsedResult.error };
  if (!allowNonLoopback && !isLoopbackHostname(parsedResult.url.hostname)) {
    return {
      ok: false,
      error:
        "기본적으로 loopback 주소(127.0.0.1/localhost)만 허용됩니다. 원격 Ollama를 쓰려면 '외부 Ollama 허용'을 명시적으로 켜세요.",
    };
  }
  return { ok: true, error: null };
}

/** MCP Server URL 등 일반 endpoint 형식 검증 — D01/D10 필드 목록에 loopback
 * 강제가 명시된 것은 Ollama뿐이므로(비-loopback을 금지하지 않는다), 여기서는
 * http(s) 형식만 확인한다. */
export function validateGenericUrl(raw: string, fieldLabel: string): UrlValidationResult {
  const parsedResult = parseHttpUrl(raw);
  if (!parsedResult.ok) {
    return { ok: false, error: raw.trim() ? parsedResult.error : `${fieldLabel}을(를) 입력하세요.` };
  }
  return { ok: true, error: null };
}

export function validateNonEmpty(raw: string, fieldLabel: string): UrlValidationResult {
  if (!raw.trim()) return { ok: false, error: `${fieldLabel}을(를) 입력하세요.` };
  return { ok: true, error: null };
}
