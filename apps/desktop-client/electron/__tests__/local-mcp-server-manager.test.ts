import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalMcpServerManager, guidanceForProbeFailure } from "../local-mcp-server-manager";
import {
  LOCAL_MCP_DIR,
  LocalMcpServerStore,
  MAX_COPY_FILES,
  buildLocalManifest,
  copyServerSource,
  defaultChoices,
  reconcileLocalMcpServers,
  toolDrafts,
  validateEndpoint,
  validateServerAlias,
  type ProbeResponse,
} from "../local-mcp-servers";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "local-mcp-"));
}

const PROBE: ProbeResponse = {
  protocol_version: "2026-07-28",
  server_name: "hello",
  tools: [
    { tool_name: "hello.now", description: "현재 시각", input_schema: { type: "object" }, read_only_hint: true, destructive_hint: null },
    { tool_name: "files.delete", description: null, input_schema: { type: "object" }, read_only_hint: null, destructive_hint: true },
    { tool_name: "plain", description: null, input_schema: {}, read_only_hint: null, destructive_hint: null },
    { tool_name: "bad name!", description: null, input_schema: {}, read_only_hint: null, destructive_hint: null },
  ],
  tools_snapshot_hash: `sha256:${"a".repeat(64)}`,
  local_user_context: { organization_id: "miracom", roles: ["USER"] },
};

describe("validation", () => {
  it("accepts manifest-style aliases only", () => {
    expect(validateServerAlias("hello-local")).toBeNull();
    for (const bad of ["Hello", "1abc", "a", "ends-", "has space", "한글"]) expect(validateServerAlias(bad)).not.toBeNull();
  });

  it("accepts http(s) endpoints and flags non-loopback ones", () => {
    expect(validateEndpoint("http://127.0.0.1:8000/mcp")).toEqual({ ok: true, loopback: true });
    expect(validateEndpoint("https://mcp.example.com/mcp")).toEqual({ ok: true, loopback: false });
    expect(validateEndpoint("file:///etc/passwd").ok).toBe(false);
    expect(validateEndpoint("http://user:pw@host/mcp").ok).toBe(false);
  });
});

describe("toolDrafts / buildLocalManifest (D-107 policy defaults)", () => {
  it("derives risk from the server's hints; unknown is READ_ONLY; WRITE is locked to confirmation", () => {
    const drafts = toolDrafts(PROBE);
    expect(drafts.map((d) => [d.toolName, d.riskLevel, d.confirmLocked, d.registrable])).toEqual([
      ["hello.now", "READ_ONLY", false, true],
      ["files.delete", "WRITE", true, true],
      ["plain", "READ_ONLY", false, true],
      ["bad name!", "READ_ONLY", false, false],
    ]);
    expect(defaultChoices(drafts).every((c) => c.confirm)).toBe(true);
    expect(defaultChoices(drafts).find((c) => c.toolName === "bad name!")!.enabled).toBe(false);
  });

  it("confirms by default, honours a per-tool opt-out, never un-confirms a WRITE tool, and names the local user", () => {
    const choices = defaultChoices(toolDrafts(PROBE)).map((c) => ({ ...c, confirm: c.toolName === "hello.now" ? false : c.confirm }));
    choices.find((c) => c.toolName === "files.delete")!.confirm = false; // user tried to turn it off
    const built = buildLocalManifest({ alias: "hello-local", transport: { kind: "HTTP", endpoint: "http://127.0.0.1:1/mcp" }, probe: PROBE, choices, id: "id-1" });
    if (!built.ok) throw new Error(built.message);
    const tools = built.manifest.declared_tools as Record<string, unknown>[];
    const byName = Object.fromEntries(tools.map((t) => [t.tool_name, t]));
    expect(Object.keys(byName)).toEqual(["hello.now", "files.delete", "plain"]); // "bad name!" excluded
    expect(byName["hello.now"].confirmation_policy).toBe("NEVER");
    expect(byName["files.delete"].confirmation_policy).toBe("ALWAYS");
    expect(byName["plain"].confirmation_policy).toBe("ALWAYS");
    expect(byName["hello.now"].permissions).toEqual({ allowed_roles: ["USER"], allowed_orgs: ["miracom"] });
    expect(built.manifest).toMatchObject({
      server_alias: "hello-local",
      provenance: "THIRD_PARTY",
      tools_snapshot_hash: PROBE.tools_snapshot_hash,
      protocol_version: "2026-07-28",
    });
  });

  it("refuses a manifest with no tools selected", () => {
    const choices = defaultChoices(toolDrafts(PROBE)).map((c) => ({ ...c, enabled: false }));
    expect(buildLocalManifest({ alias: "x-y", transport: {}, probe: PROBE, choices }).ok).toBe(false);
  });
});

