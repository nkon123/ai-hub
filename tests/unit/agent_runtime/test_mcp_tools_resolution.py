"""D-080: the resolution order between agent_runtime.mcp_tools.MCP_TOOL_SPECS
(built-ins) and a registered tool (agent_runtime.mcp_tool_registry) — the
single chokepoint `validate_tool_input`/`confirmation_policy_for` both use.

The property under test: MCP_TOOL_SPECS always wins for a name it already
has. A registration can never replace a built-in's schema with a looser one,
even if the registry itself would otherwise return an entry for that name.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from agent_runtime import mcp_tools
from agent_runtime.mcp_tool_registry import MCPToolRegistry

ALIAS = "oracle-connector"

OFFICE_PROFILE: dict[str, Any] = {
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
        }
    ]
}

LOOSE_SCHEMA: dict[str, Any] = {"type": "object"}  # accepts anything


def make_registry(tmp_path: Path) -> MCPToolRegistry:
    return MCPToolRegistry(
        registry_path=tmp_path / "mcp-tool-registry.json",
        allowed_aliases=(ALIAS,),
        office_profile_provider=lambda: OFFICE_PROFILE,
    )


@pytest.fixture(autouse=True)
def _patch_registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    registry = make_registry(tmp_path)
    monkeypatch.setattr("agent_runtime.mcp_tool_registry.get_registry", lambda: registry)
    yield registry


def test_registered_tool_reaches_validate_tool_input(_patch_registry: MCPToolRegistry) -> None:
    """A tool that is NOT a built-in becomes validatable once registered —
    this is the entire point of D-080."""
    assert mcp_tools.validate_tool_input("custom.new_tool", {}) == [
        "알 수 없는 Tool입니다: custom.new_tool"
    ]

    _patch_registry.register(
        tool_name="custom.new_tool",
        server_alias=ALIAS,
        input_schema={
            "type": "object",
            "required": ["value"],
            "additionalProperties": False,
            "properties": {"value": {"type": "string"}},
        },
        confirmation_policy="NEVER",
        risk_level="READ_ONLY",
    )

    assert mcp_tools.validate_tool_input("custom.new_tool", {"value": "x"}) == []
    errors = mcp_tools.validate_tool_input("custom.new_tool", {})
    assert errors  # missing required field
    assert mcp_tools.confirmation_policy_for("custom.new_tool") == "NEVER"


def test_builtin_spec_is_never_shadowed_by_a_looser_registration(
    _patch_registry: MCPToolRegistry,
) -> None:
    """Even if a registration for a built-in name existed with a wide-open
    schema, resolution must still use the built-in's strict schema."""
    # Register with a policy at least as strict as the built-in (registry
    # itself would refuse anything weaker) — the point under test is that,
    # regardless of what got stored, the built-in schema/policy still wins.
    _patch_registry.register(
        tool_name="table_count.query",
        server_alias=ALIAS,
        input_schema=LOOSE_SCHEMA,  # would accept e.g. {"anything": True}
        confirmation_policy="ALWAYS",
        risk_level="READ_ONLY",
    )

    # The built-in schema requires schema+table; a bare {} must still fail
    # even though the registered LOOSE_SCHEMA would have accepted it.
    errors = mcp_tools.validate_tool_input("table_count.query", {})
    assert errors, "built-in's strict schema must still be enforced"

    # And the built-in's own confirmation_policy (ON_PARAMETER) must be what
    # is returned, not the registered ALWAYS.
    assert mcp_tools.confirmation_policy_for("table_count.query") == mcp_tools.ON_PARAMETER


def test_unregistered_unknown_tool_still_refused(_patch_registry: MCPToolRegistry) -> None:
    assert mcp_tools.confirmation_policy_for("nonexistent.tool") is None
    assert mcp_tools.validate_tool_input("nonexistent.tool", {}) == [
        "알 수 없는 Tool입니다: nonexistent.tool"
    ]


def test_resolve_allowed_alias_is_unaffected_by_registration(
    _patch_registry: MCPToolRegistry,
) -> None:
    """resolve_allowed_alias only ever reads the Office Profile — it does
    not consult the registry at all, by design (the permission gate stays
    in exactly one place)."""
    assert mcp_tools.resolve_allowed_alias(OFFICE_PROFILE, "custom.new_tool") == ALIAS
    assert mcp_tools.resolve_allowed_alias(OFFICE_PROFILE, "never-allowed.tool") is None
