"""Three-axis Manifest diff — P06 버전 관리
(01-portal-and-distribution.md §2 P06: "이전 버전과 Manifest/Dependency/
Permission Diff").

The spec requires the diff to distinguish Manifest / Dependency / Permission
sections rather than one flat blob, so the UI never has to reimplement
diffing itself. This PoC has no persisted `Dependency` entity
(07-data-api-contracts.md §3.4) and no field-level permission model — the
Registry that would carry either is out of scope (open-decisions.md D-034) —
so the three-way split is an *operational definition* over known manifest
key names, applied identically regardless of asset type:

- Permission axis: keys that gate *who/what* may access or invoke this
  version — `classification` (common header), `access_control` (Knowledge:
  allowed_orgs/roles/sites), `permissions` (MCP Tool: allowed_roles/orgs).
- Dependency axis: keys that declare what this version depends on/requires
  — `indexing_profile_ref` (Knowledge → an Indexing Profile),
  `server_alias` (MCP Tool → an MCP server), `workflow`/`capabilities`
  (Agent → declared Knowledge/MCP/Prompt role requirements).
- Manifest axis: everything else (name, description, tags, source, ...).

Identity/version-bookkeeping keys (`id`, `schema_version`, `version`,
`manifest_hash`, `created_at`) are excluded from all three axes — comparing
them is never meaningful (they differ by construction between any two
versions).
"""

from __future__ import annotations

from typing import Any

_EXCLUDED_KEYS = frozenset({"id", "schema_version", "version", "manifest_hash", "created_at"})
_PERMISSION_KEYS = frozenset({"classification", "access_control", "permissions"})
_DEPENDENCY_KEYS = frozenset({"indexing_profile_ref", "server_alias", "workflow", "capabilities"})

_MISSING = object()

DiffSection = dict[str, list[dict[str, Any]]]


def _empty_section() -> DiffSection:
    return {"added": [], "removed": [], "changed": []}


def _classify(key: str) -> str:
    if key in _PERMISSION_KEYS:
        return "permission"
    if key in _DEPENDENCY_KEYS:
        return "dependency"
    return "manifest"


def compute_manifest_diff(base: dict[str, Any], target: dict[str, Any]) -> dict[str, DiffSection]:
    """`base` is the `against` (comparison baseline) version's manifest;
    `target` is the subject version's manifest. added/removed/changed are
    reported relative to base → target (an "added" key exists in `target`
    but not `base`)."""
    sections: dict[str, DiffSection] = {
        "manifest": _empty_section(),
        "dependency": _empty_section(),
        "permission": _empty_section(),
    }

    keys = (set(base) | set(target)) - _EXCLUDED_KEYS
    for key in sorted(keys):
        axis = _classify(key)
        base_value = base.get(key, _MISSING)
        target_value = target.get(key, _MISSING)
        if base_value is _MISSING:
            sections[axis]["added"].append({"key": key, "value": target_value})
        elif target_value is _MISSING:
            sections[axis]["removed"].append({"key": key, "value": base_value})
        elif base_value != target_value:
            sections[axis]["changed"].append({"key": key, "from": base_value, "to": target_value})

    return sections
