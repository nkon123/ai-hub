"""agent-runtime's hand-copied `MCP_TOOL_SPECS` vs office-mcp-server's registry.

`services/agent-runtime/.../mcp_tools.py` says so itself: it mirrors
`services/office-mcp-server/.../tools_setup.py` **by hand**, because M05 must
not import M10's internals (구현 원칙 2) and this PoC has no live Tool
Registry to fetch contracts from (D-034). Its module docstring calls the
result "a known drift risk", and M05's progress-log row still lists
"`mcp_tools.py` 손 복사 Schema Drift 위험 여전" as outstanding. This file is
what turns that risk from "someone must remember" into a failing test.

`tests/contract/test_mcp_tool_fixtures.py` (D-049) already pins the *other*
edge, Portal Manifest Fixture ↔ office-mcp-server. Together the two cover all
three copies of the same tools.

What drift actually costs, in the two directions it can go:

  - agent-runtime **stricter** than the server: ANALYZE rejects a call that
    would have been fine. Annoying, visible, safe.
  - agent-runtime **looser**: the call is dispatched and office-mcp-server
    rejects it. Not a security hole — the server re-validates authoritatively
    — but the user sees a failure attributed to the wrong layer, and for a
    D-083 routed call the model already "chose" a tool it could never run.

Neither is caught by any other test, because nothing imports both.

Deliberately NOT asserted: that every registered tool appears in
`MCP_TOOL_SPECS`. `calculator.add` is registered on the server but
intentionally absent here — it resolves through the D-080 dynamic registry
instead, which is the path a newly installed MCP Tool asset takes. The rule
is about tools this table *does* claim to describe.
"""

from __future__ import annotations

from typing import Any

import pytest
from agent_runtime.mcp_tools import MCP_TOOL_SPECS
from office_mcp_server.tool_registry import ToolRegistry, UserConfirmationPolicy
from office_mcp_server.tools_setup import register_poc_tools


@pytest.fixture(scope="module")
def registered_tools() -> dict[str, Any]:
    registry = ToolRegistry()
    register_poc_tools(registry)
    return {tool.name: tool for tool in registry.list_all()}


_SPEC_NAMES = sorted(MCP_TOOL_SPECS)


def test_the_static_table_is_not_empty() -> None:
    """A guard on the guard: if this table were ever emptied, every
    per-tool test below would vacuously pass."""
    assert _SPEC_NAMES


@pytest.mark.parametrize("tool_name", _SPEC_NAMES)
def test_every_copied_tool_still_exists_on_the_server(
    tool_name: str, registered_tools: dict[str, Any]
) -> None:
    """A tool removed or renamed in M10 leaves a stale entry here that
    ANALYZE would happily validate against — and then dispatch to a tool the
    server no longer has."""
    assert tool_name in registered_tools, (
        f"MCP_TOOL_SPECS describes {tool_name}, which office-mcp-server no longer registers. "
        "Update the hand copy in services/agent-runtime/src/agent_runtime/mcp_tools.py."
    )


@pytest.mark.parametrize("tool_name", _SPEC_NAMES)
def test_input_schema_matches_the_authoritative_one(
    tool_name: str, registered_tools: dict[str, Any]
) -> None:
    """Exact equality, unlike the Portal fixture test's structural check.

    The fixture is a human-facing catalog document and legitimately carries
    extra prose; this table is a validator input, so anything that differs
    changes what ANALYZE accepts. `required`, property names, per-property
    constraints and `additionalProperties` all matter here — a `maxLength`
    that drifts is exactly the kind of difference that produces a rejection
    at the wrong layer.
    """
    assert MCP_TOOL_SPECS[tool_name]["input_schema"] == registered_tools[tool_name].input_schema, (
        f"{tool_name}: agent-runtime's copied input_schema differs from office-mcp-server's. "
        "Re-copy it from tools_setup.py (and its description in the same edit)."
    )


@pytest.mark.parametrize("tool_name", _SPEC_NAMES)
def test_confirmation_policy_matches_the_authoritative_one(
    tool_name: str, registered_tools: dict[str, Any]
) -> None:
    """§8.4. A copy that says NEVER where the server says ON_PARAMETER makes
    the Run skip WAITING_FOR_USER and dispatch without the confirmation the
    policy requires — the server still refuses, but the user was never asked."""
    server_policy = UserConfirmationPolicy(
        registered_tools[tool_name].user_confirmation_policy
    ).value

    copied_policy = MCP_TOOL_SPECS[tool_name]["confirmation_policy"]
    assert copied_policy == server_policy, (
        f"{tool_name}: confirmation policy drifted "
        f"({copied_policy} here vs {server_policy} on the server)."
    )


@pytest.mark.parametrize("tool_name", _SPEC_NAMES)
def test_description_is_copied_verbatim(
    tool_name: str, registered_tools: dict[str, Any]
) -> None:
    """D-083: this text goes into the TOOL_ROUTE prompt, so it is what the
    model uses to pick a tool. `mcp_tools.py` instructs copying it verbatim
    rather than composing new prose — prose written here would describe a
    tool that behaves as the server defines it, not as this sentence claims."""
    assert MCP_TOOL_SPECS[tool_name]["description"] == registered_tools[tool_name].description, (
        f"{tool_name}: description drifted from tools_setup.py. Copy it verbatim, do not rewrite."
    )


@pytest.mark.parametrize("tool_name", _SPEC_NAMES)
def test_copied_tools_are_read_only(
    tool_name: str, registered_tools: dict[str, Any]
) -> None:
    """구현 원칙 8. The registry enforces READ_ONLY on its own side; this
    asserts the copy never describes something outside that surface — the
    premise D-083's fail-closed routing design explicitly rests on."""
    # Direct attribute access on purpose: a `getattr(..., default)` here would
    # keep passing if the field were ever renamed away, which is precisely the
    # drift this file exists to catch.
    assert registered_tools[tool_name].risk_level == "READ_ONLY"
