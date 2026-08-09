import { describe, expect, it } from "vitest";
import { findReferencingServices, parseServiceDefinition, type InstalledServiceBindings } from "../service-dependencies";

function serviceDefinitionFixture(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    schema_version: "1.0",
    id: "11111111-1111-1111-1111-111111111111",
    type: "service",
    name: "HR 정책 챗봇",
    version: "1.0.0",
    owner: { org: "hr", creator_id: "u1" },
    classification: "INTERNAL",
    agent_ref: { id: "agent-1", version: "2.0.0" },
    knowledge_bindings: [{ role_id: "primary", knowledge_id: "know-1", knowledge_version: "3.0.0" }],
    mcp_bindings: [{ role_id: "lookup", tool_id: "mcp-1", tool_version: "1.0.0" }],
    prompt_bindings: [{ role_id: "answerer", prompt_id: "prompt-1", prompt_version: "1.0.0" }],
    model_policy: { model_alias: "office-default" },
    ...overrides,
  };
}

describe("parseServiceDefinition", () => {
  it("extracts every binding kind with exact field names from the schema", () => {
    const parsed = parseServiceDefinition(serviceDefinitionFixture());
    expect(parsed).not.toBeNull();
    expect(parsed!.assetId).toBe("11111111-1111-1111-1111-111111111111");
    expect(parsed!.agentRef).toEqual({ id: "agent-1", version: "2.0.0" });
    expect(parsed!.knowledgeBindings).toEqual([{ roleId: "primary", knowledgeId: "know-1", knowledgeVersion: "3.0.0" }]);
    expect(parsed!.mcpBindings).toEqual([{ roleId: "lookup", toolId: "mcp-1", toolVersion: "1.0.0" }]);
    expect(parsed!.promptBindings).toEqual([{ roleId: "answerer", promptId: "prompt-1", promptVersion: "1.0.0" }]);
  });

  it("returns null for malformed input rather than throwing", () => {
    expect(parseServiceDefinition(null)).toBeNull();
    expect(parseServiceDefinition("not an object")).toBeNull();
    expect(parseServiceDefinition({})).toBeNull();
    expect(parseServiceDefinition({ id: "x" })).toBeNull(); // missing version
  });

  it("tolerates a Service with no optional bindings at all", () => {
    const parsed = parseServiceDefinition(
      serviceDefinitionFixture({ knowledge_bindings: undefined, mcp_bindings: undefined, prompt_bindings: undefined }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.knowledgeBindings).toEqual([]);
    expect(parsed!.mcpBindings).toEqual([]);
    expect(parsed!.promptBindings).toEqual([]);
  });

  it("skips a malformed individual binding entry instead of failing the whole parse", () => {
    const parsed = parseServiceDefinition(
      serviceDefinitionFixture({ knowledge_bindings: [{ role_id: "primary" }] }), // missing knowledge_id/knowledge_version
    );
    expect(parsed!.knowledgeBindings).toEqual([]);
  });
});

describe("findReferencingServices", () => {
  const svc: InstalledServiceBindings = parseServiceDefinition(serviceDefinitionFixture())!;

  it("matches a Knowledge asset referenced via knowledge_bindings", () => {
    const matches = findReferencingServices({ assetType: "knowledge", assetId: "know-1", version: "3.0.0" }, [svc]);
    expect(matches).toEqual([{ assetId: svc.assetId, name: svc.name, version: svc.version, via: "knowledge_bindings" }]);
  });

  it("matches an Agent asset referenced via agent_ref", () => {
    const matches = findReferencingServices({ assetType: "agent", assetId: "agent-1", version: "2.0.0" }, [svc]);
    expect(matches).toHaveLength(1);
    expect(matches[0].via).toBe("agent_ref");
  });

  it("matches an MCP Tool asset referenced via mcp_bindings", () => {
    const matches = findReferencingServices({ assetType: "mcp_tool", assetId: "mcp-1", version: "1.0.0" }, [svc]);
    expect(matches).toHaveLength(1);
    expect(matches[0].via).toBe("mcp_bindings");
  });

  it("matches a Prompt asset referenced via prompt_bindings", () => {
    const matches = findReferencingServices({ assetType: "prompt", assetId: "prompt-1", version: "1.0.0" }, [svc]);
    expect(matches).toHaveLength(1);
    expect(matches[0].via).toBe("prompt_bindings");
  });

  it("does not match a different version of the same asset id", () => {
    const matches = findReferencingServices({ assetType: "knowledge", assetId: "know-1", version: "9.9.9" }, [svc]);
    expect(matches).toEqual([]);
  });

  it("does not match an unrelated asset", () => {
    const matches = findReferencingServices({ assetType: "knowledge", assetId: "unrelated", version: "1.0.0" }, [svc]);
    expect(matches).toEqual([]);
  });

  it("never reports a Service as referencing itself", () => {
    const matches = findReferencingServices({ assetType: "service", assetId: svc.assetId, version: svc.version }, [svc]);
    expect(matches).toEqual([]);
  });
});
