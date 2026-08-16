import {
  checkAllConnections,
  DEFAULT_MCP_SERVER_ALIAS,
  DEFAULT_MCP_SERVER_URL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_RUNTIME_BASE_URL as DEFAULT_AGENT_RUNTIME_BASE_URL,
  DEFAULT_SEARCH_RUNTIME_BASE_URL,
  listOllamaModels,
} from "../electron/connections";
import {
  validateAgentRuntimeBaseUrl,
  validateGenericUrl,
  validateNonEmpty,
  validateOllamaBaseUrl,
  validateSearchRuntimeBaseUrl,
} from "../electron/network-policy";
import { DEFAULT_CHAT_MODEL_ALIAS } from "../electron/ollama-chat";
import type {
  ConversationRecord,
  ConversationSummary,
  ConversationTurnStatus,
  DesktopBridge,
  DesktopSettingsInput,
  DesktopSettingsPublic,
  DesktopSettingsUpdateResult,
} from "../electron/types";

const STORAGE_KEY = "desktop-client:browser-preview-settings:v1";
const CONVERSATIONS_STORAGE_KEY = "desktop-client:browser-preview-conversations:v1";
const DEFAULT_EMBEDDING_MODEL_ALIAS = "default-embedding";
const MAX_CONCURRENT_RUNS_REASON =
  "브라우저 개발 모드와 Desktop 모두 한 번에 하나의 대화만 실행합니다. 현재 이 값은 편집할 수 없습니다.";

// 브라우저 개발 모드는 파일시스템/Electron IPC가 전혀 없어 실제로 수행할 수
// 없는 동작에 공통으로 쓰는 안내 문구 — 항상 이 문구로 명시적으로 거부하고,
// 조용히 성공한 것처럼 값을 지어내지 않는다.
const DESKTOP_RUNTIME_REQUIRED_MESSAGE = "브라우저 개발 모드에서는 사용할 수 없습니다. Desktop 앱에서 실행하세요.";

// 이 타입은 예전에는 `Pick<DesktopBridge, ...>`(메서드 일부만 포함한
// 허용목록)이었다 — 그 결과 `DesktopBridge`에 새 메서드(D-079 활성화 3종)가
// 추가돼도 이 파일이 갱신되지 않으면 TypeScript가 아무 신호도 주지 않았고,
// `getDesktopBridge()`는 `window.desktop`을 여전히 "완전한 DesktopBridge"로
// 단정했다. 화면들이 `getDesktopBridge() ?? getBrowserSettingsBridge()`처럼
// 두 값을 섞어 쓰는 패턴(SettingsScreen.tsx, SetupWizardScreen.tsx)에서는
// 이 어긋남이 실제 런타임 TypeError로 이어질 수 있는 구조였다.
//
// 지금은 `DesktopBridge` 그 자체와 동일하다 — 모든 메서드를 실제로 구현하고,
// 브라우저에서 수행할 수 없는 것(파일 설치, Portal Store, Knowledge 활성화
// 등)은 조용히 성공한 척하지 않고 `DESKTOP_RUNTIME_REQUIRED_MESSAGE` 모양의
// 정직한 실패/빈 결과를 돌려준다. 이렇게 하면 다음에 `DesktopBridge`에
// 메서드가 하나 추가될 때, 아래 객체 리터럴이 그 메서드를 빠뜨리는 순간
// `pnpm typecheck`가 즉시 실패한다 — 허용목록이 인터페이스와 갈라질 수
// 없어진다.
export type BrowserSettingsBridge = DesktopBridge;

