"""D-034 해석 경로 4: the local Agent Package activation contract, and the
guard that `services/agent-runtime` has not drifted away from it.

Same rationale as `test_knowledge_local_index_contract.py` (D-079) and
`test_mcp_tool_registration_contract.py` (D-080): this contract has two
independent implementers in principle (agent-runtime serves it, Desktop
would call it), so nothing in the type system connects a field rename on
one side to the other except this test.
"""

from __future__ import annotations

import json

import pytest
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

from .conftest import API_DIR, SCHEMAS_ROOT

SCHEMA_PATH = API_DIR / "local-agent-registration.schema.json"
REPO_ROOT = SCHEMAS_ROOT.parent.parent
REGISTRY_SOURCE = (
    REPO_ROOT
    / "services"
    / "agent-runtime"
    / "src"
    / "agent_runtime"
    / "local_agent_registry.py"
)

AGENT_ID = "11111111-1111-4111-8111-111111111111"
PROMPT_ID = "22222222-2222-4222-8222-222222222222"


@pytest.fixture(scope="module")
def schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def test_schema_is_a_valid_json_schema(schema: dict) -> None:
    Draft202012Validator.check_schema(schema)


def test_register_request_accepts_the_shape_desktop_would_send(schema: dict) -> None:
    validator = Draft202012Validator(
        {**schema["definitions"]["RegisterLocalAgentRequest"], "definitions": schema["definitions"]}
    )
    validator.validate({
        "agent_asset_id": AGENT_ID,
        "agent_version": "1.0.0",
        "prompt_asset_id": PROMPT_ID,
        "prompt_version": "1.0.0",
        "label": "테스트 로컬 Agent",
    })


def test_register_request_has_no_path_or_filename_field(schema: dict) -> None:
    """The safety boundary in one assertion — root CLAUDE.md 코드 규칙:
    사용자가 제공한 파일명으로 파일 경로를 만들지 않는다. There must be no
    field on this contract that could name a filesystem location."""
    properties = set(schema["definitions"]["RegisterLocalAgentRequest"]["properties"])
    forbidden = {
        "path",
        "index_path",
        "agent_dir",
        "prompt_dir",
        "install_dir",
        "directory",
        "folder",
    }
    collision = properties & forbidden
    assert not collision, (
        f"RegisterLocalAgentRequest must never accept a path/filename field: {collision}"
    )


def test_register_request_rejects_a_non_uuid_agent_asset_id(schema: dict) -> None:
    validator = Draft202012Validator(
        {
            **schema["definitions"]["RegisterLocalAgentRequest"],
            "definitions": schema["definitions"],
        },
        format_checker=Draft202012Validator.FORMAT_CHECKER,
    )
    with pytest.raises(ValidationError):
        validator.validate({
            "agent_asset_id": "not-a-uuid",
            "agent_version": "1.0.0",
            "prompt_asset_id": PROMPT_ID,
            "prompt_version": "1.0.0",
        })


def test_register_request_rejects_a_non_semver_version(schema: dict) -> None:
    validator = Draft202012Validator(
        {**schema["definitions"]["RegisterLocalAgentRequest"], "definitions": schema["definitions"]}
    )
    with pytest.raises(ValidationError):
        validator.validate({
            "agent_asset_id": AGENT_ID,
            "agent_version": "not-semver",
            "prompt_asset_id": PROMPT_ID,
            "prompt_version": "1.0.0",
        })


def test_agent_runtime_request_model_matches_the_contract(schema: dict) -> None:
    from agent_runtime.routers.local_agents import RegisterLocalAgentRequest

    assert set(RegisterLocalAgentRequest.model_fields) == set(
        schema["definitions"]["RegisterLocalAgentRequest"]["properties"]
    )


def test_entry_response_fields_match_the_contract(schema: dict) -> None:
    from agent_runtime.local_agent_registry import LocalAgentEntry

    entry = LocalAgentEntry(
        agent_asset_id=AGENT_ID,
        agent_version="1.0.0",
        prompt_asset_id=PROMPT_ID,
        prompt_version="1.0.0",
        agent_dir="/tmp/root/assets/agents/x/1.0.0",
        prompt_dir="/tmp/root/assets/prompts/y/1.0.0",
        label=None,
        registered_at="2026-08-17T00:00:00+00:00",
    )
    validator = Draft202012Validator(
        {**schema["definitions"]["LocalAgentEntry"], "definitions": schema["definitions"]}
    )
    validator.validate(entry.to_dict())


def test_every_documented_refusal_reason_is_actually_raised_somewhere() -> None:
    """The contract enumerates the refusal reasons a caller switches on. A
    reason documented but never raised is a UI branch that can never be
    reached; a reason raised but never documented is an error the UI cannot
    explain."""
    source = REGISTRY_SOURCE.read_text(encoding="utf-8")
    documented = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))["definitions"][
        "RegisterLocalAgentResponse"
    ]["description"]

    raised = {
        "local_agents_disabled",
        "agent_asset_id_invalid",
        "agent_version_invalid",
        "prompt_asset_id_invalid",
        "prompt_version_invalid",
        "label_too_long",
        "path_outside_allowed_roots",
        "agent_install_not_found",
        "prompt_install_not_found",
        "agent_manifest_missing",
        "prompt_manifest_missing",
        "agent_manifest_unreadable",
        "prompt_manifest_unreadable",
        "agent_manifest_schema_invalid",
        "prompt_manifest_schema_invalid",
        "agent_manifest_id_mismatch",
        "agent_manifest_version_mismatch",
        "prompt_manifest_id_mismatch",
        "prompt_manifest_version_mismatch",
        "prompt_template_missing",
    }
    for reason in raised:
        assert f'"{reason}"' in source, f"reason not raised by the service: {reason}"
        assert reason in documented, f"reason not documented in the contract: {reason}"
