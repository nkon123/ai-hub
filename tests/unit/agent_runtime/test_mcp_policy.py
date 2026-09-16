"""D-094 Policy Enforcement Point — "이 호출을 해도 되는가".

MCP 프로토콜에 인가 모델이 없으므로, 여기서 막지 못한 것은 서드파티 서버가
막아주지 않는다. 그래서 이 파일이 확인하는 것은 대부분 **허용되지 않아야 할
것이 허용되지 않는가** 다.

M10(office-mcp-server)에서 옮겨 온 동작은 원본과 같은지를 함께 본다 — 옮기면서
조용히 느슨해지는 것이 이런 이전에서 가장 흔한 사고다.
"""

from __future__ import annotations

import pytest
from agent_runtime.mcp_client import (
    DispatchContext,
    RateLimiter,
    ToolPolicy,
    decide,
    is_llm_routable,
    requires_confirmation,
    routable_candidates,
)

ADMIN = DispatchContext(
    user_id="admin@miracom.com",
    roles=("ADMIN",),
    organization_id="miracom",
    site_id="headquarters",
    clearance="CONFIDENTIAL",
    actor_id="agent-1",
)


def _policy(**overrides) -> ToolPolicy:
    base = {
        "tool_name": "db_metadata.get_tables",
        "risk_level": "READ_ONLY",
        "allowed_roles": ("ADMIN", "CREATOR"),
        "allowed_orgs": ("miracom",),
        "allowed_sites": (),
        "data_classification": "INTERNAL",
        "confirmation_policy": "NEVER",
    }
    base.update(overrides)
    return ToolPolicy(**base)


def _decide(policy, context=ADMIN, **kw):
    return decide(
        policy,
        context,
        server_alias="office-connector",
        tool_name=policy.tool_name if policy else "x",
        **kw,
    )


def test_baseline_is_allowed() -> None:
    """아래 거부 테스트들은 전부 '이 상태에서 하나만 바꾼 것'이다."""
    d = _decide(_policy())
    assert d.allowed and d.denial_reason is None


# --- §7 Default Deny: 비어 있음은 '제한 없음'이 아니다 ----------------------


def test_empty_allowed_roles_denies_everyone() -> None:
    """M10 원본의 가장 중요한 성질. '아직 안 채웠다'가 '아무나 된다'로 읽히면
    검토를 건너뛴 Tool 이 전원에게 열린다."""
    d = _decide(_policy(allowed_roles=()))
    assert not d.allowed and d.denial_reason == "role_not_permitted"


def test_empty_allowed_orgs_denies_everyone() -> None:
    d = _decide(_policy(allowed_orgs=()))
    assert not d.allowed and d.denial_reason == "org_not_permitted"


def test_empty_allowed_sites_means_not_site_restricted() -> None:
    """사이트만 선택 차원이다 — 여기까지 Default Deny 로 만들면 사이트를 쓰지
    않는 배포에서 모든 Tool 이 막힌다(M10 원본도 이 하나만 예외로 둔다)."""
    d = _decide(_policy(allowed_sites=()), DispatchContext("u", ("ADMIN",), "miracom", None))
    assert d.allowed


def test_site_restriction_is_enforced_when_declared() -> None:
    policy = _policy(allowed_sites=("gumi",))
    d = _decide(policy, DispatchContext("u", ("ADMIN",), "miracom", "headquarters"))
    assert not d.allowed and d.denial_reason == "site_not_permitted"


def test_role_outside_the_allowlist_is_denied() -> None:
    d = _decide(_policy(), DispatchContext("u", ("AUDITOR",), "miracom", "headquarters"))
    assert not d.allowed and d.denial_reason == "role_not_permitted"


def test_other_org_is_denied() -> None:
    d = _decide(_policy(), DispatchContext("u", ("ADMIN",), "other-corp", "headquarters"))
    assert not d.allowed and d.denial_reason == "org_not_permitted"


# --- §7/§12.1 거부가 정책을 누설하지 않는다 ---------------------------------


