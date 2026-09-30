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
  candidate's `tool_name`, `input_schema` (a JSON Schema — structural
  metadata, not data), and an optional `description` (D-083 follow-up: a
  short human-readable line — `mcp_tools.MCP_TOOL_SPECS`' hand-copied text
  for a built-in, or a D-080 registration's `label`). Knowledge citations,
  tool results, and prior turns' answers are NEVER sent here — this stage
  never reads `citations` at all (same chokepoint discipline `hub_query.py`
  documents for D-078, applied to a different destination: the routing
  prompt, not the hub). A document that can name a tool and its arguments
  must never be able to trigger one. `description` is metadata about a
  candidate, never a channel for retrieved/document content, but it can
  still originate from a `label` an operator or Bundle supplied, so
  `_normalize_candidates` bounds its length and collapses it to a single
  line before it ever reaches the prompt — a hostile `description` cannot
  inject a newline that fakes a new candidate entry or an instruction
  block. This never changes which tools are candidates
  (`mcp_tools.list_candidate_tools`'s narrowing is untouched by any of
  this) — only what is said about each one.
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
import re
import time
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, Literal, TypedDict
from agent_runtime.config import settings

logger = logging.getLogger(__name__)

_LINE_COMMENT = re.compile(r'("(?:[^"\\]|\\.)*")|//[^\n]*')


class ToolCandidate(TypedDict, total=False):
    tool_name: str
    input_schema: dict[str, Any]
    description: str


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
    # 한 질문에 Tool 이 여럿 필요할 수 있다("오늘 메일 요약하고 현재 시간도"). 전에는
    # 정확히 하나만 제안해서 두 번째 요청은 조용히 사라졌다. `tool_name`/`tool_input`
    # 은 첫 호출의 별칭으로 남긴다 — 기존 호출자와 이벤트 페이로드가 그대로다.
    # `status == "ran"` 일 때만 비어 있지 않으며, 순서는 모델이 낸 순서다.
    calls: tuple[tuple[str, dict[str, Any]], ...] = ()


_ROUTE_SYSTEM_PROMPT = (
    "당신은 사내 MCP Tool 라우터입니다. 사용자의 질문과 아래 후보 Tool 목록"
    "(이름, 설명, 입력 Schema)만 보고, 질문에 답하려면 지금 호출해야 하는 "
    "Tool을 모두 고르세요. 질문이 서로 다른 조회를 함께 요구하면 조회마다 "
    "Tool을 하나씩 고릅니다.\n"
    "규칙:\n"
    "- 반드시 JSON 객체 하나만 출력하세요. 코드 블록 표시, 주석(//), 설명을 "
    "붙이지 마세요.\n"
    "- 요약·정리·번역·설명·비교는 Tool이 아니라 답변 단계에서 합니다. 그런 "
    "말 때문에 Tool을 고르지 마세요.\n"
    "- 질문이 요구하지 않은 Tool, 다른 Tool의 결과(id 등)가 있어야 인자를 "
    "채울 수 있는 Tool은 고르지 마세요.\n"
    "- input은 input_schema를 만족해야 합니다. 질문에서 알 수 없는 인자는 "
    "생략하세요(날짜 자리에 '오늘' 같은 말을 쓰지 마세요).\n"
    "- Tool이 필요 없으면 calls를 빈 배열로 출력하세요.\n"
    "- tool_name은 아래 후보 목록에 있는 이름만 그대로 쓰세요. input에는 그 Tool의 "
    "input_schema에 있는 속성만 쓰세요.\n"
    '- 출력 형식: {"calls": [{"tool_name": "...", "input": {...}}, ...]}'
)


def _sanitize_description(raw: Any, max_chars: int) -> str | None:
    """Bounds and single-lines a candidate's `description` before it can
    ever reach the routing prompt (D-083 follow-up). `raw.split()` splits on
    *any* run of whitespace — spaces, tabs, `\\n`, `\\r` — so joining with a
    single space collapses every literal newline out of the text. That is
    the whole defense: a hostile multi-line `description` (e.g. one crafted
    to look like `"...\\n- tool_name: evil\\n  input_schema: {}"`) can never
    produce a second `\\n`-prefixed line in `_render_candidate_block`'s
    output, so it can never forge a new candidate entry or an instruction
    block — it only ever renders as harmless inline text after
    `description: ` on the one line it was given. `max_chars` is a second,
    independent bound (`config.py`'s `tool_route_description_max_chars`) so
    an operator/Bundle-supplied `label` cannot blow up the prompt size
    either. Returns None for anything that is not a non-empty string after
    sanitizing, so a caller can treat "no description" and "sanitizes to
    nothing" identically."""
    if not isinstance(raw, str):
        return None
    collapsed = " ".join(raw.split())
    if not collapsed:
        return None
    return collapsed[:max_chars]


def _normalize_candidates(
    candidates: list[dict[str, Any]], description_max_chars: int = 160
) -> list[ToolCandidate]:
    """Defensive, same style as `knowledge_router._normalize_candidates`: a
    malformed entry (not a dict, or missing `tool_name`) is dropped rather
    than raising. `description_max_chars` bounds/single-lines an optional
    `description` via `_sanitize_description` — never a reason to drop an
    otherwise-valid candidate; a description-less (or sanitizes-to-empty)
    tool simply keeps no `description` key and still renders bare."""
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
        description = _sanitize_description(raw.get("description"), description_max_chars)
        if description:
            candidate["description"] = description
        normalized.append(candidate)
    return normalized


def _render_candidate_block(candidates: list[ToolCandidate]) -> str:
    lines: list[str] = []
    for c in candidates:
        schema_json = json.dumps(c.get("input_schema", {}), ensure_ascii=False)
        entry_lines = [f"- tool_name: {c['tool_name']}"]
        description = c.get("description")
        if description:
            entry_lines.append(f"  description: {description}")
        entry_lines.append(f"  input_schema: {schema_json}")
        lines.append("\n".join(entry_lines))
    return "\n".join(lines)


def _parse_json_object(raw: str) -> dict[str, Any] | None:
    """Tolerant JSON extraction — identical strategy to
    `knowledge_router._parse_json_object`: try the whole string first, then
    the substring between the first `{` and the last `}`. Anything else is
    unparseable."""
    if not raw:
        return None
    # 모델이 JSON 안에 `// 설명` 을 다는 일이 실측됐다(exaone3.5). 문자열 안의
    # `//`(URL 등)는 건드리지 않도록 따옴표 밖의 것만 지운다.
    raw = _LINE_COMMENT.sub(lambda m: m.group(1) or "", raw)
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


def _salvage_call_objects(raw: str) -> list[dict[str, Any]]:
    """전체가 JSON 이 아닐 때(실측 qwen3.5:4b: 첫 호출의 `}` 를 빠뜨려 뒤의 호출까지
    통째로 못 읽었다) `{"tool_name": ...}` 모양으로 **온전히 닫힌** 객체만 건진다.
    괄호가 깨진 객체는 건지지 않는다 — 반쯤 읽은 값으로 Tool 을 부르지 않는다.
    건진 것도 이후 후보 이름·스키마 검사를 그대로 지난다."""
    decoder = json.JSONDecoder()
    found: list[dict[str, Any]] = []
    index = 0
    while True:
        start = raw.find("{", index)
        if start == -1:
            return found
        try:
            value, end = decoder.raw_decode(raw, start)
        except json.JSONDecodeError:
            index = start + 1
            continue
        if isinstance(value, dict) and "tool_name" in value:
            found.append(value)
            index = end
        else:
            index = start + 1


def _prune_unknown_properties(tool_input: dict[str, Any], schema: Any) -> dict[str, Any]:
    """스키마가 `additionalProperties: false` 인데 모델이 없는 속성을 덧붙이면(실측
    qwen3.5:4b: `max_results`, 인자 없는 시간 Tool 에 임의 인자) 그 호출 전체가
    `MCP_INPUT_INVALID` 로 버려지고 나머지 요청까지 통째로 사라진다. 없는 속성만
    **지운다** — 값을 만들어 채우거나 고치지는 않는다. 그래도 필수 속성이 없거나
    타입이 틀리면 뒤의 `validate_tool_input` 이 그대로 거부한다(관문은 그대로다)."""
    # `null` 은 "값 없음"이다. 선택 인자에 null 을 넣는 모델이 있다(실측 qwen3.5:4b:
    # `{"repo": null, "ref": null}`) — 그대로 두면 문자열 타입 검사에서 호출 전체가 거부된다.
    tool_input = {k: v for k, v in tool_input.items() if v is not None}
    if not isinstance(schema, dict) or schema.get("additionalProperties") is not False:
        return tool_input
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return tool_input
    return {k: v for k, v in tool_input.items() if k in properties}


def _extract_proposals(parsed: dict[str, Any]) -> list[tuple[Any, Any]]:
    """`{"calls": [{tool_name, input}, ...]}` 를 읽는다. 예전 모양
    `{"tool_name": ..., "input": ...}` 도 받는다 — 모델이 지시를 무시하고 옛 형식으로
    답해도 하나짜리 제안은 그대로 통해야 한다. `tool_name: null` / 빈 `calls` 는
    "고르지 않음"이다."""
    calls = parsed.get("calls")
    if isinstance(calls, list):
        return [
            (item.get("tool_name"), item.get("input"))
            for item in calls
            if isinstance(item, dict) and item.get("tool_name") is not None
        ]
    if parsed.get("tool_name") is not None:
        return [(parsed.get("tool_name"), parsed.get("input"))]
    return []


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
    description_max_chars: int = 160,
    max_calls: int = 1,
) -> ToolRouteResult:
    """Proposes up to `max_calls` Tool calls for `question`, or proposes nothing.

    Never raises. See `ToolRouteResult`'s docstring for what each `status`
    means. The returned `tool_input` (when `status == "ran"`) is NOT yet
    validated against the tool's schema — the caller must still run it
    through `mcp_tools.validate_tool_input` before ever dispatching it, and
    must not call back into this function again if that validation fails
    (one shot, no retry — see this module's docstring).

    `description_max_chars` bounds each candidate's optional human-readable
    `description` (see `_sanitize_description`) — the caller should pass
    `config.settings.tool_route_description_max_chars` (a setting, not a
    literal, per this repo's CORS-hardcoding lesson)."""
    normalized = _normalize_candidates(candidates, description_max_chars)
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

    groups = _group_by_namespace(normalized) if max_calls > 1 else [normalized]
    if len(groups) == 1:
        return await _route_group(
            question, groups[0], llm_adapter, model_alias=model_alias,
            timeout_seconds=timeout_seconds, max_calls=max_calls, scoped=False,
        )

    # 후보가 서로 다른 서버(이름공간)의 Tool 로 나뉘면 서버마다 따로 묻는다. 한 번에
    # 다 주면 소형 모델이 "요약해주고" 같은 말에 흔들려 다른 서버의 Tool 을 덧붙이거나
    # 빠뜨렸다(실측 exaone3.5: 같은 질문에서 hello.now 가 들어갔다 빠졌다). 각 호출은
    # 여전히 fail-closed 이고, 합친 뒤 개수 상한을 다시 적용한다.
    results = [
        await _route_group(
            question, group, llm_adapter, model_alias=model_alias,
            timeout_seconds=timeout_seconds, max_calls=max_calls, scoped=True,
        )
        for group in groups
    ]
    merged: list[tuple[str, dict[str, Any]]] = []
    for r in results:
        merged.extend(r.calls)
    merged = merged[:max_calls]
    latency = sum(r.latency_ms or 0 for r in results)
    if not merged:
        # 이유는 가장 "실패에 가까운" 것을 낸다: 전부 거절이면 거절, 하나라도
        # 오류·파싱 실패·모르는 이름이면 그 이유.
        reasons = [r.reason for r in results if r.reason and r.reason != "declined_by_model"]
        return _no_tool(reasons[0] if reasons else "declined_by_model", latency)
    return ToolRouteResult(
        tool_name=merged[0][0],
        tool_input=merged[0][1],
        status="ran",
        reason=None,
        latency_ms=latency,
        calls=tuple(merged),
    )


