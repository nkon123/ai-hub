import { describe, expect, it } from "vitest";
import {
  type AgentDraftSourceMessage,
  buildAgentManifestDraft,
  buildPromptManifestDraft,
  buildSystemPromptDraftRequest,
  deriveCapabilitiesFromMessages,
  resolveAgentDraftOwner,
  suggestCitationRequired,
} from "../agent-draft";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function liveMessage(overrides: Partial<AgentDraftSourceMessage> = {}): AgentDraftSourceMessage {
  return {
    question: "질문",
    restored: false,
    citations: [],
    stages: { tool_call: { state: "skipped" } },
    toolRoute: null,
    ...overrides,
  };
}

describe("deriveCapabilitiesFromMessages", () => {
  it("returns knowledge_required: false when no live message has citations (never guesses true)", () => {
    const result = deriveCapabilitiesFromMessages([
      liveMessage({ citations: [] }),
      liveMessage({ citations: [] }),
    ]);
    expect(result.hasLiveMessages).toBe(true);
    expect(result.knowledgeRequired.value).toBe(false);
    expect(result.knowledgeRequired.reason).toContain("근거 문서가 사용된 턴이 없습니다");
  });

  it("returns knowledge_required: true with an evidence-bearing reason when a live message has citations", () => {
    const result = deriveCapabilitiesFromMessages([
      liveMessage({ citations: [{ chunk_id: "a" }, { chunk_id: "b" }] }),
      liveMessage({ citations: [] }),
    ]);
    expect(result.knowledgeRequired.value).toBe(true);
    expect(result.knowledgeRequired.reason).toContain("2건");
    expect(result.knowledgeRequired.reason).toContain("턴 2개 중");
  });

  it("returns mcp_allowed: false when no live message actually completed a tool call", () => {
    const result = deriveCapabilitiesFromMessages([
      liveMessage({ stages: { tool_call: { state: "skipped" } } }),
      liveMessage({ stages: { tool_call: { state: "active" } } }),
    ]);
    expect(result.mcpAllowed.value).toBe(false);
    expect(result.mcpAllowed.reason).toBe("이 대화에서 Tool이 실행된 턴이 없습니다.");
  });

  it("returns mcp_allowed: true (with the tool name) only for a completed tool_call stage", () => {
    const result = deriveCapabilitiesFromMessages([
      liveMessage({ stages: { tool_call: { state: "done" } }, toolRoute: { toolName: "calculator.add" } }),
    ]);
    expect(result.mcpAllowed.value).toBe(true);
    expect(result.mcpAllowed.reason).toContain("1회");
    expect(result.mcpAllowed.reason).toContain("calculator.add");
  });

  it("reports 'no evidence' when every message is restored (never fabricates a judgment)", () => {
    const result = deriveCapabilitiesFromMessages([
      liveMessage({ restored: true, citations: [{ chunk_id: "a" }] }),
      liveMessage({ restored: true, stages: { tool_call: { state: "done" } } }),
    ]);
    expect(result.hasLiveMessages).toBe(false);
    expect(result.liveMessageCount).toBe(0);
    expect(result.totalMessageCount).toBe(2);
    expect(result.knowledgeRequired.value).toBe(false);
    expect(result.mcpAllowed.value).toBe(false);
    expect(result.knowledgeRequired.reason).toContain("실행된 턴이 아직 없습니다");
  });

  it("ignores restored messages even when live messages are also present", () => {
    const result = deriveCapabilitiesFromMessages([
      liveMessage({ restored: true, citations: [{ chunk_id: "restored-only" }] }),
      liveMessage({ citations: [] }),
    ]);
    expect(result.hasLiveMessages).toBe(true);
    expect(result.liveMessageCount).toBe(1);
    // Only the live (non-restored) message counts — its citations array is
    // empty, so this must stay false even though the restored message above
    // "had" a citation count.
    expect(result.knowledgeRequired.value).toBe(false);
  });

  it("reports 'no evidence' for a fully empty conversation", () => {
    const result = deriveCapabilitiesFromMessages([]);
    expect(result.hasLiveMessages).toBe(false);
    expect(result.totalMessageCount).toBe(0);
  });
});

describe("suggestCitationRequired", () => {
  it("suggests citation_required only when knowledge_required is true", () => {
    expect(suggestCitationRequired(true)).toBe(true);
    expect(suggestCitationRequired(false)).toBe(false);
  });
});

