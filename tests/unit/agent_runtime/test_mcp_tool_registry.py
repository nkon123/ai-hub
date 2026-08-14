"""D-080: MCP Tool activation registry — the safety-boundary tests.

Every refusal here is load-bearing: registration must never describe more
execution permission than the deployment's Office Profile already grants
(see `agent_runtime.mcp_tool_registry` module docstring). The two tests
this feature would be a vulnerability without are
`test_tool_not_in_office_profile_allowlist_is_refused` and
`test_confirmation_policy_weaker_than_builtin_is_refused`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from agent_runtime.mcp_tool_registry import MCPToolRegistrationError, MCPToolRegistry

ALIAS = "oracle-connector"
OTHER_ALIAS = "other-server"

BASE_OFFICE_PROFILE: dict[str, Any] = {
    "allowed_mcp_servers": [
        {
            "alias": ALIAS,
            "endpoint": "http://127.0.0.1:8500",
            "allowed_tools": [
                "db_metadata.get_tables",
                "db_metadata.get_columns",
                "table_count.query",
                "custom.new_tool",
            ],
        },
        {
            "alias": OTHER_ALIAS,
            "endpoint": "http://127.0.0.1:8501",
            "allowed_tools": ["other.tool"],
        },
    ]
}

VALID_SCHEMA = {
    "type": "object",
    "required": ["schema"],
    "additionalProperties": False,
    "properties": {"schema": {"type": "string"}},
}


def make_registry(
    tmp_path: Path,
    allowed_aliases: tuple[str, ...] = (ALIAS,),
    office_profile: dict[str, Any] | None = None,
) -> MCPToolRegistry:
    profile = office_profile if office_profile is not None else BASE_OFFICE_PROFILE
    return MCPToolRegistry(
        registry_path=tmp_path / "state" / "mcp-tool-registry.json",
        allowed_aliases=allowed_aliases,
        office_profile_provider=lambda: profile,
    )


def expect_refusal(fn, reason: str, code: str = "VALIDATION_ERROR") -> None:
    with pytest.raises(MCPToolRegistrationError) as exc:
        fn()
    assert exc.value.reason == reason
    assert exc.value.code == code


# --- happy path --------------------------------------------------------


def test_register_then_resolve_and_list(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    entry = registry.register(
        tool_name="custom.new_tool",
        server_alias=ALIAS,
        input_schema=VALID_SCHEMA,
        confirmation_policy="NEVER",
        risk_level="READ_ONLY",
        label="새 조회 Tool",
    )
    assert entry.tool_name == "custom.new_tool"
    resolved = registry.resolve("custom.new_tool")
    assert resolved is not None
    assert resolved.input_schema == VALID_SCHEMA

    listed = registry.list_entries()
    assert [e.tool_name for e in listed] == ["custom.new_tool"]
    assert registry.enabled is True


def test_register_is_idempotent_per_tool_name(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    registry.register(
        tool_name="custom.new_tool",
        server_alias=ALIAS,
        input_schema=VALID_SCHEMA,
        confirmation_policy="NEVER",
        risk_level="READ_ONLY",
    )
    registry.register(
        tool_name="custom.new_tool",
        server_alias=ALIAS,
        input_schema=VALID_SCHEMA,
        confirmation_policy="ON_PARAMETER",
        risk_level="READ_ONLY",
    )
    assert len(registry.list_entries()) == 1
    assert registry.resolve("custom.new_tool").confirmation_policy == "ON_PARAMETER"


def test_unregister_removes_entry(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    registry.register(
        tool_name="custom.new_tool",
        server_alias=ALIAS,
        input_schema=VALID_SCHEMA,
        confirmation_policy="NEVER",
        risk_level="READ_ONLY",
    )
    assert registry.unregister("custom.new_tool") is True
    assert registry.resolve("custom.new_tool") is None
    # DELETE must be safe to call unconditionally (uninstall path).
    assert registry.unregister("custom.new_tool") is False
    assert registry.unregister("never-registered.tool") is False


# --- default-off ---------------------------------------------------------


def test_registration_disabled_by_default(tmp_path: Path) -> None:
    """Empty allowed_aliases (AgentRuntimeSettings default) refuses every
    registration — mirrors D-079's SEARCH_LOCAL_INDEX_ROOTS default-off."""
    registry = make_registry(tmp_path, allowed_aliases=())
    assert registry.enabled is False
    expect_refusal(
        lambda: registry.register(
            tool_name="custom.new_tool",
            server_alias=ALIAS,
            input_schema=VALID_SCHEMA,
            confirmation_policy="NEVER",
            risk_level="READ_ONLY",
        ),
        "mcp_tool_registration_disabled",
        code="PERMISSION_DENIED",
    )