_SCOPED_NOTE = (
    "(이 질문은 여러 종류의 Tool이 나눠 처리합니다. 질문에 아래 후보 설명에 나오는 대상"
    "(예: 메일, 시간, 저장소, 파일)이 직접 들어 있을 때만 그 부분에 Tool을 고르고, "
    "나머지는 무시하세요. 그런 대상이 없으면 calls를 빈 배열로 출력하세요.)\n\n"
)


def _group_by_namespace(candidates: list[ToolCandidate]) -> list[list[ToolCandidate]]:
    """`hello.now` -> `hello`. 이름공간이 없는 Tool 은 각자 자기 이름을 이름공간으로
    삼지 않고 한 묶음(`""`)에 모은다. 순서는 처음 나온 순서를 지킨다."""
    groups: dict[str, list[ToolCandidate]] = {}
    for c in candidates:
        namespace = c["tool_name"].split(".", 1)[0] if "." in c["tool_name"] else ""
        groups.setdefault(namespace, []).append(c)
    return list(groups.values())


async def _route_group(
    question: str,
    group: list[ToolCandidate],
    llm_adapter: Any,
    *,
    model_alias: str,
    timeout_seconds: float,
    max_calls: int,
    scoped: bool,
) -> ToolRouteResult:
    """모델 호출 한 번으로 `group` 안에서만 Tool 을 고른다. `scoped=True` 이면
    (후보가 여러 서버로 나뉜 경우) 질문의 나머지 부분은 다른 Tool 이 맡는다고 알려
    준다 — 안 그러면 모델이 자기 후보로 질문 전체를 처리하려 든다."""
    candidate_names = {c["tool_name"] for c in group}
    schemas = {c["tool_name"]: c.get("input_schema") for c in group}
    messages = [
        {"role": "system", "content": _ROUTE_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"질문: {question}\n\n"
                + (_SCOPED_NOTE if scoped else "")
                + f"후보 Tool:\n{_render_candidate_block(group)}\n\n"
                + "JSON:"
            ),
        },
    ]

    started = time.monotonic()
    # 이 호출이 받아야 하는 것은 JSON 한 줄이다. 상한이 없으면 모델이 계속
    # 이어 쓰다 타임아웃까지 가고, 그 시간 전체가 사용자 대기 시간이 된다
    # (`LLMAdapter.generate` 의 `max_output_tokens` docstring).
    agen = llm_adapter.generate(
        messages,
        model_alias=model_alias,
        stream=True,
        max_output_tokens=settings.router_max_output_tokens
        if settings.router_max_output_tokens > 0
        else None,
    )
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
        salvaged = _salvage_call_objects(raw)
        if salvaged:
            parsed = {"calls": salvaged}

    if parsed is None:
        logger.info("tool.route.no_tool reason=unparseable latency_ms=%d", latency_ms)
        return _no_tool("unparseable", latency_ms)

    proposals = _extract_proposals(parsed)
    if not proposals:
        logger.info("tool.route.no_tool reason=declined_by_model latency_ms=%d", latency_ms)
        return _no_tool("declined_by_model", latency_ms)

    calls: list[tuple[str, dict[str, Any]]] = []
    seen_calls: set[str] = set()
    for tool_name, raw_input in proposals:
        # 후보 밖 이름은 그 항목만 버린다. 하나라도 지어낸 이름이 섞였다고 나머지 유효한
        # 제안까지 버리면 "두 개 중 하나"가 아니라 "둘 다 없음"이 된다 — 그래도 호출되는
        # 것은 후보 안의 Tool 뿐이라 권한은 넓어지지 않는다.
        if not isinstance(tool_name, str) or tool_name not in candidate_names:
            continue
        tool_input = _prune_unknown_properties(
            raw_input if isinstance(raw_input, dict) else {}, schemas.get(tool_name)
        )
        fingerprint = f"{tool_name}\0{json.dumps(tool_input, sort_keys=True, default=str)}"
        if fingerprint in seen_calls:
            continue
        seen_calls.add(fingerprint)
        calls.append((tool_name, tool_input))
        if len(calls) >= max_calls:
            break

    if not calls:
        logger.info("tool.route.no_tool reason=unknown_tool_name latency_ms=%d", latency_ms)
        return _no_tool("unknown_tool_name", latency_ms)

    logger.info(
        "tool.route.ran tool_names=%s latency_ms=%d",
        ",".join(name for name, _ in calls),
        latency_ms,
    )
    return ToolRouteResult(
        tool_name=calls[0][0],
        tool_input=calls[0][1],
        status="ran",
        reason=None,
        latency_ms=latency_ms,
        calls=tuple(calls),
    )
