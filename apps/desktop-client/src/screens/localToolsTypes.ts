// D-084 "Desktop 로컬 Tool" — pure helpers for LocalToolsScreen.tsx (no
// fs/electron/node imports), mirroring how chatTypes.ts/assetsTypes.ts keep
// branching logic out of JSX so it can be unit-tested directly.
import type { LocalTool, LocalToolInvocationResult, LocalToolParameterInfo } from "../../electron/types";
import { formatBytes } from "../format";

export const NOT_A_SANDBOX_NOTICE =
  "이 Tool은 격리되지 않은 상태로 실행됩니다 — 사용자의 권한으로, 마치 직접 실행한 것과 동일하게 동작합니다. 시간제한과 출력 크기 제한은 멈추지 않는 프로세스를 막기 위한 것일 뿐, 악의적인 코드로부터 보호하지 않습니다.";

// --- D-080/D-084 혼동 정정(2026-08-17) --------------------------------------
// 실사용 관찰: 자산 스토어에서 MCP Tool(예: "숫자 더하기")을 설치·연결한
// 사용자가 대화창의 "로컬 Tool" 버튼을 눌렀다가 "등록된 로컬 Tool이
// 없습니다"를 보고 방금 설치한 Tool이 사라졌다고 오해했다 — 로컬 Tool(이
// 파일이 다루는 .py 파일 실행)과 MCP Tool(자산 스토어에서 설치해 D-083
// 렌치 토글로 쓰는 별개 기능)이 이름만 비슷할 뿐 완전히 다른 저장소·등록·
// 실행 경로라는 사실이 화면 어디에도 없었기 때문이다. 아래 함수는 그
// 빈 상태 문구에 정정 안내를 덧붙인다 — MCP Tool 쪽 사실(연결됨/설치만
// 됨)은 `ChatScreen.tsx`가 `chatTypes.ts`의 `summarizeMcpToolConnections`로
// 계산해 이 함수에 평범한 문자열 배열/숫자로 건네준다. 이 파일이 chatTypes.ts
// 의 타입을 직접 import하지 않는 것은 우연이 아니다 —
// `electron/__tests__/local-tool-isolation.test.ts`가
// `LocalToolInvokePanel.tsx`(이 함수의 유일한 소비자)는 `./chatTypes`를
// 전혀 import하지 않는다는 것을 구조적으로 고정한다.
export interface McpToolsSummaryForLocalToolEmptyState {
  /** 연결되어 실제로 쓸 수 있는 MCP Tool의 업무 목적 이름(`asset.name`,
   * 예: "숫자 더하기") — `tool_name`(예: `calculator.add`)은 여기 담지
   * 않는다(루트 CLAUDE.md UI 규칙: 기술 명칭보다 업무 목적을 먼저). */
  connectedNames: string[];
  /** 설치는 되어 있으나 아직 연결되지 않은 MCP Tool 개수. */
  installedNotConnectedCount: number;
}

/** D-084 로컬 Tool 목록이 비어 있을 때 원래 문구("등록된 로컬 Tool이
 * 없습니다...")에 덧붙일 정정 안내. 그 문구 자체는 D-084 기준으로는 틀리지
 * 않지만, MCP Tool을 설치·연결한 사용자에게는 오도한다. MCP Tool이 하나도
 * 없으면 `null` — 그때는 원래 문구가 그대로 정확하므로 아무것도 덧붙이지
 * 않는다(정상 상태에 새 배너를 만들지 않는다). */
export function describeMcpToolsNoticeForEmptyState(
  summary: McpToolsSummaryForLocalToolEmptyState,
): string | null {
  if (summary.connectedNames.length > 0) {
    const names = summary.connectedNames.map((name) => `"${name}"`).join(", ");
    return `참고: 설치하신 ${names}은(는) 이 기능과는 다릅니다 — 내 PC의 Python 파일이 아니라 사내에 등록된 Tool이며, 입력창의 렌치(Tool 자동 제안) 토글에서 사용합니다.`;
  }
  if (summary.installedNotConnectedCount > 0) {
    return `참고: 자산 스토어에서 설치한 Tool ${summary.installedNotConnectedCount}개가 있습니다. 이 기능과는 다릅니다 — 설치된 자산 화면에서 연결하면 입력창의 렌치(Tool 자동 제안) 토글에서 사용할 수 있습니다.`;
  }
  return null;
}

export type InvocationOutcomeTone = "success" | "danger" | "warning" | "muted";

export interface InvocationOutcomeDisplay {
  tone: InvocationOutcomeTone;
  title: string;
  detail: string;
}

