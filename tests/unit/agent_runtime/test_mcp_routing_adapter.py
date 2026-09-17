"""D-094 — 새 프로토콜 경로를 기존 workflow 에 끼워 넣는 이음매.

여기서 가장 중요한 것은 **게시된 챗봇 4개가 달라지지 않는 것**이다. 그것들은
Office Profile 이 이름을 아는 office-mcp-server Tool 을 쓰고, 그 Tool 들은
레지스트리에 없다. 라우팅이 조금이라도 넓게 잡히면 검증된 경로가 조용히
바뀐다 — 그래서 "언제 새 경로로 가는가"보다 **"언제 가지 않는가"**를 더 많이
확인한다.

두 번째로 중요한 것은 거부가 어느 차원에서 막혔는지 새어 나가지 않는 것이다
(§7). 인가·등급 거부는 전부 같은 오류코드로 모여야 한다.
"""

from __future__ import annotations

import pytest
from agent_runtime.adapters.mcp import MCPCallError
from agent_runtime.adapters.mcp_protocol import ProtocolMCPAdapter, RoutingMCPAdapter
from agent_runtime.mcp_client import FilteredResult, ToolPolicy
from agent_runtime.mcp_client import dispatch as dispatch_module


class _Settings:
    mcp_connect_timeout_seconds = 5.0
    mcp_server_install_roots = ("/tmp",)
    runtime_mode = "local"


class _Server:
    provenance = "INTERNAL"
    install_path = None
    state = "ACTIVE"
    manifest = {
        "transport": {"kind": "HTTP", "endpoint": "https://example.invalid/mcp"},
        "declared_tools": [{"tool_name": "read_file", "execution_guards": {}}],
    }


class _Registry:
    def __init__(self, known: dict[tuple[str, str], ToolPolicy] | None = None) -> None:
        self._known = known or {}

    def get(self, alias):  # noqa: ARG002
        return _Server() if self._known else None

    def get_policy(self, alias, tool):
        return self._known.get((alias, tool))


class _LegacyAdapter:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def call_tool(self, request):
        self.calls.append(request)
        return {"output": {"legacy": True}, "rows_returned": 1, "truncated": False}


def _policy(**over) -> ToolPolicy:
    base = dict(
        tool_name="read_file",
        risk_level="READ_ONLY",
        allowed_roles=("ADMIN",),
        allowed_orgs=("miracom",),
        confirmation_policy="NEVER",
    )
    base.update(over)
    return ToolPolicy(**base)


def _request(**over) -> dict:
    request = {
        "tool_name": "read_file",
        "server_alias": "fs-helper",
        "input": {},
        "confirmed": True,
        "audit_context": {
            "trace_id": "t-1",
            "run_id": "r-1",
            "user": {
                "id": "u@miracom.com",
                "organization_id": "miracom",
                "site_id": "headquarters",
                "roles": ["ADMIN"],
            },
        },
    }
    request.update(over)
    return request


def _patch_dispatch(monkeypatch, outcome):
    async def _fake(**kwargs):  # noqa: ARG001
        return outcome

    monkeypatch.setattr("agent_runtime.adapters.mcp_protocol.dispatch_tool_call", _fake)


# --- 기존 경로를 건드리지 않는다 ---------------------------------------------


@pytest.mark.asyncio
async def test_a_tool_not_in_the_registry_goes_to_the_legacy_path() -> None:
    """게시된 챗봇 4개가 쓰는 Tool 은 레지스트리에 없다 — 기존 경로 그대로."""
    legacy = _LegacyAdapter()
    adapter = RoutingMCPAdapter(_Registry(), _Settings(), legacy)

    result = await adapter.call_tool(_request(tool_name="db_metadata.get_tables"))

    assert result["output"] == {"legacy": True}
    assert len(legacy.calls) == 1


@pytest.mark.asyncio
async def test_the_legacy_request_is_passed_through_unchanged() -> None:
    """기존 어댑터가 받는 요청 모양이 달라지면 검증된 경로가 조용히 바뀐다."""
    legacy = _LegacyAdapter()
    adapter = RoutingMCPAdapter(_Registry(), _Settings(), legacy)
    request = _request(tool_name="db_metadata.get_tables")

    await adapter.call_tool(request)

    assert legacy.calls[0] == request


def test_routing_is_decided_by_registration_not_a_flag() -> None:
    """플래그로 고르면 누군가 켜야 하고, 켜는 것을 잊으면 새 경로는 영원히
    죽은 코드가 된다."""
    empty = RoutingMCPAdapter(_Registry(), _Settings(), _LegacyAdapter())
    registered = RoutingMCPAdapter(
        _Registry({("fs-helper", "read_file"): _policy()}), _Settings(), _LegacyAdapter()
    )

    assert empty.uses_protocol("fs-helper", "read_file") is False
    assert registered.uses_protocol("fs-helper", "read_file") is True


@pytest.mark.asyncio
async def test_a_registered_tool_goes_to_the_protocol_path(monkeypatch) -> None:
    legacy = _LegacyAdapter()
    adapter = RoutingMCPAdapter(
        _Registry({("fs-helper", "read_file"): _policy()}), _Settings(), legacy
    )
    _patch_dispatch(
        monkeypatch,
        dispatch_module.DispatchOutcome(
            decision=_allowed_decision(),
            audit_event=None,
            result=FilteredResult(content=[], structured_content={"ok": True}),
        ),
    )

    result = await adapter.call_tool(_request())

    assert legacy.calls == [], "등록된 Tool 이 기존 경로로 샜다"
    assert result["output"]["structured_content"] == {"ok": True}


