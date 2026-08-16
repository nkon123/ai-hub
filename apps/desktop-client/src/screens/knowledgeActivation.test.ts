import { describe, expect, it } from "vitest";
import type { IncludedAssetSummary } from "../../electron/types";
import { knowledgeActivationTargets, mcpToolConnectionTargets, noFurtherActionTargets } from "./knowledgeActivation";

function item(overrides: Partial<IncludedAssetSummary> = {}): IncludedAssetSummary {
  return {
    asset_id: "know-1",
    asset_version_id: "av-1",
    asset_type: "knowledge",
    role: "root",
    name: "재택근무 정책",
    version: "1.0.0",
    required: true,
    status: "APPROVED",
    size_bytes: 100,
    ...overrides,
  };
}

describe("knowledgeActivationTargets", () => {
  it("picks Knowledge items with both asset_id and version present", () => {
    const targets = knowledgeActivationTargets([item()]);
    expect(targets).toEqual([{ assetId: "know-1", version: "1.0.0", name: "재택근무 정책" }]);
  });

  it("ignores non-Knowledge items even when otherwise well-formed", () => {
    expect(knowledgeActivationTargets([item({ asset_type: "agent" })])).toEqual([]);
    expect(knowledgeActivationTargets([item({ asset_type: "mcp_tool" })])).toEqual([]);
  });

  it("excludes a Knowledge item with a null asset_id (STANDARD_LOCAL_COPY / D-060) rather than guessing", () => {
    expect(knowledgeActivationTargets([item({ asset_id: null })])).toEqual([]);
  });

  it("excludes a Knowledge item with a null version", () => {
    expect(knowledgeActivationTargets([item({ version: null })])).toEqual([]);
  });

  it("handles a mixed install plan, keeping order", () => {
    const plan = [
      item({ asset_id: "know-1", version: "1.0.0", name: "정책 A" }),
      item({ asset_type: "agent", asset_id: "agent-1", version: "1.0.0", name: "Agent" }),
      item({ asset_id: "know-2", version: "2.0.0", name: "정책 B" }),
    ];
    expect(knowledgeActivationTargets(plan)).toEqual([
      { assetId: "know-1", version: "1.0.0", name: "정책 A" },
      { assetId: "know-2", version: "2.0.0", name: "정책 B" },
    ]);
  });

  it("returns an empty array for an empty install plan", () => {
    expect(knowledgeActivationTargets([])).toEqual([]);
  });
});

describe("mcpToolConnectionTargets", () => {
  it("picks only identified MCP Tool items", () => {
    expect(mcpToolConnectionTargets([
      item({ asset_type: "mcp_tool", asset_id: "tool-1", name: "Oracle Tables" }),
      item(),
      item({ asset_type: "mcp_tool", asset_id: null }),
    ])).toEqual([{ assetId: "tool-1", version: "1.0.0", name: "Oracle Tables" }]);
  });
});

describe("noFurtherActionTargets", () => {
  it("picks identified Agent and Prompt items", () => {
    expect(
      noFurtherActionTargets([
        item({ asset_type: "agent", asset_id: "agent-1", name: "HR 규정 Agent" }),
        item({ asset_type: "prompt", asset_id: "prompt-1", name: "질의 재작성 Prompt" }),
      ]),
    ).toEqual([
      { assetId: "agent-1", assetType: "agent", name: "HR 규정 Agent" },
      { assetId: "prompt-1", assetType: "prompt", name: "질의 재작성 Prompt" },
    ]);
  });

  it("ignores Knowledge and MCP Tool items — those have their own activation/connection flow", () => {
    expect(noFurtherActionTargets([item(), item({ asset_type: "mcp_tool", asset_id: "tool-1" })])).toEqual([]);
  });

  it("excludes an Agent/Prompt item with a null asset_id (STANDARD_LOCAL_COPY) rather than guessing", () => {
    expect(noFurtherActionTargets([item({ asset_type: "agent", asset_id: null })])).toEqual([]);
  });

  it("returns an empty array for an empty install plan", () => {
    expect(noFurtherActionTargets([])).toEqual([]);
  });
});
