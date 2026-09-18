// D-096 desktop half — 설치한 MCP 서버를 agent-runtime 에 등록(활성화)한다.
//
// 왜 별도 파일인가: 파일을 놓는 것(`bundle-install.ts`)과 그 서버를 실제로 쓸
// 수 있게 하는 것은 다른 일이고, 실패하는 이유도 완전히 다르다. 설치는
// 성공했는데 활성화가 거부되는 경우가 **정상적으로** 존재한다 — stdio 는 이
// PC 에서 실제로 프로세스를 띄우는 경로라 운영자가 켜 줘야만 동작하기
// 때문이다. 그래서 활성화 실패는 설치 실패가 아니라 WARN 이다.
//
// `mcp-tool-connection.ts`(D-080)와 같은 분업이다: HTTP 는 주입 가능한
// `FetchLike` 뒤에, 판정에 필요한 순수 계산은 여기에, fs 접근은 호출자가
// 넘겨 준 경로로만.
//
// **거부 사유를 그대로 보여 주지 않는다.** 서버가 돌려주는 것은 기계가 읽는
// 이름(`install_path_outside_allowed_roots` 등)이고, 사용자는 그것을 보고
// 무엇을 해야 할지 알 수 없다. 사유를 한국어로 옮기는 것이 아니라 **조치**를
// 적는다 — 이 파일이 `src/screens/mcpServersTypes.ts` 의 `REFUSAL_GUIDANCE` 와
// 같은 원칙을 따르되, 여기서는 "방금 설치한 직후"라는 맥락이 있어 문구가 더
// 구체적이다(설치 경로를 실제로 알고 있다).

export type FetchLike = typeof fetch;

export interface McpServerActivationTarget {
  assetId: string;
  version: string;
  /** 설치된 자산 폴더 안에서 실제 코드가 놓인 경로. */
  installPath: string;
  /** 설치된 `manifest.json` 의 내용. */
  manifest: Record<string, unknown>;
}

export interface McpServerActivationOutcome {
  status: "PASS" | "WARN";
  message: string;
  /** 기계용 사유 — 로그/테스트용이며 사용자 문구는 `message` 다. */
  reason?: string;
  serverAlias: string;
}

/** 조치 문구. 사유를 옮기지 않고 무엇을 하면 되는지 적는다. */
function guidanceFor(reason: string | undefined, installPath: string): string {
  switch (reason) {
    case "mcp_server_registration_disabled":
      return "MCP 서버 등록 기능이 꺼져 있습니다. 관리자에게 agent-runtime 설정에서 등록을 켜 달라고 요청하세요.";
    case "stdio_not_allowed_in_hosted_mode":
      return "공유 서버에서는 내 PC에서 직접 실행하는 서버를 띄울 수 없습니다. 이 서버는 개인 PC의 Desktop에서만 사용할 수 있습니다.";
    case "install_path_outside_allowed_roots":
      return `설치 위치가 실행이 허용된 폴더 밖입니다. 관리자에게 이 경로를 허용 목록에 추가해 달라고 요청하세요: ${installPath}`;
    case "interpreter_not_configured":
      return "이 서버를 실행할 프로그램(Python/Node)이 지정되어 있지 않습니다. 관리자에게 agent-runtime 설정을 요청하세요.";
    case "entrypoint_not_found":
      return "실행할 시작 파일이 설치된 폴더에 없습니다. 자산 상세에서 시작 파일이 함께 등록되었는지 확인하세요.";
    case "handshake_failed":
    case "tools_list_failed":
      return "서버에 연결하지 못했습니다. 잠시 후 다시 시도하거나, 자산 등록자에게 문의하세요.";
    case "agent_runtime_unreachable":
      return "agent-runtime에 연결하지 못했습니다. 설정 화면에서 주소를 확인하고 실행 중인지 확인하세요.";
    default:
      return "MCP 서버를 활성화하지 못했습니다. 설치 자체는 완료되었으며, 관리자에게 문의하세요.";
  }
}

