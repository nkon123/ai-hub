// D-080 desktop half — main-process orchestration. All HTTP happens in the
// pure `mcp-tool-registration-client.ts`; manifest field validation happens
// in the pure `mcp-tool-manifest.ts`; this file only does the fs lookup
// (`readAssetManifest`) + the `InstalledAssetsStore` round-trip, same split
// `knowledge-activation.ts` keeps for D-079 (and `bundle-install.ts` keeps
// from `bundle-verify.ts`).
//
// The core rule this file exists to enforce, mirroring D-079: "설치됨" and
// "연결됨"(agent-runtime이 이 Tool의 계약을 안다는 뜻) are two separately
// visible facts, and connecting a Tool does NOT itself grant permission to
// call it — the Office Profile does (Task Brief §5). Every attempt outcome —
// success AND failure — is persisted via `InstalledAssetsStore.updateActivation`
// before returning, so a failure the user doesn't see right now is still
// visible later on the 설치된 자산 화면. Only the two refusals with nothing
// to attempt (record not found, wrong asset type) skip persistence — same
// exception D-079's `activateInstalledKnowledge` documents.
//
// `InstalledAsset.activation` (typed `KnowledgeActivation`, D-079) is reused
// as-is rather than inventing a parallel field for MCP Tools — its shape
// (state/checkedAt/reason/message/indexPath) already means the right things
// here too. `indexPath` has no meaning for an MCP Tool connection (there is
// no filesystem index to point at) and is always `null` in this file's
// writes.

import { readAssetManifest } from "./asset-management";
import type { InstallRootLayout } from "./bundle-install";
import type { InstalledAssetsStore } from "./installed-assets-store";
import { parseMcpToolManifest } from "./mcp-tool-manifest";
import {
  deregisterMcpTool,
  listMcpTools,
  registerMcpTool,
  MCP_TOOL_REGISTRATION_DISABLED_REASON,
  type FetchLike,
} from "./mcp-tool-registration-client";
import type { ConnectMcpToolResult, DisconnectMcpToolResult, KnowledgeActivation, ReconcileMcpToolConnectionsResult } from "./types";

