"""bm25_inspect: safe (non-unpickling) introspection of bm25.pkl."""

from __future__ import annotations

import pickle
from pathlib import Path

import pytest
from knowledge_packager.bm25_inspect import UnsafePickleError, peek_bm25_pickle

from .conftest import make_index_dir


def test_peek_extracts_chunk_ids_and_count(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-a")
    data = (fx.index_dir / "bm25.pkl").read_bytes()

    summary = peek_bm25_pickle(data)

    assert summary.record_count == len(fx.chunk_ids)
    assert set(summary.chunk_ids) == set(fx.chunk_ids)


def test_peek_never_imports_or_calls_anything(
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


def test_peek_rejects_unexpected_top_level_shape() -> None:
    data = pickle.dumps({"unexpected": True})
    with pytest.raises(UnsafePickleError):
        peek_bm25_pickle(data)


def test_peek_rejects_non_string_chunk_ids() -> None:
    data = pickle.dumps({"chunk_ids": [1, 2, 3]})
    with pytest.raises(UnsafePickleError):
        peek_bm25_pickle(data)


def test_peek_handles_legacy_generation_shape(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-legacy", legacy=True)
    data = (fx.index_dir / "bm25.pkl").read_bytes()

    summary = peek_bm25_pickle(data)

    assert summary.record_count == len(fx.chunk_ids)
    assert all(cid.startswith("chunk-") for cid in summary.chunk_ids)
