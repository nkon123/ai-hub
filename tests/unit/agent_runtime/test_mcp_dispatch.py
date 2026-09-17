"""D-094 — 판정·호출·필터·감사가 **한 경로**로 이어져 있는가.

이 네 가지는 각각 이미 테스트돼 있다. 여기서 확인하는 것은 그것들이 실제로
연결됐는가, 그리고 **빠뜨릴 수 없는가** 다. 조립을 호출부에 맡기면 언젠가
빠뜨리는데, 빠뜨려도 아무것도 깨지지 않는 것이 문제다 — 필터를 건너뛴 결과는
잘 동작하는 것처럼 보이고(개인정보가 섞여 나갈 뿐), 감사를 건너뛴 호출도
잘 동작하는 것처럼 보인다(기록이 없을 뿐).

그래서 여기 테스트는 대부분 "무엇이 일어나지 않았는가"를 본다.
"""

from __future__ import annotations

import pytest
from agent_runtime.mcp_client import dispatch as dispatch_module
from agent_runtime.mcp_client import (
    DispatchContext,
    MCPAuditResult,
    RawToolResult,
    ToolPolicy,
    dispatch_tool_call,
)

ADMIN = DispatchContext("u@miracom.com", ("ADMIN",), "miracom", "headquarters")


class _Settings:
    mcp_connect_timeout_seconds = 5.0
    mcp_server_install_roots = ("/tmp",)
    runtime_mode = "local"


class _Server:
    provenance = "THIRD_PARTY"
    install_path = None
    state = "ACTIVE"

    def __init__(self, guards: dict | None = None) -> None:
        self.manifest = {
            "transport": {"kind": "HTTP", "endpoint": "https://example.invalid/mcp"},
            "declared_tools": [
                {"tool_name": "read_file", "execution_guards": guards or {}},
            ],
        }


class _Registry:
    """레지스트리를 흉내 낸다 — dispatch 는 타입이 아니라 두 메서드만 쓴다."""

    def __init__(self, policy: ToolPolicy | None, server: _Server | None) -> None:
        self._policy = policy
        self._server = server

    def get(self, alias):  # noqa: ARG002
        return self._server

    def get_policy(self, alias, tool):  # noqa: ARG002
        return self._policy


def _policy(**over) -> ToolPolicy:
    base = dict(
        tool_name="read_file",
        risk_level="READ_ONLY",
        allowed_roles=("ADMIN",),
        allowed_orgs=("miracom",),
        data_classification="INTERNAL",
        confirmation_policy="NEVER",
    )
    base.update(over)
    return ToolPolicy(**base)


def _patch_call(monkeypatch, result=None, raises=None, record=None):
    """세션 열기와 `tools/call` 만 교체한다. 판정·필터·감사는 실제 코드가 돈다."""
    import contextlib

    @contextlib.asynccontextmanager
    async def _open(target, *, timeout_seconds=20.0):  # noqa: ARG001
        yield object()

    async def _call(session, tool_name, arguments):  # noqa: ARG001
        if record is not None:
            record.append((tool_name, arguments))
        if raises is not None:
            raise raises
        return result or RawToolResult(content=[], structured_content=None, is_error=False)

    monkeypatch.setattr(dispatch_module, "open_session", _open)
    monkeypatch.setattr(dispatch_module, "call_tool", _call)
    monkeypatch.setattr(
        dispatch_module, "resolve_connection_target", lambda *a, **k: object()
    )


async def _dispatch(registry, **over):
    kwargs = dict(
        server_alias="fs-helper",
        tool_name="read_file",
        arguments={"path": "a.txt"},
        context=ADMIN,
        registry=registry,
        trace_id="t-1",
        run_id="r-1",
        settings=_Settings(),
    )
    kwargs.update(over)
    return await dispatch_tool_call(**kwargs)


# --- 거부는 호출하지 않는다 --------------------------------------------------


