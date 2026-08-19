import { describe, expect, it } from "vitest";
import type { LocalTool, LocalToolCandidateResult, LocalToolInvocationResult } from "../../electron/types";
import {
  buildLocalToolArgs,
  defaultSelectedFunctionNames,
  describeMcpToolsNoticeForEmptyState,
  fieldKindForSchemaType,
  formatArgsForConfirm,
  formatInvocationOutcome,
  parseLocalToolFieldValue,
  summarizeBulkAddResults,
  type LocalToolBulkAddOutcome,
} from "./localToolsTypes";

function tool(overrides: Partial<LocalTool> = {}): LocalTool {
  return {
    id: "id-1",
    filePath: "/tmp/x.py",
    functionName: "f",
    toolName: "f",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    parameters: [
      { name: "name", schemaType: "string", required: true, defaultIncluded: false },
      { name: "limit", schemaType: "integer", required: false, defaultIncluded: true },
      { name: "active", schemaType: "boolean", required: false, defaultIncluded: true },
      { name: "tags", schemaType: "array<string>", required: false, defaultIncluded: false },
    ],
    discarded: { bodyStatementCount: 1, decoratorCount: 0, docstringPresent: false, sourceExecuted: false, sourcePersisted: false },
    warnings: [],
    addedAt: "2026-08-14T00:00:00.000Z",
    riskAcknowledgedAt: "2026-08-14T00:00:00.000Z",
    approval: null,
    ...overrides,
  };
}

describe("fieldKindForSchemaType", () => {
  it("maps primitive types", () => {
    expect(fieldKindForSchemaType("string")).toBe("text");
    expect(fieldKindForSchemaType("integer")).toBe("number");
    expect(fieldKindForSchemaType("number")).toBe("number");
    expect(fieldKindForSchemaType("boolean")).toBe("boolean");
  });
  it("falls back to json for compound/unknown types", () => {
    expect(fieldKindForSchemaType("array<string>")).toBe("json");
    expect(fieldKindForSchemaType("object<integer>")).toBe("json");
    expect(fieldKindForSchemaType("literal")).toBe("json");
    expect(fieldKindForSchemaType("any")).toBe("json");
  });
});

describe("parseLocalToolFieldValue", () => {
  it("requires a value for required fields", () => {
    expect(parseLocalToolFieldValue("text", "", true).ok).toBe(false);
  });
  it("omits optional empty fields", () => {
    const result = parseLocalToolFieldValue("text", "  ", false);
    expect(result.ok).toBe(true);
    expect(result.value).toBeUndefined();
  });
  it("parses numbers and rejects non-numeric text", () => {
    expect(parseLocalToolFieldValue("number", "42", true)).toEqual({ ok: true, value: 42 });
    expect(parseLocalToolFieldValue("number", "abc", true).ok).toBe(false);
  });
  it("parses booleans from the literal strings", () => {
    expect(parseLocalToolFieldValue("boolean", "true", false)).toEqual({ ok: true, value: true });
    expect(parseLocalToolFieldValue("boolean", "false", false)).toEqual({ ok: true, value: false });
  });
  it("parses JSON and rejects invalid JSON", () => {
    expect(parseLocalToolFieldValue("json", "[1,2,3]", true)).toEqual({ ok: true, value: [1, 2, 3] });
    expect(parseLocalToolFieldValue("json", "{not json", true).ok).toBe(false);
  });
});

describe("buildLocalToolArgs", () => {
  it("builds args and omits empty optional fields", () => {
    const result = buildLocalToolArgs(tool(), { name: "kim", limit: "", active: "true", tags: "" });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual({ name: "kim", active: true });
  });

  it("reports field-level errors for a missing required field", () => {
    const result = buildLocalToolArgs(tool(), { name: "", limit: "", active: "false", tags: "" });
    expect(result.ok).toBe(false);
    expect(result.errors?.name).toBeTruthy();
  });
});

describe("formatArgsForConfirm", () => {
  it("shows a placeholder for no args", () => {
    expect(formatArgsForConfirm({})).toBe("(인자 없음)");
  });
  it("pretty-prints args as JSON", () => {
    expect(formatArgsForConfirm({ a: 1 })).toContain('"a": 1');
  });
});