describe("resolveAgentDraftOwner", () => {
  it("uses siteId/clientDisplayName when present", () => {
    expect(resolveAgentDraftOwner("site-1", "김테스트")).toEqual({ org: "site-1", creatorId: "김테스트" });
  });

  it("falls back to honest placeholders when both are null (no Desktop login concept)", () => {
    expect(resolveAgentDraftOwner(null, null)).toEqual({ org: "local", creatorId: "desktop-user" });
  });

  it("falls back per-field when only one is set", () => {
    expect(resolveAgentDraftOwner("  ", "이름만있음")).toEqual({ org: "local", creatorId: "이름만있음" });
  });
});

describe("buildAgentManifestDraft / buildPromptManifestDraft", () => {
  const agentId = "550e8400-e29b-41d4-a716-446655440099";
  const promptId = "550e8400-e29b-41d4-a716-446655440098";
  const owner = { org: "local", creatorId: "desktop-user" };

  it("always sets entry_role to roles[0].id, even if the role id constant changes shape", () => {
    const manifest = buildAgentManifestDraft({
      agentId,
      name: "테스트 Agent",
      description: "설명",
      owner,
      knowledgeRequired: true,
      mcpAllowed: false,
      citationRequired: true,
    }) as { workflow: { entry_role: string; roles: Array<{ id: string }> } };
    expect(manifest.workflow.entry_role).toBe(manifest.workflow.roles[0].id);
    expect(manifest.workflow.roles).toHaveLength(1);
  });

  it("satisfies agent-manifest.schema.json's required fields and patterns", () => {
    const manifest = buildAgentManifestDraft({
      agentId,
      name: "테스트 Agent",
      description: "설명",
      owner,
      knowledgeRequired: true,
      mcpAllowed: false,
      citationRequired: true,
    }) as Record<string, unknown>;

    expect(manifest.schema_version).toBe("1.0");
    expect(manifest.type).toBe("agent");
    expect(manifest.id).toMatch(UUID_RE);
    expect(manifest.version).toMatch(SEMVER_RE);
    expect(manifest.name).toBe("테스트 Agent");
    expect(manifest.owner).toEqual({ org: "local", creator_id: "desktop-user" });
    expect(manifest.classification).toBe("PUBLIC_INTERNAL");

    const capabilities = manifest.capabilities as Record<string, unknown>;
    expect(capabilities.knowledge_required).toBe(true);
    expect(capabilities.mcp_allowed).toBe(false);
    expect(capabilities.citation_required).toBe(true);

    // additionalProperties:false — every top-level key must be one the
    // schema actually declares.
    const allowedTopLevel = new Set([
      "schema_version",
      "id",
      "type",
      "name",
      "version",
      "owner",
      "classification",
      "description",
      "tags",
      "manifest_hash",
      "changelog",
      "created_at",
      "workflow",
      "capabilities",
    ]);
    for (const key of Object.keys(manifest)) {
      expect(allowedTopLevel.has(key)).toBe(true);
    }
    // manifest_hash is optional and never fabricated.
    expect(manifest.manifest_hash).toBeUndefined();
  });

  it("satisfies prompt-manifest.schema.json's required fields and patterns", () => {
    const manifest = buildPromptManifestDraft({
      promptId,
      name: "테스트 Prompt",
      description: "설명",
      owner,
      systemPrompt: "당신은 도우미입니다.",
      citationRequired: true,
    }) as Record<string, unknown>;

    expect(manifest.schema_version).toBe("1.0");
    expect(manifest.type).toBe("prompt");
    expect(manifest.id).toMatch(UUID_RE);
    expect(manifest.version).toMatch(SEMVER_RE);

    const template = manifest.template as Record<string, unknown>;
    expect(template.file).toBe("template.md");
    expect(template.system).toBe("당신은 도우미입니다.");

    const variables = manifest.variables as Array<Record<string, unknown>>;
    expect(variables.some((v) => v.name === "question" && v.type === "string" && v.required === true)).toBe(true);

    expect(manifest.manifest_hash).toBeUndefined();
  });
});

describe("buildSystemPromptDraftRequest", () => {
  it("includes only question text, never answer text, and instructs role/tone/scope/refusal only", () => {
    const request = buildSystemPromptDraftRequest(["연차는 며칠인가요?", "회식비 한도는?"]);
    expect(request.history).toEqual([]);
    expect(request.question).toContain("연차는 며칠인가요?");
    expect(request.question).toContain("회식비 한도는?");
    expect(request.question).toContain("역할·말투·범위·거절 조건");
  });

  it("handles an empty question list honestly instead of fabricating content", () => {
    const request = buildSystemPromptDraftRequest([]);
    expect(request.question).toContain("(질문이 없습니다.)");
  });
});