@pytest.mark.asyncio
async def test_a_denied_call_never_reaches_the_server(monkeypatch) -> None:
    """판정이 거부인데 호출이 나가면 PEP 가 장식이 된다."""
    calls: list = []
    _patch_call(monkeypatch, record=calls)
    registry = _Registry(_policy(allowed_roles=("CREATOR",)), _Server())

    outcome = await _dispatch(registry)

    assert outcome.decision.allowed is False
    assert calls == [], "거부된 호출이 서버에 나갔다"
    assert outcome.result is None


@pytest.mark.asyncio
async def test_an_unregistered_server_is_denied(monkeypatch) -> None:
    """정책이 없으면 Default Deny — '모르는 것은 거부'."""
    calls: list = []
    _patch_call(monkeypatch, record=calls)

    outcome = await _dispatch(_Registry(None, None))

    assert outcome.decision.allowed is False
    assert calls == []


@pytest.mark.asyncio
async def test_a_denial_is_always_audited(monkeypatch) -> None:
    """거부가 기록되지 않으면 사후에 '시도조차 없었다'와 구분되지 않는다."""
    _patch_call(monkeypatch)
    registry = _Registry(_policy(allowed_orgs=("other",)), _Server())

    outcome = await _dispatch(registry)

    assert outcome.audit_event is not None
    assert outcome.audit_event.result is MCPAuditResult.DENIED
    assert outcome.audit_event.denial_reason


# --- 확인 대기 ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_confirmation_required_stops_before_the_call(monkeypatch) -> None:
    calls: list = []
    _patch_call(monkeypatch, record=calls)
    registry = _Registry(_policy(confirmation_policy="ALWAYS"), _Server())

    outcome = await _dispatch(registry)

    assert outcome.awaiting_confirmation is True
    assert calls == []


@pytest.mark.asyncio
async def test_awaiting_confirmation_is_not_recorded_as_a_denial(monkeypatch) -> None:
    """`MCPAuditResult` 에는 '대기 중'이 없다. 없는 상태를 DENIED 로 흉내 내면
    '거부된 호출'과 '확인을 기다리다 만 호출'이 사후에 같아진다."""
    _patch_call(monkeypatch)
    registry = _Registry(_policy(confirmation_policy="ALWAYS"), _Server())

    outcome = await _dispatch(registry)

    assert outcome.audit_event is None


@pytest.mark.asyncio
async def test_a_confirmed_call_goes_through(monkeypatch) -> None:
    calls: list = []
    _patch_call(monkeypatch, record=calls)
    registry = _Registry(_policy(confirmation_policy="ALWAYS"), _Server())

    outcome = await _dispatch(registry, confirmed=True)

    assert outcome.called is True
    assert calls == [("read_file", {"path": "a.txt"})]


# --- 결과는 반드시 필터를 지난다 ---------------------------------------------


@pytest.mark.asyncio
async def test_the_result_is_always_filtered(monkeypatch) -> None:
    """서드파티 서버는 자기 결과를 필터링할 의무가 없다. 파이프라인이 하지
    않으면 개인정보가 그대로 흘러나간다."""
    _patch_call(
        monkeypatch,
        result=RawToolResult(
            content=[{"type": "text", "text": "담당자 kim@miracom.com"}],
            structured_content={"rows": [{"phone": "010-1234-5678"}]},
            is_error=False,
        ),
    )
    registry = _Registry(_policy(), _Server())

    outcome = await _dispatch(registry)

    rendered = str(outcome.result.content) + str(outcome.result.structured_content)
    assert "kim@miracom.com" not in rendered
    assert "010-1234-5678" not in rendered
    assert "MASKED" in rendered


@pytest.mark.asyncio
async def test_the_outcome_does_not_carry_the_unfiltered_result(monkeypatch) -> None:
    """원본을 함께 들고 있으면 호출부가 실수로 그쪽을 쓰게 되고, 그 실수는
    눈에 보이지 않는다."""
    import dataclasses

    _patch_call(monkeypatch)
    registry = _Registry(_policy(), _Server())
    outcome = await _dispatch(registry)

    names = {f.name for f in dataclasses.fields(outcome)}
    assert "raw" not in names and "raw_result" not in names


