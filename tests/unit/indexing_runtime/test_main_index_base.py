"""INDEX_BASE default must be repo-root-relative, not hardcoded to any one
developer's machine (open-decisions.md D-073) — indexing-runtime used to
hardcode `/Users/victory/Dev/ai/miracom/enterprise-ai-asset-hub/data/indexes`
directly, which is wrong on every other machine (e.g. a Windows PC in the
closed network) unless the INDEX_BASE env var happens to be set. Sibling
services (`distribution_service.config`, `portal_api.config`) already derive
the same path from a `_REPO_ROOT` computed relative to the source file; this
guards indexing_runtime.main against regressing back to a hardcoded string."""

from __future__ import annotations

import inspect
from pathlib import Path

from indexing_runtime import main as indexing_main


def test_default_index_base_is_computed_not_a_hardcoded_literal():
    # On THIS machine the repo root legitimately lives under /Users/victory,
    # so the *resolved value* is expected to still contain that (see
    # test_default_index_base_resolves_under_repo_root below) — asserting on
    # the value alone can't tell "computed from _REPO_ROOT" apart from "still
    # a hardcoded literal that happens to match on this machine". Instead,
    # inspect the source: the assignment must derive from `_REPO_ROOT`
    # (a Path expression), not a quoted absolute path string constant like
    # the old `_DEFAULT_INDEX_BASE = "/Users/victory/.../data/indexes"` bug.
    source = inspect.getsource(indexing_main)
    assert "_REPO_ROOT" in source
    assert '"/Users/' not in source
    assert "'/Users/" not in source


def test_default_index_base_resolves_under_repo_root():
    repo_root = indexing_main._REPO_ROOT
    expected = repo_root / "data" / "indexes"

    assert Path(indexing_main._DEFAULT_INDEX_BASE) == expected
    # Sanity check that _REPO_ROOT itself actually landed on the repo root
    # (contains the top-level markers every checkout has), not some
    # intermediate directory reached by an off-by-one parent count.
    assert (repo_root / "services").is_dir()
    assert (repo_root / "apps").is_dir()
    assert (repo_root / "pyproject.toml").is_file()


def test_index_base_env_override_still_wins(monkeypatch):
    monkeypatch.setenv("INDEX_BASE", "/tmp/some-other-index-base")
    import importlib

    reloaded = importlib.reload(indexing_main)
    try:
        assert reloaded.INDEX_BASE == "/tmp/some-other-index-base"
    finally:
        # Restore the module to its env-less default for any test that runs
        # after this one and imports `indexing_runtime.main` expecting the
        # normal default (reload executes module-level code again).
        monkeypatch.delenv("INDEX_BASE", raising=False)
        importlib.reload(indexing_main)
