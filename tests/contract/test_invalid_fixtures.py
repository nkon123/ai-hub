"""Verify that fixtures/invalid/* files are rejected by schema validation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from ai_asset_schemas.validator import (
    SchemaType,
    ValidationError,
    infer_schema_type,
    validate,
)

from .conftest import INVALID_DIR, collect_json_fixtures

# Map fixture directory names to expected schema types for precise rejection testing
_INVALID_SCHEMA_TYPE_MAP: dict[str, SchemaType] = {
    "missing-fields": SchemaType.ASSET,
    "invalid-version": SchemaType.KNOWLEDGE,
    "hash-mismatch": SchemaType.KNOWLEDGE,
    "knowledge-package-missing-counts": SchemaType.KNOWLEDGE_PACKAGE,
    "source-manifest-bad-owner": SchemaType.SOURCE_MANIFEST,
}


@pytest.mark.parametrize(
    "path",
    collect_json_fixtures(INVALID_DIR),
    ids=[str(p.relative_to(INVALID_DIR)) for p in collect_json_fixtures(INVALID_DIR)],
)
def test_invalid_fixture_fails_schema(path: Path) -> None:
    """Each invalid fixture must raise ValidationError."""
    with path.open() as f:
        manifest = json.load(f)

    parent_dir = path.parent.name
    schema_type = _INVALID_SCHEMA_TYPE_MAP.get(parent_dir)

    if schema_type is None:
        try:
            schema_type = infer_schema_type(manifest)
        except ValidationError:
            # Cannot infer — test that it at minimum fails validation of ASSET schema
            schema_type = SchemaType.ASSET

    with pytest.raises(ValidationError):
        validate(manifest, schema_type)
