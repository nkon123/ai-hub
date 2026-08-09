"""Verify that OpenAPI spec files are structurally valid."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from openapi_spec_validator import validate as validate_openapi
from openapi_spec_validator.readers import read_from_filename

from .conftest import API_DIR

_OPENAPI_FILES = [
    API_DIR / "portal-openapi.yaml",
    API_DIR / "local-runtime-api.yaml",
    API_DIR / "hosted-chat-api.yaml",
]


@pytest.mark.parametrize(
    "spec_path",
    _OPENAPI_FILES,
    ids=[p.name for p in _OPENAPI_FILES],
)
def test_openapi_spec_is_valid(spec_path: Path) -> None:
    """OpenAPI spec must be structurally valid per OAS 3.1."""
    assert spec_path.exists(), f"Spec file not found: {spec_path}"
    spec_dict, _ = read_from_filename(str(spec_path))
    validate_openapi(spec_dict)  # raises if invalid


def test_portal_openapi_has_required_paths() -> None:
    """Portal OpenAPI must define all required MVP paths."""
    spec_path = API_DIR / "portal-openapi.yaml"
    with spec_path.open() as f:
        spec = yaml.safe_load(f)

    paths = spec.get("paths", {})
    required = [
        "/health",
        "/api/v1/assets",
        "/api/v1/assets/{asset_id}",
        "/api/v1/services",
        "/api/v1/service-versions/{version_id}/validate",
        "/api/v1/service-versions/{version_id}/preview-sessions",
        "/api/v1/deployments",
        "/api/v1/deployments/{deployment_id}/publish",
        "/api/v1/distributions",
        "/api/v1/audit-events",
    ]
    for path in required:
        assert path in paths, f"Missing required path: {path}"


def test_hosted_chat_api_has_required_paths() -> None:
    """Hosted Chat API must define session and message endpoints."""
    spec_path = API_DIR / "hosted-chat-api.yaml"
    with spec_path.open() as f:
        spec = yaml.safe_load(f)

    paths = spec.get("paths", {})
    required = [
        "/chat-api/v1/chatbots/{slug}",
        "/chat-api/v1/sessions",
        "/chat-api/v1/sessions/{session_id}/messages",
    ]
    for path in required:
        assert path in paths, f"Missing required path: {path}"
