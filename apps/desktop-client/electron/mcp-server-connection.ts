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
import { activateInstalledMcpServer, type FetchLike } from "./mcp-server-activation";
import type { ActivateMcpServerResult, KnowledgeActivation } from "./types";

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
