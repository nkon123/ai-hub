"""Non-executable BM25 index serialization (D-054,
docs/implementation-spec/open-decisions.md).

Before this module existed, `pipeline.py` wrote `bm25.pkl` via
`pickle.dump({"bm25": BM25Okapi(...), "chunk_ids": [...], "chunk_texts":
[...], "chunk_metadata": [...]}, f)`. A Python pickle is executable content
— `pickle.load` on a `bm25.pkl` from an untrusted source (e.g. an Offline
Bundle received from another machine) can execute arbitrary code via
GLOBAL/REDUCE/BUILD opcodes. Every Knowledge index this codebase ships is
distributed exactly that way (`services/distribution-service` zips the
index directory verbatim into `assets/knowledge/{asset_id}/index/**`), so
this was a real, not theoretical, exposure — see D-054 for the full finding
and `packages/knowledge_packager.bm25_inspect`'s pre-existing (and still
useful, for *legacy* files) opcode-walking mitigation.

The fix: `bm25.json` is a plain JSON file. It never stores a
`rank_bm25.BM25Okapi` instance — only the **tokenized corpus** plus the
plain `chunk_ids`/`chunk_texts`/`chunk_metadata` lists (all already
JSON-safe; `BM25Okapi` was the only non-JSON-serializable part of the old
pickle's top-level dict). `rebuild_bm25()` reconstructs an equivalent
`BM25Okapi` from `tokenized_corpus` at load time — deterministic, so scores
are byte-identical to what the original pickled object would have produced
(same algorithm, same inputs, no randomness in `BM25Okapi.__init__`).

`tokenized_corpus` is stored explicitly (not re-derived from `chunk_texts`
by every reader) so that a future change to how this codebase tokenizes text
(D-012: today a whitespace-split baseline, "형태소 분석기 도입" is an open
decision) cannot silently re-tokenize — and therefore silently re-score —
an index that was built under a different tokenization rule.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from rank_bm25 import BM25Okapi

BM25_JSON_FILENAME = "bm25.json"
BM25_PICKLE_FILENAME = "bm25.pkl"  # legacy — see convert_bm25_format.py / stamp_classification.py

_SCHEMA_VERSION = "1.0"
_TOKENIZER = "whitespace_split"


class Bm25FormatError(Exception):
    """Raised when a `bm25.json` file's shape does not match what this
    module writes — a deliberately narrow, honest failure rather than a
    best-effort guess at an unknown shape."""


def tokenize(text: str) -> list[str]:
    """The single tokenization rule this codebase uses for BM25 today
    (D-012 PoC baseline: whitespace split, no Korean morphological
    analyzer). Kept as one named function — rather than an inline
    `.split()` at every call site — so `pipeline.py`'s write path and
    `convert_bm25_format.py`'s legacy-corpus reconstruction are provably
    using the identical rule."""
    return text.split()


def build_bm25_document(
    chunk_ids: list[str],
    chunk_texts: list[str],
    chunk_metadata: list[dict[str, Any]],
) -> dict[str, Any]:
    """Assemble the JSON-safe document `write_bm25_json` persists —
    exposed separately so `convert_bm25_format.py` can build it once and
    both write it AND rebuild a `BM25Okapi` from it to self-verify before
    ever touching disk."""
    return {
        "schema_version": _SCHEMA_VERSION,
        "tokenizer": _TOKENIZER,
        "tokenized_corpus": [tokenize(t) for t in chunk_texts],
        "chunk_ids": chunk_ids,
        "chunk_texts": chunk_texts,
        "chunk_metadata": chunk_metadata,
    }


def write_bm25_json(
    path: Path,
    chunk_ids: list[str],
    chunk_texts: list[str],
    chunk_metadata: list[dict[str, Any]],
) -> None:
    document = build_bm25_document(chunk_ids, chunk_texts, chunk_metadata)
    path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")


def write_bm25_document(path: Path, document: dict[str, Any]) -> None:
    """Write an already-assembled document (e.g. one `convert_bm25_format`
    built from a legacy pickle) verbatim — no re-derivation."""
    path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")


def load_bm25_json(path: Path) -> dict[str, Any]:
    """Read+validate a `bm25.json` file's shape. Never touches `pickle` —
    this is a plain `json.loads`, which cannot execute code no matter what
    the file contains."""
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


def rebuild_bm25(tokenized_corpus: list[list[str]]) -> BM25Okapi:
    """Reconstruct a `BM25Okapi` from a tokenized corpus. Deterministic:
    `BM25Okapi.__init__` computes idf/doc_freqs/avgdl purely from its input,
    no randomness — so scores from a rebuilt instance are identical to the
    original pickled instance's scores for the same corpus (see this
    module's docstring and `tests/unit/indexing_runtime/test_bm25_store.py`
    for the round-trip proof)."""
    return BM25Okapi(tokenized_corpus)


def load_bm25_legacy_pickle(path: Path) -> dict[str, Any]:
    """`pickle.load` a legacy `bm25.pkl` — used ONLY by callers that have
    already established this is a **locally-built, trusted** index
    directory (the same trust boundary `stamp_classification.py` already
    documents: an operator running a CLI against an index directory they
    control, not content received over a distribution channel). NEVER call
    this on a file whose provenance might be an Offline Bundle
    import — see `services/search-runtime`'s `bm25_store.py` and
    `packages/knowledge_packager`'s `bm25_inspect.py` for the two other
    trust boundaries this codebase draws around the same file format.
    """
    import pickle  # local import: keep this hazardous call visibly opt-in

    with open(path, "rb") as f:
        return pickle.load(f)  # noqa: S301 — trusted-local, see docstring
