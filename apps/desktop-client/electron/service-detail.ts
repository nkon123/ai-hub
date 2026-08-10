// D03 Service/Agent 상세 (`02-desktop-and-agent-runtime.md` §D03) — assembles
// the detail view for one installed asset entirely from real local data
// (installed-asset records, `service-definition.json`, and an installed
// Knowledge's own `index/index-meta.json`). Several §D03 fields have no
// reliable local source today; those are returned as `{ available: false,
// reason }` rather than a fabricated value (CLAUDE.md, open-decisions.md
// D-076) — never a silent omission, never a plausible-looking guess.
//
// Reuses, rather than re-derives, everything that already exists:
//  - dependency resolution (agent_ref/knowledge/mcp/prompt bindings, with
//    installed-or-not per entry) is `asset-management.ts::getAssetDependencyView`,
//    D08's own source of truth for the same relationship.
//  - status (ACTIVE/INACTIVE/INVALID/REVOKED) is `asset-management.ts::computeStatusForAsset`.
//  - manifest reading is `asset-management.ts::readAssetManifest` (handles
//    the service-definition.json vs manifest.json filename difference).
import fs from "node:fs";
import path from "node:path";
import { assetInstallDir, computeStatusForAsset, getAssetDependencyView, loadRevocationEntries, readAssetManifest } from "./asset-management";
import { ActiveVersionStore } from "./active-version-store";
import type { InstallRootLayout } from "./bundle-install";
import type { InstalledAssetsStore } from "./installed-assets-store";
import type {
  BindingKind,
  ServiceDetailBinding,
  ServiceDetailKnowledgeIndexInfo,
  ServiceDetailModelPolicy,
  ServiceDetailPurpose,
  ServiceDetailResult,
  ServiceDetailUsageExamples,
  ServiceDetailView,
} from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// service-definition.schema.json declares no input-field/allowed-file
// concept at all (packages/schemas/manifests/service-definition.schema.json)
// — the same root gap D06/ChatScreen already documents (open-decisions.md
// D-058) for why no file-attach UI can be shown. D03 states this plainly
// instead of omitting the row or inventing a plausible schema.
const INPUT_FIELDS_GAP_REASON =
  "service-definition.json Schema(packages/schemas/manifests/service-definition.schema.json)에는 입력 필드·허용 파일 형식을 선언하는 필드가 없습니다 — Service Definition은 Agent·Knowledge·MCP·Prompt·모델 정책만 선언하고, 입력 Form 계약은 아직 없습니다(open-decisions.md D-058/D-076).";

// bundle-manifest.yaml의 runtime_requirements(os/python/model_aliases)는 D04
// 가져오기 시점에 RUNTIME_COMPAT 검사로 한 번 확인될 뿐, 개별 설치 자산
// 레코드(InstalledAsset)에는 저장되지 않는다 — 가져오기가 끝나면 그
// Manifest 자체가 staging에서 삭제된다(bundle-install.ts).
const RUNTIME_REQUIREMENTS_GAP_REASON =
  "요구 Runtime/Client 버전은 Bundle 전체의 bundle-manifest.yaml에만 있고(D04 가져오기 시점에 RUNTIME_COMPAT 검사로 한 번 확인됨), 개별 설치 자산 레코드에는 저장되지 않습니다 — 가져오기가 끝나면 그 Manifest는 삭제됩니다(open-decisions.md D-076).";

const APPROVAL_STATUS_GAP_REASON =
  "설치된 자산에는 Portal의 승인(VersionStatus) 값이 저장되지 않습니다 — Offline Bundle 가져오기는 중단·폐기(Revocation) 여부만 검사해 통과시킬 뿐, APPROVED 등 구체적인 상태 값 자체를 로컬에 남기지 않습니다(open-decisions.md D-076).";

const RESOLVED_MODEL_NOTE =
  "Desktop은 아직 Office Profile을 가져오는 기능이 없어(open-decisions.md D-074) 모델 Alias가 실제로 어떤 model_id로 해석되는지 확인할 수 없습니다. 아래 Alias는 이 Service가 선언한 값이며, 실제 해석은 Local Agent Runtime이 자신의 Office Profile(office-profile.json)로 수행합니다.";

const TOOL_RISK_NOTE =
  "이 PoC의 모든 MCP Tool은 읽기 전용만 구현합니다(CLAUDE.md 구현 원칙 8) — 변경(쓰기) 작업을 수행하는 Tool은 존재하지 않습니다. 아래 확인 정책(Confirmation Policy)은 각 Tool의 실행 전 사용자 확인 요구 수준을 나타냅니다.";

