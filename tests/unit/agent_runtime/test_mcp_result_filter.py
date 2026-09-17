"""D-094 PEP 후반 — 돌아온 결과를 그대로 내보내도 되는가 (§9, §8.3)와 감사(§10).

서드파티 서버는 자기 결과를 필터링할 의무가 없다. 개인정보를 그대로 돌려주는
서버도, 수십 MB 를 뱉는 서버도 정상적으로 존재한다 — 서버를 고칠 수 없으니
받는 쪽에서 막는지를 확인한다.

감사 쪽은 "무엇이 남는가" 보다 **"무엇이 남을 수 없는가"** 를 본다.
"""

from __future__ import annotations

import dataclasses

import pytest
from agent_runtime.mcp_client import (
    DispatchContext,
    MCPAuditEvent,
    MCPAuditResult,
    ResultLimits,
    content_blocks_to_dicts,
    decide,
    event_from_decision,
    filter_tool_result,
    mask_pii,
    mask_pii_deep,
    now_iso,
)
from agent_runtime.mcp_client.result_filter import apply_result_limits

# --- §9 개인정보 마스킹 ------------------------------------------------------


@pytest.mark.parametrize(
    "raw, must_not_contain",
    [
        ("문의: hong@miracom.com 으로 주세요", "hong@miracom.com"),
        ("연락처 010-1234-5678", "010-1234-5678"),
        ("연락처 01012345678", "01012345678"),
    ],
)
def test_pii_is_masked_in_free_text(raw: str, must_not_contain: str) -> None:
    masked = mask_pii(raw)
    assert must_not_contain not in masked
    assert "MASKED" in masked


def test_pii_masking_reaches_nested_structures() -> None:
    """서드파티 서버의 결과 모양을 미리 알 수 없다 — 최상위만 훑으면 한 겹만
    들어가도 그대로 새어 나간다."""
    value = {
        "rows": [{"comment": "contact a@b.co"}, {"nested": {"deep": ["call 010-1111-2222"]}}]
    }
    masked = mask_pii_deep(value)
    flat = str(masked)
    assert "a@b.co" not in flat and "010-1111-2222" not in flat
    assert flat.count("MASKED") == 2


def test_masking_is_applied_to_content_blocks() -> None:
    """MCP 결과의 본문은 대부분 `content` 블록의 텍스트다. structured_content
    만 필터링하면 실제 데이터 경로를 통째로 놓친다."""
    result = filter_tool_result(
        [{"type": "text", "text": "담당자 kim@miracom.com"}],
        None,
    )
    assert "kim@miracom.com" not in result.content[0]["text"]


def test_non_text_blocks_are_left_alone() -> None:
    """이미지 바이트를 정규식으로 훑는 것은 의미가 없고, 손대면 데이터가 깨진다."""
    blob = "iVBORw0KGgoAAAANSUhEUg=="
    result = filter_tool_result([{"type": "image", "data": blob, "mimeType": "image/png"}], None)
    assert result.content[0]["data"] == blob


# --- §8.3 결과 상한 ----------------------------------------------------------


def test_row_cap_applies_to_a_top_level_list() -> None:
    """M10 은 dict 안의 리스트 필드만 다뤘다. MCP 의 structured_content 는
    최상위가 리스트일 수 있어서, 그 경우를 놓치면 상한이 통째로 안 걸린다."""
    value, truncated = apply_result_limits(list(range(500)), ResultLimits(max_rows=10))
    assert len(value) == 10 and truncated


def test_row_cap_applies_inside_a_dict() -> None:
    value, truncated = apply_result_limits(
        {"items": list(range(500))}, ResultLimits(max_rows=10)
    )
    assert len(value["items"]) == 10 and truncated


def test_long_string_fields_are_truncated() -> None:
    value, truncated = apply_result_limits(
        {"rows": [{"note": "x" * 5000}]}, ResultLimits(max_field_length=100)
    )
    assert len(value["rows"][0]["note"]) == 101  # 100 + 생략 표시
    assert truncated


