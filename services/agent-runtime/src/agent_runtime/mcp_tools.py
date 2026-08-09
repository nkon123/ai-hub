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


def validate_tool_input(tool_name: str, raw_input: dict[str, Any]) -> list[str]:
    """Structural Input Schema validation (02-...md §5.2 MCP Client rule
    "Input Schema 검사"), run against the local static copy above — returns
    a sorted list of human-readable error messages (empty means valid).
    Unknown tool names return a single generic error rather than raising, so
    callers have one uniform "not valid" signal regardless of cause."""
    spec = MCP_TOOL_SPECS.get(tool_name)
    if spec is None:
        return [f"알 수 없는 Tool입니다: {tool_name}"]
    if not isinstance(raw_input, dict):
        return ["Tool 입력 값이 없거나 형식이 올바르지 않습니다."]
    validator = Draft202012Validator(spec["input_schema"])
    return sorted({e.message for e in validator.iter_errors(raw_input)})


def confirmation_policy_for(tool_name: str) -> str | None:
    spec = MCP_TOOL_SPECS.get(tool_name)
    return spec["confirmation_policy"] if spec else None
