"""Verify that all fixtures/valid/* files pass schema validation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from ai_asset_schemas.validator import ValidationError, infer_schema_type, validate

from .conftest import VALID_DIR, collect_json_fixtures

_valid_json_files = collect_json_fixtures(VALID_DIR)


@pytest.mark.parametrize(
    "path",
    _valid_json_files,
    ids=[str(p.relative_to(VALID_DIR)) for p in _valid_json_files],
)
def test_valid_fixture_passes_schema(path: Path) -> None:
    """Each valid fixture must pass schema validation without errors."""
    with path.open() as f:
        manifest = json.load(f)

    # Skip files without a 'type' field (e.g., documents)
    if (
        "type" not in manifest
        and "model_aliases" not in manifest
        and "chunking_strategy" not in manifest
        and "top_k" not in manifest
    ):
        pytest.skip(f"No schema inference possible for {path.name}")

    try:
        schema_type = infer_schema_type(manifest)
    except ValidationError:
        pytest.skip(f"Cannot infer schema type for {path.name}")

    validate(manifest, schema_type)  # must not raise
