// Shared IPC/domain types between the Electron main process and the React
// renderer (M04). Interface-only — no runtime code — so the renderer bundle
// (Vite) can import this file with zero cost and no Electron dependency.

// `version-diff.ts` is itself interface-plus-pure-function-only (no fs/
// electron imports), so re-using its result type here (rather than
// hand-duplicating a parallel shape, as some other IPC-boundary types in this
// file do for historical reasons) cannot pull any runtime code into the
// renderer bundle — `import type` is erased entirely at compile time.
import type { VersionDiffResult } from "./version-diff";
// D14 스케줄 실행 — `schedule-time.ts`도 fs/electron import가 없는 순수
// 모듈이므로(코드 배치 규칙) 여기서 그 타입을 재사용해도 렌더러 번들에
// 런타임 비용이 붙지 않는다(`import type`은 컴파일 시 완전히 지워진다).
import type { ScheduleExpression } from "./schedule-time";
export type { ScheduleExpression } from "./schedule-time";

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "SKIP";

/** One row of the D04/D05 검증·사전점검 checklist shown to the user. */
export interface CheckItem {
  id: string;
  /** Korean label shown as the checklist row title. */
  label: string;
  status: CheckStatus;
  /** Korean explanation — always present so the UI never shows a bare status. */
  message: string;
}

export interface IncludedAssetSummary {
  asset_id: string | null;
  /** AssetVersion id — the id agent-runtime/search-runtime actually key
   * Knowledge search by (D-060 fix, `packages/schemas/manifests/bundle-manifest.schema.json`).
   * `null` for STANDARD_LOCAL_COPY items (no backing AssetVersion) and for
   * Bundles built before this field existed — never fall back to asset_id
   * when this is null, that silently reintroduces the D-060 bug. */
  asset_version_id: string | null;
  asset_type: string;
  role: string;
  name: string | null;
  version: string | null;
  required: boolean;
  status: string;
  size_bytes: number;
}

export interface BundleManifest {
  bundle_id: string;
  created_at: string;
  requested_by: string | null;
  target_site_id: string | null;
  root_type: string;
  root_id: string;
  included_assets: IncludedAssetSummary[];
  runtime_requirements: {
    os: string;
    python: string;
    model_aliases: string[];
  };
  install_order: string[];
  forbidden_or_suspended_versions_present: boolean;
  total_installed_size_bytes: number;
}

export type ImportStage =
  | "QUARANTINE_COPY"
  | "ZIP_STRUCTURE"
  | "PATH_SAFETY"
  | "NESTED_ARCHIVE"
  | "EXECUTABLE_POLICY"
  | "SIZE_CAP"
  | "DISK_SPACE"
  | "EXTRACT"
  | "CHECKSUM"
  | "MANIFEST_SCHEMA"
  | "REVOCATION"
  | "RUNTIME_COMPAT"
  | "SIGNATURE_TRUST"
  | "ALREADY_INSTALLED"
  | "INSTALL";

export interface ImportProgressEvent {
  stage: ImportStage;
  status: CheckStatus;
  message: string;
}

/** Korean checklist labels keyed by stage id — shared by the main-process
 * emitter (`bundle-install.ts`) and the renderer's live progress list, so
 * the two never drift apart. */
export const STAGE_LABELS: Record<ImportStage, string> = {
  QUARANTINE_COPY: "격리 영역으로 복사",
  ZIP_STRUCTURE: "ZIP 구조 확인",
  PATH_SAFETY: "경로 안전성 검사(Zip Slip 방어)",
  NESTED_ARCHIVE: "중첩 압축 금지 정책",
  EXECUTABLE_POLICY: "실행 파일 확장자 정책",
  SIZE_CAP: "압축 해제 예상 용량(Zip Bomb 방어)",
  DISK_SPACE: "설치 대상 경로 여유 공간",
  EXTRACT: "압축 해제",
  CHECKSUM: "Checksum 일치 검증",
  MANIFEST_SCHEMA: "Manifest 형식 검사",
  REVOCATION: "Revocation List 검사",
  RUNTIME_COMPAT: "Runtime/OS 호환성",
  SIGNATURE_TRUST: "Signature/Trust 상태",
  ALREADY_INSTALLED: "기존 설치 버전 확인",
  INSTALL: "설치 완료",
};

export interface ImportResult {
  outcome: "SUCCESS" | "FAILED";
  checks: CheckItem[];
  failedStage: string | null;
  retryable: boolean;
  manifest: BundleManifest | null;
  installPlan: IncludedAssetSummary[];
  totalSizeBytes: number;
}

export interface InstalledAsset {
  assetId: string;
  /** AssetVersion id carried through from `IncludedAssetSummary.asset_version_id`
   * (D-060). A legacy Knowledge may be backfilled only from its
   * checksum-verified installed index-meta.json. Otherwise `null` means
   * "cannot be used as a knowledge_id" and callers must never substitute
   * assetId. */
  assetVersionId: string | null;
  assetType: string;
  name: string;
  version: string;
  installedAt: string;
  sizeBytes: number;
  bundleId: string;
  /** Per-file SHA-256, keyed by path relative to this asset's own install
   * folder, captured from the Bundle's `checksums.sha256` at install time
   * (D08 "Checksum 재검사" 기준값). `undefined` for installs that predate
   * this field or have nothing to compare (e.g. a STANDARD_LOCAL_COPY item)
   * — D08 disables reverification for those rather than fabricating a
   * result. */
  fileChecksums?: Record<string, string>;
  /** Result of the most recent D08 "Checksum 재검사" action, or `null` if it
   * has never been run. Never implies PASS by omission — the D08 UI must
   * read this field, not assume it. */
  checksumVerification?: ChecksumVerification | null;
  /** Result of the most recent D-079 활성화(activation, `assetType ===
   * "knowledge"`) attempt against search-runtime's Local Knowledge Index
   * Registration contract, OR the most recent D-080 연결(connection,
   * `assetType === "mcp_tool"`) attempt against agent-runtime's MCP Tool
   * Activation contract, or `null` after an explicit 비활성화/연결 해제.
   * One shared field, not two parallel ones — the same three states already
   * mean the right thing for both (`electron/mcp-tool-connection.ts`'s
   * module header explains why this was reused rather than a new field).
   * **Absence (the field itself being `undefined`) means "시도한 적이 없다"
   * and must never be rendered as ACTIVE** — same "생략으로 결과를 지어내지
   * 않는다" rule `checksumVerification` above already follows. The UI must
   * read this field explicitly and distinguish 네 가지: 필드 없음(미시도),
   * `state: "FAILED"` (시도했으나 실패 — MCP Tool의 `reason ===
   * "mcp_tool_registration_disabled"`는 이 중에서도 "재시도해도 소용없는
   * 배포 정책 상태"로 별도 안내가 필요하다, Task Brief §3), `state:
   * "ACTIVE"` (Knowledge: 이 Desktop이 search-runtime에 직접 등록해 검색
   * 가능 / MCP Tool: agent-runtime이 이 Tool의 계약을 앎 — 호출 "가능"이
   * 아니라 계약을 "안다"는 뜻뿐이다, Task Brief §5), `state:
   * "ALREADY_ACTIVE"` (Knowledge 전용, `reason === "central_index_exists"`
   * — 즉 이 Knowledge는 search-runtime의 중앙 INDEX_BASE에 이미 있어 별도
   * 등록 없이도 검색 가능. 아래 `KnowledgeActivation` 문서 참고. MCP Tool은
   * 이 state를 만들지 않는다). "설치됨"(이 레코드가 존재한다는 사실)과
   * "활성화/연결됨"(이 필드가 `state: "ACTIVE"` 또는 `"ALREADY_ACTIVE"`라는
   * 사실)은 서로 다른 사실이다(open-decisions.md D-079/D-080). */
  activation?: KnowledgeActivation | null;
  /** D-034 해석 경로 4 이어 붙이기 — `assetType === "agent"`에만 의미가
   * 있다. "설치됨"과 "등록됨(agent-runtime이 이 Agent+Prompt 짝을 알아
   * `input.local_agent_id`로 Run을 실행할 수 있음)"은 서로 다른 사실이다
   * (Knowledge/MCP Tool과 같은 원칙). `KnowledgeActivation`을 그대로
   * 재사용하지 않는 이유: 이 등록은 Agent 하나가 아니라 Agent+Prompt
   * "짝"을 등록하는 것이라 어떤 Prompt와 짝지어졌는지(및 그 표시 이름)를
   * 화면에 항상 보여줘야 한다(Task Brief 제약 C) — `KnowledgeActivation`
   * 형태에는 그 필드가 없다. 필드 자체가 없으면(`undefined`) "시도한 적
   * 없음"이고, `null`은 명시적 등록 해제 — 위 `activation` 필드와 동일한
   * 관례. */
  localAgentRegistration?: LocalAgentRegistration | null;
}

/** D-034 해석 경로 4 — `electron/local-agent-registration.ts`가
 * agent-runtime 응답(`electron/local-agent-registration-client.ts`)을 이
 * 형태로 저장한다. `state`는 두 값뿐이다 — Knowledge의 `"ALREADY_ACTIVE"`에
 * 대응하는 개념이 없다(agent-runtime이 "이미 다른 경로로 등록되어 있어
 * 필요 없음"이라고 거절하는 경우가 계약에 없다, `agent_asset_id` 기준
 * Idempotent 재등록만 있다). */
export interface LocalAgentRegistration {
  state: "ACTIVE" | "FAILED";
  checkedAt: string;
  /** `LocalAgentRefusalReason`의 값 중 하나, 또는 로컬에서만 판정한 사유
   * (예: `"prompt_not_found"`) — 로직/Telemetry 전용, 화면 표시는 항상
   * `message`. `state === "ACTIVE"`이면 `null`. */
  reason: string | null;
  /** 항상 한국어, 화면에 그대로 표시 가능. `state === "ACTIVE"`이면 `null`. */
  message: string | null;
  /** 짝지어진 Prompt 자산 — `state === "ACTIVE"`일 때만 채워진다.
   * "추측으로 짝을 만들지 않는다"(Task Brief 제약 C)는 등록 시점의 규칙이고,
   * 이 필드는 그 결과를 사후에도 계속 보여주기 위한 것이다. */
  promptAssetId: string | null;
  promptVersion: string | null;
  /** 등록 시점의 Prompt 자산 표시 이름(`InstalledAsset.name`) — Prompt가
   * 이후 제거되어도 "무엇과 짝지어 등록했는지"를 계속 보여줄 수 있도록
   * 스냅샷으로 저장한다(재조회하지 않는다). */
  promptLabel: string | null;
}

// ---------------------------------------------------------------------------
// D-034 해석 경로 4 — Local Agent 등록("설치됨" ≠ "실행에 쓸 수 있음")
// ---------------------------------------------------------------------------
// D-079/D-080과 같은 원칙, 다만 이번엔 자산 하나가 아니라 Agent+Prompt "짝"을
// 등록한다(Task Brief 제약 C: 절대 이름 유사도로 자동 짝짓기하지 않는다,
// 짝은 항상 사용자가 고르거나 — Prompt가 정확히 1개뿐일 때만 — 기본값으로
// 미리 골라 보여준다).

export interface RegisterLocalAgentResult {
  /** `state: "FAILED"`만 `ok: false`. `reason === "local_agents_disabled"`도
   * `ok: false`이지만(실제로 등록되지 않았다는 사실은 참이다) 이 배포가
   * allow-root를 설정하지 않은 배포 정책 상태이지 고장난 자산이 아니다 —
   * 화면은 "다시 등록"이 아니라 관리자에게 설치 경로를 알려주는 안내로
   * 분기해야 한다(Task Brief 제약 B). */
  ok: boolean;
  /** Persisted onto the Agent asset's `InstalledAsset` record whenever an
   * actual attempt was made. `null` only for the refusals that never touch
   * the record because there was nothing to attempt: Agent/Prompt 대상을
   * 찾을 수 없음 — 그 사유는 `error`에 담긴다. */
  registration: LocalAgentRegistration | null;
  /** Non-null only when `registration` is `null` — see above. */
  error: string | null;
}

export interface UnregisterLocalAgentResult {
  ok: boolean;
  /** Non-null when the local registration state was cleared successfully but
   * the DELETE call to agent-runtime failed or was unreachable —
   * informational only. Unregistration must still succeed locally in this
   * case (CLAUDE.md: Desktop은 Runtime 장애 시 종료되지 않고 복구 안내를
   * 제공한다). */
  remoteWarning: string | null;
  /** Non-null only when `ok === false`(대상을 찾을 수 없음). */
  error: string | null;
}

