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
import {
  activateInstalledKnowledge,
  computeActivationReconcile,
  deactivateInstalledKnowledge,
  reconcileInstalledKnowledgeActivations,
} from "../knowledge-activation";
import type { FetchLike, LocalIndexEntry } from "../search-runtime-client";
import type { InstalledAsset, KnowledgeActivation } from "../types";

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

  // central-index-exists-not-a-failure (2026-08-13 실사용 진단): the running
  // search-runtime this repo already has may serve this knowledge_id from
  // its own central INDEX_BASE. Registration is refused
  // (`central_index_exists`, VALIDATION_ERROR/400), but the Knowledge is
  // already searchable — this must surface as ok:true / state:
  // "ALREADY_ACTIVE", never as a FAILED activation.
  it("treats a 'central_index_exists' refusal as usable (ok:true, state ALREADY_ACTIVE), not a failure", async () => {
    installKnowledgeWithIndex("know-central", "1.0.0");
    const fetchImpl = (async () =>
      jsonResponse(400, {
        error: {
          code: "VALIDATION_ERROR",
          message:
            "이 Knowledge는 이미 이 배포의 기본 색인 경로에 등록되어 있어 바로 검색 가능합니다 — 별도의 외부 색인 등록은 필요하지 않습니다.",
          details: { reason: "central_index_exists" },
        },
      })) as unknown as FetchLike;

    const result = await activateInstalledKnowledge(
      layout,
      store,
      BASE_URL,
      { assetType: "knowledge", assetId: "know-central", version: "1.0.0" },
      fetchImpl,
    );

    expect(result.ok).toBe(true);
    expect(result.activation?.state).toBe("ALREADY_ACTIVE");
    expect(result.activation?.reason).toBe("central_index_exists");
    expect(result.activation?.message).toContain("바로 검색 가능");
    // Persisted as ALREADY_ACTIVE, not FAILED — the 설치된 자산 화면 must not
    // show a red "활성화 실패" badge for an asset that is already searchable.
    const persisted = store.find("knowledge", "know-central", "1.0.0")?.activation;
    expect(persisted?.state).toBe("ALREADY_ACTIVE");
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

// D-079 이어 붙이기: 로컬 ACTIVE와 search-runtime의 실제 등록 목록이 어긋날
// 수 있다(재시작/레지스트리 초기화) — 그 어긋남을 발견하고 정직하게
// 낮추는 재확인(reconcile) 로직.
function activeActivation(overrides: Partial<KnowledgeActivation> = {}): KnowledgeActivation {
  return { state: "ACTIVE", checkedAt: "2026-08-13T00:00:00.000Z", reason: null, message: null, indexPath: "/idx", ...overrides };
}

function knowledgeAsset(overrides: Partial<InstalledAsset> = {}): InstalledAsset {
  return {
    assetId: "know-1",
    assetVersionId: "av-1",
    assetType: "knowledge",
    name: "재택근무 정책",
    version: "1.0.0",
    installedAt: "2026-08-13T00:00:00.000Z",
    sizeBytes: 100,
    bundleId: "bundle-1",
    ...overrides,
  };
}

function localIndexEntry(overrides: Partial<LocalIndexEntry> = {}): LocalIndexEntry {
  return {
    knowledgeId: "av-1",
    indexPath: "/idx",
    source: "DESKTOP_OFFLINE_BUNDLE",
    label: null,
    registeredAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("computeActivationReconcile (순수 비교 로직)", () => {
  it("never downgrades anything when the server list is null (unreachable) — 'checked: false'", () => {
    const asset = knowledgeAsset({ activation: activeActivation() });
    const result = computeActivationReconcile([asset], null);
    expect(result).toEqual({ downgrades: [], checked: false });
  });

  it("downgrades a locally-ACTIVE Knowledge that the server no longer lists", () => {
    const asset = knowledgeAsset({ activation: activeActivation() });
    const result = computeActivationReconcile([asset], []);
    expect(result.checked).toBe(true);
    expect(result.downgrades).toHaveLength(1);
    expect(result.downgrades[0]).toMatchObject({ assetType: "knowledge", assetId: "know-1", version: "1.0.0" });
    expect(result.downgrades[0].activation.state).toBe("FAILED");
    expect(result.downgrades[0].activation.reason).toBe("not_registered_on_server");
  });

  it("leaves an ACTIVE Knowledge alone when the server's list still contains its id", () => {
    const asset = knowledgeAsset({ activation: activeActivation() });
    const result = computeActivationReconcile([asset], [localIndexEntry({ knowledgeId: "av-1" })]);
    expect(result).toEqual({ downgrades: [], checked: true });
  });

  it("ignores Knowledge that is not ACTIVE locally (nothing to reconcile)", () => {
    const neverActivated = knowledgeAsset({ assetId: "know-2" });
    const failed = knowledgeAsset({
      assetId: "know-3",
      activation: { state: "FAILED", checkedAt: "2026-08-13T00:00:00.000Z", reason: "index_dir_missing", message: "실패", indexPath: null },
    });
    const result = computeActivationReconcile([neverActivated, failed], []);
    expect(result).toEqual({ downgrades: [], checked: true });
  });

  // central-index-exists-not-a-failure: an ALREADY_ACTIVE Knowledge was never
  // locally registered with search-runtime (registration was refused because
  // the central INDEX_BASE already serves it) — it can therefore never
  // appear in `listLocalKnowledgeIndexes`'s entries by design. Reconcile must
  // not read that absence as "registration lost" and downgrade it to FAILED.
  it("never downgrades an ALREADY_ACTIVE (central_index_exists) Knowledge, even when the server's local-index list is empty", () => {
    const asset = knowledgeAsset({
      activation: {
        state: "ALREADY_ACTIVE",
        checkedAt: "2026-08-13T00:00:00.000Z",
        reason: "central_index_exists",
        message: "이미 검색 가능합니다.",
        indexPath: "/idx",
      },
    });
    const result = computeActivationReconcile([asset], []);
    expect(result).toEqual({ downgrades: [], checked: true });
  });

  it("ignores non-Knowledge assets even if somehow marked ACTIVE", () => {
    const asset = knowledgeAsset({ assetType: "service", activation: activeActivation() });
    const result = computeActivationReconcile([asset], []);
    expect(result).toEqual({ downgrades: [], checked: true });
  });

  it("blames the deployment, not a lost registration, when the server has activation disabled", () => {
    // 두 경우 모두 로컬 ACTIVE 는 거짓이므로 낮추는 것은 같다. 다른 것은
    // 안내다 — 기능이 꺼진 배포에서 "다시 활성화하세요"라고 말하면 사용자는
    // 반드시 다시 실패하는 행동을 하게 된다.
    const asset = knowledgeAsset({ activation: activeActivation() });
    const disabled = computeActivationReconcile([asset], [], false);

    expect(disabled.checked).toBe(true);
    expect(disabled.downgrades).toHaveLength(1);
    expect(disabled.downgrades[0].activation.reason).toBe("local_indexes_disabled");
    expect(disabled.downgrades[0].activation.message).not.toContain("다시 활성화하세요");

    const lost = computeActivationReconcile([asset], [], true);
    expect(lost.downgrades[0].activation.reason).toBe("not_registered_on_server");
    expect(lost.downgrades[0].activation.message).toContain("다시 활성화하세요");
  });

  it("defaults to the 'registration lost' wording when the flag is not supplied", () => {
    const asset = knowledgeAsset({ activation: activeActivation() });
    expect(computeActivationReconcile([asset], []).downgrades[0].activation.reason).toBe(
      "not_registered_on_server",
    );
  });
});

describe("reconcileInstalledKnowledgeActivations (main-process 오케스트레이션)", () => {
  it("downgrades a stale ACTIVE entry and persists it to the store", async () => {
    installKnowledgeWithIndex("know-8", "1.0.0");
    store.updateActivation("knowledge", "know-8", "1.0.0", activeActivation());
    const fetchImpl = (async () => jsonResponse(200, { entries: [], local_indexes_enabled: true })) as unknown as FetchLike;

    const result = await reconcileInstalledKnowledgeActivations(store, BASE_URL, fetchImpl);

    expect(result).toEqual({ checked: true, downgradedCount: 1, error: null });
    expect(store.find("knowledge", "know-8", "1.0.0")?.activation?.state).toBe("FAILED");
    expect(store.find("knowledge", "know-8", "1.0.0")?.activation?.reason).toBe("not_registered_on_server");
  });

  it("leaves the store untouched and reports checked:false when search-runtime is unreachable", async () => {
    installKnowledgeWithIndex("know-9", "1.0.0");
    store.updateActivation("knowledge", "know-9", "1.0.0", activeActivation());
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as FetchLike;

    const result = await reconcileInstalledKnowledgeActivations(store, BASE_URL, fetchImpl);

    expect(result.checked).toBe(false);
    expect(result.downgradedCount).toBe(0);
    expect(result.error).toBeTruthy();
    // Never invented a fact from a network failure — the ACTIVE state stands.
    expect(store.find("knowledge", "know-9", "1.0.0")?.activation?.state).toBe("ACTIVE");
  });

  it("reports downgradedCount:0 when the server list matches local state exactly", async () => {
    const indexDir = installKnowledgeWithIndex("know-10", "1.0.0");
    store.updateActivation("knowledge", "know-10", "1.0.0", activeActivation({ indexPath: indexDir }));
    const fetchImpl = (async () =>
      jsonResponse(200, {
        entries: [{ knowledge_id: "av-1", index_path: indexDir, source: "DESKTOP_OFFLINE_BUNDLE", label: null, registered_at: "2026-08-13T00:00:00.000Z" }],
        local_indexes_enabled: true,
      })) as unknown as FetchLike;

    const result = await reconcileInstalledKnowledgeActivations(store, BASE_URL, fetchImpl);

    expect(result).toEqual({ checked: true, downgradedCount: 0, error: null });
    expect(store.find("knowledge", "know-10", "1.0.0")?.activation?.state).toBe("ACTIVE");
  });

  it("leaves an ALREADY_ACTIVE (central_index_exists) entry untouched even though it never appears in the server's local-index list", async () => {
    installKnowledgeWithIndex("know-11", "1.0.0");
    store.updateActivation("knowledge", "know-11", "1.0.0", {
      state: "ALREADY_ACTIVE",
      checkedAt: "2026-08-13T00:00:00.000Z",
      reason: "central_index_exists",
      message: "이미 검색 가능합니다.",
      indexPath: "/idx",
    });
    // The server's local-index registry is empty — expected, since this
    // Knowledge was never registered there (it's served by the central
    // INDEX_BASE instead).
    const fetchImpl = (async () => jsonResponse(200, { entries: [], local_indexes_enabled: true })) as unknown as FetchLike;

    const result = await reconcileInstalledKnowledgeActivations(store, BASE_URL, fetchImpl);

    expect(result).toEqual({ checked: true, downgradedCount: 0, error: null });
    expect(store.find("knowledge", "know-11", "1.0.0")?.activation?.state).toBe("ALREADY_ACTIVE");
  });
});
