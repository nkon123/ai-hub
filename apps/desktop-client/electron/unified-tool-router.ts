// D-089 후속 "로컬 Tool 자동 라우팅과 MCP Tool 자동 제안 통합" — 실사용
// 피드백(2026-08-20 승인 설계, ChatScreen.tsx 상단 모듈 주석의 배경 참고).
//
// 왜 이 파일이 별도로 존재하는가: 기존 두 기능은 완전히 다른 실행 경로를
// 가진다 — 로컬 Tool은 `electron/local-tool-router.ts` + Desktop이 직접
// spawn(D-084/D-089), MCP Tool은 agent-runtime의 `tool_router.py`(D-083,
// 등록·승인·READ_ONLY 검증을 거친 자산만 다룸)다. 이 파일은 "이번 턴에
// 어느 쪽을 쓸지"만 하나로 합쳐 결정한다 — 실행 자체는 절대 합치지 않는다:
//   - 로컬을 고르면: 호출자가 이 결과의 `args`를 그대로 들고
//     `bridge.invokeLocalTool`을 호출한다(Main Process 네이티브 승인 그대로).
//   - MCP를 고르면: 호출자는 이 결과의 구체적 `toolName`을 서버에 강제로
//     넘기지 않는다 — 기존 `toolRoute: true` 그대로 agent-runtime에 넘겨
//     `tool_router.py`가 자신의 검증 체인으로 다시 고르게 한다(D-083 규칙:
//     명시적 mcpTool 요청이 최우선이므로, 여기서 고른 이름을 명시적 요청인
//     것처럼 보내면 그 규칙과 충돌한다). 이 파일이 고른 MCP Tool 이름은
//     오직 "이번 턴에 MCP를 시도할지" 판단과 표시용이다.
//
// 격리 경계(D-084 hard requirement 1과 동일한 정신) — 이 파일은 agent-runtime
// 이나 MCP 등록 모듈을 전혀 import하지 않는다. MCP 후보는 호출자
// (ChatScreen.tsx)가 이미 렌더러에서 계산해 둔 "연결된 MCP Tool 이름"
// 문자열 배열로만 받는다 — 실제 MCP 등록/연결 상태를 이 파일이 다시
// 조회하지 않는다. fs/electron/node import가 없는 순수 HTTP 모듈이라는
// 점도 `local-tool-router.ts`와 동일하다(렌더러가 상대경로로 직접 import해도
// 안전 — CLAUDE.md 코드 배치 규칙).
//
// D-089의 fail-closed 규율을 그대로 물려받는다: 타임아웃·파싱 실패·모르는
// 이름·로컬 Tool 스키마 거절 4종은 전부 "이번 턴은 아무 Tool도 실행하지
// 않음"(status가 "ran_local"/"ran_mcp"가 아님)으로 귀결된다. 검증 실패를
// 모델에게 재시도시키지 않는다(LLM 호출은 정확히 한 번). 라우팅 프롬프트는
// 이번 턴 질문과 후보 이름+(로컬만) 입력 Schema만 본다 — 대화 History,
// Citation, 이전 Tool 결과는 절대 넣지 않는다.
import { selectOllamaChatModel } from "./ollama-chat";
import { parseJsonObject, validateLocalToolArgs, type LocalToolRouteCandidate } from "./local-tool-router";

export type UnifiedToolCandidate =
  | { kind: "local"; id: string; toolName: string; functionName: string; inputSchema: Record<string, unknown> }
  | { kind: "mcp"; toolName: string };

export type UnifiedToolRouteStatus =
  | "no_candidates"
  | "declined_by_model"
  | "unparseable"
  | "unknown_tool_name"
  | "error_or_timeout"
  | "schema_invalid"
  | "ran_local"
  | "ran_mcp";

export interface UnifiedToolRouteResult {
  status: UnifiedToolRouteStatus;
  /** `status`가 `ran_local`/`ran_mcp`/`schema_invalid`일 때만 채워진다. */
  kind: "local" | "mcp" | null;
  /** 로컬 Tool일 때만(`local-tool-store.ts`의 레코드 id) — MCP는 항상 `null`
   * (실제 실행 대상은 서버가 다시 고른다, 위 모듈 설명 참고). */
  toolId: string | null;
  toolName: string | null;
  /** 로컬 Tool이 실행 가능한 상태로 검증됐을 때만 채워진다 — MCP는 항상
   * `null`(입력을 이 파일이 만들지 않는다). */
  args: Record<string, unknown> | null;
  /** `status === "schema_invalid"`일 때만 채워진다. */
  schemaErrors?: Record<string, string>;
}

