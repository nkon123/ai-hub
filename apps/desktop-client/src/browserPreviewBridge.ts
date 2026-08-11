import {
  checkAllConnections,
  DEFAULT_MCP_SERVER_ALIAS,
  DEFAULT_MCP_SERVER_URL,
  DEFAULT_OLLAMA_BASE_URL,
  listOllamaModels,
} from "../electron/connections";
import { validateGenericUrl, validateNonEmpty, validateOllamaBaseUrl } from "../electron/network-policy";
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

export type BrowserSettingsBridge = Pick<
  DesktopBridge,
  | "getDesktopSettings"
  | "updateDesktopSettings"
  | "markSetupCompleted"
  | "getInstallRootPath"
  | "getDiskSpace"
  | "listOllamaModels"
  | "checkConnections"
  | "listConversations"
  | "getConversation"
  | "createConversation"
  | "appendConversationTurn"
  | "deleteConversation"
>;

export function createDefaultBrowserPreviewSettings(): DesktopSettingsPublic {
  return {
    clientDisplayName: null,
    siteId: null,
    ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
    ollamaAllowNonLoopback: false,
    chatModelAlias: DEFAULT_CHAT_MODEL_ALIAS,
    embeddingModelAlias: DEFAULT_EMBEDDING_MODEL_ALIAS,
    mcpServerAlias: DEFAULT_MCP_SERVER_ALIAS,
    mcpServerUrl: DEFAULT_MCP_SERVER_URL,
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

  const nonEmptyFields: Array<[keyof Pick<DesktopSettingsInput, "chatModelAlias" | "embeddingModelAlias" | "mcpServerAlias">, string]> = [
    ["chatModelAlias", "기본 Chat Model Alias"],
    ["embeddingModelAlias", "기본 Embedding Model Alias"],
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
      embeddingModelAlias:
        typeof parsed.embeddingModelAlias === "string" ? parsed.embeddingModelAlias : defaults.embeddingModelAlias,
      mcpServerAlias: typeof parsed.mcpServerAlias === "string" ? parsed.mcpServerAlias : defaults.mcpServerAlias,
      mcpServerUrl: typeof parsed.mcpServerUrl === "string" ? parsed.mcpServerUrl : defaults.mcpServerUrl,
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
    async checkConnections() {
      const settings = readSettings();
      return checkAllConnections({
        ollamaBaseUrl: settings.ollamaBaseUrl,
        mcpServerAlias: settings.mcpServerAlias,
        mcpServerUrl: settings.mcpServerUrl,
      });
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
  };
  return previewBridge;
}
