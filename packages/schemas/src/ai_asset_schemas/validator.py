"""Schema validation for AI Asset manifests and profiles."""

from __future__ import annotations

import json
from enum import StrEnum
from pathlib import Path

from jsonschema import Draft202012Validator

_SCHEMAS_DIR = Path(__file__).parent.parent.parent


class SchemaType(StrEnum):
    ASSET = "asset"
    KNOWLEDGE = "knowledge"
    AGENT = "agent"
    PROMPT = "prompt"
    MCP_TOOL = "mcp_tool"
    SERVICE = "service"
    INDEXING_PROFILE = "indexing_profile"
    RETRIEVAL_PROFILE = "retrieval_profile"
    OFFICE_PROFILE = "office_profile"
    EVALUATION_DATASET = "evaluation_dataset"
    EVALUATION_RESULT = "evaluation_result"
    KNOWLEDGE_PACKAGE = "knowledge_package"
    SOURCE_MANIFEST = "source_manifest"
    BUNDLE_INSTALL_POLICY = "bundle_install_policy"
    ASSET_UPLOAD_POLICY = "asset_upload_policy"
    RUNTIME_MODEL = "runtime_model"


_SCHEMA_PATHS: dict[SchemaType, Path] = {
    SchemaType.ASSET: _SCHEMAS_DIR / "manifests" / "asset-manifest.schema.json",
    SchemaType.KNOWLEDGE: _SCHEMAS_DIR / "manifests" / "knowledge-manifest.schema.json",
    SchemaType.AGENT: _SCHEMAS_DIR / "manifests" / "agent-manifest.schema.json",
    SchemaType.PROMPT: _SCHEMAS_DIR / "manifests" / "prompt-manifest.schema.json",
    SchemaType.MCP_TOOL: _SCHEMAS_DIR / "manifests" / "mcp-tool-manifest.schema.json",
    SchemaType.SERVICE: _SCHEMAS_DIR / "manifests" / "service-definition.schema.json",
    SchemaType.INDEXING_PROFILE: _SCHEMAS_DIR / "profiles" / "indexing-profile.schema.json",
    SchemaType.RETRIEVAL_PROFILE: _SCHEMAS_DIR / "profiles" / "retrieval-profile.schema.json",
    SchemaType.OFFICE_PROFILE: _SCHEMAS_DIR / "profiles" / "office-profile.schema.json",
    SchemaType.EVALUATION_DATASET: _SCHEMAS_DIR / "evaluation" / "evaluation-dataset.schema.json",
    SchemaType.EVALUATION_RESULT: _SCHEMAS_DIR / "evaluation" / "evaluation-result.schema.json",
    SchemaType.KNOWLEDGE_PACKAGE: _SCHEMAS_DIR / "knowledge" / "knowledge-package.schema.json",
    SchemaType.SOURCE_MANIFEST: _SCHEMAS_DIR / "knowledge" / "source-manifest.schema.json",
    SchemaType.BUNDLE_INSTALL_POLICY: (
        _SCHEMAS_DIR / "policies" / "bundle-install-policy.schema.json"
    ),
    SchemaType.ASSET_UPLOAD_POLICY: (
        _SCHEMAS_DIR / "policies" / "asset-upload-policy.schema.json"
    ),
    SchemaType.RUNTIME_MODEL: (
        _SCHEMAS_DIR / "manifests" / "runtime-model-manifest.schema.json"
    ),
}


class ValidationError(Exception):
    def __init__(self, message: str, errors: list[str] | None = None) -> None:
        super().__init__(message)
        self.errors = errors or []


def _load_schema(schema_type: SchemaType) -> dict:
    path = _SCHEMA_PATHS[schema_type]
    with path.open() as f:
        return json.load(f)


def validate(manifest: dict, schema_type: SchemaType) -> None:
    """Validate manifest against the given schema type.

    Raises ValidationError if invalid.
    """
    schema = _load_schema(schema_type)
    validator = Draft202012Validator(schema)
    errors = list(validator.iter_errors(manifest))
    if errors:
        messages = [e.message for e in errors]
        raise ValidationError(
            f"Schema validation failed for {schema_type.value}: {messages[0]}",
            errors=messages,
        )


def infer_schema_type(manifest: dict) -> SchemaType:
    """Infer schema type from manifest 'type' field."""
    asset_type = manifest.get("type", "")
    mapping = {
        "knowledge": SchemaType.KNOWLEDGE,
        "agent": SchemaType.AGENT,
        "prompt": SchemaType.PROMPT,
        "mcp_tool": SchemaType.MCP_TOOL,
        "service": SchemaType.SERVICE,
        "evaluation_dataset": SchemaType.EVALUATION_DATASET,
        "evaluation_result": SchemaType.EVALUATION_RESULT,
        "knowledge_package": SchemaType.KNOWLEDGE_PACKAGE,
        "source_manifest": SchemaType.SOURCE_MANIFEST,
        "runtime_model": SchemaType.RUNTIME_MODEL,
    }
    if asset_type in mapping:
        return mapping[asset_type]
    # Profile detection by schema structure
    if "chunking_strategy" in manifest:
        return SchemaType.INDEXING_PROFILE
    if "top_k" in manifest and "hybrid_alpha" in manifest:
        return SchemaType.RETRIEVAL_PROFILE
    if "model_aliases" in manifest:
        return SchemaType.OFFICE_PROFILE
    if "archive_extensions" in manifest and "size_caps" in manifest:
        return SchemaType.BUNDLE_INSTALL_POLICY
    if "max_single_file_bytes" in manifest and "rejected_extensions" in manifest:
        return SchemaType.ASSET_UPLOAD_POLICY
    if "model_id" in manifest and "sha256" in manifest and "upload_status" in manifest:
        return SchemaType.RUNTIME_MODEL
    raise ValidationError(f"Cannot infer schema type from manifest with type='{asset_type}'")


def validate_file(path: Path, schema_type: SchemaType | None = None) -> None:
    """Load a JSON file and validate it."""
    with path.open() as f:
        manifest = json.load(f)
    if schema_type is None:
        schema_type = infer_schema_type(manifest)
    validate(manifest, schema_type)
