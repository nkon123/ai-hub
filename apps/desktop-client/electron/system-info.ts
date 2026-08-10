// D13 정보/보안 (`02-desktop-and-agent-runtime.md` §D13) — assembles Client/
// Runtime/Schema 지원 버전, Trust Store 상태와 마지막 Revocation List 날짜,
// 라이선스와 오픈소스 고지, 진단 경로, 데이터 저장 위치. Reuses rather than
// re-derives wherever a real source already exists elsewhere in this module:
//  - Client/Runtime 버전: `diagnostic-bundle.ts::readClientVersion`/`readRuntimeVersion`.
//  - Trust Store 문구: `bundle-verify.ts::checkSignatureTrust` (the exact
//    same "미검증" message D04 already shows during import — a second,
//    slightly-different string here would be its own kind of dishonesty).
//  - Revocation 항목 수: `asset-management.ts::loadRevocationEntries`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readClientVersion, readRuntimeVersion } from "./diagnostic-bundle";
import { checkSignatureTrust } from "./bundle-verify";
import { loadRevocationEntries } from "./asset-management";
import type { InstallRootLayout } from "./bundle-install";
import type { DataLocationsInfo, OpenSourceNoticeEntry, OpenSourceNotices, RevocationListInfo, SchemaVersionInfo, SystemInfoView, TrustStoreInfo } from "./types";

// packages/schemas/manifests/{agent,knowledge,prompt,mcp-tool,service-definition}.schema.json
// all declare `"schema_version": { "const": "1.0" }` — a genuine, shared
// constant across every asset-manifest Schema this Desktop build parses
// (`bundle-verify.ts::validateManifestSchema` structurally validates fields
// but does not yet pin/compare this version number — that gap is recorded in
// open-decisions.md D-076 rather than silently implied by this string).
export const SUPPORTED_MANIFEST_SCHEMA_VERSION = "1.0";
const SCHEMA_VERSION_SOURCE =
  "packages/schemas/manifests/*.schema.json의 공통 schema_version 값(Agent/Knowledge/Prompt/MCP Tool/Service Definition)";

// bundle-install.ts가 실제로 쓰는 파일명과 반드시 같아야 한다(같은 M04 모듈
// 내부의 관례적 파일명 — 별도 상수 모듈로 승격하지 않은 이유는 그 파일이
// 아직 이 이름을 export하지 않기 때문. 바뀌면 이 파일도 함께 바뀌어야 함).
const REVOCATION_STATE_FILE = "revocation-list.json";

function buildTrustStoreInfo(): TrustStoreInfo {
  const signatureCheck = checkSignatureTrust();
  return { status: "NOT_IMPLEMENTED", message: signatureCheck.message };
}

function buildRevocationListInfo(layout: InstallRootLayout): RevocationListInfo {
  const entries = loadRevocationEntries(layout);
  const filePath = path.join(layout.stateDir, REVOCATION_STATE_FILE);
  let lastLocalUpdateAt: string | null = null;
  if (fs.existsSync(filePath)) {
    try {
      lastLocalUpdateAt = fs.statSync(filePath).mtime.toISOString();
    } catch {
      lastLocalUpdateAt = null;
    }
  }
  return {
    knownEntryCount: entries.length,
    lastLocalUpdateAt,
    note:
      "Revocation List 항목에는 발행 일시 필드 자체가 없어(packages/schemas Bundle Manifest 계약 밖) '마지막 발행일'을 알 수 없습니다. 위 시각은 이 Desktop이 Bundle을 통해 마지막으로 Revocation 항목을 반영한 로컬 파일 시스템 시각입니다(open-decisions.md D-076).",
  };
}

/** Pure — testable without touching `node_modules`. `resolveInstalled` looks
 * up the actually-installed version/license for one package name (or
 * `null` if it cannot be resolved), so the notice never claims a resolved
 * value it does not actually have. */
