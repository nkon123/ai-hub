"""Non-executable BM25 index reading (D-054,
docs/implementation-spec/open-decisions.md).

Duplicated (not imported) from `services/indexing-runtime`'s module of the
same name — CLAUDE.md 구현 원칙 2 (모듈 간 내부 폴더 직접 Import 금지)
already forced the same duplication for `chroma_client_cache.py` (D-067),
so this follows the established precedent rather than introducing a new
shared-internals dependency between M07 and M08.

`bm25.json` (written by `indexing_runtime.pipeline.run_pipeline`) is a plain
JSON file: a tokenized corpus plus `chunk_ids`/`chunk_texts`/
`chunk_metadata`. It never stores a `rank_bm25.BM25Okapi` instance, so
reading it (`json.loads`) cannot execute code no matter what the file
contains. `rebuild_bm25()` reconstructs an equivalent `BM25Okapi`
deterministically at query time — same algorithm, same inputs as whatever
built the original, so scores are unaffected by this change (see
`tests/unit/indexing_runtime/test_bm25_store.py`'s round-trip proof and
`tests/unit/search_runtime/test_bm25_store.py` here).

Trust boundary (the actual point of this module, distinct from
`indexing_runtime.bm25_store`'s "operator-controlled local index"
boundary): `search_runtime.settings.ALLOW_LEGACY_PICKLE_BM25` governs
whether this service may EVER fall back to `pickle.load`-ing a
not-yet-converted `bm25.pkl`. The documented, currently-only deployment
shape (`INDEX_BASE` = the central `data/indexes/` tree, written exclusively
by `services/indexing-runtime`) defaults this to allowed for backward
compatibility with indexes not yet migrated by `convert-bm25-format`. A
search-runtime instance serving an index tree that could contain content
installed from an Offline Bundle import (`services/distribution-service`
zips an index directory verbatim — see D-054's record for why that path is
NOT currently wired up to any live search-runtime instance in this
codebase) MUST set `SEARCH_ALLOW_LEGACY_PICKLE_BM25=false` — see
`settings.py` for the full reasoning.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from rank_bm25 import BM25Okapi

BM25_JSON_FILENAME = "bm25.json"
BM25_PICKLE_FILENAME = "bm25.pkl"


class Bm25FormatError(Exception):
    """Raised when a `bm25.json` file's shape does not match what
    `indexing_runtime.bm25_store.write_bm25_json` produces."""


class LegacyPickleBm25Refused(Exception):
    """Raised when only `bm25.pkl` exists for an index and
    `allow_legacy_pickle` is False — this service refuses to `pickle.load`
    it rather than silently either loading (a code-execution risk for
    untrusted content) or silently returning empty results (which would
    look identical to "no evidence" and mask a real, actionable refusal).
    Callers (see `main.py`) must surface this as a distinct error, not
    swallow it into a 0-citation response."""


def rebuild_bm25(tokenized_corpus: list[list[str]]) -> BM25Okapi:
    return BM25Okapi(tokenized_corpus)


def load_bm25_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise Bm25FormatError(f"bm25.json 파싱 실패: {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise Bm25FormatError(f"bm25.json 최상위가 object가 아닙니다: {path}")
    for key in ("tokenized_corpus", "chunk_ids", "chunk_texts", "chunk_metadata"):
        if key not in data:
            raise Bm25FormatError(f"bm25.json에 필수 필드 '{key}'가 없습니다: {path}")
    return data


def load_bm25_document(index_dir: Path, *, allow_legacy_pickle: bool) -> tuple[dict[str, Any], str]:
    """Returns `(document, source)` where `document` has
    `tokenized_corpus`/`chunk_ids`/`chunk_texts`/`chunk_metadata` (a plain
    dict — NOT a rebuilt `BM25Okapi`; `hybrid.py` calls `rebuild_bm25`
    separately so tests can monkeypatch that one step independently of file
    I/O, mirroring how `get_chroma_client` is already monkeypatched) and
    `source` is `"json"` or `"legacy_pickle"`.

    Raises `LegacyPickleBm25Refused` if only `bm25.pkl` exists and
    `allow_legacy_pickle` is False. Raises `FileNotFoundError` if neither
    file exists (callers should check existence first for the common
    "index not built yet" case — see `hybrid.hybrid_search`)."""
    json_path = index_dir / BM25_JSON_FILENAME
    pkl_path = index_dir / BM25_PICKLE_FILENAME

    if json_path.is_file():
        return load_bm25_json(json_path), "json"

    if pkl_path.is_file():
        if not allow_legacy_pickle:
            raise LegacyPickleBm25Refused(
                f"{pkl_path}는 아직 {BM25_JSON_FILENAME}로 변환되지 않았고, 이 배포는 "
                "legacy pickle 로딩을 허용하지 않습니다"
                "(SEARCH_ALLOW_LEGACY_PICKLE_BM25=false) — indexing-runtime의 "
                "convert-bm25-format CLI로 먼저 변환하세요."
            )
        import pickle  # local import: legacy-only, trusted-local path

        with open(pkl_path, "rb") as f:
            raw = pickle.load(f)  # noqa: S301 — gated by allow_legacy_pickle, see module docstring
        chunk_texts = raw["chunk_texts"]
        document = {
            "chunk_ids": raw["chunk_ids"],
            "chunk_texts": chunk_texts,
            "chunk_metadata": raw["chunk_metadata"],
            # Legacy pickles never stored a tokenized corpus explicitly —
            # reconstruct it the same way `indexing_runtime.pipeline`
            # always built it (`indexing_runtime.bm25_store.tokenize`:
            # whitespace split, D-012). The pickled `BM25Okapi` object
            # itself is intentionally discarded here, never returned — see
            # `rebuild_bm25`, which both the json and legacy_pickle paths
            # feed through identically so scoring code has one path, not
            # two, past this function.
            "tokenized_corpus": [text.split() for text in chunk_texts],
        }
        return document, "legacy_pickle"

    raise FileNotFoundError(
        f"{BM25_JSON_FILENAME}/{BM25_PICKLE_FILENAME} 둘 다 없습니다: {index_dir}"
    )