# --- the two vulnerability-shaped refusals --------------------------------


def test_tool_not_in_office_profile_allowlist_is_refused(tmp_path: Path) -> None:
    """A registration cannot manufacture permission the Office Profile does
    not already grant — this is the core of the safety boundary."""
    registry = make_registry(tmp_path)
    expect_refusal(
        lambda: registry.register(
            tool_name="db_metadata.drop_table",  # never in allowed_tools
            server_alias=ALIAS,
            input_schema=VALID_SCHEMA,
            confirmation_policy="NEVER",
            risk_level="READ_ONLY",
        ),
        "tool_not_in_server_allowlist",
        code="PERMISSION_DENIED",
    )


def test_confirmation_policy_weaker_than_builtin_is_refused(tmp_path: Path) -> None:
    """table_count.query is a built-in with ON_PARAMETER — a registration
    must not be able to downgrade it to NEVER (silent execution)."""
    registry = make_registry(tmp_path)
    expect_refusal(
        lambda: registry.register(
            tool_name="table_count.query",
            server_alias=ALIAS,
            input_schema=VALID_SCHEMA,
            confirmation_policy="NEVER",
            risk_level="READ_ONLY",
        ),
        "confirmation_policy_weaker_than_builtin",
        code="PERMISSION_DENIED",
    )


