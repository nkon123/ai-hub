"""Runtime Model registry reader — M02, open-decisions.md D-093.

Ollama-consumable models (GGUF weights + optional Modelfile) for
closed-network PCs are a "런타임 자산", deliberately NOT an Asset Registry
type (no review/approval version chain — see the schema's own docstring in
`packages/schemas/manifests/runtime-model-manifest.schema.json`). This
module is the read side only: registration is out-of-band in this PoC (an
operator places `<runtime_model_root>/<model_id>/manifest.json` plus the
GGUF file and optional Modelfile) — there is no write path here, and
therefore no HTTP request body ever becomes a filesystem path, satisfying
root CLAUDE.md's "사용자가 제공한 파일명으로 파일 경로를 만들지 않는다" by
construction rather than by scrubbing.

Path safety: `model_id` (and, once a manifest is loaded, its internal
`file_name`/`modelfile_name`) are validated against a narrow allow-list
pattern BEFORE any path join, and the resulting path is additionally
checked to stay contained under its expected parent directory (defence in
depth against '..'/symlink tricks even though the regex already forbids
'.'/'/'). Every resolver in this module returns `None` on any
invalid/out-of-bounds input — never raises for that case — so callers
uniformly treat "invalid" and "not found" the same way (fail closed,
mirrors `resolve_model_dir`'s docstring).
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

from portal_api.config import settings

logger = logging.getLogger(__name__)

# Mirrors runtime-model-manifest.schema.json's `model_id` pattern exactly —
# the two must not drift, since this is the enforcement side of that schema
# constraint for path construction specifically.
MODEL_ID_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$")
_SAFE_FILENAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,255}$")


@dataclass(frozen=True)
class RuntimeModelManifest:
    model_id: str
    display_name: str
    purpose: str
    version: str
    source_model: str | None
    description: str | None
    file_name: str
    file_size_bytes: int
    sha256: str
    has_modelfile: bool
    modelfile_name: str | None
    upload_status: str
    registered_at: str


def _model_root() -> Path:
    return Path(settings.runtime_model_root)


def resolve_model_dir(model_id: str) -> Path | None:
    """Safely resolve `model_id` to a directory under `runtime_model_root`.

    Returns None (never raises) for any invalid/out-of-bounds model_id —
    callers must treat that identically to "not registered".
    """
    if not MODEL_ID_PATTERN.match(model_id):
        return None
    root = _model_root().resolve()
    candidate = (root / model_id).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate


def _safe_join(model_dir: Path, filename: str) -> Path | None:
    if not _SAFE_FILENAME_PATTERN.match(filename):
        return None
    resolved_dir = model_dir.resolve()
    candidate = (resolved_dir / filename).resolve()
    try:
        candidate.relative_to(resolved_dir)
    except ValueError:
        return None
    return candidate


def load_manifest(model_id: str) -> RuntimeModelManifest | None:
    """Return the parsed manifest for `model_id`, or None if `model_id` is
    invalid, unregistered, or its manifest.json is missing/malformed/
    inconsistent with its own directory name.

    A malformed or inconsistent manifest.json is logged and treated the
    same as "not found" (fail closed) rather than surfacing a broken
    listing entry or a 500 for what is an out-of-band data problem an
    operator needs to fix directly on disk.
    """
    model_dir = resolve_model_dir(model_id)
    if model_dir is None or not model_dir.is_dir():
        return None
    manifest_path = model_dir / "manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        with manifest_path.open(encoding="utf-8") as f:
            data = json.load(f)
        if data.get("model_id") != model_id:
            logger.warning(
                "runtime_model.manifest_id_mismatch dir=%s manifest_model_id=%s",
                model_id,
                data.get("model_id"),
            )
            return None
        return RuntimeModelManifest(
            model_id=data["model_id"],
            display_name=data["display_name"],
            purpose=data["purpose"],
            version=data["version"],
            source_model=data.get("source_model"),
            description=data.get("description"),
            file_name=data["file_name"],
            file_size_bytes=data["file_size_bytes"],
            sha256=data["sha256"],
            has_modelfile=data["has_modelfile"],
            modelfile_name=data.get("modelfile_name"),
            upload_status=data["upload_status"],
            registered_at=data["registered_at"],
        )
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        logger.warning("runtime_model.manifest_invalid model_id=%s error=%s", model_id, exc)
        return None


def list_manifests() -> list[RuntimeModelManifest]:
    """Every registered runtime model, sorted by model_id. Skips (with a
    logged warning, via load_manifest) any directory whose manifest.json is
    missing or malformed rather than failing the whole listing."""
    root = _model_root()
    if not root.is_dir():
        return []
    manifests: list[RuntimeModelManifest] = []
    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        if not entry.is_dir():
            continue
        manifest = load_manifest(entry.name)
        if manifest is not None:
            manifests.append(manifest)
    return manifests


def resolve_model_file(manifest: RuntimeModelManifest) -> Path | None:
    """The GGUF weight file's actual path, or None if `file_name` is unsafe
    or escapes the model's own directory."""
    model_dir = resolve_model_dir(manifest.model_id)
    if model_dir is None:
        return None
    return _safe_join(model_dir, manifest.file_name)


def resolve_modelfile(manifest: RuntimeModelManifest) -> Path | None:
    """The Modelfile's actual path, or None if this model has no Modelfile
    (`has_modelfile=false`) or `modelfile_name` is unsafe/missing."""
    if not manifest.has_modelfile or not manifest.modelfile_name:
        return None
    model_dir = resolve_model_dir(manifest.model_id)
    if model_dir is None:
        return None
    return _safe_join(model_dir, manifest.modelfile_name)
