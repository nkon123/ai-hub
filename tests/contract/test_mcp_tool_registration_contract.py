"""D-080: the MCP Tool activation contract, and the guard that
`services/agent-runtime` has not drifted away from it.

Same rationale as `test_knowledge_local_index_contract.py` (D-079): this
contract has two independent implementers in principle (agent-runtime serves
it, Desktop would call it), so nothing in the type system connects a field
rename on one side to the other except this test.
"""

from __future__ import annotations

import json

import pytest
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

from .conftest import API_DIR, SCHEMAS_ROOT

SCHEMA_PATH = API_DIR / "mcp-tool-registration.schema.json"
REPO_ROOT = SCHEMAS_ROOT.parent.parent
REGISTRY_SOURCE = (
    REPO_ROOT
    / "services"
    / "agent-runtime"
    / "src"
    / "agent_runtime"
    / "mcp_tool_registry.py"
)

VALID_SCHEMA = {
    "type": "object",
    "required": ["schema"],
    "additionalProperties": False,
    "properties": {"schema": {"type": "string"}},
}


@pytest.fixture(scope="module")
def schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def test_schema_is_a_valid_json_schema(schema: dict) -> None:
    Draft202012Validator.check_schema(schema)


def test_register_request_accepts_the_shape_desktop_would_send(schema: dict) -> None:
    validator = Draft202012Validator(
        {**schema["definitions"]["RegisterMcpToolRequest"], "definitions": schema["definitions"]}
    )
    validator.validate({
        "tool_name": "custom.new_tool",
        "server_alias": "oracle-connector",
        "input_schema": VALID_SCHEMA,
        "confirmation_policy": "NEVER",
        "risk_level": "READ_ONLY",
        "label": "새 조회 Tool",
    })


def test_register_request_has_no_endpoint_field(schema: dict) -> None:
    """The safety boundary in one assertion: there must be no field on this
    contract that could name a network destination (구현 원칙 7)."""
    properties = set(schema["definitions"]["RegisterMcpToolRequest"]["properties"])
    forbidden = {"endpoint", "url", "server_url", "connector", "base_url", "host"}
    assert not (properties & forbidden), (
        f"RegisterMcpToolRequest must never accept a network destination field: "
        f"{properties & forbidden}"
    )


def test_register_request_rejects_an_unknown_risk_level(schema: dict) -> None:
    validator = Draft202012Validator(
        {**schema["definitions"]["RegisterMcpToolRequest"], "definitions": schema["definitions"]}
    )
    with pytest.raises(ValidationError):
        validator.validate({
            "tool_name": "custom.new_tool",
            "server_alias": "oracle-connector",
            "input_schema": VALID_SCHEMA,
            "confirmation_policy": "NEVER",
            "risk_level": "WRITE",
        })


def test_register_request_rejects_an_unknown_confirmation_policy(schema: dict) -> None:
    validator = Draft202012Validator(
        {**schema["definitions"]["RegisterMcpToolRequest"], "definitions": schema["definitions"]}
    )
    with pytest.raises(ValidationError):
        validator.validate({
            "tool_name": "custom.new_tool",
            "server_alias": "oracle-connector",
            "input_schema": VALID_SCHEMA,
            "confirmation_policy": "SOMETIMES",
            "risk_level": "READ_ONLY",
        })


def test_agent_runtime_request_model_matches_the_contract(schema: dict) -> None:
    """The served model's field names are exactly the contract's properties."""
    from agent_runtime.routers.mcp_tools import RegisterMCPToolRequest

    assert set(RegisterMCPToolRequest.model_fields) == set(
        schema["definitions"]["RegisterMcpToolRequest"]["properties"]
    )


def test_entry_response_fields_match_the_contract(schema: dict) -> None:
    from agent_runtime.mcp_tool_registry import MCPToolRegistrationEntry

    entry = MCPToolRegistrationEntry(
        tool_name="custom.new_tool",
        server_alias="oracle-connector",
        input_schema=VALID_SCHEMA,
        confirmation_policy="NEVER",
        risk_level="READ_ONLY",
        label=None,
        registered_at="2026-08-14T00:00:00+00:00",
    )
    validator = Draft202012Validator(
        {**schema["definitions"]["MCPToolRegistrationEntry"], "definitions": schema["definitions"]}
    )
    validator.validate(entry.to_dict())


def test_every_documented_refusal_reason_is_actually_raised_somewhere() -> None:
    """The contract enumerates the refusal reasons a caller switches on. A
    reason documented but never raised is a UI branch that can never be
    reached; a reason raised but never documented is an error the UI cannot
    explain."""
    source = REGISTRY_SOURCE.read_text(encoding="utf-8")
    documented = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))["definitions"][
        "RegisterMcpToolResponse"
    ]["description"]

    raised = {
        "mcp_tool_registration_disabled",
        "tool_name_invalid",
        "risk_level_not_read_only",
        "confirmation_policy_invalid",
        "label_too_long",
        "server_alias_not_in_profile",
        "server_alias_not_allowed_for_registration",
        "tool_not_in_server_allowlist",
        "input_schema_invalid",
        "input_schema_declares_identity_field",
        "confirmation_policy_weaker_than_builtin",
    }
    for reason in raised:
        assert f'"{reason}"' in source, f"reason not raised by the service: {reason}"
        assert reason in documented, f"reason not documented in the contract: {reason}"


def test_confirmation_policy_enum_matches_mcp_tools_constants(schema: dict) -> None:
    """The three confirmation_policy values in the contract must be exactly
    the ones agent_runtime.mcp_tools uses (NEVER/ON_PARAMETER/ALWAYS)."""
    from agent_runtime import mcp_tools

    assert set(schema["definitions"]["MCPConfirmationPolicy"]["enum"]) == {
        mcp_tools.NEVER,
        mcp_tools.ON_PARAMETER,
        mcp_tools.ALWAYS,
    }
