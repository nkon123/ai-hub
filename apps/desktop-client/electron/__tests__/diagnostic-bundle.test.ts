// D11 — "실제 Prompt·문서·DB 결과·Secret은 제외"를 실제로 검증하는 테스트.
// 로그 Fixture에 Prompt 원문, 문서 발췌, DB 조회 결과, API Key, 홈 디렉터리
// 절대경로를 전부 심어 놓고, 완성된 진단 Bundle 어디에도(JSON 전체를 문자열로
// 검사) 그 원문이 그대로 남아있지 않음을 확인한다 — 이 기능의 존재 이유
// 그 자체를 검증하는 테스트.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInstallRoot, type InstallRootLayout } from "../bundle-install";
import { InstalledAssetsStore } from "../installed-assets-store";
import { PortalSettingsStore } from "../portal-settings";
import { ConversationStore } from "../conversation-store";
import { buildDiagnosticBundle, saveDiagnosticBundle } from "../diagnostic-bundle";
import type { InstalledAsset, LogEntry } from "../types";

let tmpRoot: string;
let layout: InstallRootLayout;
let store: InstalledAssetsStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-diag-"));
  layout = resolveInstallRoot(tmpRoot);
  store = new InstalledAssetsStore(layout.stateDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// 실제 있어서는 안 되는 값들 — 아래 테스트는 이 5개 문자열이 결과에 절대
// 그대로 나타나지 않아야 함을 검증한다.
const RAW_PROMPT = "다음 사용자 질문에 대해 회사 내부 정책만 근거로 답변하라: 연봉 인상 기준을 알려줘";
const RAW_DOCUMENT_EXCERPT = "2026년도 재택근무 정책 제3조: 주 3회까지 재택근무를 허용하며 팀장 사전 승인이 필요하다";
const RAW_DB_ROW = "employee_id=10293, name=김민준, salary=68000000, ssn=901010-1234567";
const RAW_API_KEY = "sk-live-AbCdEfGh12345678IjKlMnOp";
const RAW_HOME_PATH = "/Users/victory/Dev/ai/miracom/enterprise-ai-asset-hub/secret-notes.md";

function poisonedLogEntries(): LogEntry[] {
  const now = new Date().toISOString();
  return [
    { timestamp: now, level: "ERROR", module: "agent-runtime-proxy", message: `Prompt 전송 실패: "${RAW_PROMPT}"`, errorCode: "PROMPT_SEND_FAILED" },
    { timestamp: now, level: "INFO", module: "knowledge-search", message: `검색된 문서 발췌: "${RAW_DOCUMENT_EXCERPT}"` },
    { timestamp: now, level: "ERROR", module: "mcp-adapter", message: `DB 조회 결과 로깅됨(버그): ${RAW_DB_ROW}`, errorCode: "DB_ROW_LEAK" },
    { timestamp: now, level: "ERROR", module: "ollama-adapter", message: `인증 실패, api_key=${RAW_API_KEY}` },
    { timestamp: now, level: "WARN", module: "bundle-install", message: `임시 경로 정리 실패: ${RAW_HOME_PATH}` },
  ];
}

describe("buildDiagnosticBundle — sanitization guarantee", () => {
  it("never lets a raw prompt, document excerpt, DB row, API key, or home path survive into the Bundle", async () => {
    const bundle = await buildDiagnosticBundle(layout, store, poisonedLogEntries(), {});
    const serialized = JSON.stringify(bundle);

    expect(serialized).not.toContain(RAW_PROMPT);
    expect(serialized).not.toContain(RAW_DOCUMENT_EXCERPT);
    expect(serialized).not.toContain(RAW_DB_ROW);
    expect(serialized).not.toContain(RAW_API_KEY);
    expect(serialized).not.toContain("/Users/victory");
    // Sanity: the sanitizer actually ran (didn't just happen to have nothing
    // to redact) — the placeholder must appear.
    expect(serialized).toContain("***REDACTED***");
  });

  it("also sanitizes the on-disk saved file, not just the in-memory object", async () => {
    const bundle = await buildDiagnosticBundle(layout, store, poisonedLogEntries(), {});
    const savedPath = saveDiagnosticBundle(layout, bundle);
    const onDisk = fs.readFileSync(savedPath, "utf-8");

    expect(onDisk).not.toContain(RAW_API_KEY);
    expect(onDisk).not.toContain(RAW_DB_ROW);
    expect(onDisk).not.toContain("/Users/victory");
  });

  it("only includes logs within the requested period filter", async () => {
    const inRange: LogEntry = { timestamp: "2026-08-05T00:00:00.000Z", level: "INFO", module: "x", message: "in range" };
    const outOfRange: LogEntry = { timestamp: "2026-01-01T00:00:00.000Z", level: "INFO", module: "x", message: "out of range" };
    const bundle = await buildDiagnosticBundle(layout, store, [inRange, outOfRange], { from: "2026-08-01T00:00:00.000Z" });
    expect(bundle.logs).toHaveLength(1);
    expect(bundle.logs[0].message).toBe("in range");
  });

  it("assembles the allowlisted fields — client version, OS info, installed assets, health, and honest 'unavailable' notes", async () => {
    const asset: InstalledAsset = {
      assetId: "know-1",
      assetVersionId: "av-1",
      assetType: "knowledge",
      name: "재택근무 정책",
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      sizeBytes: 10,
      bundleId: "b1",
      fileChecksums: { "manifest.json": "a".repeat(64) },
      checksumVerification: null,
    };
    store.upsert(asset);

    const bundle = await buildDiagnosticBundle(layout, store, [], {});

    expect(bundle.clientVersion).toBe("0.1.0"); // apps/desktop-client/package.json
    expect(bundle.os.platform).toBe(process.platform);
    expect(bundle.installedAssets).toEqual([
      { assetId: "know-1", assetType: "knowledge", version: "1.0.0", contentHash: `manifest.json:${"a".repeat(64)}` },
    ]);
    expect(Array.isArray(bundle.health)).toBe(true);
    // Local Agent Runtime may or may not be reachable from this test
    // environment — either way the result must be honest: a real version
    // string (never fabricated) when reachable, or a null + explanatory
    // note (never a silent guess) when not.
    if (bundle.runtimeVersion !== null) {
      expect(typeof bundle.runtimeVersion).toBe("string");
      expect(bundle.runtimeVersionNote).toBeNull();
    } else {
      expect(bundle.runtimeVersionNote).toBeTruthy();
    }
    expect(bundle.pythonVersion).toBeNull();
    expect(bundle.pythonVersionNote).toBeTruthy();
  });

  it("never spreads an arbitrary object into the Bundle — sanitizedSettings only contains the allowlisted keys", async () => {
    const bundle = await buildDiagnosticBundle(layout, store, [], {});
    expect(Object.keys(bundle.sanitizedSettings).sort()).toEqual([
      "agentRuntimeBaseUrl",
      "installRoot",
      "ollamaBaseUrl",
      "portalBaseUrl",
      "portalTokenConfigured",
    ]);
  });

  // 자산 스토어(D-071) — Portal 식별 Token은 절대 진단 Bundle에 들어가서는
  // 안 되는 값이다. `PortalSettingsStore`에 실제로 저장한 뒤, "설정됨
  // 여부"만 전달되고 원문 Token 문자열은 in-memory 객체에도 저장된 JSON
  // 파일에도(당연히) 나타나지 않음을 확인한다.
  it("never lets a stored Portal token survive into the diagnostic Bundle", async () => {
    const portalStore = new PortalSettingsStore(layout.stateDir);
    const RAW_PORTAL_TOKEN = "dev-user-token-should-never-leak-into-diagnostics";
    portalStore.setBaseUrl("https://portal.internal.example");
    portalStore.setToken(RAW_PORTAL_TOKEN);

    const bundle = await buildDiagnosticBundle(layout, store, [], {}, portalStore.getPublic());
    const serialized = JSON.stringify(bundle);

    expect(serialized).not.toContain(RAW_PORTAL_TOKEN);
    expect(bundle.sanitizedSettings.portalTokenConfigured).toBe("true");
    expect(bundle.sanitizedSettings.portalBaseUrl).toBe("https://portal.internal.example");

    const savedPath = saveDiagnosticBundle(layout, bundle);
    const onDisk = fs.readFileSync(savedPath, "utf-8");
    expect(onDisk).not.toContain(RAW_PORTAL_TOKEN);
  });

  // Desktop 대화 고도화(멀티턴 대화 보존, `conversation-store.ts`) — 그 파일의
  // 모듈 docstring이 명시하듯, 대화의 질문/답변 원문은 CLAUDE.md가 민감하다고
  // 지정한 종류의 데이터다. `buildDiagnosticBundle`은 `ConversationStore`를
  // import조차 하지 않으므로(Allow-list 원칙 — 이 파일 최상단 docstring)
  // 오늘은 구조적으로 leak이 불가능하지만, 이 테스트는 그 사실을 회귀
  // 테스트로 고정한다 — 나중에 누군가 "최근 대화도 진단에 포함하면
  // 좋겠다"며 이 파일에 필드를 추가하는 순간 실패해야 한다. Portal Token
  // 테스트와 정확히 같은 패턴(실제로 저장한 뒤, 직렬화된 Bundle 전체에서
  // 원문을 검색)이다.
  it("never lets a stored conversation's question/answer text survive into the diagnostic Bundle", async () => {
    const conversationStore = new ConversationStore(layout.stateDir);
    const RAW_QUESTION = "연봉 인상률과 인사 평가 기준을 구체적으로 알려줘";
    const RAW_ANSWER = "2026년도 인사 평가는 팀장 1차 평가 후 인사위원회가 최종 확정하며 등급별 인상률은 S 8%, A 5%이다";

    const conversation = conversationStore.create("know-1", "인사 정책");
    conversationStore.appendTurn(conversation.id, {
      question: RAW_QUESTION,
      answer: RAW_ANSWER,
      status: "succeeded",
      citationCount: 2,
    });

    const bundle = await buildDiagnosticBundle(layout, store, [], {});
    const serialized = JSON.stringify(bundle);

    expect(serialized).not.toContain(RAW_QUESTION);
    expect(serialized).not.toContain(RAW_ANSWER);

    const savedPath = saveDiagnosticBundle(layout, bundle);
    const onDisk = fs.readFileSync(savedPath, "utf-8");
    expect(onDisk).not.toContain(RAW_QUESTION);
    expect(onDisk).not.toContain(RAW_ANSWER);
  });

  it("reports Portal as unconfigured when no settings are passed — never fabricates a value", async () => {
    const bundle = await buildDiagnosticBundle(layout, store, [], {});
    expect(bundle.sanitizedSettings.portalTokenConfigured).toBe("false");
    expect(bundle.sanitizedSettings.portalBaseUrl).toBe("미설정");
  });

  // D01/D10(desktop-settings.ts) — Ollama Base URL is no longer hardcoded;
  // the diagnostic Bundle must reflect whatever was actually configured, not
  // a stale constant, so support can tell which endpoint the client was
  // really pointed at.
  it("reflects the configured Ollama Base URL, not the hardcoded default, once Desktop settings are provided", async () => {
    const desktopSettings = {
      clientDisplayName: "본사",
      siteId: "headquarters",
      ollamaBaseUrl: "http://127.0.0.1:22222",
      ollamaAllowNonLoopback: true,
      chatModelAlias: "default-chat",
      embeddingModelAlias: "default-embedding",
      mcpServerAlias: "oracle-connector",
      mcpServerUrl: "http://127.0.0.1:8500",
      maxConcurrentRuns: { value: 1, enforced: false, reason: "테스트" },
      setupCompletedAt: null,
      updatedAt: null,
    };
    const bundle = await buildDiagnosticBundle(layout, store, [], {}, null, desktopSettings);
    expect(bundle.sanitizedSettings.ollamaBaseUrl).toBe("http://127.0.0.1:22222");
  });

  it("falls back to the documented default Ollama Base URL when no Desktop settings are passed", async () => {
    const bundle = await buildDiagnosticBundle(layout, store, [], {});
    expect(bundle.sanitizedSettings.ollamaBaseUrl).toBe("http://127.0.0.1:11434");
  });
});