export function createDefaultBrowserPreviewSettings(): DesktopSettingsPublic {
  return {
    clientDisplayName: null,
    siteId: null,
    ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
    ollamaAllowNonLoopback: false,
    chatModelAlias: DEFAULT_CHAT_MODEL_ALIAS,
    mcpServerAlias: DEFAULT_MCP_SERVER_ALIAS,
    mcpServerUrl: DEFAULT_MCP_SERVER_URL,
    searchRuntimeBaseUrl: DEFAULT_SEARCH_RUNTIME_BASE_URL,
    agentRuntimeBaseUrl: DEFAULT_AGENT_RUNTIME_BASE_URL,
    // D-084: 브라우저 개발 모드에는 파일시스템/subprocess가 없어 로컬 Tool을
    // 실행할 방법 자체가 없다 — 값이 있어도 의미가 없으므로 항상 미설정으로
    // 시작한다.
    pythonInterpreterPath: null,
    maxConcurrentRuns: { value: 1, enforced: false, reason: MAX_CONCURRENT_RUNS_REASON },
    setupCompletedAt: null,
    updatedAt: null,
  };
}

export function applyBrowserPreviewSettingsPatch(
  current: DesktopSettingsPublic,
  patch: DesktopSettingsInput,
): DesktopSettingsUpdateResult {
  const next: DesktopSettingsPublic = { ...current };

  if (patch.clientDisplayName !== undefined) next.clientDisplayName = patch.clientDisplayName.trim() || null;
  if (patch.siteId !== undefined) next.siteId = patch.siteId.trim() || null;

  if (patch.ollamaBaseUrl !== undefined || patch.ollamaAllowNonLoopback !== undefined) {
    const allowNonLoopback = patch.ollamaAllowNonLoopback ?? current.ollamaAllowNonLoopback;
    const ollamaBaseUrl = patch.ollamaBaseUrl ?? current.ollamaBaseUrl;
    const validation = validateOllamaBaseUrl(ollamaBaseUrl, allowNonLoopback);
    if (!validation.ok) return { ok: false, error: validation.error, settings: current };
    next.ollamaBaseUrl = ollamaBaseUrl.trim();
    next.ollamaAllowNonLoopback = allowNonLoopback;
  }

  const nonEmptyFields: Array<[keyof Pick<DesktopSettingsInput, "chatModelAlias" | "mcpServerAlias">, string]> = [
    ["chatModelAlias", "기본 Chat Model Alias"],
    ["mcpServerAlias", "MCP Server Alias"],
  ];
  for (const [key, label] of nonEmptyFields) {
    const value = patch[key];
    if (value === undefined) continue;
    const validation = validateNonEmpty(value, label);
    if (!validation.ok) return { ok: false, error: validation.error, settings: current };
    next[key] = value.trim();
  }

  if (patch.mcpServerUrl !== undefined) {
    const validation = validateGenericUrl(patch.mcpServerUrl, "MCP Server URL");
    if (!validation.ok) return { ok: false, error: validation.error, settings: current };
    next.mcpServerUrl = patch.mcpServerUrl.trim();
  }

  if (patch.searchRuntimeBaseUrl !== undefined) {
    const validation = validateSearchRuntimeBaseUrl(patch.searchRuntimeBaseUrl);
    if (!validation.ok) return { ok: false, error: validation.error, settings: current };
    next.searchRuntimeBaseUrl = patch.searchRuntimeBaseUrl.trim();
  }

  if (patch.agentRuntimeBaseUrl !== undefined) {
    const validation = validateAgentRuntimeBaseUrl(patch.agentRuntimeBaseUrl);
    if (!validation.ok) return { ok: false, error: validation.error, settings: current };
    next.agentRuntimeBaseUrl = patch.agentRuntimeBaseUrl.trim();
  }

  if (patch.pythonInterpreterPath !== undefined) {
    next.pythonInterpreterPath = patch.pythonInterpreterPath.trim() || null;
  }

  next.updatedAt = new Date().toISOString();
  return { ok: true, error: null, settings: next };
}

