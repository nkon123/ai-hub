// Covers the 2026-08-13 hardening of getDesktopBridge() (see this file's own
// module docstring in `bridge.ts`): a stale `dist/electron/preload.js` can
// expose `window.desktop` with some `DesktopBridge` methods missing, and
// TypeScript cannot catch that mismatch (it's a build-artifact-vs-bundle gap,
// not a source-vs-source one). These tests exercise the runtime fallback
// directly against a hand-built `window.desktop` object, the same way a
// stale preload build would actually look at runtime.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge, DesktopSettingsPublic, DiagnosticBundle, SystemInfoView, ConversationRecord } from "../electron/types";

const SETTINGS: DesktopSettingsPublic = {
  clientDisplayName: null,
  siteId: null,
  ollamaBaseUrl: "http://127.0.0.1:11434",
  ollamaAllowNonLoopback: false,
  chatModelAlias: "default-chat",
  mcpServerAlias: "default-mcp",
  mcpServerUrl: "http://127.0.0.1:8500",
  searchRuntimeBaseUrl: "http://127.0.0.1:8300",
  maxConcurrentRuns: { value: 1, enforced: false, reason: "" },
  setupCompletedAt: null,
  updatedAt: null,
};

const DIAGNOSTIC_BUNDLE: DiagnosticBundle = {
  generatedAt: "2026-08-13T00:00:00.000Z",
  clientVersion: "test",
  runtimeVersion: null,
  runtimeVersionNote: "",
  os: { platform: "test", release: "-", arch: "-" },
  pythonVersion: null,
  pythonVersionNote: "",
  sanitizedSettings: {},
  installedAssets: [],
  health: [],
  logs: [],
};

const SYSTEM_INFO: SystemInfoView = {
  clientVersion: "test",
  runtimeVersion: null,
  runtimeVersionNote: null,
  schemaVersion: { supportedVersion: "1.0.0", source: "test" },
  os: { platform: "test", release: "-", arch: "-" },
  trustStore: { status: "NOT_IMPLEMENTED", message: "" },
  revocationList: { knownEntryCount: 0, lastLocalUpdateAt: null, note: "" },
  openSourceNotices: { entries: [], incomplete: true, incompleteReason: "" },
  dataLocations: {
    installRoot: "",
    assetsDir: "",
    stateDir: "",
    logsDir: "",
    quarantineDir: "",
    profilesDir: "",
    diagnosticsDir: "",
  },
};

const CONVERSATION: ConversationRecord = {
  id: "conv-1",
  knowledgeId: "kb-1",
  knowledgeLabel: "테스트 Knowledge",
  title: "테스트 대화",
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
  turns: [],
};

/** A fully-implemented `DesktopBridge` — every method present, matching what
 * an up-to-date `preload.js` would expose. Used as the base for both the
 * "complete bridge" test and, with individual keys `delete`d, the
 * "incomplete bridge" tests. */
