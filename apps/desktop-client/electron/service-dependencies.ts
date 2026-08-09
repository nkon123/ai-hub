// D08 로컬 자산 관리 — "의존 관계 보기" / 제거 전 "참조 중인 Service" 확인의
// 근거 데이터. 순수 함수만 포함(fs/electron import 없음) — 실제 파일을 읽어
// 이 모듈에 데이터를 넣어주는 쪽(`asset-management.ts`)과 분리해 Vitest로
// 크래프트한 입력만으로 전부 검증할 수 있게 한다 (`bundle-verify.ts`와 동일한
// 설계 원칙).
//
// 여기서 파싱하는 `service-definition.json`은 Offline Bundle을 통해
// `assets/services/{asset_id}/{version}/service-definition.json`에 그대로
// 설치된 파일이다(`packages/schemas/manifests/service-definition.schema.json`,
// `distribution_service/bundler.py::collect()`). 필드 이름은 그 스키마를
// 그대로 따른다 — 값은 전부 "참조하는 Asset id + semver 버전 문자열"이며,
// AssetVersion UUID(D-060이 다루는 별도 식별자 공간)가 아니다. `InstalledAsset`
// 역시 `assetId`(Asset id)+`version`(semver)로 저장되므로 동일한 식별자
// 공간끼리 비교한다.

export interface ServiceAgentRef {
  id: string;
  version: string;
}

export interface ServiceKnowledgeBinding {
  roleId: string;
  knowledgeId: string;
  knowledgeVersion: string;
}

export interface ServiceMcpBinding {
  roleId: string;
  toolId: string;
  toolVersion: string;
}

export interface ServicePromptBinding {
  roleId: string;
  promptId: string;
  promptVersion: string;
}

/** Bindings extracted from one installed Service version's
 * `service-definition.json`, plus the Service's own identity so a match can
 * be reported back to the user by name. */
export interface InstalledServiceBindings {
  assetId: string;
  name: string;
  version: string;
  agentRef: ServiceAgentRef | null;
  knowledgeBindings: ServiceKnowledgeBinding[];
  mcpBindings: ServiceMcpBinding[];
  promptBindings: ServicePromptBinding[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Parses a `service-definition.json` payload into the binding shape above.
 * Never throws — a malformed/foreign file (e.g. hand-edited, or a future
 * schema version this build predates) yields `null` rather than crashing the
 * D08 screen; the caller treats that as "의존 관계 정보를 읽을 수 없음", not as
 * "no dependencies" (those are different facts — see `readAssetManifest`
 * disabling the action with a stated reason instead of silently proceeding).
 */
export function parseServiceDefinition(raw: unknown): InstalledServiceBindings | null {
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.version)) return null;

  let agentRef: ServiceAgentRef | null = null;
  if (isRecord(raw.agent_ref) && isNonEmptyString(raw.agent_ref.id) && isNonEmptyString(raw.agent_ref.version)) {
    agentRef = { id: raw.agent_ref.id, version: raw.agent_ref.version };
  }

  const knowledgeBindings: ServiceKnowledgeBinding[] = [];
  if (Array.isArray(raw.knowledge_bindings)) {
    for (const item of raw.knowledge_bindings) {
      if (isRecord(item) && isNonEmptyString(item.knowledge_id) && isNonEmptyString(item.knowledge_version)) {
        knowledgeBindings.push({
          roleId: isNonEmptyString(item.role_id) ? item.role_id : "",
          knowledgeId: item.knowledge_id,
          knowledgeVersion: item.knowledge_version,
        });
      }
    }
  }

  const mcpBindings: ServiceMcpBinding[] = [];
  if (Array.isArray(raw.mcp_bindings)) {
    for (const item of raw.mcp_bindings) {
      if (isRecord(item) && isNonEmptyString(item.tool_id) && isNonEmptyString(item.tool_version)) {
        mcpBindings.push({
          roleId: isNonEmptyString(item.role_id) ? item.role_id : "",
          toolId: item.tool_id,
          toolVersion: item.tool_version,
        });
      }
    }
  }

  const promptBindings: ServicePromptBinding[] = [];
  if (Array.isArray(raw.prompt_bindings)) {
    for (const item of raw.prompt_bindings) {
      if (isRecord(item) && isNonEmptyString(item.prompt_id) && isNonEmptyString(item.prompt_version)) {
        promptBindings.push({
          roleId: isNonEmptyString(item.role_id) ? item.role_id : "",
          promptId: item.prompt_id,
          promptVersion: item.prompt_version,
        });
      }
    }
  }

  return {
    assetId: raw.id,
    name: isNonEmptyString(raw.name) ? raw.name : raw.id,
    version: raw.version,
    agentRef,
    knowledgeBindings,
    mcpBindings,
    promptBindings,
  };
}

export type BindingKind = "agent_ref" | "knowledge_bindings" | "mcp_bindings" | "prompt_bindings";

export interface ReferencingService {
  assetId: string;
  name: string;
  version: string;
  via: BindingKind;
}

export interface AssetRef {
  assetType: string;
  assetId: string;
  version: string;
}

/**
 * Which installed Services reference the given asset — the real (not
 * advisory-only) basis for D08's "제거 전 참조 중인 Service를 확인한다" rule.
 * A Service is never reported as referencing itself.
 */
export function findReferencingServices(target: AssetRef, services: InstalledServiceBindings[]): ReferencingService[] {
  const matches: ReferencingService[] = [];
  for (const svc of services) {
    if (target.assetType === "service" && svc.assetId === target.assetId) continue;

    if (
      target.assetType === "agent" &&
      svc.agentRef &&
      svc.agentRef.id === target.assetId &&
      svc.agentRef.version === target.version
    ) {
      matches.push({ assetId: svc.assetId, name: svc.name, version: svc.version, via: "agent_ref" });
      continue;
    }
    if (
      target.assetType === "knowledge" &&
      svc.knowledgeBindings.some((b) => b.knowledgeId === target.assetId && b.knowledgeVersion === target.version)
    ) {
      matches.push({ assetId: svc.assetId, name: svc.name, version: svc.version, via: "knowledge_bindings" });
      continue;
    }
    if (
      target.assetType === "mcp_tool" &&
      svc.mcpBindings.some((b) => b.toolId === target.assetId && b.toolVersion === target.version)
    ) {
      matches.push({ assetId: svc.assetId, name: svc.name, version: svc.version, via: "mcp_bindings" });
      continue;
    }
    if (
      target.assetType === "prompt" &&
      svc.promptBindings.some((b) => b.promptId === target.assetId && b.promptVersion === target.version)
    ) {
      matches.push({ assetId: svc.assetId, name: svc.name, version: svc.version, via: "prompt_bindings" });
    }
  }
  return matches;
}
