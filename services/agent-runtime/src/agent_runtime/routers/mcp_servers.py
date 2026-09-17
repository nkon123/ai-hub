"""D-094 — `/local/v1/mcp-servers*`: 설치된 MCP Server 자산의 활성화 표면.

`mcp_server_registry` 위의 얇은 HTTP 층이다. 판단은 전부 그 모듈과
`mcp_client` 에 있고 여기서는 계약 모양으로 옮기기만 한다 —
`routers/local_agents.py` 가 `local_agent_registry` 위에 두는 분리와 같다.

`POST /local/v1/mcp-tools`(D-080)를 대체한다. 그쪽은 Office Profile 이 이미
이름을 아는 서버 안의 Tool 하나가 단위였고, 서드파티 서버를 붙이는 순간 그
전제가 무너진다.

`/local/v1` 에만 마운트한다 — `/chat-api/v1`(게시된 챗봇) 에는 절대 올리지
않는다. 자산 활성화는 Desktop 이 하는 일이고, 게시된 챗봇 이용자가 하는 일이
아니다.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from observability import bind_trace_id
from pydantic import BaseModel

from agent_runtime.config import settings
from agent_runtime.mcp_client import MCPRegistrationError
from agent_runtime.mcp_server_registry import get_registry

# 경로에 `/local/v1` 을 쓰지 않는다 — `main.py` 가 prefix 로 붙인다.
router = APIRouter()


class RegisterMcpServerRequest(BaseModel):
    """계약(`mcp-server-registration.schema.json`)의 `RegisterMcpServerRequest`.

    **연결 방법을 지정하는 필드가 없다.** endpoint/command/args/env/
    interpreter_path 중 어느 것도 여기 없고 앞으로도 두지 않는다 — 그것이
    있으면 요청자가 곧 실행 명령을 정하게 되어, 매니페스트 승인과 설치 루트
    제한이 모두 우회된다. 무엇을 실행할지는 승인된 매니페스트와 배포 설정만이
    정한다(`mcp_client.connection.resolve_connection_target`).
    """

    manifest: dict
    install_path: str | None = None
    source: str
    trace_id: str | None = None


def _error_envelope(status_code: int, code: str, message: str, trace_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message, "trace_id": trace_id}},
    )


#: 거부 사유 → HTTP 상태. 설정/배포 형태 때문에 아예 불가능한 것(403)과, 이번
#: 요청의 내용이 잘못된 것(400), 서버에 닿지 못한 것(502)을 구분한다 — 전부
#: 400으로 뭉개면 "고치면 되는 것"과 "이 배포에서는 불가능한 것"이 같아 보인다.
_FORBIDDEN_REASONS = {
    "mcp_server_registration_disabled",
    "stdio_not_allowed_in_hosted_mode",
    "install_path_outside_allowed_roots",
    "entrypoint_outside_bundle",
}
_UNREACHABLE_REASONS = {"handshake_failed", "tools_list_failed"}


def _status_for(reason: str) -> int:
    if reason in _FORBIDDEN_REASONS:
        return 403
    if reason in _UNREACHABLE_REASONS:
        return 502
    return 400


@router.post("/mcp-servers")
async def register_mcp_server(req: RegisterMcpServerRequest) -> JSONResponse:
    trace_id = req.trace_id or str(uuid.uuid4())
    bind_trace_id(trace_id)

    try:
        entry = await get_registry().register(
            req.manifest, req.install_path, req.source, settings=settings
        )
    except MCPRegistrationError as exc:
        # 사용자에게는 사유와 안내만 준다. `exc.detail`(경로·스키마 오류 본문)은
        # 로그 전용이다 — 거부 메시지가 배포 구조를 알려 주면 안 된다.
        return _error_envelope(
            _status_for(str(exc.reason)), str(exc.reason), str(exc), trace_id
        )

    return JSONResponse({"entry": entry.to_entry(), "trace_id": trace_id})


@router.get("/mcp-servers")
async def list_mcp_servers(trace_id: str | None = None) -> JSONResponse:
    resolved = trace_id or str(uuid.uuid4())
    bind_trace_id(resolved)

    registry = get_registry()
    return JSONResponse(
        {
            "entries": [s.to_entry() for s in registry.list_servers()],
            # 화면이 "등록 버튼을 보여 줘도 되는가"를 판단하는 근거. 이 배포에서
            # 아예 불가능한 기능을 눌러 보게 만들지 않기 위해 상태를 먼저 준다.
            "mcp_server_registration_enabled": bool(settings.mcp_server_install_roots),
            "stdio_supported": settings.runtime_mode == "local",
            "trace_id": resolved,
        }
    )


@router.delete("/mcp-servers/{server_alias}")
async def deregister_mcp_server(server_alias: str, trace_id: str | None = None) -> JSONResponse:
    resolved = trace_id or str(uuid.uuid4())
    bind_trace_id(resolved)

    removed = get_registry().deregister(server_alias)
    # 없던 것을 지워도 200 이다 — 제거 시점에 조건 없이 호출할 수 있어야
    # "설치는 지웠는데 등록은 남은" 상태가 생기지 않는다.
    return JSONResponse(
        {"server_alias": server_alias, "removed": removed, "trace_id": resolved}
    )
