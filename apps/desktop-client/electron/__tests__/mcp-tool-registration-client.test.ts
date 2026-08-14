import { describe, expect, it } from "vitest";
import { deregisterMcpTool, listMcpTools, registerMcpTool, type FetchLike } from "../mcp-tool-registration-client";

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const input = {
  toolName: "db_metadata.get_tables",
  serverAlias: "oracle-connector",
  inputSchema: { type: "object" },
  confirmationPolicy: "NEVER" as const,
  riskLevel: "READ_ONLY" as const,
  label: "Oracle Tables",
};

describe("mcp-tool-registration-client", () => {
  it("POSTs only the contract fields and never sends a dispatch endpoint", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:8100/local/v1/mcp-tools");
      sent = JSON.parse(String(init?.body));
      return response(200, { entry: { tool_name: input.toolName, server_alias: input.serverAlias, input_schema: input.inputSchema, confirmation_policy: "NEVER", risk_level: "READ_ONLY", label: input.label, registered_at: "2026-08-14T00:00:00Z" } });
    }) as FetchLike;
    expect((await registerMcpTool("http://127.0.0.1:8100/", input, fetchImpl)).ok).toBe(true);
    expect(sent).not.toHaveProperty("endpoint");
    expect(sent).not.toHaveProperty("server_url");
    expect(sent).not.toHaveProperty("connector");
  });

  it("preserves the policy-disabled refusal reason and Korean server message", async () => {
    const fetchImpl = (async () => response(403, { error: { message: "운영자 설정이 필요합니다.", details: { reason: "mcp_tool_registration_disabled" } } })) as FetchLike;
    expect(await registerMcpTool("http://127.0.0.1:8100", input, fetchImpl)).toEqual({ ok: false, reason: "mcp_tool_registration_disabled", message: "운영자 설정이 필요합니다." });
  });

  it("encodes the tool name for DELETE and returns an unreachable recovery result", async () => {
    const deleteFetch = (async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toContain("db_metadata.get_tables");
      expect(init?.method).toBe("DELETE");
      return response(200, { removed: true });
    }) as FetchLike;
    expect(await deregisterMcpTool("http://127.0.0.1:8100", input.toolName, deleteFetch)).toEqual({ ok: true, removed: true });
    const failed = await registerMcpTool("http://127.0.0.1:8100", input, (async () => { throw new Error("ECONNREFUSED"); }) as FetchLike);
    expect(failed).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("reads the current registration list and policy switch", async () => {
    const result = await listMcpTools("http://127.0.0.1:8100", (async (_url: unknown, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      return response(200, { entries: [{ tool_name: input.toolName, server_alias: input.serverAlias, input_schema: {}, confirmation_policy: "NEVER", risk_level: "READ_ONLY", registered_at: "now" }], mcp_tool_registration_enabled: true });
    }) as FetchLike);
    expect(result).toMatchObject({ ok: true, registrationEnabled: true, entries: [{ toolName: input.toolName }] });
  });
});
