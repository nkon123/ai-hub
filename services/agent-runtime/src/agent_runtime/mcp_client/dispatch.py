"""D-094 — Tool 호출의 **유일한 경로**: 판정 → 호출 → 필터 → 감사.

지금까지 이 네 가지는 각각 존재했지만 이어져 있지 않았다. 그 상태로 두면
호출부마다 조립하게 되고, 조립은 빠뜨릴 수 있다 — 그리고 빠뜨려도 **아무것도
깨지지 않는다**. 필터를 건너뛴 결과는 잘 동작하는 것처럼 보이고(개인정보가 섞여
나갈 뿐), 감사를 건너뛴 호출도 잘 동작하는 것처럼 보인다(기록이 없을 뿐).
조용히 잘못될 수 있는 것은 구조로 막는다.

그래서 이 모듈은 하나의 함수만 공개하고, 그 함수가 네 단계를 **전부** 수행한다.
`client.call_tool` 은 이 함수 밖에서 부르지 않는다.

## 감사는 모든 종료 경로에 있다

거부·타임아웃·실패·성공 어느 쪽으로 끝나도 감사 이벤트가 하나 나온다. 성공한
호출만 기록되면 감사 기록은 "무슨 일이 있었는가"가 아니라 "무엇이 잘 됐는가"가
되고, 사후 조사에서 가장 알고 싶은 것(실패·타임아웃·거부)이 없다.

타임아웃과 실패를 **다른 값으로** 남기는 것도 같은 이유다 — 하나로 뭉개면
"서버가 느리다"와 "서버가 틀렸다"를 구분할 수 없다.

## 확인이 필요한 호출

`confirmation_required` 인데 `confirmed=False` 면 **호출하지 않고** 그대로
돌려준다. 여기서 감사 이벤트를 남기지 않는 것은 의도다 — 아직 아무 일도
일어나지 않았고, `MCPAuditResult` 에는 "대기 중"이 없다. 없는 상태를 기존
값으로 흉내 내면(예: DENIED) 사후에 "거부된 호출"과 "사용자 확인을 기다리다
만 호출"을 구분할 수 없게 된다. 확인 흐름 자체는 workflow 의
`mcp.confirmation_required` 이벤트가 이미 담당한다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass

from agent_runtime.mcp_client.audit import MCPAuditEvent, MCPAuditResult, event_from_decision, now_iso
from agent_runtime.mcp_client.client import call_tool, open_session
from agent_runtime.mcp_client.connection import resolve_connection_target
from agent_runtime.mcp_client.errors import MCPRegistrationError
from agent_runtime.mcp_client.policy import DispatchContext, DispatchDecision, RateLimiter, decide
from agent_runtime.mcp_client.result_filter import FilteredResult, ResultLimits, filter_tool_result

logger = logging.getLogger("agent_runtime")


@dataclass(frozen=True)
class DispatchOutcome:
    """한 번의 dispatch 가 끝난 뒤 남는 것 전부.

    `result` 는 **필터를 지난 것만** 담는다. 원본을 함께 들고 있으면 호출부가
    실수로 그쪽을 쓰게 되고, 그 실수는 눈에 보이지 않는다.
    """

    decision: DispatchDecision
    audit_event: MCPAuditEvent | None
    result: FilteredResult | None = None
    awaiting_confirmation: bool = False
    failure_reason: str | None = None

    @property
    def called(self) -> bool:
        return self.result is not None


async def dispatch_tool_call(
    *,
    server_alias: str,
    tool_name: str,
    arguments: dict | None,
    context: DispatchContext,
    registry,
    trace_id: str,
    run_id: str,
    settings,
    confirmed: bool = False,
    ai_derived_arguments: bool = False,
    input_valid: bool = True,
    rate_limiter: RateLimiter | None = None,
) -> DispatchOutcome:
    """MCP Tool 을 한 번 호출한다. **이 함수를 거치지 않는 호출 경로는 없다.**

    `registry` 는 `mcp_server_registry.MCPServerRegistry` 다. 타입으로 묶지 않고
    덕 타이핑으로 받는 것은 `mcp_client` 가 상위 모듈(레지스트리)을 import 하지
    않게 하기 위해서다 — 의존 방향은 레지스트리 → 클라이언트 한 방향이다.
    """
    server = registry.get(server_alias)
    policy = registry.get_policy(server_alias, tool_name)

    decision = decide(
        policy,
        context,
        server_alias=server_alias,
        tool_name=tool_name,
        arguments=arguments,
        server_active=bool(server is not None and server.state == "ACTIVE"),
        input_valid=input_valid,
        ai_derived_arguments=ai_derived_arguments,
        rate_limiter=rate_limiter,
    )

    started_at = now_iso()
    started = time.monotonic()

    def _audit(result: MCPAuditResult, **extra) -> MCPAuditEvent:
        return event_from_decision(
            decision,
            trace_id=trace_id,
            run_id=run_id,
            context=context,
            started_at=started_at,
            duration_ms=int((time.monotonic() - started) * 1000),
            result=result,
            provenance=getattr(server, "provenance", None),
            risk_level=getattr(policy, "risk_level", None),
            **extra,
        )

    if not decision.allowed:
        event = _audit(MCPAuditResult.DENIED)
        logger.info(
            "mcp.dispatch.denied alias=%s tool=%s reason=%s trace_id=%s",
            server_alias, tool_name, decision.denial_reason, trace_id,
        )
        return DispatchOutcome(decision=decision, audit_event=event)

    if decision.confirmation_required and not confirmed:
        # 아직 아무 일도 일어나지 않았다 — 감사 이벤트를 만들지 않는다(모듈
        # docstring 참고).
        return DispatchOutcome(
            decision=decision, audit_event=None, awaiting_confirmation=True
        )

    limits = ResultLimits.from_execution_guards(_execution_guards(server, tool_name))
    timeout = _timeout_seconds(server, tool_name, settings)

    try:
        target = resolve_connection_target(
            server.manifest, server.install_path, settings=settings
        )
        async with open_session(target, timeout_seconds=timeout) as session:
            raw = await asyncio.wait_for(
                call_tool(session, tool_name, arguments), timeout=timeout
            )
    except TimeoutError:
        event = _audit(MCPAuditResult.TIMEOUT)
        logger.warning(
            "mcp.dispatch.timeout alias=%s tool=%s trace_id=%s", server_alias, tool_name, trace_id
        )
        return DispatchOutcome(
            decision=decision, audit_event=event, failure_reason="timeout"
        )
    except MCPRegistrationError as exc:
        event = _audit(MCPAuditResult.FAILED)
        logger.warning(
            "mcp.dispatch.failed alias=%s tool=%s reason=%s trace_id=%s",
            server_alias, tool_name, exc.reason, trace_id,
        )
        return DispatchOutcome(
            decision=decision, audit_event=event, failure_reason=str(exc.reason)
        )
    except Exception:  # noqa: BLE001 — 어떤 실패든 감사는 남는다
        event = _audit(MCPAuditResult.FAILED)
        logger.warning(
            "mcp.dispatch.failed alias=%s tool=%s trace_id=%s",
            server_alias, tool_name, trace_id, exc_info=True,
        )
        return DispatchOutcome(
            decision=decision, audit_event=event, failure_reason="call_failed"
        )

    filtered = filter_tool_result(
        raw.content,
        raw.structured_content,
        limits=limits,
        classification=getattr(policy, "data_classification", None),
        is_error=raw.is_error,
    )

    event = _audit(
        MCPAuditResult.FAILED if raw.is_error else MCPAuditResult.SUCCEEDED,
        row_count=_row_count(filtered.structured_content),
        truncated=filtered.truncated,
    )
    return DispatchOutcome(decision=decision, audit_event=event, result=filtered)


def _declared(server, tool_name: str) -> dict:
    for declared in (getattr(server, "manifest", {}) or {}).get("declared_tools") or []:
        if isinstance(declared, dict) and declared.get("tool_name") == tool_name:
            return declared
    return {}


def _execution_guards(server, tool_name: str) -> dict:
    return _declared(server, tool_name).get("execution_guards") or {}


def _timeout_seconds(server, tool_name: str, settings) -> float:
    """Tool 이 선언한 시간 상한. 없으면 배포 기본값.

    매니페스트 값을 그대로 쓰되 배포가 정한 상한을 넘지 못하게 한다 — 서드파티
    매니페스트가 "600초" 라고 적어 두면 그 한 번의 호출이 런타임을 10분 묶을 수
    있다.
    """
    ceiling = float(getattr(settings, "mcp_connect_timeout_seconds", 20.0))
    declared = _execution_guards(server, tool_name).get("timeout_seconds")
    try:
        return min(float(declared), ceiling) if declared else ceiling
    except (TypeError, ValueError):
        return ceiling


def _row_count(structured) -> int | None:
    """감사에 남길 행 수. 결과 **본문**은 절대 남기지 않는다(§10)."""
    if isinstance(structured, list):
        return len(structured)
    if isinstance(structured, dict):
        for value in structured.values():
            if isinstance(value, list):
                return len(value)
    return None
