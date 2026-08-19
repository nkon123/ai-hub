// Defensive accessor for the Electron preload bridge (M04).
//
// Screens MUST call getDesktopBridge() instead of touching `window.desktop`
// directly. The bridge is absent whenever the renderer runs outside the
// Desktop(Electron) shell — e.g. this Vite bundle opened directly in a
// browser tab for local development, or a preload script that failed to
// attach — and in that case screens must degrade to a calm "Desktop
// 런타임 필요" state instead of throwing. Per CLAUDE.md: "Desktop은 Runtime
// 장애 시 종료되지 않고 복구 안내를 제공한다."
//
// A SECOND, subtler failure mode (found 2026-08-13): `window.desktop` can
// exist but be *incomplete* — `src/global.d.ts` types it as the full
// `DesktopBridge` unconditionally, but the object is actually produced by
// the compiled `dist/electron/preload.js`. If that build artifact is stale
// (renderer rebuilt, preload not), the renderer ships methods the running
// preload never registered. TypeScript cannot catch this: the mismatch is
// between a fresh bundle and a stale build artifact, not between two source
// files. `bridge.reconcileKnowledgeActivations` missing this way already
// crashed the chat screen once (see `screens/chatTypes.ts`'s
// `resolveReconcileNotice`); `onStoreInstallProgress` missing this way was
// separately reproduced crashing the 자산 허브 screen
// (`TypeError: bridge.onStoreInstallProgress is not a function`, straight to
// the top-level ErrorBoundary). Per-call guards at each call site fix today's
// crash and nothing else the next time a method goes missing — so this file
// hardens the one chokepoint every screen already goes through instead.
import type { DesktopBridge } from "../electron/types";

/** Every method `DesktopBridge` declares, expressed as a
 * `Record<keyof DesktopBridge, true>` so adding/removing a method on the
 * interface without updating this list is a `pnpm typecheck` failure (same
 * technique `browserPreviewBridge.ts`'s `BrowserSettingsBridge` uses to stay
 * exhaustive) — this list can never silently drift from the real interface. */
const BRIDGE_METHOD_PRESENCE: Record<keyof DesktopBridge, true> = {
  pickBundleFile: true,
  importBundle: true,
  onImportProgress: true,
  listInstalledAssets: true,
  removeInstalledAsset: true,
  checkConnections: true,
  getKnowledgeEmbedModels: true,
  getInstallRootPath: true,
  checkAssetRemoval: true,
  getAssetManifest: true,
  reverifyAssetChecksum: true,
  getAssetDependencies: true,
  getKnowledgeCandidates: true,
  activateInstalledKnowledge: true,
  deactivateInstalledKnowledge: true,
  reconcileKnowledgeActivations: true,
  connectInstalledMcpTool: true,
  disconnectInstalledMcpTool: true,
  reconcileMcpToolConnections: true,
  registerLocalAgent: true,
  unregisterLocalAgent: true,
  reconcileLocalAgentRegistrations: true,
  diffAssetVersions: true,
  activateAssetVersion: true,
  cleanupOrphanedInstalls: true,
  listLogs: true,
  generateDiagnosticBundle: true,
  getPortalSettings: true,
  setPortalBaseUrl: true,
  setPortalToken: true,
  clearPortalToken: true,
  fetchPortalCatalog: true,
  installFromStore: true,
  onStoreInstallProgress: true,
  cancelStoreInstall: true,
  getDesktopSettings: true,
  updateDesktopSettings: true,
  markSetupCompleted: true,
  getDiskSpace: true,
  listOllamaModels: true,
  chatWithOllama: true,
  cancelOllamaChat: true,
  getServiceDetail: true,
  getSystemInfo: true,
  listConversations: true,
  getConversation: true,
  createConversation: true,
  appendConversationTurn: true,
  deleteConversation: true,
  generateAgentDraftSystemPrompt: true,
  cancelAgentDraftSystemPromptGeneration: true,
  pickAgentDraftExportDirectory: true,
  exportAgentDraft: true,
  uploadAgentDraft: true,
  cancelAgentDraftUpload: true,
  pickLocalToolFile: true,
  inspectLocalToolFile: true,
  addLocalTool: true,
  listLocalTools: true,
  removeLocalTool: true,
  invokeLocalTool: true,
  cancelLocalToolInvocation: true,
  approveLocalToolExecution: true,
  revokeLocalToolExecution: true,
  listSchedules: true,
  getSchedule: true,
  saveSchedule: true,
  removeSchedule: true,
  setScheduleActive: true,
  listScheduleHistory: true,
  cancelRunningSchedule: true,
  getRunningScheduleId: true,
  runNowSchedule: true,
};

