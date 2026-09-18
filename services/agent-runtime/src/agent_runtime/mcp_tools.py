"""Local static copy of the Office MCP Server's PoC tool contracts.

Why a static copy and not live Tool Discovery: agent-runtime must not import
`services/office-mcp-server` internals (CLAUDE.md 구현 원칙 2, "모듈 간 내부
폴더 직접 Import를 금지한다") and this PoC has no separate Registry to fetch
tool contracts from at run time (D-034 — the same reason Agent/Prompt/Office
Profile are loaded from a local static config copy here rather than a live
lookup). So this module mirrors, by hand,
`services/office-mcp-server/src/office_mcp_server/tools_setup.py`'s
`input_schema` and `05-mcp-security-governance.md` §8.4 confirmation policy
for the 3 registered PoC tools. This is a known drift risk (documented as an
open decision, see `docs/implementation-spec/open-decisions.md`) — if M10
adds/changes a tool, this copy must be updated by hand. Defense in depth:
the live office-mcp-server independently re-validates every input against
its own (authoritative) schema, so a stale/loose copy here can reject too
much but can never let an actually-invalid call reach the Connector.

D-083 follow-up (agentic TOOL_ROUTE candidate descriptions): each entry
below also carries a `description` string, hand-copied verbatim from that
same `tools_setup.py`'s `RegisteredTool.description` for the matching
`name` — same drift-risk convention as `input_schema`/confirmation policy
above, now widened to cover this one extra field. **When updating
`input_schema` for a tool here, also re-copy its `description` from
`tools_setup.py` in the same edit** — do not compose new prose, copy what
is actually there. `list_candidate_tools` below surfaces this text (bounded
and sanitized by `tool_router.py` before it ever reaches a prompt) so the
TOOL_ROUTE model sees more than a bare `tool_name`.

The ANALYZE stage in `workflow.py` uses `MCP_TOOL_SPECS` to validate a
caller-declared `mcp_tool`/`mcp_tool_input` *before* any network call — this
is the "명시적 Workflow와 Schema 기반 호출" the LLM Adapter section of
02-desktop-and-agent-runtime.md §5.2 calls for instead of model-driven tool
calling: the Runtime decides deterministically from an explicit field on
the run's `input`, not from parsing free-form model output.

D-080: `validate_tool_input`/`confirmation_policy_for` are the single
chokepoint ANALYZE calls, so they are also the single place a *registered*
tool (`mcp_tool_registry.py`) can supply the input_schema/confirmation_policy
this static table does not have for it. `_spec_for` below is the resolution
order: `MCP_TOOL_SPECS` (this file) always wins first and is never
shadowed — only a `tool_name` that is NOT a built-in ever falls through to
the registry. Registering a tool_name that happens to collide with a
built-in therefore has no effect on what gets validated against; see
`mcp_tool_registry.py`'s module docstring for why that module still
constrains such a registration's `confirmation_policy` anyway (defense in
depth in case this ordering ever changes). `resolve_allowed_alias` below is
untouched by any of this — the Office Profile allowlist it checks is the
actual permission gate, and registration can only ever describe a tool the
Office Profile already permits (see `mcp_tool_registry.py`), never widen it.
"""

from __future__ import annotations

from typing import Any

from jsonschema import Draft202012Validator

# §8.4 사용자 확인 정책. "NEVER" tools are auto-approved by this PoC's
# workflow; ALWAYS/ON_PARAMETER tools instead park the Run in
# WAITING_FOR_USER and wait for an explicit `POST /runs/{id}/confirm`
# decision (02-...md §5.3, D-052 후속) — see workflow.py's
# `_await_confirmation`/`_run_mcp_tool_call`.
NEVER = "NEVER"
ALWAYS = "ALWAYS"
ON_PARAMETER = "ON_PARAMETER"

