// D-107 — MCP servers the user adds in Desktop directly, the way ordinary MCP
// clients do: a local Python file or an HTTP address, no Portal approval.
// Design: docs/implementation-spec/05-mcp-security-governance.md §15.
//
// Flow: prepare (copy the server folder under the install root, then
// `POST /local/v1/mcp-servers/probe`) → the user picks tools and per-tool
// confirmation → add (generate a manifest, `POST /local/v1/mcp-servers` with
// source DESKTOP_LOCAL, record it in state/local-mcp-servers.json). The
// record lets startup re-register it, because agent-runtime keeps its
// registry in memory only.
//
// What this module does NOT relax: agent-runtime still only runs code under
// its install root (hence the copy — the user's folder is outside it), only
// on the configured interpreter, with env={}, and every call still passes
// its Policy Enforcement Point. Policy defaults here are the user's decision
// (2026-09-29): confirmation ALWAYS by default, switchable per tool; a WRITE
// tool is always confirmed (the manifest schema forbids WRITE + NEVER).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LocalMcpServerInput, LocalMcpToolChoice, LocalMcpToolDraft } from "./types";

export type { LocalMcpServerInput, LocalMcpToolChoice, LocalMcpToolDraft };

export type FetchLike = typeof fetch;

/** Folder under `<assets>/mcp-servers/` that holds user-added servers, kept
 * apart from hub-installed assets (`<assets>/mcp-servers/<assetId>/...`). */
export const LOCAL_MCP_DIR = "_local";
export const MAX_COPY_BYTES = 50 * 1024 * 1024;
export const MAX_COPY_FILES = 2000;
const EXCLUDED_NAMES = new Set([".venv", "venv", "__pycache__", ".git", "node_modules", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".idea", ".vscode"]);
// Same patterns as mcp-server-manifest.schema.json.
const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;
const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*){0,4}$/;
const PROTOCOL_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ProbedTool {
  tool_name: string;
  description: string | null;
  input_schema: Record<string, unknown>;
  read_only_hint: boolean | null;
  destructive_hint: boolean | null;
}

export interface ProbeResponse {
  protocol_version: string;
  server_name: string | null;
  tools: ProbedTool[];
  tools_snapshot_hash: string;
  local_user_context: { organization_id: string; roles: string[] };
}

export interface LocalMcpServerRecord {
  alias: string;
  kind: "STDIO" | "HTTP";
  /** What the user pointed at: the original .py file, or the endpoint. */
  source: string;
  /** Copied bundle root for STDIO (under the install root), null for HTTP. */
  installPath: string | null;
  manifest: Record<string, unknown>;
  addedAt: string;
}

export function validateServerAlias(alias: string): string | null {
  if (!ALIAS_PATTERN.test(alias)) {
    return "이름은 영문 소문자로 시작하고 영문 소문자·숫자·하이픈(-)만 쓸 수 있습니다(2~64자, 하이픈으로 끝날 수 없음).";
  }
  return null;
}

export function validateEndpoint(endpoint: string): { ok: true; loopback: boolean } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, message: "주소 형식이 올바르지 않습니다. 예: http://127.0.0.1:8000/mcp" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "http:// 또는 https:// 주소만 쓸 수 있습니다." };
  }
  if (url.username || url.password) return { ok: false, message: "주소에 계정 정보를 넣을 수 없습니다." };
  return { ok: true, loopback: ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) };
}

/** Risk from the server's own hints. Unknown → READ_ONLY: a WRITE tool is
 * never offered to the model (D-083), so defaulting unknown tools to WRITE
 * would make most of them unusable; the confirmation default covers it. */
export function toolDrafts(probe: ProbeResponse): LocalMcpToolDraft[] {
  return probe.tools.map((tool) => {
    const write = tool.destructive_hint === true || tool.read_only_hint === false;
    return {
      toolName: tool.tool_name,
      description: tool.description,
      riskLevel: write ? "WRITE" : "READ_ONLY",
      registrable: TOOL_NAME_PATTERN.test(tool.tool_name) && tool.tool_name.length <= 128,
      confirmLocked: write,
    };
  });
}

export function defaultChoices(drafts: LocalMcpToolDraft[]): LocalMcpToolChoice[] {
  return drafts.map((d) => ({ toolName: d.toolName, enabled: d.registrable, confirm: true }));
}

export function buildLocalManifest(input: {
  alias: string;
  transport: Record<string, unknown>;
  probe: ProbeResponse;
  choices: LocalMcpToolChoice[];
  id?: string;
}): { ok: true; manifest: Record<string, unknown> } | { ok: false; message: string } {
  const { alias, probe } = input;
  const aliasError = validateServerAlias(alias);
  if (aliasError) return { ok: false, message: aliasError };
  const byName = new Map(probe.tools.map((t) => [t.tool_name, t]));
  const drafts = new Map(toolDrafts(probe).map((d) => [d.toolName, d]));
  const { organization_id: org, roles } = probe.local_user_context;
  const declared = input.choices
    .filter((c) => c.enabled && drafts.get(c.toolName)?.registrable)
    .map((c) => {
      const tool = byName.get(c.toolName)!;
      const draft = drafts.get(c.toolName)!;
      const entry: Record<string, unknown> = {
        tool_name: tool.tool_name,
        input_schema: tool.input_schema ?? {},
        risk_level: draft.riskLevel,
        permissions: { allowed_roles: [...roles], allowed_orgs: [org] },
        confirmation_policy: draft.confirmLocked || c.confirm ? "ALWAYS" : "NEVER",
      };
      if (tool.description) entry.label = tool.description.slice(0, 200);
      return entry;
    });
  if (declared.length === 0) return { ok: false, message: "사용할 도구를 하나 이상 고르세요." };
  return {
    ok: true,
    manifest: {
      schema_version: "1.0",
      id: input.id ?? crypto.randomUUID(),
      type: "mcp_server",
      name: probe.server_name?.trim() || alias,
      version: "1.0.0",
      owner: { org, creator_id: "desktop-local-user" },
      classification: "INTERNAL",
      description: "Desktop에서 사용자가 직접 추가한 MCP 서버 (D-107, 허브 승인 없음)",
      server_alias: alias,
      provenance: "THIRD_PARTY",
      protocol_version: PROTOCOL_VERSION_PATTERN.test(probe.protocol_version) ? probe.protocol_version : "2025-06-18",
      transport: input.transport,
      declared_tools: declared,
      tools_snapshot_hash: probe.tools_snapshot_hash,
    },
  };
}

