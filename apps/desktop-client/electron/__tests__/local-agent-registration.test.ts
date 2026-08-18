import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { InstalledAssetsStore } from "../installed-assets-store";
import {
  computeLocalAgentRegistrationReconcile,
  PROMPT_REMOVED_REASON,
  reconcileInstalledLocalAgentRegistrations,
  registerInstalledLocalAgent,
  unregisterInstalledLocalAgent,
} from "../local-agent-registration";
import type { FetchLike } from "../local-agent-registration-client";

const AGENT_ID = "1e6f0e0a-0000-4000-8000-000000000001";
const PROMPT_ID = "1e6f0e0a-0000-4000-8000-000000000002";
const OTHER_PROMPT_ID = "1e6f0e0a-0000-4000-8000-000000000003";

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let root: string;
let store: InstalledAssetsStore;

function seedAgent() {
  store.upsert({
    assetId: AGENT_ID,
    assetVersionId: "av-agent-1",
    assetType: "agent",
    name: "HR 규정 Agent",
    version: "1.0.0",
    installedAt: new Date().toISOString(),
    sizeBytes: 1,
    bundleId: "b-1",
    checksumVerification: null,
  });
}

function seedPrompt() {
  store.upsert({
    assetId: PROMPT_ID,
    assetVersionId: "av-prompt-1",
    assetType: "prompt",
    name: "HR 규정 Prompt",
    version: "1.0.0",
    installedAt: new Date().toISOString(),
    sizeBytes: 1,
    bundleId: "b-1",
    checksumVerification: null,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-local-agent-"));
  store = new InstalledAssetsStore(root);
});

const agentTarget = { assetId: AGENT_ID, version: "1.0.0" };

describe("registerInstalledLocalAgent", () => {
  it("persists ACTIVE with the caller-chosen Prompt snapshot after a successful registration", async () => {
    seedAgent();
    seedPrompt();
    const fetchImpl = (async () =>
      response(200, {
        entry: {
          agent_asset_id: AGENT_ID,
          agent_version: "1.0.0",
          prompt_asset_id: PROMPT_ID,
          prompt_version: "1.0.0",
          agent_dir: "/opt/assets/agents/x/1.0.0",
          prompt_dir: "/opt/assets/prompts/y/1.0.0",
          label: "HR 규정 Agent",
          registered_at: "2026-08-17T00:00:00Z",
        },
      })) as FetchLike;
    const result = await registerInstalledLocalAgent(
      store,
      "http://runtime",
      agentTarget,
      { assetId: PROMPT_ID, version: "1.0.0" },
      null,
      fetchImpl,
    );
    expect(result).toMatchObject({
      ok: true,
      registration: { state: "ACTIVE", promptAssetId: PROMPT_ID, promptLabel: "HR 규정 Prompt" },
    });
    expect(store.find("agent", AGENT_ID, "1.0.0")?.localAgentRegistration).toMatchObject({
      state: "ACTIVE",
      promptAssetId: PROMPT_ID,
    });
  });

  it("refuses — never guesses a pairing — when the chosen Prompt is not actually installed (Task Brief 제약 C)", async () => {
    seedAgent();
    // No Prompt seeded at all — nothing installed to pair with.
    const fetchImpl = (async () => {
      throw new Error("must never call agent-runtime when the pairing cannot be formed locally");
    }) as FetchLike;
    const result = await registerInstalledLocalAgent(
      store,
      "http://runtime",
      agentTarget,
      { assetId: OTHER_PROMPT_ID, version: "1.0.0" },
      null,
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    expect(result.registration).toBeNull();
    expect(result.error).toContain("Prompt");
    expect(store.find("agent", AGENT_ID, "1.0.0")?.localAgentRegistration).toBeUndefined();
  });

  it("persists local_agents_disabled as a distinguishable FAILED result, distinct from a broken pairing (Task Brief 제약 B)", async () => {
    seedAgent();
    seedPrompt();
    const fetchImpl = (async () =>
      response(403, {
        error: {
          message: "이 배포는 로컬 설치 Agent Package 등록을 허용하지 않습니다 (AGENT_RUNTIME_LOCAL_AGENT_ROOTS 미설정).",
          details: { reason: "local_agents_disabled" },
        },
      })) as FetchLike;
    const result = await registerInstalledLocalAgent(
      store,
      "http://runtime",
      agentTarget,
      { assetId: PROMPT_ID, version: "1.0.0" },
      null,
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    expect(result.registration).toMatchObject({ state: "FAILED", reason: "local_agents_disabled" });
    expect(store.find("agent", AGENT_ID, "1.0.0")?.localAgentRegistration?.reason).toBe("local_agents_disabled");
  });
});

describe("unregisterInstalledLocalAgent", () => {
  it("clears local registration state even when the remote DELETE call fails", async () => {
    seedAgent();
    seedPrompt();
    store.updateLocalAgentRegistration("agent", AGENT_ID, "1.0.0", {
      state: "ACTIVE",
      checkedAt: "now",
      reason: null,
      message: null,
      promptAssetId: PROMPT_ID,
      promptVersion: "1.0.0",
      promptLabel: "HR 규정 Prompt",
    });
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as FetchLike;
    const result = await unregisterInstalledLocalAgent(store, "http://runtime", agentTarget, fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.remoteWarning).toBeTruthy();
    expect(store.find("agent", AGENT_ID, "1.0.0")?.localAgentRegistration).toBeNull();
  });

  it("returns a not-found error, touching nothing, when the Agent record itself is gone", async () => {
    const result = await unregisterInstalledLocalAgent(store, "http://runtime", agentTarget, (async () => {
      throw new Error("must not be called");
    }) as FetchLike);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("computeLocalAgentRegistrationReconcile", () => {
  const activeAgent = {
    assetType: "agent",
    assetId: AGENT_ID,
    version: "1.0.0",
    localAgentRegistration: {
      state: "ACTIVE" as const,
      checkedAt: "now",
      reason: null,
      message: null,
      promptAssetId: PROMPT_ID,
      promptVersion: "1.0.0",
      promptLabel: "P",
    },
  };
  // Prompt is still installed for the server-reconcile scenarios below —
  // isolates "server lost the registration" from D-087's "the paired Prompt
  // itself is gone" so each test exercises exactly one cause.
  const installedPrompt = { assetType: "prompt", assetId: PROMPT_ID, version: "1.0.0" };

  it("never downgrades on an unreachable check (serverEntries === null)", () => {
    const result = computeLocalAgentRegistrationReconcile([activeAgent, installedPrompt], null);
    expect(result).toEqual({ downgrades: [], checked: false });
  });

  it("downgrades a stale local ACTIVE with a retryable reason when the server has the feature enabled", () => {
    const result = computeLocalAgentRegistrationReconcile([activeAgent, installedPrompt], [], true);
    expect(result.checked).toBe(true);
    expect(result.downgrades).toHaveLength(1);
    expect(result.downgrades[0].registration.reason).toBe("not_registered_on_server");
  });

  it("downgrades with the non-retryable local_agents_disabled reason when the deployment has the feature off (Task Brief 제약 B)", () => {
    const result = computeLocalAgentRegistrationReconcile([activeAgent, installedPrompt], [], false);
    expect(result.downgrades[0].registration.reason).toBe("local_agents_disabled");
    expect(result.downgrades[0].registration.message).toContain("AGENT_RUNTIME_LOCAL_AGENT_ROOTS");
  });

  it("leaves an already-registered agent untouched", () => {
    const result = computeLocalAgentRegistrationReconcile(
      [activeAgent, installedPrompt],
      [{ agentAssetId: AGENT_ID }],
      true,
    );
    expect(result).toEqual({ downgrades: [], checked: true });
  });

  // --- D-087: paired Prompt removed, Agent registration left orphaned ------

  it("downgrades an ACTIVE registration to FAILED/prompt_removed when the paired Prompt is no longer installed, even though agent-runtime still lists it", () => {
    // Server still has the registration (agent-runtime hasn't been told yet)
    // — this is exactly the "ghost registration" scenario D-087 targets.
    const result = computeLocalAgentRegistrationReconcile([activeAgent], [{ agentAssetId: AGENT_ID }], true);
    expect(result.checked).toBe(true);
    expect(result.downgrades).toHaveLength(1);
    expect(result.downgrades[0].registration).toMatchObject({ state: "FAILED", reason: PROMPT_REMOVED_REASON });
  });

  it("names the removed Prompt by its registration-time label snapshot in the message", () => {
    const result = computeLocalAgentRegistrationReconcile([activeAgent], [{ agentAssetId: AGENT_ID }], true);
    expect(result.downgrades[0].registration.message).toContain("P");
  });

  it("does not downgrade (no false positive) when the paired Prompt is still installed", () => {
    const result = computeLocalAgentRegistrationReconcile(
      [activeAgent, installedPrompt],
      [{ agentAssetId: AGENT_ID }],
      true,
    );
    expect(result).toEqual({ downgrades: [], checked: true });
  });

  it("does not auto-reactivate — a FAILED/prompt_removed registration stays FAILED even once the Prompt is reinstalled, because the compute function never reads FAILED state as a candidate", () => {
    const failedAgent = {
      ...activeAgent,
      localAgentRegistration: {
        state: "FAILED" as const,
        checkedAt: "now",
        reason: PROMPT_REMOVED_REASON,
        message: "짝지어 등록했던 Prompt가 제거되었습니다.",
        promptAssetId: null,
        promptVersion: null,
        promptLabel: null,
      },
    };
    const result = computeLocalAgentRegistrationReconcile(
      [failedAgent, installedPrompt],
      [{ agentAssetId: AGENT_ID }],
      true,
    );
    expect(result).toEqual({ downgrades: [], checked: true });
  });
});

describe("reconcileInstalledLocalAgentRegistrations", () => {
  it("surfaces localAgentsEnabled=false as a distinct, always-refreshed state (Task Brief 제약 B)", async () => {
    seedAgent();
    seedPrompt();
    const fetchImpl = (async () => response(200, { entries: [], local_agents_enabled: false })) as FetchLike;
    const result = await reconcileInstalledLocalAgentRegistrations(store, "http://runtime", fetchImpl);
    expect(result).toMatchObject({ checked: true, localAgentsEnabled: false, downgradedCount: 0, error: null });
  });

  it("returns checked:false with the server's message on an unreachable agent-runtime, never inventing a downgrade", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as FetchLike;
    const result = await reconcileInstalledLocalAgentRegistrations(store, "http://runtime", fetchImpl);
    expect(result.checked).toBe(false);
    expect(result.localAgentsEnabled).toBeNull();
    expect(result.error).toBeTruthy();
  });

  // --- D-087: end-to-end via the store, Prompt removed while Agent registration is ACTIVE ---

  it("downgrades to FAILED/prompt_removed and unregisters the ghost entry from agent-runtime when the paired Prompt is gone (제약 C)", async () => {
    seedAgent();
    // Prompt intentionally not seeded — simulates removal after registration.
    store.updateLocalAgentRegistration("agent", AGENT_ID, "1.0.0", {
      state: "ACTIVE",
      checkedAt: "now",
      reason: null,
      message: null,
      promptAssetId: PROMPT_ID,
      promptVersion: "1.0.0",
      promptLabel: "HR 규정 Prompt",
    });
    const calls: Array<{ method: string; url: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(url) });
      if (init?.method === "DELETE") {
        return response(200, { removed: true });
      }
      return response(200, { entries: [{ agent_asset_id: AGENT_ID }], local_agents_enabled: true });
    }) as unknown as FetchLike;

    const result = await reconcileInstalledLocalAgentRegistrations(store, "http://runtime", fetchImpl);

    expect(result).toMatchObject({ checked: true, downgradedCount: 1, error: null });
    const reg = store.find("agent", AGENT_ID, "1.0.0")?.localAgentRegistration;
    expect(reg).toMatchObject({ state: "FAILED", reason: PROMPT_REMOVED_REASON });
    expect(reg?.message).toContain("HR 규정 Prompt");
    // Confirms the ghost registration was actually cleared server-side too.
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes(AGENT_ID))).toBe(true);
  });

  it("still downgrades locally even when the agent-runtime DELETE call fails (제약 C — Desktop은 Runtime 장애 시 종료되지 않는다)", async () => {
    seedAgent();
    store.updateLocalAgentRegistration("agent", AGENT_ID, "1.0.0", {
      state: "ACTIVE",
      checkedAt: "now",
      reason: null,
      message: null,
      promptAssetId: PROMPT_ID,
      promptVersion: "1.0.0",
      promptLabel: "HR 규정 Prompt",
    });
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        throw new Error("agent-runtime unreachable for DELETE");
      }
      return response(200, { entries: [{ agent_asset_id: AGENT_ID }], local_agents_enabled: true });
    }) as unknown as FetchLike;

    const result = await reconcileInstalledLocalAgentRegistrations(store, "http://runtime", fetchImpl);

    expect(result.downgradedCount).toBe(1);
    expect(store.find("agent", AGENT_ID, "1.0.0")?.localAgentRegistration).toMatchObject({
      state: "FAILED",
      reason: PROMPT_REMOVED_REASON,
    });
  });

  it("does not auto-reactivate a prompt_removed registration once the Prompt is reinstalled — reconcile only ever downgrades, never upgrades", async () => {
    seedAgent();
    seedPrompt(); // Prompt reinstalled after the registration had already been downgraded.
    store.updateLocalAgentRegistration("agent", AGENT_ID, "1.0.0", {
      state: "FAILED",
      checkedAt: "now",
      reason: PROMPT_REMOVED_REASON,
      message: "짝지어 등록했던 Prompt가 제거되었습니다.",
      promptAssetId: null,
      promptVersion: null,
      promptLabel: null,
    });
    const fetchImpl = (async () =>
      response(200, { entries: [{ agent_asset_id: AGENT_ID }], local_agents_enabled: true })) as FetchLike;

    const result = await reconcileInstalledLocalAgentRegistrations(store, "http://runtime", fetchImpl);

    expect(result.downgradedCount).toBe(0);
    expect(store.find("agent", AGENT_ID, "1.0.0")?.localAgentRegistration?.state).toBe("FAILED");
  });
});