const ALL_BRIDGE_METHOD_NAMES = Object.keys(BRIDGE_METHOD_PRESENCE) as Array<keyof DesktopBridge>;

/** Methods whose shape is `(cb) => unsubscribe`, called synchronously inside
 * a screen's `useEffect` with the return value used directly as the effect's
 * cleanup function — every other method on `DesktopBridge` is
 * promise-returning. Kept as an explicit allowlist (not inferred from name
 * prefix) so a future `on*`-named promise method doesn't silently get the
 * wrong stub shape. */
const SUBSCRIPTION_METHOD_NAMES: ReadonlySet<string> = new Set<keyof DesktopBridge>([
  "onImportProgress",
  "onStoreInstallProgress",
]);

/** Shown wherever a stubbed promise-returning method's rejection surfaces as
 * an error message — actionable rather than a raw "is not a function". */
export const STALE_BRIDGE_BUILD_MESSAGE =
  "이 기능은 현재 실행 중인 Desktop 앱 빌드에 없습니다. 앱을 완전히 종료했다가 다시 실행하세요(그래도 계속되면 최신 버전으로 다시 설치가 필요할 수 있습니다).";

// Deduped, module-level record of every bridge method observed missing —
// read via `getMissingBridgeMethods()` so the app can surface one banner
// instead of every screen discovering (and reporting) the same gap on its
// own.
const missingBridgeMethods = new Set<string>();

/** Names of `DesktopBridge` methods this session has found missing from the
 * actual `window.desktop` object (stale `preload.js`). Empty when the
 * bridge is either absent entirely or fully up to date. */
export function getMissingBridgeMethods(): string[] {
  return Array.from(missingBridgeMethods);
}

/** True when `name` was stubbed because the real bridge did not implement
 * it. Screens that render a live-progress subscription use this to show an
 * honest "실시간 진행 상황을 표시할 수 없습니다" notice instead of a
 * silently-empty progress area — a no-op subscription that produces no
 * events and no explanation is exactly the "제품이 사용자에게 거짓을
 * 말한다" failure this file exists to prevent. */
export function isBridgeMethodMissing(name: keyof DesktopBridge): boolean {
  return missingBridgeMethods.has(name);
}

function makeStub(name: keyof DesktopBridge): DesktopBridge[keyof DesktopBridge] {
  if (SUBSCRIPTION_METHOD_NAMES.has(name)) {
    // (cb) => unsubscribe — never throws, the returned unsubscribe is a
    // harmless no-op so the calling `useEffect`'s cleanup stays valid.
    return (() => () => {}) as DesktopBridge[keyof DesktopBridge];
  }
  // Every other method is promise-returning — reject, never resolve, so a
  // caller can never mistake "this build can't do that" for "the answer is
  // empty/false/zero".
  return (() => Promise.reject(new Error(STALE_BRIDGE_BUILD_MESSAGE))) as DesktopBridge[keyof DesktopBridge];
}

// Cache the wrapped/validated bridge per underlying `window.desktop` object
// identity — `preload.ts` attaches this object exactly once per renderer
// lifetime, so this amounts to computing the completeness check a single
// time. A fully up-to-date bridge is returned as-is (no wrapper object, no
// per-call indirection) — zero behavioral or allocation overhead versus the
// pre-hardening code path.
const wrappedBridgeCache = new WeakMap<DesktopBridge, DesktopBridge>();

function wrapBridge(raw: DesktopBridge): DesktopBridge {
  const cached = wrappedBridgeCache.get(raw);
  if (cached) return cached;

  const missing = ALL_BRIDGE_METHOD_NAMES.filter((name) => typeof raw[name] !== "function");
  if (missing.length === 0) {
    wrappedBridgeCache.set(raw, raw);
    return raw;
  }

  for (const name of missing) missingBridgeMethods.add(name);

  const patched: DesktopBridge = { ...raw };
  for (const name of missing) {
    (patched as unknown as Record<string, unknown>)[name] = makeStub(name);
  }
  wrappedBridgeCache.set(raw, patched);
  return patched;
}

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined" || !window.desktop) return null;
  return wrapBridge(window.desktop);
}