/** Copies the folder that holds `entryFile` to `destDir`, skipping virtualenvs,
 * caches, VCS folders and symlinks, within size/count caps. */
export function copyServerSource(entryFile: string, destDir: string): { ok: true; files: number; bytes: number } | { ok: false; message: string } {
  const srcDir = path.dirname(entryFile);
  let files = 0;
  let bytes = 0;
  const plan: { from: string; to: string }[] = [];
  const walk = (dir: string, rel: string): string | null => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDED_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;
      const from = path.join(dir, entry.name);
      const to = path.join(destDir, rel, entry.name);
      if (entry.isDirectory()) {
        const err = walk(from, path.join(rel, entry.name));
        if (err) return err;
      } else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(from).size;
        if (files > MAX_COPY_FILES) return `파일이 ${MAX_COPY_FILES}개를 넘습니다. 서버 파일만 있는 폴더를 고르세요.`;
        if (bytes > MAX_COPY_BYTES) return `폴더 크기가 ${MAX_COPY_BYTES / 1024 / 1024}MB를 넘습니다. 서버 파일만 있는 폴더를 고르세요.`;
        plan.push({ from, to });
      }
    }
    return null;
  };
  try {
    const err = walk(srcDir, "");
    if (err) return { ok: false, message: err };
    for (const { from, to } of plan) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  } catch (err) {
    return { ok: false, message: `서버 폴더를 복사하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, files, bytes };
}

export class LocalMcpServerStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, "local-mcp-servers.json");
  }

  list(): LocalMcpServerRecord[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      return Array.isArray(parsed) ? (parsed as LocalMcpServerRecord[]) : [];
    } catch {
      return []; // missing or corrupted: treat as empty, never crash the app
    }
  }

  get(alias: string): LocalMcpServerRecord | undefined {
    return this.list().find((r) => r.alias === alias);
  }

  put(record: LocalMcpServerRecord): void {
    this.save([...this.list().filter((r) => r.alias !== record.alias), record]);
  }

  remove(alias: string): void {
    this.save(this.list().filter((r) => r.alias !== alias));
  }

  private save(records: LocalMcpServerRecord[]): void {
    fs.writeFileSync(this.filePath, JSON.stringify(records, null, 2), "utf-8");
  }
}

type RuntimeCall<T> = { ok: true; value: T } | { ok: false; code: string | null; message: string };

async function postJson<T>(url: string, body: unknown, fetchImpl: FetchLike, timeoutMs: number): Promise<RuntimeCall<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
    if (!res.ok) {
      return { ok: false, code: json?.error?.code ?? null, message: json?.error?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, value: json as T };
  } catch {
    return { ok: false, code: "agent_runtime_unreachable", message: "agent-runtime에 연결하지 못했습니다." };
  } finally {
    clearTimeout(timer);
  }
}

export function probeMcpServer(baseUrl: string, transport: Record<string, unknown>, installPath: string | null, fetchImpl: FetchLike = fetch) {
  return postJson<ProbeResponse>(`${baseUrl.replace(/\/+$/, "")}/local/v1/mcp-servers/probe`, { transport, install_path: installPath }, fetchImpl, 40_000);
}

export function registerLocalMcpServer(baseUrl: string, manifest: Record<string, unknown>, installPath: string | null, fetchImpl: FetchLike = fetch) {
  return postJson<{ entry: { state: string; tool_names: string[] } }>(
    `${baseUrl.replace(/\/+$/, "")}/local/v1/mcp-servers`,
    { manifest, install_path: installPath, source: "DESKTOP_LOCAL" },
    fetchImpl,
    40_000,
  );
}

export async function deregisterMcpServerAlias(baseUrl: string, alias: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/local/v1/mcp-servers/${encodeURIComponent(alias)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Re-registers recorded local servers missing from agent-runtime (its
 * registry is in memory). Unreachable runtime → nothing changes. */
export async function reconcileLocalMcpServers(
  store: LocalMcpServerStore,
  baseUrl: string,
  registeredAliases: ReadonlySet<string>,
  fetchImpl: FetchLike = fetch,
): Promise<{ restoredCount: number; failedCount: number }> {
  let restoredCount = 0;
  let failedCount = 0;
  for (const record of store.list()) {
    if (registeredAliases.has(record.alias)) continue;
    const result = await registerLocalMcpServer(baseUrl, record.manifest, record.installPath, fetchImpl);
    if (result.ok) restoredCount += 1;
    else failedCount += 1;
  }
  return { restoredCount, failedCount };
}

export function localServerDir(mcpServersRoot: string, alias: string): string {
  return path.join(mcpServersRoot, LOCAL_MCP_DIR, alias);
}
