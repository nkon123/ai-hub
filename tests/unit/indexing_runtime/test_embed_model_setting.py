"""EMBED_MODEL must be a real, env-overridable setting
(`indexing_runtime.settings.EMBED_MODEL` / `INDEXING_EMBED_MODEL`) that is
actually honored end to end by `pipeline.run_pipeline` — not just a setting
that exists while a hardcoded literal elsewhere still wins (the exact
`agent_runtime` CORS-setting-shadowed-by-a-literal mistake this codebase
already learned from once, see `search_runtime.settings.EMBED_MODEL`'s
docstring).

No Ollama/Chroma/live service is used — `embed_batch` and `chromadb` are
faked (see conftest.py), matching tests/unit/search_runtime's established
pattern. `patch_embed_batch` additionally records the `model` argument each
call received, which is what lets these tests prove the setting was
threaded all the way through rather than just asserting on `index-meta.json`
(a hardcoded literal could coincidentally produce the same recorded value).
"""

from __future__ import annotations

import importlib
import json

import pytest
from indexing_runtime import main as indexing_main
from indexing_runtime import pipeline, settings

from .conftest import patch_chroma, patch_embed_batch


async def _run(tmp_path, monkeypatch, *, embed_model: str | None = None) -> tuple[dict, list]:
    src = tmp_path / "source"
    src.mkdir()
    (src / "doc.md").write_text("# 제목\n\n본문 내용입니다.\n")

    patch_chroma(monkeypatch, pipeline)
    calls = patch_embed_batch(monkeypatch, pipeline)

    index_base = tmp_path / "indexes"
    kwargs = {} if embed_model is None else {"embed_model": embed_model}
    result = await pipeline.run_pipeline(
        storage_path=str(src),
        knowledge_id="22222222-2222-2222-2222-222222222222",
        index_base=str(index_base),
        **kwargs,
    )
    assert result["status"] == "COMPLETED", result
    index_dir = index_base / "22222222-2222-2222-2222-222222222222"
    meta = json.loads((index_dir / "index-meta.json").read_text())
    return meta, calls


@pytest.mark.asyncio
async def test_default_embed_model_matches_setting(tmp_path, monkeypatch) -> None:
    """With no explicit override, run_pipeline must use
    `indexing_runtime.settings.EMBED_MODEL` — not a separate hardcoded
    literal that happens to currently equal it."""
    meta, calls = await _run(tmp_path, monkeypatch)

    assert meta["embed_model"] == settings.EMBED_MODEL
    assert all(c["model"] == settings.EMBED_MODEL for c in calls)


@pytest.mark.asyncio
async def test_indexing_embed_model_env_var_changes_the_default(tmp_path, monkeypatch) -> None:
    """INDEXING_EMBED_MODEL must actually change which model a new indexing
    job uses (and what index-meta.json records) when the caller relies on
    the default rather than passing embed_model explicitly — proving the
    setting isn't shadowed by a hardcoded literal anywhere on this path
    (pipeline.run_pipeline's own default, specifically)."""
    monkeypatch.setenv("INDEXING_EMBED_MODEL", "custom-embedding-model:1b")
    reloaded_settings = importlib.reload(settings)
    reloaded_pipeline = importlib.reload(pipeline)
    try:
        assert reloaded_settings.EMBED_MODEL == "custom-embedding-model:1b"

        src = tmp_path / "source"
        src.mkdir()
        (src / "doc.md").write_text("# 제목\n\n본문 내용입니다.\n")

        patch_chroma(monkeypatch, reloaded_pipeline)
        calls = patch_embed_batch(monkeypatch, reloaded_pipeline)

        index_base = tmp_path / "indexes"
        result = await reloaded_pipeline.run_pipeline(
            storage_path=str(src),
            knowledge_id="33333333-3333-3333-3333-333333333333",
            index_base=str(index_base),
        )
        assert result["status"] == "COMPLETED", result

        index_dir = index_base / "33333333-3333-3333-3333-333333333333"
        meta = json.loads((index_dir / "index-meta.json").read_text())
        assert meta["embed_model"] == "custom-embedding-model:1b"
        assert all(c["model"] == "custom-embedding-model:1b" for c in calls)
    finally:
        monkeypatch.delenv("INDEXING_EMBED_MODEL", raising=False)
        importlib.reload(settings)
        importlib.reload(pipeline)


@pytest.mark.asyncio
async def test_explicit_embed_model_argument_still_overrides_setting(tmp_path, monkeypatch) -> None:
    """A caller (e.g. portal-api's job request) that passes embed_model
    explicitly must still be able to override the configured default —
    additive, not a replacement for the per-call parameter."""
    meta, calls = await _run(tmp_path, monkeypatch, embed_model="explicit-override:9b")

    assert meta["embed_model"] == "explicit-override:9b"
    assert all(c["model"] == "explicit-override:9b" for c in calls)


def test_index_job_request_default_matches_setting() -> None:
    """indexing_runtime.main's FastAPI request model must default to the
    setting, not a separately hardcoded literal that could drift from it."""
    req = indexing_main.IndexJobRequest(
        version_id="v1", storage_path="/tmp/x", job_id="job-1"
    )
    assert req.embed_model == settings.EMBED_MODEL


def test_cli_model_option_default_matches_setting() -> None:
    """The `--model` CLI option (indexing_runtime.main.main) must default to
    the setting too."""
    default = next(p for p in indexing_main.main.params if p.name == "model").default
    assert default == settings.EMBED_MODEL
