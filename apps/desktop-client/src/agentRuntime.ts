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
// Base URL is configurable (never hardcoded in components) via Vite's
// `VITE_AGENT_RUNTIME_BASE_URL` define, defaulting to the documented local
// port.
export const AGENT_RUNTIME_BASE_URL: string =
  (import.meta.env.VITE_AGENT_RUNTIME_BASE_URL as string | undefined) ?? "http://127.0.0.1:8100";

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

export interface StartRunParams {
  /** No Service Registry exists yet (D-034) — this is an opaque string the
   * Runtime hashes into a stable UUID for audit correlation, not a real
   * registered Service id. */
  serviceId: string;
  knowledgeId: string;
  question: string;
  traceId?: string;
  /** D-058/D-052: the normal D06 conversation always omits this (defaults
   * to "standard-agent" server-side) — only the "개발 확인용" MCP trigger
   * (ChatScreen.tsx) sets it, since there is no Service Registry to learn
   * which Service allows which Agent/Tool from. */
  agentProfile?: "standard-agent" | "standard-db-agent";
  mcpTool?: string;
  mcpToolInput?: Record<string, unknown>;
  mcpConfirmed?: boolean;
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
  };
  if (params.agentProfile) input.agent_profile = params.agentProfile;
  if (params.mcpTool) {
    input.mcp_tool = params.mcpTool;
    input.mcp_tool_input = params.mcpToolInput ?? {};
    input.mcp_confirmed = params.mcpConfirmed ?? false;
  }
  const res = await fetch(`${AGENT_RUNTIME_BASE_URL}/local/v1/runs`, {
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
  const res = await fetch(`${AGENT_RUNTIME_BASE_URL}/local/v1/runs/${runId}/confirm`, {
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
  const res = await fetch(`${AGENT_RUNTIME_BASE_URL}/local/v1/runs/${runId}`);
  if (!res.ok) {
    throw new Error(await parseErrorBody(res));
  }
  return (await res.json()) as RunResponse;
}

export async function cancelRun(runId: string): Promise<void> {
  // Best-effort by design (matches StepPreview.tsx): the UI reflects the
  // actual outcome once the run.cancelled SSE event arrives, not from this
  // response.
  await fetch(`${AGENT_RUNTIME_BASE_URL}/local/v1/runs/${runId}/cancel`, { method: "POST" }).catch(() => {});
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
  "knowledge.search.started",
  "knowledge.search.completed",
  "citation.added",
  "mcp.call.started",
  "mcp.call.completed",
  "mcp.confirmation_required",
  "mcp.confirmation_resolved",
  "mcp.confirmation_expired",
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
  const es = new EventSource(`${AGENT_RUNTIME_BASE_URL}/local/v1/runs/${runId}/events`);

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