def test_confirmation_policy_equal_or_stricter_than_builtin_is_accepted(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    entry = registry.register(
        tool_name="table_count.query",
        server_alias=ALIAS,
        input_schema=VALID_SCHEMA,
        confirmation_policy="ALWAYS",  # stricter than built-in ON_PARAMETER
        risk_level="READ_ONLY",
    )
    assert entry.confirmation_policy == "ALWAYS"
    # But resolution must never consult it — see mcp_tools.py's own tests
    # for the resolution-order guarantee.


# --- other refusals --------------------------------------------------------


def test_server_alias_not_in_profile_is_refused(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    expect_refusal(
        lambda: registry.register(
            tool_name="custom.new_tool",
            server_alias="nonexistent-alias",
            input_schema=VALID_SCHEMA,
            confirmation_policy="NEVER",
            risk_level="READ_ONLY",
        ),
        "server_alias_not_in_profile",
    )


def test_server_alias_not_opted_into_dynamic_registration_is_refused(tmp_path: Path) -> None:
    """OTHER_ALIAS exists in the Office Profile but is not in this
    deployment's allowed_aliases opt-in list."""
    registry = make_registry(tmp_path, allowed_aliases=(ALIAS,))
    expect_refusal(
        lambda: registry.register(
            tool_name="other.tool",
            server_alias=OTHER_ALIAS,
            input_schema=VALID_SCHEMA,
            confirmation_policy="NEVER",
            risk_level="READ_ONLY",
        ),
        "server_alias_not_allowed_for_registration",
        code="PERMISSION_DENIED",
    )


def test_risk_level_must_be_read_only(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    expect_refusal(
        lambda: registry.register(
            tool_name="custom.new_tool",
            server_alias=ALIAS,
            input_schema=VALID_SCHEMA,
            confirmation_policy="NEVER",
            risk_level="WRITE",
        ),
        "risk_level_not_read_only",
    )


def test_invalid_tool_name_is_refused(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    expect_refusal(
        lambda: registry.register(
            tool_name="not-a-tool-name",
            server_alias=ALIAS,
            input_schema=VALID_SCHEMA,
            confirmation_policy="NEVER",
            risk_level="READ_ONLY",
        ),
        "tool_name_invalid",
    )


def test_invalid_json_schema_is_refused(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    expect_refusal(
        lambda: registry.register(
            tool_name="custom.new_tool",
            server_alias=ALIAS,
            input_schema={"type": "not-a-real-type"},
            confirmation_policy="NEVER",
            risk_level="READ_ONLY",
        ),
        "input_schema_invalid",
    )


def test_schema_declaring_identity_field_is_refused(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    expect_refusal(
        lambda: registry.register(
            tool_name="custom.new_tool",
            server_alias=ALIAS,
            input_schema={
                "type": "object",
                "properties": {"role": {"type": "string"}},
            },
            confirmation_policy="NEVER",
            risk_level="READ_ONLY",
        ),
        "input_schema_declares_identity_field",
    )


def test_invalid_confirmation_policy_is_refused(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    expect_refusal(
        lambda: registry.register(
            tool_name="custom.new_tool",
            server_alias=ALIAS,
            input_schema=VALID_SCHEMA,
            confirmation_policy="SOMETIMES",
            risk_level="READ_ONLY",
        ),
        "confirmation_policy_invalid",
    )


def test_label_too_long_is_refused(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    expect_refusal(
        lambda: registry.register(
            tool_name="custom.new_tool",
            server_alias=ALIAS,
            input_schema=VALID_SCHEMA,
            confirmation_policy="NEVER",
            risk_level="READ_ONLY",
            label="x" * 201,
        ),
        "label_too_long",
    )


# --- re-validation on read -------------------------------------------------


def test_entry_disappears_from_list_when_office_profile_narrows_afterward(tmp_path: Path) -> None:
    """Registration-time validity is not enough — a stale entry must never
    be reported as active once the Office Profile changes."""
    profile: dict[str, Any] = {
        "allowed_mcp_servers": [
            {"alias": ALIAS, "endpoint": "http://x", "allowed_tools": ["custom.new_tool"]}
        ]
    }
    registry = MCPToolRegistry(
        registry_path=tmp_path / "state" / "mcp-tool-registry.json",
        allowed_aliases=(ALIAS,),
        office_profile_provider=lambda: profile,
    )
    registry.register(
        tool_name="custom.new_tool",
        server_alias=ALIAS,
        input_schema=VALID_SCHEMA,
        confirmation_policy="NEVER",
        risk_level="READ_ONLY",
    )
    assert registry.resolve("custom.new_tool") is not None

    # Operator narrows the Office Profile's allowed_tools afterward.
    profile["allowed_mcp_servers"][0]["allowed_tools"] = []
    assert registry.resolve("custom.new_tool") is None
    assert registry.list_entries() == []


def test_entry_disappears_when_deployment_revokes_alias_opt_in(tmp_path: Path) -> None:
    profile = {
        "allowed_mcp_servers": [
            {"alias": ALIAS, "endpoint": "http://x", "allowed_tools": ["custom.new_tool"]}
        ]
    }
    registry = MCPToolRegistry(
        registry_path=tmp_path / "state" / "mcp-tool-registry.json",
        allowed_aliases=(ALIAS,),
        office_profile_provider=lambda: profile,
    )
    registry.register(
        tool_name="custom.new_tool",
        server_alias=ALIAS,
        input_schema=VALID_SCHEMA,
        confirmation_policy="NEVER",
        risk_level="READ_ONLY",
    )

    # A second registry instance simulates the deployment revoking the
    # alias opt-in (allowed_aliases is a startup setting).
    revoked_registry = MCPToolRegistry(
        registry_path=registry._registry_path,  # noqa: SLF001 (test-only access)
        allowed_aliases=(),
        office_profile_provider=lambda: profile,
    )
    assert revoked_registry.resolve("custom.new_tool") is None
    assert revoked_registry.list_entries() == []


def test_malformed_registry_row_does_not_take_down_the_whole_file(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    registry.register(
        tool_name="custom.new_tool",
        server_alias=ALIAS,
        input_schema=VALID_SCHEMA,
        confirmation_policy="NEVER",
        risk_level="READ_ONLY",
    )
    path = tmp_path / "state" / "mcp-tool-registry.json"
    import json

    rows = json.loads(path.read_text(encoding="utf-8"))
    rows.append({"garbage": True})
    path.write_text(json.dumps(rows), encoding="utf-8")

    assert [e.tool_name for e in registry.list_entries()] == ["custom.new_tool"]
