// D-094 "MCP 서버" — McpServersScreen.tsx 를 위한 순수 헬퍼(fs/electron import
// 없음). localToolsTypes.ts / knowledgeActivation.ts 와 같은 관례다 — vitest 가
// `environment: "node"` 라 컴포넌트를 렌더링할 수 없으므로, 판정은 전부 여기로
// 빼야 단위 테스트할 수 있다.

export type McpServerState = "ACTIVE" | "FAILED" | "UNREACHABLE";
export type McpTransportKind = "HTTP" | "STDIO";

export interface McpServerEntry {
  server_alias: string;
  transport_kind: McpTransportKind;
  state: McpServerState;
  protocol_version: string;
  tool_names: string[];
  provenance?: "INTERNAL" | "THIRD_PARTY" | null;
  reason?: string | null;
  message?: string | null;
  registered_at: string;
  last_checked_at?: string | null;
}

export interface McpServersListResponse {
  entries: McpServerEntry[];
  mcp_server_registration_enabled: boolean;
  stdio_supported: boolean;
  trace_id: string;
}

// --- 거부 사유 -> 무엇을 고쳐야 하는가 --------------------------------------
// 서버가 돌려주는 사유는 기계가 읽는 이름이다(`mcp-server-registration.schema
// .json` 의 `MCPRegistrationRefusalReason`, 17개). 그것을 화면에 그대로 띄우면
// 사용자는 `entrypoint_outside_bundle` 을 보고 무엇을 해야 할지 알 수 없다.
//
// **사유를 요약하지 않고 조치를 적는다.** "설치 경로가 올바르지 않습니다"는
// 사유를 한국어로 옮긴 것일 뿐 여전히 무엇을 할지 말해 주지 않는다.
//
// 경로·해석기 위치 같은 배포 구조는 여기서도 적지 않는다 — 서버가 그것을
// 응답에 담지 않는 이유와 같다.
const REFUSAL_GUIDANCE: Record<string, string> = {
  mcp_server_registration_disabled:
    "이 PC 에서는 MCP 서버 등록이 꺼져 있습니다. 관리자에게 설치 폴더 지정을 요청해 주세요.",
  stdio_not_allowed_in_hosted_mode:
    "이 방식(내 PC 에서 직접 실행)은 서버에 설치된 런타임에서는 쓸 수 없습니다. Desktop 에서 사용하세요.",
  manifest_invalid:
    "자산 정보가 승인된 형식과 맞지 않습니다. 자산을 다시 내려받아 설치해 주세요.",
  server_alias_invalid: "자산 정보에 서버 이름이 없습니다. 자산을 다시 내려받아 설치해 주세요.",
  unsupported_source:
    "허용되지 않은 경로로 반입된 자산입니다. 포털에서 내려받거나 승인된 오프라인 번들로 설치해 주세요.",
  install_path_required: "설치 위치를 찾지 못했습니다. 자산을 다시 설치해 주세요.",
  install_path_not_absolute: "설치 위치를 찾지 못했습니다. 자산을 다시 설치해 주세요.",
  install_path_outside_allowed_roots:
    "허용된 설치 폴더 밖에 있습니다. 자산 스토어에서 다시 설치해 주세요.",
  install_path_not_a_directory: "설치가 완료되지 않았습니다. 자산을 다시 설치해 주세요.",
  entrypoint_outside_bundle:
    "설치 파일이 승인된 범위를 벗어났습니다. 자산을 다시 내려받아 설치해 주세요.",
  entrypoint_not_found: "설치 파일이 일부 빠졌습니다. 자산을 다시 내려받아 설치해 주세요.",
  interpreter_not_configured:
    "이 서버를 실행할 프로그램이 설정되지 않았습니다. 설정 화면에서 실행 환경을 지정해 주세요.",
  handshake_failed:
    "서버에 연결하지 못했습니다. 서버가 실행 중인지 확인한 뒤 다시 시도해 주세요.",
  protocol_version_unsupported:
    "서버가 쓰는 MCP 버전을 지원하지 않습니다. 서버나 Desktop 을 최신 버전으로 올려 주세요.",
  tools_list_failed:
    "서버에서 기능 목록을 받지 못했습니다. 서버가 실행 중인지 확인한 뒤 다시 시도해 주세요.",
  tools_snapshot_mismatch:
    "승인 당시와 서버의 기능 구성이 다릅니다. 안전을 위해 연결하지 않았습니다 — 자산을 최신 버전으로 다시 받아 주세요.",
  no_approved_tool_available:
    "이 서버가 제공하는 기능 중 승인된 것이 없습니다. 자산 담당자에게 문의해 주세요.",
};

const UNKNOWN_REFUSAL_GUIDANCE =
  "연결하지 못했습니다. 다시 시도해도 같으면 자산 담당자에게 문의해 주세요.";

/** 기계가 읽는 거부 사유를 "무엇을 하면 되는가" 로 바꾼다. 모르는 사유도
 * 빈 화면을 남기지 않는다 — 계약에 사유가 늘어나는 것보다 화면이 늦게
 * 갱신되는 일은 언제든 생긴다. */
