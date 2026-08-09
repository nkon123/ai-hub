// 자산 스토어 설치 오케스트레이션. 네트워크/파일시스템을 전부 주입으로
// 대체해 순서와 오류 전파를 검증한다. 가장 중요한 단언은
// "importBundle이 정확히 한 번, 다운로드된 바이트가 저장된 임시 파일
// 경로로 호출된다"는 것 — 이 파일이 별도의 (미검증) 추출 경로를 만들지
// 않았다는 구조적 증거다.
import { describe, expect, it, vi } from "vitest";
import type { InstallRootLayout } from "../bundle-install";
import type { ImportResult } from "../types";
import { installFromStore, type StoreInstallDeps, type CancelToken } from "../store-install";

const LAYOUT: InstallRootLayout = {
  root: "/fake/root",
  assetsDir: "/fake/root/assets",
  quarantineDir: "/fake/root/quarantine",
  stateDir: "/fake/root/state",
  profilesDir: "/fake/root/profiles",
};

const TARGET = { assetType: "knowledge", assetId: "asset-1", assetVersionId: "av-1" };
const PORTAL = { baseUrl: "http://127.0.0.1:8003", token: "dev-user-token" };

function successImportResult(): ImportResult {
  return {
    outcome: "SUCCESS",
    checks: [{ id: "CHECKSUM", label: "Checksum 일치 검증", status: "PASS", message: "일치" }],
    failedStage: null,
    retryable: true,
    manifest: null,
    installPlan: [],
    totalSizeBytes: 42,
  };
}

function failedImportResult(): ImportResult {
  return {
    outcome: "FAILED",
    checks: [{ id: "CHECKSUM", label: "Checksum 일치 검증", status: "FAIL", message: "불일치" }],
    failedStage: "CHECKSUM",
    retryable: true,
    manifest: null,
    installPlan: [],
    totalSizeBytes: 0,
  };
}

function makeDeps(overrides: Partial<StoreInstallDeps> = {}): StoreInstallDeps {
  return {
    requestDistribution: vi.fn(async () => ({ ok: true, data: { id: "dist-1", status: "QUEUED" } })),
    getDistribution: vi.fn(async () => ({
      ok: true,
      data: { id: "dist-1", status: "SUCCEEDED", stage: "SUCCEEDED", errorCode: null, errorMessage: null, retryable: null },
    })),
    downloadDistribution: vi.fn(async () => ({ ok: true, data: Buffer.from("PK-fake-zip") })),
    importBundle: vi.fn(async () => successImportResult()),
    writeTempFile: vi.fn(() => "/fake/root/quarantine/temp-download.zip"),
    removeTempFile: vi.fn(),
    sleep: vi.fn(async () => undefined),
    pollIntervalMs: 1,
    maxPollAttempts: 5,
    ...overrides,
  } as StoreInstallDeps;
}

describe("installFromStore — happy path", () => {
  it("goes REQUEST -> SERVER_BUILD -> DOWNLOAD -> importBundle(), and only importBundle ever touches the bytes", async () => {
    const deps = makeDeps();
    const events: string[] = [];

    const result = await installFromStore(LAYOUT, TARGET, PORTAL, (e) => events.push(`${e.stage}:${e.status}`), deps);

    expect(result.outcome).toBe("SUCCESS");
    expect(result.importResult?.outcome).toBe("SUCCESS");
    expect(deps.requestDistribution).toHaveBeenCalledWith(PORTAL.baseUrl, PORTAL.token, {
      root_type: "ASSET_VERSION",
      root_id: TARGET.assetVersionId,
      mode: "OFFLINE_BUNDLE",
    });
    expect(deps.downloadDistribution).toHaveBeenCalledWith(PORTAL.baseUrl, PORTAL.token, "dist-1");
    // 핵심 계약: importBundle은 정확히 한 번, 다운로드 임시 파일 경로와
    // 동일한 layout으로 호출된다 — 다른 어떤 함수도 바이트를 열어보지 않는다.
    expect(deps.importBundle).toHaveBeenCalledTimes(1);
    expect(deps.importBundle).toHaveBeenCalledWith(
      "/fake/root/quarantine/temp-download.zip",
      LAYOUT,
      expect.any(Function),
    );
    // 다운로드 후 설치가 끝나면 임시 파일은 정리된다.
    expect(deps.removeTempFile).toHaveBeenCalledWith("/fake/root/quarantine/temp-download.zip");
    expect(events).toEqual(["REQUEST:SKIP", "REQUEST:PASS", "SERVER_BUILD:SKIP", "SERVER_BUILD:PASS", "DOWNLOAD:SKIP", "DOWNLOAD:PASS"]);
  });

  it("forwards importBundle's own progress events under the existing ImportStage vocabulary", async () => {
    const deps = makeDeps({
      importBundle: vi.fn(async (_path, _layout, emit) => {
        emit({ stage: "CHECKSUM", status: "PASS", message: "일치" });
        return successImportResult();
      }),
    });
    const events: Array<{ stage: string; status: string }> = [];
    await installFromStore(LAYOUT, TARGET, PORTAL, (e) => events.push({ stage: e.stage, status: e.status }), deps);
    expect(events).toContainEqual({ stage: "CHECKSUM", status: "PASS" });
  });
});

