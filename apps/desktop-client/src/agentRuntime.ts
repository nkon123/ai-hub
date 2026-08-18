// D06/D07 — Local Agent Runtime(services/agent-runtime, M05) HTTP/SSE client.
//
// This talks to agent-runtime directly over `fetch`/`EventSource` from the
// renderer, NOT through the `window.desktop` IPC bridge: agent-runtime is a
// separate loopback HTTP service (`electron/connections.ts` already
// health-checks it independently of the Electron shell), so there is nothing
// for the main process to broker here — exactly the same shape
// `apps/portal-web/app/chatbots/new/_components/StepPreview.tsx` uses against
// the same API. Because this module has zero Electron-specific imports, it
// works identically inside the Electron renderer and in a plain browser tab
// against the Vite dev server — which is how this screen has to be verified
// on a machine where Electron itself cannot be launched (see
// open-decisions.md D-058).
//
// `KnowledgeCandidate`(agentic Knowledge selection, KNOWLEDGE_ROUTE stage —
// `packages/schemas/api/local-runtime-api.yaml`'s `KnowledgeCandidateInput`,
// `services/agent-runtime/src/agent_runtime/knowledge_router.py`) is declared
// once in `electron/types.ts` (interface-only, zero runtime cost — see that
// file's own header) and reused here rather than duplicated, since this is
// the exact wire shape both places send/consume byte-for-byte.
import type { KnowledgeCandidate } from "../electron/types";

// Base URL resolution, in priority order:
//   1. the value the user saved in Settings (D10 `agentRuntimeBaseUrl`),
//      applied at runtime through `setAgentRuntimeBaseUrl` below;
//   2. Vite's `VITE_AGENT_RUNTIME_BASE_URL` define (browser-only dev mode,
//      where there is no settings store to read);
//   3. the documented local port.
//
// Why this is not a plain `const` any more (D-080 후속): it used to be one,
// and the result was a screen that talked to one address while its own
// connection banner checked another — `apps/desktop-client/CLAUDE.md`
// recorded it as "연결 판정 오탐(미해결)": 대화는 멀쩡히 되는데 채팅 화면에
// 빨간 "연결 끊김"이 떴다. Anything reading the address must therefore read
// the *same* resolved value, which means one place owns it.
export const DEFAULT_AGENT_RUNTIME_BASE_URL: string =
  (import.meta.env.VITE_AGENT_RUNTIME_BASE_URL as string | undefined) ?? "http://127.0.0.1:8100";

let resolvedAgentRuntimeBaseUrl: string = DEFAULT_AGENT_RUNTIME_BASE_URL;

/** The address every call in this module actually uses. Read it (never the
 * default constant) anywhere the current endpoint matters — connection
 * checks, diagnostics, error messages. */
export function getAgentRuntimeBaseUrl(): string {
  return resolvedAgentRuntimeBaseUrl;
}

/** Applies the saved setting. A blank/absent value falls back to the default
 * rather than producing requests to `undefined/...` — Desktop은 Runtime 장애
 * 시 종료되지 않고 복구 안내를 제공한다, and a settings store that cannot be
 * read (browser-only mode) must not break the chat screen. Validation is not
 * repeated here: `network-policy.ts::validateAgentRuntimeBaseUrl` in the main
 * process is what refuses a non-loopback address, and duplicating the rule in
 * the renderer would create a second place for it to drift. */
export function setAgentRuntimeBaseUrl(url: string | null | undefined): string {
  resolvedAgentRuntimeBaseUrl = url?.trim() || DEFAULT_AGENT_RUNTIME_BASE_URL;
  return resolvedAgentRuntimeBaseUrl;
}

/** Wire shape returned by search-runtime / echoed by agent-runtime's
 * `citation.added` event and `run.completed.output.citations`
 * (services/search-runtime/src/search_runtime/hybrid.py `_build_citations`). */
export interface Citation {
  chunk_id: string;
  parent_chunk_id: string | null;
  document_path: string;
  document_title: string;
  page: number;
  section: string;
  excerpt: string;
  parent_context: string;
  score: number;
  /** Cosine similarity (D-046), or null for a BM25-only match when
   * relevance filtering is disabled. */
  similarity: number | null;
  /** Two-stage retrieval (지식 검색 자동화 + 허브 조회 동의) — which trust
   * boundary this citation's Knowledge search ran against. Optional/absent
   * means "local": every citation before this field existed (and any
   * replayed/old data) has no `source` at all, and Stage 1 (local) is always
   * the default/majority case agent-runtime will keep sending regardless. */
  source?: "local" | "hub";
}

export interface RunErrorPayload {
  code: string;
  message: string;
  trace_id?: string;
}