function readSettings(): DesktopSettingsPublic {
  const defaults = createDefaultBrowserPreviewSettings();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<DesktopSettingsPublic> | null;
    if (!parsed || typeof parsed !== "object") return defaults;
    return {
      ...defaults,
      clientDisplayName: typeof parsed.clientDisplayName === "string" ? parsed.clientDisplayName : null,
      siteId: typeof parsed.siteId === "string" ? parsed.siteId : null,
      ollamaBaseUrl: typeof parsed.ollamaBaseUrl === "string" ? parsed.ollamaBaseUrl : defaults.ollamaBaseUrl,
      ollamaAllowNonLoopback: parsed.ollamaAllowNonLoopback === true,
      chatModelAlias: typeof parsed.chatModelAlias === "string" ? parsed.chatModelAlias : defaults.chatModelAlias,
      mcpServerAlias: typeof parsed.mcpServerAlias === "string" ? parsed.mcpServerAlias : defaults.mcpServerAlias,
      mcpServerUrl: typeof parsed.mcpServerUrl === "string" ? parsed.mcpServerUrl : defaults.mcpServerUrl,
      searchRuntimeBaseUrl:
        typeof parsed.searchRuntimeBaseUrl === "string" ? parsed.searchRuntimeBaseUrl : defaults.searchRuntimeBaseUrl,
      agentRuntimeBaseUrl:
        typeof parsed.agentRuntimeBaseUrl === "string" ? parsed.agentRuntimeBaseUrl : defaults.agentRuntimeBaseUrl,
      pythonInterpreterPath: typeof parsed.pythonInterpreterPath === "string" ? parsed.pythonInterpreterPath : null,
      setupCompletedAt: typeof parsed.setupCompletedAt === "string" ? parsed.setupCompletedAt : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return defaults;
  }
}

function persistSettings(settings: DesktopSettingsPublic): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function readConversations(): ConversationRecord[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CONVERSATIONS_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as ConversationRecord[]) : [];
  } catch {
    return [];
  }
}

function persistConversations(conversations: ConversationRecord[]): void {
  window.localStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(conversations));
}