describe("installFromStore — server-side failures", () => {
  it("fails at REQUEST when Bundle creation is rejected, without ever polling or downloading", async () => {
    const deps = makeDeps({
      requestDistribution: vi.fn(async () => ({ ok: false, code: "PERMISSION_DENIED", message: "권한이 없습니다." })),
    });
    const result = await installFromStore(LAYOUT, TARGET, PORTAL, () => {}, deps);

    expect(result).toMatchObject({ outcome: "FAILED", failedStage: "REQUEST", message: "권한이 없습니다.", retryable: false });
    expect(deps.getDistribution).not.toHaveBeenCalled();
    expect(deps.downloadDistribution).not.toHaveBeenCalled();
    expect(deps.importBundle).not.toHaveBeenCalled();
  });

  it("marks PORTAL_UNREACHABLE failures at REQUEST as retryable", async () => {
    const deps = makeDeps({
      requestDistribution: vi.fn(async () => ({ ok: false, code: "PORTAL_UNREACHABLE", message: "연결할 수 없습니다." })),
    });
    const result = await installFromStore(LAYOUT, TARGET, PORTAL, () => {}, deps);
    expect(result.retryable).toBe(true);
  });

  it("polls until a terminal status, then proceeds", async () => {
    const statuses = ["QUEUED", "RUNNING", "SUCCEEDED"];
    let call = 0;
    const deps = makeDeps({
      getDistribution: vi.fn(async () => ({
        ok: true,
        data: { id: "dist-1", status: statuses[call++], stage: null, errorCode: null, errorMessage: null, retryable: null },
      })),
    });
    const result = await installFromStore(LAYOUT, TARGET, PORTAL, () => {}, deps);
    expect(result.outcome).toBe("SUCCESS");
    expect(deps.getDistribution).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it("fails at SERVER_BUILD with the server's own error message when the job terminates as FAILED", async () => {
    const deps = makeDeps({
      getDistribution: vi.fn(async () => ({
        ok: true,
        data: {
          id: "dist-1",
          status: "FAILED",
          stage: "COLLECTING",
          errorCode: "ASSET_VERSION_REVOKED",
          errorMessage: "긴급 회수(Revocation)된 버전입니다.",
          retryable: false,
        },
      })),
    });
    const result = await installFromStore(LAYOUT, TARGET, PORTAL, () => {}, deps);
    expect(result).toMatchObject({
      outcome: "FAILED",
      failedStage: "SERVER_BUILD",
      message: "긴급 회수(Revocation)된 버전입니다.",
      retryable: false,
    });
    expect(deps.downloadDistribution).not.toHaveBeenCalled();
  });

  it("times out politely after maxPollAttempts without ever reaching a terminal status", async () => {
    const deps = makeDeps({
      maxPollAttempts: 3,
      getDistribution: vi.fn(async () => ({
        ok: true,
        data: { id: "dist-1", status: "RUNNING", stage: "COLLECTING", errorCode: null, errorMessage: null, retryable: null },
      })),
    });
    const result = await installFromStore(LAYOUT, TARGET, PORTAL, () => {}, deps);
    expect(result.outcome).toBe("FAILED");
    expect(result.failedStage).toBe("SERVER_BUILD");
    expect(result.retryable).toBe(true);
    expect(deps.getDistribution).toHaveBeenCalledTimes(3);
    expect(deps.downloadDistribution).not.toHaveBeenCalled();
  });

  it("fails at DOWNLOAD without calling importBundle when the download itself is rejected", async () => {
    const deps = makeDeps({
      downloadDistribution: vi.fn(async () => ({ ok: false, code: "DEPENDENCY_UNAVAILABLE", message: "Bundle이 아직 준비되지 않았습니다." })),
    });
    const result = await installFromStore(LAYOUT, TARGET, PORTAL, () => {}, deps);
    expect(result).toMatchObject({ outcome: "FAILED", failedStage: "DOWNLOAD" });
    expect(deps.importBundle).not.toHaveBeenCalled();
  });
});

describe("installFromStore — importBundle failure is passed through unmodified", () => {
  it("surfaces importBundle's own FAILED outcome and failedStage verbatim, still cleaning up the temp file", async () => {
    const deps = makeDeps({ importBundle: vi.fn(async () => failedImportResult()) });
    const result = await installFromStore(LAYOUT, TARGET, PORTAL, () => {}, deps);
    expect(result.outcome).toBe("FAILED");
    expect(result.failedStage).toBe("CHECKSUM");
    expect(result.importResult?.outcome).toBe("FAILED");
    expect(deps.removeTempFile).toHaveBeenCalledTimes(1);
  });

  it("still removes the temp file even if importBundle throws", async () => {
    const deps = makeDeps({
      importBundle: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    await expect(installFromStore(LAYOUT, TARGET, PORTAL, () => {}, deps)).rejects.toThrow("disk full");
    expect(deps.removeTempFile).toHaveBeenCalledTimes(1);
  });
});

describe("installFromStore — cancellation", () => {
  it("returns a cancelled result immediately, calling nothing, when cancelled before starting", async () => {
    const deps = makeDeps();
    const cancelToken: CancelToken = { cancelled: true };
    const result = await installFromStore(LAYOUT, TARGET, PORTAL, () => {}, deps, cancelToken);

    expect(result).toMatchObject({ outcome: "FAILED", cancelled: true, failedStage: "REQUEST" });
    expect(deps.requestDistribution).not.toHaveBeenCalled();
  });

  it("stops polling and never downloads once cancelled mid-poll", async () => {
    const cancelToken: CancelToken = { cancelled: false };
    const deps = makeDeps({
      getDistribution: vi.fn(async () => ({
        ok: true,
        data: { id: "dist-1", status: "RUNNING", stage: "COLLECTING", errorCode: null, errorMessage: null, retryable: null },
      })),
      sleep: vi.fn(async () => {
        cancelToken.cancelled = true; // 사용자가 폴링 중 취소 버튼을 눌렀다고 가정.
      }),
    });
    const result = await installFromStore(LAYOUT, TARGET, PORTAL, () => {}, deps, cancelToken);
    expect(result).toMatchObject({ outcome: "FAILED", cancelled: true, failedStage: "SERVER_BUILD" });
    expect(deps.downloadDistribution).not.toHaveBeenCalled();
  });

  it("does not check cancellation once local verification (importBundle) has started", async () => {
    const cancelToken: CancelToken = { cancelled: false };
    const deps = makeDeps({
      importBundle: vi.fn(async () => {
        cancelToken.cancelled = true; // 로컬 검증이 시작된 뒤 취소를 눌러도
        return successImportResult(); // 이미 시작된 검증은 끝까지 진행된다.
      }),
    });
    const result = await installFromStore(LAYOUT, TARGET, PORTAL, () => {}, deps, cancelToken);
    expect(result.outcome).toBe("SUCCESS");
    expect(result.cancelled).toBe(false);
  });
});
