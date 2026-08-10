"""bm25_inspect: safe (non-unpickling) introspection of a Knowledge index's
BM25 artifact — bm25.json (current, D-054) and bm25.pkl (legacy fallback,
never unpickled)."""

from __future__ import annotations

import json
import pickle
from pathlib import Path

import pytest
from knowledge_packager.bm25_inspect import (
    UnsafePickleError,
    peek_bm25_artifact,
    peek_bm25_json,
    peek_bm25_pickle,
)

from .conftest import make_index_dir

# --- bm25.pkl (legacy) — unchanged behavior ---------------------------------


def test_peek_pickle_extracts_chunk_ids_and_count(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-a", bm25_format="pickle")
    data = (fx.index_dir / "bm25.pkl").read_bytes()

    summary = peek_bm25_pickle(data)

    assert summary.record_count == len(fx.chunk_ids)
    assert set(summary.chunk_ids) == set(fx.chunk_ids)


def test_peek_pickle_never_imports_or_calls_anything(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A pickle payload whose GLOBAL opcode names a module that does not
    exist must still be safely readable — proof that peek_bm25_pickle never
    actually imports it (a real `pickle.load` would raise ModuleNotFoundError)."""

    class _EvilOnLoad:
        def __reduce__(self):  # type: ignore[no-untyped-def]
            # If this were ever unpickled for real, __reduce__ would name a
            # callable to invoke. eval/exec stand in for "arbitrary code".
            return (eval, ("1 + 1",))

    payload = {
        "bm25": _EvilOnLoad(),
        "chunk_ids": ["a", "b"],
        "chunk_texts": ["x", "y"],
        "chunk_metadata": [{}, {}],
    }
    data = pickle.dumps(payload)

    # Sanity: a real pickle.load WOULD execute the reduce (proves the
    # fixture is a genuine test of the dangerous case, not a strawman).
    assert pickle.loads(data)["bm25"] == 2

    summary = peek_bm25_pickle(data)
    assert summary.chunk_ids == ["a", "b"]


def test_peek_pickle_rejects_unexpected_top_level_shape() -> None:
    data = pickle.dumps({"unexpected": True})
    with pytest.raises(UnsafePickleError):
        peek_bm25_pickle(data)


def test_peek_pickle_rejects_non_string_chunk_ids() -> None:
    data = pickle.dumps({"chunk_ids": [1, 2, 3]})
    with pytest.raises(UnsafePickleError):
        peek_bm25_pickle(data)


def test_peek_pickle_handles_legacy_generation_shape(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-legacy", legacy=True, bm25_format="pickle")
    data = (fx.index_dir / "bm25.pkl").read_bytes()

    summary = peek_bm25_pickle(data)

    assert summary.record_count == len(fx.chunk_ids)
    assert all(cid.startswith("chunk-") for cid in summary.chunk_ids)


# --- bm25.json (current, D-054) ---------------------------------------------


def test_peek_json_extracts_chunk_ids_and_count(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-json")
    data = (fx.index_dir / "bm25.json").read_bytes()

    summary = peek_bm25_json(data)

    assert summary.record_count == len(fx.chunk_ids)
    assert set(summary.chunk_ids) == set(fx.chunk_ids)


def test_peek_json_never_uses_pickle_module(tmp_path: Path) -> None:
    """Direct proof the json.json code path never touches pickle at all —
    a malformed byte string that would crash pickletools parses fine as
    long as it's valid JSON."""
    data = json.dumps({"chunk_ids": ["a", "b"]}).encode("utf-8")
    summary = peek_bm25_json(data)
    assert summary.chunk_ids == ["a", "b"]


def test_peek_json_rejects_unexpected_top_level_shape() -> None:
    data = json.dumps({"unexpected": True}).encode("utf-8")
    with pytest.raises(UnsafePickleError):
        peek_bm25_json(data)


def test_peek_json_rejects_non_string_chunk_ids() -> None:
    data = json.dumps({"chunk_ids": [1, 2, 3]}).encode("utf-8")
    with pytest.raises(UnsafePickleError):
        peek_bm25_json(data)


def test_peek_json_rejects_malformed_bytes() -> None:
    with pytest.raises(UnsafePickleError):
        peek_bm25_json(b"{not valid json")


# --- peek_bm25_artifact (format-resolving entry point) ----------------------


def test_artifact_prefers_json_when_only_json_present(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-only-json")

    summary, fmt = peek_bm25_artifact(fx.index_dir)

    assert fmt == "json"
    assert set(summary.chunk_ids) == set(fx.chunk_ids)


def test_artifact_falls_back_to_pickle_when_only_pickle_present(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-only-pickle", bm25_format="pickle")

    summary, fmt = peek_bm25_artifact(fx.index_dir)

    assert fmt == "pickle"
    assert set(summary.chunk_ids) == set(fx.chunk_ids)


def test_artifact_prefers_json_when_both_present(tmp_path: Path) -> None:
    """Mid-conversion state (indexing-runtime's convert-bm25-format wrote
    bm25.json but a stale bm25.pkl still exists) must read the JSON, never
    fall back to unpickling."""
    fx = make_index_dir(tmp_path, "kid-both")
    # A deliberately different stale pickle so a wrong-path bug is unambiguous.
    with open(fx.index_dir / "bm25.pkl", "wb") as f:
        pickle.dump({"chunk_ids": ["stale-only"]}, f)

    summary, fmt = peek_bm25_artifact(fx.index_dir)

    assert fmt == "json"
    assert "stale-only" not in summary.chunk_ids
    assert set(summary.chunk_ids) == set(fx.chunk_ids)


def test_artifact_raises_when_neither_present(tmp_path: Path) -> None:
    empty_dir = tmp_path / "empty-index"
    empty_dir.mkdir()

    with pytest.raises(UnsafePickleError):
        peek_bm25_artifact(empty_dir)