function createCompleteBridge(): DesktopBridge {
  return {
    async pickBundleFile() {
      return null;
    },
    async importBundle() {
      return {
        outcome: "SUCCESS",
        checks: [],
        failedStage: null,
        retryable: false,
        manifest: null,
        installPlan: [],
        totalSizeBytes: 0,
      };
    },
    onImportProgress() {
      return () => {};
    },
    async listInstalledAssets() {
      return [];
    },
    async removeInstalledAsset() {
      return { ok: true };
    },
    async checkConnections() {
      return [];
    },
    async getInstallRootPath() {
      return "";
    },
    async checkAssetRemoval() {
      return {
        blocked: false,
        referencingServices: [],
        runCheckAvailable: true,
        runCheckNote: "",
        blockedByActiveVersion: false,
        activeVersionNote: null,
      };
    },
    async getAssetManifest() {
      return { available: false, reason: null, manifest: null };
    },
    async reverifyAssetChecksum() {
      return { available: false, reason: null, result: null };
    },
    async getAssetDependencies() {
      return { forward: [], forwardNote: null, referencedBy: [] };
    },
    async getKnowledgeCandidates() {
      return [];
    },
    async activateInstalledKnowledge() {
      return { ok: false, activation: null, error: null };
    },
    async deactivateInstalledKnowledge() {
      return { ok: false, remoteWarning: null, error: null };
    },
    async reconcileKnowledgeActivations() {
      return { checked: true, downgradedCount: 0, error: null };
    },
    async diffAssetVersions() {
      return { available: false, reason: null, diff: null };
    },
    async activateAssetVersion() {
      return { ok: true, error: null };
    },
    async cleanupOrphanedInstalls() {
      return { removed: [] };
    },
    async listLogs() {
      return [];
    },
    async generateDiagnosticBundle() {
      return { bundle: DIAGNOSTIC_BUNDLE, savedPath: "" };
    },
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
      return { ok: true, assets: [], error: null };
    },
    async installFromStore() {
      return {
        outcome: "SUCCESS",
        failedStage: null,
        message: "",
        cancelled: false,
        importResult: null,
        retryable: false,
      };
    },
    onStoreInstallProgress() {
      return () => {};
    },
    async cancelStoreInstall() {},
    async getDesktopSettings() {
      return SETTINGS;
    },
    async updateDesktopSettings() {
      return { ok: true, error: null, settings: SETTINGS };
    },
    async markSetupCompleted() {
      return SETTINGS;
    },
    async getDiskSpace() {
      return { path: "", freeBytes: 0 };
    },
    async listOllamaModels() {
      return { ok: true, models: [], error: null };
    },
    async chatWithOllama() {
      return { answer: "", model: "" };
    },
    async cancelOllamaChat() {},
    async getServiceDetail() {
      return { available: false, reason: null, detail: null };
    },
    async getSystemInfo() {
      return SYSTEM_INFO;
    },
    async listConversations() {
      return [];
    },
    async getConversation() {
      return null;
    },
    async createConversation() {
      return CONVERSATION;
    },
    async appendConversationTurn() {
      return null;
    },
    async getKnowledgeEmbedModels() {
      return [];
    },
    async deleteConversation() {
      return { ok: true, error: null };
    },
  };
}

function setWindowDesktop(desktop: DesktopBridge | undefined): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { desktop },
  });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("getDesktopBridge() — no bridge at all", () => {
  it("returns null when window itself does not exist (unaffected by this change)", async () => {
    Reflect.deleteProperty(globalThis, "window");
    const { getDesktopBridge } = await import("./bridge");
    expect(getDesktopBridge()).toBeNull();
  });

  it("returns null when window.desktop is undefined (browser dev mode)", async () => {
    setWindowDesktop(undefined);
    const { getDesktopBridge } = await import("./bridge");
    expect(getDesktopBridge()).toBeNull();
  });
});

describe("getDesktopBridge() — complete bridge (up-to-date preload.js)", () => {
  it("returns the bridge unchanged, records nothing missing, and behaves identically to before", async () => {
    const raw = createCompleteBridge();
    setWindowDesktop(raw);
    const { getDesktopBridge, getMissingBridgeMethods } = await import("./bridge");

    const bridge = getDesktopBridge();
    expect(bridge).toBe(raw); // identity preserved — no wrapper object created
    expect(getMissingBridgeMethods()).toEqual([]);
    await expect(bridge!.reconcileKnowledgeActivations()).resolves.toEqual({
      checked: true,
      downgradedCount: 0,
      error: null,
    });
  });

  it("returns the same wrapped reference on repeated calls (stable for useEffect deps)", async () => {
    const raw = createCompleteBridge();
    setWindowDesktop(raw);
    const { getDesktopBridge } = await import("./bridge");
    expect(getDesktopBridge()).toBe(getDesktopBridge());
  });
});

