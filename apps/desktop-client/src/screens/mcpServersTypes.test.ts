// D-094 MCP 서버 화면 헬퍼. 여기서 확인하는 것은 대부분 "사용자가 무엇을
// 해야 하는지 알 수 있는가" 다 — 이 화면의 실패 상태는 전부 사용자가 직접
// 조치해야 하는 것들이라(자산 재설치, 서버 실행, 설정), 사유만 옮겨 적으면
// 화면이 있으나 마나다.
import { describe, expect, it } from "vitest";

import {
  describeEmptyState,
  describeProvenance,
  describeRefusal,
  describeServerStatus,
  describeStdioSupport,
  knownRefusalReasons,
  sortForDisplay,
  summarizeTools,
  type McpServerEntry,
  type McpServersListResponse,
} from "./mcpServersTypes";

function entry(over: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    server_alias: "fs-helper",
    transport_kind: "STDIO",
    state: "ACTIVE",
    protocol_version: "2025-06-18",
    tool_names: ["read_file"],
    provenance: "THIRD_PARTY",
    reason: null,
    message: null,
    registered_at: "2026-09-17T00:00:00Z",
    ...over,
  };
}

// 계약(`packages/schemas/api/mcp-server-registration.schema.json` 의
// `MCPRegistrationRefusalReason`)에 있는 17개. 하나라도 문구가 없으면 사용자는
// 무엇을 고쳐야 할지 알 수 없는 화면을 보게 된다.
const CONTRACT_REASONS = [
  "mcp_server_registration_disabled",
  "stdio_not_allowed_in_hosted_mode",
  "manifest_invalid",
  "server_alias_invalid",
  "unsupported_source",
  "install_path_required",
  "install_path_not_absolute",
  "install_path_outside_allowed_roots",
  "install_path_not_a_directory",
  "entrypoint_outside_bundle",
  "entrypoint_not_found",
  "interpreter_not_configured",
  "handshake_failed",
  "protocol_version_unsupported",
  "tools_list_failed",
  "tools_snapshot_mismatch",
  "no_approved_tool_available",
];