const INSTALL_SIZE_NOTE =
  "이 자산 자체와, 로컬에 실제로 설치되어 있는 참조 대상(Agent/Knowledge/MCP 설정/Prompt)의 설치 용량 합계입니다. 참조하지만 설치되지 않은 대상은 포함하지 않습니다.";

const BINDING_ASSET_TYPE: Record<BindingKind, string> = {
  agent_ref: "agent",
  knowledge_bindings: "knowledge",
  mcp_bindings: "mcp_tool",
  prompt_bindings: "prompt",
};

function extractPurpose(manifest: unknown): ServiceDetailPurpose {
  if (isRecord(manifest) && isNonEmptyString(manifest.description)) {
    return { available: true, value: manifest.description, source: "manifest.description", reason: null };
  }
  return {
    available: false,
    value: null,
    source: null,
    reason: "이 자산의 Manifest에는 description(업무 목적 설명)이 입력되지 않았습니다(선택 필드).",
  };
}

function extractUsageExamples(manifest: unknown): ServiceDetailUsageExamples {
  if (isRecord(manifest) && isRecord(manifest.chatbot_config) && Array.isArray(manifest.chatbot_config.suggested_questions)) {
    const values = (manifest.chatbot_config.suggested_questions as unknown[]).filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (values.length > 0) {
      return { available: true, values, source: "manifest.chatbot_config.suggested_questions", reason: null };
    }
  }
  return {
    available: false,
    values: [],
    source: null,
    reason:
      "이 자산의 Manifest에는 chatbot_config.suggested_questions(추천 질문)이 없습니다 — Knowledge 챗봇 Quick Create Service에만 있는 선택 필드입니다.",
  };
}

function extractModelPolicy(manifest: unknown): ServiceDetailModelPolicy | null {
  if (!isRecord(manifest) || !isRecord(manifest.model_policy)) return null;
  const mp = manifest.model_policy;
  if (!isNonEmptyString(mp.model_alias)) return null;
  return {
    modelAlias: mp.model_alias,
    fallbackAllowed: mp.fallback_allowed === true,
    maxContextTokens: typeof mp.max_context_tokens === "number" ? mp.max_context_tokens : null,
  };
}

/** Keyed by `${tool_id}::${tool_version}` so a lookup against
 * `AssetDependencyView.forward`'s already-resolved MCP entries is a single
 * map read, not a second parse per binding. */
function extractMcpConfirmationPolicies(manifest: unknown): Map<string, string | null> {
  const map = new Map<string, string | null>();
  if (isRecord(manifest) && Array.isArray(manifest.mcp_bindings)) {
    for (const item of manifest.mcp_bindings as unknown[]) {
      if (isRecord(item) && isNonEmptyString(item.tool_id) && isNonEmptyString(item.tool_version)) {
        const policy = isNonEmptyString(item.confirmation_policy) ? item.confirmation_policy : null;
        map.set(`${item.tool_id}::${item.tool_version}`, policy);
      }
    }
  }
  return map;
}

/** Reads an installed Knowledge version's own `index/index-meta.json` — the
 * actual embedding model that Knowledge's index was built with (same source
 * `search_runtime.hybrid.resolve_embed_model` reads server-side for search,
 * D-075). Bundles copy the whole index directory tree as-is under the
 * Knowledge asset's install folder (`distribution_service.bundler.collect`),
 * so this file is really there whenever the Knowledge itself is installed. */
