"""source_manifest: §4.2 Source Manifest assembly, both ID generations, and
the "미기재" (NOT_RECORDED) discipline for fields the pipeline cannot
honestly populate today."""

from __future__ import annotations

from pathlib import Path

from knowledge_packager.index_reader import read_parents
from knowledge_packager.models import NOT_RECORDED
from knowledge_packager.source_manifest import (
    build_source_manifest,
    derive_document_id,
    relative_source_path_by_document_id,
)

from .conftest import make_index_dir


def test_new_generation_groups_by_native_document_id(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-new", num_docs=2, parents_per_doc=2)
    parents = read_parents(fx.index_dir)

    documents = build_source_manifest("kid-new", parents)

    assert {d.document_id for d in documents} == set(fx.document_ids)
    assert len(documents) == 2  # one entry per document, not per parent/chunk


def test_legacy_generation_derives_document_id_without_native_field(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-legacy", legacy=True, num_docs=2, parents_per_doc=2)
    parents = read_parents(fx.index_dir)
    for entry in parents.values():
        assert "document_id" not in entry["metadata"]  # legacy really lacks it

    documents = build_source_manifest("kid-legacy", parents)

    assert len(documents) == 2
    for doc in documents:
        assert doc.document_id.startswith("kid-legacy:")


def test_never_recorded_fields_stay_unfabricated(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-nr")
    parents = read_parents(fx.index_dir)

    documents = build_source_manifest("kid-nr", parents)

    for doc in documents:
        assert doc.source_version == NOT_RECORDED
        assert doc.license_or_usage_basis == NOT_RECORDED
        assert doc.effective_date == NOT_RECORDED
        assert doc.status == NOT_RECORDED
        assert doc.parser_identity == NOT_RECORDED
        # owner/classification default to NOT_RECORDED when no asset
        # manifest is supplied — never guessed.
        assert doc.owner == NOT_RECORDED
        assert doc.classification == NOT_RECORDED


def test_owner_and_classification_taken_from_caller_when_supplied(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-owner")
    parents = read_parents(fx.index_dir)
    owner = {"org": "miracom", "team": "hr", "creator_id": "admin@miracom.com"}

    documents = build_source_manifest("kid-owner", parents, owner=owner, classification="INTERNAL")

    assert all(d.owner == owner for d in documents)
    assert all(d.classification == "INTERNAL" for d in documents)


def test_source_hash_computed_when_original_file_exists_on_disk(tmp_path: Path) -> None:
    # Point source_path at a real file this test controls, instead of a
    # fabricated /Users/... path, so "best-effort hash of the real file"
    # is exercised honestly.
    real_source_dir = tmp_path / "real-source"
    real_source_dir.mkdir()
    real_file = real_source_dir / "doc0.md"
    real_file.write_text("hello world", encoding="utf-8")

    fx = make_index_dir(
        tmp_path / "idx", "kid-hash", num_docs=1, parents_per_doc=1,
        absolute_source_path_prefix=str(real_source_dir.parent),
    )
    # make_index_dir writes source_path as f"{prefix}/{knowledge_id}/1.0.0/{filename}";
    # rewrite parents.json to point at the real file we just created instead.
    import json

    parents_path = fx.index_dir / "parents.json"
    parents = json.loads(parents_path.read_text(encoding="utf-8"))
    for entry in parents.values():
        entry["metadata"]["source_path"] = str(real_file)
    parents_path.write_text(json.dumps(parents), encoding="utf-8")

    from knowledge_packager.index_reader import read_parents as _read_parents

    reloaded = _read_parents(fx.index_dir)
    documents = build_source_manifest("kid-hash", reloaded)

    import hashlib

    expected = hashlib.sha256(b"hello world").hexdigest()
    assert documents[0].source_hash == expected


def test_source_hash_not_recorded_when_source_file_missing(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-missing-source")
    # source_path points at a /Users/... path that does not exist.
    parents = read_parents(fx.index_dir)

    documents = build_source_manifest("kid-missing-source", parents)

    assert all(d.source_hash == NOT_RECORDED for d in documents)


def test_relative_source_path_by_document_id_matches_derive_document_id(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path, "kid-map", legacy=True)
    parents = read_parents(fx.index_dir)

    mapping = relative_source_path_by_document_id("kid-map", parents)

    for entry in parents.values():
        doc_id = derive_document_id("kid-map", entry["metadata"])
        assert doc_id in mapping