def test_byte_cap_trims_further_when_still_over_budget() -> None:
    value, truncated = apply_result_limits(
        {"rows": [{"v": "y" * 500} for _ in range(100)]},
        ResultLimits(max_rows=100, max_bytes=2000, max_field_length=500),
    )
    import json

    assert len(json.dumps(value).encode()) <= 2000
    assert truncated


def test_byte_cap_does_not_loop_forever_on_unshrinkable_content() -> None:
    """리스트가 아닌 큰 값은 더 줄일 수 없다. 그래도 멈춰야 하고, truncated 는
    정직하게 표시되어야 한다 — 여기서 무한 루프가 나면 Tool 호출 하나가 런타임을
    묶는다."""
    value, truncated = apply_result_limits({"blob": "z" * 10000}, ResultLimits(max_bytes=10))
    assert truncated
    assert value is not None


def test_untruncated_result_reports_false() -> None:
    """모든 결과에 truncated=True 를 붙이면 그 플래그는 의미가 없어진다."""
    _, truncated = apply_result_limits({"items": [1, 2, 3]}, ResultLimits())
    assert truncated is False


def test_content_blocks_are_capped_by_row_limit() -> None:
    blocks = [{"type": "text", "text": f"line {i}"} for i in range(500)]
    result = filter_tool_result(blocks, None, limits=ResultLimits(max_rows=5))
    assert len(result.content) == 5 and result.truncated


# --- 순서: 상한 → 마스킹 -----------------------------------------------------


def test_masking_runs_before_truncation_so_a_cut_email_cannot_leak() -> None:
    """실측 결함(2026-09-17). 상한을 먼저 걸면 이메일 중간이 잘리고, 남은 조각은
    정규식에 안 걸려 로컬 파트가 그대로 남는다 — `...someone@ex…`.

    처음 쓴 테스트는 `"someone@example.com" not in ...` 만 봤는데, 그 문자열은
    **두 순서 모두에서** 사라지므로 아무것도 구분하지 못했다(변이 테스트로
    발각됨). 잘려서 남는 조각인 `someone` 을 봐야 순서를 실제로 고정한다.
    """
    result = filter_tool_result(
        [],
        {"note": "x" * 90 + "someone@example.com"},
        limits=ResultLimits(max_field_length=100),
    )
    rendered = str(result.structured_content)
    assert "someone" not in rendered
    assert "MASKED" in rendered


def test_masking_a_short_address_cannot_push_the_result_over_the_cap() -> None:
    """마스킹이 길이를 늘리는 경우다 — `a@b.co`(6자) → `[MASKED_EMAIL]`(14자).
    M10 은 "마스킹은 항상 줄인다"고 보고 마스킹 뒤에 상한을 다시 걸지 않았다.
    여기서는 마스킹 뒤에 상한을 걸므로 늘어나도 최종 크기가 보장된다."""
    result = filter_tool_result(
        [], {"rows": [{"c": "a@b.co"} for _ in range(50)]}, limits=ResultLimits(max_bytes=300)
    )
    import json

    assert len(json.dumps(result.structured_content, ensure_ascii=False).encode()) <= 300
    assert result.truncated


# --- 등급 라벨 ---------------------------------------------------------------


def test_classification_label_is_attached() -> None:
    result = filter_tool_result([], {"a": 1}, classification="CONFIDENTIAL")
    assert result.classification == "CONFIDENTIAL"


def test_error_flag_is_carried_through() -> None:
    """서버가 오류를 돌려줬다는 사실이 필터를 지나며 사라지면 호출자가 실패를
    성공으로 읽는다."""
    assert filter_tool_result([], None, is_error=True).is_error is True


# --- SDK 타입 경계 -----------------------------------------------------------