export function describeRefusal(reason: string | null | undefined): string {
  if (!reason) return UNKNOWN_REFUSAL_GUIDANCE;
  return REFUSAL_GUIDANCE[reason] ?? UNKNOWN_REFUSAL_GUIDANCE;
}

/** 계약의 사유 17개가 전부 문구를 갖고 있는지 확인하기 위한 목록 — 테스트가
 * 이 목록과 계약을 대조한다. */
export function knownRefusalReasons(): string[] {
  return Object.keys(REFUSAL_GUIDANCE);
}

// --- 상태 표시 --------------------------------------------------------------

export type StatusTone = "success" | "danger" | "warning" | "muted";

export interface ServerStatusDisplay {
  tone: StatusTone;
  label: string;
  /** 실패했을 때만 채워진다 — 정상 상태에 안내 배너를 만들지 않는다. */
  guidance: string | null;
  /** 이 상태에서 "다시 연결"이 의미가 있는가. 연결 자체를 못 한 경우에만
   * 참이다 — 승인 구성이 어긋난 경우는 다시 눌러도 같은 결과라, 버튼을
   * 보여 주면 헛수고를 권하는 셈이다. */
  retryable: boolean;
}

const RETRYABLE_REASONS = new Set(["handshake_failed", "tools_list_failed"]);

export function describeServerStatus(entry: McpServerEntry): ServerStatusDisplay {
  if (entry.state === "ACTIVE") {
    return { tone: "success", label: "연결됨", guidance: null, retryable: false };
  }
  const guidance = describeRefusal(entry.reason);
  if (entry.state === "UNREACHABLE") {
    return {
      tone: "warning",
      label: "연결 안 됨",
      guidance,
      retryable: RETRYABLE_REASONS.has(entry.reason ?? ""),
    };
  }
  return { tone: "danger", label: "사용할 수 없음", guidance, retryable: false };
}

/** 카드에 보일 한 줄 요약. 연결된 서버는 몇 가지 기능을 쓸 수 있는지,
 * 아닌 서버는 개수를 말하지 않는다 — 0개라고 적으면 "기능이 없는 서버"로
 * 읽히지만 실제로는 연결이 안 된 것이다. */
export function summarizeTools(entry: McpServerEntry): string {
  if (entry.state !== "ACTIVE") return "사용 가능한 기능 없음";
  const count = entry.tool_names.length;
  if (count === 0) return "사용 가능한 기능 없음";
  if (count <= 3) return `사용 가능: ${entry.tool_names.join(", ")}`;
  return `사용 가능: ${entry.tool_names.slice(0, 3).join(", ")} 외 ${count - 3}개`;
}

/** 출처 표시. 서드파티는 명시한다 — 사내에서 만든 것과 밖에서 받은 것을
 * 같아 보이게 두면 사용자가 위험을 가늠할 근거를 잃는다. */
export function describeProvenance(entry: McpServerEntry): string | null {
  if (entry.provenance === "THIRD_PARTY") return "외부 제공";
  if (entry.provenance === "INTERNAL") return "사내 제공";
  return null;
}

// --- 목록 정렬 --------------------------------------------------------------

/** 손볼 것이 있는 서버를 위로 올린다. 정상 목록 안에 실패가 섞여 있으면
 * 눈에 띄지 않는다. 같은 상태끼리는 이름순 — 목록이 새로고침마다 움직이면
 * 읽기 어렵다. */
export function sortForDisplay(entries: McpServerEntry[]): McpServerEntry[] {
  const rank: Record<McpServerState, number> = { FAILED: 0, UNREACHABLE: 1, ACTIVE: 2 };
  return [...entries].sort(
    (a, b) => rank[a.state] - rank[b.state] || a.server_alias.localeCompare(b.server_alias),
  );
}

// --- 빈 상태 ----------------------------------------------------------------

/** 목록이 비었을 때 무엇을 말할지. "등록된 서버가 없습니다"만으로는 등록이
 * 꺼져 있어서인지 아직 설치를 안 해서인지 구분되지 않는다. */
export function describeEmptyState(response: McpServersListResponse): string {
  if (!response.mcp_server_registration_enabled) {
    return "이 PC 에서는 MCP 서버 등록이 꺼져 있습니다. 관리자에게 설치 폴더 지정을 요청해 주세요.";
  }
  return "연결된 MCP 서버가 없습니다. 자산 스토어에서 MCP 서버를 설치하면 여기에 나타납니다.";
}

/** stdio(내 PC 에서 직접 실행) 서버를 쓸 수 없는 배포인지 미리 알려 준다 —
 * 설치한 뒤에야 거부당하는 것보다 낫다. */
export function describeStdioSupport(response: McpServersListResponse): string | null {
  if (response.stdio_supported) return null;
  return "이 런타임에서는 내 PC 에서 직접 실행하는 방식의 MCP 서버를 사용할 수 없습니다. 네트워크로 연결하는 서버만 등록됩니다.";
}
