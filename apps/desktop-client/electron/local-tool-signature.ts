// D-084 "Desktop 로컬 Tool" — static Python function signature parsing, pure
// TypeScript, no fs/electron import (mirrors mcp-tool-manifest.ts's pure/
// main-process split: fs reading stays in main.ts's `inspectLocalToolFile`
// handler, this file only decides whether an already-read source string is
// usable). This file NEVER executes, imports, evals, or shells out to run
// the submitted .py source — it is regex/text-based structural analysis
// only, deliberately not a full Python grammar (Task Brief: doing anything
// else here, before any user approval, would itself be the unapproved
// execution 구현 원칙 7 forbids).
//
// Mirrors `apps/portal-api/src/portal_api/python_signature.py`'s behavior
// and Korean-facing error/refusal shape (kept READ ONLY, not imported — that
// module is Python and unreachable from this TS process) so a user who has
// seen the Portal's Python->MCP Tool converter sees a consistent experience
// here. Differences from that module are structural, not behavioral: this
// file cannot use `ast`, so it hand-rolls a light bracket/quote-aware
// scanner instead of a real parser. Deliberately conservative — anything
// that scanner can't confidently classify is refused (`unsupported_annotation`
// or similar), never guessed.

// 20_000(~500줄)은 사내 실사용에서 너무 낮았다 — 실제 Tool 파일 하나에
// `@tool` 함수 여러 개(각각 docstring/도우미 코드 포함)를 담기에 충분치
// 않았다는 실사용 제보(Windows). 200_000자로 올린다: 이 스캐너는 동기
// 텍스트 스캔(정규식/괄호 추적)이라 상한을 아예 없애면 병적인 입력이 UI를
// 멈출 수 있으므로 상한 자체는 유지하되, 20만 자는 이 스캐너로도 여전히
// 수십 ms 안에 끝나면서(정규식 스캔은 입력 길이에 선형) 현실적인 다중-Tool
// 파일은 넉넉히 담는 값이다. `apps/portal-api/src/portal_api/python_signature.py`
// 의 동일 상수(현재 20_000)도 이 값을 mirror해야 한다 — 그쪽은 M02 소유라
// 이 모듈(M04)에서 바꾸지 않는다. 두 값이 갈라지면 이 저장소가 반복해서
// 겪은 "mirror" drift(파일 상단 주석 참고)가 재현된다.
export const MAX_SOURCE_CHARS = 200_000;
export const MAX_PARAMETERS = 64;

const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENTITY_FIELDS = new Set(["user", "role", "roles", "org", "organization_id"]);

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
   * 쓰인다(`analyzeLocalToolFile`) — `parseLocalToolSignature`의 단일 결과
   * 경로에서는 절대 나오지 않는다. */
  | "duplicate_function_name_in_file";

export interface LocalToolSignatureFailure {
  ok: false;
  reason: LocalToolSignatureRefusalReason;
  message: string;
  candidates?: string[];
}

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

// ---------------------------------------------------------------------------
// Bracket/quote-aware small scanners — the core primitive every other
// function in this file builds on. All Python parameter lists, type
// annotations, and default-value expressions can nest (), [], {} and quoted
// strings, so every split/search below has to skip over those instead of
// naively matching on a bare character.
// ---------------------------------------------------------------------------

function findTopLevelChar(text: string, target: string, fromIndex = 0): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = fromIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && ch === target) return i;
  }
  return -1;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && i + 1 < text.length) {
        current += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      current += ch;
      continue;
    }
    if (depth === 0 && ch === separator) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Given `source[openIndex] === "("`, returns the text strictly between it
 * and its matching close paren (tracking nested brackets/quotes), or `null`
 * if unbalanced (malformed/truncated source — caller skips this candidate
 * rather than guessing). */
