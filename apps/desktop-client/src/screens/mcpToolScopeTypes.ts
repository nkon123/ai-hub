// D06 대화 — "MCP 도구" 고르기 패널의 순수 로직(범위 계산과 표시).
//
// 이 화면이 정하는 것은 **범위뿐**이다: 어떤 Tool 을 후보로 둘 것인가.
// 그 안에서 실제로 무엇을 부를지(또는 아무것도 부르지 않을지)는 agent-runtime
// 의 TOOL_ROUTE 가 정하고, 실행 승인은 그 뒤 PEP 가 정한다. 그래서 여기에는
// "이 Tool 을 반드시 실행한다"는 상태가 없다 — 있으면 사용자는 질문과 무관한
// 도구가 매번 실행되는 것을 보게 된다.
//
// 서버는 이 목록을 **좁히는 데만** 쓴다(`mcp_tools.filter_candidates_to_scope`).
// 여기서 고른 이름이 후보에 없으면 그냥 버려진다 — 화면의 선택이 권한이 되지
// 않는다는 뜻이고, 이 파일이 그 사실을 바꿀 수는 없다.

/** 패널이 보여주는 서버 하나. `agentRuntime.listMcpServers()` 의 entry 중
 * 이 화면에 필요한 것만 추린 모양이다. */
export interface McpServerOption {
  serverAlias: string;
  toolNames: string[];
  /** `ACTIVE` 가 아니면 고를 수 없다(부를 수 없는 Tool 은 후보가 되어도
   * 라우팅이 매번 실패로 끝난다). 이유는 화면이 그대로 보여 준다. */
  state: string;
  reason?: string | null;
}

/**
 * 대화 한 턴에 적용할 MCP Tool 범위.
 *
 * - `off`: 아무것도 고르지 않음 — Tool 을 쓰지 않는다(기본값).
 * - `auto`: 이 배포가 허용하는 후보 **전체**에서 AI 가 고른다(패널 첫 줄).
 * - `selected`: 고른 Tool 들 안에서만 AI 가 고른다.
 */
export type McpToolScope =
  | { kind: "off" }
  | { kind: "auto" }
  | { kind: "selected"; toolNames: string[] };

export const SCOPE_OFF: McpToolScope = { kind: "off" };
export const SCOPE_AUTO: McpToolScope = { kind: "auto" };

/** `GET /local/v1/mcp-servers` entry 를 이 화면의 선택 모델로 옮긴다.
 *
 * 상태 **표시**(라벨/안내/재시도 가능 여부)는 옮기지 않는다 — 그것은
 * `mcpServersTypes.describeServerStatus` 가 이미 소유하고 있고, 여기서 문구를
 * 다시 만들면 같은 상태가 화면마다 다르게 불린다. */
export function optionFromEntry(entry: {
  server_alias: string;
  tool_names?: string[] | null;
  state: string;
  reason?: string | null;
}): McpServerOption {
  return {
    serverAlias: entry.server_alias,
    toolNames: entry.tool_names ?? [],
    state: entry.state,
    reason: entry.reason ?? null,
  };
}

export function isServerSelectable(server: McpServerOption): boolean {
  return server.state === "ACTIVE" && server.toolNames.length > 0;
}

function selectedNames(scope: McpToolScope): string[] {
  return scope.kind === "selected" ? scope.toolNames : [];
}

/** 고른 Tool 목록을 정규화한 범위로 만든다(빈 목록은 `off`). */
export function scopeFromToolNames(toolNames: string[]): McpToolScope {
  const unique = Array.from(new Set(toolNames.filter((name) => name.trim())));
  return unique.length === 0 ? SCOPE_OFF : { kind: "selected", toolNames: unique };
}

/** Tool 하나를 켜고 끈다. `auto` 상태에서 개별 Tool 을 건드리면 그 Tool 하나만
 * 고른 상태가 된다 — "전체에서 고르기"와 "이것만"은 다른 의도이고, 둘을 섞으면
 * 무엇이 후보인지 화면이 설명할 수 없다. */
