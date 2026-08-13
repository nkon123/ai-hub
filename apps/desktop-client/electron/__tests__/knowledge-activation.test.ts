// D-079 — main-process orchestration for turning an installed Knowledge into
// an activated (searchable) one. Uses a real temp install layout (mirrors
// `asset-management.test.ts`'s approach) plus a fake `search-runtime-client`
// fetchImpl injected the same way `store-install.test.ts` injects its deps —
// no real network, no real search-runtime process required.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInstallRoot, type InstallRootLayout } from "../bundle-install";
import { assetInstallDir } from "../asset-management";
import { InstalledAssetsStore } from "../installed-assets-store";
import { activateInstalledKnowledge, deactivateInstalledKnowledge } from "../knowledge-activation";
import type { FetchLike } from "../search-runtime-client";
import type { InstalledAsset } from "../types";

const BASE_URL = "http://127.0.0.1:8300";

let tmpRoot: string;
let layout: InstallRootLayout;
let store: InstalledAssetsStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-knowledge-activation-"));
  layout = resolveInstallRoot(tmpRoot);
  store = new InstalledAssetsStore(layout.stateDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function installKnowledgeWithIndex(
  assetId: string,
  version: string,
  overrides: Partial<InstalledAsset> = {},
): string {
  const dir = assetInstallDir(layout, "knowledge", assetId, version);
  const indexDir = path.join(dir, "index");
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(indexDir, "index-meta.json"), JSON.stringify({ knowledge_id: "av-1" }));
  const asset: InstalledAsset = {
    assetId,
    assetVersionId: "av-1",
    assetType: "knowledge",
    name: "재택근무 정책",
    version,
    installedAt: new Date().toISOString(),
    sizeBytes: 100,
    bundleId: "bundle-1",
    checksumVerification: null,
    ...overrides,
  };
  store.upsert(asset);
  return indexDir;
}

describe("activateInstalledKnowledge", () => {
  it("registers the index dir with search-runtime and persists an ACTIVE activation on success", async () => {
    const indexDir = installKnowledgeWithIndex("know-1", "1.0.0");
    const fetchImpl = (async (url: unknown) => {
      expect(String(url)).toBe(`${BASE_URL}/search/v1/local-indexes`);
      return jsonResponse(200, {
        entry: {
          knowledge_id: "av-1",
          index_path: indexDir,
          source: "DESKTOP_OFFLINE_BUNDLE",
          label: "재택근무 정책 v1.0.0",
          registered_at: new Date().toISOString(),
        },
        trace_id: "t1",
      });
    }) as unknown as FetchLike;

    const result = await activateInstalledKnowledge(
      layout,
      store,
      BASE_URL,
      { assetType: "knowledge", assetId: "know-1", version: "1.0.0" },
      fetchImpl,
    );

    expect(result.ok).toBe(true);
    expect(result.activation?.state).toBe("ACTIVE");
    expect(result.activation?.indexPath).toBe(indexDir);
    // Persisted, not just returned once — the 설치된 자산 화면 reads this later.
    expect(store.find("knowledge", "know-1", "1.0.0")?.activation?.state).toBe("ACTIVE");
  });

  it("refuses without calling search-runtime when assetVersionId is null (D-060) — never falls back to assetId", async () => {
    installKnowledgeWithIndex("know-2", "1.0.0", { assetVersionId: null });
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse(200, {});
    }) as unknown as FetchLike;

    const result = await activateInstalledKnowledge(
      layout,
      store,
      BASE_URL,
      { assetType: "knowledge", assetId: "know-2", version: "1.0.0" },
      fetchImpl,
    );

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.activation?.state).toBe("FAILED");
    expect(result.activation?.reason).toBe("asset_version_id_missing");
    // Persisted — a failure not shown now must still be visible later.
    expect(store.find("knowledge", "know-2", "1.0.0")?.activation?.state).toBe("FAILED");
  });

  it("fails fast (locally) with a clear message when the install has no index/ folder", async () => {
    const dir = assetInstallDir(layout, "knowledge", "know-3", "1.0.0");
    fs.mkdirSync(dir, { recursive: true }); // no `index/` subfolder
    store.upsert({
      assetId: "know-3",
      assetVersionId: "av-3",
      assetType: "knowledge",
      name: "재택근무 정책",
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      sizeBytes: 100,
      bundleId: "bundle-1",
      checksumVerification: null,
    });
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse(200, {});
    }) as unknown as FetchLike;

    const result = await activateInstalledKnowledge(
      layout,
      store,
      BASE_URL,
      { assetType: "knowledge", assetId: "know-3", version: "1.0.0" },
      fetchImpl,
    );

    expect(called).toBe(false);
    expect(result.activation?.state).toBe("FAILED");
    expect(result.activation?.reason).toBe("index_dir_missing");
    expect(store.find("knowledge", "know-3", "1.0.0")?.activation?.state).toBe("FAILED");
  });

  it("persists a FAILED activation with the server's refusal reason/message when search-runtime rejects it", async () => {
    installKnowledgeWithIndex("know-4", "1.0.0");
    const fetchImpl = (async () =>
      jsonResponse(403, {
        error: { code: "PERMISSION_DENIED", message: "이 배포에서는 활성화 기능이 꺼져 있습니다.", details: { reason: "local_indexes_disabled" } },
      })) as unknown as FetchLike;

    const result = await activateInstalledKnowledge(
      layout,
      store,
      BASE_URL,
      { assetType: "knowledge", assetId: "know-4", version: "1.0.0" },
      fetchImpl,
    );

    expect(result.ok).toBe(false);
    expect(result.activation?.state).toBe("FAILED");
    expect(result.activation?.reason).toBe("local_indexes_disabled");
    expect(result.activation?.message).toBe("이 배포에서는 활성화 기능이 꺼져 있습니다.");
    expect(store.find("knowledge", "know-4", "1.0.0")?.activation?.reason).toBe("local_indexes_disabled");
  });

  it("persists a FAILED activation with reason 'unreachable' when search-runtime cannot be reached", async () => {
    installKnowledgeWithIndex("know-5", "1.0.0");
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as FetchLike;

    const result = await activateInstalledKnowledge(
      layout,
      store,
      BASE_URL,
      { assetType: "knowledge", assetId: "know-5", version: "1.0.0" },
      fetchImpl,
    );

    expect(result.activation?.state).toBe("FAILED");
    expect(result.activation?.reason).toBe("unreachable");
    expect(result.activation?.message).toContain("search-runtime");
  });

  it("refuses a non-knowledge asset type without touching the store's activation field", async () => {
    const dir = assetInstallDir(layout, "service", "svc-1", "1.0.0");
    fs.mkdirSync(dir, { recursive: true });
    store.upsert({
      assetId: "svc-1",
      assetVersionId: null,
      assetType: "service",
      name: "HR 챗봇",
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      sizeBytes: 10,
      bundleId: "bundle-1",
      checksumVerification: null,
    });

    const result = await activateInstalledKnowledge(
      layout,
      store,
      BASE_URL,
      { assetType: "service", assetId: "svc-1", version: "1.0.0" },
      undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.activation).toBeNull();
    expect(result.error).toContain("활성화 대상이 아닙니다");
    expect(store.find("service", "svc-1", "1.0.0")?.activation).toBeUndefined();
  });

  it("reports 'not found' without persisting anything when no such record exists", async () => {
    const result = await activateInstalledKnowledge(
      layout,
      store,
      BASE_URL,
      { assetType: "knowledge", assetId: "missing", version: "1.0.0" },
      undefined,
    );
    expect(result.ok).toBe(false);
    expect(result.activation).toBeNull();
    expect(result.error).toContain("찾을 수 없습니다");
  });
});