describe("거부 사유 안내", () => {
  it("계약의 사유 17개 전부에 문구가 있다", () => {
    const known = new Set(knownRefusalReasons());
    const missing = CONTRACT_REASONS.filter((r) => !known.has(r));
    expect(missing).toEqual([]);
  });

  it("문구가 없는 사유를 만들지 않는다 (목록이 계약을 넘어서지 않는다)", () => {
    const contract = new Set(CONTRACT_REASONS);
    const extra = knownRefusalReasons().filter((r) => !contract.has(r));
    expect(extra).toEqual([]);
  });

  it.each(CONTRACT_REASONS)("'%s' 안내가 기계용 이름을 그대로 노출하지 않는다", (reason) => {
    expect(describeRefusal(reason)).not.toContain(reason);
  });

  it.each(CONTRACT_REASONS)("'%s' 안내에 조치가 들어 있다", (reason) => {
    // 사유를 한국어로 옮기기만 한 문구("설치 경로가 올바르지 않습니다")는
    // 여전히 무엇을 할지 말해 주지 않는다.
    const text = describeRefusal(reason);
    expect(text).toMatch(/하세요|해 주세요|주세요|문의|확인/);
  });

  it("모르는 사유도 빈 화면을 남기지 않는다", () => {
    expect(describeRefusal("앞으로_생길_사유").length).toBeGreaterThan(10);
    expect(describeRefusal(null).length).toBeGreaterThan(10);
  });

  it("안내에 파일 경로를 적지 않는다", () => {
    // 서버가 경로를 응답에 담지 않는 이유와 같다 — 배포 구조를 드러낸다.
    for (const reason of CONTRACT_REASONS) {
      expect(describeRefusal(reason)).not.toMatch(/[A-Za-z]:\\|\/usr\/|\/home\//);
    }
  });
});

describe("상태 표시", () => {
  it("연결된 서버에는 안내 배너를 만들지 않는다", () => {
    const status = describeServerStatus(entry());
    expect(status.tone).toBe("success");
    expect(status.guidance).toBeNull();
  });

  it("연결 실패는 다시 시도할 수 있다고 알려 준다", () => {
    const status = describeServerStatus(
      entry({ state: "UNREACHABLE", reason: "handshake_failed" }),
    );
    expect(status.retryable).toBe(true);
    expect(status.guidance).toContain("실행 중인지");
  });

  it("승인 구성이 어긋난 경우에는 다시 시도를 권하지 않는다", () => {
    // 다시 눌러도 같은 결과다 — 버튼을 보여 주면 헛수고를 권하는 셈이다.
    const status = describeServerStatus(
      entry({ state: "FAILED", reason: "tools_snapshot_mismatch" }),
    );
    expect(status.retryable).toBe(false);
    expect(status.tone).toBe("danger");
  });

  it("연결 안 됨과 사용할 수 없음을 구분한다", () => {
    const unreachable = describeServerStatus(entry({ state: "UNREACHABLE", reason: "handshake_failed" }));
    const failed = describeServerStatus(entry({ state: "FAILED", reason: "manifest_invalid" }));
    expect(unreachable.label).not.toBe(failed.label);
  });
});

describe("기능 요약", () => {
  it("연결되지 않은 서버에 기능 0개라고 적지 않는다", () => {
    // "0개"라고 적으면 기능이 없는 서버로 읽히지만 실제로는 연결이 안 된 것이다.
    const text = summarizeTools(entry({ state: "UNREACHABLE", tool_names: [] }));
    expect(text).not.toMatch(/0개|0 개/);
  });

  it("기능이 많으면 앞의 몇 개만 보여 준다", () => {
    const text = summarizeTools(entry({ tool_names: ["a", "b", "c", "d", "e"] }));
    expect(text).toContain("외 2개");
  });
});

describe("출처", () => {
  it("외부에서 받은 서버임을 명시한다", () => {
    expect(describeProvenance(entry({ provenance: "THIRD_PARTY" }))).toBe("외부 제공");
  });

  it("사내와 외부를 같아 보이게 두지 않는다", () => {
    expect(describeProvenance(entry({ provenance: "INTERNAL" }))).not.toBe(
      describeProvenance(entry({ provenance: "THIRD_PARTY" })),
    );
  });
});

describe("정렬", () => {
  it("손볼 것이 있는 서버를 위로 올린다", () => {
    const sorted = sortForDisplay([
      entry({ server_alias: "b-ok", state: "ACTIVE" }),
      entry({ server_alias: "a-broken", state: "FAILED" }),
      entry({ server_alias: "c-down", state: "UNREACHABLE" }),
    ]);
    expect(sorted.map((e) => e.server_alias)).toEqual(["a-broken", "c-down", "b-ok"]);
  });

  it("같은 상태끼리는 이름순이라 새로고침마다 움직이지 않는다", () => {
    const sorted = sortForDisplay([
      entry({ server_alias: "z", state: "ACTIVE" }),
      entry({ server_alias: "a", state: "ACTIVE" }),
    ]);
    expect(sorted.map((e) => e.server_alias)).toEqual(["a", "z"]);
  });

  it("원본 배열을 바꾸지 않는다", () => {
    const original = [entry({ server_alias: "z" }), entry({ server_alias: "a" })];
    sortForDisplay(original);
    expect(original[0].server_alias).toBe("z");
  });
});

describe("빈 상태", () => {
  function response(over: Partial<McpServersListResponse> = {}): McpServersListResponse {
    return {
      entries: [],
      mcp_server_registration_enabled: true,
      stdio_supported: true,
      trace_id: "t",
      ...over,
    };
  }

  it("등록이 꺼져 있는 것과 아직 설치를 안 한 것을 구분한다", () => {
    const disabled = describeEmptyState(response({ mcp_server_registration_enabled: false }));
    const empty = describeEmptyState(response());
    expect(disabled).not.toBe(empty);
    expect(disabled).toContain("꺼져");
  });

  it("stdio 를 못 쓰는 배포는 설치 전에 알려 준다", () => {
    expect(describeStdioSupport(response({ stdio_supported: false }))).toContain("사용할 수 없습니다");
  });

  it("정상 배포에는 경고를 만들지 않는다", () => {
    expect(describeStdioSupport(response())).toBeNull();
  });
});