/** 이 자산이 활성화 대상인가.
 *
 * 주소로 연결하는(HTTP) 서버도 등록 대상이다 — 코드가 없을 뿐 등록은 똑같이
 * 필요하다. 걸러 내는 것은 매니페스트를 읽을 수 없는 경우뿐이다.
 */
export function serverAliasOf(manifest: Record<string, unknown>): string | null {
  const alias = manifest.server_alias;
  return typeof alias === "string" && alias.trim() ? alias.trim() : null;
}

/** 이 서버가 stdio 라서 `install_path` 가 필요한가. HTTP 는 로컬에서 실행하는
 * 것이 없으므로 경로를 보내지 않는다 — 보내면 실행과 무관한 경로 검사에
 * 걸린다(agent-runtime `connection.py` 가 같은 이유로 HTTP 에서는 경로를
 * 요구하지 않는다). */
export function needsInstallPath(manifest: Record<string, unknown>): boolean {
  const transport = manifest.transport;
  if (typeof transport !== "object" || transport === null) return false;
  return (transport as Record<string, unknown>).kind === "STDIO";
}

export async function activateInstalledMcpServer(
  agentRuntimeBaseUrl: string,
  target: McpServerActivationTarget,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 30_000,
): Promise<McpServerActivationOutcome> {
  const alias = serverAliasOf(target.manifest) ?? target.assetId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${agentRuntimeBaseUrl.replace(/\/+$/, "")}/local/v1/mcp-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: target.manifest,
        install_path: needsInstallPath(target.manifest) ? target.installPath : null,
        source: "OFFLINE_BUNDLE",
      }),
      signal: controller.signal,
    });
  } catch {
    return {
      status: "WARN",
      reason: "agent_runtime_unreachable",
      message: guidanceFor("agent_runtime_unreachable", target.installPath),
      serverAlias: alias,
    };
  } finally {
    clearTimeout(timer);
  }

  const body = (await res.json().catch(() => null)) as
    | { entry?: { server_alias?: string; tool_names?: string[] }; error?: { code?: string } }
    | null;

  if (!res.ok) {
    const reason = body?.error?.code;
    return {
      status: "WARN",
      reason,
      message: guidanceFor(reason, target.installPath),
      serverAlias: alias,
    };
  }

  const toolCount = body?.entry?.tool_names?.length ?? 0;
  return {
    status: "PASS",
    message: `'${body?.entry?.server_alias ?? alias}' 활성화됨 — 기능 ${toolCount}개를 사용할 수 있습니다.`,
    serverAlias: body?.entry?.server_alias ?? alias,
  };
}

export type RegisteredMcpServersResult =
  | { ok: true; aliases: Set<string> }
  | { ok: false; message: string };

/** agent-runtime 에 **지금** 등록돼 있는 서버 alias 들.
 *
 * `state` 를 가리지 않는다 — 서버 쪽에서 FAILED/UNREACHABLE 로 남아 있는
 * 것은 이미 누군가 시도했고 그 결과가 서버에 남아 있다는 뜻이므로, 다시
 * 등록할 대상(= 목록에 **없는** 것)이 아니다. 도달하지 못하면 "없음"으로
 * 지어내지 않고 `ok: false` 를 돌려준다.
 */
export async function listRegisteredMcpServerAliases(
  agentRuntimeBaseUrl: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 10_000,
): Promise<RegisteredMcpServersResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${agentRuntimeBaseUrl.replace(/\/+$/, "")}/local/v1/mcp-servers`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, message: `agent-runtime이 MCP 서버 목록 요청을 거부했습니다 (HTTP ${res.status}).` };
    }
    const body = (await res.json().catch(() => null)) as { entries?: Array<{ server_alias?: unknown }> } | null;
    if (!body || !Array.isArray(body.entries)) {
      return { ok: false, message: "agent-runtime의 MCP 서버 목록 응답을 해석하지 못했습니다." };
    }
    const aliases = new Set<string>();
    for (const entry of body.entries) {
      if (typeof entry?.server_alias === "string") aliases.add(entry.server_alias);
    }
    return { ok: true, aliases };
  } catch {
    return { ok: false, message: guidanceFor("agent_runtime_unreachable", "") };
  } finally {
    clearTimeout(timer);
  }
}