function extractBalancedParens(source: string, openIndex: number): { inner: string; endIndex: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0 && ch === ")") {
        return { inner: source.slice(openIndex + 1, i), endIndex: i };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Python-ish literal -> JSON translation, shared by default-value parsing and
// `Literal[...]` argument parsing. Only understands JSON-shaped literals
// (numbers/strings/true/false/null/arrays/objects of the same) — anything
// else (a call expression, a name reference, an f-string) fails closed.
// ---------------------------------------------------------------------------

function pythonLiteralToJsonText(text: string): string | null {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let content = "";
      while (j < text.length && text[j] !== quote) {
        if (text[j] === "\\" && j + 1 < text.length) {
          content += text.slice(j, j + 2);
          j += 2;
          continue;
        }
        content += text[j];
        j += 1;
      }
      if (j >= text.length) return null; // unterminated string literal
      const unescaped = content
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, "\\");
      out += JSON.stringify(unescaped);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1;
      const word = text.slice(i, j);
      if (word === "True") out += "true";
      else if (word === "False") out += "false";
      else if (word === "None") out += "null";
      else return null; // any other bare identifier (call/name ref) is not a literal
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function parsePythonLiteralValue(text: string): { ok: true; value: unknown } | { ok: false } {
  const jsonText = pythonLiteralToJsonText(text.trim());
  if (jsonText === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(jsonText) };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Type annotation -> JSON Schema, mirroring `python_signature.py`'s
// `_annotation_schema` (str/int/float/bool/Any/list/dict/Optional/Union/
// Literal/Annotated/PEP604 `X | Y`). Returns `null` for anything unsupported
// — the caller turns that into the `unsupported_annotation` refusal.
// ---------------------------------------------------------------------------

interface AnnotationSchema {
  schema: Record<string, unknown>;
  label: string;
}

const SIMPLE_ANNOTATIONS: Record<string, AnnotationSchema> = {
  str: { schema: { type: "string" }, label: "string" },
  int: { schema: { type: "integer" }, label: "integer" },
  float: { schema: { type: "number" }, label: "number" },
  bool: { schema: { type: "boolean" }, label: "boolean" },
  Any: { schema: {}, label: "any" },
};

function parseAnnotation(raw: string): AnnotationSchema | null {
  const text = raw.trim();
  if (!text) return null;

  const unionParts = splitTopLevel(text, "|")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (unionParts.length > 1) {
    const parsed = unionParts.map(parseAnnotation);
    if (parsed.some((p) => p === null)) return null;
    const resolved = parsed as AnnotationSchema[];
    return { schema: { anyOf: resolved.map((p) => p.schema) }, label: resolved.map((p) => p.label).join(" | ") };
  }

  if (text === "None") return { schema: { type: "null" }, label: "null" };
  if (SIMPLE_ANNOTATIONS[text]) return SIMPLE_ANNOTATIONS[text];

  const subscriptMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\[([\s\S]*)\]$/.exec(text);
  if (!subscriptMatch) return null;
  const base = subscriptMatch[1];
  const args = splitTopLevel(subscriptMatch[2], ",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);

  if (["list", "List", "set", "Set", "Sequence"].includes(base) && args.length === 1) {
    const item = parseAnnotation(args[0]);
    if (!item) return null;
    return { schema: { type: "array", items: item.schema }, label: `array<${item.label}>` };
  }
  if (["dict", "Dict", "Mapping"].includes(base) && args.length === 2) {
    const key = parseAnnotation(args[0]);
    if (!key || key.label !== "string") return null; // dict/Mapping key must be str, same as python_signature.py
    const value = parseAnnotation(args[1]);
    if (!value) return null;
    return { schema: { type: "object", additionalProperties: value.schema }, label: `object<${value.label}>` };
  }
  if (base === "Optional" && args.length === 1) {
    const value = parseAnnotation(args[0]);
    if (!value) return null;
    return { schema: { anyOf: [value.schema, { type: "null" }] }, label: `${value.label} | null` };
  }
  if (base === "Union" && args.length > 0) {
    const parsed = args.map(parseAnnotation);
    if (parsed.some((p) => p === null)) return null;
    const resolved = parsed as AnnotationSchema[];
    return { schema: { anyOf: resolved.map((p) => p.schema) }, label: resolved.map((p) => p.label).join(" | ") };
  }
  if (base === "Annotated" && args.length > 0) {
    return parseAnnotation(args[0]);
  }
  if (base === "Literal" && args.length > 0) {
    const values: unknown[] = [];
    for (const arg of args) {
      const literal = parsePythonLiteralValue(arg);
      if (!literal.ok) return null;
      values.push(literal.value);
    }
    return { schema: { enum: values }, label: "literal" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Top-level `def`/`async def` discovery + parameter-list extraction.
// "Top-level" == column 0 (not indented) — the `^` regex anchor with the
// multiline flag already means exactly that.
// ---------------------------------------------------------------------------

interface RawFunctionDef {
  name: string;
  paramsText: string;
  defStartIndex: number;
  colonIndex: number;
}

function findTopLevelFunctions(source: string): RawFunctionDef[] {
  const results: RawFunctionDef[] = [];
  const defRe = /^(?:async\s+def|def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = defRe.exec(source)) !== null) {
    const name = match[1];
    const parenOpenIndex = match.index + match[0].length - 1;
    const balanced = extractBalancedParens(source, parenOpenIndex);
    if (!balanced) continue; // unbalanced/truncated — never guess, just skip this candidate
    const afterParams = source.slice(balanced.endIndex + 1);
    const colonOffset = findTopLevelChar(afterParams, ":");
    if (colonOffset === -1) continue; // malformed signature (no body colon found)
    results.push({
      name,
      paramsText: balanced.inner,
      defStartIndex: match.index,
      colonIndex: balanced.endIndex + 1 + colonOffset,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// `@tool`/`@mcp.tool` decorator recognition (multi-function registration).
//
// Scope decision (Task Brief A/범위 밖 "데코레이터 인자 해석"): a decorator
// is recognized by NAME only — bare `tool` (covers `from ... import tool as
// tool`-style aliasing that leaves a simple name at the call site) or any
// dotted path whose LAST segment is `tool` (covers `@mcp.tool`, `@server.tool`,
// `@app.tool`, ... — the object before `.tool` is an arbitrary instance the
// user's own code created, e.g. `mcp = FastMCP(...)`, so there is no single
// fixed prefix to match on; matching the suffix is the confident, general
// form of "dot notation" the Task Brief asks for). Call arguments
// (`@mcp.tool(name="x")`) are scanned only to find where the decorator ENDS
// (balanced-paren skip) — their contents are never parsed or evaluated, so
// `name=...` never changes the registered tool name (always the function
// name). Anything else — a decorator whose name doesn't end in `tool`, or
// one whose call-parens don't balance (malformed/truncated source) — is not
// treated as a tool decorator. Never guessed.
// ---------------------------------------------------------------------------

interface DecoratorMatch {
  name: string;
  startIndex: number;
  endIndex: number;
}

function findTopLevelDecorators(source: string): DecoratorMatch[] {
  const results: DecoratorMatch[] = [];
  const decoratorRe = /^@\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/gm;
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = decoratorRe.exec(source)) !== null) {
    const name = match[1];
    let endIndex = match.index + match[0].length;
    let i = endIndex;
    while (i < source.length && (source[i] === " " || source[i] === "\t")) i += 1;
    if (source[i] === "(") {
      const balanced = extractBalancedParens(source, i);
      // Unbalanced call parens: leave endIndex at the bare name so the gap
      // before the next token is non-whitespace and this decorator fails
      // the contiguity check below rather than being guessed at.
      if (balanced) endIndex = balanced.endIndex + 1;
    }
    results.push({ name, startIndex: match.index, endIndex });
  }
  return results;
}

function isToolDecoratorName(name: string): boolean {
  const parts = name.split(".");
  return parts[parts.length - 1] === "tool";
}

/** Walks backward from `defStartIndex` collecting the contiguous run of
 * decorators immediately above it (only whitespace/newlines between them —
 * any other text breaks the chain). Order preserved top-to-bottom. */
function collectDecoratorChain(source: string, decorators: DecoratorMatch[], defStartIndex: number): DecoratorMatch[] {
  const before = decorators.filter((d) => d.endIndex <= defStartIndex);
  const chain: DecoratorMatch[] = [];
  let cursor = defStartIndex;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const d = before[i];
    const gap = source.slice(d.endIndex, cursor);
    if (!/^\s*$/.test(gap)) break;
    chain.unshift(d);
    cursor = d.startIndex;
  }
  return chain;
}

function isFunctionToolDecorated(source: string, decorators: DecoratorMatch[], defStartIndex: number): boolean {
  return collectDecoratorChain(source, decorators, defStartIndex).some((d) => isToolDecoratorName(d.name));
}

function countDecorators(source: string, defStartIndex: number): number {
  const before = source.slice(0, defStartIndex);
  const lines = before.split("\n");
  if (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  let count = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("@")) {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

function analyzeBody(source: string, colonIndex: number): { bodyStatementCount: number; docstringPresent: boolean } {
  const rest = source.slice(colonIndex + 1);
  const newlineIdx = rest.indexOf("\n");
  const sameLine = newlineIdx === -1 ? rest : rest.slice(0, newlineIdx);
  if (sameLine.trim().length > 0) {
    const trimmed = sameLine.trim();
    return { bodyStatementCount: 1, docstringPresent: /^("""|'''|"|')/.test(trimmed) };
  }
  const bodyLines = newlineIdx === -1 ? [] : rest.slice(newlineIdx + 1).split("\n");
  let baseIndent: number | null = null;
  let count = 0;
  let docstringPresent = false;
  let sawFirstStatement = false;
  for (const line of bodyLines) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (baseIndent === null) baseIndent = indent;
    if (indent < baseIndent) break; // dedented out of this function's body
    if (indent === baseIndent) {
      count += 1;
      if (!sawFirstStatement) {
        sawFirstStatement = true;
        docstringPresent = /^("""|'''|"|')/.test(line.trim());
      }
    }
  }
  return { bodyStatementCount: count, docstringPresent };
}

// ---------------------------------------------------------------------------
// Parameter-list parsing.
// ---------------------------------------------------------------------------

interface RawParam {
  name: string;
  annotationText?: string;
  defaultText?: string;
}

function splitParams(paramsText: string): string[] {
  return splitTopLevel(paramsText, ",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parses the raw parameter list text into structured params, or returns a
 * refusal reason if any entry is `*args`/`**kwargs`. Bare `*`/`/` markers
 * (keyword-only / positional-only separators, not variadic collectors) are
 * dropped silently — they carry no schema information of their own. */
function parseParamList(paramsText: string): { ok: true; params: RawParam[] } | { ok: false } {
  const params: RawParam[] = [];
  for (const raw of splitParams(paramsText)) {
    if (raw === "*" || raw === "/") continue;
    if (raw.startsWith("**") || raw.startsWith("*")) return { ok: false };
    const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(raw);
    if (!nameMatch) continue; // not a recognizable parameter token — skip defensively
    const name = nameMatch[1];
    const rest = raw.slice(name.length).trim();
    let annotationText: string | undefined;
    let defaultText: string | undefined;
    if (rest.startsWith(":")) {
      const afterColon = rest.slice(1).trim();
      const eqIdx = findTopLevelChar(afterColon, "=");
      if (eqIdx === -1) {
        annotationText = afterColon;
      } else {
        annotationText = afterColon.slice(0, eqIdx).trim();
        defaultText = afterColon.slice(eqIdx + 1).trim();
      }
    } else if (rest.startsWith("=")) {
      defaultText = rest.slice(1).trim();
    }
    params.push({ name, annotationText, defaultText });
  }
  return { ok: true, params };
}

/** Per-function validation shared by `parseLocalToolSignature` (single,
 * legacy-shaped result) and `analyzeLocalToolFile` (multi-candidate preview).
 * Never returns `candidates` — that field only makes sense at the
 * whole-file selection step, not per-function. */
function buildFunctionCandidate(source: string, fn: RawFunctionDef): LocalToolCandidateResult {
  if (!TOOL_NAME_PATTERN.test(fn.name)) {
    return {
      ok: false,
      functionName: fn.name,
      reason: "function_name_invalid",
      message: "함수 이름을 로컬 Tool 식별자로 사용할 수 없습니다.",
    };
  }

  const parsedParams = parseParamList(fn.paramsText);
  if (!parsedParams.ok) {
    return {
      ok: false,
      functionName: fn.name,
      reason: "variadic_parameters_unsupported",
      message: "*args와 **kwargs는 입력 Schema로 변환할 수 없습니다.",
    };
  }

  if (parsedParams.params.length > MAX_PARAMETERS) {
    return {
      ok: false,
      functionName: fn.name,
      reason: "too_many_parameters",
      message: `파라미터는 최대 ${MAX_PARAMETERS}개까지 지원합니다.`,
    };
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const parameters: LocalToolParameterInfo[] = [];
  const warnings: string[] = [];

  for (const param of parsedParams.params) {
    if (IDENTITY_FIELDS.has(param.name.toLowerCase())) {
      return {
        ok: false,
        functionName: fn.name,
        reason: "identity_parameter_forbidden",
        message: `'${param.name}'은 신원·권한 필드이므로 Tool 입력으로 선언할 수 없습니다. 신원은 이 Tool 실행 흐름에 주입되지 않습니다.`,
      };
    }
    if (param.annotationText === undefined) {
      return {
        ok: false,
        functionName: fn.name,
        reason: "parameter_annotation_missing",
        message: "모든 파라미터에 타입 표기를 추가하세요. 타입을 추측해 Schema를 만들지 않습니다.",
      };
    }
    const annotation = parseAnnotation(param.annotationText);
    if (!annotation) {
      return {
        ok: false,
        functionName: fn.name,
        reason: "unsupported_annotation",
        message: "지원하지 않는 타입 표기입니다. str/int/float/bool/list/dict/Optional/Union/Literal만 사용하세요.",
      };
    }

    let schema = annotation.schema;
    let defaultIncluded = false;
    if (param.defaultText !== undefined) {
      const literal = parsePythonLiteralValue(param.defaultText);
      if (literal.ok) {
        defaultIncluded = true;
        schema = { ...schema, default: literal.value };
      } else {
        warnings.push(`${param.name}: 호출식/객체 기본값은 실행하지 않고 버렸습니다.`);
      }
    } else {
      required.push(param.name);
    }

    properties[param.name] = schema;
    parameters.push({
      name: param.name,
      schemaType: annotation.label,
      required: param.defaultText === undefined,
      defaultIncluded,
    });
  }

  const { bodyStatementCount, docstringPresent } = analyzeBody(source, fn.colonIndex);
  const decoratorCount = countDecorators(source, fn.defStartIndex);

  return {
    ok: true,
    functionName: fn.name,
    toolName: fn.name,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    parameters,
    discarded: {
      bodyStatementCount,
      decoratorCount,
      docstringPresent,
      sourceExecuted: false,
      sourcePersisted: false,
    },
    warnings,
  };
}

/** Converts already-read Python source text into an MCP-Tool-shaped input
 * schema, or an explicit refusal. Never executes/imports/evals the source —
 * text/regex-based structural analysis only.
 *
 * Selects exactly one top-level function (by `requestedFunctionName`, or the
 * sole function when there's only one) — unaware of `@tool`/`@mcp.tool`
 * decorators, unchanged from before multi-function support existed. This is
 * intentional: `electron/main.ts`'s `localTool:add` handler always knows
 * which single function it's (re-)registering (either the caller picked one
 * from `analyzeLocalToolFile`'s candidates, or there's exactly one function
 * in the file), so it re-verifies with this single-function entry point
 * rather than re-running decorator selection. */
export function parseLocalToolSignature(source: string, requestedFunctionName?: string): LocalToolSignatureResult {
  if (!source.trim()) {
    return { ok: false, reason: "source_empty", message: "Python 함수 시그니처를 입력하세요." };
  }
  if (source.length > MAX_SOURCE_CHARS) {
    return { ok: false, reason: "source_too_large", message: `입력은 ${MAX_SOURCE_CHARS.toLocaleString()}자 이하여야 합니다.` };
  }

  const functions = findTopLevelFunctions(source);
  const candidateNames = functions.map((f) => f.name);
  if (functions.length === 0) {
    return { ok: false, reason: "function_not_found", message: "최상위 Python 함수(def 또는 async def)를 찾지 못했습니다." };
  }

  let selected: RawFunctionDef;
  if (requestedFunctionName) {
    const matches = functions.filter((f) => f.name === requestedFunctionName);
    if (matches.length !== 1) {
      return {
        ok: false,
        reason: "function_not_found",
        message: `'${requestedFunctionName}' 함수를 찾지 못했습니다.`,
        candidates: candidateNames,
      };
    }
    selected = matches[0];
  } else if (functions.length === 1) {
    selected = functions[0];
  } else {
    return {
      ok: false,
      reason: "multiple_functions_found",
      message:
        "최상위 함수가 여러 개입니다. 각 함수 위에 @tool 또는 @mcp.tool을 붙이면 여러 개를 한 번에 등록할 수 있습니다. " +
        "그렇지 않다면 변환할 함수 하나만 남겨 다시 시도하세요.",
      candidates: candidateNames,
    };
  }

  const result = buildFunctionCandidate(source, selected);
  if (!result.ok) {
    return { ok: false, reason: result.reason, message: result.message };
  }
  return {
    ok: true,
    functionName: result.functionName,
    toolName: result.toolName,
    inputSchema: result.inputSchema,
    parameters: result.parameters,
    discarded: result.discarded,
    warnings: result.warnings,
  };
}

// ---------------------------------------------------------------------------
// Multi-function preview/selection (Task Brief A/C/E) — the analysis the
// LocalToolsScreen "review" step shows before any registration happens.
// ---------------------------------------------------------------------------

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

export interface LocalToolFileAnalysisSuccess {
  ok: true;
  /** `true`면 `@tool`/`@mcp.tool`로 선정된 후보(들)다(1개 이상). `false`면
   * 데코레이터가 없고 최상위 함수가 정확히 하나뿐이라 그 함수 하나를
   * (기존과 동일하게, 회귀 없이) 유일한 후보로 삼은 것이다. */
  selectedByDecorator: boolean;
  candidates: LocalToolCandidateResult[];
}

export type LocalToolFileAnalysisResult = LocalToolFileAnalysisSuccess | LocalToolSignatureFailure;

/** Analyzes a whole file and returns every function that should be shown to
 * the user for registration — one candidate per `@tool`/`@mcp.tool`-decorated
 * function if any exist, or the single top-level function when there are no
 * decorators and only one function (unchanged legacy behavior). Never
 * executes the source. Duplicate function names among the selected
 * candidates (rare, but two `def`s can share a name in the same file) are
 * flagged individually as `duplicate_function_name_in_file` rather than
 * silently validating both — see `local-tool-store.ts`'s `findToolNameConflict`
 * for the complementary check against tools already registered from other
 * files/earlier in this same batch. */
export function analyzeLocalToolFile(source: string): LocalToolFileAnalysisResult {
  if (!source.trim()) {
    return { ok: false, reason: "source_empty", message: "Python 함수 시그니처를 입력하세요." };
  }
  if (source.length > MAX_SOURCE_CHARS) {
    return { ok: false, reason: "source_too_large", message: `입력은 ${MAX_SOURCE_CHARS.toLocaleString()}자 이하여야 합니다.` };
  }

  const functions = findTopLevelFunctions(source);
  if (functions.length === 0) {
    return { ok: false, reason: "function_not_found", message: "최상위 Python 함수(def 또는 async def)를 찾지 못했습니다." };
  }

  const decorators = findTopLevelDecorators(source);
  const decorated = functions.filter((f) => isFunctionToolDecorated(source, decorators, f.defStartIndex));

  let selected: RawFunctionDef[];
  let selectedByDecorator: boolean;
  if (decorated.length > 0) {
    selected = decorated;
    selectedByDecorator = true;
  } else if (functions.length === 1) {
    selected = functions;
    selectedByDecorator = false;
  } else {
    return {
      ok: false,
      reason: "multiple_functions_found",
      message:
        "최상위 함수가 여러 개입니다. 각 함수 위에 @tool 또는 @mcp.tool을 붙이면 여러 개를 한 번에 등록할 수 있습니다. " +
        "그렇지 않다면 변환할 함수 하나만 남겨 다시 시도하세요.",
      candidates: functions.map((f) => f.name),
    };
  }

  const seenNames = new Set<string>();
  const candidates: LocalToolCandidateResult[] = selected.map((fn) => {
    if (seenNames.has(fn.name)) {
      return {
        ok: false,
        functionName: fn.name,
        reason: "duplicate_function_name_in_file",
        message: `같은 이름의 함수가 이 파일에 여러 개 있습니다: '${fn.name}'. 각 함수가 서로 다른 이름이어야 각각 등록할 수 있습니다.`,
      };
    }
    seenNames.add(fn.name);
    return buildFunctionCandidate(source, fn);
  });

  return { ok: true, selectedByDecorator, candidates };
}