/** 라우팅 호출 자체의 타임아웃(로컬/MCP 실제 실행 타임아웃과는 별개). */
export const UNIFIED_TOOL_ROUTE_TIMEOUT_MS = 20_000;

function candidateName(c: UnifiedToolCandidate): string {
  return c.toolName;
}

/** 로컬 Tool 목록 + 연결된 MCP Tool 이름 목록을 하나의 후보 목록으로
 * 합친다. 이름 자체가 겹치더라도 이 함수는 그대로 둔다 — 실제 충돌 처리는
 * `resolveUnifiedPick`이 "MCP 우선"으로 코드에서 강제한다. */
export function buildUnifiedToolCandidates(
  localTools: LocalToolRouteCandidate[],
  mcpToolNames: string[],
): UnifiedToolCandidate[] {
  return [
    ...localTools.map((t) => ({
      kind: "local" as const,
      id: t.id,
      toolName: t.toolName,
      functionName: t.functionName,
      inputSchema: t.inputSchema,
    })),
    ...mcpToolNames.map((name) => ({ kind: "mcp" as const, toolName: name })),
  ];
}

/** 등록된 로컬 Tool도, 연결된 MCP Tool도 하나도 없으면 통합 토글 자체를
 * 그리지 말아야 한다(Task Brief E) — 그 판정을 화면 코드 밖으로 뺀 순수
 * 함수. */
export function hasAnyUnifiedCandidates(localToolCount: number, mcpToolNameCount: number): boolean {
  return localToolCount > 0 || mcpToolNameCount > 0;
}

/** 모델이 낸 `pick`(예: "local:foo", "mcp:bar", 접두어 없는 "foo", 또는
 * `null`)을 실제 후보 목록과 대조해 안전하게 해석한다.
 *
 * MCP 우선 tie-break을 여기서 코드로 강제한다(Task Brief C) — 프롬프트가
 * "겹치면 MCP를 고르라"고 안내하지만(아래 시스템 프롬프트), 모델이 그
 * 지시를 어기고 접두어를 잘못 붙이거나 접두어 없이 이름만 냈을 때를 대비해,
 * 이름이 일치하는 MCP 후보가 하나라도 있으면 그 이름을 로컬로 붙였든
 * 접두어가 없든 관계없이 **항상** MCP 후보를 우선 반환한다. 로컬 후보가
 * 필요한 경우는 이름이 일치하는 MCP 후보가 전혀 없을 때뿐이다. */
