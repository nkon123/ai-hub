// D-034 해석 경로 4 desktop half — main-process orchestration. All HTTP
// happens in the pure `local-agent-registration-client.ts`; this file only
// does the `InstalledAssetsStore` round-trip, same split
// `knowledge-activation.ts` keeps for D-079 and `mcp-tool-connection.ts` for
// D-080.
//
// The one structural difference from those two: this registers a PAIR (an
// `agent` asset + a `prompt` asset), not a single asset. This module never
// guesses that pairing — `promptTarget` is always supplied by the caller
// (the renderer, after the user explicitly picked a Prompt), per Task Brief
// 제약 C ("Never invent a pairing"). This file only does the fs-adjacent
// lookup (`InstalledAssetsStore.find` for both halves) + the HTTP round-trip
// + persistence — it does not read manifests or compute a suggested default;
// that "exactly one Prompt installed -> pre-select it, but still show it"
// decision belongs to the renderer (it needs to list installed Prompts to
// render a picker regardless, and `listInstalledAssets()` already gives it
// that).
//
// Every attempt outcome — success AND failure — is persisted via
// `InstalledAssetsStore.updateLocalAgentRegistration` before returning, so a
// failure the user doesn't see right now is still visible later on the
// 설치된 자산 화면. Only the two refusals with nothing to attempt (agent
// record not found, prompt record not found) skip persistence — same
// exception D-079/D-080 document for their own "not found" cases.

import type { InstalledAssetsStore } from "./installed-assets-store";
import {
  deleteLocalAgent,
  listLocalAgents,
  registerLocalAgent as registerLocalAgentHttp,
  LOCAL_AGENTS_DISABLED_REASON,
  type FetchLike,
} from "./local-agent-registration-client";
import type {
  LocalAgentRegistration,
  ReconcileLocalAgentRegistrationsResult,
  RegisterLocalAgentResult,
  UnregisterLocalAgentResult,
} from "./types";