@pytest.mark.parametrize(
    "policy_kwargs, context",
    [
        ({"allowed_roles": ()}, ADMIN),
        ({}, DispatchContext("u", ("AUDITOR",), "miracom", "headquarters")),
        ({}, DispatchContext("u", ("ADMIN",), "other-corp", "headquarters")),
        ({"allowed_sites": ("gumi",)}, ADMIN),
    ],
)
def test_denial_message_never_reveals_the_policy(policy_kwargs: dict, context) -> None:
    """어느 차원에서 막혔는지는 **감사에만** 남는다. 사용자 메시지가 그것을
    말하면 공격자가 권한 구조를 훑을 수 있다."""
    d = _decide(_policy(**policy_kwargs), context)
    assert not d.allowed
    assert d.denial_reason  # 감사에는 정확히 남는다
    for leak in ("ADMIN", "CREATOR", "miracom", "gumi", "headquarters", "role", "org", "site"):
        assert leak not in (d.message or "")


def test_all_authorization_denials_share_one_message() -> None:
    """메시지가 차원마다 다르면 문구 차이만으로 어디서 막혔는지 알 수 있다."""
    messages = {
        _decide(_policy(allowed_roles=()), ADMIN).message,
        _decide(_policy(), DispatchContext("u", ("AUDITOR",), "miracom")).message,
        _decide(_policy(), DispatchContext("u", ("ADMIN",), "other-corp")).message,
    }
    assert len(messages) == 1


# --- 등급: M11 공개 API 로만 판정한다 ---------------------------------------


def test_classification_above_clearance_is_denied() -> None:
    low = DispatchContext("u", ("ADMIN",), "miracom", "headquarters", clearance="PUBLIC_INTERNAL")
    d = _decide(_policy(data_classification="CONFIDENTIAL"), low)
    assert not d.allowed and d.denial_reason == "classification_above_clearance"


def test_unknown_classification_is_fail_closed() -> None:
    """판정 근거가 없으면 통과가 아니다 — D-062 가 막으려던 조용한 노출."""
    d = _decide(_policy(data_classification="UNKNOWN"))
    assert not d.allowed and d.denial_reason == "classification_above_clearance"


def test_unparseable_classification_is_fail_closed() -> None:
    d = _decide(_policy(data_classification="NOT_A_LEVEL"))
    assert not d.allowed and d.denial_reason == "classification_above_clearance"


# --- D-083: 모델은 쓰기 Tool 을 고를 수 없다 ---------------------------------


def test_write_tools_are_never_llm_routable() -> None:
    """선언이 아니라 유도다 — 매니페스트에 필드가 없으므로 'WRITE 인데 자동
    선택 가능'은 설정으로 만들 수 없는 상태다."""
    assert is_llm_routable("READ_ONLY") is True
    assert is_llm_routable("WRITE") is False
    assert _decide(_policy(risk_level="WRITE", confirmation_policy="ALWAYS")).llm_routable is False


def test_routable_candidates_exclude_write_and_unauthorized_tools() -> None:
    """고를 수 없는 것을 후보로 보여주면 모델이 그것을 고르고 사용자는 거부만
    본다 — 후보 집합은 이미 허용된 것보다 넓어질 수 없다(D-083)."""
    policies = [
        _policy(tool_name="read.ok"),
        _policy(tool_name="write.blocked", risk_level="WRITE", confirmation_policy="ALWAYS"),
        _policy(tool_name="other.org", allowed_orgs=("other-corp",)),
        _policy(tool_name="suspended.tool", suspended=True),
    ]
    assert routable_candidates(policies, ADMIN) == ("read.ok",)


# --- §8.4 확인 정책을 낮추지 않는다 ------------------------------------------


def test_write_always_requires_confirmation_even_if_declared_never() -> None:
    """계약이 WRITE+NEVER 를 이미 거부하지만, 스키마 검증을 거치지 않은 경로가
    생겨도 부수효과가 무인으로 나가지 않아야 한다."""
    assert requires_confirmation(_policy(risk_level="WRITE", confirmation_policy="NEVER"), {}) is True


def test_on_parameter_is_rounded_to_the_stricter_side() -> None:
    """계약에 '어느 인자가 확인을 유발하는가'를 적을 자리가 없어 일반 Tool 에
    대해서는 알 수 없다. 반올림해야 한다면 엄격한 쪽 — D-049 가 같은 상황에서
    내린 것과 같은 판단이다(느슨한 쪽으로 반올림하면 서버가 실제로 요구하는
    것보다 약한 정책을 사용자에게 보여주게 된다)."""
    assert requires_confirmation(_policy(confirmation_policy="ON_PARAMETER"), {"x": 1}) is True


def test_read_only_never_can_skip_confirmation() -> None:
    assert requires_confirmation(_policy(confirmation_policy="NEVER"), {}) is False


# --- §11 Kill Switch / 승인 여부 --------------------------------------------