/** `electron/local-agent-registration.ts`의
 * `reconcileInstalledLocalAgentRegistrations` 결과 — D-079/D-080의 reconcile과
 * 동일한 형태. `localAgentsEnabled`는 이 배포가 allow-root를 아예 설정하지
 * 않았는지(Task Brief 제약 B)를 재확인 시점마다 다시 알려준다 — 한 번
 * 확인하고 캐시하지 않는다(운영자가 배포 도중 설정을 바꿀 수 있다). */
export interface ReconcileLocalAgentRegistrationsResult {
  checked: boolean;
  downgradedCount: number;
  localAgentsEnabled: boolean | null;
  error: string | null;
}

/** D-079 활성화 결과 — `electron/knowledge-activation.ts`가 search-runtime
 * 응답(`electron/search-runtime-client.ts`)을 이 형태로 저장한다.
 *
 * 세 번째 state, `"ALREADY_ACTIVE"`(2026-08-13 실사용 진단): search-runtime은
 * 이미 `INDEX_BASE`(중앙 색인 경로)에 존재하는 `knowledge_id`의 로컬 등록을
 * 항상 `central_index_exists` 사유로 거부한다(서버 쪽 설계 불변식 — 중앙
 * 색인이 항상 우선한다, `services/search-runtime`의 `local_index_registry.py`
 * 참고, 이 저장소는 절대 바꾸지 않는다). 이 거부는 "검색이 안 됨"이 아니라
 * "이미 검색 가능해서 등록이 필요 없음"이라는 뜻이다 — search-runtime이 그
 * `knowledge_id`를 실제로 서빙하고 있기 때문이다. 이 사실을 `state: "FAILED"`
 * (빨간 배지, "활성화 실패")로 보여주면 실제로는 멀쩡히 검색되는 자산에
 * 거짓 알람을 띄우는 것이므로, 별도 state로 분리했다 — `state: "ACTIVE"`와
 * 마찬가지로 채팅에서 검색 가능한 것으로 취급해야 하지만(`chatTypes.ts`의
 * `partitionInstalledKnowledgeByActivation` 참고), Desktop이 실제로 그
 * search-runtime에 등록을 소유한 것은 아니므로(등록 자체가 거부됐다) 별도
 * 라벨로 구분해 보여준다. `ok: true`로 반환된다(사용자에게 실패로 보이지
 * 않는다) — `electron/knowledge-activation.ts::activateInstalledKnowledge`
 * 참고. */
export interface KnowledgeActivation {
  state: "ACTIVE" | "ALREADY_ACTIVE" | "FAILED";
  checkedAt: string;
  /** `SearchRuntimeRefusalReason`의 값 중 하나, 또는 로컬에서만 판정한 사유
   * (예: `"asset_version_id_missing"`, `"index_dir_missing"`) — 로직/Telemetry
   * 전용이며 화면 표시 문구는 항상 `message`를 쓴다. `state === "ACTIVE"`이면
   * `null`. `state === "ALREADY_ACTIVE"`이면 항상 `"central_index_exists"`. */
  reason: string | null;
  /** 항상 한국어, 화면에 그대로 표시 가능. `state === "ACTIVE"`이면 `null`.
   * `state === "ALREADY_ACTIVE"`이면 search-runtime이 보낸, 이미 검색
   * 가능하다는 사실을 설명하는 안내 문구(실패 문구가 아니다) — 화면은 이
   * 문구를 경고색이 아닌 안내/성공 톤으로 표시해야 한다. */
  message: string | null;
  /** 활성화를 시도한 절대 경로 — 성공/실패 모두에서 채워진다(어떤 경로가
   * 시도되었는지는 실패 원인 진단에도 필요하다). 경로 계산 자체가 불가능했던
   * 경우(예: `assetVersionId`가 없어 애초에 요청을 만들 수 없었던 경우)에만
   * `null`. */
  indexPath: string | null;
}

/** `assets:list`'s actual return shape — `InstalledAsset` plus a `status`
 * computed fresh by the main process on every call (never persisted as a
 * raw field on disk; see `electron/asset-status.ts`). Kept as a separate
 * type rather than making `status` a field on `InstalledAsset` itself so the
 * on-disk stored shape (`InstalledAssetsStore`) never has to fabricate a
 * status when constructing a record at install time. */
export interface InstalledAssetWithStatus extends InstalledAsset {
  status: AssetStatus;
}

export interface ChecksumVerification {
  checkedAt: string;
  result: "PASS" | "FAIL";
  mismatched: string[];
  missing: string[];
}

// ---------------------------------------------------------------------------
// D08 로컬 자산 관리
// ---------------------------------------------------------------------------

/** Derived, not stored as a raw flag — see `electron/asset-status.ts`.
 * "INACTIVE" is part of the spec's filter vocabulary but is never actually
 * produced today: the install layout has no Active-Version pointer concept
 * (open-decisions.md D-068), so every non-revoked/non-invalid version reads
 * as ACTIVE. The filter option stays visible (it just returns no rows) —
 * the "Active Version 전환" action itself is what carries the disabled
 * reason in the UI. */
export type AssetStatus = "ACTIVE" | "INACTIVE" | "INVALID" | "REVOKED";

export type BindingKind = "agent_ref" | "knowledge_bindings" | "mcp_bindings" | "prompt_bindings";

export interface ReferencingServiceInfo {
  assetId: string;
  name: string;
  version: string;
  via: BindingKind;
}

/** Result of the D08 removal-blocking check — see `electron/removal-guard.ts`
 * for the decision logic this mirrors across the IPC boundary. */
export interface AssetRemovalCheck {
  blocked: boolean;
  referencingServices: ReferencingServiceInfo[];
  /** `false` means the in-progress-Run portion of the check could not be
   * performed (see `runCheckNote`) — NOT that it was performed and found
   * nothing. The UI must render these two cases differently. */
  runCheckAvailable: boolean;
  runCheckNote: string;
  /** D12/D-068: true when this removal is blocked specifically because the
   * target is the current Active Version and another installed version
   * exists to switch to first. */
  blockedByActiveVersion: boolean;
  /** Korean explanation for the active-version axis, or `null` when it does
   * not apply — see `removal-guard.ts`'s `RemovalGuardResult.activeVersionNote`. */
  activeVersionNote: string | null;
}

export interface RemoveAssetResult {
  ok: boolean;
  error?: string;
  /** Present when `ok === false` because the removal-blocking rule fired —
   * lets the UI list the referencing Services by name instead of only a
   * generic error string. */
  blockedBy?: ReferencingServiceInfo[];
  /** D-079 이어 붙이기: `ok === true`인데도 알려야 할 것이 있을 때만 채워진다
   * — Knowledge 제거 중 search-runtime 등록 해제가 실패/불가했던 경우
   * (제거 자체는 계속 진행되었다: search-runtime은 사라진 디렉터리의 등록을
   * 스스로 정리하므로 제거를 막을 이유가 아니다, `electron/main.ts`의
   * `assets:remove` 핸들러 참고). */
  warning?: string | null;
}

export interface AssetManifestResult {
  available: boolean;
  /** Korean reason shown in place of the manifest when `available` is
   * false (e.g. a STANDARD_LOCAL_COPY item with no manifest.json on disk). */
  reason: string | null;
  manifest: unknown | null;
}

/** One installed, chat-usable Knowledge offered to agent-runtime's
 * KNOWLEDGE_ROUTE stage (agentic Knowledge selection,
 * `agent_runtime.knowledge_router`, `KnowledgeCandidateInput` in
 * `packages/schemas/api/local-runtime-api.yaml`) — field names match the
 * wire contract exactly (snake_case `knowledge_id`, not this file's usual
 * camelCase) because this object is sent to agent-runtime byte-for-byte, not
 * translated at another layer first.
 *
 * `name` always comes from the installed record itself (`InstalledAsset.name`
 * — the only field the record itself carries). `description`/`tags`/
 * `classification` — when present — come from that Knowledge's own
 * `manifest.json` (`packages/schemas/manifests/knowledge-manifest.schema.json`).
 * A missing/unreadable manifest (legacy Bundle, STANDARD_LOCAL_COPY) omits
 * those three fields rather than inventing them — see
 * `electron/knowledge-candidates.ts`'s `buildKnowledgeCandidate`, the pure
 * function that decides this per asset. */
export interface KnowledgeCandidate {
  knowledge_id: string;
  name?: string;
  description?: string;
  tags?: string[];
  classification?: string;
  retrieval_profile?: {
    strategy?: "balanced_hybrid" | "keyword_priority" | "semantic_priority";
    top_k?: number;
    hybrid_alpha?: number;
    min_relevance_score?: number;
    enable_parent_expansion?: boolean;
  };
}

/** D10 설정 — 설치된 Knowledge 하나의 "실제로 검색에 쓰일 임베딩 모델"을
 * 보여준다(`electron/knowledge-embed-model.ts`의 `resolveKnowledgeEmbedModelInfo`
 * 가 만든다, fs 읽기는 `asset-management.ts`의 `listKnowledgeEmbedModels`).
 * 옛 `DesktopSettingsPublic.embeddingModelAlias`(자유 입력, 아무도 읽지
 * 않았음)를 대체한다 — 이 값은 사용자가 편집하는 설정이 아니라 각 Knowledge
 * 색인 자신이 이미 가진 사실이다(D-075 `resolve_embed_model`가 검색 시점에
 * 실제로 적용하는 모델과 동일한 출처: 그 Knowledge의 `index/index-meta.json`).
 * `state`를 반드시 구분해서 렌더링한다 — `RECORDED`가 아닌 경우 `embedModel`
 * 이름을 지어내 보여주면 안 된다. */
export interface KnowledgeEmbedModelInfo {
  assetId: string;
  name: string;
  version: string;
  /** `RECORDED`: index-meta.json에 실제로 기록된 모델(`embedModel`에 채워짐).
   * `ASSUMED_FALLBACK`: 기록이 없어 search-runtime이 자신의 기본 설정으로
   * 대체한다는 뜻 — 그 기본값 자체는 Desktop이 알 수 없으므로 `embedModel`은
   * `null`로 남는다(추정치를 지어내지 않는다). `UNREADABLE`: 색인 디렉터리가
   * 없거나 손상되어 확인 자체가 불가능하다. */
  state: "RECORDED" | "ASSUMED_FALLBACK" | "UNREADABLE";
  /** `state === "RECORDED"`일 때만 채워진다. */
  embedModel: string | null;
  /** 화면에 그대로 표시 가능한 한국어 설명(위 세 상태를 이미 반영한 문구). */
  detail: string;
}

export interface AssetDependencyView {
  /** This asset's own declared dependencies. Only Service assets carry real
   * entries here — an Agent/Knowledge/Prompt/MCP Package manifest declares
   * capability flags, not concrete dependency Asset ids (see
   * `forwardNote`). */
  forward: Array<{ label: string; refType: BindingKind; assetId: string; version: string; installed: boolean }>;
  /** Non-null explanation of why `forward` is empty for non-Service assets —
   * never silently show an empty list as "no dependencies" without saying
   * why. */
  forwardNote: string | null;
  referencedBy: ReferencingServiceInfo[];
}

// ---------------------------------------------------------------------------
// D12 업데이트/복구
// ---------------------------------------------------------------------------

/** D12 "현재와 새 버전 Diff" 결과 — `electron/version-diff.ts`의
 * `computeManifestDiff` 그대로. `available=false`면 두 버전 모두의 Manifest를
 * 읽을 수 없어 비교 자체가 불가능했다는 뜻(예: 둘 다 STANDARD_LOCAL_COPY) —
 * 이 경우 빈 Diff("변경 없음")로 보여주면 거짓이므로 구분한다. */
export interface AssetVersionDiffResponse {
  available: boolean;
  reason: string | null;
  diff: VersionDiffResult | null;
}

export interface ActivateVersionResult {
  ok: boolean;
  error: string | null;
}

export interface OrphanedInstallCleanupResult {
  removed: Array<{ assetType: string; assetId: string; version: string }>;
}

// ---------------------------------------------------------------------------
// D-079 Knowledge 활성화("설치됨" ≠ "활성화됨")
// ---------------------------------------------------------------------------

