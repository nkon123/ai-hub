import { contextBridge, ipcRenderer } from "electron";
import type {
  ActivateKnowledgeResult,
  ActivateVersionResult,
  AssetDependencyView,
  AssetManifestResult,
  AssetRemovalCheck,
  AssetVersionDiffResponse,
  ChecksumVerification,
  ConnectMcpToolResult,
  ConnectionStatus,
  ConversationRecord,
  ConversationSummary,
  ConversationTurnStatus,
  DeactivateKnowledgeResult,
  DisconnectMcpToolResult,
  DesktopBridge,
  DesktopSettingsInput,
  DesktopSettingsPublic,
  DesktopSettingsUpdateResult,
  DiagnosticBundle,
  DiskSpaceInfo,
  ImportProgressEvent,
  ImportResult,
  InstalledAsset,
  InstalledAssetWithStatus,
  KnowledgeEmbedModelInfo,
  KnowledgeCandidate,
  LocalTool,
  LocalToolInvocationResult,
  LocalToolSignatureResult,
  LogEntry,
  LogFilters,
  OllamaChatInput,
  OllamaChatResult,
  OllamaModelsResult,
  OrphanedInstallCleanupResult,
  PortalCatalogResult,
  PortalSettingsPublic,
  ReconcileKnowledgeActivationsResult,
  ReconcileMcpToolConnectionsResult,
  ReconcileLocalAgentRegistrationsResult,
  RegisterLocalAgentResult,
  UnregisterLocalAgentResult,
  RemoveAssetResult,
  ServiceDetailResult,
  StoreInstallProgressEvent,
  StoreInstallResult,
  SystemInfoView,
} from "./types";