export function toggleTool(scope: McpToolScope, toolName: string): McpToolScope {
  if (scope.kind !== "selected") return scopeFromToolNames([toolName]);
  const current = selectedNames(scope);
  return scopeFromToolNames(
    current.includes(toolName) ? current.filter((name) => name !== toolName) : [...current, toolName],
  );
}

/** 서버 이름을 누르면 그 서버의 Tool 전체를 켜고 끈다(이미 전부 켜져 있으면 끈다). */
export function toggleServer(scope: McpToolScope, server: McpServerOption): McpToolScope {
  if (!isServerSelectable(server)) return scope;
  const current = scope.kind === "selected" ? selectedNames(scope) : [];
  const allOn = server.toolNames.every((name) => current.includes(name));
  if (allOn) {
    return scopeFromToolNames(current.filter((name) => !server.toolNames.includes(name)));
  }
  return scopeFromToolNames([...current, ...server.toolNames]);
}

export function isToolSelected(scope: McpToolScope, toolName: string): boolean {
  return selectedNames(scope).includes(toolName);
}

export type ServerSelectionState = "none" | "partial" | "all";

export function serverSelectionState(
  scope: McpToolScope,
  server: McpServerOption,
): ServerSelectionState {
  if (scope.kind !== "selected" || server.toolNames.length === 0) return "none";
  const chosen = server.toolNames.filter((name) => isToolSelected(scope, name));
  if (chosen.length === 0) return "none";
  return chosen.length === server.toolNames.length ? "all" : "partial";
}

/** Run 요청으로 보낼 값.
 *
 * `toolRoute` 가 꺼져 있으면 서버는 TOOL_ROUTE 단계 자체를 돌지 않는다.
 * `mcpToolNames` 를 **생략**하는 것이 "후보 전체"이고, 빈 배열은 서버에서
 * "고른 것이 없음"이라는 다른 뜻이므로 여기서는 절대 빈 배열을 만들지 않는다. */
export function scopeToRunParams(scope: McpToolScope): {
  toolRoute: boolean;
  mcpToolNames?: string[];
} {
  if (scope.kind === "off") return { toolRoute: false };
  if (scope.kind === "auto") return { toolRoute: true };
  return { toolRoute: true, mcpToolNames: scope.toolNames };
}

/** 입력창 버튼에 붙는 짧은 표시. `null` 이면 아무것도 붙이지 않는다. */
export function describeScopeBadge(scope: McpToolScope, servers: McpServerOption[]): string | null {
  if (scope.kind === "off") return null;
  if (scope.kind === "auto") return "자동";
  const fullyChosen = servers.filter((server) => serverSelectionState(scope, server) === "all");
  if (fullyChosen.length === 1 && scope.toolNames.length === fullyChosen[0].toolNames.length) {
    return fullyChosen[0].serverAlias;
  }
  return `도구 ${scope.toolNames.length}개`;
}

/** 패널 안에서 "지금 무엇이 후보인가"를 한 문장으로. 고른 Tool 이 사라진
 * 서버(등록 해제/비활성)를 가리키고 있으면 그 사실도 함께 말한다 — 조용히
 * 빼 버리면 켜 둔 줄 알았던 것이 꺼져 있다. */
export function describeScope(scope: McpToolScope, servers: McpServerOption[]): string {
  if (scope.kind === "off") return "고른 도구가 없어 이번 대화에서는 Tool을 쓰지 않습니다.";
  if (scope.kind === "auto") {
    const usable = servers.filter(isServerSelectable);
    const count = usable.reduce((sum, server) => sum + server.toolNames.length, 0);
    return usable.length === 0
      ? "쓸 수 있는 MCP 서버가 없습니다. 자산 허브에서 서버를 설치·활성화하세요."
      : `연결된 서버 ${usable.length}개의 도구 ${count}개 중에서 AI가 고릅니다.`;
  }
  const available = new Set(servers.filter(isServerSelectable).flatMap((s) => s.toolNames));
  const missing = scope.toolNames.filter((name) => !available.has(name));
  const base = `고른 도구 ${scope.toolNames.length}개 중에서 AI가 고릅니다.`;
  return missing.length === 0
    ? base
    : `${base} 이 중 ${missing.length}개(${missing.join(", ")})는 지금 연결된 서버에 없어 후보에서 빠집니다.`;
}
