"""Loader-level errors shared across `indexing_runtime.loaders` submodules.

Kept in its own module (rather than in `loaders/__init__.py`) so the
extended-format loaders (`pdf_loader.py`, `docx_loader.py`) can import it
without importing back from the package `__init__` that imports *them* —
avoids a circular import.
"""

from __future__ import annotations


class MissingLoaderDependencyError(RuntimeError):
    """Raised when a Loader's required optional dependency isn't installed.

    Carries an already-Korean, user-facing message so a missing `pypdf` /
    `python-docx` install surfaces at indexing time as an actionable
    sentence — not a bare `ModuleNotFoundError` traceback pointing at a
    library name most operators won't recognize. See
    docs/implementation-spec/13-windows-local-setup.md (폐쇄망 설치) and
    open-decisions.md D-073 for the 폐쇄망 install procedure. This error stays
    reachable on deployments that lack the packages; it is NOT reachable by
    simply running here — measured 2026-08-15, this development environment
    does have pypdf/python-docx installed, contradicting an older comment
    that claimed otherwise. Tests must force this path (monkeypatch) rather
    than relying on the environment to be missing them.
    """