function safeStringifyResult(value: unknown): string {
  if (value === undefined) return "(반환값 없음)";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Maps each of the six `LocalToolInvocationResult.outcome` values to a
 * distinct display — Task Brief: never collapse timeout/nonzero-exit/
 * oversized-output/etc. into one generic "실패" bucket. */
export function formatInvocationOutcome(result: LocalToolInvocationResult): InvocationOutcomeDisplay {
  switch (result.outcome) {
    case "success":
      return { tone: "success", title: "실행 성공", detail: safeStringifyResult(result.result) };
    case "function_error":
      return { tone: "danger", title: `Python 예외: ${result.errorType}`, detail: result.errorMessage || "(메시지 없음)" };
    case "nonzero_exit":
      return {
        tone: "danger",
        title: `종료 코드 ${result.exitCode}`,
        detail: result.stderrSnippet.trim() || "표준 오류 출력이 없습니다.",
      };
    case "timeout":
      return {
        tone: "warning",
        title: "시간 초과",
        detail: `${Math.round(result.timeoutMs / 1000)}초 안에 끝나지 않아 프로세스를 종료했습니다.`,
      };
    case "oversized_output":
      return {
        tone: "warning",
        title: "출력 크기 초과",
        detail: `출력이 ${formatBytes(result.limitBytes)}를 초과해 프로세스를 종료했습니다.`,
      };
    case "spawn_error":
      return { tone: "danger", title: "실행 시작 실패", detail: result.message };
    case "interpreter_not_configured":
      return {
        tone: "muted",
        title: "Python 인터프리터 미설정",
        detail: "설정 > 일반에서 Python 인터프리터 경로를 설정해야 로컬 Tool을 실행할 수 있습니다.",
      };
    case "user_denied":
      // 오류가 아니다 — 실행 직전 Main Process가 띄운 승인 대화상자에서
      // 사용자가 취소한 정상 결과다(D-084). 실패처럼 보이게 하지 않는다.
      return {
        tone: "muted",
        title: "실행하지 않았습니다",
        detail: "실행 승인을 취소하셔서 이 Tool을 실행하지 않았습니다.",
      };
  }
}

export type LocalToolFieldKind = "text" | "number" | "boolean" | "json";

/** Maps a parameter's `schemaType` label (`string`/`integer`/`array<string>`/
 * `literal`/... — see `local-tool-signature.ts`'s annotation labels) to the
 * simple input widget this screen renders for it. Anything not directly a
 * text/number/boolean falls back to a JSON textarea — this doesn't need to
 * be fancy (Task Brief). */
export function fieldKindForSchemaType(schemaType: string): LocalToolFieldKind {
  if (schemaType === "string") return "text";
  if (schemaType === "integer" || schemaType === "number") return "number";
  if (schemaType === "boolean") return "boolean";
  return "json";
}

export interface FieldParseResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Parses one form field's raw text into the typed value that will go into
 * the invocation's `args` object. Empty text for a required field is always
 * an error; empty text for an optional field means "omit this key". */
export function parseLocalToolFieldValue(kind: LocalToolFieldKind, raw: string, required: boolean): FieldParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    if (required) return { ok: false, error: "필수 입력입니다." };
    return { ok: true, value: undefined };
  }
  if (kind === "text") return { ok: true, value: raw };
  if (kind === "number") {
    const n = Number(trimmed);
    if (Number.isNaN(n)) return { ok: false, error: "숫자가 아닙니다." };
    return { ok: true, value: n };
  }
  if (kind === "boolean") return { ok: true, value: trimmed === "true" };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, error: "올바른 JSON이 아닙니다." };
  }
}

/** Builds the raw form field's initial text for a parameter — booleans
 * default to "false" (a concrete, visible choice) rather than blank. */
export function initialFieldText(param: LocalToolParameterInfo): string {
  if (fieldKindForSchemaType(param.schemaType) === "boolean") return "false";
  return "";
}

export interface BuildArgsResult {
  ok: boolean;
  args?: Record<string, unknown>;
  errors?: Record<string, string>;
}

/** Validates and converts every parameter's raw form text into the
 * `args` object `invokeLocalTool` will receive. Returns field-level errors
 * (keyed by parameter name) instead of a single opaque failure so the form
 * can highlight exactly which inputs are wrong. */
export function buildLocalToolArgs(tool: LocalTool, rawValues: Record<string, string>): BuildArgsResult {
  const args: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const param of tool.parameters) {
    const kind = fieldKindForSchemaType(param.schemaType);
    const raw = rawValues[param.name] ?? "";
    const parsed = parseLocalToolFieldValue(kind, raw, param.required);
    if (!parsed.ok) {
      errors[param.name] = parsed.error ?? "입력값을 확인하세요.";
      continue;
    }
    if (parsed.value !== undefined) args[param.name] = parsed.value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, args };
}

/** Pretty-prints the args about to be sent, for the confirm step (Task
 * Brief 요구사항 2 — the confirmation must show the exact arguments). */
export function formatArgsForConfirm(args: Record<string, unknown>): string {
  if (Object.keys(args).length === 0) return "(인자 없음)";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
