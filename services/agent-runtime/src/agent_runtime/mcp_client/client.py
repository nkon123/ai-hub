"""D-094: 실제 MCP 프로토콜 클라이언트.

이 저장소의 기존 "MCP" 는 이름뿐이었다 — `GET /mcp/v1/tools` /
`POST /mcp/v1/tools/{name}/call` 라는 자체 REST 였고, JSON-RPC 도
`initialize` 협상도 없었다. 여기서는 공식 `mcp` SDK 로 진짜 프로토콜을 말한다.
직접 짜지 않는 이유는 목적 자체가 **남이 만든 서버와의 상호운용**이고,
프레이밍과 lifecycle 을 손으로 재구현하면 바로 거기서 어긋나기 때문이다.

이 모듈이 하지 않는 것: 인가 판정, 출력 필터, Rate Limit, 감사. MCP 프로토콜에
인가 모델이 없으므로 그것들은 Policy Enforcement Point 가 **모든 dispatch 에**
적용한다. 여기는 "말할 수 있게" 만드는 층이고, "해도 되는가" 는 위층이 정한다 —
둘을 한 파일에 섞으면 우회 경로가 생긴다.

승인된 Tool 집합과의 대조도 여기서 한다(`tools/list` 스냅샷 해시) — 프로토콜은
서버가 Tool 목록을 바꾸는 것을 허용하므로, 승인이 특정 집합에 대한 것이라는
사실은 클라이언트가 지켜야 한다.
"""

from __future__ import annotations

import hashlib
import json
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from agent_runtime.mcp_client.connection import ConnectionTarget, HttpTarget, StdioTarget
from agent_runtime.mcp_client.errors import MCPRegistrationError, MCPRegistrationReason
from agent_runtime.mcp_client.result_filter import content_blocks_to_dicts

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DiscoveredTool:
    tool_name: str
    input_schema: dict


@dataclass(frozen=True)
class HandshakeResult:
    """`initialize` 와 `tools/list` 가 실제로 돌려준 것."""

    protocol_version: str
    server_name: str | None
    tools: tuple[DiscoveredTool, ...]
    snapshot_hash: str


def compute_tools_snapshot_hash(tools: list[dict] | tuple[DiscoveredTool, ...]) -> str:
    """승인 시점과 연결 시점의 Tool 구성을 비교하기 위한 정규화 해시.

    정렬 + 분리자 고정으로 계산해, 같은 내용이 순서나 공백 때문에 다른 해시가
    되지 않게 한다 — 그렇지 않으면 정상 서버가 매번 `tools_snapshot_mismatch`
    로 거부되어, 이 검사가 곧바로 꺼야 하는 기능이 된다.
    """
    if tools and isinstance(tools[0], DiscoveredTool):
        payload = [
            {"tool_name": t.tool_name, "input_schema": t.input_schema}
            for t in tools  # type: ignore[union-attr]
        ]
    else:
        payload = [
            {"tool_name": t.get("tool_name") or t.get("name"), "input_schema": t.get("input_schema") or t.get("inputSchema") or {}}
            for t in tools  # type: ignore[union-attr]
        ]
    payload.sort(key=lambda entry: entry["tool_name"] or "")
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _build_sdk_target(target: ConnectionTarget) -> Any:
    """검증을 마친 대상을 SDK 가 받는 형태로 바꾼다.

    이 함수는 **결정하지 않는다** — `connection.resolve_connection_target` 이
    이미 내린 결정을 옮길 뿐이다. 여기서 경로나 명령을 조립하기 시작하면
    보안 판단이 두 곳으로 갈라진다.
    """
    from mcp import StdioServerParameters

    if isinstance(target, HttpTarget):
        return target.endpoint
    if isinstance(target, StdioTarget):
        return StdioServerParameters(
            command=target.interpreter_path,
            args=[target.entrypoint_path, *target.args],
            cwd=target.cwd,
            # 환경변수를 물려주지 않는다. 부모 프로세스의 환경에는 이 서버가 알
            # 필요가 없는 것들(토큰, 내부 주소)이 들어 있고, 서드파티 코드에
            # 기본으로 넘길 이유가 없다. 필요한 값이 생기면 계약에 명시적으로
            # 추가할 일이지 상속할 일이 아니다.
            env={},
        )
    raise MCPRegistrationError(MCPRegistrationReason.MANIFEST_INVALID)


@asynccontextmanager
async def open_session(target: ConnectionTarget, *, timeout_seconds: float = 20.0):
    """연결을 열고 `initialize` 까지 마친 SDK 클라이언트를 내준다.

    SDK 예외를 전부 `MCPRegistrationError` 로 번역한다 — 위층(라우터)이
    SDK 예외 타입을 알게 되면 모듈 경계가 무너지고, 사용자에게는 이름 있는
    사유만 나가야 한다.
    """
    from mcp import Client

    sdk_target = _build_sdk_target(target)
    client = Client(sdk_target, read_timeout_seconds=timeout_seconds)
    try:
        async with client:
            yield client
    except MCPRegistrationError:
        raise
    except Exception as exc:  # SDK/전송 계층의 모든 실패
        # 원문은 로그에만 남긴다 — 서버가 보낸 문자열이라 사용자 화면에
        # 그대로 올리지 않는다.
        logger.warning("mcp_client.handshake_failed error=%s", type(exc).__name__, exc_info=True)
        raise MCPRegistrationError(
            MCPRegistrationReason.HANDSHAKE_FAILED, detail=str(exc)
        ) from exc


