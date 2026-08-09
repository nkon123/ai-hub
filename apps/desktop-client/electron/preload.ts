import { contextBridge, ipcRenderer } from "electron";
import type {
  ActivateVersionResult,
  AssetDependencyView,
  AssetManifestResult,
  AssetRemovalCheck,
  AssetVersionDiffResponse,
  ChecksumVerification,
  ConnectionStatus,
  DesktopBridge,
  DesktopSettingsInput,
  DesktopSettingsPublic,
  DesktopSettingsUpdateResult,
  DiagnosticBundle,
  DiskSpaceInfo,
  ImportProgressEvent,
  ImportResult,
  InstalledAssetWithStatus,
  LogEntry,
  LogFilters,
  OllamaModelsResult,
  OrphanedInstallCleanupResult,
  PortalCatalogResult,
  PortalSettingsPublic,
  RemoveAssetResult,
  StoreInstallProgressEvent,
  StoreInstallResult,
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
};

contextBridge.exposeInMainWorld("desktop", bridge);