export interface ActivateKnowledgeResult {
  /** `state: "ACTIVE"`와 `state: "ALREADY_ACTIVE"` 모두 `ok: true`다 — 사용자
   * 입장에서 둘 다 "이제(또는 이미) 검색된다"는 같은 결론이고, 실패가
   * 아니다(`KnowledgeActivation.state`의 `"ALREADY_ACTIVE"` 문서 참고).
   * `state: "FAILED"`만 `ok: false`. */
  ok: boolean;
  /** Persisted onto the `InstalledAsset` record whenever an actual attempt
   * was made (assetVersionId 확인, index 폴더 확인, search-runtime 호출 —
   * 성공/실패/이미 등록됨 모두). `null` only for the two refusals that never
   * touch the record because there was nothing to attempt: 대상을 찾을 수
   * 없음, 이 자산 유형은 활성화 대상이 아님 — 그 사유는 `error`에 담긴다. */
  activation: KnowledgeActivation | null;
  /** Non-null only when `activation` is `null` — see above. */
  error: string | null;
}

/** D-079 이어 붙이기 — `electron/knowledge-activation.ts`의
 * `reconcileInstalledKnowledgeActivations` 결과. `checked: false`는
 * search-runtime에 도달하지 못해 확인 자체를 하지 못했다는 뜻이며(네트워크
 * 장애를 "등록 안 됨"으로 지어내지 않는다), 이때 `error`에 서버/네트워크가
 * 준 한국어 메시지가 담긴다. `checked: true`이면 실제로 비교가 수행된
 * 것이며, `downgradedCount`는 로컬 ACTIVE였으나 search-runtime 목록에 없어
 * FAILED로 낮춘 개수(0이면 전부 최신 상태). */
export interface ReconcileKnowledgeActivationsResult {
  checked: boolean;
  downgradedCount: number;
  error: string | null;
}

export interface DeactivateKnowledgeResult {
  ok: boolean;
  /** Non-null when the local activation state was cleared successfully but
   * the DELETE call to search-runtime failed or was unreachable —
   * informational only. Deactivation must still succeed locally in this case
   * (CLAUDE.md: Desktop은 Runtime 장애 시 종료되지 않고 복구 안내를 제공한다) —
   * otherwise a user could never uninstall cleanly while search-runtime is
   * down. */
  remoteWarning: string | null;
  /** Non-null only when `ok === false` (대상을 찾을 수 없음, 또는 이 자산
   * 유형은 활성화 대상이 아님). */
  error: string | null;
}

// ---------------------------------------------------------------------------
// D-080 MCP Tool 연결("설치됨" ≠ "연결됨", agent-runtime이 계약을 앎)
// ---------------------------------------------------------------------------
// `InstalledAsset.activation`(위 `KnowledgeActivation`)을 그대로 재사용한다
// — MCP Tool에도 같은 세 state(`ACTIVE`/`ALREADY_ACTIVE`/`FAILED`, 필드
// 자체 없음=미시도)가 그대로 맞는 뜻이다. `indexPath`만 MCP Tool에는 의미가
// 없어 항상 `null`(전용 필드를 새로 만들지 않는다 — `electron/mcp-tool-connection.ts`
// 참고). 연결은 이 Tool의 계약(입력 Schema/확인 정책)을 agent-runtime에
// 알리는 것일 뿐, 호출 권한을 부여하지 않는다 — 실제 실행 권한은 Office
// Profile이 이미 정한 대로다(D-080 계약 최상위 설명, 구현 원칙 7).

export interface ConnectMcpToolResult {
  /** `state: "FAILED"`만 `ok: false` — Knowledge의 `ActivateKnowledgeResult`와
   * 동일한 규약. `reason === "mcp_tool_registration_disabled"`도 `ok: false`
   * 이지만(실제로 연결되지 않았다는 사실은 참이다), 배포 정책 상태이지 고장난
   * 자산이 아니므로 화면은 "다시 연결"이 아니라 운영자에게 요청하라는
   * 안내로 분기해야 한다(Task Brief §3). */
  ok: boolean;
  /** Persisted onto the `InstalledAsset` record whenever an actual attempt
   * was made (manifest 읽기, agent-runtime 호출 모두). `null` only for the
   * two refusals that never touch the record because there was nothing to
   * attempt: 대상을 찾을 수 없음, 이 자산 유형은 연결 대상이 아님 — 그
   * 사유는 `error`에 담긴다. */
  activation: KnowledgeActivation | null;
  /** Non-null only when `activation` is `null` — see above. */
  error: string | null;
}

export interface DisconnectMcpToolResult {
  ok: boolean;
  /** Non-null when the local connection state was cleared successfully but
   * either the manifest could not be re-read (so `tool_name` was unknown and
   * the DELETE call was never attempted) or the DELETE call to agent-runtime
   * failed/was unreachable — informational only. Disconnection must still
   * succeed locally in this case (CLAUDE.md: Desktop은 Runtime 장애 시
   * 종료되지 않고 복구 안내를 제공한다). */
  remoteWarning: string | null;
  /** Non-null only when `ok === false` (대상을 찾을 수 없음, 또는 이 자산
   * 유형은 연결 대상이 아님). */
  error: string | null;
}

export interface ReconcileMcpToolConnectionsResult {
  checked: boolean;
  downgradedCount: number;
  registrationEnabled: boolean | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// D-084 "Desktop 로컬 Tool" — 사용자가 직접 고른 .py 파일 하나의 함수를,
// 실행하지 않고 정적으로 분석해 입력 Schema를 만들고, 이후 사용자가 명시적
// 확인을 거쳐 매 호출마다 그 파일을 로컬에서 직접 실행한다. D-083
// TOOL_ROUTE/D-080 MCP Tool 등록과 **구조적으로 분리**되어 있다 — 이 값들은
// agent-runtime에도, 대화 화면의 Tool 후보 조립에도 절대 전달되지 않는다
// (`electron/__tests__/local-tool-isolation.test.ts`가 소스 텍스트를 직접
// 읽어 그 사실을 강제한다). 자세한 경계와 잔여 위험은
// `docs/implementation-spec/open-decisions.md` D-084 참고.
// ---------------------------------------------------------------------------

export interface LocalToolParameterInfo {
  name: string;
  schemaType: string;
  required: boolean;
  defaultIncluded: boolean;
}

export interface LocalToolDiscardedInfo {
  bodyStatementCount: number;
  decoratorCount: number;
  docstringPresent: boolean;
  sourceExecuted: false;
  sourcePersisted: false;
}

export type LocalToolSignatureRefusalReason =
  | "source_empty"
  | "source_too_large"
  | "function_not_found"
  | "multiple_functions_found"
  | "function_name_invalid"
  | "variadic_parameters_unsupported"
  | "parameter_annotation_missing"
  | "unsupported_annotation"
  | "identity_parameter_forbidden"
  | "too_many_parameters"
  /** `@tool`/`@mcp.tool`로 선택된 여러 함수 중 이름이 같은 것이 또 있을 때만
   * 쓰인다(`LocalToolCandidateResult`) — 아래 단일 결과 타입에서는 절대
   * 나오지 않는다. */
  | "duplicate_function_name_in_file"
  /** fs 읽기 자체가 실패한 경우(파일이 이동/삭제/권한 문제) — 순수 파서
   * (`local-tool-signature.ts`)에는 없는, main process 전용 실패 사유. */
  | "file_unreadable";

export interface LocalToolSignatureFailure {
  ok: false;
  reason: LocalToolSignatureRefusalReason;
  message: string;
  candidates?: string[];
}

export interface LocalToolSignatureSuccess {
  ok: true;
  functionName: string;
  toolName: string;
  inputSchema: Record<string, unknown>;
  parameters: LocalToolParameterInfo[];
  discarded: LocalToolDiscardedInfo;
  warnings: string[];
}

export type LocalToolSignatureResult = LocalToolSignatureSuccess | LocalToolSignatureFailure;

/** D-084 후속("@tool 데코레이터로 여러 Tool 등록") — 파일 하나에서 발견된
 * 함수 하나에 대한 미리보기 결과. 성공/실패 모두 `functionName`을 담아
 * 여러 후보를 화면에서 나란히 보여줄 수 있게 한다(`LocalToolSignatureFailure`
 * 와 달리 이건 파일 전체가 아니라 함수 하나짜리 결과다). */
export interface LocalToolCandidateSuccess {
  ok: true;
  functionName: string;
  toolName: string;
  inputSchema: Record<string, unknown>;
  parameters: LocalToolParameterInfo[];
  discarded: LocalToolDiscardedInfo;
  warnings: string[];
}

export interface LocalToolCandidateFailure {
  ok: false;
  functionName: string;
  reason: LocalToolSignatureRefusalReason;
  message: string;
}

export type LocalToolCandidateResult = LocalToolCandidateSuccess | LocalToolCandidateFailure;

/** `inspectLocalToolFile`의 반환 타입. `@tool`/`@mcp.tool`이 붙은 함수가
 * 하나 이상 있으면 그 함수들 각각이 `candidates`에 담기고
 * `selectedByDecorator: true`다. 데코레이터가 전혀 없고 최상위 함수가
 * 정확히 하나면(기존 동작, 회귀 없음) 그 함수 하나만 담기고
 * `selectedByDecorator: false`다. 데코레이터 없이 함수가 여럿이면 여전히
 * `LocalToolSignatureFailure`(`reason: "multiple_functions_found"`)로 파일
 * 전체가 거절된다 — 화면은 이 경우 후보 목록 없이 안내 문구만 보여준다. */
export interface LocalToolFileAnalysisSuccess {
  ok: true;
  selectedByDecorator: boolean;
  candidates: LocalToolCandidateResult[];
}

export type LocalToolFileAnalysisResult = LocalToolFileAnalysisSuccess | LocalToolSignatureFailure;

/** D-084 후속 3 ("최초 한번만 승인") — a standing "skip the per-run dialog"
 * approval for one local tool, bound to the exact file CONTENT at approval
 * time via `approvedFileHash` (sha256 hex, `local-tool-store.ts`'s
 * `hashLocalToolSource`), not to the path. `electron/main.ts`'s
 * `localTool:invoke` handler re-reads the file and recomputes this hash on
 * every invocation — a mismatch means the approval is stale and the native
 * dialog is shown again. Set only by the 자산 > 로컬 Tool screen's explicit
 * "실행 허용" action; the per-run execution dialog never writes this (그
 * 대화상자의 승인은 기억되지 않는다 — Task Brief 제약). */
export interface LocalToolApproval {
  approvedAt: string;
  approvedFileHash: string;
}

/** 렌더러에 노출되는 저장된 로컬 Tool 레코드. `id`는 항상
 * `crypto.randomUUID()`이며 파일명/함수명에서 파생되지 않는다(사용자가 준
 * 이름으로 경로/식별자를 만들지 않는다는 CLAUDE.md 규칙).
 * `riskAcknowledgedAt`은 절대 `null`이 아니다 — `LocalToolStore.add()`가
 * `acknowledgedRisk: true` 없이는 애초에 레코드를 만들지 않는다(구조적
 * 강제, UI 체크박스는 그 강제의 표현일 뿐이다). `approval`은 이것과 별개다
 * — 항상 `null`로 시작하고(기존 Tool을 소급 승인하지 않는다), 자산 > 로컬
 * Tool 화면에서 명시적으로 "실행 허용"을 눌러야만 값이 생기며, 언제든
 * "허용 해제"로 다시 `null`로 되돌릴 수 있다. */
export interface LocalTool {
  id: string;
  filePath: string;
  functionName: string;
  toolName: string;
  inputSchema: Record<string, unknown>;
  parameters: LocalToolParameterInfo[];
  discarded: LocalToolDiscardedInfo;
  warnings: string[];
  addedAt: string;
  riskAcknowledgedAt: string;
  approval: LocalToolApproval | null;
}

/** 매 호출의 결과 — 여섯 가지 outcome은 서로 다른 사실이며 화면에서 절대
 * 하나의 "실패"로 뭉개지 않는다(Task Brief). `interpreter_not_configured`는
 * 프로세스를 아예 띄우기 전에 판정되는 유일한 outcome이다. */
export type LocalToolInvocationResult =
  | { outcome: "success"; result: unknown }
  | { outcome: "function_error"; errorType: string; errorMessage: string }
  | { outcome: "nonzero_exit"; exitCode: number; stderrSnippet: string }
  | { outcome: "timeout"; timeoutMs: number }
  | { outcome: "oversized_output"; limitBytes: number }
  | { outcome: "spawn_error"; message: string }
  | { outcome: "interpreter_not_configured" }
  /** 사용자가 Main Process의 네이티브 실행 승인 대화상자에서 거부했다. 렌더러의
   * 확인 UI와 별개로, 승인 판정은 항상 Main Process가 한다 — 렌더러만
   * 확인을 담당하면 브릿지에 도달하는 다른 경로가 승인 없이 Python을 실행할 수
   * 있고, 그것이 구현 원칙 7이 금지하는 "승인되지 않은 임의 Python 실행"이다
   * (D-084). D-084 후속 3 이후 대화상자가 매번 뜨지는 않는다: `approval`이
   * 있고 그 `approvedFileHash`가 지금 파일 내용과 일치하면 생략된다. 그 둘이
   * 이 기능이 구현 원칙 7을 계속 만족시키는 유일한 근거다(D-089).
   * 추가 시점의 위험 고지(`riskAcknowledgedAt`)는 여전히 이 승인을 대신하지
   * 않는다 — 파일 내용에 묶여 있지 않아 이후 어떤 코드가 실행될지 보장하지
   * 못한다. */
  | { outcome: "user_denied" }
  /** 실사용 제보(2026-08-19) — 대화형 실행 중 사용자가 명시적으로 중단했다.
   * `user_denied`와 마찬가지로 오류가 아니라 정상 결과다: 사용자가 원해서
   * 멈춘 것이지 무언가 실패한 것이 아니다. Main Process가 spawn된 프로세스를
   * 실제로 SIGKILL로 종료한 뒤에만 이 outcome을 반환한다(`local-tool-runner.ts`
   * `runLocalToolProcess`의 `signal` 처리, `electron/__tests__/local-tool-runner.test.ts`의
   * "실제로 프로세스가 죽는지" 회귀 테스트 참고) — 렌더러가 "취소했다"고
   * 표시만 하고 프로세스가 살아있는 상태는 이 outcome이 의미하는 바가 아니다. */
  | { outcome: "cancelled" };

// ---------------------------------------------------------------------------
// D11 로그/진단
// ---------------------------------------------------------------------------

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/** One structured log line written by the main process itself (never by
 * copying arbitrary renderer/user content — see `electron/app-logger.ts`'s
 * module docstring for why the log SOURCE is kept minimal rather than
 * relying only on redaction at export time). */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  /** Which internal module emitted this — e.g. "bundle-install",
   * "asset-management", "connections". Free text, not a closed enum, since
   * new modules will keep being added. */
  module: string;
  message: string;
  runId?: string;
  traceId?: string;
  errorCode?: string;
}