async def discover(client: Any) -> HandshakeResult:
    """이미 열린 세션에서 `tools/list` 를 읽어 우리 타입으로 옮긴다.

    `open_session` 과 나눠 둔 이유는 책임이 다르기 때문이다 — 저쪽은 "무엇에
    연결할 것인가"(보안 판단의 결과를 집행), 이쪽은 "서버가 뭐라고 답했나"
    (프로토콜 응답 번역). 덕분에 테스트가 **실제 MCP 서버에 실제로 연결한
    세션**을 이 함수에 넘겨 프로토콜 왕복을 검증할 수 있고, 그러자고
    `_build_sdk_target` 에 "테스트용 객체도 받아준다" 같은 구멍을 낼 필요가
    없다 — 연결 대상을 정하는 경로는 계속 하나뿐이다.
    """
    try:
        listed = await client.list_tools()
    except Exception as exc:
        logger.warning("mcp_client.tools_list_failed error=%s", type(exc).__name__)
        raise MCPRegistrationError(
            MCPRegistrationReason.TOOLS_LIST_FAILED, detail=str(exc)
        ) from exc

    # SDK 2.x 의 `Tool` 은 `input_schema`(snake_case)다 — wire 형식의
    # `inputSchema` 가 아니다. 두 이름을 모두 보는 것은 방어가 아니라 버전 차이를
    # 덮는 것이라, 실제 속성 하나만 읽는다(틀리면 테스트가 즉시 깨진다).
    tools = tuple(
        DiscoveredTool(
            tool_name=t.name,
            input_schema=dict(t.input_schema or {}),
        )
        for t in listed.tools
    )
    server_info = getattr(client, "server_info", None)
    return HandshakeResult(
        protocol_version=str(getattr(client, "protocol_version", "") or ""),
        server_name=getattr(server_info, "name", None),
        tools=tools,
        snapshot_hash=compute_tools_snapshot_hash(tools),
    )


async def handshake(
    target: ConnectionTarget,
    *,
    timeout_seconds: float = 20.0,
) -> HandshakeResult:
    """연결 → `initialize` → `tools/list` 까지 한 번에 수행한다."""
    async with open_session(target, timeout_seconds=timeout_seconds) as client:
        return await discover(client)


@dataclass(frozen=True)
class RawToolResult:
    """서버가 돌려준 것. **아직 아무 필터도 지나지 않았다.**

    SDK 타입을 그대로 내보내지 않는다(루트 코드 규칙: 외부 Library 타입을 모듈
    공개 계약으로 직접 노출하지 않는다). 이름에 `Raw` 를 넣은 것은 의도다 —
    이것을 그대로 사용자나 모델에게 건네면 §9(마스킹)와 §8.3(결과 상한)을
    통째로 건너뛰게 되고, 그 사실이 호출부에서 보이지 않으면 언젠가 그렇게 된다.
    `dispatch.dispatch_tool_call` 만이 이것을 만들고 곧바로 필터에 넘긴다.
    """

    content: list[dict]
    structured_content: Any
    is_error: bool


async def call_tool(client: Any, tool_name: str, arguments: dict | None) -> RawToolResult:
    """열린 세션에서 `tools/call` 한 번.

    "호출해도 되는가"는 **여기서 판단하지 않는다** — 그것은
    `policy.decide` 의 몫이고, 이 함수는 판정을 통과한 뒤에만 불린다.
    두 곳에서 판단하면 한 곳만 고쳐진다.
    """
    result = await client.call_tool(tool_name, arguments or {})
    return RawToolResult(
        content=content_blocks_to_dicts(getattr(result, "content", None)),
        structured_content=getattr(result, "structured_content", None),
        is_error=bool(getattr(result, "is_error", False)),
    )


def approved_tool_intersection(
    declared_tools: list[dict],
    discovered: tuple[DiscoveredTool, ...],
) -> tuple[str, ...]:
    """승인된 것 ∩ 서버가 실제로 제공하는 것. **합집합이 아니다.**

    한쪽만 있는 Tool 은 각각 다른 이유로 호출 불가다: 서버만 가진 것은 아무도
    검토하지 않았고, 승인만 된 것은 서버에 없다. 둘 다 조용히 포함시키면
    검토가 무의미해지거나 없는 Tool 을 호출하려 든다.
    """
    approved = {t["tool_name"] for t in declared_tools if isinstance(t, dict) and t.get("tool_name")}
    offered = {t.tool_name for t in discovered}
    return tuple(sorted(approved & offered))
