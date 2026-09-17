"""D-094 10단계 — office-mcp-server 를 **진짜 MCP 프로토콜**로 노출한 표면.

지금까지 `/mcp/v1/tools*` 는 이름만 MCP 인 자체 REST 였다. 여기서 확인하는
것은 프로토콜이 동작하는가보다 **두 표면의 통제가 갈라지지 않는가** 다:

* 목록에 나오는 Tool 과 스키마가 **승인된 것 그대로**인가 — 파이썬 함수
  시그니처에서 유도된 것이 나가면 검토자가 승인하지 않은 계약이 나가는 셈이다.
* 신원이 **`_meta` 에서만** 오는가 — Tool 인자에서 읽으면 Prompt Injection 으로
  role 을 위조할 수 있고, 그것을 막는 것이 이 서버의 핵심 장치다.
* 신원이 없으면 거부하는가 — 익명 호출을 허용하면 §7 인가가 통째로 사라진다.
* Kill Switch 로 내린 Tool 이 목록에서도 빠지는가.

SDK 를 mock 하지 않는다 — 진짜 `Client` 로 진짜 `Server` 에 붙는다. mock 했다면
`input_schema` 가 snake_case 라는 것 같은 실제 차이를 못 잡는다(이미 한 번
겪었다).
"""

from __future__ import annotations

import pytest
from office_mcp_server.mcp_protocol import AUDIT_CONTEXT_META_KEY, build_mcp_server
from office_mcp_server.pipeline import ToolCallPipeline
from office_mcp_server.tool_registry import ToolRegistry
from office_mcp_server.tools_setup import register_poc_tools

CALCULATOR = "calculator.add"


def _audit_context(tool_name: str = CALCULATOR, roles: list[str] | None = None) -> dict:
    return {
        "request_id": "11111111-1111-1111-1111-111111111111",
        "trace_id": "22222222-2222-2222-2222-222222222222",
        "run_id": "33333333-3333-3333-3333-333333333333",
        "service_id": "44444444-4444-4444-4444-444444444444",
        "service_version": "1.0.0",
        "agent_id": "55555555-5555-5555-5555-555555555555",
        "agent_version": "1.0.0",
        "user": {
            "id": "dev-user@miracom.com",
            "organization_id": "miracom",
            "site_id": "headquarters",
            "roles": roles if roles is not None else ["CREATOR"],
        },
        "requested_tool": tool_name,
    }


@pytest.fixture
def server():
    registry = ToolRegistry()
    register_poc_tools(registry)

    class _Sink:
        def __init__(self) -> None:
            self.events: list = []

        def record(self, event) -> None:
            self.events.append(event)

    class _Connector:
        async def health(self):
            return True

        async def execute_named_query(self, query_id, parameters, context):  # noqa: ARG002
            return {"rows": []}

        async def close(self):
            return None

    sink = _Sink()
    pipeline = ToolCallPipeline(registry=registry, connector=_Connector(), audit_sink=sink)
    srv = build_mcp_server(registry, pipeline, version="test")
    srv._test_registry = registry  # type: ignore[attr-defined]
    srv._test_sink = sink  # type: ignore[attr-defined]
    return srv


async def _client(server):
    from mcp import Client

    return Client(server)


# --- 목록 -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tools_list_returns_the_approved_schema(server) -> None:
    """파이썬 함수 시그니처에서 유도한 스키마가 나가면 검토자가 승인하지 않은
    계약이 클라이언트에게 나가는 셈이다."""
    approved = {
        t["name"]: t["input_schema"] for t in server._test_registry.admin_list()
    }

    async with await _client(server) as client:
        listed = await client.list_tools()

    by_name = {t.name: t for t in listed.tools}
    assert CALCULATOR in by_name
    assert by_name[CALCULATOR].input_schema == approved[CALCULATOR]


@pytest.mark.asyncio
async def test_a_disabled_tool_disappears_from_the_list(server) -> None:
    """목록에 두고 호출만 막으면 클라이언트는 그것을 쓸 수 있는 것으로 보고
    승인 스냅샷에 담는다 — 그러면 Kill Switch 를 내릴 때마다
    `tools_snapshot_mismatch` 가 난다."""
    server._test_registry.disable(CALCULATOR)

    async with await _client(server) as client:
        listed = await client.list_tools()

    assert CALCULATOR not in {t.name for t in listed.tools}


@pytest.mark.asyncio
async def test_read_only_is_advertised_at_the_protocol_level(server) -> None:
    async with await _client(server) as client:
        listed = await client.list_tools()

    tool = next(t for t in listed.tools if t.name == CALCULATOR)
    assert tool.annotations is not None
    assert tool.annotations.read_only_hint is True


