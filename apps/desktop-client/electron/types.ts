// Shared IPC/domain types between the Electron main process and the React
// renderer (M04). Interface-only — no runtime code — so the renderer bundle
// (Vite) can import this file with zero cost and no Electron dependency.

// `version-diff.ts` is itself interface-plus-pure-function-only (no fs/
// electron imports), so re-using its result type here (rather than
// hand-duplicating a parallel shape, as some other IPC-boundary types in this
// file do for historical reasons) cannot pull any runtime code into the
// renderer bundle — `import type` is erased entirely at compile time.
import type { VersionDiffResult } from "./version-diff";

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
   * (D-060). `null` when the installing Bundle predates this field or the
   * item is a STANDARD_LOCAL_COPY (agent/prompt) with no AssetVersion —
   * callers (e.g. ChatScreen's Knowledge selector) must treat `null` as
   * "cannot be used as a knowledge_id", never substitute assetId. */
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
}

export interface AssetManifestResult {
  available: boolean;
  /** Korean reason shown in place of the manifest when `available` is
   * false (e.g. a STANDARD_LOCAL_COPY item with no manifest.json on disk). */
  reason: string | null;
  manifest: unknown | null;
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

export type ConnectionId = "runtime" | "ollama" | "mcp";

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
  embeddingModelAlias: string;
  mcpServerAlias: string;
  mcpServerUrl: string;
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
  embeddingModelAlias?: string;
  mcpServerAlias?: string;
  mcpServerUrl?: string;
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

  // --- D03 Service/Agent 상세 -------------------------------------------------
  getServiceDetail(assetType: string, assetId: string, version: string): Promise<ServiceDetailResult>;

  // --- D13 정보/보안 -----------------------------------------------------------
  getSystemInfo(): Promise<SystemInfoView>;
}
