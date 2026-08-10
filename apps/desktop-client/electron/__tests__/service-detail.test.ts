// D03 Service/Agent 상세 — integration tests against a real temp install
// layout (same approach as `asset-management.test.ts`: real files on disk,
// not mocked fs, since this is exactly the code path CLAUDE.md's "지어내지
// 않는다" rule depends on for every §D03 field).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInstallRoot, type InstallRootLayout } from "../bundle-install";
import { InstalledAssetsStore } from "../installed-assets-store";
import { assetInstallDir } from "../asset-management";
import { getServiceDetailView } from "../service-detail";
import type { InstalledAsset } from "../types";

let tmpRoot: string;
let layout: InstallRootLayout;
let store: InstalledAssetsStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-service-detail-"));
  layout = resolveInstallRoot(tmpRoot);
  store = new InstalledAssetsStore(layout.stateDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function installAsset(assetType: string, assetId: string, version: string, name: string, sizeBytes = 100): void {
  fs.mkdirSync(assetInstallDir(layout, assetType, assetId, version), { recursive: true });
  const asset: InstalledAsset = {
    assetId,
    assetVersionId: null,
    assetType,
    name,
    version,
    installedAt: new Date().toISOString(),
    sizeBytes,
    bundleId: "bundle-1",
    checksumVerification: null,
  };
  store.upsert(asset);
}

function installService(assetId: string, version: string, definition: Record<string, unknown>, sizeBytes = 10): void {
  const dir = assetInstallDir(layout, "service", assetId, version);
  fs.mkdirSync(dir, { recursive: true });
  const fullDefinition = { ...definition, id: assetId, version };
  fs.writeFileSync(path.join(dir, "service-definition.json"), JSON.stringify(fullDefinition));
  const asset: InstalledAsset = {
    assetId,
    assetVersionId: null,
    assetType: "service",
    name: (definition.name as string) ?? assetId,
    version,
    installedAt: new Date().toISOString(),
    sizeBytes,
    bundleId: "bundle-1",
    checksumVerification: null,
  };
  store.upsert(asset);
}

function installKnowledgeWithIndex(assetId: string, version: string, indexMeta: Record<string, unknown> | null, sizeBytes = 200): void {
  const dir = assetInstallDir(layout, "knowledge", assetId, version);
  fs.mkdirSync(dir, { recursive: true });
  if (indexMeta) {
    const indexDir = path.join(dir, "index");
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(path.join(indexDir, "index-meta.json"), JSON.stringify(indexMeta));
  }
  const asset: InstalledAsset = {
    assetId,
    assetVersionId: "av-know-1",
    assetType: "knowledge",
    name: "재택근무 정책",
    version,
    installedAt: new Date().toISOString(),
    sizeBytes,
    bundleId: "bundle-1",
    checksumVerification: null,
  };
  store.upsert(asset);
}

describe("getServiceDetailView — not found", () => {
  it("reports available:false for an asset that was never installed", () => {
    const result = getServiceDetailView(layout, store, { assetType: "service", assetId: "missing", version: "1.0.0" });
    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.detail).toBeNull();
  });
});

describe("getServiceDetailView — 업무 목적과 사용 예", () => {
  it("surfaces description/chatbot_config.suggested_questions when present", () => {
    installService("svc-1", "1.0.0", {
      name: "HR 챗봇",
      description: "사내 인사 정책을 안내합니다.",
      chatbot_config: { suggested_questions: ["연차는 어떻게 신청하나요?", "육아휴직 기간은?"] },
      agent_ref: { id: "agent-1", version: "1.0.0" },
      model_policy: { model_alias: "office-default" },
    });
    const result = getServiceDetailView(layout, store, { assetType: "service", assetId: "svc-1", version: "1.0.0" });
    expect(result.available).toBe(true);
    expect(result.detail!.purpose).toEqual({
      available: true,
      value: "사내 인사 정책을 안내합니다.",
      source: "manifest.description",
      reason: null,
    });
    expect(result.detail!.usageExamples.available).toBe(true);
    expect(result.detail!.usageExamples.values).toEqual(["연차는 어떻게 신청하나요?", "육아휴직 기간은?"]);
  });

  it("reports a stated gap (never fabricates) when description/chatbot_config are absent", () => {
    installService("svc-2", "1.0.0", { name: "무설명 Service", agent_ref: { id: "agent-1", version: "1.0.0" }, model_policy: { model_alias: "office-default" } });
    const result = getServiceDetailView(layout, store, { assetType: "service", assetId: "svc-2", version: "1.0.0" });
    expect(result.detail!.purpose.available).toBe(false);
    expect(result.detail!.purpose.value).toBeNull();
    expect(result.detail!.purpose.reason).toBeTruthy();
    expect(result.detail!.usageExamples.available).toBe(false);
    expect(result.detail!.usageExamples.reason).toBeTruthy();
  });
});

