"""D-094 MCP 감사 이벤트 — 05-mcp-security-governance.md §10.

M10 의 `audit.py` 를 클라이언트로 옮긴 것이고, 그 모듈의 핵심 성질을 그대로
가져온다: **"입력 Parameter와 결과 본문은 기본 Audit Event에 포함하지 않는다"
를 규칙이 아니라 구조로 지킨다.** 이 dataclass 에는 `input`/`output`/
`parameters` 필드가 **아예 없다** — 그래서 실수로 채울 속성 자체가 없다.
문서화된 관례로 두면 언젠가 "디버깅용으로 잠깐만" 이 들어오고, 그 잠깐이
남는다.

서드파티 서버를 붙이면서 오히려 더 중요해진 것: 감사에는 **어느 서버의 어느
Tool 이 누구의 권한으로 무엇을 했는지**가 남아야 한다. 그래서 M10 의 필드에
`server_alias`/`provenance`/`ai_derived_arguments`/`denial_reason` 을 더했다 —
서드파티 서버였는지, 인자를 모델이 썼는지, 왜 거부됐는지는 사후에 반드시
구분되어야 하는 사실이다.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from enum import StrEnum


class MCPAuditResult(StrEnum):
    SUCCEEDED = "SUCCEEDED"
    DENIED = "DENIED"
    FAILED = "FAILED"
    TIMEOUT = "TIMEOUT"


@dataclass(frozen=True)
class MCPAuditEvent:
    """한 번의 dispatch 에 대한 기록.

    필드를 추가할 때 한 가지만 지킨다: **호출 입력이나 결과 본문을 담는 필드를
    만들지 않는다.** 행 수·절단 여부처럼 본문을 드러내지 않는 요약은 괜찮다.
    """

    trace_id: str
    run_id: str
    user_id: str
    organization_id: str
    server_alias: str
    tool_name: str
    result: MCPAuditResult
    started_at: str
    duration_ms: int
    site_id: str | None = None
    service_id: str | None = None
    agent_id: str | None = None
    provenance: str | None = None
    risk_level: str | None = None
    #: 거부된 경우에만. `policy.DispatchDecision.denial_reason` 그대로 —
    #: 사용자에게는 감추는 차원(role/org/site)을 여기에는 정확히 남긴다.
    denial_reason: str | None = None
    #: D-083. 인자를 모델이 만들었는지. 사후에 "사람이 시킨 것"과 "모델이
    #: 제안하고 사람이 승인한 것"을 구분할 수 없으면 사고 조사 때 둘을 섞게 된다.
    ai_derived_arguments: bool = False
    confirmation_required: bool = False
    row_count: int | None = None
    truncated: bool | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def event_from_decision(
    decision,
    *,
    trace_id: str,
    run_id: str,
    context,
    started_at: str,
    duration_ms: int,
    result: MCPAuditResult,
    provenance: str | None = None,
    risk_level: str | None = None,
    row_count: int | None = None,
    truncated: bool | None = None,
) -> MCPAuditEvent:
    """판정 결과와 호출 컨텍스트에서 감사 이벤트를 만든다.

    `decision` 과 `context` 를 받는 것은 의도다 — 호출자가 필드를 손으로
    골라 담으면 거부 사유나 AI 파생 여부를 빠뜨리기 쉽고, 그 둘은 빠뜨려도
    아무것도 깨지지 않는 종류의 값이라 조용히 사라진다.
    """
    return MCPAuditEvent(
        trace_id=trace_id,
        run_id=run_id,
        user_id=context.user_id,
        organization_id=context.organization_id,
        site_id=context.site_id,
        server_alias=decision.server_alias,
        tool_name=decision.tool_name,
        result=result,
        started_at=started_at,
        duration_ms=duration_ms,
        provenance=provenance,
        risk_level=risk_level,
        denial_reason=decision.denial_reason,
        ai_derived_arguments=decision.ai_derived_arguments,
        confirmation_required=decision.confirmation_required,
        row_count=row_count,
        truncated=truncated,
    )