MCP_TOOL_SPECS: dict[str, dict[str, Any]] = {
    "db_metadata.get_tables": {
        "description": "허용된 Schema의 Table 목록을 조회합니다 (읽기 전용).",
        "input_schema": {
            "type": "object",
            "required": ["schema"],
            "additionalProperties": False,
            "properties": {
                "schema": {"type": "string", "minLength": 1, "maxLength": 64},
                "name_contains": {"type": "string", "maxLength": 64},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
            },
        },
        "confirmation_policy": NEVER,
    },
    "db_metadata.get_columns": {
        "description": "허용된 Table의 Column 메타데이터 조회 (읽기 전용, Default Value 미반환).",
        "input_schema": {
            "type": "object",
            "required": ["schema", "table"],
            "additionalProperties": False,
            "properties": {
                "schema": {"type": "string", "minLength": 1, "maxLength": 64},
                "table": {"type": "string", "minLength": 1, "maxLength": 128},
            },
        },
        "confirmation_policy": NEVER,
    },
    "table_count.query": {
        "description": "허용된 Table/Field/Operator로 건수만 조회 (읽기 전용, 임의 SQL 미입력).",
        "input_schema": {
            "type": "object",
            "required": ["schema", "table"],
            "additionalProperties": False,
            "properties": {
                "schema": {"type": "string", "minLength": 1, "maxLength": 64},
                "table": {"type": "string", "minLength": 1, "maxLength": 128},
                "filters": {
                    "type": "array",
                    "maxItems": 5,
                    "items": {
                        "type": "object",
                        "required": ["field", "operator", "value"],
                        "additionalProperties": False,
                        "properties": {
                            "field": {"type": "string", "maxLength": 64},
                            "operator": {"type": "string", "enum": ["eq", "neq"]},
                            "value": {"type": ["string", "number", "boolean"]},
                        },
                    },
                },
            },
        },
        # §5.3's tool is the security-critical one — PoC keeps its
        # server-side ON_PARAMETER policy (unfiltered/whole-table counts
        # need confirmation): a call without `confirmed=true` parks the Run
        # in WAITING_FOR_USER instead of dispatching (see workflow.py).
        "confirmation_policy": ON_PARAMETER,
    },
}


def resolve_allowed_alias(office_profile: dict[str, Any], tool_name: str) -> str | None:
    """Office Profile MCP Client rule: "Office Profile에 등록된 Server Alias만
    사용" — returns the `alias` of the first `allowed_mcp_servers` entry
    whose `allowed_tools` contains `tool_name`, or None if no entry allows
    it. Callers must refuse the call *before any network request* when this
    returns None."""
    for server in office_profile.get("allowed_mcp_servers", []):
        if tool_name in server.get("allowed_tools", []):
            return str(server["alias"])

    # D-094: Office Profile 이 모르는 Tool 이라도 **등록된 MCP 서버**가 제공하면
    # 허용한다. Office Profile 목록은 D-080 시절의 안전 경계였는데, 서드파티
    # 서버를 설치해 쓰는 순간 그 목록은 더 이상 전체를 담을 수 없다.
    #
    # 경계가 느슨해지는 것이 아니다 — 등록 자체가 네 겹의 검사를 통과해야 하고
    # (매니페스트 승인, 연결 경계, 핸드셰이크 대조, 검토자가 부여한 거버넌스
    # 메타데이터), 실제 호출은 `mcp_client.dispatch_tool_call` 의 PEP 를 그대로
    # 지난다. 여기서 alias 를 돌려주는 것은 "그 PEP 까지 갈 수 있다"는 뜻이지
    # "호출해도 된다"는 뜻이 아니다.
    from agent_runtime.mcp_server_registry import get_registry as _get_server_registry

    for server in _get_server_registry().list_servers():
        if server.state == "ACTIVE" and tool_name in server.tool_names:
            return server.server_alias
    return None


def _spec_for(tool_name: str) -> dict[str, Any] | None:
    """D-080 resolution order: `MCP_TOOL_SPECS` first and always — a
    registered entry for a built-in `tool_name` is never consulted here.
    Only a `tool_name` absent from the static table falls through to the
    registry. Local import: `mcp_tool_registry` imports this module at its
    own top level (for `MCP_TOOL_SPECS`/`NEVER`/`ON_PARAMETER`/`ALWAYS`), so
    importing it back at this module's top level would be a cycle."""
    spec = MCP_TOOL_SPECS.get(tool_name)
    if spec is not None:
        return spec
    from agent_runtime.mcp_tool_registry import get_registry

    entry = get_registry().resolve(tool_name)
    if entry is not None:
        return {
            "input_schema": entry.input_schema,
            "confirmation_policy": entry.confirmation_policy,
            # D-080's `label` is the description-shaped field a registered
            # (non-built-in) tool actually carries — see `list_candidate_tools`.
            "label": entry.label,
        }

    # D-094: 마지막으로 등록된 MCP 서버의 매니페스트를 본다. 스키마와 확인
    # 정책은 **검토자가 승인한 매니페스트**에서 오지 서버가 말하는 것에서
    # 오지 않는다 — 서버가 자기 확인 정책을 NEVER 라고 주장할 수 있으면
    # 확인 정책은 의미가 없다.
    return _spec_from_mcp_server_registry(tool_name)