export interface LogFilters {
  /** ISO timestamps — inclusive range. Either bound may be omitted. */
  from?: string;
  to?: string;
  level?: LogLevel;
  runId?: string;
  traceId?: string;
  module?: string;
  errorCode?: string;
}

/** Allowlisted diagnostic Bundle shape — every field here is deliberately
 * enumerated (see `electron/diagnostic-bundle.ts`'s module docstring for why
 * this must never become "spread everything, then strip"). `logs` has
 * already been filtered to the requested period AND sanitized
 * (`electron/log-sanitizer.ts`) before this object is ever constructed. */
export interface DiagnosticBundle {
  generatedAt: string;
  clientVersion: string;
  runtimeVersion: string | null;
  runtimeVersionNote: string | null;
  os: { platform: string; release: string; arch: string };
  /** Always `null` today — Desktop is Electron/Node (D-006), and Local Agent
   * Runtime's `/health` does not report its Python interpreter version. See
   * `pythonVersionNote` and open-decisions.md. */
  pythonVersion: null;
  pythonVersionNote: string;
  sanitizedSettings: Record<string, string>;
  installedAssets: Array<{ assetId: string; assetType: string; version: string; contentHash: string | null }>;
  health: ConnectionStatus[];
  logs: LogEntry[];
}

/** D-079 이어 붙이기: `"search"`(search-runtime)를 추가 — Knowledge 채팅이
 * 로컬 검색·활성화 모두를 search-runtime에 의존하므로 D09 연결 상태에서
 * 독립적으로 확인해야 한다(`electron/connections.ts`의
 * `assessChatConnections` 문서 참고). */
export type ConnectionId = "runtime" | "ollama" | "mcp" | "search";

export interface ConnectionStatus {
  id: ConnectionId;
  label: string;
  ok: boolean;
  detail: string;
  checkedAt: string;
  latencyMs: number | null;
  recoveryHint: string | null;
}

/** Ollama에 실제 설치된 모델 이름 목록 — D01 4단계("설치된 Chat/Embedding
 * 모델 확인")가 쓴다. Desktop은 "Alias -> 실제 model_id" 매핑을 모른다(그
 * 매핑은 agent-runtime이 로드하는 Office Profile에만 있고, Desktop에는 아직
 * Office Profile 가져오기 기능이 없다 — open-decisions.md 참고) — 그래서
 * Alias별 PASS/FAIL을 단정하지 않고, Ollama가 보고하는 설치된 모델 이름을
 * 그대로 보여주는 정직한 목록에 그친다. */
export interface OllamaModelsResult {
  ok: boolean;
  models: string[];
  error: string | null;
}

export interface OllamaChatInput {
  question: string;
  history: Array<{ question: string; answer: string }>;
}

export interface OllamaChatResult {
  answer: string;
  model: string;
}

// ---------------------------------------------------------------------------
// D01 최초 설정 Wizard / D10 설정
// ---------------------------------------------------------------------------

/** "최대 동시 Run 수"는 오늘 Desktop이 실제로 강제할 수 없다(단일 창·단일
 * 대화, Local Agent Runtime에 동시성 제한 없음) — 편집 가능한 숫자가 아니라
 * 이 구조로만 노출해 "바꿔도 아무 효과 없는 설정"을 만들지 않는다
 * (`electron/desktop-settings.ts`, open-decisions.md D-074). */
export interface MaxConcurrentRunsInfo {
  value: number;
  enforced: boolean;
  reason: string;
}

/** D01/D10이 공유하는 설정 저장소(`electron/desktop-settings.ts`)의
 * 렌더러/IPC 노출 형태. 이 안에는 실제 Secret이 없다(Ollama/MCP 모두 이
 * PoC에서는 인증이 없음) — 그래서 `PortalSettingsPublic`과 달리 모든 필드가
 * 그대로 노출된다. */
export interface DesktopSettingsPublic {
  clientDisplayName: string | null;
  siteId: string | null;
  ollamaBaseUrl: string;
  ollamaAllowNonLoopback: boolean;
  chatModelAlias: string;
  // `embeddingModelAlias`(자유 입력 Alias)는 2026-08-14 제거되었다 — 어떤
  // 코드도 이 값을 읽지 않았다(search-runtime/indexing-runtime/agent-runtime
  // 어디에도 도달하지 않음, `desktop-settings.ts` 참고). "바꿔도 아무것도
  // 달라지지 않는 설정은 없는 것보다 나쁘다"(`MAX_CONCURRENT_RUNS_*`와 같은
  // 원칙). 실제로 검색에 쓰이는 임베딩 모델은 사용자가 고르는 값이 아니라
  // Knowledge 색인 자신이 `index-meta.json`에 이미 기록해 둔 사실이다 —
  // `getKnowledgeEmbedModels()`가 그 사실을 설치된 Knowledge마다 읽기 전용
  // 으로 보여준다(D10 SettingsScreen). 재색인(모델 교체)은 Portal
  // `/admin/settings`(P15)가 소유한다.
  mcpServerAlias: string;
  mcpServerUrl: string;
  /** D-079 — search-runtime의 Local Knowledge Index Registration 계약
   * Base URL. loopback만 허용된다(Ollama와 달리 원격 허용 예외 없음 —
   * `network-policy.ts`의 `validateSearchRuntimeBaseUrl` 참고: 활성화
   * 요청이 이 기기의 절대 경로를 담기 때문). */
  searchRuntimeBaseUrl: string;
  /** D-080 후속 — Local Agent Runtime Base URL. 대화 실행(D06/D07), 연결
   * 판정(D09), MCP Tool 등록/해제가 **모두 이 하나의 값**을 쓴다. 이전에는
   * 렌더러가 빌드 타임 `VITE_AGENT_RUNTIME_BASE_URL`을, Main Process가
   * `connections.ts`의 하드코딩 기본값을 각각 봤고, 그래서 대화는 되는데
   * 연결 배너는 "끊김"이라고 말하는 상태가 실제로 있었다. loopback만
   * 허용된다(`network-policy.ts::validateAgentRuntimeBaseUrl`). */
  agentRuntimeBaseUrl: string;
  /** D-084 "Desktop 로컬 Tool" 실행에 쓰는 Python 인터프리터 절대 경로.
   * 기본값 `null` — 어떤 코드도 `python`/`python3` 같은 PATH 검색으로
   * 대체하지 않는다(구현 원칙 7: 승인되지 않은 임의 실행을 만들지 않는다 —
   * 사용자가 명시적으로 설정하지 않은 인터프리터로 조용히 실행을 시도하는
   * 것도 그 원칙 위반이다). 값이 `null`/빈 문자열이면
   * `invokeLocalTool`은 프로세스를 아예 띄우지 않고
   * `interpreter_not_configured`를 반환한다. */
  pythonInterpreterPath: string | null;
  /** 실사용 제보(2026-08-19) — 대화(채팅)에서 직접 로컬 Tool을 실행할 때
   * 1회 호출을 기다리는 상한(분). 기존에는 `local-tool-runner.ts`의
   * `LOCAL_TOOL_TIMEOUT_MS`(30초) 고정값이었다 — 실제 작업을 하는 Tool에는
   * 너무 짧아 중간에 끊겼다. 기본값 5분, 1~60분 사이로만 저장할 수 있다
   * (`desktop-settings.ts`의 `DEFAULT_LOCAL_TOOL_TIMEOUT_MINUTES`/
   * `MIN_LOCAL_TOOL_TIMEOUT_MINUTES`/`MAX_LOCAL_TOOL_TIMEOUT_MINUTES`).
   * 스케줄별 `ScheduleRecord.timeoutMinutes`와는 완전히 독립적이다 — 한쪽을
   * 바꿔도 다른 쪽에는 전혀 영향을 주지 않는다(대화형 대 스케줄 실행은
   * 별개의 실행 경로다). 값만 올리는 대신, 실행 중 사용자가 중단할 수
   * 있는 수단(`DesktopBridge.cancelLocalToolInvocation`)이 함께 있어야만
   * 이 값을 늘리는 것이 안전하다 — 취소 수단 없이 값만 올리면 멈춘 Tool을
   * 이 시간 내내 붙잡고 빠져나올 방법이 없어진다. */
  localToolTimeoutMinutes: number;
  maxConcurrentRuns: MaxConcurrentRunsInfo;
  setupCompletedAt: string | null;
  updatedAt: string | null;
}

/** 부분 업데이트 입력 — 제공된 필드만 검증·반영된다(All-or-nothing: 하나라도
 * 검증에 실패하면 아무것도 저장되지 않는다). */
export interface DesktopSettingsInput {
  clientDisplayName?: string;
  siteId?: string;
  ollamaBaseUrl?: string;
  ollamaAllowNonLoopback?: boolean;
  chatModelAlias?: string;
  mcpServerAlias?: string;
  mcpServerUrl?: string;
  searchRuntimeBaseUrl?: string;
  agentRuntimeBaseUrl?: string;
  pythonInterpreterPath?: string;
  localToolTimeoutMinutes?: number;
}

export interface DesktopSettingsUpdateResult {
  ok: boolean;
  error: string | null;
  settings: DesktopSettingsPublic;
}

export interface DiskSpaceInfo {
  path: string;
  freeBytes: number;
}

// ---------------------------------------------------------------------------
// D03 Service/Agent 상세
// ---------------------------------------------------------------------------

/** service-definition.json's optional `description` — D03's "업무 목적". */
export interface ServiceDetailPurpose {
  available: boolean;
  value: string | null;
  source: string | null;
  reason: string | null;
}

/** service-definition.json's optional `chatbot_config.suggested_questions` —
 * D03's "사용 예". Present only for Knowledge Chatbot Quick Create services. */
export interface ServiceDetailUsageExamples {
  available: boolean;
  values: string[];
  source: string | null;
  reason: string | null;
}

/** A field D03 wants to show but has no reliable local source for — instead
 * of fabricating a plausible-looking value, this shape lets the UI render
 * "미기재" + a stated reason (CLAUDE.md, open-decisions.md D-076). */
export interface ServiceDetailGap {
  available: false;
  reason: string;
}

/** D03's "모델 정책과 현재 해석된 모델" — only the declared policy, since
 * Desktop cannot resolve `modelAlias` to an actual model_id today (no Office
 * Profile import, open-decisions.md D-074) — see `resolvedModelNote` on
 * `ServiceDetailView` for why. */
export interface ServiceDetailModelPolicy {
  modelAlias: string;
  fallbackAllowed: boolean;
  maxContextTokens: number | null;
}

