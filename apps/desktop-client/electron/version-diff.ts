// D12 업데이트/복구 — "현재와 새 버전 Diff". 순수 함수(fs/electron import
// 없음) — 호출자(`asset-management.ts`)가 두 버전의 Manifest JSON을 읽어
// 넘겨준다(`readAssetManifest`가 이미 하는 일 그대로 재사용, 새 파일 포맷
// 없음).
//
// `01-portal-and-distribution.md`(P09 검토 상세, §"이전 버전과
// Manifest/Dependency/Permission Diff")가 Portal의 버전 검토 화면에 쓰는 것과
// 같은 3축 아이디어를 이 화면에도 적용한다 — 다만 이 모듈은 그 코드를
// Import하지 않는다(CLAUDE.md 원칙 2: 모듈 간 내부 폴더 직접 Import 금지).
// 여기서는 로컬로 다시 구현하되 같은 3개 범주로 필드를 분류한다:
//  - dependency: 다른 Asset을 참조하는 필드(Service의 4개 바인딩 종류)
//  - permission: 권한/위험도를 나타내는 필드(MCP Tool의 risk_level, Agent의
//    capabilities, Service의 대상 사용자·제한)
//  - manifest: 그 외 일반 필드(name, description, tags, model_policy 등)

export type DiffAxis = "manifest" | "dependency" | "permission";
export type DiffChangeType = "added" | "removed" | "changed";

export interface DiffEntry {
  axis: DiffAxis;
  field: string;
  changeType: DiffChangeType;
  /** JSON-stringified (or raw string) values, truncated for display — never
   * the full document, just enough to show what changed. */
  oldValue: string | null;
  newValue: string | null;
}

export interface VersionDiffResult {
  hasChanges: boolean;
  entries: DiffEntry[];
}

const DEPENDENCY_FIELDS = new Set(["agent_ref", "knowledge_bindings", "mcp_bindings", "prompt_bindings"]);
const PERMISSION_FIELDS = new Set(["risk_level", "capabilities", "target_users", "limits", "execution_guards"]);

// Fields that change on every install/re-export regardless of any meaningful
// content change (build timestamp, recomputed hash) — surfacing these as
// "changes" would bury the fields a human actually needs to review.
const IGNORED_FIELDS = new Set(["created_at", "manifest_hash"]);

const MAX_VALUE_LENGTH = 300;

function axisFor(field: string): DiffAxis {
  if (DEPENDENCY_FIELDS.has(field)) return "dependency";
  if (PERMISSION_FIELDS.has(field)) return "permission";
  return "manifest";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringifyValue(v: unknown): string | null {
  if (v === undefined) return null;
  const str = typeof v === "string" ? v : JSON.stringify(v);
  return str.length > MAX_VALUE_LENGTH ? `${str.slice(0, MAX_VALUE_LENGTH)}…` : str;
}

/**
 * Compares two installed Manifest documents field-by-field. Neither input
 * needs to be schema-valid — an unreadable/missing manifest on either side
 * (e.g. a STANDARD_LOCAL_COPY asset, per `readAssetManifest`) is treated as
 * an empty object so every field on the other side shows as fully
 * added/removed rather than throwing.
 */
export function computeManifestDiff(oldManifest: unknown, newManifest: unknown): VersionDiffResult {
  const oldObj = isRecord(oldManifest) ? oldManifest : {};
  const newObj = isRecord(newManifest) ? newManifest : {};
  const keys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

  const entries: DiffEntry[] = [];
  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue;
    const oldStr = stringifyValue(oldObj[key]);
    const newStr = stringifyValue(newObj[key]);
    if (oldStr === newStr) continue;

    let changeType: DiffChangeType;
    if (oldStr === null) changeType = "added";
    else if (newStr === null) changeType = "removed";
    else changeType = "changed";

    entries.push({ axis: axisFor(key), field: key, changeType, oldValue: oldStr, newValue: newStr });
  }

  // Deterministic order: axis grouping first (dependency/permission surfaced
  // before general manifest noise, matching the P09 emphasis order), then
  // field name.
  const axisOrder: Record<DiffAxis, number> = { dependency: 0, permission: 1, manifest: 2 };
  entries.sort((a, b) => axisOrder[a.axis] - axisOrder[b.axis] || a.field.localeCompare(b.field));

  return { hasChanges: entries.length > 0, entries };
}

// Referenced by asset-management.ts so a manifest-read failure on either
// side of the diff can still name which file was expected, instead of a bare
// "diff unavailable" message.
export function manifestFileNameHint(assetType: string): string {
  return assetType === "service" ? "service-definition.json" : "manifest.json";
}
