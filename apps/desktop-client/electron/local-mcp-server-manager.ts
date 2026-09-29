// D-107 — orchestration behind the "MCP 서버 추가" IPC handlers: prepare
// (copy + probe) → add (manifest + register + record) → remove. Kept out of
// main.ts so the whole sequence is unit-tested with a fake fetch
// (`__tests__/local-mcp-server-manager.test.ts`). Pure pieces live in
// `local-mcp-servers.ts`.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildLocalManifest,
  copyServerSource,
  defaultChoices,
  deregisterMcpServerAlias,
  localServerDir,
  probeMcpServer,
  registerLocalMcpServer,
  toolDrafts,
  validateEndpoint,
  validateServerAlias,
  type FetchLike,
  type LocalMcpServerInput,
  type LocalMcpServerStore,
  type LocalMcpToolChoice,
  type ProbeResponse,
} from "./local-mcp-servers";
import type {
  AddLocalMcpServerResult,
  LocalMcpServerSummary,
  PrepareLocalMcpServerResult,
  RemoveLocalMcpServerResult,
} from "./types";

/** User-facing guidance per refusal code: what to do, not the raw code. */
export function guidanceForProbeFailure(code: string | null, message: string): string {
  switch (code) {
    case "handshake_failed":
      return "서버를 실행했지만 MCP 연결에 실패했습니다. MCP 서버 파일이 맞는지, 표준 출력(print)에 다른 내용을 쓰지 않는지, 필요한 패키지를 불러올 수 있는지 확인하세요. 동봉된 Python에는 MCP SDK와 기본 라이브러리만 있습니다.";
    case "tools_list_failed":
      return "서버가 도구 목록(tools/list)을 돌려주지 않았습니다.";
    case "entrypoint_not_found":
      return "복사한 폴더에서 서버 파일을 찾지 못했습니다.";
    case "interpreter_not_configured":
      return "이 PC의 Runtime에 Python 실행 경로가 설정되어 있지 않습니다.";
    case "mcp_server_registration_disabled":
    case "stdio_not_allowed_in_hosted_mode":
      return "이 PC의 Runtime에서 MCP 서버 등록이 꺼져 있습니다(설치본이 아닌 개발 환경이면 agent-runtime의 .env 설정을 확인하세요).";
    case "install_path_outside_allowed_roots":
      return "Runtime이 허용하는 폴더 밖이라 실행할 수 없습니다.";
    case "manifest_invalid":
      return "서버 정보 형식이 올바르지 않습니다.";
    case "tools_snapshot_mismatch":
      return "연결 시험 뒤에 서버의 도구 구성이 바뀌었습니다. 다시 연결 시험을 하세요.";
    case "agent_runtime_unreachable":
      return "agent-runtime에 연결하지 못했습니다. 연결 상태 화면에서 Runtime을 확인하세요.";
    default:
      return message;
  }
}

interface Draft {
  input: LocalMcpServerInput;
  transport: Record<string, unknown>;
  installPath: string | null;
  aliasDir: string | null;
  probe: ProbeResponse;
}