/** Installed Knowledge's own `index/index-meta.json` — the actual model an
 * index was built with (same source `search_runtime.hybrid.resolve_embed_model`
 * reads server-side, D-075), read locally since a Bundle's index files are
 * installed as-is under the Knowledge asset's own folder. */
export interface ServiceDetailKnowledgeIndexInfo {
  available: boolean;
  embedModel: string | null;
  chunkingStrategy: string | null;
  source: string | null;
  reason: string | null;
}

/** One row of D03's "선택된 Agent, Knowledge, MCP Tool, Prompt" — built on
 * top of `AssetDependencyView.forward` (`asset-management.ts`, already D08's
 * source of truth for the same relationship) rather than re-deriving it. */
export interface ServiceDetailBinding {
  label: string;
  refType: BindingKind;
  assetId: string;
  version: string;
  installed: boolean;
  /** Only present for `refType === "knowledge_bindings"`. */
  indexInfo?: ServiceDetailKnowledgeIndexInfo;
  /** Only present for `refType === "mcp_bindings"` — the literal declared
   * `confirmation_policy` value from service-definition.json's mcp_bindings
   * entry, or `null` if the Service didn't declare one (schema default is
   * "always", but this shows the literal value rather than assuming it). */
  confirmationPolicy?: string | null;
}

export interface ServiceDetailView {
  assetId: string;
  assetType: string;
  name: string;
  version: string;
  status: AssetStatus;
  checksumVerification: ChecksumVerification | null;
  purpose: ServiceDetailPurpose;
  usageExamples: ServiceDetailUsageExamples;
  /** Always unavailable today — see `ServiceDetailGap` and the module
   * docstring in `electron/service-detail.ts` for why (no schema field). */
  inputFields: ServiceDetailGap;
  bindings: ServiceDetailBinding[];
  /** Non-null explanation when `bindings` is empty for a non-Service asset
   * (mirrors `AssetDependencyView.forwardNote`). */
  bindingsNote: string | null;
  /** `null` when the asset has no manifest to read a model policy from
   * (non-Service asset, or Manifest missing/unreadable). */
  modelPolicy: ServiceDetailModelPolicy | null;
  resolvedModelNote: string;
  runtimeRequirements: ServiceDetailGap;
  /** Always-true PoC-wide statement (CLAUDE.md 구현 원칙 8) plus how to read
   * each binding's `confirmationPolicy` above. */
  toolRiskNote: string;
  approvalStatus: ServiceDetailGap;
  /** This asset's own `sizeBytes` plus every `bindings` entry that is
   * actually installed locally (`installed === true`) — not a claim about
   * dependencies that are not installed. */
  installSizeBytes: number;
  installSizeNote: string;
}

export interface ServiceDetailResult {
  available: boolean;
  reason: string | null;
  detail: ServiceDetailView | null;
}

// ---------------------------------------------------------------------------
// D13 정보/보안
// ---------------------------------------------------------------------------

export interface OpenSourceNoticeEntry {
  name: string;
  declaredRange: string;
  resolvedVersion: string | null;
  license: string | null;
}

export interface OpenSourceNotices {
  entries: OpenSourceNoticeEntry[];
  /** Always `true` today — this lists Desktop's own direct runtime
   * dependencies with resolved version/license only, not a full
   * transitive-closure OSS notice with license texts (open-decisions.md
   * D-076). */
  incomplete: boolean;
  incompleteReason: string;
}

/** D13's "Trust Store 상태" — always `NOT_IMPLEMENTED`: this PoC has no PKI
 * (open-decisions.md D-016/D-048), so there is no Trust Store to report a
 * status for. Never rendered as a green "신뢰됨" badge that would mean
 * nothing. */
export interface TrustStoreInfo {
  status: "NOT_IMPLEMENTED";
  message: string;
}

export interface RevocationListInfo {
  knownEntryCount: number;
  /** Local filesystem mtime of `state/revocation-list.json` — i.e. the last
   * time THIS Desktop merged a Bundle's Revocation List into its local
   * state. NOT an authoritative "list published at" timestamp (no such field
   * exists on a Revocation entry — open-decisions.md D-076). `null` if no
   * Bundle has ever carried Revocation entries. */
  lastLocalUpdateAt: string | null;
  note: string;
}

export interface SchemaVersionInfo {
  supportedVersion: string;
  source: string;
}

export interface DataLocationsInfo {
  installRoot: string;
  assetsDir: string;
  stateDir: string;
  logsDir: string;
  quarantineDir: string;
  profilesDir: string;
  diagnosticsDir: string;
}

export interface SystemInfoView {
  clientVersion: string;
  runtimeVersion: string | null;
  runtimeVersionNote: string | null;
  schemaVersion: SchemaVersionInfo;
  os: { platform: string; release: string; arch: string };
  trustStore: TrustStoreInfo;
  revocationList: RevocationListInfo;
  openSourceNotices: OpenSourceNotices;
  dataLocations: DataLocationsInfo;
}

// ---------------------------------------------------------------------------
// 자산 스토어 — Portal 카탈로그 브라우징 + 설치 (VS Code Extension 스타일)
// ---------------------------------------------------------------------------

/** Main process에만 존재하는 실제 Token 값은 절대 여기 포함하지 않는다 —
 * `electron/portal-settings.ts`의 `getToken()`은 IPC/preload로 노출되지
 * 않고, 렌더러는 이 "설정됨 여부 + 마지막 갱신 시각"만 받는다. D11 진단
 * Bundle에도 이 shape만 들어간다(실제 Token 문자열은 어디에도 직렬화되지
 * 않음 — `electron/__tests__/diagnostic-bundle.test.ts`의 신규 테스트 참고). */
export interface PortalSettingsPublic {
  baseUrl: string | null;
  tokenConfigured: boolean;
  tokenUpdatedAt: string | null;
}

/** D-072: `GET /api/v1/assets`의 `AssetVersionOut.active_revocation` 요약 —
 * 이 버전에 지금 효력이 있는(effective_at <= now) 긴급 회수(Revocation)가
 * 있을 때만 채워진다(미래 시각 회수는 null로 남는다 — 아직 설치를 막지
 * 않으므로 미리 보여주지 않는다, portal-api
 * `_attach_active_revocations`/`effective_filter`와 동일한 판단).
 * `reason`은 호출자 역할에 따라 서버가 이미 마스킹했을 수 있다(P16
 * 수명주기 화면과 동일하게 `LIFECYCLE_READ` 권한 보유자에게만 노출) —
 * Desktop은 이 값을 그대로 신뢰해 표시하면 되고, null이어도 회수 자체는
 * 이 필드가 존재하는 것으로 이미 알 수 있다. */
export interface PortalCatalogActiveRevocation {
  effectiveAt: string;
  reason: string | null;
}

/** `GET /api/v1/assets`의 한 Version — portal-api의 `AssetVersionOut`에서
 * 이 화면이 실제로 쓰는 필드만 추린 것(전체 manifest는 카탈로그 목록에
 * 필요하지 않다). */
export interface PortalCatalogVersion {
  id: string;
  version: string;
  /** `security_policy.transitions.VersionStatus` 중 하나(문자열 그대로) —
   * DRAFT/VALIDATING/READY_FOR_REVIEW/IN_REVIEW/CHANGES_REQUESTED/REJECTED/
   * APPROVED/SUSPENDED/DEPRECATED/RETIRED. 이 값이 APPROVED라도
   * `activeRevocation`이 채워져 있으면 실제로는 설치할 수 없다(D-072) —
   * 두 필드를 함께 봐야 한다. */
  status: string;
  activeRevocation: PortalCatalogActiveRevocation | null;
}

export interface PortalCatalogAsset {
  id: string;
  type: string;
  name: string;
  classification: string;
  versions: PortalCatalogVersion[];
}

export interface PortalCatalogResult {
  ok: boolean;
  assets: PortalCatalogAsset[];
  /** `ok === false`이거나 Portal 설정이 없을 때의 한국어 안내 — Portal
   * 도달 불가는 폐쇄망에서 정상적인 경우이므로 항상 수동 가져오기 대안을
   * 함께 안내한다(화면에서 조합). */
  error: string | null;
}

/** 서버측(Portal/Distribution) 단계 3개 + 기존 `importBundle()`의
 * `ImportStage` 전체 — 두 단계를 하나의 진행률 목록으로 이어 보여준다. */
export type StoreInstallServerStage = "REQUEST" | "SERVER_BUILD" | "DOWNLOAD";
export type StoreInstallStage = StoreInstallServerStage | ImportStage;

export const STORE_SERVER_STAGE_LABELS: Record<StoreInstallServerStage, string> = {
  REQUEST: "Bundle 생성 요청",
  SERVER_BUILD: "서버에서 Bundle 생성 중",
  DOWNLOAD: "Bundle 다운로드",
};

export interface StoreInstallProgressEvent {
  stage: StoreInstallStage;
  status: CheckStatus;
  message: string;
}

export interface StoreInstallResult {
  outcome: "SUCCESS" | "FAILED";
  failedStage: StoreInstallStage | null;
  message: string;
  /** 사용자가 명시적으로 취소한 경우에만 true — 화면이 오류(빨강)가 아니라
   * 중립적인 "취소됨" 상태로 보여줄 수 있도록 구분한다. */
  cancelled: boolean;
  /** `importBundle()`이 실제로 호출된 경우에만 채워진다(서버 단계에서
   * 실패/취소되면 null) — D04 결과 카드를 그대로 재사용할 수 있게 한다. */
  importResult: ImportResult | null;
  retryable: boolean;
}

// --- D06 대화 보존 (Desktop 대화 고도화/멀티턴) ------------------------------
// `electron/conversation-store.ts`의 renderer 쪽 거울(mirror) 타입 — 그
// 파일의 모듈 docstring 참고: 질문/답변 원문은 민감 데이터로 취급하고,
// 진단 Bundle에는 절대 포함하지 않는다.
export type ConversationTurnStatus = "succeeded" | "insufficient_evidence" | "failed" | "cancelled";

// 실사용 제보(2026-08-19) — "채팅에서 툴 수행시 기록이 안 남는다" 대응.
// 이 턴이 실제로 호출한 Tool(들)의 사실 기록 — 이름/인자/결과 요약(또는
// 실패 사유)/경로. 3가지 route:
//  - "user_selected": 사용자가 로컬 Tool 화면에서 직접 Tool과 인자를 골라
//    실행(`LocalToolInvokePanel.tsx`의 수동 경로).
//  - "ai_auto_selected": AI가 이번 질문만 보고 Tool과(또는) 인자를 스스로
//    골랐다 — D-083 TOOL_ROUTE(ran)이거나 D-084 후속 2 로컬 Tool 자동
//    라우팅.
//  - "mcp_tool": 사용자가 명시적으로 지정한 설치된 MCP Tool 호출(개발 확인용
//    Tool 트리거).
// `args`는 Tool의 짧은 구조적 입력 파라미터이지 문서/Prompt 원문이 아니므로
// 그대로 저장한다(`conversation-store.ts` 모듈 docstring의 "원문 저장 금지"
// 원칙은 질문/답변 자유 텍스트 대상이다) — `resultSummary`/`failureReason`만
// 길이 상한을 둔다(`conversation-store.ts`의 `truncateToolResultText` 참고).
export type ToolExecutionRoute = "user_selected" | "ai_auto_selected" | "mcp_tool";

export interface ToolExecutionRecord {
  toolName: string;
  args: Record<string, unknown> | null;
  /** 성공/실행됨일 때만 채워지는 짧은 요약 — 실패 시 `null`. */
  resultSummary: string | null;
  /** 실패/거절/오류일 때만 채워지는 사유 — 성공 시 `null`. */
  failureReason: string | null;
  route: ToolExecutionRoute;
}

export interface ConversationTurnRecord {
  id: string;
  question: string;
  answer: string;
  status: ConversationTurnStatus;
  citationCount: number;
  /** 이 턴이 실제로 수행한 Tool 호출들 — 없으면 빈 배열(이 필드가 없는
   * 과거 대화 파일도 `conversation-store.ts`가 읽을 때 빈 배열로
   * 정규화한다, `local-tool-store.ts`의 `approval` 레거시 정규화와 동일한
   * 스타일). */
  toolExecutions: ToolExecutionRecord[];
  createdAt: string;
}

export interface ConversationRecord {
  id: string;
  knowledgeId: string;
  knowledgeLabel: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurnRecord[];
}

export interface ConversationSummary {
  id: string;
  knowledgeId: string;
  knowledgeLabel: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}

