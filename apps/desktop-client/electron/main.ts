import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { freeBytesAt, importBundle, resolveInstallRoot, type InstallRootLayout } from "./bundle-install";
import { InstalledAssetsStore } from "./installed-assets-store";
import { ActiveVersionStore } from "./active-version-store";
import { ConversationStore } from "./conversation-store";
import { checkAllConnections, listOllamaModels, DEFAULT_RUNTIME_BASE_URL } from "./connections";
import { DesktopSettingsStore } from "./desktop-settings";
import { chatWithOllama } from "./ollama-chat";
import { buildSystemPromptDraftRequest, AGENT_DRAFT_TEMPLATE_FILE_NAME } from "./agent-draft";
import {
  activateAssetVersion,
  assetInstallDir,
  buildKnowledgeCandidatesForChat,
  checkAssetRemoval,
  cleanupOrphanedInstalls,
  diffAssetVersions,
  getAssetDependencyView,
  listInstalledAssetsWithStatus,
  listKnowledgeEmbedModels,
  readAssetManifest,
  recoverLegacyKnowledgeAssetVersionIds,
  reverifyAssetChecksum,
} from "./asset-management";
import {
  activateInstalledKnowledge,
  deactivateInstalledKnowledge,
  reconcileInstalledKnowledgeActivations,
} from "./knowledge-activation";
import { connectInstalledMcpTool, disconnectInstalledMcpTool, reconcileInstalledMcpToolConnections } from "./mcp-tool-connection";
import {
  registerInstalledLocalAgent,
  unregisterInstalledLocalAgent,
  reconcileInstalledLocalAgentRegistrations,
} from "./local-agent-registration";
import { analyzeLocalToolFile, parseLocalToolSignature } from "./local-tool-signature";
import { findToolNameConflict, hashLocalToolSource, LocalToolStore } from "./local-tool-store";
import { invokeLocalTool as runInvokeLocalTool } from "./local-tool-runner";
import { AppLogger } from "./app-logger";
import { filterLogEntries } from "./log-filter";
import { buildDiagnosticBundle, saveDiagnosticBundle } from "./diagnostic-bundle";
import { PortalSettingsStore } from "./portal-settings";
import { fetchCatalog, requestDistribution, getDistribution, downloadDistribution, createAsset } from "./portal-client";
import { uploadAgentDraft } from "./agent-draft-upload";
import { installFromStore, defaultSleep, type CancelToken } from "./store-install";
import { getServiceDetailView } from "./service-detail";
import { buildSystemInfo } from "./system-info";
import type {
  ActivateKnowledgeResult,
  ActivateVersionResult,
  AgentDraftExportInput,
  AgentDraftExportResult,
  AgentDraftUploadInput,
  AgentDraftUploadResult,
  AssetDependencyView,
  AssetManifestResult,
  AssetRemovalCheck,
  AssetVersionDiffResponse,
  ChecksumVerification,
  ConnectMcpToolResult,
  ConversationRecord,
  ConversationSummary,
  ConversationTurnStatus,
  DeactivateKnowledgeResult,
  DesktopSettingsInput,
  DesktopSettingsPublic,
  DesktopSettingsUpdateResult,
  DiagnosticBundle,
  DiskSpaceInfo,
  DisconnectMcpToolResult,
  ReconcileMcpToolConnectionsResult,
  ImportProgressEvent,
  InstalledAsset,
  InstalledAssetWithStatus,
  KnowledgeEmbedModelInfo,
  KnowledgeCandidate,
  LocalTool,
  LocalToolFileAnalysisResult,
  LocalToolInvocationResult,
  LogEntry,
  LogFilters,
  OllamaChatInput,
  OllamaChatResult,
  OllamaModelsResult,
  OrphanedInstallCleanupResult,
  PortalCatalogResult,
  PortalSettingsPublic,
  ReconcileKnowledgeActivationsResult,
  ReconcileLocalAgentRegistrationsResult,
  RegisterLocalAgentResult,
  UnregisterLocalAgentResult,
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
let conversationStore: ConversationStore | null = null;
let localToolStore: LocalToolStore | null = null;
let ollamaChatAbortController: AbortController | null = null;
// D06 "대화로 Agent 초안 만들기"의 시스템 프롬프트 생성 취소 대상 — 위
// `ollamaChatAbortController`(일반 대화 취소)와 별개다. 같은 변수를
// 공유하면 두 기능이 서로의 요청을 취소하게 된다.
let agentDraftAbortController: AbortController | null = null;
let agentDraftUploadAbortController: AbortController | null = null;
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

/** D-080 후속 — agent-runtime 주소는 이제 저장된 설정에서 온다. 이전에는
 * 이 Main Process가 `DEFAULT_RUNTIME_BASE_URL`을, 렌더러가 빌드 타임
 * `VITE_AGENT_RUNTIME_BASE_URL`을 각각 봤다: 사용자가 다른 포트로 띄우면
 * MCP Tool 등록만 조용히 옛 주소로 나갔고, 연결 배너는 대화가 멀쩡히 되는
 * 상태에서도 "끊김"을 표시했다(`apps/desktop-client/CLAUDE.md`의
 * "연결 판정 오탐"). 저장소가 비어 있으면 값 자체가 기본값이므로 여기서
 * 추가 fallback을 두지 않는다 — 기본값의 단일 출처는 계속 `connections.ts`다. */
function agentRuntimeBaseUrl(): string {
  return getDesktopSettingsStore().getPublic().agentRuntimeBaseUrl;
}

function getConversationStore(): ConversationStore {
  if (!conversationStore) {
    conversationStore = new ConversationStore(getLayout().stateDir);
  }
  return conversationStore;
}

/** D-084 — 완전히 별도의 저장소(`local-tools.json`)다. `InstalledAssetsStore`와
 * 절대 공유하지 않는다(electron/__tests__/local-tool-isolation.test.ts가
 * 이 분리를 소스 텍스트 검사로 강제한다). */
function getLocalToolStore(): LocalToolStore {
  if (!localToolStore) {
    localToolStore = new LocalToolStore(getLayout().stateDir);
  }
  return localToolStore;
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

  // D10 설정 — 편집 가능한 "임베딩 모델" 입력을 대체한다. 사용자가 고르는
  // 값이 아니라 각 Knowledge 색인이 이미 가진 사실을 읽어 보여줄 뿐이다.
  ipcMain.handle("knowledge:getEmbedModels", async (): Promise<KnowledgeEmbedModelInfo[]> => {
    const layout = getLayout();
    return listKnowledgeEmbedModels(layout, new InstalledAssetsStore(layout.stateDir));
  });

  ipcMain.handle("assets:list", async (): Promise<InstalledAssetWithStatus[]> => {
    const layout = getLayout();
    const store = new InstalledAssetsStore(layout.stateDir);
    const recovered = recoverLegacyKnowledgeAssetVersionIds(layout, store);
    if (recovered > 0) {
      getLogger().info("asset-migration", `이전 Bundle의 Knowledge 식별자 ${recovered}건을 검증 후 복구했습니다.`);
    }
    return listInstalledAssetsWithStatus(layout, store);
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
      // D-079 이어 붙이기: Knowledge를 지우면서 search-runtime 등록을 남겨
      //두지 않는다. search-runtime은 디렉터리가 사라진 등록을 스스로
      // 정리하므로(self-heal) 이 호출이 실패해도 제거 자체를 막을 이유는
      // 없다 — 그래도 명시적 등록 해제가 더 정직하므로 먼저 시도하고,
      // 결과와 무관하게 제거를 계속 진행한다(CLAUDE.md: Desktop은 Runtime
      // 장애 시 종료되지 않는다).
      let deactivationWarning: string | null = null;
      if (existing.assetType === "knowledge") {
        const baseUrl = getDesktopSettingsStore().getPublic().searchRuntimeBaseUrl;
        const deactivation = await deactivateInstalledKnowledge(store, baseUrl, { assetType, assetId, version });
        if (!deactivation.ok) {
          deactivationWarning = `search-runtime 등록 해제에 실패했습니다: ${deactivation.error ?? "알 수 없는 오류"} (제거는 계속 진행합니다)`;
        } else if (deactivation.remoteWarning) {
          deactivationWarning = deactivation.remoteWarning;
        }
        if (deactivationWarning) {
          getLogger().warn("knowledge-activation", `자산 제거 중 활성화 해제 경고: ${assetType}/${assetId}@${version} — ${deactivationWarning}`);
        }
      }
      // D-080 이어 붙이기: MCP Tool도 같은 원칙 — 제거하면서 agent-runtime
      // 등록을 남겨두지 않는다. `disconnectInstalledMcpTool`은 manifest를
      // 다시 읽어 tool_name을 구해야 하므로 파일 삭제(`fs.rmSync`) 전에
      // 호출해야 한다(그 이후에는 manifest.json 자체가 사라진다).
      if (existing.assetType === "mcp_tool") {
        const disconnection = await disconnectInstalledMcpTool(layout, store, agentRuntimeBaseUrl(), {
          assetType,
          assetId,
          version,
        });
        if (!disconnection.ok) {
          deactivationWarning = `agent-runtime 연결 해제에 실패했습니다: ${disconnection.error ?? "알 수 없는 오류"} (제거는 계속 진행합니다)`;
        } else if (disconnection.remoteWarning) {
          deactivationWarning = disconnection.remoteWarning;
        }
        if (deactivationWarning) {
          getLogger().warn("mcp-tool-connection", `자산 제거 중 연결 해제 경고: ${assetType}/${assetId}@${version} — ${deactivationWarning}`);
        }
      }
      // D-034 해석 경로 4 이어 붙이기: Agent를 지우면서 agent-runtime 등록을
      // 남겨두지 않는다 — 등록이 가리키는 디렉터리가 사라진 뒤 Run이
      // `LOCAL_AGENT_NOT_REGISTERED`로 실패하는 대신, 제거 시점에 정리한다
      // (Knowledge/MCP Tool과 동일한 원칙). DELETE는 agent_asset_id만
      // 필요하므로 파일 삭제 전/후 순서는 상관없다(Prompt와 달리 등록 해제에
      // manifest 재조회가 필요 없다).
      if (existing.assetType === "agent") {
        const unregistration = await unregisterInstalledLocalAgent(store, agentRuntimeBaseUrl(), {
          assetId,
          version,
        });
        if (!unregistration.ok) {
          deactivationWarning = `agent-runtime 등록 해제에 실패했습니다: ${unregistration.error ?? "알 수 없는 오류"} (제거는 계속 진행합니다)`;
        } else if (unregistration.remoteWarning) {
          deactivationWarning = unregistration.remoteWarning;
        }
        if (deactivationWarning) {
          getLogger().warn(
            "local-agent-registration",
            `자산 제거 중 등록 해제 경고: ${assetType}/${assetId}@${version} — ${deactivationWarning}`,
          );
        }
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
        return { ok: true, warning: deactivationWarning };
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

  // --- D06 대화: KNOWLEDGE_ROUTE 후보 조립(agentic Knowledge 선택) -------------
  // 렌더러가 이미 `partitionInstalledKnowledgeByActivation`으로 "검색 가능"
  // 판정을 마친 자산 목록을 그대로 받는다 — 이 핸들러는 그 판정을 다시
  // 계산하지 않고, fs로만 가능한 부분(각 자산의 manifest.json 읽기)만 한다.
  ipcMain.handle(
    "knowledge:getCandidates",
    async (_event, assets: InstalledAsset[]): Promise<KnowledgeCandidate[]> => {
      const layout = getLayout();
      return buildKnowledgeCandidatesForChat(layout, Array.isArray(assets) ? assets : []);
    },
  );

  // --- D-079 Knowledge 활성화 ("설치됨" ≠ "활성화됨") ---------------------------
  ipcMain.handle(
    "knowledge:activate",
    async (_event, assetType: string, assetId: string, version: string): Promise<ActivateKnowledgeResult> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      const baseUrl = getDesktopSettingsStore().getPublic().searchRuntimeBaseUrl;
      const result = await activateInstalledKnowledge(layout, store, baseUrl, { assetType, assetId, version });
      if (result.activation) {
        // ALREADY_ACTIVE(central_index_exists)는 실패가 아니다 — ACTIVE와
        // 함께 info로 남긴다. FAILED만 error 레벨(전자를 error로 로깅하면
        // 실제로는 검색되는 자산이 운영 로그에서 실패로 보인다).
        const logFn = result.activation.state === "FAILED" ? "error" : "info";
        getLogger()[logFn](
          "knowledge-activation",
          `Knowledge 활성화 ${result.activation.state}: ${assetType}/${assetId}@${version}` +
            (result.activation.reason ? ` (사유: ${result.activation.reason})` : ""),
          result.activation.state === "FAILED" ? { errorCode: result.activation.reason ?? undefined } : {},
        );
      } else {
        getLogger().warn(
          "knowledge-activation",
          `Knowledge 활성화 요청을 시도할 수 없음: ${assetType}/${assetId}@${version} (${result.error})`,
        );
      }
      return result;
    },
  );

  ipcMain.handle(
    "knowledge:deactivate",
    async (_event, assetType: string, assetId: string, version: string): Promise<DeactivateKnowledgeResult> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      const baseUrl = getDesktopSettingsStore().getPublic().searchRuntimeBaseUrl;
      const result = await deactivateInstalledKnowledge(store, baseUrl, { assetType, assetId, version });
      getLogger().info(
        "knowledge-activation",
        `Knowledge 비활성화: ${assetType}/${assetId}@${version}` +
          (result.remoteWarning ? ` (원격 경고: ${result.remoteWarning})` : ""),
      );
      return result;
    },
  );

  ipcMain.handle(
    "knowledge:reconcileActivations",
    async (): Promise<ReconcileKnowledgeActivationsResult> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      const baseUrl = getDesktopSettingsStore().getPublic().searchRuntimeBaseUrl;
      const result = await reconcileInstalledKnowledgeActivations(store, baseUrl);
      if (!result.checked) {
        getLogger().warn("knowledge-activation", `활성화 상태 재확인 불가: ${result.error}`);
      } else if (result.downgradedCount > 0) {
        getLogger().warn(
          "knowledge-activation",
          `활성화 상태 재확인 — search-runtime에 등록되지 않은 ${result.downgradedCount}건을 재활성화 필요 상태로 낮췄습니다.`,
          { errorCode: "not_registered_on_server" },
        );
      }
      return result;
    },
  );

  // --- D-080 MCP Tool 연결 ("설치됨" ≠ "연결됨") ---------------------------------
  ipcMain.handle(
    "mcpTool:connect",
    async (_event, assetType: string, assetId: string, version: string): Promise<ConnectMcpToolResult> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      const result = await connectInstalledMcpTool(layout, store, agentRuntimeBaseUrl(), {
        assetType,
        assetId,
        version,
      });
      if (result.activation) {
        const logFn =
          result.activation.reason === "mcp_tool_registration_disabled"
            ? "warn"
            : result.activation.state === "FAILED"
              ? "error"
              : "info";
        getLogger()[logFn](
          "mcp-tool-connection",
          `MCP Tool 연결 ${result.activation.state}: ${assetType}/${assetId}@${version}` +
            (result.activation.reason ? ` (사유: ${result.activation.reason})` : ""),
          result.activation.state === "FAILED" ? { errorCode: result.activation.reason ?? undefined } : {},
        );
      } else {
        getLogger().warn(
          "mcp-tool-connection",
          `MCP Tool 연결 요청을 시도할 수 없음: ${assetType}/${assetId}@${version} (${result.error})`,
        );
      }
      return result;
    },
  );

  ipcMain.handle(
    "mcpTool:disconnect",
    async (_event, assetType: string, assetId: string, version: string): Promise<DisconnectMcpToolResult> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      const result = await disconnectInstalledMcpTool(layout, store, agentRuntimeBaseUrl(), {
        assetType,
        assetId,
        version,
      });
      getLogger().info(
        "mcp-tool-connection",
        `MCP Tool 연결 해제: ${assetType}/${assetId}@${version}` +
          (result.remoteWarning ? ` (원격 경고: ${result.remoteWarning})` : ""),
      );
      return result;
    },
  );

  ipcMain.handle("mcpTool:reconcileConnections", async (): Promise<ReconcileMcpToolConnectionsResult> => {
    const layout = getLayout();
    const store = new InstalledAssetsStore(layout.stateDir);
    const result = await reconcileInstalledMcpToolConnections(layout, store, agentRuntimeBaseUrl());
    if (!result.checked) {
      getLogger().warn("mcp-tool-connection", `연결 상태 재확인 불가: ${result.error}`);
    } else if (result.downgradedCount > 0) {
      getLogger().warn("mcp-tool-connection", `agent-runtime 현재 상태와 다른 MCP Tool ${result.downgradedCount}건을 연결 필요 상태로 낮췄습니다.`);
    }
    return result;
  });

  // --- D-034 해석 경로 4: Local Agent 등록 ---------------------------------------
  ipcMain.handle(
    "localAgent:register",
    async (
      _event,
      agentAssetId: string,
      agentVersion: string,
      promptAssetId: string,
      promptVersion: string,
      label?: string | null,
    ): Promise<RegisterLocalAgentResult> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      const result = await registerInstalledLocalAgent(
        store,
        agentRuntimeBaseUrl(),
        { assetId: agentAssetId, version: agentVersion },
        { assetId: promptAssetId, version: promptVersion },
        label,
      );
      if (result.registration) {
        const logFn =
          result.registration.reason === "local_agents_disabled"
            ? "warn"
            : result.registration.state === "FAILED"
              ? "error"
              : "info";
        getLogger()[logFn](
          "local-agent-registration",
          `Local Agent 등록 ${result.registration.state}: ${agentAssetId}@${agentVersion}` +
            (result.registration.reason ? ` (사유: ${result.registration.reason})` : ""),
          result.registration.state === "FAILED" ? { errorCode: result.registration.reason ?? undefined } : {},
        );
      } else {
        getLogger().warn(
          "local-agent-registration",
          `Local Agent 등록 요청을 시도할 수 없음: ${agentAssetId}@${agentVersion} (${result.error})`,
        );
      }
      return result;
    },
  );

  ipcMain.handle(
    "localAgent:unregister",
    async (_event, agentAssetId: string, agentVersion: string): Promise<UnregisterLocalAgentResult> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      const result = await unregisterInstalledLocalAgent(store, agentRuntimeBaseUrl(), {
        assetId: agentAssetId,
        version: agentVersion,
      });
      getLogger().info(
        "local-agent-registration",
        `Local Agent 등록 해제: ${agentAssetId}@${agentVersion}` +
          (result.remoteWarning ? ` (원격 경고: ${result.remoteWarning})` : ""),
      );
      return result;
    },
  );

  ipcMain.handle(
    "localAgent:reconcileRegistrations",
    async (): Promise<ReconcileLocalAgentRegistrationsResult> => {
      const layout = getLayout();
      const store = new InstalledAssetsStore(layout.stateDir);
      const result = await reconcileInstalledLocalAgentRegistrations(store, agentRuntimeBaseUrl());
      if (!result.checked) {
        getLogger().warn("local-agent-registration", `등록 상태 재확인 불가: ${result.error}`);
      } else if (result.downgradedCount > 0) {
        getLogger().warn(
          "local-agent-registration",
          `agent-runtime 현재 상태와 다른 Local Agent ${result.downgradedCount}건을 등록 필요 상태로 낮췄습니다.`,
        );
      }
      return result;
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
      runtimeBaseUrl: desktopSettings.agentRuntimeBaseUrl,
      ollamaBaseUrl: desktopSettings.ollamaBaseUrl,
      mcpServerUrl: desktopSettings.mcpServerUrl,
      mcpServerAlias: desktopSettings.mcpServerAlias,
      searchRuntimeBaseUrl: desktopSettings.searchRuntimeBaseUrl,
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

  ipcMain.handle("chat:ollama", async (_event, input: OllamaChatInput): Promise<OllamaChatResult> => {
    const settings = getDesktopSettingsStore().getPublic();
    const controller = new AbortController();
    ollamaChatAbortController = controller;
    try {
      return await chatWithOllama(settings.ollamaBaseUrl, settings.chatModelAlias, input, controller.signal);
    } finally {
      if (ollamaChatAbortController === controller) ollamaChatAbortController = null;
    }
  });

  ipcMain.handle("chat:ollamaCancel", async (): Promise<void> => {
    ollamaChatAbortController?.abort();
  });

  // --- D06 대화 -> Agent 초안 (`electron/agent-draft.ts`) ----------------------
  // 대화 원문을 프롬프트에 그대로 넣지 않는다 — `liveQuestions`는 렌더러가
  // 이미 라이브(복원되지 않은) 턴의 질문 텍스트만 골라 넘긴다(답변 본문/
  // Citation 발췌는 절대 포함하지 않는다). 시스템 프롬프트 생성은 기존
  // `chatWithOllama`를 그대로 재사용하고, 취소는 `chat:ollamaCancel`과
  // 별개의 Abort Controller를 쓴다.
  ipcMain.handle(
    "agentDraft:generateSystemPrompt",
    async (_event, liveQuestions: string[]): Promise<OllamaChatResult> => {
      const settings = getDesktopSettingsStore().getPublic();
      const controller = new AbortController();
      agentDraftAbortController = controller;
      try {
        const request = buildSystemPromptDraftRequest(liveQuestions);
        return await chatWithOllama(settings.ollamaBaseUrl, settings.chatModelAlias, request, controller.signal);
      } finally {
        if (agentDraftAbortController === controller) agentDraftAbortController = null;
      }
    },
  );

  ipcMain.handle("agentDraft:cancelGenerateSystemPrompt", async (): Promise<void> => {
    agentDraftAbortController?.abort();
  });

  // 사용자가 입력한 파일명으로 경로를 만들지 않는다 — 디렉터리는 항상
  // `dialog.showOpenDialog`가 돌려준 절대 경로이고, 그 아래 세 파일명은
  // `agentDraft:export`가 고정한다(아래).
  ipcMain.handle("agentDraft:pickExportDirectory", async (): Promise<string | null> => {
    const win = mainWindow;
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: "Agent 초안을 저장할 폴더 선택",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(
    "agentDraft:export",
    async (_event, input: AgentDraftExportInput): Promise<AgentDraftExportResult> => {
      try {
        const agentPath = path.join(input.directory, "agent-manifest.json");
        const promptPath = path.join(input.directory, "prompt-manifest.json");
        const templatePath = path.join(input.directory, "template.md");
        fs.writeFileSync(agentPath, JSON.stringify(input.agentManifest, null, 2), "utf-8");
        fs.writeFileSync(promptPath, JSON.stringify(input.promptManifest, null, 2), "utf-8");
        fs.writeFileSync(templatePath, input.templateContent, "utf-8");
        // 대화 원문/생성된 프롬프트 원문/파일 경로는 로깅하지 않는다 —
        // 구조적 이벤트만 남긴다(conversation-store.ts와 동일한 로그 규율).
        getLogger().info("agent-draft", "Agent 초안 내보내기 완료(파일 3개)");
        return { ok: true, error: null, savedPath: input.directory };
      } catch (err) {
        const message = err instanceof Error ? err.message : "파일을 저장하지 못했습니다.";
        getLogger().error("agent-draft", "Agent 초안 내보내기 실패", { errorCode: "AGENT_DRAFT_EXPORT_FAILED" });
        return { ok: false, error: message, savedPath: null };
      }
    },
  );

  // --- Desktop Client PR2: 대화 -> Agent 초안을 Portal에 DRAFT로 등록 --------
  // Portal이 설정되지 않았으면(폐쇄형 신호) 방어적으로 거부한다 — 화면은
  // 이 상태에 도달하기 전에 업로드 진입점 자체를 숨겨야 한다(브리프 A항).
  // Agent와 Prompt는 별개 자산이라 `createAsset`을 두 번 호출하고, 하나가
  // 실패해도 다른 하나의 시도를 막지 않는다(브리프 D항 — 부분 실패를
  // 숨기지 않는다). 매니페스트 원문/프롬프트 원문/Token은 로그에 남기지
  // 않는다 — `agentDraft:export`와 같은 로그 규율(구조적 이벤트+오류코드만).
  ipcMain.handle(
    "agentDraft:upload",
    async (_event, input: AgentDraftUploadInput): Promise<AgentDraftUploadResult> => {
      const settings = getPortalSettingsStore();
      const controller = new AbortController();
      agentDraftUploadAbortController = controller;
      try {
        const result = await uploadAgentDraft(
          { baseUrl: settings.getBaseUrl(), token: settings.getToken() },
          input,
          AGENT_DRAFT_TEMPLATE_FILE_NAME,
          { createAsset: (b, t, manifest, files, signal) => createAsset(b, t, manifest, files, undefined, signal) },
          controller.signal,
        );

        if (!result.attempted) {
          getLogger().warn("agent-draft", "Agent 초안 Portal 등록 거부 — Portal 미설정", {
            errorCode: "PORTAL_NOT_CONFIGURED",
          });
        } else if (result.agent?.ok && result.prompt?.ok) {
          getLogger().info("agent-draft", "Agent 초안 Portal 등록 완료(Agent+Prompt DRAFT 2건)");
        } else {
          getLogger().warn(
            "agent-draft",
            `Agent 초안 Portal 등록 부분/전체 실패 (agent: ${result.agent?.ok ? "성공" : "실패"}, prompt: ${
              result.prompt?.ok ? "성공" : "실패"
            })`,
            { errorCode: (!result.agent?.ok ? result.agent?.errorCode : result.prompt?.errorCode) ?? undefined },
          );
        }
        return result;
      } finally {
        if (agentDraftUploadAbortController === controller) agentDraftUploadAbortController = null;
      }
    },
  );

  ipcMain.handle("agentDraft:cancelUpload", async (): Promise<void> => {
    agentDraftUploadAbortController?.abort();
  });

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

  // --- D06 대화 보존 (Desktop 대화 고도화/멀티턴) — 질문/답변 원문은
  // 민감 데이터다(`conversation-store.ts` 모듈 docstring). 아래 핸들러는
  // 구조적 이벤트만 로깅하고 절대 질문/답변 내용을 `getLogger()`에 넘기지
  // 않는다 — 예외는 삭제 "사유"뿐이며, `assets:remove`가 이미 확립한 선례를
  // 그대로 따른다(운영자가 직접 입력한 짧은 정당화 텍스트는 로깅해도
  // 안전하다).
  ipcMain.handle("conversations:list", async (): Promise<ConversationSummary[]> => {
    return getConversationStore().list();
  });

  ipcMain.handle(
    "conversations:get",
    async (_event, id: string): Promise<ConversationRecord | null> => {
      return getConversationStore().get(id);
    },
  );

  ipcMain.handle(
    "conversations:create",
    async (_event, knowledgeId: string, knowledgeLabel: string): Promise<ConversationRecord> => {
      const record = getConversationStore().create(knowledgeId, knowledgeLabel);
      getLogger().info("conversation-store", `대화 생성됨: ${record.id}`);
      return record;
    },
  );

  ipcMain.handle(
    "conversations:appendTurn",
    async (
      _event,
      conversationId: string,
      turn: { question: string; answer: string; status: ConversationTurnStatus; citationCount: number },
    ): Promise<ConversationRecord | null> => {
      const updated = getConversationStore().appendTurn(conversationId, turn);
      getLogger().info(
        "conversation-store",
        `대화 턴 추가됨: ${conversationId} (status=${turn.status}, citation_count=${turn.citationCount})`,
      );
      return updated;
    },
  );

  ipcMain.handle(
    "conversations:delete",
    async (_event, id: string, reason: string): Promise<{ ok: boolean; error: string | null }> => {
      // CLAUDE.md: 삭제는 확인과 사유를 요구한다 — 렌더러(`ReasonConfirmDialog`)가
      // 이미 빈 사유를 막지만, `assets:remove`와 동일하게 여기서도 다시
      // 검증한다(방어적 이중 검사).
      const result = getConversationStore().remove(id, reason);
      if (result.ok) {
        getLogger().info("conversation-store", `대화 삭제됨: ${id} (사유: ${reason.trim()})`);
      }
      return result;
    },
  );

  // --- D-084 "Desktop 로컬 Tool" -----------------------------------------------
  // 구조적으로 D-083 TOOL_ROUTE/D-080 등록과 분리되어 있다 — 이 핸들러들은
  // agent-runtime을 절대 호출하지 않는다. 파일 경로는 항상
  // `dialog.showOpenDialog`에서만 나오고(사용자가 입력한 파일명으로 경로를
  // 만들지 않는다), 저장 식별자는 항상 `LocalToolStore.add()`가 만드는
  // `crypto.randomUUID()`다.
  ipcMain.handle("localTool:pickFile", async (): Promise<string | null> => {
    const win = mainWindow;
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: "로컬 Tool로 사용할 Python 파일 선택",
      filters: [{ name: "Python", extensions: ["py"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(
    "localTool:inspectFile",
    async (_event, filePath: string): Promise<LocalToolFileAnalysisResult> => {
      let source: string;
      try {
        source = fs.readFileSync(filePath, "utf-8");
      } catch (err) {
        return {
          ok: false,
          reason: "file_unreadable",
          message: `파일을 읽을 수 없습니다: ${err instanceof Error ? err.message : "알 수 없는 오류"}`,
        };
      }
      // `@tool`/`@mcp.tool`이 붙은 함수가 있으면 그 함수들 전부를, 없고
      // 최상위 함수가 하나뿐이면 그 함수 하나를(기존 동작, 회귀 없음)
      // 후보로 돌려준다. 데코레이터 없이 함수가 여럿이면 여기서 그대로
      // `multiple_functions_found`로 거절된다.
      return analyzeLocalToolFile(source);
    },
  );

  ipcMain.handle(
    "localTool:add",
    async (
      _event,
      filePath: string,
      acknowledgedRisk: boolean,
      functionName?: string,
    ): Promise<{ ok: boolean; tool: LocalTool | null; error: string | null }> => {
      // 렌더러가 왕복시킨 Schema를 신뢰하지 않고 서버 측에서 파일을 다시
      // 읽어 다시 분석한다(Task Brief) — 그 사이 파일이 바뀌었거나 렌더러가
      // 조작된 값을 보냈더라도 실제로 저장되는 Schema는 항상 지금 이 순간의
      // 파일 내용을 반영한다. `functionName`을 생략하면 기존 단일-함수
      // 동작 그대로다(회귀 없음) — `@tool`로 여러 함수를 등록할 때는
      // 렌더러가 이 IPC를 함수마다 한 번씩, `functionName`을 채워서 호출한다.
      let source: string;
      try {
        source = fs.readFileSync(filePath, "utf-8");
      } catch (err) {
        return {
          ok: false,
          tool: null,
          error: `파일을 읽을 수 없습니다: ${err instanceof Error ? err.message : "알 수 없는 오류"}`,
        };
      }
      const parsed = parseLocalToolSignature(source, functionName);
      if (!parsed.ok) {
        return { ok: false, tool: null, error: parsed.message };
      }
      // 이름 충돌은 조용히 넘어가지 않는다(Task Brief C) — 같은 파일 내부의
      // 다른 함수(이 배치에서 앞서 등록됨)든, 완전히 다른 파일에서 이미
      // 등록된 Tool이든 상관없이 `toolName`이 겹치면 저장을 거부한다.
      const conflict = findToolNameConflict(getLocalToolStore().list(), parsed.toolName);
      if (conflict) {
        return {
          ok: false,
          tool: null,
          error: `이미 등록된 로컬 Tool 이름과 같습니다: '${parsed.toolName}' (파일: ${conflict.filePath}). 함수 이름을 바꾸거나 기존 Tool을 먼저 제거하세요.`,
        };
      }
      const result = getLocalToolStore().add(
        {
          filePath,
          functionName: parsed.functionName,
          toolName: parsed.toolName,
          inputSchema: parsed.inputSchema,
          parameters: parsed.parameters,
          discarded: parsed.discarded,
          warnings: parsed.warnings,
        },
        acknowledgedRisk,
      );
      if (!result.ok) {
        return { ok: false, tool: null, error: result.error };
      }
      getLogger().info("local-tool", `로컬 Tool 추가됨: ${result.tool.toolName} (${result.tool.id})`);
      return { ok: true, tool: result.tool, error: null };
    },
  );

  ipcMain.handle("localTool:list", async (): Promise<LocalTool[]> => {
    return getLocalToolStore().list();
  });

  ipcMain.handle("localTool:remove", async (_event, id: string): Promise<{ ok: boolean; error: string | null }> => {
    const result = getLocalToolStore().remove(id);
    if (result.ok) {
      getLogger().info("local-tool", `로컬 Tool 제거됨: ${id}`);
    }
    return result;
  });

  // D-084 후속 3 ("최초 한번만 승인") — 자산 > 로컬 Tool 화면의 "실행 허용"
  // 전용. 렌더러가 무엇을 승인했다고 주장하든 신뢰하지 않는다: 여기서
  // `filePath`를 다시 읽어(fail-closed — 읽기 실패면 승인하지 않는다)
  // Main Process 스스로 해시를 계산해 저장한다.
  ipcMain.handle(
    "localTool:approveExecution",
    async (_event, id: string): Promise<{ ok: boolean; tool: LocalTool | null; error: string | null }> => {
      const tool = getLocalToolStore().find(id);
      if (!tool) {
        return { ok: false, tool: null, error: "로컬 Tool을 찾을 수 없습니다." };
      }
      let source: string;
      try {
        source = fs.readFileSync(tool.filePath, "utf-8");
      } catch (err) {
        return {
          ok: false,
          tool: null,
          error: `파일을 읽을 수 없어 실행을 허용할 수 없습니다: ${err instanceof Error ? err.message : "알 수 없는 오류"}`,
        };
      }
      const result = getLocalToolStore().approve(id, hashLocalToolSource(source));
      if (result.ok) {
        getLogger().info("local-tool", `로컬 Tool 실행 자동 허용됨: ${tool.toolName} (${id})`);
        return { ok: true, tool: result.tool, error: null };
      }
      return { ok: false, tool: null, error: result.error };
    },
  );

  ipcMain.handle(
    "localTool:revokeExecution",
    async (_event, id: string): Promise<{ ok: boolean; tool: LocalTool | null; error: string | null }> => {
      const result = getLocalToolStore().revoke(id);
      if (result.ok) {
        getLogger().info("local-tool", `로컬 Tool 실행 허용 철회됨: ${id}`);
        return { ok: true, tool: result.tool, error: null };
      }
      return { ok: false, tool: null, error: result.error };
    },
  );

  ipcMain.handle(
    "localTool:invoke",
    async (
      _event,
      id: string,
      args: Record<string, unknown>,
      options?: { aiSelected?: boolean },
    ): Promise<LocalToolInvocationResult> => {
      const tool = getLocalToolStore().find(id);
      if (!tool) {
        return { outcome: "spawn_error", message: "로컬 Tool을 찾을 수 없습니다." };
      }
      // 승인 여부 판정은 항상 여기, Main Process에서만 한다 — 렌더러가
      // "승인됐다"고 주장하는 값을 받지 않는다(이 IPC 인자 목록에 그런
      // 값이 아예 없다). 파일을 지금 다시 읽어(fail-closed) 현재 내용의
      // 해시를 계산하고, 저장된 승인의 해시와 비교한다 — 경로가 아니라
      // 내용에 승인을 묶는다(D-084 후속 3). 읽기 자체가 실패하면(파일
      // 이동/삭제/권한 문제) 승인 여부와 무관하게 실행하지 않는다.
      let currentSource: string;
      try {
        currentSource = fs.readFileSync(tool.filePath, "utf-8");
      } catch (err) {
        getLogger().error("local-tool", `로컬 Tool 실행 불가(파일 읽기 실패): ${tool.toolName} (${id})`);
        return {
          outcome: "spawn_error",
          message: `파일을 읽을 수 없어 실행하지 않았습니다: ${err instanceof Error ? err.message : "알 수 없는 오류"}`,
        };
      }
      const currentHash = hashLocalToolSource(currentSource);
      const storedApproval = tool.approval;
      const approvalStillValid = storedApproval !== null && storedApproval.approvedFileHash === currentHash;

      if (!approvalStillValid) {
        // 승인 기록이 없거나(한 번도 허용한 적 없음) 무효(파일 내용이 승인
        // 이후 바뀜) — 지금까지와 동일하게 실행 직전 Main Process가 직접
        // 네이티브 대화상자로 묻는다. 렌더러(LocalToolsScreen)의 확인
        // 단계와 중복처럼 보이지만 중복이 아니다 — Electron에서 신뢰 경계는
        // Main Process이고, 렌더러만 확인을 담당하면 이 브릿지에 도달하는
        // 다른 코드 경로가 승인 없이 사용자 권한으로 Python을 실행할 수
        // 있다. 그것이 구현 원칙 7이 금지하는 "승인되지 않은 임의 Python
        // 실행"이다(D-084). 이 대화상자에서 사용자가 실행을 눌러도 그
        // 승인은 이 1회 실행에만 적용되고 저장되지 않는다 — 영구 허용은
        // 오직 자산 > 로컬 Tool 화면의 "실행 허용"으로만 만들 수 있다.
        const win = mainWindow;
        if (!win) {
          return { outcome: "spawn_error", message: "창이 없어 실행 승인을 받을 수 없습니다." };
        }
        const staleApprovalNotice =
          storedApproval !== null
            ? "파일 내용이 승인 이후 변경되어 이전 승인이 무효화되었습니다 — 다시 확인해야 합니다.\n\n"
            : "";
        // D-084 후속(채팅 자동 라우팅) — Tool 선택과 인자를 사람이 아니라
        // AI가 정했을 때는 승인 대화상자 문구가 그 사실을 반드시 밝힌다(Task
        // Brief 제약 C: D-083의 "인자가 AI 파생이면 확인 문구가 그 사실을
        // 밝힌다" 규칙의 확장). 승인 절차 자체는 aiSelected 여부와 무관하게
        // 항상 동일하게 거친다 — 문구만 달라진다.
        const aiSelectedNotice = options?.aiSelected
          ? "이 Tool 선택과 인자는 모두 AI가 스스로 결정했습니다 — 사람이 입력하지 않았습니다.\n\n"
          : "";
        const approvalDialog = await dialog.showMessageBox(win, {
          type: "warning",
          buttons: ["실행", "취소"],
          defaultId: 1,
          cancelId: 1,
          title: "로컬 Tool 실행 승인",
          message: `'${tool.toolName}'을(를) 실행할까요?`,
          detail:
            staleApprovalNotice +
            aiSelectedNotice +
            `파일: ${tool.filePath}\n함수: ${tool.functionName}\n인자: ${JSON.stringify(args ?? {})}\n\n` +
            "이 코드는 격리되지 않은 상태로, 사용자의 권한으로 실행됩니다 — 직접 실행한 것과 동일합니다.\n\n" +
            "매번 묻지 않으려면 자산 > 로컬 Tool에서 이 Tool의 실행을 허용하세요.",
        });
        if (approvalDialog.response !== 0) {
          getLogger().info("local-tool", `로컬 Tool 실행 거부됨: ${tool.toolName} (${id})`);
          return { outcome: "user_denied" };
        }
      } else {
        getLogger().info("local-tool", `사전 허용됨(대화상자 생략): ${tool.toolName} (${id})`);
      }

      const interpreterPath = getDesktopSettingsStore().getPublic().pythonInterpreterPath;
      const result = await runInvokeLocalTool({
        interpreterPath,
        modulePath: tool.filePath,
        functionName: tool.functionName,
        args: args ?? {},
      });
      // 실행 결과에는 인자 값(사용자 입력)도, 반환값 원문도 기록하지 않는다
      // — outcome만 남긴다(CLAUDE.md: Log에 Prompt 원문/문서 전체를 기본
      // 저장하지 않는다는 원칙과 같은 정신).
      const logFn = result.outcome === "success" ? "info" : result.outcome === "interpreter_not_configured" ? "warn" : "error";
      getLogger()[logFn]("local-tool", `로컬 Tool 실행 ${result.outcome}: ${tool.toolName} (${id})`);
      return result;
    },
  );
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
