// D-084 후속 "채팅 질문으로 로컬 Tool 인자 자동 채우기".
//
// 왜 이 파일이 존재하는가: D-084는 로컬 Tool을 D-083 TOOL_ROUTE에서
// **구조적으로** 배제했다 — 로컬 Tool은 등록·승인·READ_ONLY 검증을 하나도
// 거치지 않은, 사용자 PC의 임의 Python 파일이기 때문이다
// (`electron/__tests__/local-tool-isolation.test.ts`). 그 배제는 여전히
// 유효하다: `services/agent-runtime/src/agent_runtime/tool_router.py`는
// 지금도 로컬 Tool의 존재 자체를 모른다.
//
// 대신 이 파일은 Desktop이 로컬 Ollama에 **직접, 한 번만** 물어 사용자가
// 이미 등록해 둔 로컬 Tool 후보 중 하나를 "제안"받는다 — 승인·실행은 전혀
// 다루지 않는다(그 몫은 여전히 `electron/main.ts`의 `localTool:invoke`
// 네이티브 승인 대화상자와 `local-tool-runner.ts`다). agent-runtime의
// `tool_router.py`가 지키는 규율을 그대로 이 파일에 옮긴다(그 모듈의
// docstring 참고):
//   1. 실패·타임아웃·파싱 실패·모르는 이름·스키마 불일치는 전부 "아무 Tool도
//      실행하지 않음"으로 귀결된다. 후보가 하나뿐이어도 추측하지 않는다.
//   2. 검증 실패를 모델에게 재시도시키지 않는다 — 이 함수는 LLM을 정확히
//      한 번만 부르고, 실패한 검증 결과를 다시 이 함수로 되돌리지 않는다
//      (호출자 책임).
//   3. 라우팅 프롬프트는 이번 턴 질문과 후보 Tool의 이름+입력 Schema만
//      본다 — 대화 History, Citation, 이전 Tool 결과는 절대 넣지 않는다.
//   4. 후보 집합은 호출자가 넘긴 로컬 Tool 목록 그대로다 — 모델 응답에
//      담긴 어떤 이름으로도 넓어지지 않는다(`candidateNames`로 강제).
//
// fs/electron/node import가 없는 순수 HTTP 모듈이다(`ollama-chat.ts`와 같은
// 분류) — Main Process 전용 IPC(네이티브 승인, subprocess 실행)는 이 파일이
// 전혀 알지 못하고, 렌더러에서 직접 호출해도 안전하다.
import { selectOllamaChatModel } from "./ollama-chat";

export interface LocalToolRouteCandidate {
  id: string;
  toolName: string;
  functionName: string;
  inputSchema: Record<string, unknown>;
}

export type LocalToolRouteStatus =
  | "no_candidates"
  | "declined_by_model"
  | "unparseable"
  | "unknown_tool_name"
  | "error_or_timeout"
  | "schema_invalid"
  | "ran";

export interface LocalToolRouteResult {
  status: LocalToolRouteStatus;
  toolId: string | null;
  toolName: string | null;
  args: Record<string, unknown> | null;
  /** `status === "schema_invalid"`일 때만 채워진다 — 필드별 검증 실패 사유. */
  schemaErrors?: Record<string, string>;
}

/** 라우팅 호출 자체의 타임아웃. 실행 프로세스 타임아웃
 * (`local-tool-runner.ts`의 `LOCAL_TOOL_TIMEOUT_MS`)과는 별개다 — 이건
 * "제안을 받는" LLM 호출 하나에 대한 상한이다. */
export const LOCAL_TOOL_ROUTE_TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT =
  "당신은 사용자의 PC에 등록된 로컬 Tool(검토되지 않은 개인 Python 함수) 라우터입니다. " +
  "사용자의 질문과 아래 후보 Tool 목록(이름, 입력 Schema)만 보고, 이 질문에 답하기 위해 " +
  "지금 호출해야 할 Tool을 정확히 하나 고르거나, 필요 없다면 아무 것도 고르지 마세요.\n" +
  "규칙:\n" +
  "- 반드시 JSON 객체 하나만 출력하세요. 다른 설명이나 코드 블록 표시를 덧붙이지 마세요.\n" +
  "- Tool 호출이 필요한지 확신할 수 없으면 호출하지 마세요(과다 호출보다 누락이 안전합니다) " +
  "— 이 경우 tool_name을 null로 출력하세요.\n" +
  "- Tool을 고른다면 input은 그 Tool의 input_schema를 만족하는 값이어야 합니다. 확실하지 않은 " +
  "값은 만들어내지 말고 tool_name을 null로 출력하세요.\n" +
  '- 출력 형식: {"tool_name": "..." 또는 null, "input": {...} 또는 null}';

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function renderCandidateBlock(candidates: LocalToolRouteCandidate[]): string {
  return candidates
    .map((c) => `- tool_name: ${c.toolName}\n  input_schema: ${JSON.stringify(c.inputSchema)}`)
    .join("\n");
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    // fall through to substring extraction below
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 경량 JSON Schema 값 검증 — `local-tool-signature.ts`의 `parseAnnotation`이
// 만드는 스키마 형태(type/anyOf/enum/items/additionalProperties)만 이해하면
// 충분하다. 모델이 만든 인자가 이 검증을 통과하지 못하면 절대 실행하지
// 않는다(Task Brief: 재시도 없이 사유를 사용자에게 보여준다).
// ---------------------------------------------------------------------------

function matchesSchema(schema: unknown, value: unknown): boolean {
  if (!schema || typeof schema !== "object") return true; // {} == "any"
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum)) {
    return s.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value));
  }
  if (Array.isArray(s.anyOf)) {
    return s.anyOf.some((sub) => matchesSchema(sub, value));
  }
  const type = s.type;
  if (type === undefined) return true;
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value) && value.every((item) => matchesSchema(s.items, item));
    case "object":
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value as Record<string, unknown>).every((v) => matchesSchema(s.additionalProperties, v))
      );
    default:
      return true;
  }
}