export function summarizeOpenSourceNotices(
  declaredDependencies: Record<string, string>,
  resolveInstalled: (name: string) => { version: string | null; license: string | null } | null,
): OpenSourceNotices {
  const entries: OpenSourceNoticeEntry[] = Object.entries(declaredDependencies)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, declaredRange]) => {
      const resolved = resolveInstalled(name);
      return {
        name,
        declaredRange,
        resolvedVersion: resolved?.version ?? null,
        license: resolved?.license ?? null,
      };
    });
  return {
    entries,
    incomplete: true,
    incompleteReason:
      "Desktop(apps/desktop-client)의 직접 실행 의존성 이름·버전·License 필드만 나열합니다 — 전이(transitive) 의존성과 각 License 원문을 포함하는 완전한 OSS 고지는 아직 생성되지 않습니다(open-decisions.md D-076).",
  };
}

/** Reads `node_modules/{name}/package.json`'s `version`/`license` — best
 * effort, `null` when the package cannot be resolved (never installed
 * locally, e.g. a fresh checkout before `pnpm install`). */
function resolveInstalledPackageInfo(nodeModulesDir: string, name: string): { version: string | null; license: string | null } | null {
  const pkgJsonPath = path.join(nodeModulesDir, name, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return null;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    if (typeof raw !== "object" || raw === null) return null;
    const pkg = raw as Record<string, unknown>;
    const version = typeof pkg.version === "string" ? pkg.version : null;
    const license = typeof pkg.license === "string" ? pkg.license : null;
    return { version, license };
  } catch {
    return null;
  }
}

/** Finds this app's own `package.json` the same way `diagnostic-bundle.ts`'s
 * `readClientVersion` does (bounded upward walk from `__dirname` — a fixed
 * relative depth breaks between a Vitest run and the built app). Returns
 * both the parsed `dependencies` map and the directory it was found in (so
 * the caller can resolve `node_modules` as a sibling). */
function findAppPackageJson(startDir: string): { dependencies: Record<string, string>; appDir: string } | null {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8"));
        if (parsed.name === "desktop-client") {
          const deps = typeof parsed.dependencies === "object" && parsed.dependencies !== null ? parsed.dependencies : {};
          return { dependencies: deps as Record<string, string>, appDir: dir };
        }
      } catch {
        // keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function buildOpenSourceNotices(): OpenSourceNotices {
  const found = findAppPackageJson(__dirname);
  if (!found) {
    return {
      entries: [],
      incomplete: true,
      incompleteReason: "package.json을 찾을 수 없어 오픈소스 고지를 생성하지 못했습니다.",
    };
  }
  const nodeModulesDir = path.join(found.appDir, "node_modules");
  return summarizeOpenSourceNotices(found.dependencies, (name) => resolveInstalledPackageInfo(nodeModulesDir, name));
}

function buildDataLocations(layout: InstallRootLayout): DataLocationsInfo {
  return {
    installRoot: layout.root,
    assetsDir: layout.assetsDir,
    stateDir: layout.stateDir,
    logsDir: path.join(layout.stateDir, "logs"),
    quarantineDir: layout.quarantineDir,
    profilesDir: layout.profilesDir,
    diagnosticsDir: path.join(layout.root, "diagnostics"),
  };
}

export async function buildSystemInfo(layout: InstallRootLayout): Promise<SystemInfoView> {
  const { version: runtimeVersion, note: runtimeVersionNote } = await readRuntimeVersion();
  const schemaVersion: SchemaVersionInfo = { supportedVersion: SUPPORTED_MANIFEST_SCHEMA_VERSION, source: SCHEMA_VERSION_SOURCE };
  return {
    clientVersion: readClientVersion(__dirname),
    runtimeVersion,
    runtimeVersionNote,
    schemaVersion,
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    trustStore: buildTrustStoreInfo(),
    revocationList: buildRevocationListInfo(layout),
    openSourceNotices: buildOpenSourceNotices(),
    dataLocations: buildDataLocations(layout),
  };
}