def test_content_blocks_to_dicts_handles_sdk_objects_and_plain_dicts() -> None:
    """이 함수 하나만 SDK 타입을 안다 — 나머지 필터는 순수 데이터만 다뤄서
    SDK 없이 테스트되고, SDK 가 필드명을 바꿔도 여기만 고치면 된다."""
    # 선언된 의존성(`mcp`)이 재노출하는 것을 쓴다 — `mcp_types` 는
    # 전이 의존성이라 직접 import 하면 환경에 따라 없다.
    from mcp import types as t

    blocks = content_blocks_to_dicts([t.TextContent(type="text", text="hi"), {"type": "x"}])
    assert blocks[0]["text"] == "hi"
    assert blocks[1] == {"type": "x"}


# --- §10 감사: 담을 수 없어야 하는 것 ----------------------------------------


def _event(**kw) -> MCPAuditEvent:
    base = dict(
        trace_id="t",
        run_id="r",
        user_id="u@miracom.com",
        organization_id="miracom",
        server_alias="fs-helper",
        tool_name="read_file",
        result=MCPAuditResult.SUCCEEDED,
        started_at=now_iso(),
        duration_ms=12,
    )
    base.update(kw)
    return MCPAuditEvent(**base)


@pytest.mark.parametrize(
    "forbidden", ["input", "output", "parameters", "arguments", "result_body", "raw_output"]
)
def test_audit_event_cannot_carry_call_input_or_output(forbidden: str) -> None:
    """§10 "입력 Parameter와 결과 본문은 기본 Audit Event에 포함하지 않는다" 를
    관례가 아니라 구조로 지킨다 — 채울 속성 자체가 없어야 한다. 관례로 두면
    언젠가 '디버깅용으로 잠깐만' 이 들어오고 그 잠깐이 남는다."""
    fields = {f.name for f in dataclasses.fields(MCPAuditEvent)}
    assert forbidden not in fields

    with pytest.raises(TypeError):
        _event(**{forbidden: "민감한 값"})


def test_audit_event_is_frozen() -> None:
    """기록된 뒤에 조용히 바뀌면 감사가 아니다."""
    event = _event()
    with pytest.raises(dataclasses.FrozenInstanceError):
        event.result = MCPAuditResult.DENIED  # type: ignore[misc]


def test_denial_reason_survives_into_the_audit_event() -> None:
    """사용자에게는 감추는 차원을 감사에는 정확히 남긴다 — 그게 없으면 사후에
    왜 막혔는지 알 수 없다."""
    from agent_runtime.mcp_client import ToolPolicy

    context = DispatchContext("u", ("AUDITOR",), "miracom", "headquarters")
    policy = ToolPolicy(
        tool_name="read_file",
        risk_level="READ_ONLY",
        allowed_roles=("ADMIN",),
        allowed_orgs=("miracom",),
    )
    decision = decide(policy, context, server_alias="fs-helper", tool_name="read_file")
    event = event_from_decision(
        decision,
        trace_id="t",
        run_id="r",
        context=context,
        started_at=now_iso(),
        duration_ms=3,
        result=MCPAuditResult.DENIED,
    )
    assert event.denial_reason == "role_not_permitted"
    assert event.result is MCPAuditResult.DENIED


def test_ai_derived_flag_survives_into_the_audit_event() -> None:
    """D-083. 사후 조사에서 '사람이 시킨 것'과 '모델이 제안하고 사람이 승인한
    것'을 구분할 수 없으면 둘을 섞어 읽게 된다."""
    from agent_runtime.mcp_client import ToolPolicy

    context = DispatchContext("u", ("ADMIN",), "miracom", "headquarters")
    policy = ToolPolicy(
        tool_name="read_file",
        risk_level="READ_ONLY",
        allowed_roles=("ADMIN",),
        allowed_orgs=("miracom",),
        data_classification="INTERNAL",
    )
    decision = decide(
        policy,
        context,
        server_alias="fs-helper",
        tool_name="read_file",
        ai_derived_arguments=True,
    )
    event = event_from_decision(
        decision,
        trace_id="t",
        run_id="r",
        context=context,
        started_at=now_iso(),
        duration_ms=3,
        result=MCPAuditResult.SUCCEEDED,
        provenance="THIRD_PARTY",
    )
    assert event.ai_derived_arguments is True
    assert event.provenance == "THIRD_PARTY"
