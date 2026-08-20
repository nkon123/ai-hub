import { describe, expect, it } from "vitest";
import type { LocalTool, LocalToolCandidateResult, LocalToolInvocationResult } from "../../electron/types";
import {
  buildLocalToolArgs,
  buildToolOnlyTurnPersistPayload,
  classifyToolResultForDisplay,
  defaultSelectedFunctionNames,
  describeMcpToolsNoticeForEmptyState,
  describeUnifiedToolRouteCandidates,
  fieldKindForSchemaType,
  formatArgsForConfirm,
  formatInvocationOutcome,
  outcomeToTurnStatus,
  parseLocalToolFieldValue,
  summarizeBulkAddResults,
  type InvocationOutcomeDisplay,
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

describe("classifyToolResultForDisplay", () => {
  it("classifies a string result as markdown, keeping the raw text", () => {
    expect(classifyToolResultForDisplay("# 제목\n표\n")).toEqual({ kind: "markdown", text: "# 제목\n표\n" });
  });

  it("classifies a plain object as structured JSON", () => {
    const result = classifyToolResultForDisplay({ a: 1, sum: 3334 });
    expect(result.kind).toBe("structured");
    expect(result.text).toContain('"sum": 3334');
  });

  it("classifies an array as structured, not markdown", () => {
    expect(classifyToolResultForDisplay([1, 2, 3]).kind).toBe("structured");
  });

  it("does not throw for null/undefined/number/boolean and classifies them as structured", () => {
    for (const value of [null, undefined, 0, 42, false, true]) {
      expect(() => classifyToolResultForDisplay(value)).not.toThrow();
      expect(classifyToolResultForDisplay(value).kind).toBe("structured");
    }
    expect(classifyToolResultForDisplay(undefined).text).toBe("(반환값 없음)");
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

  it("success shows the JSON result and marks it structured (not markdown) for an object return value", () => {
    const display = formatInvocationOutcome({ outcome: "success", result: { greeting: "hi" } });
    expect(display.tone).toBe("success");
    expect(display.detail).toContain("greeting");
    expect(display.detailKind).toBe("structured");
  });

  // 실사용 제보(2026-08-20) — "결과가 마크다운으로 안 보인다". 문자열을
  // 돌려주는 Tool(예: markdown_table.py)의 결과는 markdown으로 표시돼야
  // 한다 — 그리고 JSON.stringify로 따옴표를 씌우면 안 된다(그러면 원문이
  // 아니게 된다).
  it("success marks a string return value as markdown and keeps the raw text (no JSON quoting)", () => {
    const display = formatInvocationOutcome({ outcome: "success", result: "| a | b |\n|---|---|\n| 1 | 2 |" });
    expect(display.detailKind).toBe("markdown");
    expect(display.detail).toBe("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(display.detail).not.toContain('"'); // JSON.stringify would have added quotes
  });

  it("success marks an array return value as structured, not markdown", () => {
    const display = formatInvocationOutcome({ outcome: "success", result: [1, 2, 3] });
    expect(display.detailKind).toBe("structured");
  });

  // 경계값들 — 크래시 없이 structured로 처리된다.
  it.each([
    ["null", null],
    ["a number", 42],
    ["a boolean", false],
  ] as const)("success treats %s as structured, not markdown", (_label, value) => {
    expect(() => formatInvocationOutcome({ outcome: "success", result: value })).not.toThrow();
    const display = formatInvocationOutcome({ outcome: "success", result: value });
    expect(display.detailKind).toBe("structured");
  });

  // 빈 문자열은 여전히 "문자열"이므로 markdown 경로다(크래시하지 않고,
  // `AnswerMarkdown`이 빈 문자열을 안전하게 다룬다 — 그 파일 자체는 이번
  // 변경 범위 밖이다).
  it("success treats an empty string as markdown without throwing", () => {
    expect(() => formatInvocationOutcome({ outcome: "success", result: "" })).not.toThrow();
    const display = formatInvocationOutcome({ outcome: "success", result: "" });
    expect(display.detailKind).toBe("markdown");
    expect(display.detail).toBe("");
  });

  // 기존 실패/취소/타임아웃 표시는 회귀하지 않는다 — 사람이 쓴 안내
  // 문구이지 Tool 반환값이 아니므로 markdown으로 분류되지 않는다(그리고
  // 기존 톤/제목 규칙도 그대로 유지된다).
  it("non-success outcomes are never marked as markdown (they're hand-written notices, not tool return values)", () => {
    const nonSuccessCases: LocalToolInvocationResult[] = [
      { outcome: "function_error", errorType: "ValueError", errorMessage: "bad" },
      { outcome: "nonzero_exit", exitCode: 2, stderrSnippet: "boom" },
      { outcome: "timeout", timeoutMs: 30_000 },
      { outcome: "oversized_output", limitBytes: 1024 },
      { outcome: "spawn_error", message: "ENOENT" },
      { outcome: "interpreter_not_configured" },
      { outcome: "user_denied" },
      { outcome: "cancelled" },
    ];
    for (const c of nonSuccessCases) {
      const display = formatInvocationOutcome(c);
      expect(display.detailKind).not.toBe("markdown");
    }
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

  it("names the connected MCP Tool(s) and points at the unified 'Tool 자동 선택' toggle (D-089 후속)", () => {
    const notice = describeMcpToolsNoticeForEmptyState({
      connectedNames: ["숫자 더하기"],
      installedNotConnectedCount: 0,
    });
    expect(notice).toContain("숫자 더하기");
    expect(notice).toContain("Tool 자동 선택");
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

// 실사용 제보(2026-08-19, 2026-08-20 후속) — "로컬 Tool 자동 라우팅이
// 생기면서 기존 대화가 없어진다": 자동 라우팅으로 보낸 질문이 대화 저장소에
// 남아야 하고, Tool이 실행되지 않은 경우("불필요 판단"/"후보 없음"/"후보 중
// 못 고름")도 실패로 뭉개지 않은 채 그 사실이 드러나야 한다.
describe("outcomeToTurnStatus", () => {
  it("maps success to succeeded", () => {
    expect(outcomeToTurnStatus("success")).toBe("succeeded");
  });

  it("maps danger (a tool was chosen but couldn't run, e.g. schema validation failure) to failed", () => {
    expect(outcomeToTurnStatus("danger")).toBe("failed");
  });

  it("maps warning (couldn't pick a candidate) to no_action, not failed — nothing actually ran", () => {
    expect(outcomeToTurnStatus("warning")).toBe("no_action");
  });

  it("maps muted (AI decided no tool was needed / no candidates registered) to no_action, not failed", () => {
    expect(outcomeToTurnStatus("muted")).toBe("no_action");
  });
});

describe("buildToolOnlyTurnPersistPayload", () => {
  function outcome(overrides: Partial<InvocationOutcomeDisplay> = {}): InvocationOutcomeDisplay {
    return { tone: "success", title: "실행 성공", detail: "반환값 없음", ...overrides };
  }

  it("persists a succeeded turn with the executed tool recorded in toolExecutions", () => {
    const payload = buildToolOnlyTurnPersistPayload({
      question: "재고 몇 개 남았어?",
      toolName: "check_stock",
      args: { sku: "A-1" },
      route: "ai_auto_selected",
      outcome: outcome({ tone: "success", detail: "재고 12개" }),
    });
    expect(payload.status).toBe("succeeded");
    expect(payload.question).toBe("재고 몇 개 남았어?");
    expect(payload.toolExecutions).toHaveLength(1);
    expect(payload.toolExecutions[0]).toMatchObject({
      toolName: "check_stock",
      args: { sku: "A-1" },
      resultSummary: "재고 12개",
      failureReason: null,
      route: "ai_auto_selected",
    });
  });

  // 실사용 제보(2026-08-20) — 복원된 턴(ChatScreen.tsx의 ToolExecutionsPanel)도
  // 마크다운으로 그려지려면, 저장 Payload가 `outcome.detailKind`를
  // `resultDisplayKind`로 옮겨야 한다.
  it("propagates the outcome's detailKind onto the persisted record's resultDisplayKind", () => {
    const markdownPayload = buildToolOnlyTurnPersistPayload({
      question: "디스크 사용량 보여줘",
      toolName: "disk_space_report",
      args: {},
      route: "user_selected",
      outcome: outcome({ tone: "success", detail: "| 드라이브 | 여유 |\n|---|---|\n| C | 10GB |", detailKind: "markdown" }),
    });
    expect(markdownPayload.toolExecutions[0].resultDisplayKind).toBe("markdown");

    const structuredPayload = buildToolOnlyTurnPersistPayload({
      question: "숫자 더해줘",
      toolName: "add_numbers",
      args: { a: 1, b: 3333 },
      route: "user_selected",
      outcome: outcome({ tone: "success", detail: '{\n  "sum": 3334\n}', detailKind: "structured" }),
    });
    expect(structuredPayload.toolExecutions[0].resultDisplayKind).toBe("structured");
  });

  it("does not set resultDisplayKind for a failed execution (failureReason is always hand-written, not a tool return value)", () => {
    const payload = buildToolOnlyTurnPersistPayload({
      question: "재고 몇 개 남았어?",
      toolName: "check_stock",
      args: null,
      route: "ai_auto_selected",
      outcome: outcome({ tone: "danger", detail: "sku: 필수 항목입니다" }),
    });
    expect(payload.toolExecutions[0].resultDisplayKind).toBeUndefined();
  });

  it("persists a schema-validation failure with the chosen tool name and a failureReason (danger tone)", () => {
    const payload = buildToolOnlyTurnPersistPayload({
      question: "재고 몇 개 남았어?",
      toolName: "check_stock",
      args: null,
      route: "ai_auto_selected",
      outcome: outcome({ tone: "danger", detail: "sku: 필수 항목입니다" }),
    });
    expect(payload.status).toBe("failed");
    expect(payload.toolExecutions).toHaveLength(1);
    expect(payload.toolExecutions[0].failureReason).toBe("sku: 필수 항목입니다");
    expect(payload.toolExecutions[0].resultSummary).toBeNull();
  });

  // 이 테스트가 이번 수정의 핵심 회귀 방지 대상이다: 이전에는 muted/warning
  // 톤일 때 이 함수 자체를 호출하지 않아(ChatScreen.tsx의 `if (toolName)`
  // 가드) 질문이 대화 저장소에서 통째로 사라졌다.
  it("still persists the question when the AI decided no tool was needed (muted, toolName null) — never drops the turn", () => {
    const payload = buildToolOnlyTurnPersistPayload({
      question: "오늘 날씨 어때?",
      toolName: null,
      args: null,
      route: "ai_auto_selected",
      outcome: outcome({
        tone: "muted",
        title: "AI가 Tool이 필요 없다고 판단했습니다",
        detail: "이 질문에는 등록된 로컬 Tool 중 어느 것도 필요하지 않다고 판단해 아무것도 실행하지 않았습니다.",
      }),
    });
    expect(payload.question).toBe("오늘 날씨 어때?");
    expect(payload.status).toBe("no_action");
    // 실행된 Tool이 없으므로 toolExecutions는 정직하게 빈 배열 — 대신
    // 사유는 answer에 담겨 질문만 있고 결과가 텅 비어 보이지 않는다.
    expect(payload.toolExecutions).toEqual([]);
    expect(payload.answer).toContain("필요하지 않다고 판단");
  });

  it("still persists the question when the AI couldn't pick a candidate from the registered tools (warning, toolName null)", () => {
    const payload = buildToolOnlyTurnPersistPayload({
      question: "이 파일 좀 처리해줘",
      toolName: null,
      args: null,
      route: "ai_auto_selected",
      outcome: outcome({
        tone: "warning",
        title: "후보 중에서 Tool을 고르지 못했습니다",
        detail: "AI 응답을 해석하지 못해 어떤 Tool도 실행하지 않았습니다.",
      }),
    });
    expect(payload.question).toBe("이 파일 좀 처리해줘");
    expect(payload.status).toBe("no_action");
    expect(payload.toolExecutions).toEqual([]);
    expect(payload.answer).toContain("해석하지 못해");
  });

  it("never leaves both toolExecutions and answer empty for a terminal status (a turn must always show why)", () => {
    for (const tone of ["success", "danger", "warning", "muted"] as const) {
      const payload = buildToolOnlyTurnPersistPayload({
        question: "질문",
        toolName: tone === "success" || tone === "danger" ? "some_tool" : null,
        args: null,
        route: "ai_auto_selected",
        outcome: outcome({ tone, detail: "상세 내용" }),
      });
      const hasVisibleOutcome = payload.toolExecutions.length > 0 || payload.answer.length > 0;
      expect(hasVisibleOutcome).toBe(true);
    }
  });
});

describe("describeUnifiedToolRouteCandidates (D-089 후속 — 통합 Tool 라우팅 토글의 후보 표시 문구)", () => {
  it("returns an empty string when there are no candidates of either kind", () => {
    expect(describeUnifiedToolRouteCandidates([], [])).toBe("");
  });

  it("lists MCP candidate names and marks them as priority when only MCP candidates exist", () => {
    const text = describeUnifiedToolRouteCandidates([], ["숫자 더하기", "테이블 건수 조회"]);
    expect(text).toContain("숫자 더하기");
    expect(text).toContain("테이블 건수 조회");
    expect(text).not.toContain("로컬 Tool");
  });

  it("lists local candidate names and marks approval status when only local candidates exist", () => {
    const text = describeUnifiedToolRouteCandidates(
      [tool({ toolName: "business_days_between", approval: null }), tool({ toolName: "approved_tool", approval: { approvedFileHash: "h", approvedAt: "2026-08-20T00:00:00.000Z" } })],
      [],
    );
    expect(text).toContain("business_days_between");
    expect(text).toContain("approved_tool(실행 허용됨)");
    expect(text).not.toContain("사내 등록 Tool");
  });

  it("lists both kinds together when both exist, MCP section first", () => {
    const text = describeUnifiedToolRouteCandidates([tool({ toolName: "local_only" })], ["mcp_only"]);
    expect(text.indexOf("mcp_only")).toBeLessThan(text.indexOf("local_only"));
    expect(text).toContain("우선");
  });
});
