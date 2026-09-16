"""D-094 프로토콜 클라이언트 — **실제 MCP 서버**를 상대로 검증한다.

SDK 를 mock 하지 않는다. 이 층이 존재하는 이유가 "진짜 프로토콜을 말한다"는
것 하나뿐이라, SDK 를 흉내 낸 가짜를 상대로 통과하는 테스트는 정확히 아무것도
증명하지 못한다(이 저장소가 tests/CLAUDE.md 에 적어 둔 실패 방식 그대로다 —
청커 단위 테스트 60개가 전부 통과하는 동안 실제 챗봇은 0 Citation 이었다).

`mcp.Client` 가 테스트용으로 `MCPServer` 인스턴스를 직접 받아 인프로세스로
연결해 주므로, 프로세스를 띄우지 않고도 `initialize` → `tools/list` →
`tools/call` 전 구간이 실제 프로토콜로 돈다.

연결 대상을 만드는 `_build_sdk_target` 은 HTTP/STDIO 만 받는다(보안 경계이므로
테스트 편의를 위해 넓히지 않는다). 그래서 테스트는 SDK `Client` 를 직접 열고,
프로토콜 응답을 번역하는 `discover()` 에 그 세션을 넘긴다 — 검증 대상은
그대로 실제 프로토콜 왕복이다.
"""

from __future__ import annotations

import pytest
from agent_runtime.mcp_client import (
    MCPRegistrationError,
    MCPRegistrationReason,
    approved_tool_intersection,
    compute_tools_snapshot_hash,
    discover,
    handshake,
)
from agent_runtime.mcp_client.client import DiscoveredTool
from mcp import Client
from mcp.server import MCPServer

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _server() -> MCPServer:
    server = MCPServer(name="test-office-connector", version="1.0.0")

    @server.tool(name="db_metadata.get_tables", description="테이블 목록")
    def get_tables(schema_name: str = "APP") -> list[str]:
        return [f"{schema_name}.EMPLOYEE", f"{schema_name}.DEPARTMENT"]

    @server.tool(name="table_count.query", description="행 수")
    def table_count(table_name: str) -> int:
        return 42 if table_name == "EMPLOYEE" else 0

    return server


# --- 핸드셰이크가 실제로 프로토콜을 왕복한다 --------------------------------


async def test_handshake_negotiates_and_lists_tools() -> None:
    async with Client(_server()) as client:
        result = await discover(client)

    assert result.protocol_version, "initialize 가 버전을 협상해야 한다"
    assert result.server_name == "test-office-connector"
    assert {t.tool_name for t in result.tools} == {
        "db_metadata.get_tables",
        "table_count.query",
    }
    assert result.snapshot_hash.startswith("sha256:")


async def test_input_schema_comes_from_the_server_not_a_hand_copy() -> None:
    """`tools/list` 가 권위 있는 출처라는 것이 이 재설계의 핵심 이득이다 —
    `MCP_TOOL_SPECS` 손복사와 그것을 막던 계약 테스트 16개가 통째로 필요 없어진다."""
    async with Client(_server()) as client:
        result = await discover(client)
    by_name = {t.tool_name: t for t in result.tools}
    schema = by_name["table_count.query"].input_schema
    assert schema.get("type") == "object"
    assert "table_name" in schema.get("properties", {})


async def test_call_tool_round_trips() -> None:
    async with Client(_server()) as client:
        result = await client.call_tool("table_count.query", {"table_name": "EMPLOYEE"})
    assert "42" in str(result.content)


# --- 스냅샷 해시: 같은 구성은 같은 해시, 다른 구성은 다른 해시 ---------------


def test_snapshot_hash_ignores_order_and_formatting() -> None:
    """정규화하지 않으면 정상 서버가 매번 `tools_snapshot_mismatch` 로 거부되고,
    그러면 이 검사는 곧바로 꺼야 하는 기능이 된다 — 즉 없느니만 못해진다."""
    a = (
        DiscoveredTool("b.tool", {"type": "object"}),
        DiscoveredTool("a.tool", {"type": "object"}),
    )
    b = (
        DiscoveredTool("a.tool", {"type": "object"}),
        DiscoveredTool("b.tool", {"type": "object"}),
    )
    assert compute_tools_snapshot_hash(a) == compute_tools_snapshot_hash(b)


def test_snapshot_hash_changes_when_a_tool_appears() -> None:
    """서버가 아무도 검토하지 않은 Tool 을 추가하면 반드시 드러나야 한다 —
    이게 안 바뀌면 `tools_snapshot_mismatch` 검사 전체가 무의미하다."""
    before = (DiscoveredTool("a.tool", {"type": "object"}),)
    after = (*before, DiscoveredTool("b.tool", {"type": "object"}))
    assert compute_tools_snapshot_hash(before) != compute_tools_snapshot_hash(after)


def test_snapshot_hash_changes_when_an_input_schema_changes() -> None:
    """이름만 보면 놓친다 — 같은 이름으로 받는 인자가 바뀌는 것도 승인 대상의
    변경이다."""
    before = (DiscoveredTool("a.tool", {"type": "object", "properties": {}}),)
    after = (
        DiscoveredTool("a.tool", {"type": "object", "properties": {"path": {"type": "string"}}}),
    )
    assert compute_tools_snapshot_hash(before) != compute_tools_snapshot_hash(after)


async def test_handshake_hash_matches_recomputation() -> None:
    """승인 시점과 연결 시점이 같은 함수로 계산되어야 비교가 성립한다."""
    async with Client(_server()) as client:
        result = await discover(client)
    assert result.snapshot_hash == compute_tools_snapshot_hash(result.tools)


# --- 승인 ∩ 제공: 합집합이 아니다 --------------------------------------------


def test_intersection_drops_a_tool_nobody_approved() -> None:
    declared = [{"tool_name": "a.tool"}]
    discovered = (DiscoveredTool("a.tool", {}), DiscoveredTool("sneaky.tool", {}))
    assert approved_tool_intersection(declared, discovered) == ("a.tool",)


def test_intersection_drops_an_approved_tool_the_server_lacks() -> None:
    declared = [{"tool_name": "a.tool"}, {"tool_name": "gone.tool"}]
    discovered = (DiscoveredTool("a.tool", {}),)
    assert approved_tool_intersection(declared, discovered) == ("a.tool",)


def test_intersection_can_be_empty() -> None:
    """빈 교집합은 `no_approved_tool_available` 로 귀결된다 — 아무것도 못 하는
    서버를 ACTIVE 로 등록하면 화면은 정상인데 호출은 영원히 안 된다."""
    assert approved_tool_intersection([{"tool_name": "a"}], (DiscoveredTool("b", {}),)) == ()


# --- 실패는 이름 있는 사유로 번역된다 ----------------------------------------


async def test_unreachable_endpoint_becomes_handshake_failed() -> None:
    """SDK 예외 타입이 위층으로 새면 모듈 경계가 무너지고, 사용자에게는
    이름 있는 사유만 나가야 한다."""
    from agent_runtime.mcp_client import HttpTarget

    with pytest.raises(MCPRegistrationError) as exc:
        await handshake(HttpTarget(endpoint="http://127.0.0.1:1/mcp"), timeout_seconds=2.0)
    assert exc.value.reason == MCPRegistrationReason.HANDSHAKE_FAILED
    assert exc.value.message
    assert "/" not in exc.value.message, "사용자 메시지에 경로를 넣지 않는다"