// ---------------------------------------------------------------------------
// D06 대화 -> Agent 초안 (`electron/agent-draft.ts`의 순수 로직을 IPC로
// 감싼 입출력 형태) — 현재 세션의 라이브 메시지를 재료로 Agent+Prompt
// Manifest 초안을 로컬 디렉터리로 내보낸다. Portal로는 아무것도 전송하지
// 않는다.
// ---------------------------------------------------------------------------

/** 시스템 프롬프트 초안 생성 입력 — 라이브 턴의 질문 텍스트만 담는다(답변
 * 본문/Citation 발췌는 절대 포함하지 않는다, `agent-draft.ts`의
 * `buildSystemPromptDraftRequest` 참고). */
export interface AgentDraftGenerateSystemPromptInput {
  liveQuestions: string[];
}

export interface AgentDraftExportInput {
  /** `agentDraft:pickExportDirectory`가 돌려준 절대 경로 그대로 — 파일명은
   * 항상 Main Process가 고정한다(사용자가 입력한 파일명으로 경로를 만들지
   * 않는다, 루트 CLAUDE.md 코드 규칙). */
  directory: string;
  /** 렌더러가 `agent-draft.ts`의 빌더로 이미 만든 최종 Manifest 객체 —
   * Main Process는 이 값을 그대로 JSON.stringify해서 쓴다(재검증/재계산
   * 없음). */
  agentManifest: unknown;
  promptManifest: unknown;
  templateContent: string;
}

export interface AgentDraftExportResult {
  ok: boolean;
  /** Non-null only when `ok === false`(디스크 쓰기 실패 등) — 재시도
   * 가능하도록 원인을 그대로 보여준다. */
  error: string | null;
  /** `ok === true`일 때만 채워진다 — 실제로 파일이 저장된 디렉터리. */
  savedPath: string | null;
}

// --- Desktop Client PR2: 대화 -> Agent 초안을 Portal에 DRAFT로 등록 --------
// Portal이 설정된 배포에서만(Portal 미설정 = 폐쇄형 신호) 노출되는 추가
// 경로 — 파일 내보내기(위)는 이 기능과 무관하게 항상 동작한다. Agent와
// Prompt는 별개 자산이라 `POST /api/v1/assets`를 두 번 호출하며, 하나가
// 실패해도 다른 하나의 시도를 막지 않고 결과를 뭉개지 않는다.

export interface AgentDraftUploadInput {
  agentManifest: unknown;
  promptManifest: unknown;
  templateContent: string;
}

/** 자산 하나(Agent 또는 Prompt)의 업로드 결과. */
export interface AgentDraftUploadAssetOutcome {
  ok: boolean;
  /** `ok === true`일 때만 채워진다 — Portal에 실제로 생성된 자산/버전
   * 식별자(부분 실패 시 사용자가 Portal에서 직접 정리할 수 있도록). */
  assetId: string | null;
  versionId: string | null;
  version: string | null;
  /** `ok === false`일 때만 채워진다 — portal-api Error Envelope의 `code`
   * 그대로(`VALIDATION_ERROR`/`ASSET_UPLOAD_*`/`PERMISSION_DENIED`/
   * `PORTAL_UNREACHABLE` 등, `portal-client.ts::createAsset` 참고). 뭉개지
   * 않고 그대로 보여준다. */
  errorCode: string | null;
  /** 항상 한국어 — 화면에 그대로 표시 가능. */
  errorMessage: string | null;
  /** `errorCode === "VALIDATION_ERROR"`일 때만 채워지는 필드별 오류 목록
   * (portal-api `details.errors` 그대로, 이미 한국어 문자열). */
  validationErrors: string[] | null;
}

export interface AgentDraftUploadResult {
  /** false면 Portal이 설정되지 않아 아예 시도하지 않았다는 뜻 — 화면은 이
   * 경로에 도달하기 전에 업로드 진입점 자체를 숨기지만(Portal 미설정 =
   * 폐쇄형 신호), Main Process는 방어적으로 다시 검사한다. */
  attempted: boolean;
  /** `attempted === false`일 때만 채워지는 한국어 안내. */
  notConfiguredReason: string | null;
  /** Agent/Prompt 각각 독립적으로 시도한 결과 — `attempted === false`일
   * 때만 둘 다 null이다. */
  agent: AgentDraftUploadAssetOutcome | null;
  prompt: AgentDraftUploadAssetOutcome | null;
}

// --- D14 "등록된 에이전트를 스케줄에 따라 수행" -----------------------------
//
// 스케줄 대상("실행 레시피")은 새 실행 경로를 발명하지 않는다 — D06
// `ChatScreen.tsx`의 `handleSend`가 non-ollama-only 턴에서 조립하는 것과
// 정확히 같은 조합(질문 텍스트 + Knowledge 토글 + 로컬 Tool 자동 선택 토글 +
// Local Agent 선택 + Chat Model)을 그대로 필드로 옮긴 것뿐이다. Main Process의
// 스케줄 실행기가 이 레시피로 재구성하는 호출도 `src/agentRuntime.ts`의
// `StartRunParams`가 요구하는 것과 같은 필드만 채운다(Main에서는 그 모듈을
// 직접 쓰지 못하므로 — EventSource가 브라우저 전용이라 — 같은 HTTP 계약을
// 향해 별도 Main 전용 클라이언트가 존재한다, `electron/schedule-agent-runtime.ts`).
//
// `localToolRouteActive`가 켜진 레시피는 D-084 후속 2(`electron/local-tool-router.ts`)와
// 동일하게 agent-runtime을 아예 거치지 않고 로컬 Ollama에 직접 묻는다 — 이
// 필드가 "Tool 위험 확인" 게이트(F, 아래 `ScheduleSaveResult` 참고)가 검사하는
// 유일한 신호다.
export interface ScheduleRecipe {
  question: string;
  knowledgeLookupActive: boolean;
  /** `knowledgeLookupActive === true`일 때만 의미가 있다 — 검색에 쓸
   * AssetVersion id 목록(`ChatScreen.tsx`의 `knowledgeIds`와 같은 값 종류). */
  knowledgeIds: string[];
  /** D-084 후속 2 — 로컬 Ollama가 로컬 Tool 후보 중 하나를 직접 고르고
   * 실행한다(agent-runtime을 거치지 않는다). 이 값이 true인 레시피만 F의
   * Tool 위험 확인 게이트 대상이다. */
  localToolRouteActive: boolean;
  /** D-034 해석 경로 4 — 채워지면 표준 Agent 대신 이 Local Agent로 실행한다. */
  localAgentId: string | null;
  /** Ollama 대화(Knowledge/Local Agent 둘 다 꺼진 경우)와 로컬 Tool 자동
   * 라우팅 둘 다에서 사용하는 Chat Model alias. */
  chatModelAlias: string;
}

export type ScheduleRunOutcome = "success" | "failure" | "missed" | "cancelled";

/** D14 후속("지금 실행" 트리거, 실사용 제보 3) — 이력 한 건이 정기 Tick으로
 * 실행됐는지, 사용자가 "지금 실행" 버튼으로 수동 트리거했는지. 섞어 보이면
 * "왜 이 시각에 돌았지"를 설명할 수 없다(Task Brief). `"scheduled"`가 이
 * 필드 도입 이전 모든 기록의 정규화 기본값이다 — 그 시점에는 수동 실행
 * 경로 자체가 없었으므로 전부 정기 실행이었다는 사실과 일치한다. */
export type ScheduleTrigger = "scheduled" | "manual";

export interface ScheduleRecord {
  id: string;
  name: string;
  expression: ScheduleExpression;
  recipe: ScheduleRecipe;
  active: boolean;
  /** `recipe.localToolRouteActive`가 true인 레시피에서만 채워진다(F) — 그
   * 외에는 항상 `null`(확인이 필요한 적이 없었으므로 확인한 적도 없다). */
  toolRiskAcknowledgedAt: string | null;
  /** 실사용 제보(2026-08-19) — 이 스케줄 실행 1회의 전체 상한(분 단위).
   * agent-runtime Run의 폴링 상한(`maxPollMs`)과, `localToolRouteActive`인
   * 레시피의 로컬 Tool 1회 호출 상한(`timeoutMs`) 양쪽에 그대로 쓰인다 —
   * 스케줄 전체가 이 시간 안에 끝나야 한다는 하나의 사용자 기대를 두
   * 하위 상한으로 나눠 강제하지 않는다(`schedule-store.ts`의
   * `DEFAULT_SCHEDULE_TIMEOUT_MINUTES` 등 참고 — 기본 30분, 상/하한 있음).
   * 대화형(채팅) 로컬 Tool 실행의 기본 30초 타임아웃과는 완전히 무관하다 —
   * 그쪽은 절대 이 값의 영향을 받지 않는다. */
  timeoutMinutes: number;
  createdAt: string;
  updatedAt: string;
  /** 항상 "지금부터의 다음 실행"을 가리킨다 — 저장/실행/앱 시작 시 놓친
   * 실행 감지 직후 매번 새로 계산된다(드리프트 누적 없음). */
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunOutcome: ScheduleRunOutcome | null;
}

export interface ScheduleSaveInput {
  /** 있으면 수정, 없으면 새로 생성. */
  id?: string;
  name: string;
  expression: ScheduleExpression;
  recipe: ScheduleRecipe;
  active: boolean;
  /** 생략하면 기본값(30분)이 적용된다 — `ScheduleStore.saveWithToolRiskAck`가
   * 상/하한을 검증한다. */
  timeoutMinutes?: number;
}

export type ScheduleSaveResult =
  | { ok: true; schedule: ScheduleRecord; error: null; requiresToolRiskAck: false }
  | { ok: false; schedule: null; error: string; requiresToolRiskAck: boolean };

export interface ScheduleLocalToolInvocationRecord {
  toolName: string;
  args: Record<string, unknown>;
}

/** 실행 1건의 이력(E) — 성공/실패/누락(missed) 모두 이 형태로 남는다. 질문/
 * 답변 원문은 절대 저장하지 않는다(`resultSummary`/`failureReason`은 사람이
 * 읽을 짧은 요약이지 원문이 아니다) — `electron/diagnostic-bundle.ts`가
 * 이 저장소를 import조차 하지 않는다는 사실과 함께
 * `electron/__tests__/schedule-diagnostic-leak.test.ts`가 이를 고정한다. */
export interface ScheduleHistoryRecord {
  id: string;
  scheduleId: string;
  timestamp: string;
  outcome: ScheduleRunOutcome;
  /** 정기 Tick(`"scheduled"`) vs 사용자가 누른 "지금 실행"(`"manual"`). */
  trigger: ScheduleTrigger;
  /** 이번 실행이 실제로 로컬 Tool을 호출했을 때만 채워진다(`localToolRouteActive`가
   * 꺼져 있었거나, 켜져 있었지만 이번 질문에는 아무 Tool도 고르지 않았으면
   * 빈 배열). */
  localToolInvocations: ScheduleLocalToolInvocationRecord[];
  /** 성공 시에만 채워지는 짧은 요약(길면 잘라낸다) — 답변 원문 저장 금지
   * 원칙에 따라 전체 답변이 아니다. */
  resultSummary: string | null;
  /** 실패/누락 시에만 채워지는 사유. */
  failureReason: string | null;
}

/** Renderer-facing surface exposed via `contextBridge` in `preload.ts`. */
export interface DesktopBridge {
  pickBundleFile(): Promise<string | null>;
  importBundle(filePath: string): Promise<ImportResult>;
  onImportProgress(cb: (event: ImportProgressEvent) => void): () => void;
  listInstalledAssets(): Promise<InstalledAssetWithStatus[]>;
  /** CLAUDE.md: 제거는 확인과 사유를 요구한다(D12 작업에서 D08/D02 양쪽에
   * 소급 적용) — `reason`은 비어 있으면 안 되며, 렌더러가 이미 필수 입력으로
   * 강제하지만 서버 측에서도 다시 검증한다(방어적 이중 검사, `bundle-install.ts`의
   * 경로 안전성 재검사와 같은 원칙). */
  removeInstalledAsset(assetType: string, assetId: string, version: string, reason: string): Promise<RemoveAssetResult>;
  checkConnections(): Promise<ConnectionStatus[]>;
  getInstallRootPath(): Promise<string>;

  // --- D08 로컬 자산 관리 ---------------------------------------------------
  /** Proactive check the D08 UI runs before even opening the removal confirm
   * dialog — the same rule `removeInstalledAsset` itself enforces
   * server-side (defense in depth, same pattern as `bundle-install.ts`'s
   * path-safety re-check at the point of extraction). */
  checkAssetRemoval(assetType: string, assetId: string, version: string): Promise<AssetRemovalCheck>;
  getAssetManifest(assetType: string, assetId: string, version: string): Promise<AssetManifestResult>;
  reverifyAssetChecksum(
    assetType: string,
    assetId: string,
    version: string,
  ): Promise<{ available: boolean; reason: string | null; result: ChecksumVerification | null }>;
  getAssetDependencies(assetType: string, assetId: string, version: string): Promise<AssetDependencyView>;

