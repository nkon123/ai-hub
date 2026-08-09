"""ToolRegistry — READ_ONLY guard (pre-existing behavior, kept covered) and
Kill Switch (§11)."""

from __future__ import annotations

import pytest
from office_mcp_server.tool_registry import RegisteredTool, ToolRegistry, ToolStatus


def _minimal_tool(name: str = "some.tool", risk_level: str = "READ_ONLY") -> RegisteredTool:
    return RegisteredTool(
        name=name,
        version="1.0.0",
        server_alias="oracle-connector",
        description="test tool",
        input_schema={},
        output_schema={},
        risk_level=risk_level,
    )


def test_register_read_only_tool_succeeds() -> None:
    registry = ToolRegistry()
    registry.register(_minimal_tool())
    assert registry.get("some.tool") is not None


@pytest.mark.parametrize("risk_level", ["WRITE", "READ_WRITE", "ADMIN", ""])
def test_register_rejects_non_read_only_tool(risk_level: str) -> None:
    registry = ToolRegistry()
    with pytest.raises(ValueError, match="READ_ONLY"):
        registry.register(_minimal_tool(risk_level=risk_level))
    assert registry.get("some.tool") is None


def test_new_tool_defaults_to_active() -> None:
    registry = ToolRegistry()
    registry.register(_minimal_tool())
    assert registry.is_active("some.tool")
    assert registry.status_of("some.tool") == ToolStatus.ACTIVE


def test_kill_switch_disable_then_enable() -> None:
    registry = ToolRegistry()
    registry.register(_minimal_tool())

    assert registry.disable("some.tool") is True
    assert registry.is_active("some.tool") is False
    assert registry.status_of("some.tool") == ToolStatus.DISABLED

    assert registry.enable("some.tool") is True
    assert registry.is_active("some.tool") is True


def test_kill_switch_on_unknown_tool_returns_false() -> None:
    registry = ToolRegistry()
    assert registry.disable("nonexistent") is False
    assert registry.enable("nonexistent") is False


def test_admin_list_includes_status() -> None:
    registry = ToolRegistry()
    registry.register(_minimal_tool())
    registry.disable("some.tool")
    [entry] = registry.admin_list()
    assert entry["status"] == "DISABLED"
    assert entry["name"] == "some.tool"
