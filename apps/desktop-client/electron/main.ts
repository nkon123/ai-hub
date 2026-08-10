import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { freeBytesAt, importBundle, resolveInstallRoot, type InstallRootLayout } from "./bundle-install";
import { InstalledAssetsStore } from "./installed-assets-store";
import { ActiveVersionStore } from "./active-version-store";
import { checkAllConnections, listOllamaModels } from "./connections";
import { DesktopSettingsStore } from "./desktop-settings";
import {
  activateAssetVersion,
  assetInstallDir,
  checkAssetRemoval,
  cleanupOrphanedInstalls,
  diffAssetVersions,
  getAssetDependencyView,
  listInstalledAssetsWithStatus,
  readAssetManifest,
  reverifyAssetChecksum,
} from "./asset-management";
import { AppLogger } from "./app-logger";
import { filterLogEntries } from "./log-filter";
import { buildDiagnosticBundle, saveDiagnosticBundle } from "./diagnostic-bundle";
import { PortalSettingsStore } from "./portal-settings";
import { fetchCatalog, requestDistribution, getDistribution, downloadDistribution } from "./portal-client";
import { installFromStore, defaultSleep, type CancelToken } from "./store-install";
import { getServiceDetailView } from "./service-detail";
import { buildSystemInfo } from "./system-info";
import type {
  ActivateVersionResult,
  AssetDependencyView,
  AssetManifestResult,
  AssetRemovalCheck,
  AssetVersionDiffResponse,
  ChecksumVerification,
  DesktopSettingsInput,
  DesktopSettingsPublic,
  DesktopSettingsUpdateResult,
  DiagnosticBundle,
  DiskSpaceInfo,
  ImportProgressEvent,
  InstalledAssetWithStatus,
  LogEntry,
  LogFilters,
  OllamaModelsResult,
  OrphanedInstallCleanupResult,
  PortalCatalogResult,
  PortalSettingsPublic,
  RemoveAssetResult,
  ServiceDetailResult,
  StoreInstallProgressEvent,
  StoreInstallResult,
  SystemInfoView,
} from "./types";

// `app.isPackaged` (Electron's own signal) is used instead of `NODE_ENV`:
// it is false whenever the app runs unpackaged via `electron .` — exactly
// the dev workflow — and true once built/packaged, with no extra env var to
// wire through `pnpm`/`concurrently` (which would otherwise need a
// cross-platform shim like `cross-env` to work on Windows, the actual target
// OS per D-005).
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let installLayout: InstallRootLayout | null = null;
let appLogger: AppLogger | null = null;
let portalSettingsStore: PortalSettingsStore | null = null;
let desktopSettingsStore: DesktopSettingsStore | null = null;
// 자산 스토어는 한 번에 하나의 설치만 진행한다고 가정한다(PoC 범위) — 취소
// 버튼은 이 토큰을 통해 진행 중인 폴링/다운로드 루프에 협조적으로 신호를
// 보낸다(`store-install.ts`의 `CancelToken` 문서 참고).
let currentStoreInstallCancelToken: CancelToken | null = null;

function getLayout(): InstallRootLayout {
  if (!installLayout) {
    installLayout = resolveInstallRoot(app.getPath("userData"));
  }
  return installLayout;
}

function getPortalSettingsStore(): PortalSettingsStore {
  if (!portalSettingsStore) {
    portalSettingsStore = new PortalSettingsStore(getLayout().stateDir);
  }
  return portalSettingsStore;
}

function getDesktopSettingsStore(): DesktopSettingsStore {
  if (!desktopSettingsStore) {
    desktopSettingsStore = new DesktopSettingsStore(getLayout().stateDir);
  }
  return desktopSettingsStore;
}

/** D11's only log source — see `app-logger.ts`'s module docstring for why
 * call sites below only ever pass structured, minimal-content messages. */
function getLogger(): AppLogger {
  if (!appLogger) {
    appLogger = new AppLogger(getLayout().stateDir);
  }
  return appLogger;
}

/** Dev server can still be booting when Electron starts (both launched by
 * `concurrently`); retry instead of racing it. */
