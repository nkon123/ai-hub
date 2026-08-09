// 자산 스토어 — Portal 연결 설정(Base URL + 식별 Token) 영속화.
//
// D-001(SSO 미도입, PoC는 `dev-*-token` 형태의 고정 Bearer Token 사용)에
// 따라 이 PoC는 Token을 로컬 파일에 평문으로 저장한다 — OS Keychain 연동은
// 범위 밖으로 `open-decisions.md`에 기록되어 있다.
//
// 이 파일이 지키는 절대 규칙: Token 실제 값을 반환하는 `getToken()`은 이
// 클래스 밖으로 나가는 순간부터 Main Process 내부(HTTP 호출 조립)에서만
// 쓰여야 한다 — `preload.ts`의 어떤 브리지 메서드도 이 값을 반환하지 않고,
// `main.ts`의 IPC 핸들러도 이 값을 로그에 남기지 않는다. 렌더러와 D11 진단
// Bundle에는 오직 `getPublic()`(설정됨 여부 + 마지막 갱신 시각)만 노출된다.
import fs from "node:fs";
import path from "node:path";
import type { PortalSettingsPublic } from "./types";

interface PortalSettingsFile {
  baseUrl: string | null;
  token: string | null;
  tokenUpdatedAt: string | null;
}

const EMPTY_FILE: PortalSettingsFile = { baseUrl: null, token: null, tokenUpdatedAt: null };

export class PortalSettingsStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, "portal-settings.json");
  }

  private read(): PortalSettingsFile {
    if (!fs.existsSync(this.filePath)) return { ...EMPTY_FILE };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      return {
        baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : null,
        token: typeof parsed.token === "string" ? parsed.token : null,
        tokenUpdatedAt: typeof parsed.tokenUpdatedAt === "string" ? parsed.tokenUpdatedAt : null,
      };
    } catch {
      // 손상된 설정 파일은 "미설정"으로 취급한다 — Desktop은 장애 시
      // 종료되지 않는다(CLAUDE.md).
      return { ...EMPTY_FILE };
    }
  }

  private write(next: PortalSettingsFile): void {
    fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf-8");
  }

  /** 렌더러/D11 진단 Bundle에 노출해도 안전한 형태 — 절대 Token 원문을
   * 포함하지 않는다. */
  getPublic(): PortalSettingsPublic {
    const current = this.read();
    return {
      baseUrl: current.baseUrl,
      tokenConfigured: !!current.token,
      tokenUpdatedAt: current.tokenUpdatedAt,
    };
  }

  /** Main Process 내부 전용 — HTTP 호출 조립에만 사용한다. */
  getToken(): string | null {
    return this.read().token;
  }

  getBaseUrl(): string | null {
    return this.read().baseUrl;
  }

  setBaseUrl(baseUrl: string): PortalSettingsPublic {
    const current = this.read();
    this.write({ ...current, baseUrl: baseUrl.trim() || null });
    return this.getPublic();
  }

  setToken(token: string): PortalSettingsPublic {
    const current = this.read();
    this.write({ ...current, token: token.trim() || null, tokenUpdatedAt: new Date().toISOString() });
    return this.getPublic();
  }

  clearToken(): PortalSettingsPublic {
    const current = this.read();
    this.write({ ...current, token: null, tokenUpdatedAt: null });
    return this.getPublic();
  }
}
