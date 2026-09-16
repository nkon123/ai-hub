"""D-094 MCP 서버 등록·연결 거부 사유.

`packages/schemas/api/mcp-server-registration.schema.json` 의 reason 목록이
권위 있는 정의이고, 이 모듈은 그것의 Python 대응이다. **문자열을 손으로 두 번
적는 구조라 갈라질 수 있다** — 이 저장소는 그런 손복사가 실제로 드리프트한
전례가 있어서(`mcp_tools.MCP_TOOL_SPECS`), 계약 테스트가 두 목록의 동일성을
고정한다.

거부는 조용할 수 없다: 모든 거부는 이름 있는 `reason` 과 사용자에게 그대로
보여도 되는 한국어 문장을 함께 갖는다. 메시지에 파일시스템 경로를 넣지
않는다(07-data-api-contracts.md §10.2).
"""

from __future__ import annotations

from enum import StrEnum


class MCPRegistrationReason(StrEnum):
    """계약의 `details.reason` 값. 이 목록 밖의 사유를 만들지 않는다."""

    # 배포 정책 — 사용자가 재시도해서 풀 수 있는 것이 아니다.
    REGISTRATION_DISABLED = "mcp_server_registration_disabled"
    STDIO_NOT_ALLOWED_IN_HOSTED_MODE = "stdio_not_allowed_in_hosted_mode"

    # 매니페스트
    MANIFEST_INVALID = "manifest_invalid"
    SERVER_ALIAS_INVALID = "server_alias_invalid"
    UNSUPPORTED_SOURCE = "unsupported_source"

    # 경로 (STDIO 전용)
    INSTALL_PATH_REQUIRED = "install_path_required"
    INSTALL_PATH_NOT_ABSOLUTE = "install_path_not_absolute"
    INSTALL_PATH_OUTSIDE_ALLOWED_ROOTS = "install_path_outside_allowed_roots"
    INSTALL_PATH_NOT_A_DIRECTORY = "install_path_not_a_directory"
    ENTRYPOINT_OUTSIDE_BUNDLE = "entrypoint_outside_bundle"
    ENTRYPOINT_NOT_FOUND = "entrypoint_not_found"
    INTERPRETER_NOT_CONFIGURED = "interpreter_not_configured"

    # 프로토콜
    HANDSHAKE_FAILED = "handshake_failed"
    PROTOCOL_VERSION_UNSUPPORTED = "protocol_version_unsupported"
    TOOLS_LIST_FAILED = "tools_list_failed"
    TOOLS_SNAPSHOT_MISMATCH = "tools_snapshot_mismatch"
    NO_APPROVED_TOOL_AVAILABLE = "no_approved_tool_available"


#: 사용자에게 그대로 보여도 되는 한국어 문장. 경로·명령줄을 담지 않는다.
#: 재시도로 풀리지 않는 사유는 **무엇을 해야 풀리는지**를 말한다 — 이 저장소가
#: D-079 에서 배운 것: 반드시 실패하는 행동을 안내하면 사용자는 영원히 막힌다.
_MESSAGES: dict[MCPRegistrationReason, str] = {
    MCPRegistrationReason.REGISTRATION_DISABLED: (
        "이 배포는 외부에 설치된 MCP 서버 등록을 허용하지 않습니다. "
        "관리자가 설치 경로를 지정해야 사용할 수 있습니다."
    ),
    MCPRegistrationReason.STDIO_NOT_ALLOWED_IN_HOSTED_MODE: (
        "이 런타임은 공용 서버로 실행 중이라 stdio 방식 MCP 서버를 띄울 수 없습니다. "
        "원격 HTTP 방식 서버를 쓰거나, 개인 PC의 런타임에서 설치해 주세요."
    ),
    MCPRegistrationReason.MANIFEST_INVALID: "MCP 서버 매니페스트 형식이 올바르지 않습니다.",
    MCPRegistrationReason.SERVER_ALIAS_INVALID: "서버 식별자 형식이 올바르지 않습니다.",
    MCPRegistrationReason.UNSUPPORTED_SOURCE: "알 수 없는 설치 경로로 등록할 수 없습니다.",
    MCPRegistrationReason.INSTALL_PATH_REQUIRED: (
        "stdio 방식 서버는 설치 폴더 위치가 필요합니다."
    ),
    MCPRegistrationReason.INSTALL_PATH_NOT_ABSOLUTE: "설치 폴더는 절대 경로여야 합니다.",
    MCPRegistrationReason.INSTALL_PATH_OUTSIDE_ALLOWED_ROOTS: (
        "이 배포가 허용한 설치 경로 밖의 폴더는 등록할 수 없습니다."
    ),
    MCPRegistrationReason.INSTALL_PATH_NOT_A_DIRECTORY: "설치 폴더를 찾을 수 없습니다.",
    MCPRegistrationReason.ENTRYPOINT_OUTSIDE_BUNDLE: (
        "서버 실행 파일이 설치 폴더 밖을 가리키고 있어 실행할 수 없습니다."
    ),
    MCPRegistrationReason.ENTRYPOINT_NOT_FOUND: "서버 실행 파일을 찾을 수 없습니다.",
    MCPRegistrationReason.INTERPRETER_NOT_CONFIGURED: (
        "이 서버를 실행할 런타임 경로가 설정되어 있지 않습니다. "
        "관리자에게 실행 경로 설정을 요청해 주세요."
    ),
    MCPRegistrationReason.HANDSHAKE_FAILED: (
        "MCP 서버와 연결하지 못했습니다. 서버가 실행 중인지 확인해 주세요."
    ),
    MCPRegistrationReason.PROTOCOL_VERSION_UNSUPPORTED: (
        "이 MCP 서버가 사용하는 프로토콜 버전을 지원하지 않습니다."
    ),
    MCPRegistrationReason.TOOLS_LIST_FAILED: "MCP 서버에서 Tool 목록을 가져오지 못했습니다.",
    MCPRegistrationReason.TOOLS_SNAPSHOT_MISMATCH: (
        "이 서버가 제공하는 Tool 구성이 승인된 내용과 다릅니다. "
        "다시 시도해도 해결되지 않으며, 변경된 구성으로 재승인이 필요합니다."
    ),
    MCPRegistrationReason.NO_APPROVED_TOOL_AVAILABLE: (
        "승인된 Tool 중 이 서버가 실제로 제공하는 것이 없습니다."
    ),
}


class MCPRegistrationError(Exception):
    """등록·연결 거부. 정확히 하나의 `reason` 을 갖는다."""

    def __init__(self, reason: MCPRegistrationReason, *, detail: str | None = None) -> None:
        self.reason = reason
        self.message = _MESSAGES[reason]
        # `detail` 은 로그 전용이다 — 사용자 응답에 싣지 않는다. 경로나 명령줄이
        # 들어갈 수 있는 유일한 자리라 호출자가 의도적으로만 기록하게 분리했다.
        self.detail = detail
        super().__init__(f"{reason}: {self.message}")


def message_for(reason: MCPRegistrationReason) -> str:
    return _MESSAGES[reason]
