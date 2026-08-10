"""`stamp-classification` — upgrade an existing on-disk index in place.

Why this exists (open-decisions.md D-062): search-runtime's new ACL
enforcement (04-knowledge-platform.md §3.8) is fail-closed by default —
chunks whose `classification` metadata is missing/UNKNOWN are withheld from
every caller unless the deployment explicitly opts in
(`search_runtime.settings.ALLOW_UNKNOWN_CLASSIFICATION=true`). Every index
built before this feature (including the 4 published demo chatbots' indexes)
has no `classification` field at all in `index-meta.json` or its chunk
metadata, so under the fail-closed default they would start returning zero
citations the next time indexing-runtime/search-runtime restart with this
code — a real, deliberate regression, not a bug, and the alternative (making
UNKNOWN pass by default) is exactly the "silently allow it" outcome this
feature was built to avoid.

This CLI is the sanctioned way to migrate an existing index without
re-embedding: it patches `classification` into `index-meta.json` and every
chunk metadata record in `bm25.json`/`bm25.pkl` (search-runtime's actual
read path — see hybrid.py) and, best-effort, into the Chroma collection's
stored metadata for consistency. It is idempotent — running it twice with
the same `--classification` value is a no-op the second time; running it
again with a *different* value re-stamps everything (last write wins,
logged either way).

D-054 update: since indexing-runtime started writing `bm25.json` (a plain,
non-executable JSON file — see `bm25_store.py`) instead of `bm25.pkl`, this
command prefers `bm25.json` when present and never needs `pickle` for it.
An index directory not yet migrated (`bm25.pkl` only — run
`convert-bm25-format` first, or let this command fall back automatically)
is still supported via the legacy pickle path below, unchanged.

Trust boundary note: unlike `packages/knowledge-packager`'s deliberate
"never `pickle.load` an untrusted `bm25.pkl`" rule (D-054, that boundary is a
*distributed* package coming from outside the building), this CLI operates
on an index directory the operator already controls locally — the same
trust boundary indexing-runtime's own `pipeline.py` writer already assumes.
`pickle.load` (only reached for a not-yet-converted `bm25.pkl`) is used
here for exactly that reason — see `bm25_store.load_bm25_legacy_pickle`.

Usage:
    stamp-classification <index_dir> --classification INTERNAL

`<index_dir>` is one Knowledge index directory, e.g.
`data/indexes/<asset_version_id>` — the directory containing
`index-meta.json`/`bm25.pkl`/`chroma/`, NOT the `data/indexes/` parent.
`--classification` is required and must be a real level (PUBLIC_INTERNAL /
INTERNAL / CONFIDENTIAL / RESTRICTED) — the whole point of this feature is
never guessing, so the operator must assert a real value; `UNKNOWN` is
rejected as a `--classification` argument (that is the state this command
exists to remove, not to (re-)apply).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import click
from security_policy import Classification

from indexing_runtime.bm25_store import (
    BM25_JSON_FILENAME,
    BM25_PICKLE_FILENAME,
    load_bm25_json,
    load_bm25_legacy_pickle,
    write_bm25_document,
)

_REAL_LEVELS = [c.value for c in Classification if c is not Classification.UNKNOWN]


class StampClassificationError(Exception):
    """Raised for any precondition failure (bad index dir, bad value)."""


def stamp_index_classification(index_dir: Path, classification: str) -> dict[str, Any]:
    """Pure(ish) function — all I/O is local file reads/writes under
    `index_dir`, no network. Returns a summary dict for the CLI to print and
    for tests to assert against. Raises `StampClassificationError` if
    `index_dir` does not look like a valid index or `classification` is not
    one of the four real levels."""
    if classification not in _REAL_LEVELS:
        raise StampClassificationError(
            f"--classification must be one of {_REAL_LEVELS}, got {classification!r} "
            "(UNKNOWN is the state this command removes, not a valid target value)"
        )

    meta_path = index_dir / "index-meta.json"
    json_path = index_dir / BM25_JSON_FILENAME
    pkl_path = index_dir / BM25_PICKLE_FILENAME
    bm25_format = "json" if json_path.is_file() else "legacy_pickle" if pkl_path.is_file() else None
    if not meta_path.exists() or bm25_format is None:
        raise StampClassificationError(
            f"{index_dir} does not look like an index directory "
            f"(missing index-meta.json or {BM25_JSON_FILENAME}/{BM25_PICKLE_FILENAME})"
        )

    # 1. index-meta.json
    meta = json.loads(meta_path.read_text())
    previous = meta.get("classification")
    meta["classification"] = classification
    meta_path.write_text(json.dumps(meta, indent=2))

    # 2. bm25 chunk_metadata — this is what search-runtime's hybrid.py
    # actually reads at query time (not Chroma's stored metadata; see this
    # module's docstring). Prefers bm25.json (D-054: plain JSON, no pickle
    # ever touched); falls back to the legacy bm25.pkl path unchanged for an
    # index not yet migrated by `convert-bm25-format`.
    if bm25_format == "json":
        bm25_data = load_bm25_json(json_path)
        chunk_metadata: list[dict[str, Any]] = bm25_data.get("chunk_metadata", [])
        for entry in chunk_metadata:
            entry["classification"] = classification
        write_bm25_document(json_path, bm25_data)
    else:
        import pickle  # local import: legacy-only path, see module docstring

        bm25_data = load_bm25_legacy_pickle(pkl_path)
        chunk_metadata = bm25_data.get("chunk_metadata", [])
        for entry in chunk_metadata:
            entry["classification"] = classification
        with open(pkl_path, "wb") as f:
            pickle.dump(bm25_data, f)

    # 3. Chroma collection metadata — best-effort, for consistency with
    # anything that reads the vector store's own metadata directly (e.g. a
    # future package rebuild) rather than through search-runtime. Not fatal
    # if the collection is missing/unreadable; search-runtime's own ACL
    # enforcement does not depend on this succeeding.
    chroma_updated = 0
    chroma_dir = index_dir / "chroma"
    if chroma_dir.exists():
        try:
            # Shared cache, not a bare `chromadb.PersistentClient(...)`, for
            # consistency with pipeline.py/hybrid.py (D-067,
            # open-decisions.md) — this CLI is short-lived so a per-process
            # leak here is low-risk on its own, but a single leaked-client
            # pattern left in the codebase is an easy regression to
            # reintroduce elsewhere later. Local import: keep chromadb an
            # implementation detail of this module, same precedent as this
            # function's existing style.
            from indexing_runtime.chroma_client_cache import get_chroma_client

            client = get_chroma_client(chroma_dir)
            collection_name = f"knowledge_{index_dir.name.replace('-', '_')}"
            collection = client.get_collection(collection_name)
            existing = collection.get(include=["metadatas"])
            ids = existing["ids"]
            metadatas = existing["metadatas"] or []
            if ids:
                for m in metadatas:
                    m["classification"] = classification
                collection.update(ids=ids, metadatas=metadatas)
                chroma_updated = len(ids)
        except Exception as exc:  # noqa: BLE001 — best-effort, never fatal
            click.echo(f"경고: Chroma metadata 갱신을 건너뜁니다 ({exc})", err=True)

    return {
        "index_dir": str(index_dir),
        "previous_classification": previous,
        "classification": classification,
        "chunks_updated": len(chunk_metadata),
        "chroma_records_updated": chroma_updated,
    }


@click.command()
@click.argument("index_dir", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option(
    "--classification",
    required=True,
    type=click.Choice(_REAL_LEVELS),
    help="The real classification level to stamp (never UNKNOWN — see module docstring).",
)
def main(index_dir: Path, classification: str) -> None:
    """Stamp `classification` onto an existing index's metadata in place,
    without re-embedding — see module docstring for why this exists."""
    try:
        result = stamp_index_classification(index_dir, classification)
    except StampClassificationError as exc:
        raise click.ClickException(str(exc)) from exc
    click.echo(json.dumps(result, indent=2, ensure_ascii=False))