/** 후보의 `inputSchema`(`{type:"object", properties, required, additionalProperties:false}`)에
 * 대해 모델이 제안한 `rawArgs`를 검증한다. 실패하면 필드별 사유를 담아
 * 반환하고, 호출자는 이 결과로 절대 실행하지 않는다. */
export function validateLocalToolArgs(
  inputSchema: Record<string, unknown>,
  rawArgs: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return { ok: false, errors: { _: "AI가 제안한 입력이 객체(JSON object) 형태가 아닙니다." } };
  }
  const args = rawArgs as Record<string, unknown>;
  const properties = (inputSchema.properties && typeof inputSchema.properties === "object"
    ? (inputSchema.properties as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const required = Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [];
  const allowExtra = inputSchema.additionalProperties !== false;

  for (const key of required) {
    if (!(key in args)) errors[key] = "필수 입력값이 빠졌습니다.";
  }
  for (const [key, value] of Object.entries(args)) {
    if (!(key in properties)) {
      if (!allowExtra) errors[key] = "이 Tool이 받지 않는 필드입니다.";
      continue;
    }
    if (!matchesSchema(properties[key], value)) {
      errors[key] = "이 필드의 값 형식이 맞지 않습니다.";
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, args };
}

export interface LocalToolRouteOptions {
  baseUrl: string;
  preferredModel: string;
  timeoutMs?: number;
  /** 테스트 전용 — 프로덕션 호출부는 절대 넘기지 않는다(실 fetch 사용). */
  fetchImpl?: typeof fetch;
}

/** 이번 턴 질문에 맞는 로컬 Tool을 최대 하나 제안한다(또는 아무것도
 * 제안하지 않는다). LLM 호출은 정확히 한 번, 절대 재시도하지 않는다. 절대
 * throw하지 않는다 — 모든 실패는 `status !== "ran"`인 결과로 돌아온다. */
export async function routeLocalToolCall(
  question: string,
  candidates: LocalToolRouteCandidate[],
  options: LocalToolRouteOptions,
): Promise<LocalToolRouteResult> {
  if (candidates.length === 0) {
    return { status: "no_candidates", toolId: null, toolName: null, args: null };
  }
  const candidateByName = new Map(candidates.map((c) => [c.toolName, c] as const));
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? LOCAL_TOOL_ROUTE_TIMEOUT_MS;
  const baseUrl = trimTrailingSlash(options.baseUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const tagsRes = await fetchImpl(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (!tagsRes.ok) return { status: "error_or_timeout", toolId: null, toolName: null, args: null };
    const tags = (await tagsRes.json()) as { models?: Array<{ name?: string }> };
    const models = Array.isArray(tags.models)
      ? tags.models.map((m) => m.name).filter((n): n is string => typeof n === "string" && n.length > 0)
      : [];
    const model = selectOllamaChatModel(models, options.preferredModel);
    if (!model) return { status: "error_or_timeout", toolId: null, toolName: null, args: null };

    const chatRes = await fetchImpl(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `질문: ${question}\n\n후보 Tool:\n${renderCandidateBlock(candidates)}\n\nJSON:`,
          },
        ],
      }),
    });
    if (!chatRes.ok) return { status: "error_or_timeout", toolId: null, toolName: null, args: null };
    const body = (await chatRes.json()) as { message?: { content?: string } };
    const raw = (body.message?.content ?? "").trim();
    const parsed = parseJsonObject(raw);
    if (parsed === null) return { status: "unparseable", toolId: null, toolName: null, args: null };

    const toolName = parsed.tool_name;
    if (toolName === null || toolName === undefined) {
      return { status: "declined_by_model", toolId: null, toolName: null, args: null };
    }
    if (typeof toolName !== "string" || !candidateByName.has(toolName)) {
      return { status: "unknown_tool_name", toolId: null, toolName: null, args: null };
    }
    const candidate = candidateByName.get(toolName)!;
    const rawInput = "input" in parsed ? parsed.input : {};
    const validated = validateLocalToolArgs(candidate.inputSchema, rawInput ?? {});
    if (!validated.ok) {
      return { status: "schema_invalid", toolId: candidate.id, toolName, args: null, schemaErrors: validated.errors };
    }
    return { status: "ran", toolId: candidate.id, toolName, args: validated.args };
  } catch {
    return { status: "error_or_timeout", toolId: null, toolName: null, args: null };
  } finally {
    clearTimeout(timer);
  }
}
