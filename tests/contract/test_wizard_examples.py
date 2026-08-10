"""Anti-rot test for the P05 asset registration wizard's per-type examples.

`apps/portal-web/app/assets/new/[type]/examples/route.ts` shows CREATOR users
a real, working example manifest for `agent` / `prompt` / `mcp_tool` (real
user feedback: "어떤 파일을 등록하라는건지 모르겠다" — see
docs/implementation-spec/progress-log.md M01 session history). That route
reads `fixtures/valid/*` verbatim and only ever (a) swaps `id` for a fresh
UUID and (b) drops the optional `manifest_hash`/`created_at` placeholders —
see `fixtures/wizard-examples-index.json` for the single source-of-truth
mapping both that route and this test read.

This test mirrors that exact transform in Python and asserts the result
still validates against `packages/schemas`. If a schema changes underneath
the wizard's example in a way that breaks it, this test fails loudly instead
of the wizard silently teaching users a wrong shape.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import pytest
from ai_asset_schemas.validator import SchemaType, validate

from .conftest import FIXTURES_ROOT

INDEX_PATH = FIXTURES_ROOT / "wizard-examples-index.json"

_SCHEMA_TYPE_BY_WIZARD_TYPE = {
    "agent": SchemaType.AGENT,
    "prompt": SchemaType.PROMPT,
    "mcp_tool": SchemaType.MCP_TOOL,
}


def _load_index() -> dict[str, dict[str, Any]]:
    with INDEX_PATH.open() as f:
        data = json.load(f)
    return {k: v for k, v in data.items() if not k.startswith("$")}


def _apply_wizard_transform(manifest: dict[str, Any]) -> dict[str, Any]:
    """Same transform as the route handler: fresh id, drop computed fields."""
    transformed = dict(manifest)
    transformed["id"] = str(uuid.uuid4())
    transformed.pop("manifest_hash", None)
    transformed.pop("created_at", None)
    return transformed


_INDEX = _load_index()


@pytest.mark.parametrize("wizard_type", sorted(_INDEX.keys()), ids=sorted(_INDEX.keys()))
def test_wizard_example_manifest_validates(wizard_type: str) -> None:
    entry = _INDEX[wizard_type]
    manifest_path = FIXTURES_ROOT / entry["manifest"]
    with manifest_path.open() as f:
        manifest = json.load(f)

    example = _apply_wizard_transform(manifest)

    schema_type = _SCHEMA_TYPE_BY_WIZARD_TYPE[wizard_type]
    validate(example, schema_type)  # must not raise


@pytest.mark.parametrize("wizard_type", sorted(_INDEX.keys()), ids=sorted(_INDEX.keys()))
def test_wizard_example_companion_files_exist(wizard_type: str) -> None:
    entry = _INDEX[wizard_type]
    for rel_path in entry["companionFiles"]:
        companion = FIXTURES_ROOT / rel_path
        assert companion.is_file(), f"missing companion file for {wizard_type}: {rel_path}"
        assert companion.read_text().strip(), (
            f"companion file for {wizard_type} is empty: {rel_path}"
        )


def test_prompt_example_template_file_matches_companion() -> None:
    """The prompt example's `template.file` must name the file we offer for download."""
    entry = _INDEX["prompt"]
    manifest_path = FIXTURES_ROOT / entry["manifest"]
    with manifest_path.open() as f:
        manifest = json.load(f)

    expected_name = manifest["template"]["file"]
    companion_names = [Path(p).name for p in entry["companionFiles"]]
    assert expected_name in companion_names, (
        f"prompt example's template.file={expected_name!r} has no matching "
        f"companion file in {companion_names}"
    )
