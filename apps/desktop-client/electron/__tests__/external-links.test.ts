// D-093 "(1) Ollama 본체 = 외부 홈페이지 링크" — 판정 로직의 회귀 테스트.
// `judgeOllamaConnection`/`shouldShowOllamaInstallGuidance`는 순수 함수이므로
// (렌더링 테스트가 없는 이 프로젝트의 vitest.config.ts가 environment: "node"인
// 이유가 여기 있다) 여기서 직접 검증한다.
import { describe, expect, it } from "vitest";
import { judgeOllamaConnection, OLLAMA_DOWNLOAD_URL, shouldShowOllamaInstallGuidance } from "../external-links";
import type { ConnectionStatus } from "../types";

function makeOllamaStatus(ok: boolean): ConnectionStatus {
  return {
    id: "ollama",
    label: "Ollama",
    ok,
    detail: ok ? "정상 연결됨" : "연결 실패",
    checkedAt: new Date().toISOString(),
    latencyMs: ok ? 12 : null,
    recoveryHint: ok ? null : "Ollama가 실행 중인지 확인하세요.",
  };
}

describe("D-093 judgeOllamaConnection", () => {
  it("returns 'connected' when the status is ok", () => {
    expect(judgeOllamaConnection(makeOllamaStatus(true))).toBe("connected");
  });

  it("returns 'failed' when the status is present but not ok", () => {
    expect(judgeOllamaConnection(makeOllamaStatus(false))).toBe("failed");
  });

  it("returns 'unknown' when no status has been checked yet (null)", () => {
    expect(judgeOllamaConnection(null)).toBe("unknown");
  });

  it("returns 'unknown' when the status is undefined (e.g. .find() found nothing)", () => {
    expect(judgeOllamaConnection(undefined)).toBe("unknown");
  });
});

describe("D-093 shouldShowOllamaInstallGuidance", () => {
  it("does not show guidance when Ollama is already connected", () => {
    expect(shouldShowOllamaInstallGuidance(makeOllamaStatus(true))).toBe(false);
  });

  it("shows guidance only once the connection check has confirmed failure", () => {
    expect(shouldShowOllamaInstallGuidance(makeOllamaStatus(false))).toBe(true);
  });

  it("does not show guidance while the connection state is still unknown (not yet checked)", () => {
    // A premature "install Ollama" banner before the health check even ran
    // would be a false positive — the same failure shape this repo's
    // CLAUDE.md warns about for CORS-blocked-but-healthy services.
    expect(shouldShowOllamaInstallGuidance(null)).toBe(false);
    expect(shouldShowOllamaInstallGuidance(undefined)).toBe(false);
  });
});

describe("D-093 OLLAMA_DOWNLOAD_URL", () => {
  it("is the exact address decided in open-decisions.md D-093", () => {
    expect(OLLAMA_DOWNLOAD_URL).toBe("https://ollama.com/download");
  });
});
