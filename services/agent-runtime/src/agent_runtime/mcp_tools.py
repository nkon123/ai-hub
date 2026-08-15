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
        "input_schema": {
            "type": "object",
            "required": ["schema"],
            "additionalProperties": False,
            "properties": {
                "schema": {"type": "string", "minLength": 1, "maxLength": 64},
                "name_contains": {"type": "string", "maxLength": 64},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            },
        },
        "confirmation_policy": NEVER,
    },
    "db_metadata.get_columns": {
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
    if entry is None:
        return None
    return {"input_schema": entry.input_schema, "confirmation_policy": entry.confirmation_policy}


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
    """D-083 TOOL_ROUTE candidate set: exactly the Office Profile's
    `allowed_mcp_servers[].allowed_tools`, intersected with every
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

    Returns `[{"tool_name": ..., "input_schema": ...}, ...]` — metadata only
    (structural JSON Schema, not data), the exact shape
    `tool_router.route_tool_call` expects as `candidates`."""
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
            candidates.append({"tool_name": tool_name, "input_schema": spec["input_schema"]})
    return candidates