describe("getServiceDetailView — 항상 미기재인 필드", () => {
  it("always reports inputFields/runtimeRequirements/approvalStatus as unavailable with a reason", () => {
    installService("svc-3", "1.0.0", { name: "S", agent_ref: { id: "agent-1", version: "1.0.0" }, model_policy: { model_alias: "office-default" } });
    const detail = getServiceDetailView(layout, store, { assetType: "service", assetId: "svc-3", version: "1.0.0" }).detail!;
    expect(detail.inputFields).toEqual({ available: false, reason: expect.any(String) });
    expect(detail.runtimeRequirements).toEqual({ available: false, reason: expect.any(String) });
    expect(detail.approvalStatus).toEqual({ available: false, reason: expect.any(String) });
    expect(detail.inputFields.reason.length).toBeGreaterThan(0);
    expect(detail.runtimeRequirements.reason.length).toBeGreaterThan(0);
    expect(detail.approvalStatus.reason.length).toBeGreaterThan(0);
  });
});

describe("getServiceDetailView — 선택된 Agent/Knowledge/MCP Tool/Prompt", () => {
  it("marks each binding installed/not-installed and reads Knowledge's own index-meta.json for the embedding model", () => {
    installAsset("agent", "agent-1", "1.0.0", "표준 Agent");
    installKnowledgeWithIndex("know-1", "3.0.0", { embed_model: "qwen3-embedding:0.6b", chunking_strategy: "recursive" });
    // mcp-1과 prompt-1은 설치되지 않은 상태로 남긴다 — "미설치" 표시 확인용.
    installService("svc-4", "1.0.0", {
      name: "HR 챗봇",
      agent_ref: { id: "agent-1", version: "1.0.0" },
      knowledge_bindings: [{ role_id: "primary", knowledge_id: "know-1", knowledge_version: "3.0.0" }],
      mcp_bindings: [{ role_id: "lookup", tool_id: "mcp-1", tool_version: "1.0.0", confirmation_policy: "sensitive_only" }],
      prompt_bindings: [{ role_id: "answerer", prompt_id: "prompt-1", prompt_version: "1.0.0" }],
      model_policy: { model_alias: "office-default" },
    });

    const detail = getServiceDetailView(layout, store, { assetType: "service", assetId: "svc-4", version: "1.0.0" }).detail!;
    const byRefType = Object.fromEntries(detail.bindings.map((b) => [b.refType, b]));

    expect(byRefType.agent_ref.installed).toBe(true);
    expect(byRefType.knowledge_bindings.installed).toBe(true);
    expect(byRefType.knowledge_bindings.indexInfo).toEqual({
      available: true,
      embedModel: "qwen3-embedding:0.6b",
      chunkingStrategy: "recursive",
      source: expect.stringContaining("index-meta.json"),
      reason: null,
    });
    expect(byRefType.mcp_bindings.installed).toBe(false);
    expect(byRefType.mcp_bindings.confirmationPolicy).toBe("sensitive_only");
    expect(byRefType.prompt_bindings.installed).toBe(false);
  });

  it("reports the Knowledge index-info gap honestly when the binding is not installed at all", () => {
    installService("svc-5", "1.0.0", {
      name: "S",
      agent_ref: { id: "agent-1", version: "1.0.0" },
      knowledge_bindings: [{ role_id: "primary", knowledge_id: "know-missing", knowledge_version: "1.0.0" }],
      model_policy: { model_alias: "office-default" },
    });
    const detail = getServiceDetailView(layout, store, { assetType: "service", assetId: "svc-5", version: "1.0.0" }).detail!;
    const knowledgeBinding = detail.bindings.find((b) => b.refType === "knowledge_bindings")!;
    expect(knowledgeBinding.installed).toBe(false);
    expect(knowledgeBinding.indexInfo!.available).toBe(false);
    expect(knowledgeBinding.indexInfo!.reason).toBeTruthy();
  });

  it("reports a null confirmationPolicy when the Service didn't declare one, rather than assuming the schema default", () => {
    installService("svc-6", "1.0.0", {
      name: "S",
      agent_ref: { id: "agent-1", version: "1.0.0" },
      mcp_bindings: [{ role_id: "lookup", tool_id: "mcp-1", tool_version: "1.0.0" }],
      model_policy: { model_alias: "office-default" },
    });
    const detail = getServiceDetailView(layout, store, { assetType: "service", assetId: "svc-6", version: "1.0.0" }).detail!;
    const mcpBinding = detail.bindings.find((b) => b.refType === "mcp_bindings")!;
    expect(mcpBinding.confirmationPolicy).toBeNull();
  });

  it("for a non-Service asset, forwards AssetDependencyView's forwardNote instead of a bindings list", () => {
    installKnowledgeWithIndex("know-2", "1.0.0", { embed_model: "qwen3-embedding:0.6b" });
    const detail = getServiceDetailView(layout, store, { assetType: "knowledge", assetId: "know-2", version: "1.0.0" }).detail!;
    expect(detail.bindings).toEqual([]);
    expect(detail.bindingsNote).toBeTruthy();
    expect(detail.modelPolicy).toBeNull();
  });
});