export interface LocalMcpServerManagerDeps {
  /** `<assets>/mcp-servers` — agent-runtime's allowed install root. */
  mcpServersRoot: string;
  store: LocalMcpServerStore;
  /** Read at call time: the user can change the runtime address in settings. */
  agentRuntimeBaseUrl: () => string;
  listRegisteredAliases: (baseUrl: string) => Promise<{ ok: true; aliases: Set<string> } | { ok: false; message: string }>;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export class LocalMcpServerManager {
  private readonly drafts = new Map<string, Draft>();
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(private readonly deps: LocalMcpServerManagerDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  list(): LocalMcpServerSummary[] {
    return this.deps.store.list().map((r) => ({
      alias: r.alias,
      kind: r.kind,
      source: r.source,
      toolCount: Array.isArray(r.manifest.declared_tools) ? r.manifest.declared_tools.length : 0,
      addedAt: r.addedAt,
    }));
  }

  async prepare(input: LocalMcpServerInput): Promise<PrepareLocalMcpServerResult> {
    const aliasError = validateServerAlias(input.alias);
    if (aliasError) return { ok: false, message: aliasError };
    if (this.deps.store.get(input.alias)) {
      return { ok: false, message: `"${input.alias}" 이름으로 이미 추가한 서버가 있습니다. 다른 이름을 쓰거나 먼저 삭제하세요.` };
    }
    const baseUrl = this.deps.agentRuntimeBaseUrl();
    const registered = await this.deps.listRegisteredAliases(baseUrl);
    if (!registered.ok) return { ok: false, message: guidanceForProbeFailure("agent_runtime_unreachable", registered.message) };
    if (registered.aliases.has(input.alias)) {
      return { ok: false, message: `"${input.alias}" 이름의 서버가 이미 연결되어 있습니다(허브에서 설치한 서버일 수 있습니다). 다른 이름을 쓰세요.` };
    }

    const warnings: string[] = [];
    let transport: Record<string, unknown>;
    let installPath: string | null = null;
    let aliasDir: string | null = null;
    if (input.kind === "STDIO") {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(input.entryFile);
      } catch {
        return { ok: false, message: "선택한 파일을 찾을 수 없습니다." };
      }
      if (!stat.isFile() || path.extname(input.entryFile).toLowerCase() !== ".py") {
        return { ok: false, message: "Python 서버 파일(.py)을 고르세요." };
      }
      aliasDir = localServerDir(this.deps.mcpServersRoot, input.alias);
      // Leftovers from an abandoned attempt with this alias (no record exists).
      fs.rmSync(aliasDir, { recursive: true, force: true });
      const stamp = this.now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      installPath = path.join(aliasDir, stamp, "source");
      const copied = copyServerSource(input.entryFile, installPath);
      if (!copied.ok) {
        fs.rmSync(aliasDir, { recursive: true, force: true });
        return { ok: false, message: copied.message };
      }
      transport = { kind: "STDIO", interpreter: "python", entrypoint: path.basename(input.entryFile), args: [] };
    } else {
      const endpoint = input.endpoint.trim();
      const checked = validateEndpoint(endpoint);
      if (!checked.ok) return { ok: false, message: checked.message };
      if (!checked.loopback) {
        warnings.push("이 PC가 아닌 주소입니다. 도구를 부를 때 입력값이 이 주소로 전송됩니다.");
      }
      transport = { kind: "HTTP", endpoint };
    }

    const probed = await probeMcpServer(baseUrl, transport, installPath, this.fetchImpl);
    if (!probed.ok) {
      if (aliasDir) fs.rmSync(aliasDir, { recursive: true, force: true });
      return { ok: false, message: guidanceForProbeFailure(probed.code, probed.message) };
    }
    const tools = toolDrafts(probed.value);
    if (tools.length === 0) {
      if (aliasDir) fs.rmSync(aliasDir, { recursive: true, force: true });
      return { ok: false, message: "서버가 도구를 하나도 제공하지 않습니다." };
    }
    if (tools.some((t) => !t.registrable)) {
      warnings.push("이름 형식이 맞지 않는 도구는 추가할 수 없어 제외됩니다.");
    }
    const draftId = crypto.randomUUID();
    this.drafts.set(draftId, { input, transport, installPath, aliasDir, probe: probed.value });
    return { ok: true, draftId, serverName: probed.value.server_name, tools, choices: defaultChoices(tools), warnings };
  }

  async add(draftId: string, choices: LocalMcpToolChoice[]): Promise<AddLocalMcpServerResult> {
    const draft = this.drafts.get(draftId);
    if (!draft) return { ok: false, message: "연결 시험 결과가 없습니다. 다시 연결 시험을 하세요." };
    const built = buildLocalManifest({ alias: draft.input.alias, transport: draft.transport, probe: draft.probe, choices });
    if (!built.ok) return built;
    const result = await registerLocalMcpServer(this.deps.agentRuntimeBaseUrl(), built.manifest, draft.installPath, this.fetchImpl);
    if (!result.ok) return { ok: false, message: guidanceForProbeFailure(result.code, result.message) };
    this.deps.store.put({
      alias: draft.input.alias,
      kind: draft.input.kind,
      source: draft.input.kind === "STDIO" ? draft.input.entryFile : draft.input.endpoint.trim(),
      installPath: draft.installPath,
      manifest: built.manifest,
      addedAt: this.now().toISOString(),
    });
    this.drafts.delete(draftId);
    return { ok: true, alias: draft.input.alias, toolNames: result.value.entry.tool_names };
  }

  /** Drops an unfinished draft and its copied files. */
  cancel(draftId: string): void {
    const draft = this.drafts.get(draftId);
    if (!draft) return;
    this.drafts.delete(draftId);
    if (draft.aliasDir && !this.deps.store.get(draft.input.alias)) fs.rmSync(draft.aliasDir, { recursive: true, force: true });
  }

  /** Deregister (stops a running stdio child), forget, and delete the copy.
   * The user's original folder is never touched. */
  async remove(alias: string): Promise<RemoveLocalMcpServerResult> {
    const record = this.deps.store.get(alias);
    if (!record) return { ok: false, message: "직접 추가한 서버가 아닙니다." };
    const deregistered = await deregisterMcpServerAlias(this.deps.agentRuntimeBaseUrl(), alias, this.fetchImpl);
    this.deps.store.remove(alias);
    fs.rmSync(localServerDir(this.deps.mcpServersRoot, alias), { recursive: true, force: true });
    return {
      ok: true,
      message: deregistered ? "삭제했습니다." : "삭제했습니다. agent-runtime에 연결하지 못해 연결 해제는 다음 시작 때 반영됩니다.",
    };
  }
}
