// D11 로그/진단 — 진단 Bundle 조립. `types.ts`의 `DiagnosticBundle`이 이미
// 허용된 필드를 전부 열거해 두었으므로, 이 파일의 유일한 책임은 그 필드마다
// "정확히 이 값"을 채우는 것이다 — 어딘가에서 객체를 통째로 스프레드해 넣는
// 코드가 한 줄이라도 있으면 그 자체가 버그다(Deny-list가 아니라 Allow-list
// 여야 한다는 지시사항의 핵심). Prompt 원문·문서 전체·DB 결과·Secret이 여기
// 들어올 유일한 경로는 `logs` 필드뿐이고, 그마저도 `log-sanitizer.ts`를
// 반드시 거친다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstallRootLayout } from "./bundle-install";
import type { InstalledAssetsStore } from "./installed-assets-store";
import { checkAllConnections, DEFAULT_OLLAMA_BASE_URL, DEFAULT_RUNTIME_BASE_URL } from "./connections";
import { filterLogEntries } from "./log-filter";
import { sanitizeText } from "./log-sanitizer";
import type { DesktopSettingsPublic, DiagnosticBundle, LogEntry, LogFilters, PortalSettingsPublic } from "./types";

/** Finds this app's own `package.json` (for `clientVersion`) by walking up
 * from `__dirname` — a fixed relative depth breaks between a Vitest run
 * (`electron/`, source) and the built app (`dist/electron/`), same issue
 * `bundle-verify.ts`'s `findRepoRoot` documents. Bounded to a handful of
 * levels; returns `"0.0.0"` (never throws) if it somehow cannot be found —
 * a diagnostic Bundle must still be produced even if this one field is
 * degraded. */
// Exported for D13(정보/보안)'s "Client 버전" reuse — `system-info.ts` must
// never re-derive this from a second, hand-copied path-walk.
export function readClientVersion(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8"));
        if (parsed.name === "desktop-client" && typeof parsed.version === "string") {
          return parsed.version;
        }
      } catch {
        // keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

// Exported for D13's "Runtime 버전" reuse — same reasoning as
// `readClientVersion` above.
// `baseUrl`은 호출자가 저장된 설정(`agentRuntimeBaseUrl`)에서 넘긴다 —
// 여기서 주소를 다시 하드코딩하면, 사용자가 다른 포트로 띄운 Runtime이
// 멀쩡히 도는데도 진단 Bundle에는 "연결할 수 없어 버전을 확인하지 못했습니다"
// 라고 적히게 된다. 기본값은 계속 `connections.ts` 하나에서만 온다.
export async function readRuntimeVersion(
  baseUrl: string = DEFAULT_RUNTIME_BASE_URL,
): Promise<{ version: string | null; note: string | null }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { version: null, note: `Local Agent Runtime 응답 오류(HTTP ${res.status})로 버전을 확인하지 못했습니다.` };
    const body = (await res.json()) as { version?: string };
    return body.version ? { version: body.version, note: null } : { version: null, note: "Local Agent Runtime이 버전 정보를 반환하지 않았습니다." };
  } catch {
    return { version: null, note: "Local Agent Runtime에 연결할 수 없어 버전을 확인하지 못했습니다." };
  }
}

const PYTHON_VERSION_NOTE =
  "Desktop Client는 Electron/Node 기반이라 자체 Python 버전이 없습니다(D-006). Local Agent Runtime(Python)이 자신의 Python 버전을 알려주는 API를 아직 제공하지 않아 확인할 수 없습니다.";

/** Explicit allowlist of settings worth including — never "every env var" or
 * "the whole config object". Each value is still run through the sanitizer
 * (defense in depth) even though none of these are expected to hold a
 * secret today.
 *
 * `portalSettings`(자산 스토어 D-071)는 의도적으로 `tokenConfigured`
 * (boolean, "true"/"false" 문자열)만 포함한다 — 실제 Portal Token 값은
 * `PortalSettingsStore.getToken()`으로만 접근 가능하고 이 함수는 그 메서드를
 * 절대 호출하지 않는다. `electron/__tests__/diagnostic-bundle.test.ts`가
 * 저장된 Token 원문이 진단 Bundle 어디에도(직렬화된 JSON 전체 기준) 나타나지
 * 않음을 명시적으로 검증한다. */