export interface McpToolConnectionTarget {
  assetType: string;
  assetId: string;
  version: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function failedConnection(reason: string, message: string): KnowledgeActivation {
  return { state: "FAILED", checkedAt: nowIso(), reason, message, indexPath: null };
}

/**
 * Looks up the installed record, verifies it is an MCP Tool with a readable,
 * complete-enough manifest, then registers its contract with agent-runtime.
 * Persists the outcome (ACTIVE or FAILED) either way, per the module header.
 */
export async function connectInstalledMcpTool(
  layout: InstallRootLayout,
  store: InstalledAssetsStore,
  agentRuntimeBaseUrl: string,
  target: McpToolConnectionTarget,
  fetchImpl?: FetchLike,
): Promise<ConnectMcpToolResult> {
  const asset = store.find(target.assetType, target.assetId, target.version);
  if (!asset) {
    return { ok: false, activation: null, error: "설치된 자산을 찾을 수 없습니다." };
  }
  if (asset.assetType !== "mcp_tool") {
    return { ok: false, activation: null, error: "이 자산 유형은 연결 대상이 아닙니다." };
  }

  const manifestResult = readAssetManifest(layout, asset);
  if (!manifestResult.available) {
    // Task Brief §1: 매니페스트가 없거나 읽을 수 없으면 절대 추측해 등록하지
    // 않는다 — 명시적 실패로 남긴다. `readAssetManifest`가 이미 "없음"과
    // "손상됨"을 구분한 한국어 사유를 돌려준다.
    const activation = failedConnection("manifest_unavailable", manifestResult.reason ?? "Manifest를 읽을 수 없습니다.");
    store.updateActivation(target.assetType, target.assetId, target.version, activation);
    return { ok: false, activation, error: null };
  }

  const parsed = parseMcpToolManifest(manifestResult.manifest);
  if (!parsed.ok) {
    const activation = failedConnection(parsed.reason, parsed.message);
    store.updateActivation(target.assetType, target.assetId, target.version, activation);
    return { ok: false, activation, error: null };
  }

  const result = await registerMcpTool(
    agentRuntimeBaseUrl,
    {
      toolName: parsed.toolName,
      serverAlias: parsed.serverAlias,
      inputSchema: parsed.inputSchema,
      confirmationPolicy: parsed.confirmationPolicy,
      riskLevel: parsed.riskLevel,
      label: parsed.label ?? asset.name,
    },
    fetchImpl,
  );

  if (!result.ok) {
    // Task Brief §3: `mcp_tool_registration_disabled`는 "고장난 자산"이
    // 아니라 이 배포가 아직 이 서버 alias를 동적 등록에 열지 않았다는
    // 배포 정책 상태다 — 재시도해도 운영자가 설정을 바꾸기 전까지는 항상
    // 같은 이유로 거절된다. `reason`을 그대로 보존해 화면(AssetsScreen)이
    // "다시 연결"이 아니라 "운영자에게 요청" 문구/버튼 상태로 분기할 수
    // 있게 한다 — 서버의 `message`는 이미 그 사실과 조치를 담고 있어 여기서
    // 별도 문구를 새로 짓지 않는다(D-079 선례와 동일).
    const activation = failedConnection(result.reason, result.message);
    store.updateActivation(target.assetType, target.assetId, target.version, activation);
    return { ok: false, activation, error: null };
  }

  const activation: KnowledgeActivation = {
    state: "ACTIVE",
    checkedAt: nowIso(),
    reason: null,
    message: null,
    indexPath: null,
  };
  store.updateActivation(target.assetType, target.assetId, target.version, activation);
  return { ok: true, activation, error: null };
}

/** 대상 Tool의 `tool_name`을 다시 얻기 위해 manifest를 한 번 더 읽는다 — 로컬
 * `activation` 레코드는 tool_name을 보존하지 않는다(D-079의 `indexPath`와
 * 달리, 여기서는 그 값 자체가 재등록 시 다시 계산 가능한 파생값이라 별도
 * 저장 필드를 추가하지 않았다). manifest를 읽을 수 없으면 원격 등록 해제는
 * 건너뛰고 경고만 남긴 채 로컬 상태는 항상 정리한다 — D-079의
 * `deactivateInstalledKnowledge`와 동일한 "Runtime/파일 장애에도 로컬 정리는
 * 항상 성공해야 한다" 원칙(CLAUDE.md).
 */
export async function disconnectInstalledMcpTool(
  layout: InstallRootLayout,
  store: InstalledAssetsStore,
  agentRuntimeBaseUrl: string,
  target: McpToolConnectionTarget,
  fetchImpl?: FetchLike,
): Promise<DisconnectMcpToolResult> {
  const asset = store.find(target.assetType, target.assetId, target.version);
  if (!asset) {
    return { ok: false, remoteWarning: null, error: "설치된 자산을 찾을 수 없습니다." };
  }
  if (asset.assetType !== "mcp_tool") {
    return { ok: false, remoteWarning: null, error: "이 자산 유형은 연결 대상이 아닙니다." };
  }

  let remoteWarning: string | null = null;
  const manifestResult = readAssetManifest(layout, asset);
  const parsed = manifestResult.available ? parseMcpToolManifest(manifestResult.manifest) : null;
  if (parsed?.ok) {
    const result = await deregisterMcpTool(agentRuntimeBaseUrl, parsed.toolName, fetchImpl);
    if (!result.ok) {
      remoteWarning = `agent-runtime에서 연결 해제를 확인하지 못했습니다: ${result.message} 로컬 연결 상태는 정리되었습니다.`;
    }
  } else {
    remoteWarning =
      "Manifest를 읽을 수 없어 agent-runtime에 연결 해제를 요청하지 못했습니다. 로컬 연결 상태는 정리되었습니다.";
  }

  store.updateActivation(target.assetType, target.assetId, target.version, null);
  return { ok: true, remoteWarning, error: null };
}

export async function reconcileInstalledMcpToolConnections(
  layout: InstallRootLayout,
  store: InstalledAssetsStore,
  agentRuntimeBaseUrl: string,
  fetchImpl?: FetchLike,
): Promise<ReconcileMcpToolConnectionsResult> {
  const remote = await listMcpTools(agentRuntimeBaseUrl, fetchImpl);
  if (!remote.ok) {
    return { checked: false, downgradedCount: 0, registrationEnabled: null, error: remote.message };
  }

  const registeredNames = new Set(remote.entries.map((entry) => entry.toolName));
  let downgradedCount = 0;
  for (const asset of store.list()) {
    if (asset.assetType !== "mcp_tool" || !asset.activation) continue;
    const manifest = readAssetManifest(layout, asset);
    const parsed = manifest.available ? parseMcpToolManifest(manifest.manifest) : null;
    const stillRegistered = parsed?.ok === true && registeredNames.has(parsed.toolName);

    // 운영자가 정책을 켠 뒤에는 이전 policy-disabled 상태가 영구 잠금으로
    // 남아서는 안 된다. 이미 서버에 등록돼 있으면 ACTIVE로 복구하고,
    // 아니라면 미시도 상태로 돌려 "연결" 버튼을 다시 제공한다.
    if (
      remote.registrationEnabled &&
      asset.activation.state === "FAILED" &&
      asset.activation.reason === MCP_TOOL_REGISTRATION_DISABLED_REASON
    ) {
      store.updateActivation(
        asset.assetType,
        asset.assetId,
        asset.version,
        stillRegistered
          ? { state: "ACTIVE", checkedAt: nowIso(), reason: null, message: null, indexPath: null }
          : null,
      );
      continue;
    }

    if (asset.activation.state !== "ACTIVE") continue;
    if (remote.registrationEnabled && stillRegistered) continue;

    const policyDisabled = !remote.registrationEnabled;
    store.updateActivation(
      asset.assetType,
      asset.assetId,
      asset.version,
      failedConnection(
        policyDisabled ? MCP_TOOL_REGISTRATION_DISABLED_REASON : "not_registered_on_server",
        policyDisabled
          ? "이 배포에서는 MCP Tool 동적 등록이 꺼져 있습니다. 운영자가 서버 alias를 허용 목록에 추가해야 합니다."
          : "agent-runtime의 현재 등록 목록에 이 MCP Tool이 없습니다. 다시 연결하세요.",
      ),
    );
    downgradedCount += 1;
  }
  return { checked: true, downgradedCount, registrationEnabled: remote.registrationEnabled, error: null };
}

export { MCP_TOOL_REGISTRATION_DISABLED_REASON };
