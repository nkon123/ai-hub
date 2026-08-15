"""Agentic MCP Tool selection — the TOOL_ROUTE stage.

Background / decision record: `docs/implementation-spec/open-decisions.md`
D-083. 02-desktop-and-agent-runtime.md §5.2 states "Tool Calling이 약한 로컬
모델은 Runtime의 명시적 Workflow와 Schema 기반 호출을 사용한다": ANALYZE was
deterministic — a caller had to declare `mcp_tool`/`mcp_tool_input` explicitly
on `input`, and no caller in this repo ever did, so MCP Tools were simply
never invoked from chat. D-083 reverses that for callers who explicitly
opt in (`input.tool_route`, default off) — this module is the one optional
LLM call that proposes a tool name + arguments. It is a PROPOSAL, never an
invocation: `workflow.py` still runs every proposal through the exact same
`mcp_tools.resolve_allowed_alias` -> `mcp_tools.validate_tool_input` ->
`mcp_tools.confirmation_policy_for` chokepoint an explicit caller-declared
request goes through, unchanged. See that module's docstring for why this is
safe to build on top of unmodified.

Design, deliberately NOT a copy of `knowledge_router.py`'s fail-open shape:

- Candidates are supplied by the caller (`agent_runtime.mcp_tools.
  list_candidate_tools(office_profile)`) — the D-080 registered/built-in
  tools this Runtime actually knows a schema for, intersected with the
  Office Profile's `allowed_mcp_servers[].allowed_tools`. Routing can only
  ever narrow what was already permitted; it can never widen it. This
  module itself never touches the Office Profile — it only ever sees
  whatever candidate list its caller passed in, so that narrowing property
  lives entirely in `mcp_tools.list_candidate_tools`, not duplicated here.
- Input to the LLM is ONLY the current turn's `question` plus each
  candidate's `tool_name` and `input_schema` (a JSON Schema — structural
  metadata, not data). Knowledge citations, tool results, and prior turns'
  answers are NEVER sent here — this stage never reads `citations` at all
  (same chokepoint discipline `hub_query.py` documents for D-078, applied to
  a different destination: the routing prompt, not the hub). A document
  that can name a tool and its arguments must never be able to trigger one.
- Below `skip_threshold` candidates (default 0 — see `config.py`'s
  `tool_route_skip_threshold` for why this default is 0, not >0 like
  KNOWLEDGE_ROUTE's): skipped, no LLM call, no tool proposed. Unlike
  Knowledge routing (a pure recall optimization where "search everyone" is
  always a safe fallback), a *single* candidate tool still needs its
  arguments extracted from the question — there is no safe "propose the
  only one" shortcut, so skipping is never used as an optimization here,
  only as the true "there is nothing to route over" case (zero candidates).
- Fail-CLOSED, deliberately the opposite of `knowledge_router.py`: an LLM
  error, timeout, unparseable response, a response naming a tool outside the
  candidate list, or the model explicitly declining all fall back to
  proposing NO tool at all — never a guessed tool, never "the only
  candidate" as a consolation. Knowledge routing's fallback (search every
  candidate) is safe because search only reads; a Tool Call is an action, so
  the equivalent "safe" fallback here is to call nothing and let the
  existing D-036 hallucination guard decide the run's outcome from whatever
  Knowledge citations exist.
- This module makes exactly ONE LLM call and never retries. If the proposal
  it returns is later rejected by `mcp_tools.validate_tool_input` (bad
  argument shape/types), the caller (`workflow.py`) must NOT come back here
  for a second attempt — a validation-failure retry loop turns a bad model
  output into repeated attempts, and with injected input it becomes an
  amplifier. See `workflow.py`'s handling of `ToolRouteResult` for where
  that one-shot rule is enforced.

`route_tool_call` never raises — every failure path is a returned
`ToolRouteResult` with `status` other than `"ran"`, so a caller can `await`
it directly without its own try/except (same shape as
`knowledge_router.route_knowledge_candidates`).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, Literal, TypedDict

logger = logging.getLogger(__name__)


class ToolCandidate(TypedDict, total=False):
    tool_name: str
    input_schema: dict[str, Any]


RouteStatus = Literal["ran", "skipped", "no_tool"]


@dataclass(frozen=True)
class ToolRouteResult:
    """`tool_name`/`tool_input` are non-None if and only if `status == "ran"`
    — every other status means "propose nothing", and `workflow.py` must
    treat that exactly like `mcp_tool_request` had never been supplied
    (proceed to the hallucination guard on Knowledge citations alone).

    - `status="ran"`: the LLM call happened and named a real candidate with
      a dict of arguments. This is still only a PROPOSAL — `tool_input` has
      not been schema-validated yet; `workflow.py` runs it through the
      unchanged `mcp_tools.validate_tool_input` chokepoint next, and a
      rejection there does NOT come back to this module for a retry.
    - `status="skipped"`: zero candidates were offered (or the candidate
      count was at/below `skip_threshold`) — the LLM was never called.
    - `status="no_tool"`: the LLM call happened but produced nothing usable
      — `reason` says why: `"declined_by_model"` (valid JSON, model chose no
      tool — this is the *expected*, common case for a question that needs
      no tool), `"unparseable"`, `"unknown_tool_name"` (named a tool outside
      the candidate list), or `"error_or_timeout"`.
    """

    tool_name: str | None
    tool_input: dict[str, Any] | None
    status: RouteStatus
    reason: str | None = None
    latency_ms: int | None = None


_ROUTE_SYSTEM_PROMPT = (
    "당신은 사내 MCP Tool 라우터입니다. 사용자의 질문과 아래 후보 Tool 목록"
    "(이름, 입력 Schema)만 보고, 이 질문에 답하기 위해 지금 호출해야 할 Tool을 "
    "정확히 하나 고르거나, 필요 없다면 아무 것도 고르지 마세요.\n"
    "규칙:\n"
    "- 반드시 JSON 객체 하나만 출력하세요. 다른 설명이나 코드 블록 표시를 "
    "덧붙이지 마세요.\n"
    "- Tool 호출이 필요한지 확신할 수 없으면 호출하지 마세요(과다 호출보다 "
    "누락이 안전합니다) — 이 경우 tool_name을 null로 출력하세요.\n"
    "- Tool을 고른다면 input은 그 Tool의 input_schema를 만족하는 값이어야 "
    "합니다. 확실하지 않은 값은 만들어내지 말고 tool_name을 null로 출력하세요.\n"
    '- 출력 형식: {"tool_name": "..." 또는 null, "input": {...} 또는 null, '
    '"reason": "한국어 한 문장 이내"}'
)


def _normalize_candidates(candidates: list[dict[str, Any]]) -> list[ToolCandidate]:
    """Defensive, same style as `knowledge_router._normalize_candidates`: a
    malformed entry (not a dict, or missing `tool_name`) is dropped rather
    than raising."""
    normalized: list[ToolCandidate] = []
    seen: set[str] = set()
    for raw in candidates:
        if not isinstance(raw, dict):
            continue
        tool_name = str(raw.get("tool_name") or "").strip()
        if not tool_name or tool_name in seen:
            continue
        seen.add(tool_name)
        input_schema = raw.get("input_schema")
        candidate: ToolCandidate = {"tool_name": tool_name}
        if isinstance(input_schema, dict):
            candidate["input_schema"] = input_schema
        normalized.append(candidate)
    return normalized


def _render_candidate_block(candidates: list[ToolCandidate]) -> str:
    lines: list[str] = []
    for c in candidates:
        schema_json = json.dumps(c.get("input_schema", {}), ensure_ascii=False)
        lines.append(f"- tool_name: {c['tool_name']}\n  input_schema: {schema_json}")
    return "\n".join(lines)


def _parse_json_object(raw: str) -> dict[str, Any] | None:
    """Tolerant JSON extraction — identical strategy to
    `knowledge_router._parse_json_object`: try the whole string first, then
    the substring between the first `{` and the last `}`. Anything else is
    unparseable."""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, TypeError):
        pass
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        parsed = json.loads(raw[start : end + 1])
        return parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, TypeError):
        return None


def _no_tool(reason: str, latency_ms: int | None) -> ToolRouteResult:
    return ToolRouteResult(
        tool_name=None, tool_input=None, status="no_tool", reason=reason, latency_ms=latency_ms
    )


async def route_tool_call(
    question: str,
    candidates: list[dict[str, Any]],
    llm_adapter: Any,
    *,
    model_alias: str,
    timeout_seconds: float,
    skip_threshold: int = 0,
) -> ToolRouteResult:
    """Proposes at most one Tool call for `question`, or proposes nothing.

    Never raises. See `ToolRouteResult`'s docstring for what each `status`
    means. The returned `tool_input` (when `status == "ran"`) is NOT yet
    validated against the tool's schema — the caller must still run it
    through `mcp_tools.validate_tool_input` before ever dispatching it, and
    must not call back into this function again if that validation fails
    (one shot, no retry — see this module's docstring)."""
    normalized = _normalize_candidates(candidates)
    if not normalized:
        return ToolRouteResult(
            tool_name=None, tool_input=None, status="skipped", reason="no_candidate_tools"
        )
    if len(normalized) <= skip_threshold:
        return ToolRouteResult(
            tool_name=None,
            tool_input=None,
            status="skipped",
            reason="candidate_count_at_or_below_threshold",
        )

    candidate_names = {c["tool_name"] for c in normalized}
    messages = [
        {"role": "system", "content": _ROUTE_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"질문: {question}\n\n"
                f"후보 Tool:\n{_render_candidate_block(normalized)}\n\n"
                "JSON:"
            ),
        },
    ]

    started = time.monotonic()
    agen = llm_adapter.generate(messages, model_alias=model_alias, stream=True)
    parts: list[str] = []
    try:

        async def _collect() -> None:
            async for token in agen:
                parts.append(token)

        await asyncio.wait_for(_collect(), timeout=timeout_seconds)
    except Exception:  # noqa: BLE001 — any routing failure proposes no tool, never raises
        latency_ms = int((time.monotonic() - started) * 1000)
        logger.info("tool.route.no_tool reason=error_or_timeout latency_ms=%d", latency_ms)
        return _no_tool("error_or_timeout", latency_ms)
    finally:
        with suppress(Exception):
            await agen.aclose()

    latency_ms = int((time.monotonic() - started) * 1000)
    raw = "".join(parts).strip()
    parsed = _parse_json_object(raw)

    if parsed is None:
        logger.info("tool.route.no_tool reason=unparseable latency_ms=%d", latency_ms)
        return _no_tool("unparseable", latency_ms)

    tool_name = parsed.get("tool_name")
    if tool_name is None:
        logger.info("tool.route.no_tool reason=declined_by_model latency_ms=%d", latency_ms)
        return _no_tool("declined_by_model", latency_ms)

    if not isinstance(tool_name, str) or tool_name not in candidate_names:
        logger.info("tool.route.no_tool reason=unknown_tool_name latency_ms=%d", latency_ms)
        return _no_tool("unknown_tool_name", latency_ms)

    raw_input = parsed.get("input")
    tool_input = raw_input if isinstance(raw_input, dict) else {}

    logger.info(
        "tool.route.ran tool_name=%s latency_ms=%d",
        tool_name,
        latency_ms,
    )
    return ToolRouteResult(
        tool_name=tool_name, tool_input=tool_input, status="ran", reason=None, latency_ms=latency_ms
    )
