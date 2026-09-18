"""TOOL_ROUTE 후보 목록이 **등록된 MCP 서버**까지 포함하는지, 그리고 사용자가
대화 화면에서 고른 범위가 그 목록을 **좁히기만** 하는지 고정한다.

**왜 생겼나(2026-09-18 실사용)**: 샘플 MCP 서버(hello-mcp)를 설치하고 등록까지
마쳤는데 대화에서 쓸 방법이 없었다. `resolve_allowed_alias` 는 이미 등록된
서버의 Tool 을 허용하고 있었는데 `list_candidate_tools` 만 Office Profile 에
묶여 있어서, 라우터에게는 그 Tool 이 아예 존재하지 않았다 — "부를 수는 있는데
고를 수는 없는" 상태.

이 suite 가 지키는 경계는 하나다: **사용자 선택은 좁히기만 한다.** 선택 목록이
후보를 넓힐 수 있으면 화면에서 타이핑한 이름이 곧 권한이 된다.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from agent_runtime import mcp_tools
from agent_runtime.mcp_server_registry import MCPServerRegistry, RegisteredServer
from agent_runtime.mcp_tool_registry import MCPToolRegistry

ALIAS = "oracle-connector"

OFFICE_PROFILE: dict[str, Any] = {
    "allowed_mcp_servers": [
        {
            "alias": ALIAS,
            "endpoint": "http://127.0.0.1:8500",
            "allowed_tools": ["db_metadata.get_tables", "table_count.query"],
        }
    ]
}

HELLO_MANIFEST: dict[str, Any] = {
    "server_alias": "hello-mcp",
    "declared_tools": [
        {
            "tool_name": "hello.echo",
            # 매니페스트가 산문을 담는 필드는 `label` 이다
            # (`mcp-server-manifest.schema.json`) — 라우터 후보의
            # `description` 으로 그대로 옮겨진다.
            "label": "보낸 문장을 그대로 돌려줍니다",
            "risk_level": "READ_ONLY",
            "confirmation_policy": "NEVER",
            "input_schema": {
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
                "additionalProperties": False,
            },
        },
        {
            "tool_name": "hello.now",
            "risk_level": "READ_ONLY",
            "confirmation_policy": "NEVER",
            "input_schema": {"type": "object", "additionalProperties": False},
        },
    ],
}


def _put(registry: MCPServerRegistry, server: RegisteredServer) -> None:
    """등록 상태를 직접 만든다. 공개 `register()` 는 실제로 stdio 프로세스를
    띄우고 핸드셰이크·`tools/list` 대조까지 하므로(그 경로는
    `test_mcp_connection_gate.py`/`test_mcp_protocol_client.py` 가 덮는다),
    "이미 등록된 서버가 있을 때 후보 목록이 어떻게 되는가"만 보는 이 suite 는
    그 앞 단계를 재현하지 않는다."""
    registry._servers[server.server_alias] = server  # noqa: SLF001


def _server(state: str = "ACTIVE") -> RegisteredServer:
    return RegisteredServer(
        server_alias="hello-mcp",
        transport_kind="STDIO",
        state=state,
        protocol_version="2025-06-18",
        tool_names=("hello.echo", "hello.now"),
        provenance="INTERNAL",
        registered_at="2026-09-18T00:00:00+00:00",
        manifest=HELLO_MANIFEST,
    )


@pytest.fixture(autouse=True)
def _isolated_registries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """두 레지스트리(D-080 Tool / D-094 서버)를 이 테스트 것으로 바꾼다 —
    실제 파일이나 기동된 서버에 의존하지 않는다."""
    tool_registry = MCPToolRegistry(
        registry_path=tmp_path / "mcp-tool-registry.json",
        allowed_aliases=(ALIAS,),
        office_profile_provider=lambda: OFFICE_PROFILE,
    )
    server_registry = MCPServerRegistry()
    monkeypatch.setattr("agent_runtime.mcp_tool_registry.get_registry", lambda: tool_registry)
    monkeypatch.setattr("agent_runtime.mcp_server_registry.get_registry", lambda: server_registry)
    return server_registry


def _names(candidates: list[dict[str, Any]]) -> list[str]:
    return [c["tool_name"] for c in candidates]


def test_registered_server_tools_become_candidates(_isolated_registries: MCPServerRegistry) -> None:
    before = _names(mcp_tools.list_candidate_tools(OFFICE_PROFILE))
    assert "hello.echo" not in before

    _put(_isolated_registries, _server())

    after = _names(mcp_tools.list_candidate_tools(OFFICE_PROFILE))
    assert "hello.echo" in after and "hello.now" in after
    # Office Profile 쪽 후보가 사라지지 않는다.
    assert "db_metadata.get_tables" in after


def test_candidate_carries_the_manifest_schema_not_a_guess(
    _isolated_registries: MCPServerRegistry,
) -> None:
    """스키마는 **검토자가 승인한 매니페스트**에서 온다 — 서버가 말하는 것이
    아니다. 라우터가 검증할 수 없는 입력을 만들지 못하게 하는 근거다."""
    _put(_isolated_registries, _server())
    candidate = next(
        c for c in mcp_tools.list_candidate_tools(OFFICE_PROFILE) if c["tool_name"] == "hello.echo"
    )
    assert candidate["input_schema"]["required"] == ["message"]
    assert candidate["input_schema"]["additionalProperties"] is False
    assert candidate["description"] == "보낸 문장을 그대로 돌려줍니다"


def test_inactive_server_is_not_offered(_isolated_registries: MCPServerRegistry) -> None:
    """등록만 되고 ACTIVE 가 아니면(핸드셰이크 실패 등) 고를 수 없다 — 부를 수
    없는 Tool 을 제안하면 라우팅이 매번 실패로 끝난다."""
    _put(_isolated_registries, _server(state="UNREACHABLE"))
    assert "hello.echo" not in _names(mcp_tools.list_candidate_tools(OFFICE_PROFILE))


def test_scope_none_keeps_every_candidate(_isolated_registries: MCPServerRegistry) -> None:
    _put(_isolated_registries, _server())
    candidates = mcp_tools.list_candidate_tools(OFFICE_PROFILE)
    assert mcp_tools.filter_candidates_to_scope(candidates, None) == candidates


def test_scope_narrows_to_the_selected_tools(_isolated_registries: MCPServerRegistry) -> None:
    _put(_isolated_registries, _server())
    candidates = mcp_tools.list_candidate_tools(OFFICE_PROFILE)
    narrowed = mcp_tools.filter_candidates_to_scope(candidates, ("hello.now",))
    assert _names(narrowed) == ["hello.now"]


def test_scope_cannot_widen_the_candidate_set(_isolated_registries: MCPServerRegistry) -> None:
    """화면에서 보낸 이름이 후보에 없으면 **버린다**. 넣어 주면 그 이름이 곧
    권한이 되고, 라우터는 이 배포가 허용한 적 없는 Tool 을 제안하게 된다."""
    candidates = mcp_tools.list_candidate_tools(OFFICE_PROFILE)
    narrowed = mcp_tools.filter_candidates_to_scope(
        candidates, ("hello.echo", "os.delete_everything")
    )
    # hello-mcp 는 아직 등록되지 않았고, 두 번째 이름은 아무 데서도 오지 않았다.
    assert narrowed == []


def test_empty_scope_yields_no_candidates(_isolated_registries: MCPServerRegistry) -> None:
    """"고른 것이 없음"은 "전부"가 아니다 — 빈 선택이 전체 허용으로 읽히면
    사용자가 끈 것이 켜진 것이 된다."""
    _put(_isolated_registries, _server())
    candidates = mcp_tools.list_candidate_tools(OFFICE_PROFILE)
    assert mcp_tools.filter_candidates_to_scope(candidates, ()) == []


def test_scope_ignores_blank_names(_isolated_registries: MCPServerRegistry) -> None:
    _put(_isolated_registries, _server())
    candidates = mcp_tools.list_candidate_tools(OFFICE_PROFILE)
    narrowed = mcp_tools.filter_candidates_to_scope(candidates, ("", "   ", "hello.echo"))
    assert _names(narrowed) == ["hello.echo"]
