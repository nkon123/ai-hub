"""D-079: the local Knowledge index registration contract, and the guard that
`services/search-runtime` has not drifted away from it.

Why a drift test and not just a schema-validity test: this contract has two
independent implementers — search-runtime (M08) serves it, and the Desktop
Client (M04) calls it over HTTP without importing any of M08's code. Nothing
in the type system connects the two, so a field renamed on one side would
otherwise only surface as a Knowledge that silently refuses to activate on a
user's machine.
"""

from __future__ import annotations

import json

import pytest
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

from .conftest import API_DIR, SCHEMAS_ROOT

SCHEMA_PATH = API_DIR / "knowledge-local-index.schema.json"
REPO_ROOT = SCHEMAS_ROOT.parent.parent
REGISTRY_SOURCE = (
    REPO_ROOT / "services" / "search-runtime" / "src" / "search_runtime" / "local_index_registry.py"
)


@pytest.fixture(scope="module")
def schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def test_schema_is_a_valid_json_schema(schema: dict) -> None:
    Draft202012Validator.check_schema(schema)


def test_register_request_accepts_the_shape_desktop_sends(schema: dict) -> None:
    validator = Draft202012Validator(
        {**schema["definitions"]["RegisterLocalIndexRequest"], "definitions": schema["definitions"]}
    )
    validator.validate({
        "knowledge_id": "d9e660b7-ca76-4f46-899e-2e1621bac139",
        "index_path": "/Users/x/Library/Application Support/app/assets/knowledge/a/1.0.0/index",
        "source": "DESKTOP_OFFLINE_BUNDLE",
        "label": "재택근무 정책 Knowledge v1.0.0",
    })


def test_register_request_rejects_an_unknown_source(schema: dict) -> None:
    """`source` is a closed enum on purpose — search-runtime applies stricter
    artifact rules to distributed content than to locally-built content, so
    the channel has to be named, not described."""
    validator = Draft202012Validator(
        {**schema["definitions"]["RegisterLocalIndexRequest"], "definitions": schema["definitions"]}
    )
    with pytest.raises(ValidationError):
        validator.validate({
            "knowledge_id": "d9e660b7-ca76-4f46-899e-2e1621bac139",
            "index_path": "/tmp/index",
            "source": "SOMEWHERE_ELSE",
        })


def test_search_runtime_request_model_matches_the_contract(schema: dict) -> None:
    """The served model's field names are exactly the contract's properties."""
    from search_runtime.main import RegisterLocalIndexRequest

    assert set(RegisterLocalIndexRequest.model_fields) == set(
        schema["definitions"]["RegisterLocalIndexRequest"]["properties"]
    )


def test_search_runtime_accepts_exactly_the_contract_sources(schema: dict) -> None:
    from search_runtime.local_index_registry import ALLOWED_SOURCES

    assert set(ALLOWED_SOURCES) == set(schema["definitions"]["LocalIndexSource"]["enum"])


def test_entry_response_fields_match_the_contract(schema: dict) -> None:
    from search_runtime.local_index_registry import LocalIndexEntry

    entry = LocalIndexEntry(
        knowledge_id="d9e660b7-ca76-4f46-899e-2e1621bac139",
        index_path="/tmp/index",
        source="DESKTOP_OFFLINE_BUNDLE",
        label=None,
        registered_at="2026-08-13T00:00:00+00:00",
    )
    validator = Draft202012Validator(
        {**schema["definitions"]["LocalIndexEntry"], "definitions": schema["definitions"]}
    )
    validator.validate(entry.to_dict())


def test_every_documented_refusal_reason_is_actually_raised_somewhere() -> None:
    """The contract enumerates the refusal reasons Desktop switches on. A
    reason documented but never raised (or raised but never documented) is a
    UI branch that can never be reached, or an error the UI cannot explain."""
    source = REGISTRY_SOURCE.read_text(encoding="utf-8")
    documented = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))["definitions"][
        "RegisterLocalIndexResponse"
    ]["description"]

    raised = {
        "local_indexes_disabled",
        "path_outside_allowed_roots",
        "path_not_absolute",
        "path_not_a_directory",
        "knowledge_id_invalid",
        "index_meta_missing",
        "index_meta_unreadable",
        "index_meta_knowledge_id_mismatch",
        "bm25_missing",
        "bm25_legacy_pickle_only",
        "chroma_missing",
        "central_index_exists",
        "source_not_allowed",
        "label_too_long",
    }
    for reason in raised:
        assert f'"{reason}"' in source, f"reason not raised by the service: {reason}"
        assert reason in documented, f"reason not documented in the contract: {reason}"