describe("formatInvocationOutcome", () => {
  it("distinguishes all nine outcomes", () => {
    const cases: LocalToolInvocationResult[] = [
      { outcome: "success", result: { ok: true } },
      { outcome: "function_error", errorType: "ValueError", errorMessage: "bad" },
      { outcome: "nonzero_exit", exitCode: 2, stderrSnippet: "boom" },
      { outcome: "timeout", timeoutMs: 30_000 },
      { outcome: "oversized_output", limitBytes: 262_144 },
      { outcome: "spawn_error", message: "ENOENT" },
      { outcome: "interpreter_not_configured" },
      { outcome: "user_denied" },
      { outcome: "cancelled" },
    ];
    const titles = cases.map((c) => formatInvocationOutcome(c).title);
    expect(new Set(titles).size).toBe(titles.length); // all distinct
  });

  it("success shows the JSON result", () => {
    const display = formatInvocationOutcome({ outcome: "success", result: { greeting: "hi" } });
    expect(display.tone).toBe("success");
    expect(display.detail).toContain("greeting");
  });

  it("interpreter_not_configured points at Settings", () => {
    const display = formatInvocationOutcome({ outcome: "interpreter_not_configured" });
    expect(display.detail).toContain("설정");
  });

  // 실사용 제보(2026-08-19) — 취소는 실패가 아니라 정상 결과다. user_denied와
  // 같은 muted 톤이어야 하고, danger/warning으로 보이면 안 된다.
  it("cancelled is shown as a normal (muted) result, not a failure", () => {
    const display = formatInvocationOutcome({ outcome: "cancelled" });
    expect(display.tone).toBe("muted");
    expect(display.tone).not.toBe("danger");
    expect(display.tone).not.toBe("warning");
    expect(display.title).not.toContain("실패");
    expect(display.title).not.toContain("오류");
  });

  // 실사용 제보(2026-08-19) — 타임아웃 메시지는 "무엇의 상한인지"와 그 값을
  // 사람이 읽는 단위(분/초)로 담아야 한다. 원시 밀리초를 그대로 보여주지
  // 않는다.
  it("timeout names which cap was hit and shows the value in a human-readable unit", () => {
    const fiveMinutes = formatInvocationOutcome({ outcome: "timeout", timeoutMs: 5 * 60_000 });
    expect(fiveMinutes.detail).toContain("로컬 Tool 1회 호출 상한");
    expect(fiveMinutes.detail).toContain("5분");
    expect(fiveMinutes.detail).not.toContain("300000ms");
    expect(fiveMinutes.detail).not.toContain("300000");

    const thirtySeconds = formatInvocationOutcome({ outcome: "timeout", timeoutMs: 30_000 });
    expect(thirtySeconds.detail).toContain("30초");
  });
});

describe("describeMcpToolsNoticeForEmptyState (D-080/D-084 혼동 정정)", () => {
  it("returns null when there are no MCP Tools at all — the original empty-state text stays accurate", () => {
    const notice = describeMcpToolsNoticeForEmptyState({ connectedNames: [], installedNotConnectedCount: 0 });
    expect(notice).toBeNull();
  });

  it("names the connected MCP Tool(s) and points at the wrench (Tool 자동 제안) toggle", () => {
    const notice = describeMcpToolsNoticeForEmptyState({
      connectedNames: ["숫자 더하기"],
      installedNotConnectedCount: 0,
    });
    expect(notice).toContain("숫자 더하기");
    expect(notice).toContain("렌치");
  });

  it("lists every connected name, not just the first", () => {
    const notice = describeMcpToolsNoticeForEmptyState({
      connectedNames: ["숫자 더하기", "문서 검색"],
      installedNotConnectedCount: 0,
    });
    expect(notice).toContain("숫자 더하기");
    expect(notice).toContain("문서 검색");
  });

  it("reports only the installed-but-not-connected count (no fabricated names) when nothing is connected", () => {
    const notice = describeMcpToolsNoticeForEmptyState({ connectedNames: [], installedNotConnectedCount: 2 });
    expect(notice).toContain("2개");
    expect(notice).toContain("연결");
  });

  it("prioritizes the connected list over the not-connected count when both are present", () => {
    const notice = describeMcpToolsNoticeForEmptyState({
      connectedNames: ["숫자 더하기"],
      installedNotConnectedCount: 1,
    });
    expect(notice).toContain("숫자 더하기");
  });
});

function candidate(overrides: Partial<LocalToolCandidateResult> = {}): LocalToolCandidateResult {
  const base = {
    functionName: "f",
    toolName: "f",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    parameters: [],
    discarded: { bodyStatementCount: 1, decoratorCount: 1, docstringPresent: false, sourceExecuted: false, sourcePersisted: false },
    warnings: [],
  };
  return { ok: true, ...base, ...overrides } as LocalToolCandidateResult;
}

describe("defaultSelectedFunctionNames", () => {
  it("selects every ok:true candidate and excludes failed ones", () => {
    const candidates: LocalToolCandidateResult[] = [
      candidate({ functionName: "a" }),
      { ok: false, functionName: "b", reason: "parameter_annotation_missing", message: "..." },
      candidate({ functionName: "c" }),
    ];
    expect(defaultSelectedFunctionNames(candidates)).toEqual(["a", "c"]);
  });

  it("returns an empty array when no candidate is valid", () => {
    const candidates: LocalToolCandidateResult[] = [
      { ok: false, functionName: "b", reason: "parameter_annotation_missing", message: "..." },
    ];
    expect(defaultSelectedFunctionNames(candidates)).toEqual([]);
  });
});

describe("summarizeBulkAddResults", () => {
  it("reports a single success without failure language", () => {
    const results: LocalToolBulkAddOutcome[] = [{ functionName: "add", ok: true }];
    const summary = summarizeBulkAddResults(results);
    expect(summary).toContain("add");
    expect(summary).not.toContain("실패");
  });

  it("reports all successes when every function registered", () => {
    const results: LocalToolBulkAddOutcome[] = [
      { functionName: "add", ok: true },
      { functionName: "sub", ok: true },
    ];
    const summary = summarizeBulkAddResults(results);
    expect(summary).toContain("add");
    expect(summary).toContain("sub");
    expect(summary).not.toContain("실패");
  });

  it("reports both succeeded and failed functions by name+reason when partial (never silently drops the failures)", () => {
    const results: LocalToolBulkAddOutcome[] = [
      { functionName: "add", ok: true },
      { functionName: "dup", ok: false, error: "이미 등록된 로컬 Tool 이름과 같습니다: 'dup'" },
    ];
    const summary = summarizeBulkAddResults(results);
    expect(summary).toContain("add");
    expect(summary).toContain("dup");
    expect(summary).toContain("이미 등록된");
  });

  it("returns a distinct message when nothing was selected", () => {
    expect(summarizeBulkAddResults([])).not.toBe("");
  });
});
