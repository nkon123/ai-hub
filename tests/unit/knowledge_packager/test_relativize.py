"""relativize: rewriting build-host absolute source_path leaks on a
package's own copy of parents.json / Chroma metadata."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from knowledge_packager.index_reader import read_chroma_snapshot
from knowledge_packager.relativize import (
    looks_like_leaking_absolute_path,
    relativize_source_path,
    rewrite_chroma_metadata,
    rewrite_parents_json,
)
from knowledge_packager.source_manifest import relative_source_path_by_document_id

from .conftest import make_index_dir


def test_looks_like_leaking_absolute_path_detects_macos_and_linux() -> None:
    assert looks_like_leaking_absolute_path("/Users/victory/repo/doc.md")
    assert looks_like_leaking_absolute_path("/home/builder/repo/doc.md")
    assert looks_like_leaking_absolute_path(r"C:\Users\builder\repo\doc.md")


def test_looks_like_leaking_absolute_path_ignores_relative_and_safe_values() -> None:
    assert not looks_like_leaking_absolute_path("doc.md")
    assert not looks_like_leaking_absolute_path("source/doc.md")
    assert not looks_like_leaking_absolute_path("")
    assert not looks_like_leaking_absolute_path(None)
    assert not looks_like_leaking_absolute_path("/var/lib/something")  # not a /Users or /home path


def test_relativize_source_path_replaces_only_leaking_values() -> None:
    assert relativize_source_path("/Users/x/doc.md", "doc.md") == "doc.md"
    assert relativize_source_path("already/relative.md", "doc.md") == "already/relative.md"


def test_rewrite_parents_json_replaces_absolute_paths(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path / "orig", "kid-rel", num_docs=2, parents_per_doc=1)
    package_index = tmp_path / "package" / "index"
    package_index.mkdir(parents=True)
    shutil.copy2(fx.index_dir / "parents.json", package_index / "parents.json")

    from knowledge_packager.index_reader import read_parents

    original_parents = read_parents(fx.index_dir)
    for entry in original_parents.values():
        assert entry["metadata"]["source_path"].startswith("/Users/")

    relative_map = relative_source_path_by_document_id("kid-rel", original_parents)
    rewritten = rewrite_parents_json(package_index / "parents.json", "kid-rel", relative_map)

    assert rewritten == len(original_parents)
    updated = json.loads((package_index / "parents.json").read_text(encoding="utf-8"))
    for entry in updated.values():
        assert not entry["metadata"]["source_path"].startswith("/Users/")
        assert entry["metadata"]["source_path_relativized"] is True


def test_rewrite_parents_json_is_a_noop_on_already_relative_paths(tmp_path: Path) -> None:
    package_index = tmp_path / "package" / "index"
    package_index.mkdir(parents=True)
    data = {
        "p1": {
            "id": "p1",
            "text": "hi",
            "metadata": {"document_id": "kid:doc.md", "source_path": "doc.md"},
        }
    }
    (package_index / "parents.json").write_text(json.dumps(data), encoding="utf-8")

    rewritten = rewrite_parents_json(
        package_index / "parents.json", "kid", {"kid:doc.md": "doc.md"}
    )

    assert rewritten == 0


def test_rewrite_chroma_metadata_replaces_absolute_paths(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path / "orig", "kid-chroma-rel", num_docs=1, parents_per_doc=2)
    package_index = tmp_path / "package" / "index"
    package_index.mkdir(parents=True)
    shutil.copytree(fx.index_dir / "chroma", package_index / "chroma")

    from knowledge_packager.index_reader import read_parents

    original_parents = read_parents(fx.index_dir)
    relative_map = relative_source_path_by_document_id("kid-chroma-rel", original_parents)

    before = read_chroma_snapshot(package_index, fx.collection_name)
    assert all(m["source_path"].startswith("/Users/") for m in before.metadatas)

    changed = rewrite_chroma_metadata(
        package_index / "chroma", fx.collection_name, "kid-chroma-rel", relative_map
    )

    assert changed == len(fx.chunk_ids)
    after = read_chroma_snapshot(package_index, fx.collection_name)
    assert all(not m["source_path"].startswith("/Users/") for m in after.metadatas)
    assert all(m.get("source_path_relativized") is True for m in after.metadatas)
    # Embeddings/documents must be untouched — only metadata was updated.
    assert set(after.ids) == set(before.ids)


def test_rewrite_chroma_metadata_never_touches_original_index_dir(tmp_path: Path) -> None:
    """Guards the module's own safety claim: relativize functions must only
    ever be pointed at a package's copy. This test proves the ORIGINAL
    fixture dir is untouched after rewriting a separate copy."""
    fx = make_index_dir(tmp_path / "orig", "kid-guard", num_docs=1, parents_per_doc=1)
    copy_dir = tmp_path / "copy" / "index"
    copy_dir.mkdir(parents=True)
    shutil.copytree(fx.index_dir / "chroma", copy_dir / "chroma")

    from knowledge_packager.index_reader import read_parents

    original_parents = read_parents(fx.index_dir)
    relative_map = relative_source_path_by_document_id("kid-guard", original_parents)
    rewrite_chroma_metadata(copy_dir / "chroma", fx.collection_name, "kid-guard", relative_map)

    original_snapshot = read_chroma_snapshot(fx.index_dir, fx.collection_name)
    assert all(m["source_path"].startswith("/Users/") for m in original_snapshot.metadatas)