  // --- D06 대화: KNOWLEDGE_ROUTE 후보 조립(agentic Knowledge 선택) -------------
  /** `assets`는 이미 렌더러가 "검색에 실제로 활성화된 것"으로 판정한 목록
   * 그대로다(`chatTypes.ts`의 `partitionInstalledKnowledgeByActivation` —
   * 이 호출은 그 판정을 재현하지 않고 재사용만 한다). 각 자산의
   * `manifest.json`(fs 읽기, Main에서만 가능)을 읽어 agent-runtime의
   * `knowledge_candidates` 입력 형태로 조립해 돌려준다. `assetVersionId`가
   * 없는 자산(D-060 레거시 Bundle)은 애초에 `usable` 목록에 없어야 하지만,
   * 방어적으로 결과에서 제외된다(발명하지 않는다) — 조립 규칙 자체는
   * `electron/knowledge-candidates.ts`의 순수 함수를 그대로 쓴다. */
  getKnowledgeCandidates(assets: InstalledAsset[]): Promise<KnowledgeCandidate[]>;

  // --- D10 설정: Knowledge별 실제 임베딩 모델 ----------------------------------
  /** 설치된 모든 Knowledge(활성화 여부와 무관)를 대상으로, 각자의
   * `index/index-meta.json`에 기록된(또는 기록되지 않은) 임베딩 모델을
   * 읽기 전용으로 보여준다. 설치된 Knowledge가 없으면 빈 배열(오류 아님).
   * 옛 `embeddingModelAlias` 자유 입력 필드를 대체한다 — 위 `KnowledgeEmbedModelInfo`
   * 문서 참고. */
  getKnowledgeEmbedModels(): Promise<KnowledgeEmbedModelInfo[]>;

  // --- D-079 Knowledge 활성화 --------------------------------------------------
  /** "설치됨"과 "활성화됨"은 서로 다른 사실이다 — 이 호출은 설치된 Knowledge의
   * index 경로를 search-runtime에 등록해 실제로 검색 가능하게 만든다.
   * Knowledge가 아닌 자산 유형이거나 레코드를 찾을 수 없으면 `activation: null`
   * + `error`만 채워 반환한다(시도 자체가 없었으므로 저장할 결과가 없다). */
  activateInstalledKnowledge(assetType: string, assetId: string, version: string): Promise<ActivateKnowledgeResult>;
  /** search-runtime 등록을 해제한다. search-runtime이 응답하지 않아도 로컬
   * 활성화 상태는 항상 정리된다(정직하게 `remoteWarning`으로 알린다) —
   * Runtime 장애 때문에 제거/재설치가 막히지 않도록. */
  deactivateInstalledKnowledge(assetType: string, assetId: string, version: string): Promise<DeactivateKnowledgeResult>;
  /** 로컬에 ACTIVE로 저장된 Knowledge가 search-runtime에 실제로도 등록되어
   * 있는지 재확인하고, 어긋나면(재시작/레지스트리 초기화 등) 로컬 상태를
   * FAILED로 낮춘다 — search-runtime에 도달할 수 없으면 아무것도 바꾸지
   * 않는다(`checked: false`). `listInstalledAssets()` 호출 전에 불러 최신
   * 상태를 보여주는 용도로 쓴다. */
  reconcileKnowledgeActivations(): Promise<ReconcileKnowledgeActivationsResult>;

  // --- D-080 MCP Tool 연결 ------------------------------------------------------
  /** "설치됨"과 "연결됨"은 서로 다른 사실이다 — 이 호출은 설치된 MCP Tool의
   * manifest.json(server_alias/tool_name/risk_level/input_schema/확인 정책)을
   * 읽어 agent-runtime에 그 계약을 등록한다. **연결은 호출 권한을 부여하지
   * 않는다** — 실제로 호출 가능한지는 Office Profile의 `allowed_tools`가
   * 이미 정한 대로다(Task Brief §5). MCP Tool이 아닌 자산 유형이거나
   * 레코드를 찾을 수 없으면 `activation: null` + `error`만 채워 반환한다. */
  connectInstalledMcpTool(assetType: string, assetId: string, version: string): Promise<ConnectMcpToolResult>;
  /** agent-runtime 등록을 해제한다. agent-runtime이 응답하지 않거나
   * manifest를 다시 읽을 수 없어도 로컬 연결 상태는 항상 정리된다(정직하게
   * `remoteWarning`으로 알린다) — Runtime 장애 때문에 제거/재설치가 막히지
   * 않도록(D-079 `deactivateInstalledKnowledge`와 동일한 원칙). */
  disconnectInstalledMcpTool(assetType: string, assetId: string, version: string): Promise<DisconnectMcpToolResult>;
  /** 로컬 ACTIVE와 agent-runtime의 현재 등록 목록을 비교한다. Runtime에
   * 도달하지 못하면 상태를 추측해 낮추지 않고 `checked: false`를 반환한다. */
  reconcileMcpToolConnections(): Promise<ReconcileMcpToolConnectionsResult>;

  // --- D-034 해석 경로 4: Local Agent 등록 ---------------------------------------
  /** "설치됨"과 "실행에 쓸 수 있음"은 서로 다른 사실이다 — 설치된 Agent와
   * 사용자가 고른 Prompt의 짝을 agent-runtime에 등록해 이후 대화에서
   * `input.local_agent_id`로 이 Agent를 실행할 수 있게 한다. 짝은 절대
   * 이 호출 안에서 추측하지 않는다 — `promptAssetId`/`promptVersion`은
   * 항상 호출자(렌더러)가 명시적으로 고른 값이다(Task Brief 제약 C).
   * Agent/Prompt 대상을 찾을 수 없으면 `registration: null` + `error`만
   * 채워 반환한다. */
  registerLocalAgent(
    agentAssetId: string,
    agentVersion: string,
    promptAssetId: string,
    promptVersion: string,
    label?: string | null,
  ): Promise<RegisterLocalAgentResult>;
  /** agent-runtime 등록을 해제한다. agent-runtime이 응답하지 않아도 로컬
   * 등록 상태는 항상 정리된다(정직하게 `remoteWarning`으로 알린다) —
   * Runtime 장애 때문에 제거/재등록이 막히지 않도록(D-079/D-080과 동일한
   * 원칙). */
  unregisterLocalAgent(agentAssetId: string, agentVersion: string): Promise<UnregisterLocalAgentResult>;
  /** 로컬 ACTIVE와 agent-runtime의 현재 등록 목록을 비교한다. Runtime에
   * 도달하지 못하면 상태를 추측해 낮추지 않고 `checked: false`를 반환한다.
   * `localAgentsEnabled`는 이 배포가 allow-root를 아예 설정하지 않았는지
   * 매번 다시 알려준다(Task Brief 제약 B). */
  reconcileLocalAgentRegistrations(): Promise<ReconcileLocalAgentRegistrationsResult>;

  // --- D12 업데이트/복구 -------------------------------------------------------
  /** 두 설치된 버전의 Manifest를 비교한다(Manifest/Dependency/Permission 3축). */
  diffAssetVersions(
    assetType: string,
    assetId: string,
    fromVersion: string,
    toVersion: string,
  ): Promise<AssetVersionDiffResponse>;
  /** "Active Pointer 전환"과 "이전 버전 Rollback"은 동일한 호출이다 — Rollback은
   * 그냥 더 오래된 버전으로 이 메서드를 다시 호출하는 것뿐이다. 대상 버전이
   * REVOKED/INVALID이거나 이미 Active이면 `ok=false`+사유를 반환한다(추측
   * 활성화 금지). CLAUDE.md: 전환/Rollback도 확인과 사유를 요구한다 — `reason`은
   * 비어 있으면 안 되며 서버 측에서도 다시 검증한다. */
  activateAssetVersion(assetType: string, assetId: string, version: string, reason: string): Promise<ActivateVersionResult>;
  /** D12 "실패 설치 정리" — Store에 기록되지 않은(=완결되지 못한) 설치 디렉터리를
   * 제거한다. 멱등(정리할 것이 없으면 빈 배열을 반환하며 안전하게 재호출 가능). */
  cleanupOrphanedInstalls(): Promise<OrphanedInstallCleanupResult>;

  // --- D11 로그/진단 ---------------------------------------------------------
  listLogs(filters: LogFilters): Promise<LogEntry[]>;
  /** Builds the allowlisted diagnostic Bundle and writes it to disk (JSON)
   * for the user to share — `savedPath` is where it landed. */
  generateDiagnosticBundle(filters: LogFilters): Promise<{ bundle: DiagnosticBundle; savedPath: string }>;

  // --- 자산 스토어(Portal 카탈로그 설치) --------------------------------------
  getPortalSettings(): Promise<PortalSettingsPublic>;
  setPortalBaseUrl(baseUrl: string): Promise<PortalSettingsPublic>;
  /** 저장 이후 렌더러에는 절대 값이 돌아오지 않는다 — 반환값도 `getPortalSettings()`와
   * 동일한 "설정됨 여부"뿐이다. */
  setPortalToken(token: string): Promise<PortalSettingsPublic>;
  clearPortalToken(): Promise<PortalSettingsPublic>;
  fetchPortalCatalog(): Promise<PortalCatalogResult>;
  installFromStore(assetType: string, assetId: string, assetVersionId: string): Promise<StoreInstallResult>;
  onStoreInstallProgress(cb: (event: StoreInstallProgressEvent) => void): () => void;
  /** 진행 중인 단 하나의 설치(REQUEST/SERVER_BUILD/DOWNLOAD 단계 한정, 로컬
   * 검증·설치 단계 진입 후에는 효과 없음)를 취소 요청한다 — Distribution
   * Job 자체를 서버에서 중단시키는 API는 없으므로(문서화된 계약 없음), 이
   * Desktop이 더 이상 폴링/다운로드를 진행하지 않도록만 한다. */
  cancelStoreInstall(): Promise<void>;

  // --- D01 최초 설정 Wizard / D10 설정 ----------------------------------------
  getDesktopSettings(): Promise<DesktopSettingsPublic>;
  /** All-or-nothing: 포함된 필드 중 하나라도 검증 실패면 아무것도 저장하지
   * 않고 `ok:false`+사유를 반환한다(Ollama URL의 loopback 규칙 등은 Main
   * Process에서 다시 검증된다 — 방어적 이중 검사). */
  updateDesktopSettings(patch: DesktopSettingsInput): Promise<DesktopSettingsUpdateResult>;
  /** D01 7단계 "전체 진단 결과와 저장" 완료 시점에 한 번 호출한다. */
  markSetupCompleted(): Promise<DesktopSettingsPublic>;
  /** D01 1단계 "설치 경로와 여유 공간". */
  getDiskSpace(): Promise<DiskSpaceInfo>;
  /** D01 4단계 "설치된 Chat/Embedding 모델 확인" — 지금 저장된(또는 아직
   * 저장 전인) Ollama Base URL을 인자로 받아, 마법사가 저장 전에도 방금 입력한
   * 값으로 확인할 수 있게 한다. */
  listOllamaModels(ollamaBaseUrl: string): Promise<OllamaModelsResult>;
  /** Knowledge 자산이 없을 때 설정된 Ollama 채팅 모델로 일반 대화한다. */
  chatWithOllama(input: OllamaChatInput): Promise<OllamaChatResult>;
  /** 진행 중인 Ollama 일반 대화를 취소한다. */
  cancelOllamaChat(): Promise<void>;

  // --- D03 Service/Agent 상세 -------------------------------------------------
  getServiceDetail(assetType: string, assetId: string, version: string): Promise<ServiceDetailResult>;

  // --- D13 정보/보안 -----------------------------------------------------------
  getSystemInfo(): Promise<SystemInfoView>;