function conversationSummary(conversation: ConversationRecord): ConversationSummary {
  return {
    id: conversation.id,
    knowledgeId: conversation.knowledgeId,
    knowledgeLabel: conversation.knowledgeLabel,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    turnCount: conversation.turns.length,
  };
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `preview-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function isBrowserDesktopPreviewEnabled(): boolean {
  return (
    import.meta.env.DEV &&
    typeof window !== "undefined" &&
    !window.desktop &&
    new URLSearchParams(window.location.search).get("desktop-preview") === "1"
  );
}

let previewBridge: BrowserSettingsBridge | null = null;

export function getBrowserSettingsBridge(): BrowserSettingsBridge | null {
  if (!isBrowserDesktopPreviewEnabled()) return null;
  if (previewBridge) return previewBridge;

  previewBridge = {
    async getDesktopSettings() {
      return readSettings();
    },
    async updateDesktopSettings(patch) {
      const result = applyBrowserPreviewSettingsPatch(readSettings(), patch);
      if (!result.ok) return result;
      try {
        persistSettings(result.settings);
        return result;
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "브라우저 설정을 저장하지 못했습니다.",
          settings: readSettings(),
        };
      }
    },
    async markSetupCompleted() {
      const settings = { ...readSettings(), setupCompletedAt: new Date().toISOString() };
      persistSettings(settings);
      return settings;
    },
    async getInstallRootPath() {
      return "브라우저 개발 모드 (파일 저장 없음)";
    },
    async getDiskSpace() {
      return { path: "브라우저 개발 모드 (파일 저장 없음)", freeBytes: 0 };
    },
    async listOllamaModels(ollamaBaseUrl) {
      return listOllamaModels(ollamaBaseUrl);
    },
    // 브라우저 개발 모드에는 설치된 자산도 파일시스템도 없다 — 빈 목록이
    // 정직한 답이다(가짜 모델명을 지어내지 않는다).
    async getKnowledgeEmbedModels() {
      return [];
    },

    async checkConnections() {
      const settings = readSettings();
      return checkAllConnections({
        ollamaBaseUrl: settings.ollamaBaseUrl,
        mcpServerAlias: settings.mcpServerAlias,
        mcpServerUrl: settings.mcpServerUrl,
      });
    },

    // --- Bundle Import / D08 로컬 자산 관리 -----------------------------------
    // 브라우저 개발 모드에는 파일시스템도, 설치된 자산도 없다. 빈 목록/
    // "선택 없음"은 이 모드에서는 사실 그대로다(설치된 것이 정말 없다) —
    // 거짓 성공이 아니다.
    async pickBundleFile() {
      return null;
    },
    async importBundle() {
      return {
        outcome: "FAILED",
        checks: [
          {
            id: "desktop_runtime_required",
            label: "Desktop 런타임 필요",
            status: "FAIL",
            message: DESKTOP_RUNTIME_REQUIRED_MESSAGE,
          },
        ],
        failedStage: null,
        retryable: false,
        manifest: null,
        installPlan: [],
        totalSizeBytes: 0,
      };
    },
    onImportProgress() {
      // 브라우저 개발 모드에서는 Import 자체가 절대 시작되지 않으므로 이
      // 이벤트도 절대 발생하지 않는다 — 구독은 안전하게 no-op으로 둔다.
      return () => {};
    },
    async listInstalledAssets() {
      return [];
    },
    async removeInstalledAsset() {
      return { ok: false, error: DESKTOP_RUNTIME_REQUIRED_MESSAGE };
    },
    async checkAssetRemoval() {
      return {
        blocked: false,
        referencingServices: [],
        runCheckAvailable: false,
        runCheckNote: DESKTOP_RUNTIME_REQUIRED_MESSAGE,
        blockedByActiveVersion: false,
        activeVersionNote: null,
      };
    },
    async getAssetManifest() {
      return { available: false, reason: DESKTOP_RUNTIME_REQUIRED_MESSAGE, manifest: null };
    },
    async reverifyAssetChecksum() {
      return { available: false, reason: DESKTOP_RUNTIME_REQUIRED_MESSAGE, result: null };
    },
    async getAssetDependencies() {
      return { forward: [], forwardNote: DESKTOP_RUNTIME_REQUIRED_MESSAGE, referencedBy: [] };
    },

    // --- D06 대화: KNOWLEDGE_ROUTE 후보 조립(agentic Knowledge 선택) -----------
    // `listInstalledAssets()`가 이미 `[]`를 돌려주므로(브라우저 개발 모드는
    // 설치된 자산 자체가 없다) 여기도 같은 사실을 그대로 반영한다 — 오류가
    // 아니라 "후보가 없다"이므로 조용한 빈 배열이 정직한 결과다.
    async getKnowledgeCandidates() {
      return [];
    },

    // --- D-079 Knowledge 활성화 ------------------------------------------------
    // 이 세 메서드가 이전에 빠져 있던(Pick 허용목록에 없던) 바로 그 메서드다
    // — 여기서도 마찬가지로 "시도조차 못했다"를 정직하게 표현한다.
    async activateInstalledKnowledge() {
      return { ok: false, activation: null, error: DESKTOP_RUNTIME_REQUIRED_MESSAGE };
    },
    async deactivateInstalledKnowledge() {
      return { ok: false, remoteWarning: null, error: DESKTOP_RUNTIME_REQUIRED_MESSAGE };
    },
    async reconcileKnowledgeActivations() {
      return { checked: false, downgradedCount: 0, error: DESKTOP_RUNTIME_REQUIRED_MESSAGE };
    },

    // --- D-080 MCP Tool 연결 --------------------------------------------------
    async connectInstalledMcpTool() {
      return { ok: false, activation: null, error: DESKTOP_RUNTIME_REQUIRED_MESSAGE };
    },
    async disconnectInstalledMcpTool() {
      return { ok: false, remoteWarning: null, error: DESKTOP_RUNTIME_REQUIRED_MESSAGE };
    },
    async reconcileMcpToolConnections() {
      return { checked: false, downgradedCount: 0, registrationEnabled: null, error: DESKTOP_RUNTIME_REQUIRED_MESSAGE };
    },

    // --- D12 업데이트/복구 -------------------------------------------------------
    async diffAssetVersions() {
      return { available: false, reason: DESKTOP_RUNTIME_REQUIRED_MESSAGE, diff: null };
    },
    async activateAssetVersion() {
      return { ok: false, error: DESKTOP_RUNTIME_REQUIRED_MESSAGE };
    },
    async cleanupOrphanedInstalls() {
      return { removed: [] };
    },

    // --- D11 로그/진단 -----------------------------------------------------------
    async listLogs() {
      return [];
    },
    async generateDiagnosticBundle() {
      const generatedAt = new Date().toISOString();
      return {
        bundle: {
          generatedAt,
          clientVersion: "browser-preview",
          runtimeVersion: null,
          runtimeVersionNote: DESKTOP_RUNTIME_REQUIRED_MESSAGE,
          os: { platform: "browser", release: "-", arch: "-" },
          pythonVersion: null,
          pythonVersionNote: DESKTOP_RUNTIME_REQUIRED_MESSAGE,
          sanitizedSettings: {},
          installedAssets: [],
          health: [],
          logs: [],
        },
        savedPath: "브라우저 개발 모드 (파일 저장 없음)",
      };
    },

    // --- 자산 스토어(Portal 카탈로그 설치) --------------------------------------
    // Portal 설정은 브라우저 개발 모드에서 저장하지 않는다(Token을
    // localStorage에 남기지 않기 위한 의도적 선택, CLAUDE.md: Secret을
    // 기본 저장하지 않는다) — 항상 "설정 안 됨" 상태를 정직하게 돌려준다.
    async getPortalSettings() {
      return { baseUrl: null, tokenConfigured: false, tokenUpdatedAt: null };
    },
    async setPortalBaseUrl() {
      return { baseUrl: null, tokenConfigured: false, tokenUpdatedAt: null };
    },
    async setPortalToken() {
      return { baseUrl: null, tokenConfigured: false, tokenUpdatedAt: null };
    },
    async clearPortalToken() {
      return { baseUrl: null, tokenConfigured: false, tokenUpdatedAt: null };
    },
    async fetchPortalCatalog() {
      return { ok: false, assets: [], error: DESKTOP_RUNTIME_REQUIRED_MESSAGE };
    },
    async installFromStore() {
      return {
        outcome: "FAILED",
        failedStage: null,
        message: DESKTOP_RUNTIME_REQUIRED_MESSAGE,
        cancelled: false,
        importResult: null,
        retryable: false,
      };
    },
    onStoreInstallProgress() {
      return () => {};
    },
    async cancelStoreInstall() {
      // 진행 중인 Store 설치가 있을 수 없으므로(installFromStore가 항상
      // 즉시 실패를 돌려줌) no-op.
    },

    // --- D01 최초 설정 Wizard / D10 설정: chatWithOllama/cancelOllamaChat ------
    // ChatScreen은 브라우저 개발 모드에서 이 메서드를 거치지 않는다 —
    // `../../electron/ollama-chat`의 순수 함수를 직접 호출해 Ollama와
    // Loopback으로 통신한다(그 경로가 실제 동작 경로). 이 스텁은 향후 다른
    // 호출자가 `bridge.chatWithOllama`를 통해서만 접근하더라도 타입 계약을
    // 지키면서 정직하게(성공을 지어내지 않고) 실패하도록 존재한다.
    async chatWithOllama() {
      throw new Error(`${DESKTOP_RUNTIME_REQUIRED_MESSAGE} (대화 화면은 Ollama에 직접 연결합니다.)`);
    },
    async cancelOllamaChat() {
      // 위와 같은 이유로 취소할 진행 중인 호출이 이 경로로는 존재하지 않는다.
    },

    // --- D03 Service/Agent 상세 -------------------------------------------------
    async getServiceDetail() {
      return { available: false, reason: DESKTOP_RUNTIME_REQUIRED_MESSAGE, detail: null };
    },

    // --- D13 정보/보안 -----------------------------------------------------------
    async getSystemInfo() {
      return {
        clientVersion: "browser-preview",
        runtimeVersion: null,
        runtimeVersionNote: DESKTOP_RUNTIME_REQUIRED_MESSAGE,
        schemaVersion: { supportedVersion: "unknown", source: DESKTOP_RUNTIME_REQUIRED_MESSAGE },
        os: { platform: "browser", release: "-", arch: "-" },
        trustStore: { status: "NOT_IMPLEMENTED" as const, message: "이 PoC는 Trust Store를 구현하지 않습니다." },
        revocationList: { knownEntryCount: 0, lastLocalUpdateAt: null, note: DESKTOP_RUNTIME_REQUIRED_MESSAGE },
        openSourceNotices: { entries: [], incomplete: true, incompleteReason: DESKTOP_RUNTIME_REQUIRED_MESSAGE },
        dataLocations: {
          installRoot: "-",
          assetsDir: "-",
          stateDir: "-",
          logsDir: "-",
          quarantineDir: "-",
          profilesDir: "-",
          diagnosticsDir: "-",
        },
      };
    },

    async listConversations() {
      return readConversations()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(conversationSummary);
    },
    async getConversation(id) {
      return readConversations().find((conversation) => conversation.id === id) ?? null;
    },
    async createConversation(knowledgeId, knowledgeLabel) {
      const now = new Date().toISOString();
      const conversation: ConversationRecord = {
        id: newId(),
        knowledgeId,
        knowledgeLabel,
        title: "새 대화",
        createdAt: now,
        updatedAt: now,
        turns: [],
      };
      persistConversations([...readConversations(), conversation]);
      return conversation;
    },
    async appendConversationTurn(conversationId, turn) {
      const conversations = readConversations();
      const index = conversations.findIndex((conversation) => conversation.id === conversationId);
      if (index < 0) return null;
      const current = conversations[index];
      const now = new Date().toISOString();
      const question = turn.question.trim();
      const title = question.length > 40 ? `${question.slice(0, 40)}…` : question || "새 대화";
      const updated: ConversationRecord = {
        ...current,
        title: current.turns.length === 0 ? title : current.title,
        updatedAt: now,
        turns: [
          ...current.turns,
          {
            id: newId(),
            question: turn.question,
            answer: turn.answer,
            status: turn.status as ConversationTurnStatus,
            citationCount: turn.citationCount,
            createdAt: now,
          },
        ],
      };
      conversations[index] = updated;
      persistConversations(conversations);
      return updated;
    },
    async deleteConversation(id, reason) {
      if (!reason.trim()) return { ok: false, error: "삭제 사유를 입력해야 합니다." };
      const conversations = readConversations();
      if (!conversations.some((conversation) => conversation.id === id)) {
        return { ok: false, error: "대화를 찾을 수 없습니다." };
      }
      persistConversations(conversations.filter((conversation) => conversation.id !== id));
      return { ok: true, error: null };
    },

    // --- D-084 "Desktop 로컬 Tool" ------------------------------------------
    // 브라우저 개발 모드에는 파일시스템도 subprocess도 없다 — 파일을 고를
    // 수도, Python을 실행할 수도 없으므로 모든 메서드가 정직하게 "불가"를
    // 돌려준다(성공을 지어내지 않는다).
    async pickLocalToolFile() {
      return null;
    },
    async inspectLocalToolFile() {
      return { ok: false, reason: "file_unreadable", message: DESKTOP_RUNTIME_REQUIRED_MESSAGE };
    },
    async addLocalTool() {
      return { ok: false, tool: null, error: DESKTOP_RUNTIME_REQUIRED_MESSAGE };
    },
    async listLocalTools() {
      return [];
    },
    async removeLocalTool() {
      return { ok: false, error: DESKTOP_RUNTIME_REQUIRED_MESSAGE };
    },
    async invokeLocalTool() {
      // "interpreter_not_configured"를 재사용하지 않는다 — 이 브라우저
      // 모드에서는 인터프리터 설정 여부와 무관하게 애초에 실행 경로 자체가
      // 없다(별도 이유가 필요하다는 Task Brief 지침).
      return { outcome: "spawn_error", message: DESKTOP_RUNTIME_REQUIRED_MESSAGE };
    },
  };
  return previewBridge;
}