def _spec_from_mcp_server_registry(tool_name: str) -> dict[str, Any] | None:
    """D-094 로 등록된 서버의 매니페스트에서 이 Tool 의 선언을 찾는다."""
    from agent_runtime.mcp_server_registry import get_registry as _get_server_registry

    for server in _get_server_registry().list_servers():
        if server.state != "ACTIVE" or tool_name not in server.tool_names:
            continue
        for declared in (server.manifest or {}).get("declared_tools") or []:
            if isinstance(declared, dict) and declared.get("tool_name") == tool_name:
                return {
                    # 스키마를 선언하지 않은 Tool 은 "아무 입력이나 허용"이 아니라
                    # 빈 객체만 허용한다 — 검증할 수 없는 입력을 통과시키면
                    # 입력 검사가 있다는 사실 자체가 거짓이 된다.
                    "input_schema": declared.get("input_schema")
                    or {"type": "object", "additionalProperties": False},
                    "confirmation_policy": declared.get("confirmation_policy") or ALWAYS,
                    "label": declared.get("label") or tool_name,
                }
    return None


def validate_tool_input(tool_name: str, raw_input: dict[str, Any]) -> list[str]:
    """Structural Input Schema validation (02-...md §5.2 MCP Client rule
    "Input Schema 검사"), run against the local static copy above, falling
    back to a D-080 registered tool's schema when `tool_name` is not a
    built-in (`_spec_for`) — returns a sorted list of human-readable error
    messages (empty means valid). Unknown tool names (neither built-in nor
    registered) return a single generic error rather than raising, so
    callers have one uniform "not valid" signal regardless of cause."""
    spec = _spec_for(tool_name)
    if spec is None:
        return [f"알 수 없는 Tool입니다: {tool_name}"]
    if not isinstance(raw_input, dict):
        return ["Tool 입력 값이 없거나 형식이 올바르지 않습니다."]
    validator = Draft202012Validator(spec["input_schema"])
    return sorted({e.message for e in validator.iter_errors(raw_input)})


def confirmation_policy_for(tool_name: str) -> str | None:
    spec = _spec_for(tool_name)
    return spec["confirmation_policy"] if spec else None