export function resolveUnifiedPick(
  rawPick: string | null,
  candidates: UnifiedToolCandidate[],
): { kind: "local" | "mcp"; candidate: UnifiedToolCandidate } | null {
  if (!rawPick) return null;
  const idx = rawPick.indexOf(":");
  const name = idx === -1 ? rawPick : rawPick.slice(idx + 1);

  const mcpMatch = candidates.find((c) => c.kind === "mcp" && candidateName(c) === name);
  if (mcpMatch) return { kind: "mcp", candidate: mcpMatch };

  const localMatch = candidates.find((c) => c.kind === "local" && candidateName(c) === name);
  if (localMatch) return { kind: "local", candidate: localMatch };

  return null;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function renderCandidateBlock(candidates: UnifiedToolCandidate[]): string {
  return candidates
    .map((c) =>
      c.kind === "local"
        ? `- pick: local:${c.toolName}\n  종류: 이 PC의 검토되지 않은 로컬 코드\n  입력 스키마: ${JSON.stringify(c.inputSchema)}`
        : `- pick: mcp:${c.toolName}\n  종류: 사내에 등록·승인된 Tool(실제로 어떤 세부 동작·인자를 쓸지는 별도 시스템이 다시 정하므로 input을 만들 필요 없음)`,
    )
    .join("\n");
}

const SYSTEM_PROMPT =
  "당신은 이번 질문에 Tool 호출이 필요한지 고르는 통합 라우터입니다. 아래 후보 목록에는 두 " +
  "종류가 섞여 있습니다: 사내에 등록·승인된 Tool(pick이 'mcp:'로 시작)과 이 PC의 검토되지 " +
  "않은 로컬 코드(pick이 'local:'로 시작). 이번 질문에 답하기 위해 지금 호출해야 할 후보를 " +
  "정확히 하나 고르거나, 필요 없다면 아무 것도 고르지 마세요.\n" +
  "규칙:\n" +
  "- 반드시 JSON 객체 하나만 출력하세요. 다른 설명이나 코드 블록 표시를 덧붙이지 마세요.\n" +
  "- 로컬 코드와 사내 등록 Tool 둘 다 이 질문에 맞아 보이면 반드시 사내 등록 Tool(mcp:)을 " +
  "고르세요 — 로컬 코드는 검토되지 않았습니다.\n" +
  "- Tool 호출이 필요한지 확신할 수 없으면 호출하지 마세요(과다 호출보다 누락이 안전합니다) " +
  "— 이 경우 pick을 null로 출력하세요.\n" +
  "- 'local:'로 시작하는 후보를 고른다면 input은 그 후보의 입력 스키마를 만족하는 값이어야 " +
  "합니다. 확실하지 않은 값은 만들어내지 말고 pick을 null로 출력하세요.\n" +
  "- 'mcp:'로 시작하는 후보를 고른다면 input은 항상 null로 두세요(실제 인자는 별도 시스템이 " +
  "다시 만듭니다).\n" +
  '- 출력 형식: {"pick": "local:..." 또는 "mcp:..." 또는 null, "input": {...} 또는 null}';

export interface UnifiedToolRouteOptions {
  baseUrl: string;
  preferredModel: string;
  timeoutMs?: number;
  /** 테스트 전용 — 프로덕션 호출부는 절대 넘기지 않는다(실 fetch 사용). */
  fetchImpl?: typeof fetch;
}

/** 이번 턴 질문에 맞는 Tool(로컬 또는 MCP)을 최대 하나 고른다(또는 아무것도
 * 고르지 않는다). LLM 호출은 정확히 한 번, 절대 재시도하지 않는다. 절대
 * throw하지 않는다 — 모든 실패는 `status !== "ran_local" && status !==
 * "ran_mcp"`인 결과로 돌아온다. */
export async function routeUnifiedToolCall(
  question: string,
  candidates: UnifiedToolCandidate[],
  options: UnifiedToolRouteOptions,
): Promise<UnifiedToolRouteResult> {
  if (candidates.length === 0) {
    return { status: "no_candidates", kind: null, toolId: null, toolName: null, args: null };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? UNIFIED_TOOL_ROUTE_TIMEOUT_MS;
  const baseUrl = trimTrailingSlash(options.baseUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const tagsRes = await fetchImpl(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (!tagsRes.ok) return { status: "error_or_timeout", kind: null, toolId: null, toolName: null, args: null };
    const tags = (await tagsRes.json()) as { models?: Array<{ name?: string }> };
    const models = Array.isArray(tags.models)
      ? tags.models.map((m) => m.name).filter((n): n is string => typeof n === "string" && n.length > 0)
      : [];
    const model = selectOllamaChatModel(models, options.preferredModel);
    if (!model) return { status: "error_or_timeout", kind: null, toolId: null, toolName: null, args: null };

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
            content: `질문: ${question}\n\n후보:\n${renderCandidateBlock(candidates)}\n\nJSON:`,
          },
        ],
      }),
    });
    if (!chatRes.ok) return { status: "error_or_timeout", kind: null, toolId: null, toolName: null, args: null };
    const body = (await chatRes.json()) as { message?: { content?: string } };
    const raw = (body.message?.content ?? "").trim();
    const parsed = parseJsonObject(raw);
    if (parsed === null) return { status: "unparseable", kind: null, toolId: null, toolName: null, args: null };

    const rawPick = parsed.pick;
    if (rawPick === null || rawPick === undefined) {
      return { status: "declined_by_model", kind: null, toolId: null, toolName: null, args: null };
    }
    if (typeof rawPick !== "string") {
      return { status: "unknown_tool_name", kind: null, toolId: null, toolName: null, args: null };
    }
    const resolved = resolveUnifiedPick(rawPick, candidates);
    if (!resolved) {
      return { status: "unknown_tool_name", kind: null, toolId: null, toolName: null, args: null };
    }

    if (resolved.kind === "mcp") {
      // 실제 어떤 MCP Tool·인자를 쓸지는 이 파일이 정하지 않는다(위 모듈
      // 설명) — 이름은 표시/판단용으로만 돌려준다.
      return { status: "ran_mcp", kind: "mcp", toolId: null, toolName: resolved.candidate.toolName, args: null };
    }

    // resolved.kind === "local"
    const local = resolved.candidate as Extract<UnifiedToolCandidate, { kind: "local" }>;
    const rawInput = "input" in parsed ? parsed.input : {};
    const validated = validateLocalToolArgs(local.inputSchema, rawInput ?? {});
    if (!validated.ok) {
      return {
        status: "schema_invalid",
        kind: "local",
        toolId: local.id,
        toolName: local.toolName,
        args: null,
        schemaErrors: validated.errors,
      };
    }
    return { status: "ran_local", kind: "local", toolId: local.id, toolName: local.toolName, args: validated.args };
  } catch {
    return { status: "error_or_timeout", kind: null, toolId: null, toolName: null, args: null };
  } finally {
    clearTimeout(timer);
  }
}