describe("copyServerSource", () => {
  it("copies the entry file's folder without venvs, caches, VCS or symlink targets", () => {
    const src = tempDir();
    fs.writeFileSync(path.join(src, "server.py"), "print()");
    fs.mkdirSync(path.join(src, "lib"));
    fs.writeFileSync(path.join(src, "lib", "util.py"), "x = 1");
    for (const skip of [".venv", "__pycache__", ".git", "node_modules"]) {
      fs.mkdirSync(path.join(src, skip));
      fs.writeFileSync(path.join(src, skip, "big.bin"), "x");
    }
    const dest = path.join(tempDir(), "source");
    const result = copyServerSource(path.join(src, "server.py"), dest);
    expect(result).toMatchObject({ ok: true, files: 2 });
    expect(fs.existsSync(path.join(dest, "lib", "util.py"))).toBe(true);
    expect(fs.existsSync(path.join(dest, ".venv"))).toBe(false);
  });

  it("refuses a folder with too many files instead of copying a whole drive", () => {
    const src = tempDir();
    for (let i = 0; i <= MAX_COPY_FILES; i += 1) fs.writeFileSync(path.join(src, `f${i}.txt`), "");
    const dest = path.join(tempDir(), "source");
    expect(copyServerSource(path.join(src, "f0.txt"), dest).ok).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
  });
});

function fakeRuntime(opts: { probeError?: { status: number; code: string }; registered?: string[] } = {}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init?.method ?? "GET", url, body });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/probe")) {
      if (opts.probeError) return json(opts.probeError.status, { error: { code: opts.probeError.code, message: opts.probeError.code } });
      return json(200, { ...PROBE, trace_id: "t" });
    }
    if (init?.method === "POST") return json(200, { entry: { state: "ACTIVE", tool_names: body.manifest.declared_tools.map((t: { tool_name: string }) => t.tool_name) }, trace_id: "t" });
    if (init?.method === "DELETE") return json(200, { removed: true });
    return json(404, {});
  }) as typeof fetch;
  return { calls, fetchImpl, registered: new Set(opts.registered ?? []) };
}

function manager(rt: ReturnType<typeof fakeRuntime>) {
  const root = path.join(tempDir(), "mcp-servers");
  fs.mkdirSync(root);
  const store = new LocalMcpServerStore(tempDir());
  const m = new LocalMcpServerManager({
    mcpServersRoot: root,
    store,
    agentRuntimeBaseUrl: () => "http://127.0.0.1:8100",
    listRegisteredAliases: async () => ({ ok: true, aliases: rt.registered }),
    fetchImpl: rt.fetchImpl,
    now: () => new Date("2026-09-29T01:02:03Z"),
  });
  return { m, root, store };
}

function serverFile(): string {
  const dir = tempDir();
  const file = path.join(dir, "server.py");
  fs.writeFileSync(file, "# mcp server");
  return file;
}

