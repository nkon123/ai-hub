// D01 최초 설정 Wizard / D10 설정 — 공용 설정 저장소.
//
// 하나의 저장소를 D01과 D10 두 화면이 함께 읽고 쓴다(경쟁하는 두 번째
// 저장소를 만들지 않는다) — `PortalSettingsStore`(Portal Base URL/Token)와
// 같은 관례(단일 JSON 파일, `state/` 아래, Main Process 전용)를 따르되
// 별개 파일로 둔다: 이 저장소가 다루는 필드(Ollama/모델 Alias/MCP/사업장)는
// Portal 연결과는 다른 수명주기를 가지기 때문이다 — Portal Token을 지워도
// 이 값들은 남아야 하고, 그 반대도 마찬가지다.
//
// 이 파일의 필드 중 실제 Secret은 없다(Ollama/MCP 모두 이 PoC에서는 인증이
// 없다 — D-001 Test Identity Adapter, MCP는 Mock User Context로 별도 Key가
// 필요 없음). 따라서 `PortalSettingsStore.getToken()`류의 "반환 금지" 접근자는
// 여기 없다 — `getPublic()`이 모든 필드를 그대로 반환해도 안전하다. 향후
// 실제 Secret 필드(예: MCP 인증 Key)가 추가되면 `PortalSettingsStore`와
// 동일한 패턴(Main Process 전용 접근자, IPC/진단 Bundle에는 "설정됨 여부"만)을
// 그대로 재사용해야 한다 — 새 메커니즘을 만들지 않는다.
import fs from "node:fs";
import path from "node:path";
// Endpoint 기본값은 connections.ts가 유일한 출처다 — 여기서 다시 상수를
// 정의하면 두 파일이 서로 다른 기본값으로 갈라질 위험이 생긴다(D01 3/5단계와
// D09가 결국 같은 값을 봐야 한다).
import { DEFAULT_MCP_SERVER_ALIAS, DEFAULT_MCP_SERVER_URL, DEFAULT_OLLAMA_BASE_URL } from "./connections";
import { validateGenericUrl, validateOllamaBaseUrl } from "./network-policy";
import { DEFAULT_CHAT_MODEL_ALIAS } from "./ollama-chat";
import type { DesktopSettingsInput, DesktopSettingsPublic, DesktopSettingsUpdateResult } from "./types";

export { DEFAULT_CHAT_MODEL_ALIAS };
export const DEFAULT_EMBEDDING_MODEL_ALIAS = "default-embedding";
export { DEFAULT_MCP_SERVER_ALIAS, DEFAULT_MCP_SERVER_URL, DEFAULT_OLLAMA_BASE_URL };

// D-074(open-decisions.md): 오늘 Desktop은 창 하나·대화 하나에서만 Run을
// 실행할 수 있다(ChatScreen의 `isRunning` 게이트, 다중 창/다중 대화 UI 없음,
// Local Agent Runtime에도 동시 실행 수를 제한하는 Queue/Semaphore가 없음) —
// 이 값을 사용자가 2 이상으로 바꿔도 실제로 동시에 실행되는 Run 수는 전혀
// 달라지지 않는다. "바꿔도 아무것도 달라지지 않는 설정"은 없는 것보다
// 나쁘므로(CLAUDE.md 취지), 이 필드는 편집 가능한 숫자로 노출하지 않고
// 항상 이 상수+사유로만 노출한다.
export const MAX_CONCURRENT_RUNS_VALUE = 1;
export const MAX_CONCURRENT_RUNS_REASON =
  "현재 Desktop은 창 하나에서 한 번에 하나의 대화만 실행할 수 있고, Local Agent Runtime에도 동시 실행 수를 제한하는 기능이 없습니다. 값을 바꿔도 실제 동작은 달라지지 않으므로 편집을 제공하지 않습니다 (open-decisions.md D-074).";

interface DesktopSettingsFile {
  clientDisplayName: string | null;
  siteId: string | null;
  ollamaBaseUrl: string;
  ollamaAllowNonLoopback: boolean;
  chatModelAlias: string;
  embeddingModelAlias: string;
  mcpServerAlias: string;
  mcpServerUrl: string;
  setupCompletedAt: string | null;
  updatedAt: string | null;
}

const DEFAULT_FILE: DesktopSettingsFile = {
  clientDisplayName: null,
  siteId: null,
  ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
  ollamaAllowNonLoopback: false,
  chatModelAlias: DEFAULT_CHAT_MODEL_ALIAS,
  embeddingModelAlias: DEFAULT_EMBEDDING_MODEL_ALIAS,
  mcpServerAlias: DEFAULT_MCP_SERVER_ALIAS,
  mcpServerUrl: DEFAULT_MCP_SERVER_URL,
  setupCompletedAt: null,
  updatedAt: null,
};