describe("deactivateInstalledKnowledge", () => {
  it("unregisters remotely and clears the local activation state", async () => {
    installKnowledgeWithIndex("know-6", "1.0.0");
    store.updateActivation("knowledge", "know-6", "1.0.0", {
      state: "ACTIVE",
      checkedAt: new Date().toISOString(),
      reason: null,
      message: null,
      indexPath: "/x",
    });
    let deleteCalled = false;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(`${BASE_URL}/search/v1/local-indexes/av-1`);
      expect(init?.method).toBe("DELETE");
      deleteCalled = true;
      return jsonResponse(200, { knowledge_id: "av-1", removed: true, trace_id: "t1" });
    }) as unknown as FetchLike;

    const result = await deactivateInstalledKnowledge(
      store,
      BASE_URL,
      { assetType: "knowledge", assetId: "know-6", version: "1.0.0" },
      fetchImpl,
    );

    expect(deleteCalled).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.remoteWarning).toBeNull();
    expect(store.find("knowledge", "know-6", "1.0.0")?.activation).toBeNull();
  });

  it("still clears local state and reports ok:true (with a remoteWarning) when search-runtime is unreachable", async () => {
    installKnowledgeWithIndex("know-7", "1.0.0");
    store.updateActivation("knowledge", "know-7", "1.0.0", {
      state: "ACTIVE",
      checkedAt: new Date().toISOString(),
      reason: null,
      message: null,
      indexPath: "/x",
    });
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as FetchLike;

    const result = await deactivateInstalledKnowledge(
      store,
      BASE_URL,
      { assetType: "knowledge", assetId: "know-7", version: "1.0.0" },
      fetchImpl,
    );

    // Local state must be cleared regardless — a user must be able to
    // uninstall/retry cleanly even while search-runtime is down.
    expect(result.ok).toBe(true);
    expect(result.remoteWarning).toContain("search-runtime");
    expect(store.find("knowledge", "know-7", "1.0.0")?.activation).toBeNull();
  });

  it("refuses a non-knowledge asset type", async () => {
    store.upsert({
      assetId: "svc-2",
      assetVersionId: null,
      assetType: "service",
      name: "HR 챗봇",
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      sizeBytes: 10,
      bundleId: "bundle-1",
      checksumVerification: null,
    });
    const result = await deactivateInstalledKnowledge(
      store,
      BASE_URL,
      { assetType: "service", assetId: "svc-2", version: "1.0.0" },
      undefined,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("활성화 대상이 아닙니다");
  });

  it("reports 'not found' when no such record exists", async () => {
    const result = await deactivateInstalledKnowledge(
      store,
      BASE_URL,
      { assetType: "knowledge", assetId: "missing", version: "1.0.0" },
      undefined,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("찾을 수 없습니다");
  });
});
