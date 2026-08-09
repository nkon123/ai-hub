"""Read-only access to one `data/indexes/{AssetVersion id}/` directory
written by services/indexing-runtime (M07).

CLAUDE.md 구현 원칙 2 (모듈 간 내부 폴더 직접 Import 금지): this module
never imports `indexing_runtime`. It reads the same *on-disk artifacts*
that module writes — `index-meta.json`/`parents.json` as JSON, `chroma/` via
the `chromadb` client (an installed dependency, already used the same way
by services/search-runtime) — which is reading a file format, not a Python
package.

Two ID generations coexist in live data and both must load without
crashing:
  - new:    `<knowledge_id>:<doc>.md::p0000::<12hex>` (has `document_id` in
    parent metadata)
  - legacy: `chunk-<16hex>` (no `document_id` key in parent metadata)
"""

from __future__ import annotations

import json
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class IndexReadError(Exception):
    """Raised when a required index artifact is missing or malformed."""


@dataclass(frozen=True)
class IndexMeta:
    knowledge_id: str
    chunk_count: int
    parent_count: int
    document_count: int
    collection_name: str
    embed_model: str
    chunking_strategy: str | None  # None for pre-D-053 index dirs (legacy)


def read_index_meta(index_dir: Path) -> IndexMeta:
    path = index_dir / "index-meta.json"
    if not path.is_file():
        raise IndexReadError(f"index-meta.json이 없습니다: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise IndexReadError(f"index-meta.json 파싱 실패: {path}: {exc}") from exc
    try:
        return IndexMeta(
            knowledge_id=data["knowledge_id"],
            chunk_count=int(data["chunk_count"]),
            parent_count=int(data["parent_count"]),
            document_count=int(data["document_count"]),
            collection_name=data["collection_name"],
            embed_model=data["embed_model"],
            chunking_strategy=data.get("chunking_strategy"),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise IndexReadError(f"index-meta.json 필드가 예상과 다릅니다: {path}: {exc}") from exc


def read_parents(index_dir: Path) -> dict[str, dict[str, Any]]:
    """Returns the parents.json dict, keyed by parent id -> {id, text,
    metadata}. Empty dict is valid (recursive/markdown strategies have no
    Parent Store)."""
    path = index_dir / "parents.json"
    if not path.is_file():
        raise IndexReadError(f"parents.json이 없습니다: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise IndexReadError(f"parents.json 파싱 실패: {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise IndexReadError(f"parents.json 최상위가 object가 아닙니다: {path}")
    return data


@dataclass(frozen=True)
class ChromaSnapshot:
    ids: list[str]
    metadatas: list[dict[str, Any]]

    @property
    def count(self) -> int:
        return len(self.ids)

    def metadata_by_id(self) -> dict[str, dict[str, Any]]:
        return dict(zip(self.ids, self.metadatas, strict=True))


def read_chroma_snapshot(index_dir: Path, collection_name: str) -> ChromaSnapshot:
    """Read every child chunk id + metadata from the Chroma collection.

    Opens a **throwaway copy** of `index_dir/chroma`, never the directory
    itself: measured empirically (see open-decisions.md D-054, corrected
    2026-08-07), opening a Chroma directory with a new
    `chromadb.PersistentClient` — even for a pure read (`Collection.get()`,
    no writes) — rewrites bytes in `chroma.sqlite3` on *every single open*,
    indefinitely (not just once). An earlier version of this module's
    docstring claimed a second open of an already-opened copy was a no-op;
    that claim was tested directly (hashing the same untouched package's
    `index/chroma/` tree across three consecutive `package-knowledge verify`
    runs) and is false — each run produced a different hash. Reading through
    a `tempfile.TemporaryDirectory` copy that is discarded before this
    function returns means every caller (both `build`'s own read and every
    `package-knowledge verify` run) can inspect Chroma's live content
    without ever perturbing the package's on-disk bytes, so those bytes stay
    checksum-stable forever. Read-only with respect to `index_dir` itself:
    never called against `data/indexes/` with write intent by this module
    (callers that need to *rewrite* a copy's metadata — see
    `knowledge_packager.relativize` — open their own client against the
    package's own copy at build time, before checksumming, never against
    `data/indexes/` and never against this function's disposable copy)."""
    import chromadb  # local import: keep chromadb an implementation detail

    chroma_dir = index_dir / "chroma"
    if not chroma_dir.is_dir():
        raise IndexReadError(f"chroma/ 디렉터리가 없습니다: {chroma_dir}")
    with tempfile.TemporaryDirectory(prefix="knowledge-packager-chroma-read-") as tmp_dir:
        throwaway_chroma_dir = Path(tmp_dir) / "chroma"
        shutil.copytree(chroma_dir, throwaway_chroma_dir)
        client = chromadb.PersistentClient(path=str(throwaway_chroma_dir))
        try:
            collection = client.get_collection(collection_name)
        except Exception as exc:  # chromadb raises its own NotFoundError subtype
            raise IndexReadError(
                f"Chroma collection '{collection_name}'을 찾을 수 없습니다: {exc}"
            ) from exc
        result = collection.get(include=["metadatas"])
        return ChromaSnapshot(ids=list(result["ids"]), metadatas=list(result["metadatas"] or []))
