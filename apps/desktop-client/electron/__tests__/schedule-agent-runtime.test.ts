import { describe, expect, it, vi } from "vitest";
import { describeMaxPollTimeoutMinutes, runScheduledRecipeAgainstAgentRuntime } from "../schedule-agent-runtime";
import type { ScheduleRecipe } from "../types";

function recipe(overrides: Partial<ScheduleRecipe> = {}): ScheduleRecipe {
  return {
    question: "질문",
    knowledgeLookupActive: false,
    knowledgeIds: [],
    localToolRouteActive: false,
    localAgentId: null,
    chatModelAlias: "default-chat",
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("runScheduledRecipeAgainstAgentRuntime", () => {
  it("polls until SUCCEEDED and returns the answer", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "run-1" })) // POST start
      .mockResolvedValueOnce(jsonResponse({ status: "RUNNING" })) // poll 1
      .mockResolvedValueOnce(jsonResponse({ status: "SUCCEEDED", output: { answer: "답변입니다", citations: [1, 2] } }));

    const result = await runScheduledRecipeAgainstAgentRuntime("http://127.0.0.1:8100", recipe(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 5,
    });
    expect(result.ok).toBe(true);
    expect(result.answer).toBe("답변입니다");
    expect(result.citationCount).toBe(2);
  }, 10_000);

  it("reports failure when the run terminates FAILED", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "run-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "FAILED", error: { message: "무언가 잘못됨" } }));

    const result = await runScheduledRecipeAgainstAgentRuntime("http://127.0.0.1:8100", recipe(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe("무언가 잘못됨");
  }, 10_000);

  it("reports a connection failure honestly when the initial POST throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const result = await runScheduledRecipeAgainstAgentRuntime("http://127.0.0.1:8100", recipe(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("연결하지 못했습니다");
  });

  it("reports rejection honestly when the start request is refused (non-2xx)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}, false, 400));
    const result = await runScheduledRecipeAgainstAgentRuntime("http://127.0.0.1:8100", recipe(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("HTTP 400");
  });

  it("stops polling and reports cancellation when the signal is already aborted", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ id: "run-1" }));
    const controller = new AbortController();
    controller.abort();
    const result = await runScheduledRecipeAgainstAgentRuntime("http://127.0.0.1:8100", recipe(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("중단");
  });

  // 실사용 제보(2026-08-19) — "이 스케줄에 설정된 시간을 넘겼다"는 사실과
  // 그 값(분 단위)이 실행 이력에 남아야 한다.
  it("reports the configured maxPollMs (as minutes) when the deadline elapses without a terminal status", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "run-1" }))
      .mockResolvedValue(jsonResponse({ status: "RUNNING" }));
    const result = await runScheduledRecipeAgainstAgentRuntime("http://127.0.0.1:8100", recipe(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 5,
      maxPollMs: 20,
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("실행 시간 상한");
  });
});

describe("describeMaxPollTimeoutMinutes", () => {
  it("converts ms to a human-readable minute count", () => {
    expect(describeMaxPollTimeoutMinutes(30 * 60_000)).toBe("30분");
    expect(describeMaxPollTimeoutMinutes(120_000)).toBe("2분");
  });
});