function collectSanitizedSettings(
  layout: InstallRootLayout,
  portalSettings: PortalSettingsPublic | null,
  desktopSettings: DesktopSettingsPublic | null,
): Record<string, string> {
  const settings: Record<string, string> = {
    installRoot: layout.root,
    // 실제로 이 앱이 쓰는 주소를 적는다. 예전에는 여기에 기본값 문자열이
    // 하드코딩돼 있어, 설정을 바꾼 사용자의 진단 Bundle이 쓰지도 않는 주소를
    // 보고했다 — 진단 파일이 사실과 다르면 진단이 아니라 오도다.
    agentRuntimeBaseUrl: desktopSettings?.agentRuntimeBaseUrl ?? DEFAULT_RUNTIME_BASE_URL,
    ollamaBaseUrl: desktopSettings?.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL,
    portalBaseUrl: portalSettings?.baseUrl ?? "미설정",
    portalTokenConfigured: String(portalSettings?.tokenConfigured ?? false),
  };
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    sanitized[key] = sanitizeText(value);
  }
  return sanitized;
}

export async function buildDiagnosticBundle(
  layout: InstallRootLayout,
  store: InstalledAssetsStore,
  allLogs: LogEntry[],
  filters: LogFilters,
  portalSettings: PortalSettingsPublic | null = null,
  desktopSettings: DesktopSettingsPublic | null = null,
): Promise<DiagnosticBundle> {
  const { version: runtimeVersion, note: runtimeVersionNote } = await readRuntimeVersion(
    desktopSettings?.agentRuntimeBaseUrl ?? DEFAULT_RUNTIME_BASE_URL,
  );
  const health = await checkAllConnections({
    runtimeBaseUrl: desktopSettings?.agentRuntimeBaseUrl,
    ollamaBaseUrl: desktopSettings?.ollamaBaseUrl,
    mcpServerUrl: desktopSettings?.mcpServerUrl,
    mcpServerAlias: desktopSettings?.mcpServerAlias,
    searchRuntimeBaseUrl: desktopSettings?.searchRuntimeBaseUrl,
  });

  const filteredLogs = filterLogEntries(allLogs, filters);
  const sanitizedLogs: LogEntry[] = filteredLogs.map((entry) => ({
    ...entry,
    message: sanitizeText(entry.message),
  }));

  const installedAssets = store.list().map((a) => ({
    assetId: a.assetId,
    assetType: a.assetType,
    version: a.version,
    // 파일별 checksum을 이어붙여 한 번 더 해시한 "자산 전체 대표 Hash" —
    // 새 해시 알고리즘이 아니라 이미 저장된 개별 파일 checksum들의 결정적
    // 요약이다. 재검사 기준값(`fileChecksums`)이 없는 자산(D08 참고)은
    // 정직하게 null로 남긴다.
    contentHash: a.fileChecksums
      ? Object.entries(a.fileChecksums)
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([p, h]) => `${p}:${h}`)
          .join("|")
      : null,
  }));

  return {
    generatedAt: new Date().toISOString(),
    clientVersion: readClientVersion(__dirname),
    runtimeVersion,
    runtimeVersionNote,
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    pythonVersion: null,
    pythonVersionNote: PYTHON_VERSION_NOTE,
    sanitizedSettings: collectSanitizedSettings(layout, portalSettings, desktopSettings),
    installedAssets,
    health,
    logs: sanitizedLogs,
  };
}

/** Writes the Bundle as JSON under `{installRoot}/diagnostics/` and returns
 * the path — the D11 UI surfaces this so the user knows where to find the
 * file to share (e.g. via email/ticket attachment), matching D13's "진단
 * 경로" expectation. */
export function saveDiagnosticBundle(layout: InstallRootLayout, bundle: DiagnosticBundle): string {
  const dir = path.join(layout.root, "diagnostics");
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `diagnostic-bundle-${bundle.generatedAt.replace(/[:.]/g, "-")}.json`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), "utf-8");
  return filePath;
}