@pytest.mark.asyncio
async def test_tool_declared_limits_are_applied(monkeypatch) -> None:
    _patch_call(
        monkeypatch,
        result=RawToolResult(
            content=[], structured_content={"rows": [{"v": i} for i in range(500)]},
            is_error=False,
        ),
    )
    registry = _Registry(_policy(), _Server(guards={"max_rows": 10}))

    outcome = await _dispatch(registry)

    assert len(outcome.result.structured_content["rows"]) == 10
    assert outcome.result.truncated is True


# --- 실패해도 감사는 남는다 --------------------------------------------------


@pytest.mark.asyncio
async def test_a_failed_call_is_audited(monkeypatch) -> None:
    """성공한 호출만 기록되면 감사는 '무슨 일이 있었는가'가 아니라 '무엇이 잘
    됐는가'가 된다 — 사후에 가장 알고 싶은 것이 없다."""
    _patch_call(monkeypatch, raises=RuntimeError("서버가 끊김"))
    registry = _Registry(_policy(), _Server())

    outcome = await _dispatch(registry)

    assert outcome.audit_event is not None
    assert outcome.audit_event.result is MCPAuditResult.FAILED
    assert outcome.result is None
    assert outcome.failure_reason == "call_failed"


@pytest.mark.asyncio
async def test_a_timeout_is_audited_as_a_timeout_not_a_failure(monkeypatch) -> None:
    """타임아웃과 오류를 같은 값으로 뭉개면 '서버가 느리다'와 '서버가 틀렸다'를
    구분할 수 없다."""
    _patch_call(monkeypatch, raises=TimeoutError())
    registry = _Registry(_policy(), _Server())

    outcome = await _dispatch(registry)

    assert outcome.audit_event.result is MCPAuditResult.TIMEOUT
    assert outcome.failure_reason == "timeout"


@pytest.mark.asyncio
async def test_a_server_error_result_is_audited_as_failed(monkeypatch) -> None:
    """서버가 is_error 로 돌려준 것을 성공으로 기록하면 감사가 거짓이 된다."""
    _patch_call(
        monkeypatch,
        result=RawToolResult(content=[], structured_content=None, is_error=True),
    )
    registry = _Registry(_policy(), _Server())

    outcome = await _dispatch(registry)

    assert outcome.audit_event.result is MCPAuditResult.FAILED
    assert outcome.result.is_error is True


# --- 감사에 본문이 없다 ------------------------------------------------------


@pytest.mark.asyncio
async def test_the_audit_event_never_carries_the_result_body(monkeypatch) -> None:
    """§10. 행 수는 남기되 본문은 남기지 않는다."""
    secret = "대외비 본문입니다"
    _patch_call(
        monkeypatch,
        result=RawToolResult(
            content=[{"type": "text", "text": secret}],
            structured_content={"rows": [{"note": secret}]},
            is_error=False,
        ),
    )
    registry = _Registry(_policy(), _Server())

    outcome = await _dispatch(registry)

    assert secret not in str(outcome.audit_event)
    assert outcome.audit_event.row_count == 1


@pytest.mark.asyncio
async def test_ai_derived_arguments_survive_into_the_audit(monkeypatch) -> None:
    """D-083. 사후 조사에서 '사람이 시킨 것'과 '모델이 제안한 것'이 섞이면 안 된다."""
    _patch_call(monkeypatch)
    registry = _Registry(_policy(), _Server())

    outcome = await _dispatch(registry, ai_derived_arguments=True)

    assert outcome.audit_event.ai_derived_arguments is True


# --- 배포가 정한 시간 상한 ---------------------------------------------------


def test_a_manifest_cannot_raise_the_timeout_above_the_deployment_ceiling() -> None:
    """서드파티 매니페스트가 '600초'라고 적어 두면 그 한 번의 호출이 런타임을
    10분 묶는다."""
    server = _Server(guards={"timeout_seconds": 600})
    assert dispatch_module._timeout_seconds(server, "read_file", _Settings()) == 5.0


def test_a_shorter_declared_timeout_is_honored() -> None:
    server = _Server(guards={"timeout_seconds": 2})
    assert dispatch_module._timeout_seconds(server, "read_file", _Settings()) == 2.0
