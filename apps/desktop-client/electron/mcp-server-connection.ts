// D-096 "MCP 서버 다시 활성화" — main process 오케스트레이션.
//
// 왜 필요한가: 설치 직후의 자동 활성화(`bundle-install.ts`)가 거부되는 경우가
// **정상적으로** 존재한다 — stdio 는 이 PC 에서 프로세스를 띄우는 경로라
// 운영자가 설정을 켜 줘야 한다. 그런데 그 설정을 고친 뒤 다시 시도할 방법이
// 자산을 **다시 설치하는 것**밖에 없었다. 설정을 고쳤다고 멀쩡히 설치된
// 파일을 지웠다 다시 받는 것은 말이 안 된다(실 사용자 지적).
//
// 분업은 `mcp-tool-connection.ts`(D-080)와 같다: HTTP 와 판정 문구는 순수
// 모듈(`mcp-server-activation.ts`)에, fs 조회와 `InstalledAssetsStore`
// 왕복만 여기에.
//
// 규약 하나: **시도했으면 결과를 반드시 남긴다.** 성공이든 실패든
// `updateActivation` 에 저장한다 — 지금 화면에서 사라져도 나중에 설치된 자산
// 목록에서 같은 사실을 볼 수 있어야 한다. 시도할 것이 애초에 없었던 두 경우
// (대상 없음, 이 유형이 아님)만 저장을 건너뛴다. D-079/D-080 이 같은 예외를
// 명시한다.

import path from "node:path";

import { assetInstallDir, readAssetManifest } from "./asset-management";
import type { InstallRootLayout } from "./bundle-install";
import type { InstalledAssetsStore } from "./installed-assets-store";
import {
  activateInstalledMcpServer,
  listRegisteredMcpServerAliases,
  serverAliasOf,
  type FetchLike,
} from "./mcp-server-activation";
import type { ActivateMcpServerResult, KnowledgeActivation, ReconcileMcpServersResult } from "./types";

export interface McpServerTarget {
  assetId: string;
  version: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function failed(reason: string, message: string): KnowledgeActivation {
  return { state: "FAILED", checkedAt: nowIso(), reason, message, indexPath: null };
}

/**
 * 설치된 MCP 서버 자산 하나를 agent-runtime 에 다시 등록한다.
 *
 * 설치 직후 자동 활성화와 **같은 경로**를 쓴다(`activateInstalledMcpServer`)
 * — 두 경로가 갈라지면 "설치할 때는 되는데 다시 활성화는 안 된다"(혹은 그
 * 반대)가 생기고, 그때 어느 쪽이 맞는지 알 방법이 없다.
 */
export async function reactivateInstalledMcpServer(
  layout: InstallRootLayout,
  store: InstalledAssetsStore,
  agentRuntimeBaseUrl: string,
  target: McpServerTarget,
  fetchImpl: FetchLike = fetch,
): Promise<ActivateMcpServerResult> {
  const record = store.find("mcp_server", target.assetId, target.version);
  if (!record) {
    // 시도할 것이 없다 — 남길 기록도 없다.
    return {
      ok: false,
      activation: null,
      message: "설치된 MCP 서버를 찾을 수 없습니다. 목록을 새로고침해 주세요.",
    };
  }

  const manifestResult = readAssetManifest(layout, record);
  if (!manifestResult.available || manifestResult.manifest === null) {
    const activation = failed(
      "manifest_unreadable",
      manifestResult.reason ?? "Manifest를 읽을 수 없습니다.",
    );
    store.updateActivation("mcp_server", target.assetId, target.version, activation);
    return { ok: false, activation, message: activation.message! };
  }

  const outcome = await activateInstalledMcpServer(
    agentRuntimeBaseUrl,
    {
      assetId: target.assetId,
      version: target.version,
      // 설치 직후와 **동일한 경로 계산**이어야 한다. 여기서 따로 조립하면
      // 두 경로가 갈라진다.
      installPath: path.join(
        assetInstallDir(layout, "mcp_server", target.assetId, target.version),
        "source",
      ),
      manifest: manifestResult.manifest as Record<string, unknown>,
    },
    fetchImpl,
  );

  const activation: KnowledgeActivation = {
    state: outcome.status === "PASS" ? "ACTIVE" : "FAILED",
    checkedAt: nowIso(),
    reason: outcome.reason ?? null,
    message: outcome.message,
    indexPath: null,
  };
  store.updateActivation("mcp_server", target.assetId, target.version, activation);

  return { ok: outcome.status === "PASS", activation, message: outcome.message };
}

/**
 * 로컬에 ACTIVE 로 기록된 MCP 서버를 agent-runtime 의 **현재** 등록 목록과
 * 맞추고, 빠진 것은 다시 등록한다.
 *
 * 왜 필요한가: agent-runtime 의 서버 레지스트리는 메모리에만 있다
 * (`mcp_server_registry.py`). agent-runtime 이 재시작되면 등록이 전부
 * 사라지는데 Desktop 의 설치 기록은 여전히 ACTIVE 라, 사용자가 자산 화면에서
 * "다시 확인"을 누르기 전까지 대화에서 서버가 보이지 않았다(2026-09-18 실사용
 * 제보). 사용자가 이미 한 번 성공시킨 등록을 다시 하는 것이므로 확인을 묻지
 * 않는다 — 새로 허용하는 것이 아니라 잃어버린 상태를 복구하는 것이다.
 *
 * 대상은 **로컬 기록이 ACTIVE 인 것만**이다. FAILED 는 설정이 바뀌지 않는 한
 * 다시 거절될 것이 뻔하고(stdio 비허용 등), 기록이 없는 것은 사용자가 아직
 * 시도하지 않은 것이다 — 둘 다 여기서 조용히 시도하지 않는다. 같은 자산의
 * 다른 버전이 있으면 Active Version(D12)만 다룬다 — 옛 버전이 같은 alias 로
 * 덮어쓰면 안 된다.
 *
 * agent-runtime 에 도달하지 못하면 아무것도 바꾸지 않고 `checked: false`.
 */
export async function reconcileInstalledMcpServers(
  layout: InstallRootLayout,
  store: InstalledAssetsStore,
  agentRuntimeBaseUrl: string,
  activeVersionOf: (assetType: string, assetId: string) => string | null,
  fetchImpl: FetchLike = fetch,
): Promise<ReconcileMcpServersResult> {
  const remote = await listRegisteredMcpServerAliases(agentRuntimeBaseUrl, fetchImpl);
  if (!remote.ok) {
    return { checked: false, restoredCount: 0, failedCount: 0, error: remote.message };
  }

  let restoredCount = 0;
  let failedCount = 0;
  const attempted = new Set<string>();
  for (const asset of store.list()) {
    if (asset.assetType !== "mcp_server" || asset.activation?.state !== "ACTIVE") continue;
    const activeVersion = activeVersionOf(asset.assetType, asset.assetId);
    if (activeVersion != null && activeVersion !== asset.version) continue;

    const manifest = readAssetManifest(layout, asset);
    const alias =
      (manifest.available && manifest.manifest
        ? serverAliasOf(manifest.manifest as Record<string, unknown>)
        : null) ?? asset.assetId;
    if (remote.aliases.has(alias) || attempted.has(alias)) continue;
    attempted.add(alias);

    const result = await reactivateInstalledMcpServer(
      layout,
      store,
      agentRuntimeBaseUrl,
      { assetId: asset.assetId, version: asset.version },
      fetchImpl,
    );
    if (result.ok) restoredCount += 1;
    else failedCount += 1;
  }
  return { checked: true, restoredCount, failedCount, error: null };
}