describe("LocalMcpServerManager", () => {
  it("prepare copies under the install root and probes the copy; add registers DESKTOP_LOCAL and records it", async () => {
    const rt = fakeRuntime();
    const { m, root, store } = manager(rt);
    const prepared = await m.prepare({ kind: "STDIO", alias: "hello-local", entryFile: serverFile() });
    if (!prepared.ok) throw new Error(prepared.message);
    const probeCall = rt.calls.find((c) => c.url.endsWith("/probe"))!;
    const installPath = (probeCall.body as { install_path: string }).install_path;
    expect(installPath.startsWith(path.join(root, LOCAL_MCP_DIR, "hello-local"))).toBe(true);
    expect(fs.existsSync(path.join(installPath, "server.py"))).toBe(true);
    expect((probeCall.body as { transport: unknown }).transport).toEqual({ kind: "STDIO", interpreter: "python", entrypoint: "server.py", args: [] });

    const added = await m.add(prepared.draftId, prepared.choices);
    expect(added).toMatchObject({ ok: true, alias: "hello-local" });
    const reg = rt.calls.find((c) => c.method === "POST" && c.url.endsWith("/mcp-servers"))!;
    expect((reg.body as { source: string }).source).toBe("DESKTOP_LOCAL");
    expect((reg.body as { install_path: string }).install_path).toBe(installPath);
    expect(store.get("hello-local")).toMatchObject({ kind: "STDIO", installPath });
    expect(m.list()).toEqual([expect.objectContaining({ alias: "hello-local", toolCount: 3 })]);
  });

  it("refuses an alias that is already in use by a hub-installed server", async () => {
    const rt = fakeRuntime({ registered: ["hello-mcp"] });
    const { m } = manager(rt);
    const result = await m.prepare({ kind: "STDIO", alias: "hello-mcp", entryFile: serverFile() });
    expect(result.ok).toBe(false);
    expect(rt.calls).toHaveLength(0);
  });

  it("refuses non-.py files, and cleans up the copy when the probe fails", async () => {
    const rt = fakeRuntime({ probeError: { status: 502, code: "handshake_failed" } });
    const { m, root } = manager(rt);
    const txt = path.join(tempDir(), "server.txt");
    fs.writeFileSync(txt, "");
    expect((await m.prepare({ kind: "STDIO", alias: "a-b", entryFile: txt })).ok).toBe(false);

    const failed = await m.prepare({ kind: "STDIO", alias: "hello-local", entryFile: serverFile() });
    expect(failed).toEqual({ ok: false, message: guidanceForProbeFailure("handshake_failed", "") });
    expect(fs.existsSync(path.join(root, LOCAL_MCP_DIR, "hello-local"))).toBe(false);
  });

  it("HTTP servers copy nothing and warn when the address is not this PC", async () => {
    const rt = fakeRuntime();
    const { m, root } = manager(rt);
    const prepared = await m.prepare({ kind: "HTTP", alias: "remote-one", endpoint: "https://mcp.example.com/mcp" });
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.warnings.join(" ")).toContain("이 PC가 아닌 주소");
    expect(fs.existsSync(path.join(root, LOCAL_MCP_DIR))).toBe(false);
    expect((rt.calls.find((c) => c.url.endsWith("/probe"))!.body as { install_path: unknown }).install_path).toBeNull();
  });

  it("remove deregisters, forgets and deletes the copy, never the original", async () => {
    const rt = fakeRuntime();
    const { m, root, store } = manager(rt);
    const original = serverFile();
    const prepared = await m.prepare({ kind: "STDIO", alias: "hello-local", entryFile: original });
    if (!prepared.ok) throw new Error(prepared.message);
    await m.add(prepared.draftId, prepared.choices);
    const result = await m.remove("hello-local");
    expect(result.ok).toBe(true);
    expect(rt.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/mcp-servers/hello-local"))).toBe(true);
    expect(store.get("hello-local")).toBeUndefined();
    expect(fs.existsSync(path.join(root, LOCAL_MCP_DIR, "hello-local"))).toBe(false);
    expect(fs.existsSync(original)).toBe(true);
  });

  it("reconcile re-registers recorded servers the runtime lost on restart", async () => {
    const rt = fakeRuntime();
    const { m, store } = manager(rt);
    const prepared = await m.prepare({ kind: "HTTP", alias: "remote-one", endpoint: "http://127.0.0.1:9/mcp" });
    if (!prepared.ok) throw new Error(prepared.message);
    await m.add(prepared.draftId, prepared.choices);
    rt.calls.length = 0;
    expect(await reconcileLocalMcpServers(store, "http://127.0.0.1:8100", new Set(["remote-one"]), rt.fetchImpl)).toEqual({ restoredCount: 0, failedCount: 0 });
    expect(await reconcileLocalMcpServers(store, "http://127.0.0.1:8100", new Set(), rt.fetchImpl)).toEqual({ restoredCount: 1, failedCount: 0 });
    expect((rt.calls[0].body as { source: string }).source).toBe("DESKTOP_LOCAL");
  });
});