# --- 신원 -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_call_without_identity_is_refused(server) -> None:
    """익명 호출을 허용하면 §7 인가가 통째로 사라진다. 클라이언트 PEP 가 이미
    판정했다는 것은 우리 서버가 자기 판정을 생략해도 된다는 뜻이 아니다 —
    그 클라이언트가 우리 것이라는 보장이 없다."""
    async with await _client(server) as client:
        result = await client.call_tool(CALCULATOR, {"a": 1, "b": 2})

    assert result.is_error is True


@pytest.mark.asyncio
async def test_identity_in_the_arguments_does_not_count(server) -> None:
    """Tool 인자는 모델이나 사용자가 채우는 값이다. 거기서 role 을 읽으면
    "권한을 요청자가 적어 내는" 구조가 된다."""
    async with await _client(server) as client:
        result = await client.call_tool(
            CALCULATOR,
            {"a": 1, "b": 2, "audit_context": _audit_context(roles=["ADMIN"])},
        )

    assert result.is_error is True, "인자에 실린 신원이 받아들여졌다"


@pytest.mark.asyncio
async def test_a_call_with_identity_in_meta_succeeds(server) -> None:
    async with await _client(server) as client:
        result = await client.call_tool(
            CALCULATOR,
            {"a": 1, "b": 2},
            meta={AUDIT_CONTEXT_META_KEY: _audit_context()},
        )

    assert result.is_error is False, result.content
    assert server._test_sink.events, "감사 이벤트가 남지 않았다"


@pytest.mark.asyncio
async def test_authorization_still_applies_over_the_protocol(server) -> None:
    """프로토콜 표면이 파이프라인을 우회하면 REST 와 통제가 갈라진다."""
    async with await _client(server) as client:
        result = await client.call_tool(
            CALCULATOR,
            {"a": 1, "b": 2},
            meta={AUDIT_CONTEXT_META_KEY: _audit_context(roles=["AUDITOR"])},
        )

    assert result.is_error is True


@pytest.mark.asyncio
async def test_input_validation_still_applies_over_the_protocol(server) -> None:
    async with await _client(server) as client:
        result = await client.call_tool(
            CALCULATOR,
            {"a": "숫자가 아님"},
            meta={AUDIT_CONTEXT_META_KEY: _audit_context()},
        )

    assert result.is_error is True


# --- 오류 표현 ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_tool_failure_is_a_result_not_a_protocol_error(server) -> None:
    """MCP 에서 Tool 실행 실패는 정상 응답이고 프로토콜 오류는 전송/요청 형식
    문제를 뜻한다. 섞으면 클라이언트가 재시도 판단을 못 한다."""
    async with await _client(server) as client:
        # 예외가 아니라 `is_error=True` 결과로 돌아와야 한다.
        result = await client.call_tool(CALCULATOR, {"a": 1, "b": 2})

    assert result.is_error is True
    assert result.content, "왜 실패했는지 알려 주는 내용이 있어야 한다"


# --- 선언한 출력 모양과 실제 전송 모양 ---------------------------------------


@pytest.mark.asyncio
async def test_the_declared_output_schema_describes_what_is_actually_sent(server) -> None:
    """실측으로 발견한 불일치(2026-09-17).

    `output_filter` 는 업무 출력에 `classification` 라벨을 덧붙여 내보내는데,
    Tool 의 `output_schema` 는 **라벨을 붙이기 전**의 모양을 기술한다(그 검증이
    Handler 버그를 잡는 장치이므로 그쪽이 맞다). REST 표면에서는 아무도 응답을
    스키마로 검증하지 않아 이 차이가 드러나지 않았다 — MCP 클라이언트는
    검증하므로 정상 응답이 매번 거부됐다.

    스키마를 아예 안 보내면 이 테스트는 통과하지만 클라이언트가 응답 모양을
    확인할 수단을 잃는다. 그래서 "검증이 켜져 있고 통과한다"를 함께 본다.
    """
    async with await _client(server) as client:
        listed = await client.list_tools()
        tool = next(t for t in listed.tools if t.name == CALCULATOR)
        # 검증을 끄는 방식으로 통과시키지 않았는지부터 확인한다.
        assert tool.output_schema is not None
        assert "classification" in (tool.output_schema.get("properties") or {})

        # SDK 클라이언트가 이 스키마로 structured_content 를 검증한다 —
        # 어긋나면 여기서 RuntimeError 로 터진다.
        result = await client.call_tool(
            CALCULATOR, {"a": 1, "b": 2}, meta={AUDIT_CONTEXT_META_KEY: _audit_context()}
        )

    assert result.is_error is False
    assert result.structured_content is not None