function readKnowledgeIndexInfo(
  layout: InstallRootLayout,
  assetId: string,
  version: string,
  installed: boolean,
): ServiceDetailKnowledgeIndexInfo {
  if (!installed) {
    return {
      available: false,
      embedModel: null,
      chunkingStrategy: null,
      source: null,
      reason: "이 Knowledge 버전이 로컬에 설치되어 있지 않아 색인 정보를 읽을 수 없습니다.",
    };
  }
  const metaPath = path.join(assetInstallDir(layout, "knowledge", assetId, version), "index", "index-meta.json");
  if (!fs.existsSync(metaPath)) {
    return {
      available: false,
      embedModel: null,
      chunkingStrategy: null,
      source: null,
      reason: "설치된 Knowledge에 index/index-meta.json이 없습니다(표준 구성 자산이거나 색인이 포함되지 않은 이전 형식의 Bundle).",
    };
  }
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    const embedModel = isRecord(raw) && isNonEmptyString(raw.embed_model) ? raw.embed_model : null;
    const chunkingStrategy = isRecord(raw) && isNonEmptyString(raw.chunking_strategy) ? raw.chunking_strategy : null;
    if (!embedModel) {
      return {
        available: false,
        embedModel: null,
        chunkingStrategy,
        source: null,
        reason: "index-meta.json에 embed_model 값이 없습니다(이전 형식의 색인일 수 있습니다).",
      };
    }
    return {
      available: true,
      embedModel,
      chunkingStrategy,
      source: `assets/knowledge/${assetId}/${version}/index/index-meta.json (설치된 색인 자체에 기록된 값 — D-075와 동일한 원칙)`,
      reason: null,
    };
  } catch {
    return {
      available: false,
      embedModel: null,
      chunkingStrategy: null,
      source: null,
      reason: "index-meta.json을 읽을 수 없습니다(손상되었을 수 있음).",
    };
  }
}

export function getServiceDetailView(
  layout: InstallRootLayout,
  store: InstalledAssetsStore,
  target: { assetType: string; assetId: string; version: string },
): ServiceDetailResult {
  const asset = store.find(target.assetType, target.assetId, target.version);
  if (!asset) {
    return { available: false, reason: "설치된 자산을 찾을 수 없습니다.", detail: null };
  }

  const revocationEntries = loadRevocationEntries(layout);
  const status = computeStatusForAsset(asset, revocationEntries, new ActiveVersionStore(layout.stateDir));

  const dependencyView = getAssetDependencyView(layout, store, asset);
  const manifestResult = readAssetManifest(layout, asset);
  const rawManifest = manifestResult.available ? manifestResult.manifest : null;
  const mcpConfirmationPolicies = extractMcpConfirmationPolicies(rawManifest);

  const bindings: ServiceDetailBinding[] = dependencyView.forward.map((f) => {
    const binding: ServiceDetailBinding = {
      label: f.label,
      refType: f.refType,
      assetId: f.assetId,
      version: f.version,
      installed: f.installed,
    };
    if (f.refType === "knowledge_bindings") {
      binding.indexInfo = readKnowledgeIndexInfo(layout, f.assetId, f.version, f.installed);
    }
    if (f.refType === "mcp_bindings") {
      binding.confirmationPolicy = mcpConfirmationPolicies.get(`${f.assetId}::${f.version}`) ?? null;
    }
    return binding;
  });

  // 설치 용량 합계 — 대상 자산 자체 + 실제로 설치되어 있는 참조 대상만.
  // 같은 (assetType, assetId, version)이 두 번 이상 참조되어도(이론상)
  // 중복 합산하지 않는다.
  let installSizeBytes = asset.sizeBytes;
  const countedKeys = new Set<string>([`${target.assetType}::${target.assetId}::${target.version}`]);
  for (const f of dependencyView.forward) {
    if (!f.installed) continue;
    const depAssetType = BINDING_ASSET_TYPE[f.refType];
    const key = `${depAssetType}::${f.assetId}::${f.version}`;
    if (countedKeys.has(key)) continue;
    const depAsset = store.find(depAssetType, f.assetId, f.version);
    if (depAsset) {
      installSizeBytes += depAsset.sizeBytes;
      countedKeys.add(key);
    }
  }

  const detail: ServiceDetailView = {
    assetId: asset.assetId,
    assetType: asset.assetType,
    name: asset.name,
    version: asset.version,
    status,
    checksumVerification: asset.checksumVerification ?? null,
    purpose: extractPurpose(rawManifest),
    usageExamples: extractUsageExamples(rawManifest),
    inputFields: { available: false, reason: INPUT_FIELDS_GAP_REASON },
    bindings,
    bindingsNote: dependencyView.forwardNote,
    modelPolicy: extractModelPolicy(rawManifest),
    resolvedModelNote: RESOLVED_MODEL_NOTE,
    runtimeRequirements: { available: false, reason: RUNTIME_REQUIREMENTS_GAP_REASON },
    toolRiskNote: TOOL_RISK_NOTE,
    approvalStatus: { available: false, reason: APPROVAL_STATUS_GAP_REASON },
    installSizeBytes,
    installSizeNote: INSTALL_SIZE_NOTE,
  };

  return { available: true, reason: null, detail };
}