describe("getDesktopBridge() — stale preload.js missing a promise-returning method", () => {
  it("stubs the missing method to reject with an actionable Korean message, and records its name", async () => {
    const raw = createCompleteBridge();
    delete (raw as Partial<DesktopBridge>).reconcileKnowledgeActivations;
    setWindowDesktop(raw);
    const { getDesktopBridge, getMissingBridgeMethods, isBridgeMethodMissing, STALE_BRIDGE_BUILD_MESSAGE } =
      await import("./bridge");

    const bridge = getDesktopBridge();
    expect(bridge).not.toBeNull();
    await expect(bridge!.reconcileKnowledgeActivations()).rejects.toThrow(STALE_BRIDGE_BUILD_MESSAGE);
    expect(getMissingBridgeMethods()).toEqual(["reconcileKnowledgeActivations"]);
    expect(isBridgeMethodMissing("reconcileKnowledgeActivations")).toBe(true);
    expect(isBridgeMethodMissing("getSystemInfo")).toBe(false);
  });

  it("never resolves the stub — a caller can never mistake missing-method for an empty/false answer", async () => {
    const raw = createCompleteBridge();
    delete (raw as Partial<DesktopBridge>).activateInstalledKnowledge;
    setWindowDesktop(raw);
    const { getDesktopBridge } = await import("./bridge");
    const bridge = getDesktopBridge()!;
    let settled: "resolved" | "rejected" | "pending" = "pending";
    bridge.activateInstalledKnowledge("knowledge", "a", "1.0.0").then(
      () => (settled = "resolved"),
      () => (settled = "rejected"),
    );
    await Promise.resolve().then(() => {});
    await Promise.resolve().then(() => {});
    expect(settled).toBe("rejected");
  });

  it("leaves every other (present) method untouched and fully functional", async () => {
    const raw = createCompleteBridge();
    delete (raw as Partial<DesktopBridge>).reconcileKnowledgeActivations;
    setWindowDesktop(raw);
    const { getDesktopBridge } = await import("./bridge");
    const bridge = getDesktopBridge()!;
    await expect(bridge.getSystemInfo()).resolves.toEqual(SYSTEM_INFO);
  });
});

describe("getDesktopBridge() — stale preload.js missing a subscription method", () => {
  it("returns a usable no-op unsubscribe instead of throwing, and records the method name", async () => {
    const raw = createCompleteBridge();
    delete (raw as Partial<DesktopBridge>).onStoreInstallProgress;
    setWindowDesktop(raw);
    const { getDesktopBridge, getMissingBridgeMethods } = await import("./bridge");

    const bridge = getDesktopBridge()!;
    let unsubscribe: (() => void) | undefined;
    expect(() => {
      unsubscribe = bridge.onStoreInstallProgress(() => {
        throw new Error("should never be invoked — no-op stub never fires events");
      });
    }).not.toThrow();
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe!()).not.toThrow(); // effect cleanup must stay valid
    expect(getMissingBridgeMethods()).toEqual(["onStoreInstallProgress"]);
  });

  it("does the same for onImportProgress", async () => {
    const raw = createCompleteBridge();
    delete (raw as Partial<DesktopBridge>).onImportProgress;
    setWindowDesktop(raw);
    const { getDesktopBridge, isBridgeMethodMissing } = await import("./bridge");

    const bridge = getDesktopBridge()!;
    const unsubscribe = bridge.onImportProgress(() => {});
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
    expect(isBridgeMethodMissing("onImportProgress")).toBe(true);
  });
});

describe("getDesktopBridge() — multiple missing methods at once", () => {
  it("stubs and records every missing method, not just the first", async () => {
    const raw = createCompleteBridge();
    delete (raw as Partial<DesktopBridge>).onStoreInstallProgress;
    delete (raw as Partial<DesktopBridge>).reconcileKnowledgeActivations;
    delete (raw as Partial<DesktopBridge>).getSystemInfo;
    setWindowDesktop(raw);
    const { getDesktopBridge, getMissingBridgeMethods } = await import("./bridge");

    const bridge = getDesktopBridge()!;
    expect(new Set(getMissingBridgeMethods())).toEqual(
      new Set(["onStoreInstallProgress", "reconcileKnowledgeActivations", "getSystemInfo"]),
    );
    expect(typeof bridge.onStoreInstallProgress(() => {})).toBe("function");
    await expect(bridge.reconcileKnowledgeActivations()).rejects.toThrow();
    await expect(bridge.getSystemInfo()).rejects.toThrow();
    // an untouched method on the same patched object still works normally.
    await expect(bridge.getDesktopSettings()).resolves.toEqual(SETTINGS);
  });
});
