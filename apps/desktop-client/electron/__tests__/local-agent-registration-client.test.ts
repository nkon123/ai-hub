import { describe, expect, it } from "vitest";
import { deleteLocalAgent, listLocalAgents, registerLocalAgent, type FetchLike } from "../local-agent-registration-client";

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const input = {
  agentAssetId: "1e6f0e0a-0000-4000-8000-000000000001",
  agentVersion: "1.0.0",
  promptAssetId: "1e6f0e0a-0000-4000-8000-000000000002",
  promptVersion: "1.0.0",
  label: "HR 규정 Agent",
};

describe("local-agent-registration-client", () => {
  it("POSTs only the id/version/label contract fields — never a file path or directory name", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:8100/local/v1/local-agents");
      sent = JSON.parse(String(init?.body));
      return response(200, {
        entry: {
          agent_asset_id: input.agentAssetId,
          agent_version: input.agentVersion,
          prompt_asset_id: input.promptAssetId,
          prompt_version: input.promptVersion,
          agent_dir: "/opt/assets/agents/x/1.0.0",
          prompt_dir: "/opt/assets/prompts/y/1.0.0",
          label: input.label,
          registered_at: "2026-08-17T00:00:00Z",
        },
      });
    }) as FetchLike;
    expect((await registerLocalAgent("http://127.0.0.1:8100/", input, fetchImpl)).ok).toBe(true);
    expect(sent).not.toHaveProperty("path");
    expect(sent).not.toHaveProperty("agent_dir");
    expect(sent).not.toHaveProperty("file_path");
    expect(sent).toEqual({
      agent_asset_id: input.agentAssetId,
      agent_version: input.agentVersion,
      prompt_asset_id: input.promptAssetId,
      prompt_version: input.promptVersion,
      label: input.label,
      trace_id: null,
    });
  });

  it("preserves the local_agents_disabled refusal reason and Korean server message (Task Brief 제약 B)", async () => {
    const fetchImpl = (async () =>
      response(403, {
        error: {
          message: "이 배포는 로컬 설치 Agent Package 등록을 허용하지 않습니다 (AGENT_RUNTIME_LOCAL_AGENT_ROOTS 미설정).",
          details: { reason: "local_agents_disabled" },
        },
      })) as FetchLike;
    expect(await registerLocalAgent("http://127.0.0.1:8100", input, fetchImpl)).toEqual({
      ok: false,
      reason: "local_agents_disabled",
      message: "이 배포는 로컬 설치 Agent Package 등록을 허용하지 않습니다 (AGENT_RUNTIME_LOCAL_AGENT_ROOTS 미설정).",
    });
  });

  it("maps an unrecognized reason string to 'unknown' rather than inventing a more specific one", async () => {
    const fetchImpl = (async () =>
      response(400, { error: { message: "알 수 없는 오류", details: { reason: "some_future_reason" } } })) as FetchLike;
    expect(await registerLocalAgent("http://127.0.0.1:8100", input, fetchImpl)).toEqual({
      ok: false,
      reason: "unknown",
      message: "알 수 없는 오류",
    });
  });

  it("encodes the agent id for DELETE and returns an unreachable recovery result on network failure", async () => {
    const deleteFetch = (async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toContain(encodeURIComponent(input.agentAssetId));
      expect(init?.method).toBe("DELETE");
      return response(200, { removed: true });
    }) as FetchLike;
    expect(await deleteLocalAgent("http://127.0.0.1:8100", input.agentAssetId, deleteFetch)).toEqual({
      ok: true,
      removed: true,
    });
    const failed = await registerLocalAgent(
      "http://127.0.0.1:8100",
      input,
      (async () => {
        throw new Error("ECONNREFUSED");
      }) as FetchLike,
    );
    expect(failed).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("diagnoses a bare 404 as a possibly-stale agent-runtime process, not a generic unknown error", async () => {
    const fetchImpl = (async () => response(404, {})) as FetchLike;
    const result = await registerLocalAgent("http://127.0.0.1:8100", input, fetchImpl);
    expect(result).toMatchObject({ ok: false, reason: "activation_api_unavailable" });
  });

  it("reads the current registration list and the local_agents_enabled flag", async () => {
    const result = await listLocalAgents("http://127.0.0.1:8100", (async (_url: unknown, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      return response(200, {
        entries: [
          {
            agent_asset_id: input.agentAssetId,
            agent_version: input.agentVersion,
            prompt_asset_id: input.promptAssetId,
            prompt_version: input.promptVersion,
            agent_dir: "/opt/assets/agents/x/1.0.0",
            prompt_dir: "/opt/assets/prompts/y/1.0.0",
            label: input.label,
            registered_at: "now",
          },
        ],
        local_agents_enabled: true,
      });
    }) as FetchLike);
    expect(result).toMatchObject({
      ok: true,
      localAgentsEnabled: true,
      entries: [{ agentAssetId: input.agentAssetId }],
    });
  });

  it("reports local_agents_enabled=false as a distinct, honest flag rather than an empty list looking the same as 'nothing registered yet'", async () => {
    const result = await listLocalAgents(
      "http://127.0.0.1:8100",
      (async () => response(200, { entries: [], local_agents_enabled: false })) as FetchLike,
    );
    expect(result).toMatchObject({ ok: true, localAgentsEnabled: false, entries: [] });
  });
});