// `contextIsolation: true` + `nodeIntegration: false` (set in main.ts) mean
// the renderer has zero Node/Electron access unless explicitly granted here.
// Only the specific methods below are exposed — never `ipcRenderer` itself
// and never a raw Node API — per CLAUDE.md's contextBridge rule.
const bridge: DesktopBridge = {
  pickBundleFile: () => ipcRenderer.invoke("bundle:pickFile"),

  importBundle: (filePath: string): Promise<ImportResult> => ipcRenderer.invoke("bundle:import", filePath),

  onImportProgress: (cb: (event: ImportProgressEvent) => void) => {
    const listener = (_event: unknown, progress: ImportProgressEvent) => cb(progress);
    ipcRenderer.on("bundle:import-progress", listener);
    return () => ipcRenderer.removeListener("bundle:import-progress", listener);
  },

  listInstalledAssets: (): Promise<InstalledAssetWithStatus[]> => ipcRenderer.invoke("assets:list"),

  removeInstalledAsset: (assetType: string, assetId: string, version: string, reason: string): Promise<RemoveAssetResult> =>
    ipcRenderer.invoke("assets:remove", assetType, assetId, version, reason),

  checkConnections: (): Promise<ConnectionStatus[]> => ipcRenderer.invoke("connections:check"),
  getKnowledgeEmbedModels: (): Promise<KnowledgeEmbedModelInfo[]> =>
    ipcRenderer.invoke("knowledge:getEmbedModels"),

  getInstallRootPath: (): Promise<string> => ipcRenderer.invoke("app:getInstallRootPath"),

  checkAssetRemoval: (assetType: string, assetId: string, version: string): Promise<AssetRemovalCheck> =>
    ipcRenderer.invoke("assets:checkRemoval", assetType, assetId, version),

  getAssetManifest: (assetType: string, assetId: string, version: string): Promise<AssetManifestResult> =>
    ipcRenderer.invoke("assets:getManifest", assetType, assetId, version),

  reverifyAssetChecksum: (
    assetType: string,
    assetId: string,
    version: string,
  ): Promise<{ available: boolean; reason: string | null; result: ChecksumVerification | null }> =>
    ipcRenderer.invoke("assets:reverifyChecksum", assetType, assetId, version),

  getAssetDependencies: (assetType: string, assetId: string, version: string): Promise<AssetDependencyView> =>
    ipcRenderer.invoke("assets:getDependencies", assetType, assetId, version),

  // --- D06 대화: KNOWLEDGE_ROUTE 후보 조립(agentic Knowledge 선택) -------------
  getKnowledgeCandidates: (assets: InstalledAsset[]): Promise<KnowledgeCandidate[]> =>
    ipcRenderer.invoke("knowledge:getCandidates", assets),

  // --- D-079 Knowledge 활성화 --------------------------------------------------
  activateInstalledKnowledge: (assetType: string, assetId: string, version: string): Promise<ActivateKnowledgeResult> =>
    ipcRenderer.invoke("knowledge:activate", assetType, assetId, version),

  deactivateInstalledKnowledge: (assetType: string, assetId: string, version: string): Promise<DeactivateKnowledgeResult> =>
    ipcRenderer.invoke("knowledge:deactivate", assetType, assetId, version),

  reconcileKnowledgeActivations: (): Promise<ReconcileKnowledgeActivationsResult> =>
    ipcRenderer.invoke("knowledge:reconcileActivations"),

  // --- D-080 MCP Tool 연결 ----------------------------------------------------
  connectInstalledMcpTool: (assetType: string, assetId: string, version: string): Promise<ConnectMcpToolResult> =>
    ipcRenderer.invoke("mcpTool:connect", assetType, assetId, version),

  disconnectInstalledMcpTool: (assetType: string, assetId: string, version: string): Promise<DisconnectMcpToolResult> =>
    ipcRenderer.invoke("mcpTool:disconnect", assetType, assetId, version),

  reconcileMcpToolConnections: (): Promise<ReconcileMcpToolConnectionsResult> =>
    ipcRenderer.invoke("mcpTool:reconcileConnections"),

  // --- D-034 해석 경로 4: Local Agent 등록 ---------------------------------------
  registerLocalAgent: (
    agentAssetId: string,
    agentVersion: string,
    promptAssetId: string,
    promptVersion: string,
    label?: string | null,
  ): Promise<RegisterLocalAgentResult> =>
    ipcRenderer.invoke("localAgent:register", agentAssetId, agentVersion, promptAssetId, promptVersion, label),

  unregisterLocalAgent: (agentAssetId: string, agentVersion: string): Promise<UnregisterLocalAgentResult> =>
    ipcRenderer.invoke("localAgent:unregister", agentAssetId, agentVersion),

  reconcileLocalAgentRegistrations: (): Promise<ReconcileLocalAgentRegistrationsResult> =>
    ipcRenderer.invoke("localAgent:reconcileRegistrations"),

  // --- D12 업데이트/복구 -------------------------------------------------------
  diffAssetVersions: (
    assetType: string,
    assetId: string,
    fromVersion: string,
    toVersion: string,
  ): Promise<AssetVersionDiffResponse> =>
    ipcRenderer.invoke("update:diffVersions", assetType, assetId, fromVersion, toVersion),

  activateAssetVersion: (assetType: string, assetId: string, version: string, reason: string): Promise<ActivateVersionResult> =>
    ipcRenderer.invoke("update:activateVersion", assetType, assetId, version, reason),

  cleanupOrphanedInstalls: (): Promise<OrphanedInstallCleanupResult> => ipcRenderer.invoke("update:cleanupOrphans"),

  listLogs: (filters: LogFilters): Promise<LogEntry[]> => ipcRenderer.invoke("logs:list", filters),

  generateDiagnosticBundle: (filters: LogFilters): Promise<{ bundle: DiagnosticBundle; savedPath: string }> =>
    ipcRenderer.invoke("logs:generateDiagnosticBundle", filters),

  // --- 자산 스토어(Portal 카탈로그 설치) --------------------------------------
  getPortalSettings: (): Promise<PortalSettingsPublic> => ipcRenderer.invoke("store:getSettings"),

  setPortalBaseUrl: (baseUrl: string): Promise<PortalSettingsPublic> =>
    ipcRenderer.invoke("store:setBaseUrl", baseUrl),

  // Token 원문은 여기서 IPC 인자로 한 번만 넘어가고, 반환값은 다른 브리지
  // 메서드와 마찬가지로 "설정됨 여부"뿐이다 — main 프로세스가 값을 다시
  // 돌려주지 않는다.
  setPortalToken: (token: string): Promise<PortalSettingsPublic> => ipcRenderer.invoke("store:setToken", token),

  clearPortalToken: (): Promise<PortalSettingsPublic> => ipcRenderer.invoke("store:clearToken"),

  fetchPortalCatalog: (): Promise<PortalCatalogResult> => ipcRenderer.invoke("store:fetchCatalog"),

  installFromStore: (assetType: string, assetId: string, assetVersionId: string): Promise<StoreInstallResult> =>
    ipcRenderer.invoke("store:install", assetType, assetId, assetVersionId),

  onStoreInstallProgress: (cb: (event: StoreInstallProgressEvent) => void) => {
    const listener = (_event: unknown, progress: StoreInstallProgressEvent) => cb(progress);
    ipcRenderer.on("store:install-progress", listener);
    return () => ipcRenderer.removeListener("store:install-progress", listener);
  },

  cancelStoreInstall: (): Promise<void> => ipcRenderer.invoke("store:cancelInstall"),

  // --- D01 최초 설정 Wizard / D10 설정 ----------------------------------------
  getDesktopSettings: (): Promise<DesktopSettingsPublic> => ipcRenderer.invoke("settings:get"),

  updateDesktopSettings: (patch: DesktopSettingsInput): Promise<DesktopSettingsUpdateResult> =>
    ipcRenderer.invoke("settings:update", patch),

  markSetupCompleted: (): Promise<DesktopSettingsPublic> => ipcRenderer.invoke("settings:markSetupCompleted"),

  getDiskSpace: (): Promise<DiskSpaceInfo> => ipcRenderer.invoke("settings:getDiskSpace"),

  listOllamaModels: (ollamaBaseUrl: string): Promise<OllamaModelsResult> =>
    ipcRenderer.invoke("settings:listOllamaModels", ollamaBaseUrl),

  chatWithOllama: (input: OllamaChatInput): Promise<OllamaChatResult> => ipcRenderer.invoke("chat:ollama", input),

  cancelOllamaChat: (): Promise<void> => ipcRenderer.invoke("chat:ollamaCancel"),

  // --- D03 Service/Agent 상세 -------------------------------------------------
  getServiceDetail: (assetType: string, assetId: string, version: string): Promise<ServiceDetailResult> =>
    ipcRenderer.invoke("assets:getServiceDetail", assetType, assetId, version),

  // --- D13 정보/보안 -----------------------------------------------------------
  getSystemInfo: (): Promise<SystemInfoView> => ipcRenderer.invoke("system:getInfo"),

  // --- D06 대화 보존 (Desktop 대화 고도화/멀티턴) ------------------------------
  listConversations: (): Promise<ConversationSummary[]> => ipcRenderer.invoke("conversations:list"),

  getConversation: (id: string): Promise<ConversationRecord | null> =>
    ipcRenderer.invoke("conversations:get", id),

  createConversation: (knowledgeId: string, knowledgeLabel: string): Promise<ConversationRecord> =>
    ipcRenderer.invoke("conversations:create", knowledgeId, knowledgeLabel),

  appendConversationTurn: (
    conversationId: string,
    turn: { question: string; answer: string; status: ConversationTurnStatus; citationCount: number },
  ): Promise<ConversationRecord | null> => ipcRenderer.invoke("conversations:appendTurn", conversationId, turn),

  deleteConversation: (id: string, reason: string): Promise<{ ok: boolean; error: string | null }> =>
    ipcRenderer.invoke("conversations:delete", id, reason),

  // --- D-084 "Desktop 로컬 Tool" ------------------------------------------------
  pickLocalToolFile: (): Promise<string | null> => ipcRenderer.invoke("localTool:pickFile"),

  inspectLocalToolFile: (filePath: string): Promise<LocalToolSignatureResult> =>
    ipcRenderer.invoke("localTool:inspectFile", filePath),

  addLocalTool: (filePath: string, acknowledgedRisk: boolean): Promise<{ ok: boolean; tool: LocalTool | null; error: string | null }> =>
    ipcRenderer.invoke("localTool:add", filePath, acknowledgedRisk),

  listLocalTools: (): Promise<LocalTool[]> => ipcRenderer.invoke("localTool:list"),

  removeLocalTool: (id: string): Promise<{ ok: boolean; error: string | null }> =>
    ipcRenderer.invoke("localTool:remove", id),

  invokeLocalTool: (id: string, args: Record<string, unknown>): Promise<LocalToolInvocationResult> =>
    ipcRenderer.invoke("localTool:invoke", id, args),
};

contextBridge.exposeInMainWorld("desktop", bridge);
