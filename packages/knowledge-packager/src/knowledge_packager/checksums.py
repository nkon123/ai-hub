"""Checksum helpers (04-knowledge-platform.md §4.1 "Checksum 생성").

Same `checksums.sha256` line format as
`services/distribution-service/src/distribution_service/bundler.py`
(`"{sha256}  {relpath}"`, two spaces, sorted by path) — a package built here
may later be picked up and zipped by M03's Bundle Builder, so keeping the
on-disk checksum manifest format identical avoids yet another ad-hoc format
for the same idea (D-016: "Checksum 필수").
"""

from __future__ import annotations

import hashlib
from pathlib import Path


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def render_checksums_file(sha256_by_relative_path: dict[str, str]) -> str:
    lines = [f"{sha}  {relpath}" for relpath, sha in sorted(sha256_by_relative_path.items())]
    return "\n".join(lines) + "\n" if lines else ""


def parse_checksums_file(content: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in content.strip().splitlines():
        if not line.strip():
            continue
        sha, relpath = line.split("  ", 1)
        result[relpath] = sha
    return result
