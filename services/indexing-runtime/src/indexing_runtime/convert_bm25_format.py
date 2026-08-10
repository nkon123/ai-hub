"""`convert-bm25-format` — upgrade an existing index's `bm25.pkl` (a Python
pickle, executable content) to `bm25.json` (plain, non-executable JSON) in
place, without re-embedding (D-054, docs/implementation-spec/open-decisions.md).

Same spirit as the existing `stamp-classification` CLI in this package:
a local operator tool that migrates already-built `data/indexes/<id>/`
directories forward, run once per index, safe to re-run.

Why this matters: `services/distribution-service` zips an index directory
verbatim into every Offline Bundle it builds (`assets/knowledge/{asset_id}/
index/**`, see `distribution_service.bundler.collect`) — it does not go
through `packages/knowledge_packager` and does not transform `bm25.pkl` in
any way. Converting the *source* index directories under `data/indexes/` is
therefore what actually makes future bundles safe: once an index directory
has no `bm25.pkl` left, no bundle built from it can ship one either.

What this does, in order:
  1. If `bm25.json` already exists and `bm25.pkl` does not: nothing to do
     (idempotent no-op) — reported, not silently skipped.
  2. If both exist (a previous run was interrupted after writing the JSON
     but before removing the pickle): verify the JSON is well-formed and
     rebuilds correctly, then just remove the stale `bm25.pkl` — no
     re-extraction needed, the JSON is already authoritative.
  3. If only `bm25.pkl` exists (the normal case for an unconverted index):
     - `pickle.load` it. This is the ONE place in this migration path that
       still unpickles — justified by the same trust boundary
       `stamp_classification.py` already documents: an operator explicitly
       running this CLI against an index directory they control locally,
       not content received over a distribution channel (see
       `indexing_runtime.bm25_store.load_bm25_legacy_pickle`).
     - Extract `chunk_ids`/`chunk_texts`/`chunk_metadata` (already
       JSON-safe) and build `tokenized_corpus` from `chunk_texts` via the
       same tokenizer `pipeline.py` always used
       (`indexing_runtime.bm25_store.tokenize` — whitespace split, D-012).
     - Self-verify BEFORE writing anything or deleting the original:
       rebuild a fresh `BM25Okapi` from `tokenized_corpus` and confirm its
       `get_scores()` matches the ORIGINAL pickled `BM25Okapi` instance's
       `get_scores()` for a canary query (derived from the corpus itself,
       so this works on any index without hardcoding a domain-specific
       query). `BM25Okapi.__init__` is a pure function of its tokenized
       corpus (idf/doc_freqs/avgdl, no randomness), so this is expected to
       always match — the check exists to catch a bug in extraction, not
       because the algorithm is non-deterministic.
     - Write `bm25.json`, then re-read it back and re-verify the SAME
       canary scores one more time (write -> read -> compare) before ever
       deleting `bm25.pkl`. Only then is `bm25.pkl` removed.

Never deletes `bm25.pkl` unless both verification passes succeed — an
interrupted or failed conversion always leaves a still-loadable index (the
original pickle) rather than a corrupted one.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import click

from indexing_runtime.bm25_store import (
    BM25_JSON_FILENAME,
    BM25_PICKLE_FILENAME,
    Bm25FormatError,
    build_bm25_document,
    load_bm25_json,
    load_bm25_legacy_pickle,
    rebuild_bm25,
    tokenize,
    write_bm25_document,
)


class ConvertBm25FormatError(Exception):
    """Raised for any precondition or verification failure. Deliberately
    never deletes `bm25.pkl` when this is raised after extraction has
    started — see module docstring."""


@dataclass(frozen=True)
class ConversionResult:
    index_dir: Path
    action: str  # "already_converted" | "cleaned_stale_pickle" | "converted"
    chunk_count: int
    legacy_pickle_removed: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "index_dir": str(self.index_dir),
            "action": self.action,
            "chunk_count": self.chunk_count,
            "legacy_pickle_removed": self.legacy_pickle_removed,
        }


def _canary_query(chunk_texts: list[str]) -> list[str]:
    """A deterministic, corpus-derived query used only to sanity-check that
    the rebuilt BM25Okapi scores agree with the original — not a real
    search. Uses the first few tokens of the first non-empty chunk text so
    this works on any corpus without hardcoding domain content."""
    for text in chunk_texts:
        tokens = tokenize(text)
        if tokens:
            return tokens[:5]
    return []


def _scores_match(a: list[float], b: list[float]) -> bool:
    if len(a) != len(b):
        return False
    return all(abs(x - y) < 1e-9 for x, y in zip(a, b, strict=True))


def convert_index_bm25_format(index_dir: Path) -> ConversionResult:
    """Pure(ish) function — all I/O is local file reads/writes under
    `index_dir`. Raises `ConvertBm25FormatError` if `index_dir` has neither
    `bm25.json` nor `bm25.pkl`, or if self-verification fails (in which
    case `bm25.pkl`, if present, is left untouched)."""
    json_path = index_dir / BM25_JSON_FILENAME
    pkl_path = index_dir / BM25_PICKLE_FILENAME

    json_exists = json_path.is_file()
    pkl_exists = pkl_path.is_file()

    if not json_exists and not pkl_exists:
        raise ConvertBm25FormatError(
            f"{index_dir}에 {BM25_JSON_FILENAME}/{BM25_PICKLE_FILENAME} 둘 다 없습니다 "
            "— Knowledge Index 디렉터리가 맞는지 확인하세요."
        )

    if json_exists and not pkl_exists:
        try:
            document = load_bm25_json(json_path)
        except Bm25FormatError as exc:
            raise ConvertBm25FormatError(f"{json_path} 읽기 실패: {exc}") from exc
        return ConversionResult(
            index_dir=index_dir,
            action="already_converted",
            chunk_count=len(document.get("chunk_ids", [])),
            legacy_pickle_removed=False,
        )

    if json_exists and pkl_exists:
        # A previous run was interrupted after writing JSON but before
        # removing the stale pickle — the JSON is already authoritative
        # (it would not exist otherwise), so just verify it parses and
        # clean up the leftover pickle. No re-extraction needed.
        try:
            document = load_bm25_json(json_path)
        except Bm25FormatError as exc:
            raise ConvertBm25FormatError(
                f"{json_path}가 존재하지만 읽을 수 없어 안전하게 정리를 진행할 수 없습니다: {exc}"
            ) from exc
        pkl_path.unlink()
        return ConversionResult(
            index_dir=index_dir,
            action="cleaned_stale_pickle",
            chunk_count=len(document.get("chunk_ids", [])),
            legacy_pickle_removed=True,
        )

    # Only bm25.pkl exists — the normal migration case.
    legacy = load_bm25_legacy_pickle(pkl_path)
    try:
        chunk_ids = legacy["chunk_ids"]
        chunk_texts = legacy["chunk_texts"]
        chunk_metadata = legacy["chunk_metadata"]
        legacy_bm25 = legacy["bm25"]
    except KeyError as exc:
        raise ConvertBm25FormatError(f"{pkl_path}의 최상위 구조가 예상과 다릅니다: {exc}") from exc

    canary = _canary_query(chunk_texts)
    original_scores = list(legacy_bm25.get_scores(canary))

    document = build_bm25_document(chunk_ids, chunk_texts, chunk_metadata)
    rebuilt_bm25 = rebuild_bm25(document["tokenized_corpus"])
    rebuilt_scores = list(rebuilt_bm25.get_scores(canary))
    if not _scores_match(original_scores, rebuilt_scores):
        raise ConvertBm25FormatError(
            f"{pkl_path}: 재구성한 BM25 점수가 원본과 일치하지 않습니다 — "
            f"{BM25_PICKLE_FILENAME}를 그대로 두고 변환을 중단합니다."
        )

    write_bm25_document(json_path, document)

    # Write -> read -> compare, one more time, before ever deleting the
    # original pickle.
    reread_document = load_bm25_json(json_path)
    reread_bm25 = rebuild_bm25(reread_document["tokenized_corpus"])
    reread_scores = list(reread_bm25.get_scores(canary))
    if not _scores_match(original_scores, reread_scores):
        # Untrustworthy write — remove it so a retry starts fresh from the
        # still-present (never touched) bm25.pkl, rather than leaving behind
        # a bm25.json a later run might mistake for "already converted".
        json_path.unlink(missing_ok=True)
        raise ConvertBm25FormatError(
            f"{json_path}: 기록 후 다시 읽은 BM25 점수가 원본과 일치하지 않습니다 — "
            f"{BM25_PICKLE_FILENAME}를 그대로 두고 변환을 중단합니다."
        )

    pkl_path.unlink()

    return ConversionResult(
        index_dir=index_dir,
        action="converted",
        chunk_count=len(chunk_ids),
        legacy_pickle_removed=True,
    )


@click.command()
@click.argument("index_dir", type=click.Path(exists=True, file_okay=False, path_type=Path))
def main(index_dir: Path) -> None:
    """<index_dir>의 bm25.pkl(Python pickle)을 bm25.json(비실행 JSON)으로
    재임베딩 없이 제자리에서 변환한다 — D-054.

    <index_dir>은 하나의 Knowledge Index 디렉터리다(예:
    data/indexes/<AssetVersion id>), data/indexes/ 자체가 아니다.
    """
    try:
        result = convert_index_bm25_format(index_dir)
    except ConvertBm25FormatError as exc:
        raise click.ClickException(str(exc)) from exc
    click.echo(json.dumps(result.to_dict(), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