export class DesktopSettingsStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, "desktop-settings.json");
  }

  private read(): DesktopSettingsFile {
    if (!fs.existsSync(this.filePath)) return { ...DEFAULT_FILE };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      return {
        clientDisplayName: typeof parsed.clientDisplayName === "string" ? parsed.clientDisplayName : null,
        siteId: typeof parsed.siteId === "string" ? parsed.siteId : null,
        ollamaBaseUrl: typeof parsed.ollamaBaseUrl === "string" ? parsed.ollamaBaseUrl : DEFAULT_OLLAMA_BASE_URL,
        ollamaAllowNonLoopback: parsed.ollamaAllowNonLoopback === true,
        chatModelAlias: typeof parsed.chatModelAlias === "string" ? parsed.chatModelAlias : DEFAULT_CHAT_MODEL_ALIAS,
        embeddingModelAlias:
          typeof parsed.embeddingModelAlias === "string" ? parsed.embeddingModelAlias : DEFAULT_EMBEDDING_MODEL_ALIAS,
        mcpServerAlias: typeof parsed.mcpServerAlias === "string" ? parsed.mcpServerAlias : DEFAULT_MCP_SERVER_ALIAS,
        mcpServerUrl: typeof parsed.mcpServerUrl === "string" ? parsed.mcpServerUrl : DEFAULT_MCP_SERVER_URL,
        setupCompletedAt: typeof parsed.setupCompletedAt === "string" ? parsed.setupCompletedAt : null,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      };
    } catch {
      // 손상된 설정 파일은 "미설정"으로 취급한다 — Desktop은 장애 시
      // 종료되지 않는다(CLAUDE.md).
      return { ...DEFAULT_FILE };
    }
  }

  private write(next: DesktopSettingsFile): void {
    fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf-8");
  }

  getPublic(): DesktopSettingsPublic {
    const current = this.read();
    return {
      clientDisplayName: current.clientDisplayName,
      siteId: current.siteId,
      ollamaBaseUrl: current.ollamaBaseUrl,
      ollamaAllowNonLoopback: current.ollamaAllowNonLoopback,
      chatModelAlias: current.chatModelAlias,
      embeddingModelAlias: current.embeddingModelAlias,
      mcpServerAlias: current.mcpServerAlias,
      mcpServerUrl: current.mcpServerUrl,
      maxConcurrentRuns: { value: MAX_CONCURRENT_RUNS_VALUE, enforced: false, reason: MAX_CONCURRENT_RUNS_REASON },
      setupCompletedAt: current.setupCompletedAt,
      updatedAt: current.updatedAt,
    };
  }

  isSetupCompleted(): boolean {
    return this.read().setupCompletedAt !== null;
  }

  /** 제공된 필드만 검증 후 반영한다(부분 업데이트) — D01은 단계마다, D10은
   * Section마다 이 메서드를 호출한다. 어느 한 필드라도 검증에 실패하면 아무
   * 것도 저장하지 않고(All-or-nothing) 실패 사유를 반환한다 — 절반만 저장된
   * 상태로 남기지 않기 위함. */
  update(patch: DesktopSettingsInput): DesktopSettingsUpdateResult {
    const current = this.read();
    const next: DesktopSettingsFile = { ...current };

    if (patch.clientDisplayName !== undefined) {
      next.clientDisplayName = patch.clientDisplayName.trim() || null;
    }
    if (patch.siteId !== undefined) {
      next.siteId = patch.siteId.trim() || null;
    }
    if (patch.ollamaBaseUrl !== undefined || patch.ollamaAllowNonLoopback !== undefined) {
      const allowNonLoopback = patch.ollamaAllowNonLoopback ?? current.ollamaAllowNonLoopback;
      const url = patch.ollamaBaseUrl ?? current.ollamaBaseUrl;
      const check = validateOllamaBaseUrl(url, allowNonLoopback);
      if (!check.ok) return { ok: false, error: check.error, settings: this.getPublic() };
      next.ollamaBaseUrl = url.trim();
      next.ollamaAllowNonLoopback = allowNonLoopback;
    }
    if (patch.chatModelAlias !== undefined) {
      if (!patch.chatModelAlias.trim()) {
        return { ok: false, error: "기본 Chat Model Alias를 입력하세요.", settings: this.getPublic() };
      }
      next.chatModelAlias = patch.chatModelAlias.trim();
    }
    if (patch.embeddingModelAlias !== undefined) {
      if (!patch.embeddingModelAlias.trim()) {
        return { ok: false, error: "기본 Embedding Model Alias를 입력하세요.", settings: this.getPublic() };
      }
      next.embeddingModelAlias = patch.embeddingModelAlias.trim();
    }
    if (patch.mcpServerAlias !== undefined) {
      if (!patch.mcpServerAlias.trim()) {
        return { ok: false, error: "MCP Server Alias를 입력하세요.", settings: this.getPublic() };
      }
      next.mcpServerAlias = patch.mcpServerAlias.trim();
    }
    if (patch.mcpServerUrl !== undefined) {
      const check = validateGenericUrl(patch.mcpServerUrl, "MCP Server URL");
      if (!check.ok) return { ok: false, error: check.error, settings: this.getPublic() };
      next.mcpServerUrl = patch.mcpServerUrl.trim();
    }

    next.updatedAt = new Date().toISOString();
    this.write(next);
    return { ok: true, error: null, settings: this.getPublic() };
  }

  /** D01 7단계 "전체 진단 결과와 저장" 완료 시점 — 이후 D00이 도입되면 이
   * 값을 "설정 완료됨" 판정에 사용할 수 있다(D00 자체는 이번 범위 밖). */
  markSetupCompleted(): DesktopSettingsPublic {
    const current = this.read();
    this.write({ ...current, setupCompletedAt: new Date().toISOString() });
    return this.getPublic();
  }
}
