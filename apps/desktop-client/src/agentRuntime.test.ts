// D-034 해석 경로 4 — startRun()이 실제로 보내는 요청 본문을 고정한다.
// 핵심 불변식(Task Brief 제약 D): 기본(아무것도 명시적으로 고르지 않음)
// 대화는 `local_agent_id`를 절대 보내지 않는다 — 표준 Agent가 항상 기본.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAgentRuntimeBaseUrl, startRun, type StartRunParams } from "./agentRuntime";

const baseParams: StartRunParams = {
  serviceId: "svc-1",
  knowledgeId: "know-1",
  knowledgeIds: ["know-1"],
  question: "질문",
  allowHubLookup: false,
};

function mockFetchOk(): { fetchMock: ReturnType<typeof vi.fn>; getSentBody: () => Record<string, unknown> } {
  let sentBody: Record<string, unknown> = {};
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body));
    return {
      ok: true,
      json: async () => ({ id: "run-1", status: "RUNNING", trace_id: "trace-1", created_at: "2026-08-17T00:00:00Z" }),
    } as Response;
  });
  return { fetchMock, getSentBody: () => sentBody };
}

beforeEach(() => {
  setAgentRuntimeBaseUrl("http://127.0.0.1:8100");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startRun — D-034 해석 경로 4 local_agent_id", () => {
  it("never sends local_agent_id when the caller omits it (D06 기본 동작 불변)", async () => {
    const { fetchMock, getSentBody } = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);
    await startRun(baseParams);
    const sent = getSentBody();
    expect(sent.input).not.toHaveProperty("local_agent_id");
  });

  it("sends local_agent_id, and omits agent_profile, when the caller explicitly picks a registered Local Agent", async () => {
    const { fetchMock, getSentBody } = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);
    await startRun({ ...baseParams, localAgentId: "agent-asset-1", agentProfile: "standard-agent" });
    const sent = getSentBody();
    const input = sent.input as Record<string, unknown>;
    expect(input.local_agent_id).toBe("agent-asset-1");
    // 서버가 local_agent_id를 먼저 확인하면 agent_profile을 아예 읽지
    // 않는다(routers/runs.py의 elif 분기) — 실제로 적용되지 않는 필드를
    // 보내지 않는다.
    expect(input).not.toHaveProperty("agent_profile");
  });

  it("still sends the explicit agent_profile when no Local Agent is selected (existing standard-db-agent path unchanged)", async () => {
    const { fetchMock, getSentBody } = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);
    await startRun({ ...baseParams, agentProfile: "standard-db-agent" });
    const sent = getSentBody();
    const input = sent.input as Record<string, unknown>;
    expect(input.agent_profile).toBe("standard-db-agent");
    expect(input).not.toHaveProperty("local_agent_id");
  });
});