  // --- D06 대화 보존 (Desktop 대화 고도화/멀티턴) ------------------------------
  listConversations(): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<ConversationRecord | null>;
  /** 첫 턴이 완료된 시점에만 호출된다(빈 대화를 목록에 남기지 않기 위해) —
   * `knowledgeLabel`은 화면에 이미 표시 중인 이름을 그대로 넘긴다(별도
   * 조회 없이). */
  createConversation(knowledgeId: string, knowledgeLabel: string): Promise<ConversationRecord>;
  appendConversationTurn(
    conversationId: string,
    turn: {
      question: string;
      answer: string;
      status: ConversationTurnStatus;
      citationCount: number;
      /** 생략하면 빈 배열로 저장된다(Tool을 전혀 쓰지 않은 턴). */
      toolExecutions?: ToolExecutionRecord[];
    },
  ): Promise<ConversationRecord | null>;
  /** CLAUDE.md: 삭제는 확인과 사유를 요구한다 — `reason`이 비어 있으면
   * 저장하지 않고 실패를 반환한다(Main Process에서도 다시 검증, 방어적
   * 이중 검사). */
  deleteConversation(id: string, reason: string): Promise<{ ok: boolean; error: string | null }>;

  // --- D06 대화 -> Agent 초안 (`electron/agent-draft.ts`) ----------------------
  /** 라이브 턴의 질문 텍스트만으로 시스템 프롬프트 초안을 Ollama에게
   * 요청한다(`chatWithOllama`를 그대로 재사용, Main Process 경유). 실패 시
   * throw — 호출자는 빈 편집 상태로 떨어뜨리고 지어낸 기본값을 채우지
   * 않는다. */
  generateAgentDraftSystemPrompt(liveQuestions: string[]): Promise<OllamaChatResult>;
  /** 진행 중인 생성 요청을 취소한다(`chat:ollamaCancel`과 별개의 Abort
   * Controller — 서로 다른 취소 대상이다). */
  cancelAgentDraftSystemPromptGeneration(): Promise<void>;
  /** Agent 초안을 내보낼 로컬 디렉터리를 고르는 네이티브 대화상자.
   * 취소하면 `null`(오류가 아니다 — CLAUDE.md 취소 상태). */
  pickAgentDraftExportDirectory(): Promise<string | null>;
  /** 고른 디렉터리에 `agent-manifest.json`/`prompt-manifest.json`/
   * `template.md` 세 파일을 쓴다. */
  exportAgentDraft(input: AgentDraftExportInput): Promise<AgentDraftExportResult>;
  /** Portal이 설정된 배포에서만 화면이 노출하는 진입점 — DRAFT 두 건
   * (Agent+Prompt)을 Portal에 등록한다. 승인·게시 API는 절대 호출하지
   * 않는다. Portal 미설정 시 Main Process가 `attempted:false`로 방어적으로
   * 거부한다(화면은 이 상태에 도달하기 전에 진입점 자체를 숨겨야 한다). */
  uploadAgentDraft(input: AgentDraftUploadInput): Promise<AgentDraftUploadResult>;
  /** 진행 중인 업로드를 취소 요청한다(`agentDraft:upload`와 별개의 Abort
   * Controller). 이미 서버에 반영된 자산은 되돌리지 않는다 — 취소 후에도
   * `uploadAgentDraft`의 결과는 취소 시점까지 실제로 일어난 일(부분 성공
   * 포함)을 그대로 보여준다. */
  cancelAgentDraftUpload(): Promise<void>;

  // --- D-084 "Desktop 로컬 Tool" ------------------------------------------------
  // D-083 TOOL_ROUTE/D-080 등록과 구조적으로 분리되어 있다 — 이 여섯 메서드는
  // agent-runtime을 절대 호출하지 않는다(`electron/__tests__/local-tool-isolation.test.ts`).
  /** `.py` 파일만 허용하는 네이티브 파일 대화상자. 사용자가 취소하면 `null`
   * (오류가 아니다 — CLAUDE.md 취소 상태). */
  pickLocalToolFile(): Promise<string | null>;
  /** 이미 고른 파일을 main process가 직접 읽어(fs) 정적 분석한다 — 실행하지
   * 않는다. 파일을 옮기거나 지운 경우 등 읽기 자체가 실패하면
   * `reason: "file_unreadable"`을 돌려준다. `@tool`/`@mcp.tool`이 붙은
   * 함수가 하나 이상 있으면 그 함수들 전부를, 없고 최상위 함수가 하나뿐이면
   * 그 함수 하나를(기존 동작, 회귀 없음) 후보로 돌려준다 — 데코레이터 없이
   * 함수가 여럿이면 파일 전체가 `multiple_functions_found`로 거절된다. */
  inspectLocalToolFile(filePath: string): Promise<LocalToolFileAnalysisResult>;
  /** 렌더러가 왕복시킨 Schema를 신뢰하지 않고 파일을 서버 측에서 다시
   * 분석한 뒤 저장한다. `acknowledgedRisk: true`가 아니면 저장 자체를
   * 거부한다(Task Brief 요구사항 3 — "격리되지 않음" 고지에 대한 구조적
   * 강제, 체크박스만으로 우회할 수 없다). `functionName`을 생략하면 기존
   * 동작 그대로(파일 안에 함수가 하나뿐일 때만 성공) 그 함수를 등록한다.
   * `@tool` 등으로 여러 함수를 등록할 때는 `inspectLocalToolFile`이 돌려준
   * 후보 각각의 `functionName`으로 이 메서드를 함수마다 한 번씩 호출한다 —
   * 이름이 이미 등록된 다른 Tool(같은 파일의 앞선 호출 포함)과 겹치면
   * 저장을 거부하고 `error`에 사유를 담는다(조용히 넘어가지 않는다). */
  addLocalTool(
    filePath: string,
    acknowledgedRisk: boolean,
    functionName?: string,
  ): Promise<{ ok: boolean; tool: LocalTool | null; error: string | null }>;
  listLocalTools(): Promise<LocalTool[]>;
  removeLocalTool(id: string): Promise<{ ok: boolean; error: string | null }>;
  /** 매 호출은 렌더러의 명시적 확인 단계(파일 경로+인자 표시) 뒤에만
   * 호출된다 — 이 메서드 자체는 그 확인을 강제하지 않으므로(IPC 경계에서는
   * 강제할 수 없다) 호출부(LocalToolsScreen.tsx)가 그 규약을 지킨다.
   * `pythonInterpreterPath`가 비어 있으면 프로세스를 띄우지 않고
   * `interpreter_not_configured`를 반환한다.
   * `options.aiSelected`(D-084 후속, 채팅 자동 라우팅)가 `true`이면 네이티브
   * 승인 대화상자 문구가 "Tool 선택과 인자 모두 AI가 정했다"는 사실을 반드시
   * 밝힌다 — `aiSelected`가 승인 정책을 낮추지는 않는다(구현 원칙 7).
   * 다만 그 대화상자가 뜨는지 자체는 `approval`이 정한다(D-084 후속 3):
   * 미리 허용해 둔 Tool은 AI가 정한 인자여도 대화상자 없이 실행된다(D-089).
   * 생략하면(수동 경로) 기존 문구 그대로다.
   * `options.invocationId`(실사용 제보 2026-08-19, 취소 추가) — 렌더러가
   * `crypto.randomUUID()`로 미리 만들어 넘기면, Main Process가 이 실행의
   * spawn된 프로세스를 이 id로 추적해 `cancelLocalToolInvocation(invocationId)`로
   * 취소할 수 있게 한다. 생략하면(자동 라우팅 등 취소 UI가 없는 호출부) 취소
   * 불가능한 실행으로 취급된다 — 실행 자체는 그대로 진행된다. */
  invokeLocalTool(
    id: string,
    args: Record<string, unknown>,
    options?: { aiSelected?: boolean; invocationId?: string },
  ): Promise<LocalToolInvocationResult>;
  /** 실사용 제보(2026-08-19) — 대화형 로컬 Tool 실행 중 사용자가 중단한다.
   * `invocationId`가 `invokeLocalTool(..., { invocationId })`에 넘긴 값과
   * 일치하고 그 실행이 아직 진행 중일 때만 실제로 spawn된 프로세스를
   * SIGKILL로 종료한다(Main Process가 유일한 신뢰 경계 — 렌더러는 종료
   * 여부를 스스로 판단하지 않는다). 이미 끝났거나 알 수 없는 id면
   * `ok: false`를 돌려준다(조용히 성공한 척하지 않는다). 스케줄 실행 취소
   * (`cancelSchedule`)와는 완전히 별개의 경로다 — 서로 다른 실행을
   * 죽이거나 서로에게 영향을 주지 않는다. */
  cancelLocalToolInvocation(invocationId: string): Promise<{ ok: boolean; error: string | null }>;
  /** D-084 후속 3 ("최초 한번만 승인") — 자산 > 로컬 Tool 화면의 "실행 허용"
   * 액션 전용. Main Process가 승인 시점에 `filePath`를 다시 읽어 sha256을
   * 계산해 저장한다(렌더러가 계산한 해시를 신뢰하지 않는다) — 그 사이 파일이
   * 이동/삭제/읽기 불가면 승인 자체를 거부한다(fail-closed). 이 호출은
   * `localTool:invoke`의 매 호출 네이티브 승인 대화상자를 대신하지 않는다 —
   * 이후 호출에서 파일 해시가 이 시점 값과 일치할 때만 그 대화상자를
   * 건너뛴다. */
  approveLocalToolExecution(id: string): Promise<{ ok: boolean; tool: LocalTool | null; error: string | null }>;
  /** 위 승인을 철회한다 — 되돌릴 수 없는 승인을 만들지 않는다(Task Brief
   * 제약). 철회 후에는 다음 실행부터 다시 매번 네이티브 대화상자로 묻는다. */
  revokeLocalToolExecution(id: string): Promise<{ ok: boolean; tool: LocalTool | null; error: string | null }>;

  // --- D14 "등록된 에이전트를 스케줄에 따라 수행" -------------------------------
  listSchedules(): Promise<ScheduleRecord[]>;
  getSchedule(id: string): Promise<ScheduleRecord | null>;
  /** 구조적 위험 확인 게이트(F) — `recipe.localToolRouteActive`가 true이고
   * 재확인이 필요한 변경(끄기->켜기 전환, 질문 텍스트 변경, 또는 신규 생성)
   * 이면 `acknowledgedToolRisk !== true`일 때 저장 자체가 거부된다
   * (`ScheduleStore.saveWithToolRiskAck`가 실제로 강제한다 — 렌더러 확인
   * 화면은 이 게이트를 보조할 뿐, 유일한 강제 지점이 아니다). */
  saveSchedule(input: ScheduleSaveInput, ack: { acknowledgedToolRisk: boolean }): Promise<ScheduleSaveResult>;
  /** CLAUDE.md: 폐기는 확인과 사유를 요구한다 — `reason`이 비어 있으면
   * 저장하지 않고 실패를 반환한다(Main Process에서도 다시 검증). */
  removeSchedule(id: string, reason: string): Promise<{ ok: boolean; error: string | null }>;
  /** 활성/비활성 전환도 CLAUDE.md의 "중단은 확인과 사유를 요구한다"를 따른다 —
   * 비활성화는 예약된 실행을 중단시키는 조치이지 사소한 토글이 아니다. */
  setScheduleActive(id: string, active: boolean, reason: string): Promise<{ ok: boolean; error: string | null }>;
  /** `scheduleId`를 생략하면 전체 스케줄의 통합 이력(최신순)을 돌려준다. */
  listScheduleHistory(scheduleId?: string): Promise<ScheduleHistoryRecord[]>;
  /** 지금 실행 중인 스케줄(있다면)을 중단한다(Cancellation 상태) — Main
   * Process가 들고 있는 AbortController에 신호를 보낸다. 실행 중이 아니면
   * `ok:false`+사유. */
  cancelRunningSchedule(scheduleId: string): Promise<{ ok: boolean; error: string | null }>;
  /** 지금 실제로 실행 중인 스케줄의 id, 없으면 `null` — 화면은 이 값을 보고
   * "지금 실행 중단" 버튼을 어떤 스케줄에 붙일지 정한다(추측하지 않는다). */
  getRunningScheduleId(): Promise<string | null>;
  /** 실사용 제보 3 — 방금 만들거나 수정한 스케줄을 기다리지 않고 바로
   * 테스트한다. 정기 실행과 완전히 같은 실행기/이력 경로를 그대로 재사용하며
   * (`ScheduleScheduler.execute`), 이력에는 `trigger: "manual"`로 구분되어
   * 남는다. 이미 다른 스케줄이 실행 중이면 거부한다(`getRunningScheduleId()`가
   * `null`이 아닌 경우). Tool을 호출할 수 있는 스케줄인데
   * `toolRiskAcknowledgedAt`이 없으면(정식 저장 경로를 우회해 만들어졌거나
   * 예전 기록이거나) 승인 우회 없이 거부한다 — 정기 실행과 동일한 게이트. */
  runNowSchedule(id: string): Promise<{ ok: boolean; error: string | null }>;
}
