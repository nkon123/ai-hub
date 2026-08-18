import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assetInstallDir } from "../asset-management";
import { resolveInstallRoot, type InstallRootLayout } from "../bundle-install";
import { InstalledAssetsStore } from "../installed-assets-store";
import { connectInstalledMcpTool, disconnectInstalledMcpTool, reconcileInstalledMcpToolConnections } from "../mcp-tool-connection";
import type { FetchLike } from "../mcp-tool-registration-client";

let root: string;
let layout: InstallRootLayout;
let store: InstalledAssetsStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-mcp-tool-"));
  layout = resolveInstallRoot(root);
  store = new InstalledAssetsStore(layout.stateDir);
  const dir = assetInstallDir(layout, "mcp_tool", "oracle-tables", "1.0.0");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ type: "mcp_tool", name: "Oracle Tables", server_alias: "oracle-connector", tool_name: "db_metadata.get_tables", risk_level: "READ_ONLY", input_schema: { type: "object" } }));
  store.upsert({ assetId: "oracle-tables", assetVersionId: "av-1", assetType: "mcp_tool", name: "Oracle Tables", version: "1.0.0", installedAt: new Date().toISOString(), sizeBytes: 1, bundleId: "b-1", checksumVerification: null });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const target = { assetType: "mcp_tool", assetId: "oracle-tables", version: "1.0.0" };

describe("installed MCP Tool connection", () => {
  it("persists ACTIVE after registration and clears local state after disconnect", async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => init?.method === "DELETE"
      ? ({ ok: true, status: 200, json: async () => ({ removed: true }) } as Response)
      : ({ ok: true, status: 200, json: async () => ({ entry: { tool_name: "db_metadata.get_tables", server_alias: "oracle-connector", input_schema: { type: "object" }, confirmation_policy: "NEVER", risk_level: "READ_ONLY", label: "Oracle Tables", registered_at: "now" } }) } as Response)) as FetchLike;
    expect((await connectInstalledMcpTool(layout, store, "http://runtime", target, fetchImpl)).activation?.state).toBe("ACTIVE");
    expect(store.find("mcp_tool", "oracle-tables", "1.0.0")?.activation?.state).toBe("ACTIVE");
    expect((await disconnectInstalledMcpTool(layout, store, "http://runtime", target, fetchImpl)).ok).toBe(true);
    expect(store.find("mcp_tool", "oracle-tables", "1.0.0")?.activation).toBeNull();
  });

  it("persists policy-disabled as a distinguishable FAILED result", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "운영자 설정이 필요합니다.", details: { reason: "mcp_tool_registration_disabled" } } }) } as Response)) as FetchLike;
    const result = await connectInstalledMcpTool(layout, store, "http://runtime", target, fetchImpl);
    expect(result.activation).toMatchObject({ state: "FAILED", reason: "mcp_tool_registration_disabled" });
    expect(store.find("mcp_tool", "oracle-tables", "1.0.0")?.activation?.reason).toBe("mcp_tool_registration_disabled");
  });

  it("downgrades stale ACTIVE after a successful list check, but never on an unreachable check", async () => {
    store.updateActivation("mcp_tool", "oracle-tables", "1.0.0", { state: "ACTIVE", checkedAt: "now", reason: null, message: null, indexPath: null });
    const unreachable = await reconcileInstalledMcpToolConnections(layout, store, "http://runtime", (async () => { throw new Error("offline"); }) as FetchLike);
    expect(unreachable.checked).toBe(false);
    expect(store.find("mcp_tool", "oracle-tables", "1.0.0")?.activation?.state).toBe("ACTIVE");

    const checked = await reconcileInstalledMcpToolConnections(layout, store, "http://runtime", (async () => ({ ok: true, status: 200, json: async () => ({ entries: [], mcp_tool_registration_enabled: true }) } as Response)) as FetchLike);
    expect(checked).toMatchObject({ checked: true, downgradedCount: 1, registrationEnabled: true });
    expect(store.find("mcp_tool", "oracle-tables", "1.0.0")?.activation).toMatchObject({ state: "FAILED", reason: "not_registered_on_server" });
  });

  it("unlocks a previous policy-disabled state after the operator enables registration", async () => {
    store.updateActivation("mcp_tool", "oracle-tables", "1.0.0", { state: "FAILED", checkedAt: "now", reason: "mcp_tool_registration_disabled", message: "운영자 설정 필요", indexPath: null });
    const result = await reconcileInstalledMcpToolConnections(layout, store, "http://runtime", (async () => ({ ok: true, status: 200, json: async () => ({ entries: [], mcp_tool_registration_enabled: true }) } as Response)) as FetchLike);
    expect(result.checked).toBe(true);
    expect(store.find("mcp_tool", "oracle-tables", "1.0.0")?.activation).toBeNull();
  });
});
