// D14 — Main-process-safe agent-runtime client for scheduled (non-local-tool)
// recipes.
//
// `src/agentRuntime.ts`'s `startRun`/`openRunEventStream` are renderer-only:
// `openRunEventStream` uses `EventSource`, a browser API unavailable in the
// Electron Main process. This module mirrors the exact same
// `POST /local/v1/runs` wire contract that `startRun` builds (see that
// module's docstring for field meaning) using Node's global `fetch`
// (Node 18+/Electron), then POLLS `GET /local/v1/runs/{id}` to a terminal
// status instead of subscribing to SSE — a scheduled run has no UI to stream
// incremental stages to, so polling for the terminal state is sufficient and
// far simpler than hand-parsing SSE frames in Main.
//
// Base URL: NEVER hardcoded here — always passed in by the caller
// (`main.ts`'s `agentRuntimeBaseUrl()`, the single source of truth this
// app's CLAUDE.md's "연결 판정 오탐" section requires every new address-
// reading code path to use).
//
// Kept in its own Main-only file (not `schedule-time.ts`, which has zero fs/
// node imports and must stay that way for the renderer to import it
// directly) per this module's code-placement rule: Main-only network logic
// never goes in a "pure function" file.
import type { ScheduleRecipe } from "./types";

const POLL_INTERVAL_MS = 1_500;
const MAX_POLL_MS = 120_000;

const TERMINAL_SUCCESS = new Set(["SUCCEEDED", "INSUFFICIENT_EVIDENCE"]);
const TERMINAL_FAILURE = new Set(["FAILED"]);
const TERMINAL_CANCELLED = new Set(["CANCELLED"]);

export interface ScheduledAgentRunResult {
  ok: boolean;
  answer: string | null;
  citationCount: number;
  errorMessage: string | null;
  runId: string | null;
}

interface StartRunResponseShape {
  id: string;
}

interface PollRunResponseShape {
  status: string;
  output?: { answer?: string; citations?: unknown[] } | null;
  error?: { message?: string } | null;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Reconstructs exactly what `ChatScreen.tsx`'s `handleSend` would send to
 * `startRun` for this recipe, restricted to the non-`ollamaOnly`,
 * non-`localToolRouteActive` cases (the caller — `schedule-scheduler.ts` —
 * routes `localToolRouteActive` recipes through `local-tool-router.ts` +
 * `invokeLocalToolForScheduledRun` instead and never reaches this
 * function for those). `allow_hub_lookup` is always `false`: there is no
 * per-run human consent to read for an unattended scheduled run, and the
 * D-078 invariant fails closed rather than guessing a stale/default value. */
export async function runScheduledRecipeAgainstAgentRuntime(
  baseUrl: string,
  recipe: ScheduleRecipe,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; pollIntervalMs?: number; maxPollMs?: number } = {},
): Promise<ScheduledAgentRunResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = trimTrailingSlash(baseUrl);
  const ollamaOnly = !recipe.knowledgeLookupActive && !recipe.localAgentId;
  const serviceId = ollamaOnly
    ? "desktop-schedule:ollama-default"
    : `desktop-schedule:${recipe.knowledgeIds[0] ?? recipe.localAgentId ?? "schedule"}`;

  const input: Record<string, unknown> = {
    knowledge_id: recipe.knowledgeIds[0] ?? "",
    knowledge_ids: recipe.knowledgeLookupActive ? recipe.knowledgeIds : [],
    question: recipe.question,
    allow_hub_lookup: false,
  };
  if (recipe.localAgentId) {
    input.local_agent_id = recipe.localAgentId;
  }

  let startRes: Response;
  try {
    startRes = await fetchImpl(`${base}/local/v1/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service_id: serviceId, input }),
      signal: options.signal,
    });
  } catch (err) {
    return {
      ok: false,
      answer: null,
      citationCount: 0,
      errorMessage: `Local Agent Runtime에 연결하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`,
      runId: null,
    };
  }
  if (!startRes.ok) {
    return {
      ok: false,
      answer: null,
      citationCount: 0,
      errorMessage: `실행 요청이 거부되었습니다 (HTTP ${startRes.status}).`,
      runId: null,
    };
  }
  const created = (await startRes.json()) as StartRunResponseShape;

  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const maxPollMs = options.maxPollMs ?? MAX_POLL_MS;
  const deadline = Date.now() + maxPollMs;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      return { ok: false, answer: null, citationCount: 0, errorMessage: "실행이 중단되었습니다.", runId: created.id };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    if (options.signal?.aborted) {
      return { ok: false, answer: null, citationCount: 0, errorMessage: "실행이 중단되었습니다.", runId: created.id };
    }

    let pollRes: Response;
    try {
      pollRes = await fetchImpl(`${base}/local/v1/runs/${created.id}`, { signal: options.signal });
    } catch {
      if (options.signal?.aborted) {
        return { ok: false, answer: null, citationCount: 0, errorMessage: "실행이 중단되었습니다.", runId: created.id };
      }
      continue; // transient network hiccup — keep polling until the deadline
    }
    if (!pollRes.ok) continue;
    const run = (await pollRes.json()) as PollRunResponseShape;

    if (TERMINAL_SUCCESS.has(run.status)) {
      return {
        ok: true,
        answer: run.output?.answer ?? null,
        citationCount: Array.isArray(run.output?.citations) ? run.output!.citations!.length : 0,
        errorMessage: null,
        runId: created.id,
      };
    }
    if (TERMINAL_FAILURE.has(run.status)) {
      return {
        ok: false,
        answer: null,
        citationCount: 0,
        errorMessage: run.error?.message ?? "실행이 실패했습니다.",
        runId: created.id,
      };
    }
    if (TERMINAL_CANCELLED.has(run.status)) {
      return { ok: false, answer: null, citationCount: 0, errorMessage: "실행이 취소되었습니다.", runId: created.id };
    }
    // RUNNING / WAITING_FOR_USER 등은 계속 폴링한다. 스케줄 실행에는 확인
    // 대화상자에 답할 사람이 없으므로 WAITING_FOR_USER는 그대로 두면
    // MAX_POLL_MS에서 타임아웃으로 귀결된다(아래) — 추측으로 승인/거부하지
    // 않는다.
  }
  // 실사용 제보(2026-08-19) — 어느 상한을 넘겼는지와 그 값을 사람이 읽는
  // 단위로 함께 알린다(원시 ms를 찍지 않는다).
  return {
    ok: false,
    answer: null,
    citationCount: 0,
    errorMessage: `이 스케줄에 설정된 실행 시간 상한(${describeMaxPollTimeoutMinutes(maxPollMs)})을 넘겨 중단되었습니다.`,
    runId: created.id,
  };
}

/** ms를 분 단위 문구로 바꾼다 — 실시간 폴링 루프를 기다리지 않고도
 * 단위 테스트할 수 있도록 순수 함수로 분리한다. */
export function describeMaxPollTimeoutMinutes(maxPollMs: number): string {
  return `${Math.round(maxPollMs / 60_000)}분`;
}
