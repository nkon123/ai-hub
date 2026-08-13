"""Standard Knowledge (+ optional MCP Tool) chat workflow (state machine).

INPUT_VALIDATE -> PREPARE -> ANALYZE -> KNOWLEDGE_ROUTE (optional) ->
KNOWLEDGE_SEARCH (0..n) -> TOOL_CONFIRM (optional) -> MCP_TOOL_CALL (0..n) ->
ANSWER_GENERATE -> OUTPUT_VALIDATE -> COMPLETE

(stage list per 02-desktop-and-agent-runtime.md §5.2, extended with
KNOWLEDGE_ROUTE — agentic Knowledge selection, only present when the caller
supplies `knowledge_candidates`; see `agent_runtime.knowledge_router` and
this function's own docstring on `knowledge_candidates` for the full
contract, including its fail-open guarantee.)

Never call the LLM to *answer* when there is no evidence at all — neither
Knowledge citations nor MCP Tool results (hallucination guard, D-036,
extended here to also cover the MCP-capable agent's tool-only answers) —
terminate with INSUFFICIENT_EVIDENCE instead, without ever reaching
ANSWER_GENERATE. Desktop 대화 고도화 (multi-turn/`history`) does not weaken
this: `history` can influence KNOWLEDGE_SEARCH's query (§3.4 Query Rewrite,
agent_runtime.conversation.rewrite_query_for_search — itself one *search-
shaping* LLM call, made before citations are known, whose output never
reaches the end user) and can be shown to the model as labeled, non-
evidentiary context once ANSWER_GENERATE is reached — but it is never
consulted by the guard itself, and a run with history but zero citations
(and zero Tool results) still terminates at INSUFFICIENT_EVIDENCE exactly as
it always has, one asyncio task earlier than the answer-generation call. See
`tests/integration/agent_runtime/test_runs.py`'s
`test_history_does_not_bypass_hallucination_guard` for the regression proof.

ANALYZE (the tool-selection decision) is deterministic, not model-driven:
the caller declares `mcp_tool_request` explicitly — an explicit field on the
run's `input`, extracted by routers/runs.py — instead of the Runtime asking
an LLM to decide/produce a tool call and parsing its free-form output. This
is exactly what 02-desktop-and-agent-runtime.md §5.2 means by "Tool
Calling이 약한 로컬 모델은 Runtime의 명시적 Workflow와 Schema 기반 호출을
사용한다": no model output is ever interpreted as a tool invocation. Before
any network call, the requested tool name is checked against the Office
Profile's `allowed_mcp_servers[].allowed_tools` allowlist
(`mcp_tools.resolve_allowed_alias`) and its input is validated against the
local static schema copy (`mcp_tools.validate_tool_input`) — both are pure,
local, and unit-testable without a live LLM, live MCP server, or live
search-runtime.

TOOL_CONFIRM (§8.4 ALWAYS/ON_PARAMETER Tools) parks the Run in
WAITING_FOR_USER via `_await_confirmation` — RUNNING -> WAITING_FOR_USER ->
(approve/deny via `POST /runs/{id}/confirm`) -> RUNNING, or FAILED on
confirmation timeout, or CANCELLED if the Run is cancelled while waiting
(02-...md §5.3, D-052 후속). This is additive to, never a replacement for,
office-mcp-server's own independent §8.4 enforcement — an approved call still
dispatches with `confirmed=true` through the same validated path (allowlist +
local schema check) as a caller-pre-confirmed request.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncGenerator
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from typing import Any, cast
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from observability import bind_run_id, bind_trace_id

from agent_runtime import mcp_tools
from agent_runtime.adapters import HubSearchAdapter, KnowledgeAdapter, LLMAdapter, MCPAdapter
from agent_runtime.adapters.hub_search import HubSearchError
from agent_runtime.adapters.mcp import MCPCallError
from agent_runtime.adapters.search import KnowledgeSearchError
from agent_runtime.config import settings
from agent_runtime.conversation import bound_history, rewrite_query_for_search
from agent_runtime.hub_query import build_hub_query
from agent_runtime.knowledge_router import KnowledgeRouteResult, route_knowledge_candidates
from agent_runtime.manifests import StandardKnowledgeChatConfig
from agent_runtime.prompt_renderer import build_messages
from agent_runtime.run_store import PendingConfirmation, RunRecord, RunStore

logger = logging.getLogger(__name__)

# Per-call MCP timeout (02-...md §5.2 MCP Client rule "Timeout, Cancellation,
# Result Size 제한"). This is a Runtime-side ceiling independent of
# office-mcp-server's own per-tool `timeout_seconds` (the authoritative
# one) — whichever fires first wins.
_MCP_CALL_TIMEOUT_SECONDS = 15.0

# 07-data-api-contracts.md §1 declares `service_id` as a UUID identifier
# (local-runtime-api.yaml's StartRunRequest.service_id also declares
# `format: uuid`), but there is no Service Registry yet (D-034) —
# StartRunRequest.service_id is accepted as an opaque caller string (a
# Hosted Chat slug, or any caller-chosen string in local/test runs) with no
# UUID guarantee. 05-mcp-security-governance.md §3's Request Context expects
# `service_id` to identify a real registered service. Rather than crash on a
# non-UUID value or pass a non-conforming string into the MCP audit trail,
# this derives a *stable* UUID5 from the opaque string: the same input
# always yields the same UUID, so audit correlation for a given logical
# service_id stays consistent across runs, instead of a fresh, untraceable
# random UUID per call. This is NOT a real Portal-registered Service UUID —
# it is a deliberate, documented compromise (open-decisions.md) to be
# replaced once agent-runtime can resolve a real Service Registry entry.
_SERVICE_ID_NAMESPACE = NAMESPACE_URL


def _derive_service_uuid(service_id: str) -> str:
    try:
        return str(UUID(service_id))
    except ValueError:
        return str(uuid5(_SERVICE_ID_NAMESPACE, f"urn:agent-runtime:service:{service_id}"))


# PoC Mock User Context (D-015) — agent-runtime has no caller-identity
# adapter yet (D-035: unauthenticated). A real identity/auth layer would
# supply these instead of a fixed constant.
_POC_MCP_USER_ID = "poc-local-runtime-user"
_POC_MCP_USER_ROLES = ["USER"]

# Placeholder — there is no ServiceVersion Registry lookup available to this
# Runtime yet (D-034), so no real version string exists for an opaque
# service_id. Deliberately not shaped like a real semver release so it never
# reads as authoritative in an audit trail.
_POC_SERVICE_VERSION = "0.0.0-poc-unregistered"


class _Cancelled:
    """Sentinel: `_run_mcp_tool_call` already recorded the run's terminal
    CANCELLED state itself; the caller must simply stop."""

    __slots__ = ()


_CANCELLED = _Cancelled()


class _Denied:
    """Sentinel: the user explicitly declined the Tool call via
    `POST /runs/{id}/confirm` (decision="deny"). Deliberately distinct from
    `_Cancelled` — per D-052 후속 ("Denial is a first-class outcome (run ends
    cleanly, not an error)"), a denial does not fail or cancel the Run. It
    simply contributes no MCP evidence: the caller treats this exactly like
    `mcp_tool_request` had never been supplied, so the existing hallucination
    guard (D-036) decides the outcome — SUCCEEDED off Knowledge citations
    alone if there are any, INSUFFICIENT_EVIDENCE otherwise. Never FAILED."""

    __slots__ = ()


_DENIED = _Denied()

# §5.3 사용자 확인 정책의 Tool 하나(`table_count.query`)에 대한 안내 문구.
# 새 ALWAYS/ON_PARAMETER Tool이 추가되면 사람이 이 표를 갱신해야 한다
# (mcp_tools.py의 MCP_TOOL_SPECS 손 복사 관례와 동일한 종류의 Drift 위험,
# open-decisions.md에 기록).
_TOOL_ACTION_DESCRIPTIONS: dict[str, str] = {
    "table_count.query": "테이블의 데이터 건수를 조회",
}


def _build_confirmation_summary(tool_name: str, raw_input: dict[str, Any]) -> str:
    """Human-readable Korean summary of what will run if approved.

    Deliberately excludes filter *values* (arbitrary business/query data) —
    only the table/schema identifiers that are themselves part of the
    already-validated structural input (not the "raw query") are shown, plus
    a count of any filters. This keeps the D-052 후속 property ("MCP events
    never carry raw tool input/results") intact for the confirmation panel:
    the user learns *what* will be queried, never the specific values being
    filtered on.
    """
    action = _TOOL_ACTION_DESCRIPTIONS.get(tool_name, "Tool을 실행")
    schema_name = raw_input.get("schema")
    table_name = raw_input.get("table")
    target = f"'{schema_name}.{table_name}'" if schema_name and table_name else f"'{tool_name}'"
    summary = f"{target} {action}합니다."
    filters = raw_input.get("filters") or []
    if filters:
        summary += f" (필터 {len(filters)}개 적용, 값은 표시되지 않음)"
    return summary


async def _await_confirmation(
    *,
    run_id: str,
    trace_id: str,
    run_store: RunStore,
    run_record: RunRecord,
    tool_name: str,
    summary: str,
    timeout_seconds: float,
) -> str | tuple[str, str] | _Cancelled | _Denied:
    """Parks the Run in WAITING_FOR_USER and waits for one of three things:
    an explicit decision (`POST /runs/{id}/confirm`), a cancellation
    (`POST /runs/{id}/cancel` — "Cancel must still work while waiting"), or
    the confirmation timeout expiring (§5.3 "무한 대기를 방지하기 위해
    만료시간을 가진다"). Every branch finalizes run_store state itself before
    returning, so the caller only needs to interpret the return value."""
    deadline = datetime.now(UTC) + timedelta(seconds=timeout_seconds)
    confirmation = PendingConfirmation(tool_name=tool_name, summary=summary, deadline=deadline)
    run_record.confirmation = confirmation
    run_store.set_status(run_id, "WAITING_FOR_USER")
    run_store.append_event(
        run_id,
        "mcp.confirmation_required",
        {"tool_name": tool_name, "summary": summary, "deadline": deadline.isoformat()},
    )

    confirm_task: asyncio.Task[bool] = asyncio.ensure_future(confirmation.event.wait())
    cancel_task: asyncio.Task[bool] = asyncio.ensure_future(run_record.cancel_event.wait())
    done, pending = await asyncio.wait(
        {confirm_task, cancel_task},
        timeout=timeout_seconds,
        return_when=asyncio.FIRST_COMPLETED,
    )
    for task in pending:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    run_record.confirmation = None  # no longer pending, whichever way this resolves

    if confirm_task in done:
        decision = confirmation.decision or "deny"
        run_store.set_status(run_id, "RUNNING")
        run_store.append_event(
            run_id, "mcp.confirmation_resolved", {"tool_name": tool_name, "decision": decision}
        )
        return _DENIED if decision == "deny" else "approve"

    if cancel_task in done:
        run_store.set_status(run_id, "CANCELLED")
        run_store.append_event(run_id, "run.cancelled", {"trace_id": trace_id})
        return _CANCELLED

    # Neither resolved nor cancelled before the deadline — terminate rather
    # than hold the Run (and its background asyncio.Task) open indefinitely.
    run_store.append_event(run_id, "mcp.confirmation_expired", {"tool_name": tool_name})
    return (
        "MCP_CONFIRMATION_TIMEOUT",
        "사용자 확인 대기 시간이 초과되어 실행이 중단되었습니다.",
    )


def _fail(run_store: RunStore, run_id: str, trace_id: str, code: str, message: str) -> None:
    error = {"code": code, "message": message, "trace_id": trace_id}
    run_store.set_status(run_id, "FAILED", error=error)
    run_store.append_event(run_id, "run.failed", error)


def _build_mcp_audit_context(
    *,
    request_id: str,
    trace_id: str,
    run_id: str,
    service_id: str,
    agent_manifest: dict[str, Any],
    office_profile: dict[str, Any],
    tool_name: str,
) -> dict[str, Any]:
    """05-mcp-security-governance.md §3 Request Context — built only from
    Runtime-trusted values (manifest / office profile / run identifiers),
    never from Agent Prompt or tool input (see request_context.py's module
    docstring on the office-mcp-server side for the boundary this exists to
    enforce)."""
    sites = office_profile.get("sites") or ["unknown-site"]
    return {
        "request_id": request_id,
        "trace_id": trace_id,
        "run_id": run_id,
        "service_id": _derive_service_uuid(service_id),
        "service_version": _POC_SERVICE_VERSION,
        "agent_id": agent_manifest["id"],
        "agent_version": agent_manifest["version"],
        "user": {
            "id": _POC_MCP_USER_ID,
            "organization_id": office_profile.get("org", "unknown-org"),
            "site_id": sites[0],
            "roles": list(_POC_MCP_USER_ROLES),
        },
        "requested_tool": tool_name,
    }


async def _run_mcp_tool_call(
    *,
    run_id: str,
    service_id: str,
    trace_id: str,
    config: StandardKnowledgeChatConfig,
    mcp_adapter: MCPAdapter | None,
    mcp_tool_request: dict[str, Any],
    run_store: RunStore,
    confirmation_timeout_seconds: float,
) -> dict[str, Any] | tuple[str, str] | _Cancelled | _Denied:
    """Validate then (if valid) execute one MCP_TOOL_CALL.

    Returns:
    - a common-envelope dict on success — fed into ANSWER_GENERATE as cited
      evidence alongside Knowledge citations.
    - an `(error_code, message)` tuple on any pre-flight/call failure or a
      confirmation timeout — the caller turns this into a clean `run.failed`
      (never an unhandled exception).
    - the `_CANCELLED` sentinel if the run was cancelled (mid-call, or while
      WAITING_FOR_USER) — this function has already recorded the terminal
      CANCELLED state itself.
    - the `_DENIED` sentinel if the user declined the confirmation — the
      caller must treat this as "no tool evidence", not a failure.

    Every rejection branch before the `mcp_adapter.call_tool` dispatch runs
    with zero network calls — the allowlist and schema checks are pure,
    local, and always run first.
    """
    tool_name = mcp_tool_request.get("tool_name")
    raw_input = mcp_tool_request.get("input") or {}
    confirmed = bool(mcp_tool_request.get("confirmed", False))

    if not isinstance(tool_name, str) or not tool_name:
        return ("MCP_TOOL_NOT_FOUND", "요청한 MCP Tool 이름이 없습니다.")

    alias = mcp_tools.resolve_allowed_alias(config.office_profile, tool_name)
    if alias is None:
        return ("MCP_TOOL_NOT_FOUND", "Office Profile에 허용되지 않은 MCP Tool입니다.")

    schema_errors = mcp_tools.validate_tool_input(tool_name, raw_input)
    if schema_errors:
        return ("MCP_INPUT_INVALID", "; ".join(schema_errors))

    run_record = run_store.get(run_id)
    assert run_record is not None

    policy = mcp_tools.confirmation_policy_for(tool_name)
    if policy != mcp_tools.NEVER and not confirmed:
        # §5.3 RUNNING -> WAITING_FOR_USER -> (resume) RUNNING. This is an
        # additional gate on top of office-mcp-server's own §8.4 enforcement
        # (D-052 후속 constraint #4) — a "confirmed" outcome below still
        # dispatches through the exact same `confirmed=true` path as a
        # caller-pre-confirmed request, so office-mcp-server independently
        # re-checks its own policy either way.
        summary = _build_confirmation_summary(tool_name, raw_input)
        outcome = await _await_confirmation(
            run_id=run_id,
            trace_id=trace_id,
            run_store=run_store,
            run_record=run_record,
            tool_name=tool_name,
            summary=summary,
            timeout_seconds=confirmation_timeout_seconds,
        )
        if isinstance(outcome, (_Cancelled, _Denied, tuple)):
            return outcome
        confirmed = True  # outcome == "approve"

    if mcp_adapter is None:
        return ("MCP_SERVER_UNAVAILABLE", "MCP Adapter가 구성되지 않았습니다.")

    audit_context = _build_mcp_audit_context(
        request_id=str(uuid4()),
        trace_id=trace_id,
        run_id=run_id,
        service_id=service_id,
        agent_manifest=config.agent_manifest,
        office_profile=config.office_profile,
        tool_name=tool_name,
    )
    call_request = {
        "tool_name": tool_name,
        "server_alias": alias,
        "input": raw_input,
        "audit_context": audit_context,
        "confirmed": confirmed,
    }

    run_store.append_event(run_id, "mcp.call.started", {"tool_name": tool_name})

    started = time.monotonic()
    call_task: asyncio.Task[dict[str, Any]] = asyncio.ensure_future(
        mcp_adapter.call_tool(call_request)
    )
    cancel_task: asyncio.Task[bool] = asyncio.ensure_future(run_record.cancel_event.wait())
    done, _pending = await asyncio.wait(
        {call_task, cancel_task},
        timeout=_MCP_CALL_TIMEOUT_SECONDS,
        return_when=asyncio.FIRST_COMPLETED,
    )

    if call_task not in done:
        # Either cancelled or timed out mid-call — either way, stop waiting.
        call_task.cancel()
        with suppress(asyncio.CancelledError):
            await call_task
        if cancel_task in done:
            run_store.append_event(
                run_id,
                "mcp.call.completed",
                {"tool_name": tool_name, "success": False, "error_code": "CANCELLED"},
            )
            run_store.set_status(run_id, "CANCELLED")
            run_store.append_event(run_id, "run.cancelled", {"trace_id": trace_id})
            return _CANCELLED
        run_store.append_event(
            run_id,
            "mcp.call.completed",
            {"tool_name": tool_name, "success": False, "error_code": "MCP_EXECUTION_TIMEOUT"},
        )
        return ("MCP_EXECUTION_TIMEOUT", "MCP Tool 호출이 시간 초과되었습니다.")

    cancel_task.cancel()
    with suppress(asyncio.CancelledError):
        await cancel_task

    duration_ms = int((time.monotonic() - started) * 1000)
    try:
        result = call_task.result()
    except MCPCallError as exc:
        run_store.append_event(
            run_id,
            "mcp.call.completed",
            {
                "tool_name": tool_name,
                "success": False,
                "error_code": exc.code,
                "duration_ms": duration_ms,
            },
        )
        return (exc.code, exc.message)
    except Exception:  # noqa: BLE001 — an adapter contract violation must never crash the run
        logger.exception("mcp.call.unexpected_error run_id=%s tool=%s", run_id, tool_name)
        run_store.append_event(
            run_id,
            "mcp.call.completed",
            {
                "tool_name": tool_name,
                "success": False,
                "error_code": "MCP_SERVER_UNAVAILABLE",
                "duration_ms": duration_ms,
            },
        )
        return ("MCP_SERVER_UNAVAILABLE", "MCP Tool 호출 중 알 수 없는 오류가 발생했습니다.")

    row_count = result.get("rows_returned")
    truncated = bool(result.get("truncated", False))
    run_store.append_event(
        run_id,
        "mcp.call.completed",
        {
            "tool_name": tool_name,
            "success": True,
            "duration_ms": duration_ms,
            "row_count": row_count,
            "truncated": truncated,
        },
    )
    return {"tool_name": tool_name, "output": result.get("output"), "truncated": truncated}


async def run_knowledge_chat(
    run_id: str,
    service_id: str,
    trace_id: str,
    knowledge_id: str,
    question: str,
    config: StandardKnowledgeChatConfig,
    llm_adapter: LLMAdapter,
    knowledge_adapter: KnowledgeAdapter,
    run_store: RunStore,
    mcp_adapter: MCPAdapter | None = None,
    mcp_tool_request: dict[str, Any] | None = None,
    mcp_confirmation_timeout_seconds: float | None = None,
    user_context: dict[str, Any] | None = None,
    history: list[dict[str, Any]] | None = None,
    knowledge_ids: list[str] | None = None,
    knowledge_candidates: list[dict[str, Any]] | None = None,
    allow_hub_lookup: bool = False,
    hub_search_adapter: HubSearchAdapter | None = None,
) -> None:
    """`mcp_adapter`/`mcp_tool_request` are additive/optional — the
    Knowledge-only standard-agent path (both always None/omitted, exactly
    as before this change) is byte-for-byte unaffected: `mcp_tool_request`
    stays None, the MCP_TOOL_CALL block below is skipped entirely, and
    `mcp_adapter.call_tool` is never invoked.

    `mcp_confirmation_timeout_seconds` defaults to
    `AgentRuntimeSettings.mcp_confirmation_timeout_seconds` (a setting, not a
    hardcoded literal — see config.py) when omitted; the explicit parameter
    exists so tests can inject a short timeout without monkeypatching global
    state.

    `user_context` (D-062, additive/optional) is the Run's own trusted
    context — `StartRunRequest.user_context` (routers/runs.py), set by the
    calling service, e.g. a future authenticated Hosted Chat session or
    Desktop — NEVER derived from `input`/the chat question body, which an
    end user directly controls. Only its `clearance` key is read here, to
    build the search request's `access_context` (04-knowledge-platform.md
    §3.8 step 1). Omitted/missing `clearance` falls back to
    `settings.default_search_clearance` — see that setting's docstring for
    why INTERNAL and its explicit no-real-identity caveat.

    `history` (Desktop 대화 고도화, additive/optional) is prior conversation
    turns off `input` — `[{"question": ..., "answer": ...}, ...]`, any order
    — the same trust boundary `question` itself already is (an end user
    fully controls this, so it MUST NEVER be allowed to influence the D-036
    hallucination guard below, only what gets searched for and what the
    prompt shows as labeled context; see `agent_runtime.conversation`'s
    module docstring for the full guarantee). Omitting it (every caller
    today except the new Desktop persistence work) reproduces the exact
    prior behavior: `bound_history(None, ...)` is `[]`,
    `rewrite_query_for_search` no-ops on empty history, and `build_messages`
    renders no history block at all.

    `knowledge_ids` (additive/optional) fans Stage 1 (local) search out
    across every id in the list via `asyncio.gather`, using the same
    (possibly rewritten) local search query for all of them, merging all
    their citations (each additively tagged `"source": "local"`).
    Omitted/empty falls back to the single-`knowledge_id` behavior
    byte-for-byte.

    `knowledge_candidates` (additive/optional — agentic Knowledge selection,
    KNOWLEDGE_ROUTE stage, `agent_runtime.knowledge_router`) is a list of
    `{knowledge_id, name, description?, tags?, classification?}` dicts. When
    non-empty, it takes over Stage 1's search-target selection entirely:
    ONE optional LLM call (`route_knowledge_candidates`) reads only this
    call's `question` and the candidates' metadata — never document text,
    citations, or prior answers — and picks the subset worth searching,
    each with a short Korean reason; `knowledge_ids` is ignored in that
    case (a caller doing agentic selection sends candidates, not a
    pre-decided id list). Below `settings.knowledge_route_skip_threshold`
    candidates the LLM call is skipped entirely (every candidate is
    searched — routing that few is pure latency for no benefit). On any
    routing failure (LLM error/timeout/unparseable output/an id outside the
    candidate list) OR a valid-but-empty selection ("abstained"), this
    fails open: every candidate is searched, never zero, never a
    guessed-at subset — routing is an optimization, and a failed
    optimization must not silently reduce recall. The decision (selected
    ids, excluded ids, each with a reason, and whether routing ran/was
    skipped/fell back) is emitted as a `knowledge.route.selected` event.
    Omitting `knowledge_candidates` (every caller today, including the 4
    published Hosted chatbots) reproduces the exact prior `knowledge_ids`/
    `knowledge_id` behavior byte-for-byte — `route_knowledge_candidates` is
    never even called.

    `allow_hub_lookup`/`hub_search_adapter` (additive/optional, default off)
    gate Stage 2: a hub (central Knowledge registry, portal-api M02) lookup
    that only ever runs when Stage 1 found zero citations AND the caller
    explicitly opted in AND an adapter was supplied — see
    `agent_runtime.hub_query` for why the hub query is built ONLY from
    `question` (this call's own, untouched parameter) and `bounded_history`'s
    `["question"]` fields, NEVER `["answer"]` fields (which can legitimately
    contain local Knowledge document content), retrieved citations, or the
    Stage 1 (possibly rewritten) local search query. A hub lookup failure
    (`HubSearchError`) is logged and swallowed — it must never fail the Run;
    Stage 2 simply contributes nothing, falling through to the same
    INSUFFICIENT_EVIDENCE path as when both stages find nothing."""
    bounded_history = bound_history(
        history, max_turns=settings.max_history_turns, max_chars=settings.max_history_chars
    )
    confirmation_timeout = (
        mcp_confirmation_timeout_seconds
        if mcp_confirmation_timeout_seconds is not None
        else settings.mcp_confirmation_timeout_seconds
    )
    # This coroutine is always run as its own `asyncio.create_task(...)`
    # (routers/runs.py) — a dedicated async task per Run — so binding here
    # without an explicit reset is safe: the bound trace_id/run_id are local
    # to this task's context and die with it, never leaking into another
    # concurrent request/run. Every `logger.info(...)` call below, and every
    # outbound call an adapter makes that reads `get_trace_id()` itself, now
    # carries this Run's id (README §15 step 12 / NFR-04).
    bind_trace_id(trace_id)
    bind_run_id(run_id)
    try:
        capabilities = config.agent_manifest.get("capabilities", {})
        knowledge_required = capabilities.get("knowledge_required", False)
        mcp_allowed = capabilities.get("mcp_allowed", False)

        # --- INPUT_VALIDATE ---
        run_store.append_event(
            run_id,
            "run.started",
            {
                "run_id": run_id,
                "service_id": service_id,
                "trace_id": trace_id,
                "knowledge_id": knowledge_id,
                "question": question,
            },
        )
        logger.info(
            "run.input_validate run_id=%s question_len=%d history_turns=%d",
            run_id,
            len(question or ""),
            len(bounded_history),
        )

        if not question or not question.strip():
            _fail(run_store, run_id, trace_id, "INVALID_INPUT", "question is required")
            return

        # Defensive: a caller may send only the fan-out `knowledge_ids` list
        # (no singular `knowledge_id`) — the Desktop client is expected to
        # always send both for back-compat, but this gate must not falsely
        # reject a valid multi-knowledge request that omits the singular
        # field. `knowledge_ok` below (PREFLIGHT) reads this same variable,
        # so this one change covers both checks.
        has_knowledge_id = bool(knowledge_id) or bool(knowledge_ids) or bool(knowledge_candidates)
        has_mcp_request = mcp_tool_request is not None
        if knowledge_required and not has_knowledge_id:
            _fail(run_store, run_id, trace_id, "INVALID_INPUT", "knowledge_id is required")
            return
        if not knowledge_required and not has_knowledge_id and not has_mcp_request:
            _fail(
                run_store,
                run_id,
                trace_id,
                "INVALID_INPUT",
                "knowledge_id or an MCP tool request is required",
            )
            return

        # --- PREPARE ---
        checks: list[dict[str, Any]] = []
        knowledge_ok = (not knowledge_required) or has_knowledge_id
        checks.append(
            {
                "name": "knowledge_available",
                "passed": knowledge_ok,
                "message": "knowledge_id provided for a knowledge-required agent"
                if knowledge_ok
                else "agent requires knowledge search but no knowledge_id was given",
            }
        )

        has_office_profile = config.office_profile is not None
        checks.append(
            {
                "name": "office_profile_present",
                "passed": has_office_profile,
                "message": "office profile loaded"
                if has_office_profile
                else "office profile missing",
            }
        )

        preflight_passed = all(check["passed"] for check in checks)
        run_store.set_status(run_id, "PREFLIGHT")
        run_store.append_event(
            run_id, "preflight.completed", {"passed": preflight_passed, "checks": checks}
        )

        if not preflight_passed:
            _fail(
                run_store, run_id, trace_id, "PREFLIGHT_FAILED", "preflight checks did not pass"
            )
            return

        # --- ANALYZE (implicit) + KNOWLEDGE_SEARCH (0..n) ---
        run_store.set_status(run_id, "RUNNING")
        citations: list[dict[str, Any]] = []
        if has_knowledge_id:
            # --- KNOWLEDGE_ROUTE (optional, before KNOWLEDGE_SEARCH) ---
            # Agentic Knowledge selection — only runs when the caller
            # supplied `knowledge_candidates` (additive/optional; every
            # existing caller, including the 4 published Hosted chatbots,
            # never does). See `agent_runtime.knowledge_router` for the
            # fail-open contract this relies on: `route_result.selected_ids`
            # is always safe to search directly, in every status.
            route_result: KnowledgeRouteResult | None = None
            if knowledge_candidates:
                route_result = await route_knowledge_candidates(
                    question,
                    knowledge_candidates,
                    llm_adapter,
                    model_alias="default-chat",
                    timeout_seconds=settings.knowledge_route_timeout_seconds,
                    skip_threshold=settings.knowledge_route_skip_threshold,
                )
                run_store.append_event(
                    run_id,
                    "knowledge.route.selected",
                    {
                        "status": route_result.status,
                        "fallback_reason": route_result.fallback_reason,
                        "selected": route_result.selected,
                        "excluded": route_result.excluded,
                    },
                )
                logger.info(
                    "knowledge.route run_id=%s status=%s fallback_reason=%s "
                    "selected_count=%d excluded_count=%d",
                    run_id,
                    route_result.status,
                    route_result.fallback_reason,
                    len(route_result.selected_ids),
                    len(route_result.excluded),
                )

            run_store.append_event(
                run_id, "knowledge.search.started", {"knowledge_id": knowledge_id}
            )

            # §3.4 Query Rewrite — only when there is bounded history to
            # rewrite with (a first turn pays no extra LLM call and searches
            # on `question` unchanged, exactly as before this feature
            # existed). A bare follow-up like "그럼 신청은 어떻게 해?" carries
            # almost no retrievable signal on its own; rewriting it into a
            # standalone query using recent turns is what makes the follow-up
            # actually retrieve anything relevant (see this module's
            # docstring reference to the measurement backing this choice).
            search_query = question
            if bounded_history:
                search_query, rewrite_meta = await rewrite_query_for_search(
                    question,
                    bounded_history,
                    llm_adapter,
                    model_alias="default-chat",
                    timeout_seconds=settings.query_rewrite_timeout_seconds,
                )
                run_store.append_event(run_id, "knowledge.query_rewritten", rewrite_meta)

            # Stage 1 fan-out: searches every id in `ids_to_search` with the
            # same `search_query`, via `asyncio.gather` — unchanged
            # access_context/clearance logic, just repeated per id.
            # `route_result` (KNOWLEDGE_ROUTE, above) takes over id
            # selection entirely when present — its `selected_ids` is
            # always the right thing to search, fallback-inclusive.
            # Otherwise `knowledge_ids` (non-empty) reproduces the plain
            # fan-out; omitting both reproduces the exact prior
            # single-`knowledge_id` request/response handling.
            if route_result is not None:
                ids_to_search = route_result.selected_ids
            else:
                ids_to_search = list(knowledge_ids) if knowledge_ids else [knowledge_id]
            access_context = {
                # §3.8 step 1 — see this function's docstring for why this
                # comes from `user_context`, never from `input`.
                "user_id": (user_context or {}).get("user_id"),
                "organization_id": (user_context or {}).get("organization_id"),
                "permissions": (user_context or {}).get("permissions", []),
                "clearance": (user_context or {}).get("clearance")
                or settings.default_search_clearance,
            }

            async def _search_one(kid: str) -> dict[str, Any]:
                return await knowledge_adapter.search(
                    {
                        "query": search_query,
                        "knowledge_id": kid,
                        "knowledge_version": "latest",
                        "top_k": 5,
                        "alpha": 0.5,
                        "trace_id": trace_id,
                        "run_id": run_id,
                        "access_context": access_context,
                    }
                )

            try:
                search_results = await asyncio.gather(
                    *(_search_one(kid) for kid in ids_to_search)
                )
            except KnowledgeSearchError as exc:
                # Surfaces search-runtime's own code (e.g. KNOWLEDGE_ACCESS_DENIED
                # — §3.8) instead of falling through to the generic
                # INTERNAL_ERROR catch-all at the bottom of this function.
                # Expected to be rare in practice: this Run built its own
                # access_context above rather than trusting `input`, so this
                # path fires on a real integration/config bug, not normal use.
                _fail(run_store, run_id, trace_id, exc.code, exc.message)
                return

            citations = [
                {**citation, "source": "local"}
                for search_result in search_results
                for citation in search_result.get("citations", [])
            ]
            # Single-id fallback keeps the exact prior latency_ms value
            # (including `None` when absent); fan-out sums the per-id
            # latencies as a reasonable merge — this event's payload was
            # never asserted on beyond `citation_count` by any existing test.
            latency_ms = (
                search_results[0].get("latency_ms")
                if len(search_results) == 1
                else sum(r.get("latency_ms") or 0 for r in search_results)
            )

            run_store.append_event(
                run_id,
                "knowledge.search.completed",
                {"citation_count": len(citations), "latency_ms": latency_ms},
            )
            logger.info(
                "run.knowledge_search run_id=%s citation_count=%d", run_id, len(citations)
            )
            for citation in citations:
                run_store.append_event(run_id, "citation.added", citation)

        # --- Stage 2: hub lookup (opt-in, only when Stage 1 found nothing) ---
        # Consent-default-off: `allow_hub_lookup` defaults False, so this
        # block never runs — and `hub_search_adapter.search` is never
        # called — unless a caller explicitly opts in. See hub_query.py's
        # module docstring for why `hub_query` is built ONLY from `question`
        # (this call's own untouched parameter, never the Stage 1 rewritten
        # `search_query`) and `bounded_history`'s `["question"]` fields.
        if len(citations) == 0 and allow_hub_lookup and hub_search_adapter is not None:
            hub_query = build_hub_query(question, bounded_history)
            try:
                hub_result = await hub_search_adapter.search(
                    hub_query, top_k=5, trace_id=trace_id
                )
            except HubSearchError as exc:
                # Hub unreachable/erroring must never fail the Run — Stage 2
                # simply contributes nothing, falling through to the same
                # INSUFFICIENT_EVIDENCE path as if it had never been tried.
                logger.info(
                    "hub.search.failed run_id=%s code=%s message=%s",
                    run_id,
                    exc.code,
                    exc.message,
                )
            else:
                hub_citations = [
                    {**citation, "source": "hub"} for citation in hub_result.get("citations", [])
                ]
                # Safe to include the literal query text in this event:
                # `UserTypedQuery` structurally guarantees it never contains
                # assistant/local content (see hub_query.py).
                run_store.append_event(
                    run_id,
                    "hub.query_sent",
                    {
                        "query": hub_query.text,
                        "knowledge_ids_searched": hub_result.get("knowledge_ids_searched", []),
                    },
                )
                run_store.append_event(
                    run_id, "hub.search.completed", {"citation_count": len(hub_citations)}
                )
                logger.info(
                    "run.hub_search run_id=%s citation_count=%d", run_id, len(hub_citations)
                )
                citations = citations + hub_citations
                for citation in hub_citations:
                    run_store.append_event(run_id, "citation.added", citation)

        # --- TOOL_CONFIRM (optional) / MCP_TOOL_CALL (0..n) ---
        tool_results: list[dict[str, Any]] = []
        if mcp_tool_request is not None:
            if not mcp_allowed:
                _fail(
                    run_store,
                    run_id,
                    trace_id,
                    "MCP_PERMISSION_DENIED",
                    "이 Agent는 MCP Tool을 호출할 수 없습니다.",
                )
                return

            outcome = await _run_mcp_tool_call(
                run_id=run_id,
                service_id=service_id,
                trace_id=trace_id,
                config=config,
                mcp_adapter=mcp_adapter,
                mcp_tool_request=mcp_tool_request,
                run_store=run_store,
                confirmation_timeout_seconds=confirmation_timeout,
            )
            if isinstance(outcome, _Cancelled):
                return  # terminal state already recorded by _run_mcp_tool_call
            if isinstance(outcome, tuple):
                code, message = outcome
                _fail(run_store, run_id, trace_id, code, message)
                return
            if isinstance(outcome, _Denied):
                # "Denial is a first-class outcome (run ends cleanly, not an
                # error)" — proceed exactly as if no mcp_tool_request had
                # been given; the hallucination guard right below decides
                # SUCCEEDED (off Knowledge citations alone) vs
                # INSUFFICIENT_EVIDENCE. Never FAILED.
                tool_results = []
            else:
                tool_results = [outcome]

        # Hallucination guard (D-036), extended to cover tool-only evidence:
        # never answer when there is no Knowledge citation AND no MCP Tool
        # result at all.
        if len(citations) == 0 and len(tool_results) == 0:
            run_store.set_status(run_id, "INSUFFICIENT_EVIDENCE", output={"citations": []})
            run_store.append_event(
                run_id,
                "run.completed",
                {"status": "INSUFFICIENT_EVIDENCE", "output": {"citations": []}},
            )
            return

        # --- ANSWER_GENERATE ---
        run_record = run_store.get(run_id)
        assert run_record is not None

        system_prompt = config.prompt_manifest["template"]["system"]
        messages = build_messages(
            system_prompt,
            config.prompt_template,
            citations,
            question,
            tool_results=tool_results,
            history=bounded_history,
        )

        answer_parts: list[str] = []
        # Cast: the ABC declares AsyncIterator[str], but adapters are implemented
        # as async generator functions, which additionally support aclose() —
        # needed here to cancel a mid-stream generation cleanly.
        agen = cast(
            AsyncGenerator[str, None],
            llm_adapter.generate(messages, model_alias="default-chat", stream=True),
        )
        try:
            async for token in agen:
                if run_record.cancel_event.is_set():
                    await agen.aclose()
                    run_store.set_status(run_id, "CANCELLED")
                    run_store.append_event(run_id, "run.cancelled", {"trace_id": trace_id})
                    return
                answer_parts.append(token)
                run_store.append_event(run_id, "answer.delta", {"delta": token})
        finally:
            await agen.aclose()

        full_answer = "".join(answer_parts)
        logger.info("run.answer_generate run_id=%s answer_len=%d", run_id, len(full_answer))

        # --- OUTPUT_VALIDATE ---
        if not full_answer.strip():
            _fail(run_store, run_id, trace_id, "EMPTY_ANSWER", "model produced an empty answer")
            return

        # --- COMPLETE ---
        output = {"answer": full_answer, "citations": citations}
        run_store.set_status(run_id, "SUCCEEDED", output=output)
        run_store.append_event(
            run_id, "run.completed", {"status": "SUCCEEDED", "output": output}
        )

    except Exception:  # noqa: BLE001 - a bug here must never leave a run RUNNING
        logger.exception("run.internal_error run_id=%s", run_id)
        _fail(
            run_store,
            run_id,
            trace_id,
            "INTERNAL_ERROR",
            "an internal error occurred while processing the run",
        )
