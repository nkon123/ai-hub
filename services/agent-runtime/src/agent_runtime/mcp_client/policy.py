"""D-094 Policy Enforcement Point — "이 호출을 해도 되는가".

MCP 프로토콜에는 인가 모델이 없다. `tools/call` 은 누가 부르는지도, 무엇을
봐도 되는지도 묻지 않는다. 그래서 05-mcp-security-governance.md 의 통제를
**서버 안**(office-mcp-server 가 자기 호출에 대해 하던 것)에서 **클라이언트
안**으로 옮긴다. 옮기는 것이 버리는 것보다 나은 이유는 적용 범위다: 서버 안에
있으면 우리가 만든 서버만 지키지만, 클라이언트에 있으면 **서드파티 서버에도
똑같이 적용된다** — 그리고 통제가 정말 필요한 쪽은 후자다.

여기서 내리는 판정(§7 인가, §8.2 Rate Limit, §8.4 확인 정책, §11 Kill Switch)은
계약의 `MCPToolDispatchDecision` 그대로다. 출력 필터(§9)와 결과 상한(§8.3)은
호출 **이후**에 적용되는 것이라 이 모듈이 아니라 별도 단계다.

지키는 규칙 넷, 전부 M10 의 원본 동작에서 그대로 옮긴 것:

1. **Default Deny** — `allowed_roles` 나 `allowed_orgs` 가 비어 있으면 아무도
   허용되지 않는다. "비었으니 제한 없음" 이 아니다. `allowed_sites` 만
   선택 차원이라 비어 있으면 "사이트 제한 없음" 이다.
2. **거부는 정책을 누설하지 않는다** — 어느 차원에서 막혔는지는 감사에만
   남기고, 사용자에게는 권한이 없다는 사실과 문의처만 말한다(§7/§12.1).
3. **모델은 쓰기 Tool 을 고를 수 없다** — `llm_routable` 은 `risk_level` 에서
   **유도**한다. 매니페스트에 선언 필드를 두지 않았으므로 "WRITE 인데 자동
   선택 가능" 은 설정으로 만들 수 없는 상태다(D-083 의 fail-closed 전제).
4. **확인 정책을 낮추지 않는다** — 선언된 것보다 약하게 판정하지 않는다.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from security_policy import Classification, clearance_covers

#: §8.2. 서버 전체에 걸리는 상한 — M10 의 `SERVER_RATE_LIMIT_PER_MINUTE` 와 같은 값.
SERVER_RATE_LIMIT_PER_MINUTE = 300
#: Tool 이 자기 상한을 선언하지 않았을 때. 보수적인 쪽으로 둔다(§8.2 "PoC 에서는
#: 보수적인 고정 Limit 으로 시작").
DEFAULT_TOOL_RATE_LIMIT_PER_MINUTE = 30

#: 사용자에게 보이는 거부 문구. 어느 차원에서 막혔는지 말하지 않는다.
_DENIAL_MESSAGE = "이 Tool을 호출할 권한이 없습니다. 담당자에게 문의하세요."
_RATE_LIMIT_MESSAGE = "호출 빈도 제한을 초과했습니다. 잠시 후 다시 시도하세요."
_SUSPENDED_MESSAGE = "이 Tool은 현재 사용이 중지되어 있습니다."
_SERVER_INACTIVE_MESSAGE = "이 MCP 서버에 연결되어 있지 않습니다."
_NOT_APPROVED_MESSAGE = "승인되지 않은 Tool은 호출할 수 없습니다."
_INPUT_INVALID_MESSAGE = "Tool 입력이 정의된 형식과 맞지 않습니다."


@dataclass(frozen=True)
class ToolPolicy:
    """매니페스트 `declared_tools[]` 한 항목의 거버넌스 메타데이터.

    **서버에서 읽은 값이 아니다.** 승인 시점에 검토자가 부여한 것이다 — 서버는
    신뢰 대상이 아니므로 자기 권한을 스스로 주장할 수 없다.
    """

    tool_name: str
    risk_level: str  # READ_ONLY | WRITE
    allowed_roles: tuple[str, ...] = ()
    allowed_orgs: tuple[str, ...] = ()
    allowed_sites: tuple[str, ...] = ()
    data_classification: str | None = None
    confirmation_policy: str = "ALWAYS"
    rate_limit_per_minute: int = DEFAULT_TOOL_RATE_LIMIT_PER_MINUTE
    suspended: bool = False

    @classmethod
    def from_declared_tool(cls, declared: dict, *, server_classification: str | None = None):
        permissions = declared.get("permissions") or {}
        guards = declared.get("execution_guards") or {}
        return cls(
            tool_name=declared["tool_name"],
            risk_level=declared.get("risk_level", "WRITE"),
            allowed_roles=tuple(permissions.get("allowed_roles") or ()),
            allowed_orgs=tuple(permissions.get("allowed_orgs") or ()),
            allowed_sites=tuple(permissions.get("allowed_sites") or ()),
            data_classification=declared.get("data_classification") or server_classification,
            confirmation_policy=declared.get("confirmation_policy", "ALWAYS"),
            rate_limit_per_minute=int(
                guards.get("rate_limit_per_minute") or DEFAULT_TOOL_RATE_LIMIT_PER_MINUTE
            ),
            suspended=bool(declared.get("suspended", False)),
        )


@dataclass(frozen=True)
class DispatchContext:
    """호출자 신원. 전송 계층 모양에 의존하지 않도록 라우터가 만들어 넘긴다.

    이 값들은 **호출자가 주장하는 것**이다 — 실제 신원 검증은 상위 계층의
    몫이고, search-runtime 의 `access_context` 가 같은 성질을 갖는다(D-062/D-015).
    """

    user_id: str
    roles: tuple[str, ...]
    organization_id: str
    site_id: str | None = None
    clearance: str = "INTERNAL"
    actor_id: str = "-"


@dataclass(frozen=True)
class DispatchDecision:
    """계약의 `MCPToolDispatchDecision` 그대로."""

    tool_name: str
    server_alias: str
    allowed: bool
    confirmation_required: bool
    llm_routable: bool
    denial_reason: str | None = None
    message: str | None = None
    ai_derived_arguments: bool = False


class RateLimiter:
    """§8.2 고정 윈도 카운터. M10 의 것과 같은 동작 — 이 PoC 의 런타임은 단일
    프로세스라 in-memory 로 충분하다(분산/영속 아님)."""

    def __init__(self, window_seconds: float = 60.0) -> None:
        self._window_seconds = window_seconds
        self._counts: dict[str, tuple[int, float]] = {}

    def _count_in_window(self, key: str, now: float) -> int:
        count, start = self._counts.get(key, (0, now))
        if now - start >= self._window_seconds:
            return 0
        return count

    def check_and_record(self, keys_with_limits: list[tuple[str, int]]) -> str | None:
        """All-or-nothing: 하나라도 한도에 닿아 있으면 **아무것도 기록하지 않고**
        그 키를 돌려준다. 부분 기록을 남기면 거부된 호출이 다른 키의 예산을
        갉아먹는다."""
        now = time.monotonic()
        for key, limit in keys_with_limits:
            if self._count_in_window(key, now) >= limit:
                return key
        for key, _limit in keys_with_limits:
            count, start = self._counts.get(key, (0, now))
            if now - start >= self._window_seconds:
                count, start = 0, now
            self._counts[key] = (count + 1, start)
        return None


def is_llm_routable(risk_level: str) -> bool:
    """D-083 이 '후보로 제안해도 안전한 Tool 표면' 을 전제로 fail-closed 설계를
    했다. WRITE 가 들어오는 순간 그 전제가 깨지므로, 쓰기 Tool 은 모델 후보에서
    구조적으로 빠진다 — 선언이 아니라 유도라, 설정으로 되돌릴 수 없다."""
    return risk_level == "READ_ONLY"


def requires_confirmation(policy: ToolPolicy, arguments: dict | None) -> bool:
    """§8.4. 선언된 정책보다 약하게 판정하지 않는다.

    `ON_PARAMETER` 는 지금 `ALWAYS` 와 같게 동작한다. 계약에 **어느 인자가**
    확인을 유발하는지 적을 자리가 없어서, 일반 Tool 에 대해 이 런타임이 그것을
    알 방법이 없기 때문이다. 둘 중 하나로 반올림해야 한다면 엄격한 쪽이다 —
    D-049 가 같은 상황(스키마가 `ON_PARAMETER` 를 표현하지 못함)에서 내린 것과
    같은 판단이고, 반대로 반올림하면 서버가 실제로 요구하는 것보다 약한 정책을
    사용자에게 보여주게 된다. `confirmation_parameters` 를 계약에 추가하면 이
    함수가 그때 의미를 갖는다(미결로 기록됨).
    """
    if policy.risk_level == "WRITE":
        # 계약이 WRITE + NEVER 를 이미 거부하지만, 스키마 검증을 거치지 않은
        # 경로가 생겨도 부수효과가 무인으로 나가지 않게 여기서도 막는다.
        return True
    return policy.confirmation_policy in ("ALWAYS", "ON_PARAMETER")


def _authorization_denial(policy: ToolPolicy, context: DispatchContext) -> str | None:
    """§7. 어느 차원에서 막혔는지 이름으로 돌려준다 — 감사에 정확히 남기기
    위해서다. 이 값이 사용자 메시지로 흘러가면 안 된다(§7/§12.1)."""
    # Default Deny: 비어 있으면 '제한 없음' 이 아니라 '아무도 안 됨'.
    if not policy.allowed_roles or not any(r in policy.allowed_roles for r in context.roles):
        return "role_not_permitted"
    if not policy.allowed_orgs or context.organization_id not in policy.allowed_orgs:
        return "org_not_permitted"
    # allowed_sites 만 선택 차원 — 비어 있으면 사이트 제한이 없다는 뜻이다.
    if policy.allowed_sites and context.site_id not in policy.allowed_sites:
        return "site_not_permitted"
    return None


def _classification_denial(policy: ToolPolicy, context: DispatchContext) -> str | None:
    """등급 판정은 M11 의 공개 API 로만 한다 — 이 판정을 재구현하지 않는다
    (루트 원칙: Enum·판정은 중앙 정의 사용)."""
    if not policy.data_classification:
        return None
    try:
        tool_level = Classification(policy.data_classification)
        clearance = Classification(context.clearance)
    except ValueError:
        # 알 수 없는 등급은 판정 근거가 없다는 뜻이므로 통과시키지 않는다
        # (search-runtime 의 fail-closed 와 같은 방향).
        return "classification_above_clearance"
    # `allow_unknown_classification=False` 는 협상 대상이 아니다 — 켜면 D-062 가
    # 막으려던 조용한 정보 노출이 그대로 돌아온다. search-runtime 이 이 값을
    # 배포 설정으로 두는 것과 달리 여기서는 상수다: Tool 결과는 검색 결과와
    # 달리 부수효과를 동반할 수 있어 느슨하게 둘 이유가 없다.
    covered = clearance_covers(clearance, tool_level, allow_unknown_classification=False)
    return None if covered else "classification_above_clearance"


_DENIAL_MESSAGES = {
    "server_not_active": _SERVER_INACTIVE_MESSAGE,
    "tool_not_approved": _NOT_APPROVED_MESSAGE,
    "tool_suspended": _SUSPENDED_MESSAGE,
    "rate_limited": _RATE_LIMIT_MESSAGE,
    "input_schema_violation": _INPUT_INVALID_MESSAGE,
}


def decide(
    policy: ToolPolicy | None,
    context: DispatchContext,
    *,
    server_alias: str,
    tool_name: str,
    arguments: dict | None = None,
    server_active: bool = True,
    input_valid: bool = True,
    ai_derived_arguments: bool = False,
    rate_limiter: RateLimiter | None = None,
) -> DispatchDecision:
    """한 번의 dispatch 에 대한 판정. 모든 호출이 여기를 지난다 — TOOL_ROUTE 가
    제안한 것도 예외가 아니다(D-083: 모델 출력은 발동이 아니라 제안이며, 기존
    체크포인트를 우회하지 않고 **그대로 통과**한다).

    검사 순서는 의도적이다: 신원과 무관한 사실(서버 연결, 승인 여부, 중지 여부)
    → 인가 → 등급 → 입력 → Rate Limit. Rate Limit 이 마지막인 이유는 그것만이
    **상태를 바꾸는** 검사이기 때문이다. 앞에 두면 어차피 거부될 호출이 정상
    호출의 예산을 갉아먹는다.
    """

    def deny(reason: str, *, routable: bool = False) -> DispatchDecision:
        return DispatchDecision(
            tool_name=tool_name,
            server_alias=server_alias,
            allowed=False,
            confirmation_required=False,
            llm_routable=routable,
            denial_reason=reason,
            message=_DENIAL_MESSAGES.get(reason, _DENIAL_MESSAGE),
            ai_derived_arguments=ai_derived_arguments,
        )

    if policy is None:
        return deny("tool_not_approved")

    routable = is_llm_routable(policy.risk_level)

    if not server_active:
        return deny("server_not_active", routable=routable)
    if policy.suspended:
        return deny("tool_suspended", routable=routable)

    denial = _authorization_denial(policy, context)
    if denial:
        return deny(denial, routable=routable)

    denial = _classification_denial(policy, context)
    if denial:
        return deny(denial, routable=routable)

    if not input_valid:
        return deny("input_schema_violation", routable=routable)

    if rate_limiter is not None:
        over = rate_limiter.check_and_record(
            [
                (f"user:{context.user_id}:{tool_name}", policy.rate_limit_per_minute),
                (f"actor:{context.actor_id}:{tool_name}", policy.rate_limit_per_minute),
                ("server", SERVER_RATE_LIMIT_PER_MINUTE),
            ]
        )
        if over is not None:
            return deny("rate_limited", routable=routable)

    return DispatchDecision(
        tool_name=tool_name,
        server_alias=server_alias,
        allowed=True,
        confirmation_required=requires_confirmation(policy, arguments),
        llm_routable=routable,
        denial_reason=None,
        message=None,
        ai_derived_arguments=ai_derived_arguments,
    )


def routable_candidates(policies: list[ToolPolicy], context: DispatchContext) -> tuple[str, ...]:
    """TOOL_ROUTE(D-083) 가 모델에게 보여줄 후보. 쓰기 Tool 은 여기서 구조적으로
    빠지고, 호출자가 볼 권한이 없는 Tool 도 빠진다 — 고를 수 없는 것을 후보로
    보여주면 모델이 그것을 고르고 사용자는 거부만 본다."""
    out: list[str] = []
    for policy in policies:
        if not is_llm_routable(policy.risk_level) or policy.suspended:
            continue
        if _authorization_denial(policy, context) or _classification_denial(policy, context):
            continue
        out.append(policy.tool_name)
    return tuple(sorted(out))