/** Present only while `status === "WAITING_FOR_USER"` (02-desktop-and-
 * agent-runtime.md §5.3, D-052 후속) — a safe, human-readable summary of the
 * MCP Tool call awaiting approval. Never the raw tool input/result. */
export interface PendingConfirmation {
  tool_name: string;
  summary: string;
  deadline: string;
}

/** `GET /local/v1/runs/{id}` response shape (routers/runs.py `RunResponse`). */
export interface RunResponse {
  id: string;
  status: string;
  trace_id: string;
  created_at: string;
  output?: { answer?: string; citations?: Citation[] } | null;
  error?: RunErrorPayload | null;
  completed_at?: string | null;
  pending_confirmation?: PendingConfirmation | null;
}

/** Wire shape for `input.history` (local-runtime-api.yaml
 * `ConversationTurnInput`) — Desktop 대화 고도화. Both fields are the same
 * trust boundary `question` itself already is; agent-runtime bounds growth
 * server-side (`AgentRuntimeSettings.max_history_turns`/`max_history_chars`)
 * regardless of how many turns this client sends. */
export interface ConversationTurnInput {
  question: string;
  answer: string;
}

export interface StartRunParams {
  /** No Service Registry exists yet (D-034) — this is an opaque string the
   * Runtime hashes into a stable UUID for audit correlation, not a real
   * registered Service id. */
  serviceId: string;
  /** Backward-compat single id, kept alongside `knowledgeIds` — set to the
   * first id in `knowledgeIds` (or `""` if none). agent-runtime's existing
   * input-validation gate and `run.started` event still read this field; it
   * is not otherwise meaningful once `knowledgeIds` is populated (지식 검색
   * 자동화). */
  knowledgeId: string;
  /** Every installed Knowledge asset's AssetVersion id Stage 1 (local)
   * search should run against — replaces the old single manual pick, and
   * (D-079 이어 붙이기) only ever includes Knowledge search-runtime has
   * actually registered as searchable. See `chatTypes.ts`'s
   * `resolveActivatedKnowledgeIds`. Ignored (never sent) when
   * `knowledgeCandidates` is non-empty — see that field's docstring. */
  knowledgeIds: string[];
  /** Agentic Knowledge selection (KNOWLEDGE_ROUTE stage, additive/optional).
   * When non-empty, this REPLACES `knowledgeIds` in the request entirely —
   * `startRun` sends `knowledge_candidates`, never `knowledge_ids`, in that
   * case (the two are mutually exclusive on the wire, per
   * `local-runtime-api.yaml`'s `StartRunRequest.input` docstring). Each
   * candidate carries only metadata (id/name/description/tags/
   * classification) — never document text — agent-runtime's own optional
   * LLM call picks the subset worth searching. Omitting/emptying this
   * reproduces the exact prior `knowledgeIds` fan-out behavior. */
  knowledgeCandidates?: KnowledgeCandidate[];
  question: string;
  traceId?: string;
  /** Per-session consent (default `false`, never persisted) for Stage 2 hub
   * lookup — only takes effect when Stage 1 local search finds nothing. Must
   * never be inferred from anything other than the user's own toggle. */
  allowHubLookup: boolean;
  /** D-058/D-052: the normal D06 conversation always omits this (defaults
   * to "standard-agent" server-side) — only the "개발 확인용" MCP trigger
   * (ChatScreen.tsx) sets it, since there is no Service Registry to learn
   * which Service allows which Agent/Tool from. */
  agentProfile?: "standard-agent" | "standard-db-agent";
  /** D-034 해석 경로 4 — Desktop이 등록해 둔 로컬 Agent Package의 핸들
   * (`agent_asset_id`). 채워지면 서버는 이것을 `agent_profile`보다 먼저
   * 확인해 이 값으로만 Agent를 해석한다(`routers/runs.py`의 `elif` 분기 —
   * `agent_profile`은 이 값이 있으면 아예 읽히지 않는다) — 그래서
   * `startRun`은 이 값이 있을 때 `agent_profile`을 함께 보내지 않는다(혼동
   * 방지, 서버가 실제로 무시하는 필드를 보내지 않는다). 기본은 항상
   * `undefined`(표준 Agent) — 사용자가 명시적으로 등록된 Local Agent를
   * 고를 때만 채워진다(D06 기본 동작 불변, Task Brief 제약 D). */
  localAgentId?: string;
  mcpTool?: string;
  mcpToolInput?: Record<string, unknown>;
  mcpConfirmed?: boolean;
  /** D-083 TOOL_ROUTE opt-in (`input.tool_route`, `local-runtime-api.yaml`
   * `StartRunRequest.input`) — default-off, per-run consent for agent-runtime
   * to make ONE optional LLM call that proposes an MCP Tool name + arguments
   * from the question text, instead of never calling MCP Tools at all (the
   * prior behavior of every caller in this repo). Only takes effect
   * server-side when no explicit `mcpTool` is also supplied (that path always
   * wins — see `agent_runtime.workflow`'s `run_knowledge_chat` docstring) and
   * the resolved agent's `capabilities.mcp_allowed` is true (`standard-agent`
   * has it false; `standard-db-agent` has it true — so a caller wanting this
   * to actually route anything must also pass
   * `agentProfile: "standard-db-agent"`). Every proposal still goes through
   * the unchanged confirmation/validation chokepoint — this flag never
   * bypasses approval. Omitting it reproduces the exact prior
   * no-tool-routing behavior. */
  toolRoute?: boolean;
  /** Desktop 대화 고도화 (additive/optional) — prior turns of this same
   * conversation, oldest first. Omitting it (every call site that predates
   * this feature) reproduces the exact prior single-turn request body. */
  history?: ConversationTurnInput[];
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = await res.json();
    // FastAPI's HTTPException(detail={"code":..., "message":...}) shape
    // (confirm_run's 409) alongside the plain-string detail shape (most
    // other endpoints' 404s) — both must resolve to a readable message, not
    // "[object Object]".
    const detailMessage =
      typeof body?.detail === "string" ? body.detail : body?.detail?.message;
    return body?.error?.message ?? detailMessage ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function startRun(params: StartRunParams): Promise<RunResponse> {
  const input: Record<string, unknown> = {
    knowledge_id: params.knowledgeId,
    question: params.question,
    // 로컬에서 조회하는 데이터를 허브에 넘기면 안 된다 — default-off consent,
    // always sent explicitly (never inferred server-side).
    allow_hub_lookup: params.allowHubLookup,
  };
  // KNOWLEDGE_ROUTE(agentic Knowledge 선택) — 후보를 보낼 때는 knowledge_ids를
  // 절대 함께 보내지 않는다(local-runtime-api.yaml: 후보가 있으면 서버가 id
  // 선택을 통째로 넘겨받는다). 후보가 없으면(브릿지 없음/manifest 조립 실패
  // 등) 기존 fan-out 동작을 그대로 재현한다.
  if (params.knowledgeCandidates && params.knowledgeCandidates.length > 0) {
    input.knowledge_candidates = params.knowledgeCandidates;
  } else {
    input.knowledge_ids = params.knowledgeIds;
  }
  // D-034 해석 경로 4 — local_agent_id가 있으면 서버는 agent_profile을 아예
  // 읽지 않는다(routers/runs.py의 elif 분기) — 함께 보내면 실제로 적용되지
  // 않는 필드를 보내는 것이므로 아예 생략한다.
  if (params.localAgentId) {
    input.local_agent_id = params.localAgentId;
  } else if (params.agentProfile) {
    input.agent_profile = params.agentProfile;
  }
  if (params.mcpTool) {
    input.mcp_tool = params.mcpTool;
    input.mcp_tool_input = params.mcpToolInput ?? {};
    input.mcp_confirmed = params.mcpConfirmed ?? false;
  }
  // D-083 — only ever sent when the caller explicitly opted in this run.
  // Never sent alongside `mcpTool` in practice (the caller decides which of
  // the two consent shapes applies to a given turn), but this function does
  // not itself enforce mutual exclusivity — that judgment belongs to the
  // caller (ChatScreen.tsx's `toolRouteActive`), same division of
  // responsibility as `knowledgeCandidates` vs `knowledgeIds` above.
  if (params.toolRoute) {
    input.tool_route = true;
  }
  if (params.history && params.history.length > 0) {
    input.history = params.history;
  }
  const res = await fetch(`${getAgentRuntimeBaseUrl()}/local/v1/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: params.serviceId,
      input,
      trace_id: params.traceId,
    }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorBody(res));
  }
  return (await res.json()) as RunResponse;
}

/** `POST /local/v1/runs/{id}/confirm` — resolves a Run parked in
 * WAITING_FOR_USER with an explicit approve/deny decision (D-052 후속).
 * Throws on 404 (unknown Run) or 409 (Run is not currently
 * WAITING_FOR_USER — already resolved/expired/terminal); the caller decides
 * how to surface that (D06 shows it as an error banner, since by the time a
 * user clicks 승인/거부 the panel should already be gone if the Run moved
 * on — this is a genuine race, not expected steady-state). */
export async function confirmRun(
  runId: string,
  decision: "approve" | "deny",
): Promise<RunResponse> {
  const res = await fetch(`${getAgentRuntimeBaseUrl()}/local/v1/runs/${runId}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) {
    throw new Error(await parseErrorBody(res));
  }
  return (await res.json()) as RunResponse;
}

export async function getRun(runId: string): Promise<RunResponse> {
  const res = await fetch(`${getAgentRuntimeBaseUrl()}/local/v1/runs/${runId}`);
  if (!res.ok) {
    throw new Error(await parseErrorBody(res));
  }
  return (await res.json()) as RunResponse;
}

export async function cancelRun(runId: string): Promise<void> {
  // Best-effort by design (matches StepPreview.tsx): the UI reflects the
  // actual outcome once the run.cancelled SSE event arrives, not from this
  // response.
  await fetch(`${getAgentRuntimeBaseUrl()}/local/v1/runs/${runId}/cancel`, { method: "POST" }).catch(() => {});
}

/** One SSE frame, timestamped at the moment this client received it.
 * agent-runtime does not stamp per-event server timestamps (only
 * `RunResponse.created_at`/`completed_at` are authoritative) — `receivedAt`
 * is a client-observed wall-clock value, used for D07's step timeline, and
 * must always be presented as such (never implied to be server-measured). */
export interface RunEventLogItem {
  id: string;
  event: string;
  data: unknown;
  receivedAt: string;
}

const KNOWN_EVENT_NAMES = [
  "run.started",
  "preflight.completed",
  // KNOWLEDGE_ROUTE(agentic Knowledge 선택) — 후보를 보냈을 때만 실제로
  // 발생한다(agent_runtime.knowledge_router). status는 "ran"(LLM이 실제로
  // 골랐다)/"skipped"(후보가 threshold 이하라 LLM을 부르지 않았다)/
  // "fallback"(LLM 호출은 됐지만 신뢰할 수 없어 전체를 검색했다) 중 하나 —
  // chatTypes.ts의 describeKnowledgeRoute가 세 경우를 구분해 보여준다.
  "knowledge.route.selected",
  "knowledge.search.started",
  "knowledge.search.completed",
  "knowledge.query_rewritten",
  "citation.added",
  // 두 단계 검색(지식 검색 자동화 + 허브 조회 동의) — Stage 2가 실제로 허브에
  // 무엇을 보냈는지(사후 가시성)와 그 검색이 끝났는지를 알리는 이벤트.
  "hub.query_sent",
  "hub.search.completed",
  "mcp.call.started",
  "mcp.call.completed",
  "mcp.confirmation_required",
  "mcp.confirmation_resolved",
  "mcp.confirmation_expired",
  // D-083 TOOL_ROUTE — only actually emitted when this turn sent
  // `tool_route: true` (see `StartRunParams.toolRoute`'s docstring) AND the
  // resolved agent allows MCP. "selected" carries the routing decision
  // (ran/skipped/no_tool + which tool, if any); "rejected" is the rarer
  // preflight-refusal case where a "ran" proposal failed schema validation
  // and was dropped rather than dispatched (chatTypes.ts's
  // `describeToolRouteSelected`/`describeToolRouteRejected` render the two
  // distinctly — see that module for why "nothing happened" and "something
  // was proposed and blocked" must never look the same).
  "mcp.tool_route.selected",
  "mcp.tool_route.rejected",
  "answer.delta",
  "run.completed",
  "run.failed",
  "run.cancelled",
];

/** Opens `GET /local/v1/runs/{id}/events` (SSE) and invokes `onEvent` for
 * every named frame in arrival order. `GET` means a plain `EventSource` can
 * be used here (unlike the Hosted Chat POST-SSE endpoint, which needs manual
 * `fetch` + `ReadableStream` parsing — see `chat/[slug]/page.tsx`).
 * Returns a teardown function; always call it when the caller no longer
 * cares about this run's stream (component unmount, run superseded). */
export function openRunEventStream(
  runId: string,
  onEvent: (item: RunEventLogItem) => void,
  onConnectionError: () => void,
): () => void {
  const es = new EventSource(`${getAgentRuntimeBaseUrl()}/local/v1/runs/${runId}/events`);

  for (const name of KNOWN_EVENT_NAMES) {
    es.addEventListener(name, (evt) => {
      const messageEvent = evt as MessageEvent<string>;
      let data: unknown = null;
      try {
        data = JSON.parse(messageEvent.data);
      } catch {
        data = null;
      }
      onEvent({
        id: messageEvent.lastEventId,
        event: name,
        data,
        receivedAt: new Date().toISOString(),
      });
    });
  }

  es.onerror = () => {
    onConnectionError();
  };

  return () => es.close();
}
