"""SemVer parsing/comparison for P06 새 버전 만들기
(01-portal-and-distribution.md §2 P06: "Version 입력과 SemVer 가이드").

Mirrors the `version` field pattern in
`packages/schemas/manifests/asset-manifest.schema.json`
(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$`) — every manifest in this
project uses plain major.minor.patch with no pre-release/build metadata, so a
full SemVer 2.0 parser would be over-engineering; a compiled regex + tuple
comparison covers exactly what the schema allows.
"""

from __future__ import annotations

import re

_SEMVER_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


def parse_semver(version: str) -> tuple[int, int, int] | None:
    """Returns `None` if `version` doesn't match the schema's SemVer pattern."""
    match = _SEMVER_RE.match(version)
    if not match:
        return None
    major, minor, patch = (int(part) for part in match.groups())
    return (major, minor, patch)


def is_strictly_greater(candidate: str, baseline: str) -> bool | None:
    """Whether `candidate` > `baseline` as SemVer tuples.

    Returns `None` (not `False`) when either string fails to parse — callers
    must treat that as its own validation failure, not as "not greater than".
    """
    parsed_candidate = parse_semver(candidate)
    parsed_baseline = parse_semver(baseline)
    if parsed_candidate is None or parsed_baseline is None:
        return None
    return parsed_candidate > parsed_baseline