async function loadURLWithRetry(win: BrowserWindow, url: string, attempts = 30, delayMs = 300): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await win.loadURL(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // Final attempt — let the real error surface if it still fails.
  await win.loadURL(url);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Enterprise AI Asset Hub",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow = win;

  if (isDev) {
    void loadURLWithRetry(win, "http://localhost:5173");
    win.webContents.openDevTools();
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  win.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle("bundle:pickFile", async () => {
    const win = mainWindow;
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: "Offline Bundle 선택",
      filters: [{ name: "Offline Bundle (.zip)", extensions: ["zip"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("bundle:import", async (event, filePath: string) => {
    const layout = getLayout();
    const emit = (progress: ImportProgressEvent) => {
      event.sender.send("bundle:import-progress", progress);
    };
    const result = await importBundle(filePath, layout, emit);
    // 파일 경로(사용자가 고른 파일명)나 Manifest 내용은 기록하지 않는다 —
    // 결과 요약(성공/실패 단계, 설치된 자산 개수)만 남긴다.
    if (result.outcome === "SUCCESS") {
      getLogger().info("bundle-install", `Bundle 설치 성공 (자산 ${result.installPlan.length}개)`);
    } else {
      getLogger().error("bundle-install", `Bundle 설치 실패 (단계: ${result.failedStage ?? "미상"})`, {
        errorCode: result.failedStage ?? undefined,
      });
    }
    return result;
  });

  ipcMain.handle("assets:list", async (): Promise<InstalledAssetWithStatus[]> => {
    const layout = getLayout();
    return listInstalledAssetsWithStatus(layout, new InstalledAssetsStore(layout.stateDir));
  });

  ipcMain.handle(
    "assets:remove",
    async (_event, assetType: string, assetId: string, version: string, reason: string): Promise<RemoveAssetResult> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      // CLAUDE.md: 제거는 확인과 사유를 요구한다 — 렌더러(`ReasonConfirmDialog`)가
      // 이미 빈 사유를 막지만, 다른 호출 경로를 대비해 여기서도 다시 검증한다
      // (방어적 이중 검사, 이 파일의 다른 곳과 동일한 원칙).
      if (!reason || !reason.trim()) {
        return { ok: false, error: "제거 사유를 입력해야 합니다." };
      }
      const existing = store.find(assetType, assetId, version);
      if (!existing) {
        return { ok: false, error: "설치된 자산을 찾을 수 없습니다." };
      }
      // D08 하드 규칙: 제거 전 참조 중인 Service를 확인하고, 있으면 차단한다
      // (경고 후 진행 허용이 아니라 실제로 막는다). D08 화면은 이 검사를
      // `checkAssetRemoval` IPC로 먼저 미리 보여주지만, 다른 진입점(D02
      // 홈 화면의 제거 버튼 등)에서도 동일하게 지켜지도록 여기서도 다시
      // 검사한다 — `bundle-install.ts`가 경로 안전성을 추출 시점에 재확인하는
      // 것과 같은 방어적 이중 검사 원칙.
      const guard = checkAssetRemoval(layout, store, { assetType, assetId, version });
      if (guard.blocked) {
        const names = guard.referencingServices.map((s) => `${s.name} v${s.version}`).join(", ");
        // D12/D-068: an active-version block has neither a referencing
        // Service nor a blocking Run — it must not fall through to the
        // generic "Run이 있어" message, which would misreport why removal
        // was refused.
        const blockReasonMessage = names
          ? `다음 Service가 이 자산을 참조하고 있어 제거할 수 없습니다: ${names}`
          : guard.blockedByActiveVersion
            ? (guard.activeVersionNote ?? "이 버전은 현재 Active Version이라 제거할 수 없습니다.")
            : "이 자산을 사용 중인 Run이 있어 제거할 수 없습니다.";
        getLogger().warn(
          "asset-management",
          `자산 제거 차단: ${assetType}/${assetId}@${version} (참조 Service ${guard.referencingServices.length}건, Active Pointer 차단: ${guard.blockedByActiveVersion})`,
          { errorCode: "REMOVAL_BLOCKED" },
        );
        return { ok: false, error: blockReasonMessage, blockedBy: guard.referencingServices };
      }
      const dir = assetInstallDir(layout, assetType, assetId, version);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        store.remove(assetType, assetId, version);
        // D12/D-068: if that was the last installed version of this asset,
        // the Active Pointer would otherwise dangle, pointing at a version
        // that no longer exists on disk.
        const anyVersionsLeft = store.list().some((a) => a.assetType === assetType && a.assetId === assetId);
        if (!anyVersionsLeft) {
          new ActiveVersionStore(layout.stateDir).clear(assetType, assetId);
        }
        // Reason is a short operator-typed justification, not free-form
        // document/Prompt content — safe to log per CLAUDE.md's log policy
        // (this is exactly the kind of "structural, minimal" info app-logger
        // is meant to carry, same spirit as everywhere else in this file).
        getLogger().info("asset-management", `자산 제거 완료: ${assetType}/${assetId}@${version} (사유: ${reason.trim()})`);
        return { ok: true };
      } catch (err) {
        getLogger().error("asset-management", `자산 제거 실패: ${assetType}/${assetId}@${version}`, {
          errorCode: "REMOVAL_FAILED",
        });
        return { ok: false, error: err instanceof Error ? err.message : "삭제 중 오류가 발생했습니다." };
      }
    },
  );

  ipcMain.handle(
    "assets:checkRemoval",
    async (_event, assetType: string, assetId: string, version: string): Promise<AssetRemovalCheck> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      return checkAssetRemoval(layout, store, { assetType, assetId, version });
    },
  );

  ipcMain.handle(
    "assets:getManifest",
    async (_event, assetType: string, assetId: string, version: string): Promise<AssetManifestResult> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      const asset = store.find(assetType, assetId, version);
      if (!asset) {
        return { available: false, reason: "설치된 자산을 찾을 수 없습니다.", manifest: null };
      }
      return readAssetManifest(layout, asset);
    },
  );

  ipcMain.handle(
    "assets:reverifyChecksum",
    async (
      _event,
      assetType: string,
      assetId: string,
      version: string,
    ): Promise<{ available: boolean; reason: string | null; result: ChecksumVerification | null }> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      const outcome = reverifyAssetChecksum(layout, store, { assetType, assetId, version });
      if (outcome.available && outcome.result) {
        const logFn = outcome.result.result === "PASS" ? "info" : "error";
        getLogger()[logFn](
          "asset-management",
          `Checksum 재검사 ${outcome.result.result}: ${assetType}/${assetId}@${version} (불일치 ${outcome.result.mismatched.length}건, 누락 ${outcome.result.missing.length}건)`,
          outcome.result.result === "FAIL" ? { errorCode: "CHECKSUM_MISMATCH" } : {},
        );
      }
      return outcome;
    },
  );

  ipcMain.handle(
    "assets:getDependencies",
    async (_event, assetType: string, assetId: string, version: string): Promise<AssetDependencyView> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      const asset = store.find(assetType, assetId, version);
      if (!asset) {
        return {
          forward: [],
          forwardNote: "설치된 자산을 찾을 수 없습니다.",
          referencedBy: [],
        };
      }
      return getAssetDependencyView(layout, store, asset);
    },
  );

  // --- D12 업데이트/복구 -------------------------------------------------------
  ipcMain.handle(
    "update:diffVersions",
    async (
      _event,
      assetType: string,
      assetId: string,
      fromVersion: string,
      toVersion: string,
    ): Promise<AssetVersionDiffResponse> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      return diffAssetVersions(layout, store, { assetType, assetId, fromVersion, toVersion });
    },
  );

  ipcMain.handle(
    "update:activateVersion",
    async (
      _event,
      assetType: string,
      assetId: string,
      version: string,
      reason: string,
    ): Promise<ActivateVersionResult> => {
      // CLAUDE.md: 전환/Rollback도 확인과 사유를 요구한다 — 렌더러
      // (`ReasonConfirmDialog`)가 이미 강제하지만 여기서도 다시 검증한다.
      if (!reason || !reason.trim()) {
        return { ok: false, error: "전환 사유를 입력해야 합니다." };
      }
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      const result = activateAssetVersion(layout, store, { assetType, assetId, version });
      if (result.ok) {
        getLogger().info(
          "active-version",
          `Active Pointer 전환: ${assetType}/${assetId} -> v${version} (사유: ${reason.trim()})`,
        );
      } else {
        getLogger().warn("active-version", `Active Pointer 전환 거부: ${assetType}/${assetId}@${version}`, {
          errorCode: "ACTIVATE_VERSION_REJECTED",
        });
      }
      return result;
    },
  );

  ipcMain.handle("update:cleanupOrphans", async (): Promise<OrphanedInstallCleanupResult> => {
    const layout = getLayout();
    const store = new InstalledAssetsStore(layout.stateDir);
    const result = cleanupOrphanedInstalls(layout, store);
    if (result.removed.length > 0) {
      getLogger().info("update-recovery", `실패 설치 정리: ${result.removed.length}건 제거`);
    }
    return result;
  });

  ipcMain.handle("connections:check", async () => {
    const desktopSettings = getDesktopSettingsStore().getPublic();
    const results = await checkAllConnections({
      ollamaBaseUrl: desktopSettings.ollamaBaseUrl,
      mcpServerUrl: desktopSettings.mcpServerUrl,
      mcpServerAlias: desktopSettings.mcpServerAlias,
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      getLogger().warn("connections", `연결 확인 실패: ${failed.map((f) => f.label).join(", ")}`, {
        errorCode: "CONNECTION_CHECK_FAILED",
      });
    }
    return results;
  });

  ipcMain.handle("app:getInstallRootPath", async () => getLayout().root);

  // --- D11 로그/진단 ---------------------------------------------------------
  ipcMain.handle("logs:list", async (_event, filters: LogFilters): Promise<LogEntry[]> => {
    return filterLogEntries(getLogger().readAll(), filters ?? {});
  });

  ipcMain.handle(
    "logs:generateDiagnosticBundle",
    async (_event, filters: LogFilters): Promise<{ bundle: DiagnosticBundle; savedPath: string }> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      const bundle = await buildDiagnosticBundle(
        layout,
        store,
        getLogger().readAll(),
        filters ?? {},
        getPortalSettingsStore().getPublic(),
        getDesktopSettingsStore().getPublic(),
      );
      const savedPath = saveDiagnosticBundle(layout, bundle);
      getLogger().info("diagnostic-bundle", `진단 Bundle 생성 완료 (Log ${bundle.logs.length}건 포함)`);
      return { bundle, savedPath };
    },
  );

  // --- 자산 스토어(Portal 카탈로그 브라우징 + 설치) ---------------------------
  ipcMain.handle("store:getSettings", async (): Promise<PortalSettingsPublic> => {
    return getPortalSettingsStore().getPublic();
  });

  ipcMain.handle("store:setBaseUrl", async (_event, baseUrl: string): Promise<PortalSettingsPublic> => {
    return getPortalSettingsStore().setBaseUrl(baseUrl);
  });

  // Token 원문은 인자로만 지나가고 반환되지 않는다 — 로그에도 남기지 않는다
  // (CLAUDE.md: Secret을 Log에 기본 저장하지 않는다).
  ipcMain.handle("store:setToken", async (_event, token: string): Promise<PortalSettingsPublic> => {
    const result = getPortalSettingsStore().setToken(token);
    getLogger().info("portal-settings", "Portal 식별 Token이 갱신되었습니다.");
    return result;
  });

  ipcMain.handle("store:clearToken", async (): Promise<PortalSettingsPublic> => {
    const result = getPortalSettingsStore().clearToken();
    getLogger().info("portal-settings", "Portal 식별 Token이 삭제되었습니다.");
    return result;
  });

  ipcMain.handle("store:fetchCatalog", async (): Promise<PortalCatalogResult> => {
    const settings = getPortalSettingsStore();
    const baseUrl = settings.getBaseUrl();
    const token = settings.getToken();
    if (!baseUrl || !token) {
      return {
        ok: false,
        assets: [],
        error: "Portal 서버 주소와 식별 Token을 먼저 설정하세요.",
      };
    }
    const result = await fetchCatalog(baseUrl, token);
    if (!result.ok) {
      getLogger().warn("portal-catalog", `카탈로그 조회 실패: ${result.code}`, { errorCode: result.code });
      return { ok: false, assets: [], error: result.message };
    }
    return { ok: true, assets: result.data, error: null };
  });

  ipcMain.handle(
    "store:install",
    async (
      event,
      assetType: string,
      assetId: string,
      assetVersionId: string,
    ): Promise<StoreInstallResult> => {
      const layout = getLayout();
      const settings = getPortalSettingsStore();
      const baseUrl = settings.getBaseUrl();
      const token = settings.getToken();
      const emit = (progress: StoreInstallProgressEvent) => {
        event.sender.send("store:install-progress", progress);
      };
      if (!baseUrl || !token) {
        const message = "Portal 서버 주소와 식별 Token을 먼저 설정하세요.";
        emit({ stage: "REQUEST", status: "FAIL", message });
        return { outcome: "FAILED", failedStage: "REQUEST", message, cancelled: false, importResult: null, retryable: false };
      }

      const cancelToken: CancelToken = { cancelled: false };
      currentStoreInstallCancelToken = cancelToken;
      try {
        const result = await installFromStore(
          layout,
          { assetType, assetId, assetVersionId },
          { baseUrl, token },
          emit,
          {
            requestDistribution: (b, t, body) => requestDistribution(b, t, body),
            getDistribution: (b, t, id) => getDistribution(b, t, id),
            downloadDistribution: (b, t, id) => downloadDistribution(b, t, id),
            importBundle,
            writeTempFile: (data: Buffer) => {
              const tempPath = path.join(layout.quarantineDir, `${crypto.randomUUID()}-store-download.zip`);
              fs.mkdirSync(layout.quarantineDir, { recursive: true });
              fs.writeFileSync(tempPath, data);
              return tempPath;
            },
            removeTempFile: (filePath: string) => {
              fs.rmSync(filePath, { force: true });
            },
            sleep: defaultSleep,
            pollIntervalMs: 1500,
            maxPollAttempts: 60, // 최대 약 90초 대기 — PoC 규모 Bundle 기준.
          },
          cancelToken,
        );
        // Bundle Manifest/자산 이름 등 자유 텍스트는 절대 기록하지 않는다 —
        // bundle-install.ts의 IPC 핸들러와 동일한 원칙.
        if (result.outcome === "SUCCESS") {
          getLogger().info("store-install", `자산 스토어 설치 성공: ${assetType}/${assetId}`);
        } else if (result.cancelled) {
          getLogger().warn("store-install", `자산 스토어 설치 취소: ${assetType}/${assetId} (단계: ${result.failedStage ?? "미상"})`);
        } else {
          getLogger().error("store-install", `자산 스토어 설치 실패: ${assetType}/${assetId} (단계: ${result.failedStage ?? "미상"})`, {
            errorCode: result.failedStage ?? undefined,
          });
        }
        return result;
      } finally {
        currentStoreInstallCancelToken = null;
      }
    },
  );

  ipcMain.handle("store:cancelInstall", async (): Promise<void> => {
    if (currentStoreInstallCancelToken) {
      currentStoreInstallCancelToken.cancelled = true;
    }
  });

  // --- D01 최초 설정 Wizard / D10 설정 ----------------------------------------
  ipcMain.handle("settings:get", async (): Promise<DesktopSettingsPublic> => {
    return getDesktopSettingsStore().getPublic();
  });

  ipcMain.handle(
    "settings:update",
    async (_event, patch: DesktopSettingsInput): Promise<DesktopSettingsUpdateResult> => {
      const result = getDesktopSettingsStore().update(patch ?? {});
      if (result.ok) {
        // 값 자체(URL/Alias)는 운영 Secret이 아니라 설정된 사실만 기록한다 —
        // portal-settings의 "갱신되었습니다"류 로그와 같은 원칙.
        getLogger().info("desktop-settings", "Desktop 설정이 갱신되었습니다.");
      } else {
        getLogger().warn("desktop-settings", `Desktop 설정 갱신 거부: ${result.error ?? "알 수 없는 오류"}`, {
          errorCode: "DESKTOP_SETTINGS_INVALID",
        });
      }
      return result;
    },
  );

  ipcMain.handle("settings:markSetupCompleted", async (): Promise<DesktopSettingsPublic> => {
    const result = getDesktopSettingsStore().markSetupCompleted();
    getLogger().info("desktop-settings", "최초 설정 Wizard 완료");
    return result;
  });

  ipcMain.handle("settings:getDiskSpace", async (): Promise<DiskSpaceInfo> => {
    const layout = getLayout();
    return { path: layout.root, freeBytes: freeBytesAt(layout.root) };
  });

  ipcMain.handle(
    "settings:listOllamaModels",
    async (_event, ollamaBaseUrl: string): Promise<OllamaModelsResult> => {
      return listOllamaModels(ollamaBaseUrl || getDesktopSettingsStore().getPublic().ollamaBaseUrl);
    },
  );

  // --- D03 Service/Agent 상세 -------------------------------------------------
  ipcMain.handle(
    "assets:getServiceDetail",
    async (_event, assetType: string, assetId: string, version: string): Promise<ServiceDetailResult> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      return getServiceDetailView(layout, store, { assetType, assetId, version });
    },
  );

  // --- D13 정보/보안 -----------------------------------------------------------
  ipcMain.handle("system:getInfo", async (): Promise<SystemInfoView> => {
    return buildSystemInfo(getLayout());
  });
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