export interface LocalAgentTarget {
  assetId: string;
  version: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function failedRegistration(reason: string, message: string): LocalAgentRegistration {
  return {
    state: "FAILED",
    checkedAt: nowIso(),
    reason,
    message,
    promptAssetId: null,
    promptVersion: null,
    promptLabel: null,
  };
}

/**
 * Looks up the installed Agent and (caller-chosen) Prompt records, then
 * registers the pair with agent-runtime. Persists the outcome (ACTIVE or
 * FAILED) onto the Agent asset's record either way — never the Prompt's,
 * which has no registration state of its own.
 */
export async function registerInstalledLocalAgent(
  store: InstalledAssetsStore,
  agentRuntimeBaseUrl: string,
  agentTarget: LocalAgentTarget,
  promptTarget: LocalAgentTarget,
  label: string | null | undefined,
  fetchImpl?: FetchLike,
): Promise<RegisterLocalAgentResult> {
  const agentAsset = store.find("agent", agentTarget.assetId, agentTarget.version);
  if (!agentAsset) {
    return { ok: false, registration: null, error: "설치된 Agent 자산을 찾을 수 없습니다." };
  }
  const promptAsset = store.find("prompt", promptTarget.assetId, promptTarget.version);
  if (!promptAsset) {
    // Task Brief 제약 C: Prompt를 찾을 수 없으면(설치 후 제거된 경우 등)
    // 절대 추측해 등록을 진행하지 않는다 — 명시적 실패로 남긴다.
    return { ok: false, registration: null, error: "선택한 Prompt 자산을 찾을 수 없습니다." };
  }

  const result = await registerLocalAgentHttp(
    agentRuntimeBaseUrl,
    {
      agentAssetId: agentAsset.assetId,
      agentVersion: agentAsset.version,
      promptAssetId: promptAsset.assetId,
      promptVersion: promptAsset.version,
      label: label ?? agentAsset.name,
    },
    fetchImpl,
  );

  if (!result.ok) {
    // Task Brief 제약 B: `local_agents_disabled`는 "고장난 자산"이 아니라
    // 이 배포가 allow-root를 설정하지 않은 배포 정책 상태다 — 재시도해도
    // 관리자가 설정을 바꾸기 전까지는 항상 같은 이유로 거절된다. `reason`을
    // 그대로 보존해 화면이 "다시 등록"이 아니라 "관리자에게 요청" 문구로
    // 분기할 수 있게 한다(D-080 선례와 동일). 서버의 `message`는 이미 그
    // 사실과 조치를 담고 있어 여기서 별도 문구를 새로 짓지 않는다.
    const registration = failedRegistration(result.reason, result.message);
    store.updateLocalAgentRegistration("agent", agentAsset.assetId, agentAsset.version, registration);
    return { ok: false, registration, error: null };
  }

  const registration: LocalAgentRegistration = {
    state: "ACTIVE",
    checkedAt: nowIso(),
    reason: null,
    message: null,
    promptAssetId: promptAsset.assetId,
    promptVersion: promptAsset.version,
    // 등록 시점의 표시 이름을 스냅샷으로 저장한다(Prompt가 이후 제거되어도
    // "무엇과 짝지어 등록했는지"를 계속 보여줄 수 있도록) — types.ts의
    // `LocalAgentRegistration.promptLabel` 문서 참고.
    promptLabel: promptAsset.name,
  };
  store.updateLocalAgentRegistration("agent", agentAsset.assetId, agentAsset.version, registration);
  return { ok: true, registration, error: null };
}

/**
 * Unregisters from agent-runtime, then always clears the local registration
 * state — even when the remote call fails/times out (D-079/D-080의
 * `deactivateInstalledKnowledge`/`disconnectInstalledMcpTool`과 동일한
 * 원칙: CLAUDE.md "Desktop은 Runtime 장애 시 종료되지 않고 복구 안내를
 * 제공한다").
 */
export async function unregisterInstalledLocalAgent(
  store: InstalledAssetsStore,
  agentRuntimeBaseUrl: string,
  agentTarget: LocalAgentTarget,
  fetchImpl?: FetchLike,
): Promise<UnregisterLocalAgentResult> {
  const agentAsset = store.find("agent", agentTarget.assetId, agentTarget.version);
  if (!agentAsset) {
    return { ok: false, remoteWarning: null, error: "설치된 Agent 자산을 찾을 수 없습니다." };
  }

  let remoteWarning: string | null = null;
  const result = await deleteLocalAgent(agentRuntimeBaseUrl, agentAsset.assetId, fetchImpl);
  if (!result.ok) {
    remoteWarning = `agent-runtime에서 등록 해제를 확인하지 못했습니다: ${result.message} 로컬 등록 상태는 정리되었습니다.`;
  }

  store.updateLocalAgentRegistration("agent", agentAsset.assetId, agentAsset.version, null);
  return { ok: true, remoteWarning, error: null };
}

// --- 이어 붙이기: 등록 상태 재확인(reconcile) --------------------------------
// 로컬에 저장된 `localAgentRegistration.state === "ACTIVE"`는 시점 스냅샷일
// 뿐이다 — agent-runtime이 다른 `AGENT_RUNTIME_LOCAL_AGENT_ROOTS`로
// 재시작되었거나 등록 레지스트리 파일이 초기화되면, 로컬은 여전히
// ACTIVE라고 믿지만 실제로는 실행되지 않는 "거짓 ACTIVE"가 생긴다 — D-079의
// `computeActivationReconcile`과 동일한 문제, 동일한 해법.

export interface LocalAgentRegistrationDowngrade {
  assetId: string;
  version: string;
  registration: LocalAgentRegistration;
}

/** D-087: Prompt 자산이 제거돼도 짝지어진 Agent 등록은 조용히 사라지지
 * 않는다 — 이 재조정이 다음에 돌 때 여기서 잡혀 FAILED로 강등된다. 등록
 * 시점 사유(`registerInstalledLocalAgent`가 실패 시 쓰는 값들)와도, 서버
 * 쪽 판정 사유(`not_registered_on_server`/`local_agents_disabled`)와도
 * 구분되는 로컬 전용 사유 — "재시도하면 될 수도 있는 실패"가 아니라 "짝의
 * 한쪽이 사라졌다는 사실"이므로 별도 값을 쓴다. */
export const PROMPT_REMOVED_REASON = "prompt_removed";

/** 순수 비교 로직 — fs/네트워크 없음, 단위 테스트 대상.
 *
 * `serverEntries === null`은 "서버에 물어봤지만 응답을 알 수 없음"(도달 불가
 * 포함)을 뜻한다 — 이 경우 절대 아무것도 낮추지 않는다(`checked: false`):
 * 네트워크 장애를 "등록 안 됨"이라는 사실로 둔갑시키지 않는다. 서버 목록을
 * 실제로 받았을 때만(`checked: true`) 아래 두 검사를 수행한다.
 *
 * 1) (D-087) 로컬 ACTIVE 등록 중 짝지어진 Prompt가 더 이상 `installed`
 *    목록에 없는 것 — Agent 제거는 이미 등록 해제로 연쇄되지만(Task Brief
 *    범위 밖), Prompt 제거는 그러지 않는다(D-086 "짝을 지어내지 않는다"와
 *    같은 이유로, 사라짐을 조용히 등록 해제로 연쇄시키지 않고 대신 여기서
 *    무효로 표시한다). 이 검사는 서버 목록 내용과 무관한 순수 로컬 사실이지만,
 *    실제 강등은 agent-runtime 쪽 유령 등록도 함께 정리해야 하므로(재조정
 *    오케스트레이션이 `checked` 분기에서만 DELETE를 시도한다) 서버에 실제로
 *    도달했을 때만(`checked: true`) 수행한다 — 도달 불가 시 아무것도
 *    낮추지 않는다는 위 원칙과 일관된다.
 * 2) 서버 목록을 실제로 받았을 때만(`checked: true`) 로컬 ACTIVE 중 그
 *    목록에 없는 것을 FAILED로 낮춘다.
 *
 * `serverLocalAgentsEnabled === false`는 "등록이 사라졌다"가 아니라 "이
 * 배포는 이 기능 자체를 켜지 않았다"는 뜻이다(agent-runtime에
 * `AGENT_RUNTIME_LOCAL_AGENT_ROOTS` 미설정, Task Brief 제약 B) — 안내가
 * 달라야 한다: 전자에 "다시 등록하세요"라고 말하면 사용자는 반드시 다시
 * 실패하는 행동을 하게 된다. */
export function computeLocalAgentRegistrationReconcile(
  installed: ReadonlyArray<{ assetType: string; assetId: string; version: string; localAgentRegistration?: LocalAgentRegistration | null }>,
  serverEntries: ReadonlyArray<{ agentAssetId: string }> | null,
  serverLocalAgentsEnabled = true,
): { downgrades: LocalAgentRegistrationDowngrade[]; checked: boolean } {
  if (serverEntries === null) {
    return { downgrades: [], checked: false };
  }
  const registeredIds = new Set(serverEntries.map((e) => e.agentAssetId));
  // D-087: Prompt 자산이 아직 설치돼 있는지 판정하기 위한 인덱스 —
  // assetId -> 설치된 version 집합.
  const installedPromptVersions = new Map<string, Set<string>>();
  for (const asset of installed) {
    if (asset.assetType !== "prompt") continue;
    let versions = installedPromptVersions.get(asset.assetId);
    if (!versions) {
      versions = new Set();
      installedPromptVersions.set(asset.assetId, versions);
    }
    versions.add(asset.version);
  }

  const downgrades: LocalAgentRegistrationDowngrade[] = [];
  for (const asset of installed) {
    if (asset.assetType !== "agent") continue;
    const registration = asset.localAgentRegistration;
    if (registration?.state !== "ACTIVE") continue;

    // D-087: 짝 Prompt가 사라졌는지 먼저 본다 — 서버 등록 여부와 무관하게
    // 사실이 성립하면 이쪽 사유를 우선한다(둘 다 해당돼도 "왜"를 하나로
    // 명확히 말해야 한다).
    if (registration.promptAssetId) {
      const versions = installedPromptVersions.get(registration.promptAssetId);
      const promptStillInstalled = versions
        ? registration.promptVersion == null || versions.has(registration.promptVersion)
        : false;
      if (!promptStillInstalled) {
        const promptName = registration.promptLabel ?? registration.promptAssetId;
        downgrades.push({
          assetId: asset.assetId,
          version: asset.version,
          registration: {
            state: "FAILED",
            checkedAt: nowIso(),
            reason: PROMPT_REMOVED_REASON,
            message: `짝지어 등록했던 Prompt "${promptName}"가 제거되어 이 Agent를 대화에 쓸 수 없습니다. 그 Prompt를 다시 설치하거나, 다른 Prompt를 골라 이 Agent를 다시 등록하세요.`,
            promptAssetId: null,
            promptVersion: null,
            promptLabel: null,
          },
        });
        continue;
      }
    }

    if (registeredIds.has(asset.assetId)) continue;
    downgrades.push({
      assetId: asset.assetId,
      version: asset.version,
      registration: {
        state: "FAILED",
        checkedAt: nowIso(),
        reason: serverLocalAgentsEnabled ? "not_registered_on_server" : LOCAL_AGENTS_DISABLED_REASON,
        message: serverLocalAgentsEnabled
          ? "다시 등록하세요 — agent-runtime에 이 Agent의 등록 정보가 없습니다(agent-runtime이 다른 설정으로 재시작되었거나 등록이 초기화되었을 수 있습니다)."
          : "관리자에게 이 PC의 설치 경로를 AGENT_RUNTIME_LOCAL_AGENT_ROOTS 허용 목록에 추가하도록 요청하세요 — 연결된 agent-runtime이 로컬 설치 Agent 등록을 허용하지 않도록 설정되어 있어(AGENT_RUNTIME_LOCAL_AGENT_ROOTS 미설정) 다시 등록해도 같은 이유로 거절됩니다.",
        promptAssetId: null,
        promptVersion: null,
        promptLabel: null,
      },
    });
  }
  return { downgrades, checked: true };
}

/** Main-process 오케스트레이션 — agent-runtime에 실제로 등록된 목록을 받아와
 * 위 순수 비교를 수행하고, 낮출 것이 있으면 저장한다. agent-runtime에
 * 도달할 수 없으면 아무것도 바꾸지 않고 `checked:false`+서버가 준 한국어
 * 메시지를 그대로 반환한다("확인 불가" — 사실을 지어내지 않는다). */
export async function reconcileInstalledLocalAgentRegistrations(
  store: InstalledAssetsStore,
  agentRuntimeBaseUrl: string,
  fetchImpl?: FetchLike,
): Promise<ReconcileLocalAgentRegistrationsResult> {
  const listResult = await listLocalAgents(agentRuntimeBaseUrl, fetchImpl);
  if (!listResult.ok) {
    return { checked: false, downgradedCount: 0, localAgentsEnabled: null, error: listResult.message };
  }
  const installed = store.list();
  const { downgrades, checked } = computeLocalAgentRegistrationReconcile(
    installed,
    listResult.entries.map((e) => ({ agentAssetId: e.agentAssetId })),
    listResult.localAgentsEnabled,
  );
  for (const d of downgrades) {
    store.updateLocalAgentRegistration("agent", d.assetId, d.version, d.registration);
    // D-087 제약 C: Prompt가 사라져 로컬을 FAILED로 낮춘 경우, agent-runtime
    // 쪽에 남아 있을 수 있는 유령 등록도 함께 정리한다 — 그러지 않으면 다른
    // 실행 경로(예: Hosted 쪽)가 그 등록을 여전히 유효한 것으로 볼 수 있다.
    // (`not_registered_on_server` 사유는 서버가 이미 그 등록을 갖고 있지
    // 않다는 뜻이므로 DELETE를 다시 보낼 필요가 없다.)
    // 이 호출이 실패해도 위에서 이미 반영한 로컬 강등은 되돌리지 않는다 —
    // `unregisterInstalledLocalAgent`/자산 제거 훅과 동일한 "Desktop은
    // Runtime 장애 시 종료되지 않는다" 원칙(CLAUDE.md).
    if (d.registration.reason === PROMPT_REMOVED_REASON) {
      await deleteLocalAgent(agentRuntimeBaseUrl, d.assetId, fetchImpl);
    }
  }
  return {
    checked,
    downgradedCount: downgrades.length,
    localAgentsEnabled: listResult.localAgentsEnabled,
    error: null,
  };
}