describe("getServiceDetailView — 모델 정책", () => {
  it("extracts the declared model_policy and always includes the resolvedModelNote caveat", () => {
    installService("svc-7", "1.0.0", {
      name: "S",
      agent_ref: { id: "agent-1", version: "1.0.0" },
      model_policy: { model_alias: "default-chat", fallback_allowed: true, max_context_tokens: 8192 },
    });
    const detail = getServiceDetailView(layout, store, { assetType: "service", assetId: "svc-7", version: "1.0.0" }).detail!;
    expect(detail.modelPolicy).toEqual({ modelAlias: "default-chat", fallbackAllowed: true, maxContextTokens: 8192 });
    expect(detail.resolvedModelNote.length).toBeGreaterThan(0);
  });
});

describe("getServiceDetailView — 설치 용량", () => {
  it("sums this asset's own size plus every installed (but not uninstalled) binding target exactly once", () => {
    installAsset("agent", "agent-1", "1.0.0", "표준 Agent", 50);
    installKnowledgeWithIndex("know-1", "3.0.0", { embed_model: "m" }, 300);
    installService(
      "svc-8",
      "1.0.0",
      {
        name: "S",
        agent_ref: { id: "agent-1", version: "1.0.0" },
        knowledge_bindings: [{ role_id: "primary", knowledge_id: "know-1", knowledge_version: "3.0.0" }],
        mcp_bindings: [{ role_id: "lookup", tool_id: "mcp-not-installed", tool_version: "1.0.0" }],
        model_policy: { model_alias: "office-default" },
      },
      10,
    );
    const detail = getServiceDetailView(layout, store, { assetType: "service", assetId: "svc-8", version: "1.0.0" }).detail!;
    // 10 (service) + 50 (agent) + 300 (knowledge) — 설치되지 않은 mcp-1은 제외.
    expect(detail.installSizeBytes).toBe(360);
  });
});

describe("getServiceDetailView — 상태/Checksum", () => {
  it("carries the asset's computed status and stored checksumVerification through unchanged", () => {
    installService("svc-9", "1.0.0", { name: "S", agent_ref: { id: "agent-1", version: "1.0.0" }, model_policy: { model_alias: "x" } });
    const detail = getServiceDetailView(layout, store, { assetType: "service", assetId: "svc-9", version: "1.0.0" }).detail!;
    expect(detail.status).toBe("ACTIVE");
    expect(detail.checksumVerification).toBeNull();
  });
});