def _allowed_decision(**over):
    from agent_runtime.mcp_client import DispatchDecision

    base = dict(
        tool_name="read_file",
        server_alias="fs-helper",
        allowed=True,
        confirmation_required=False,
        llm_routable=True,
    )
    base.update(over)
    return DispatchDecision(**base)


def _denied_decision(reason: str):
    from agent_runtime.mcp_client import DispatchDecision

    return DispatchDecision(
        tool_name="read_file",
        server_alias="fs-helper",
        allowed=False,
        confirmation_required=False,
        llm_routable=False,
        denial_reason=reason,
        message="이 Tool 을 호출할 수 없습니다.",
    )


# --- 거부가 정책 구조를 누설하지 않는다 --------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reason", ["role_not_permitted", "org_not_permitted", "site_not_permitted",
               "classification_above_clearance"]
)
async def test_authorization_denials_all_collapse_to_one_code(monkeypatch, reason: str) -> None:
    """§7. 어느 차원에서 막혔는지 알려 주면 정책 구조를 역추적할 수 있다."""
    adapter = ProtocolMCPAdapter(_Registry({("fs-helper", "read_file"): _policy()}), _Settings())
    _patch_dispatch(
        monkeypatch,
        dispatch_module.DispatchOutcome(decision=_denied_decision(reason), audit_event=None),
    )

    with pytest.raises(MCPCallError) as exc:
        await adapter.call_tool(_request())
    assert exc.value.code == "MCP_PERMISSION_DENIED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reason, code",
    [
        ("tool_not_approved", "MCP_TOOL_NOT_FOUND"),
        ("server_not_active", "MCP_SERVER_UNAVAILABLE"),
        ("tool_suspended", "MCP_TOOL_DISABLED"),
        ("input_schema_violation", "MCP_INPUT_INVALID"),
        ("rate_limited", "RATE_LIMITED"),
    ],
)
async def test_operational_denials_keep_their_own_code(monkeypatch, reason, code) -> None:
    """운영상 구분이 필요한 것(없는 Tool/중지/입력 오류/한도)은 정책 차원이
    아니므로 각자의 코드를 유지한다 — 사용자가 고칠 수 있는 것들이다."""
    adapter = ProtocolMCPAdapter(_Registry({("fs-helper", "read_file"): _policy()}), _Settings())
    _patch_dispatch(
        monkeypatch,
        dispatch_module.DispatchOutcome(decision=_denied_decision(reason), audit_event=None),
    )

    with pytest.raises(MCPCallError) as exc:
        await adapter.call_tool(_request())
    assert exc.value.code == code


def test_every_mapped_code_exists_in_the_central_list() -> None:
    """여기서만 아는 오류코드를 만들면 화면이 그것을 모른다."""
    from office_mcp_server.errors import ErrorCode
    from agent_runtime.adapters.mcp_protocol import _DENIAL_TO_ERROR_CODE

    central = {e.value for e in ErrorCode}
    unknown = set(_DENIAL_TO_ERROR_CODE.values()) - central
    assert not unknown, f"중앙 목록에 없는 코드: {unknown}"


# --- 확인을 건너뛴 호출 ------------------------------------------------------


@pytest.mark.asyncio
async def test_an_unconfirmed_call_is_refused_not_silently_run(monkeypatch) -> None:
    """확인 정책을 낮추는 유일한 방법이 '실수로 건너뛰기'가 되어서는 안 된다."""
    adapter = ProtocolMCPAdapter(_Registry({("fs-helper", "read_file"): _policy()}), _Settings())
    _patch_dispatch(
        monkeypatch,
        dispatch_module.DispatchOutcome(
            decision=_allowed_decision(confirmation_required=True),
            audit_event=None,
            awaiting_confirmation=True,
        ),
    )

    with pytest.raises(MCPCallError):
        await adapter.call_tool(_request(confirmed=False))


# --- 실패 번역 ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_timeout_keeps_its_own_code(monkeypatch) -> None:
    adapter = ProtocolMCPAdapter(_Registry({("fs-helper", "read_file"): _policy()}), _Settings())
    _patch_dispatch(
        monkeypatch,
        dispatch_module.DispatchOutcome(
            decision=_allowed_decision(), audit_event=None, failure_reason="timeout"
        ),
    )

    with pytest.raises(MCPCallError) as exc:
        await adapter.call_tool(_request())
    assert exc.value.code == "MCP_EXECUTION_TIMEOUT"


@pytest.mark.asyncio
async def test_the_returned_output_is_the_filtered_one(monkeypatch) -> None:
    """어댑터가 필터를 지나지 않은 값을 꺼내 오면 파이프라인을 우회하는 셈이다."""
    adapter = ProtocolMCPAdapter(_Registry({("fs-helper", "read_file"): _policy()}), _Settings())
    _patch_dispatch(
        monkeypatch,
        dispatch_module.DispatchOutcome(
            decision=_allowed_decision(),
            audit_event=None,
            result=FilteredResult(
                content=[{"type": "text", "text": "[MASKED_EMAIL]"}],
                structured_content=None,
                truncated=True,
            ),
        ),
    )

    result = await adapter.call_tool(_request())

    assert result["truncated"] is True
    assert result["output"]["content"] == [{"type": "text", "text": "[MASKED_EMAIL]"}]
