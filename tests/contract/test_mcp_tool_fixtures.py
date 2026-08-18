"""D-049: every §5 PoC Tool has a Portal Manifest Fixture, and none of them
has drifted away from the authoritative runtime definition.

Three definitions of the same three Tools exist in this repo and nothing in
the type system connects them:

1. `services/office-mcp-server/.../tools_setup.py` — the authoritative one.
   office-mcp-server re-validates every call against it before touching a
   Connector, so it is what actually decides whether a call succeeds.
2. `services/agent-runtime/.../mcp_tools.py::MCP_TOOL_SPECS` — a hand-copied
   static table agent-runtime uses for pre-call validation and for the §8.4
   confirmation policy.
3. `fixtures/valid/mcp-*/mcp-tool-manifest.json` — what a Portal *asset*
   looks like: the thing that gets registered, approved, bundled and
   installed onto a Desktop, and then handed to D-080 registration.

A fixture that disagrees with (1) does not fail loudly — it produces a
catalog entry and a Wizard example that describes a Tool differently from
the one that will actually run, and a Desktop registration whose declared
input_schema is a lie the user cannot see. This test is the only thing that
notices.

Deliberately NOT asserted here: exact input_schema equality. The manifest is
a human-facing catalog document and carries `description` text and
Allowlist wording the runtime schema has no reason to hold. What must match
is the *shape a caller has to satisfy* — required fields, accepted property
names, and whether unknown properties are refused.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from office_mcp_server.tool_registry import ToolRegistry, UserConfirmationPolicy
from office_mcp_server.tools_setup import register_poc_tools

from .conftest import VALID_DIR

# apps/desktop-client/electron/mcp-tool-manifest.ts maps the manifest's one
# boolean onto the registration contract's three-value policy. The manifest
# schema cannot express ON_PARAMETER, so a Tool whose real policy is
# ON_PARAMETER must round *up* to ALWAYS — rounding down would be refused at
# registration (`confirmation_policy_weaker_than_builtin`) and, worse, would
# describe a weaker policy than the server enforces.
_DESKTOP_POLICY_MAPPING = {False: "NEVER", True: "ALWAYS"}
_POLICY_RANK = {"NEVER": 0, "ON_PARAMETER": 1, "ALWAYS": 2}

# 07-data-api-contracts.md: identity travels only through the server-built
# `audit_context`, never through caller-supplied tool input.
_IDENTITY_FIELDS = {"user", "user_id", "role", "roles", "org", "organization_id"}


@pytest.fixture(scope="module")
def registered_tools() -> dict[str, Any]:
    registry = ToolRegistry()
    register_poc_tools(registry)
    return {tool.name: tool for tool in registry.list_all()}


def _mcp_tool_fixtures() -> list[tuple[str, dict[str, Any]]]:
    found: list[tuple[str, dict[str, Any]]] = []
    for path in sorted(VALID_DIR.rglob("*.json")):
        manifest = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(manifest, dict) and manifest.get("type") == "mcp_tool":
            found.append((str(path.relative_to(VALID_DIR)), manifest))
    return found


_FIXTURES = _mcp_tool_fixtures()
_FIXTURE_IDS = [name for name, _ in _FIXTURES]


def test_every_registered_tool_has_a_manifest_fixture(
    registered_tools: dict[str, Any],
) -> None:
    """A Tool the runtime can execute but the Portal cannot register is a
    Tool no Desktop can ever install — the exact gap D-049 recorded."""
    fixture_tool_names = {manifest["tool_name"] for _, manifest in _FIXTURES}
    missing = sorted(set(registered_tools) - fixture_tool_names)
    assert not missing, (
        f"office-mcp-server registers {missing} but no fixtures/valid/*/mcp-tool-manifest.json "
        "declares them — add a Portal Manifest Fixture (D-049)."
    )


def test_no_two_fixtures_claim_the_same_tool_name() -> None:
    """한 Manifest = 한 Portal 등록 자산. Two assets claiming the same
    `tool_name` would make D-080 registration (idempotent per tool_name)
    silently overwrite one with the other."""
    seen: dict[str, str] = {}
    for name, manifest in _FIXTURES:
        tool_name = manifest["tool_name"]
        assert tool_name not in seen, (
            f"{name} and {seen[tool_name]} both declare tool_name={tool_name}"
        )
        seen[tool_name] = name


@pytest.mark.parametrize(("name", "manifest"), _FIXTURES, ids=_FIXTURE_IDS)
def test_fixture_matches_office_mcp_server_registry(
    name: str, manifest: dict[str, Any], registered_tools: dict[str, Any]
) -> None:
    tool_name = manifest["tool_name"]
    assert tool_name in registered_tools, (
        f"{name} declares tool_name={tool_name}, which office-mcp-server does not register — "
        "a Portal asset for a Tool that cannot execute."
    )
    tool = registered_tools[tool_name]

    assert manifest["server_alias"] == tool.server_alias
    # 구현 원칙 8 — this PoC's MCP surface is READ_ONLY end to end.
    assert manifest["risk_level"] == "READ_ONLY"

    manifest_schema = manifest["input_schema"]
    runtime_schema = tool.input_schema
    assert set(manifest_schema.get("required", [])) == set(runtime_schema.get("required", []))
    assert set(manifest_schema.get("properties", {})) == set(runtime_schema.get("properties", {}))
    assert manifest_schema.get("additionalProperties") == runtime_schema.get(
        "additionalProperties"
    ), f"{name}: manifest and runtime disagree on whether unknown input properties are refused"


@pytest.mark.parametrize(("name", "manifest"), _FIXTURES, ids=_FIXTURE_IDS)
def test_fixture_input_schema_declares_no_identity_field(
    name: str, manifest: dict[str, Any]
) -> None:
    declared = set(manifest["input_schema"].get("properties", {}))
    leaked = sorted(declared & _IDENTITY_FIELDS)
    assert not leaked, (
        f"{name}: input_schema declares identity field(s) {leaked} — identity comes from the "
        "server-built audit_context only, and D-080 registration refuses such a schema "
        "(input_schema_declares_identity_field)."
    )


@pytest.mark.parametrize(("name", "manifest"), _FIXTURES, ids=_FIXTURE_IDS)
def test_fixture_confirmation_is_never_weaker_than_the_server_policy(
    name: str, manifest: dict[str, Any], registered_tools: dict[str, Any]
) -> None:
    """The manifest's boolean must not describe *less* confirmation than
    office-mcp-server enforces. Stricter is allowed and is the only way a
    manifest can represent ON_PARAMETER at all."""
    tool = registered_tools[manifest["tool_name"]]
    server_policy = UserConfirmationPolicy(tool.user_confirmation_policy).value
    requires_confirmation = (
        manifest.get("execution_guards", {}).get("requires_user_confirmation") is True
    )
    declared_policy = _DESKTOP_POLICY_MAPPING[requires_confirmation]

    assert _POLICY_RANK[declared_policy] >= _POLICY_RANK[server_policy], (
        f"{name}: execution_guards.requires_user_confirmation={requires_confirmation} maps to "
        f"{declared_policy}, weaker than office-mcp-server's {server_policy}. D-080 registration "
        "would be refused with confirmation_policy_weaker_than_builtin; set it to true."
    )