def list_candidate_tools(office_profile: dict[str, Any]) -> list[dict[str, Any]]:
    """D-083 TOOL_ROUTE candidate set: the Office Profile's
    `allowed_mcp_servers[].allowed_tools` **plus the tools of every ACTIVE
    registered MCP server** (D-094 이어 붙이기 — 함수 끝의 주석 참고),
    intersected with every
    `tool_name` this Runtime actually has a schema for (`_spec_for` — the
    same built-in-first-then-registry resolution `validate_tool_input`/
    `confirmation_policy_for` use). Routing can only ever narrow what the
    deployment already permits, never widen it: a `tool_name` present in
    `allowed_tools` but absent from both `MCP_TOOL_SPECS` and the D-080
    registry (e.g. `office-profile.json`'s `calculator.add`, which has no
    registered schema in this PoC) is silently excluded here rather than
    offered to the router with a guessed-at schema — the router must never
    see a tool it could not actually validate/dispatch through the unchanged
    `resolve_allowed_alias` -> `validate_tool_input` chokepoint.

    Returns `[{"tool_name": ..., "input_schema": ..., "description": ...}, ...]`
    — metadata only (structural JSON Schema, not data; `description` is
    human-readable prose, present only when the tool has one). For a
    built-in this is the hand-copied `description` in `MCP_TOOL_SPECS`
    above; for a D-080 registered tool it is that registration's `label`. A
    tool with neither omits the `description` key entirely rather than
    being dropped as a candidate — losing a callable tool for lacking prose
    would be worse than offering it bare. This raw text is NOT length-bounded
    or line-sanitized here — `tool_router._normalize_candidates` is the
    chokepoint that does that immediately before this text ever reaches a
    routing prompt, the same "sanitize at the boundary that touches the
    prompt" discipline this module's docstring describes for `input_schema`.
    This is the exact shape `tool_router.route_tool_call` expects as
    `candidates`."""
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for server in office_profile.get("allowed_mcp_servers", []):
        for tool_name in server.get("allowed_tools", []):
            if not isinstance(tool_name, str) or tool_name in seen:
                continue
            spec = _spec_for(tool_name)
            if spec is None:
                continue
            seen.add(tool_name)
            candidate: dict[str, Any] = {
                "tool_name": tool_name,
                "input_schema": spec["input_schema"],
            }
            description = spec.get("description")
            if not isinstance(description, str) or not description.strip():
                description = spec.get("label")
            if isinstance(description, str) and description.strip():
                candidate["description"] = description
            candidates.append(candidate)

    # D-094 이어 붙이기 — **등록된 MCP 서버**가 제공하는 Tool 도 후보에 넣는다.
    #
    # 이 함수가 Office Profile 만 보던 동안, 서버를 설치하고 등록까지 마쳐도
    # 대화에서는 그 Tool 이 존재하지 않는 것과 같았다(실사용 2026-09-18:
    # hello-mcp 를 등록했는데 채팅에서 쓸 방법이 없었다). `resolve_allowed_alias`
    # 는 이미 등록된 서버의 Tool 을 허용하고 있었으므로, 여기만 Office Profile
    # 에 묶여 있어 "부를 수는 있는데 고를 수는 없는" 상태였다.
    #
    # 경계가 넓어지는 것이 아니다: 후보가 되는 것은 **ACTIVE 로 등록된** 서버가
    # 매니페스트에 선언한 Tool 뿐이고(등록 자체가 매니페스트 승인·연결 경계·
    # 핸드셰이크 대조·거버넌스 메타데이터 네 겹을 지난다), 실제 호출은 여전히
    # `resolve_allowed_alias` -> `validate_tool_input` -> `confirmation_policy_for`
    # 를 그대로 지난다. 후보에 오른다는 것은 "라우터가 이름을 볼 수 있다"는
    # 뜻이지 "호출해도 된다"는 뜻이 아니다.
    from agent_runtime.mcp_server_registry import get_registry as _get_server_registry

    for server in _get_server_registry().list_servers():
        if server.state != "ACTIVE":
            continue
        for tool_name in server.tool_names:
            if not isinstance(tool_name, str) or tool_name in seen:
                continue
            spec = _spec_for(tool_name)
            if spec is None:
                continue
            seen.add(tool_name)
            candidate = {"tool_name": tool_name, "input_schema": spec["input_schema"]}
            description = spec.get("description") or spec.get("label")
            if isinstance(description, str) and description.strip():
                candidate["description"] = description
            candidates.append(candidate)

    return candidates


def filter_candidates_to_scope(
    candidates: list[dict[str, Any]], scope: tuple[str, ...] | None
) -> list[dict[str, Any]]:
    """사용자가 대화에서 고른 Tool 범위로 후보를 **좁힌다**.

    `scope` 가 `None` 이면(고르지 않음) 후보를 그대로 둔다. 비어 있는 튜플은
    "고를 수 있는 것이 없다"이므로 빈 후보를 돌려준다 — 라우터는 후보가 없으면
    아무것도 제안하지 않는다(fail-closed).

    **교집합만 한다.** 호출자가 보낸 이름이 후보에 없으면 그냥 버린다 — 후보
    목록은 이 배포가 허용한 것에서만 나오고, 사용자의 선택은 그것을 넓히는
    수단이 될 수 없다. 넓힐 수 있게 하면 "화면에서 고른 이름"이 곧 권한이
    된다.
    """
    if scope is None:
        return candidates
    wanted = {name for name in scope if isinstance(name, str) and name.strip()}
    return [candidate for candidate in candidates if candidate["tool_name"] in wanted]