def test_suspended_tool_is_denied() -> None:
    d = _decide(_policy(suspended=True))
    assert not d.allowed and d.denial_reason == "tool_suspended"


def test_unknown_tool_is_denied_as_not_approved() -> None:
    d = decide(None, ADMIN, server_alias="s", tool_name="never.approved")
    assert not d.allowed and d.denial_reason == "tool_not_approved"


def test_inactive_server_is_denied() -> None:
    d = _decide(_policy(), server_active=False)
    assert not d.allowed and d.denial_reason == "server_not_active"


def test_input_schema_violation_is_denied() -> None:
    d = _decide(_policy(), input_valid=False)
    assert not d.allowed and d.denial_reason == "input_schema_violation"


# --- §8.2 Rate Limit --------------------------------------------------------


def test_rate_limit_denies_past_the_tool_limit() -> None:
    limiter = RateLimiter()
    policy = _policy(rate_limit_per_minute=2)
    for _ in range(2):
        assert _decide(policy, rate_limiter=limiter).allowed
    d = _decide(policy, rate_limiter=limiter)
    assert not d.allowed and d.denial_reason == "rate_limited"


def test_a_denied_call_does_not_consume_rate_budget() -> None:
    """Rate Limit 을 인가보다 **뒤에** 두는 이유. 앞에 두면 어차피 거부될 호출이
    정상 호출의 예산을 갉아먹고, 권한 없는 호출을 반복해 남의 예산을 고갈시킬
    수 있다."""
    limiter = RateLimiter()
    blocked = _policy(tool_name="db_metadata.get_tables", allowed_roles=("NOBODY",))
    for _ in range(10):
        assert not _decide(blocked, rate_limiter=limiter).allowed

    allowed_policy = _policy(rate_limit_per_minute=2)
    assert _decide(allowed_policy, rate_limiter=limiter).allowed


def test_rate_limiter_records_nothing_when_any_key_is_over() -> None:
    """All-or-nothing. 부분 기록을 남기면 거부된 호출이 다른 키의 예산을 깎는다."""
    limiter = RateLimiter()
    assert limiter.check_and_record([("a", 1), ("b", 1)]) is None
    assert limiter.check_and_record([("a", 1), ("b", 5)]) == "a"
    # "b" 는 위 거부에서 기록되지 않았어야 한다.
    assert limiter.check_and_record([("b", 2)]) is None


# --- D-083: AI 가 만든 인자라는 사실이 판정을 바꾸지 않는다 ------------------


def test_ai_derived_flag_is_carried_but_does_not_change_the_decision() -> None:
    """확인 문구는 바뀌어야 하지만 권한 판정은 그대로다 — 모델이 인자를 썼다는
    이유로 더 허용되거나 덜 허용되면 그 자체가 새로운 통제 우회 경로다."""
    plain = _decide(_policy())
    ai = _decide(_policy(), ai_derived_arguments=True)
    assert ai.allowed == plain.allowed
    assert ai.confirmation_required == plain.confirmation_required
    assert ai.ai_derived_arguments is True and plain.ai_derived_arguments is False


# --- 계약과 같은 이름을 쓰는가 ----------------------------------------------


def test_denial_reasons_match_the_contract_enum() -> None:
    """`MCPToolDispatchDecision.denial_reason` 의 enum 과 실제로 만들어지는 값이
    갈라지면, 화면은 모르는 사유를 받고 감사는 분류되지 않은 값을 남긴다."""
    import json
    from pathlib import Path

    schema = json.loads(
        (
            Path(__file__).resolve().parents[3]
            / "packages"
            / "schemas"
            / "api"
            / "mcp-server-registration.schema.json"
        ).read_text(encoding="utf-8")
    )
    allowed = set(
        schema["definitions"]["MCPToolDispatchDecision"]["properties"]["denial_reason"]["enum"]
    )
    produced = {
        _decide(_policy(allowed_roles=())).denial_reason,
        _decide(_policy(allowed_orgs=())).denial_reason,
        _decide(_policy(allowed_sites=("gumi",))).denial_reason,
        _decide(_policy(data_classification="RESTRICTED"), ADMIN).denial_reason,
        _decide(_policy(suspended=True)).denial_reason,
        _decide(_policy(), server_active=False).denial_reason,
        _decide(_policy(), input_valid=False).denial_reason,
        decide(None, ADMIN, server_alias="s", tool_name="x").denial_reason,
    }
    assert produced <= allowed
