"""verification: each of the seven §4.1 checks, and — the actual point of
this suite — proof that each one CAN fail on realistically corrupted input,
not just pass on well-formed input."""

from __future__ import annotations

import dataclasses
from pathlib import Path

from knowledge_packager.checksums import sha256_bytes
from knowledge_packager.index_reader import read_chroma_snapshot, read_index_meta, read_parents
from knowledge_packager.policy import load_policy
from knowledge_packager.verification import VerificationInputs, run_all_checks

from .conftest import make_index_dir

_POLICY_PATH = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "packages"
    / "knowledge-packager"
    / "config"
    / "package-policy.yaml"
)


def _policy():
    return load_policy(_POLICY_PATH)


def _inputs_for(tmp_path: Path, **kwargs) -> tuple[VerificationInputs, dict]:
    """Builds a fully self-consistent VerificationInputs from a fresh
    fixture index dir, plus the raw fixture dict for tests to mutate."""
    fx = make_index_dir(tmp_path, kwargs.pop("knowledge_id", "kid"), **kwargs)
    index_meta = read_index_meta(fx.index_dir)
    parents = read_parents(fx.index_dir)
    chroma = read_chroma_snapshot(fx.index_dir, fx.collection_name)
    import pickle

    bm25_data = pickle.loads((fx.index_dir / "bm25.pkl").read_bytes())

    actual_files = {
        "index/index-meta.json": (fx.index_dir / "index-meta.json").read_bytes(),
        "index/parents.json": (fx.index_dir / "parents.json").read_bytes(),
        "index/bm25.pkl": (fx.index_dir / "bm25.pkl").read_bytes(),
    }
    declared_files = {k: sha256_bytes(v) for k, v in actual_files.items()}

    inputs = VerificationInputs(
        knowledge_id=index_meta.knowledge_id,
        index_meta=index_meta,
        parents=parents,
        chroma=chroma,
        bm25_chunk_ids=list(bm25_data["chunk_ids"]),
        bm25_record_count=len(bm25_data["chunk_ids"]),
        declared_files=declared_files,
        actual_files=actual_files,
        policy=_policy(),
    )
    return inputs, {"fixture": fx, "index_meta": index_meta, "parents": parents, "chroma": chroma}


def _find(report, name: str):
    return next(c for c in report.checks if c.name == name)


# --- happy path -------------------------------------------------------


def test_happy_path_all_checks_pass(tmp_path: Path) -> None:
    # A relative source_path prefix here represents an already-clean build
    # (post path-relativization) — the absolute-path leak itself is its own
    # dedicated, deliberately-failing test below.
    inputs, _ = _inputs_for(tmp_path, absolute_source_path_prefix="source")
    report = run_all_checks(inputs)
    assert report.passed, [c.to_dict() for c in report.failed_checks]


def test_happy_path_legacy_generation_all_checks_pass(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path, legacy=True, absolute_source_path_prefix="source")
    report = run_all_checks(inputs)
    assert report.passed, [c.to_dict() for c in report.failed_checks]


# --- 1. manifest file list consistency ---------------------------------


def test_manifest_file_list_fails_on_missing_declared_file(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)
    inputs.declared_files["index/extra-declared-only.json"] = "0" * 64

    report = run_all_checks(inputs)

    check = _find(report, "manifest_file_list_consistency")
    assert not check.passed
    assert "index/extra-declared-only.json" in check.details["missing_from_disk"]


def test_manifest_file_list_fails_on_unexpected_file_on_disk(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)
    inputs.actual_files["index/sneaky-undeclared.json"] = b"{}"

    report = run_all_checks(inputs)

    check = _find(report, "manifest_file_list_consistency")
    assert not check.passed
    assert "index/sneaky-undeclared.json" in check.details["unexpected_on_disk"]


# --- 2. record count reconciliation ------------------------------------


def test_record_count_fails_when_bm25_count_diverges(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)
    truncated_ids = inputs.bm25_chunk_ids[:-1]  # drop one record
    inputs = dataclasses.replace(
        inputs, bm25_chunk_ids=truncated_ids, bm25_record_count=len(truncated_ids)
    )

    report = run_all_checks(inputs)

    assert not _find(report, "record_count_reconciliation").passed


def test_record_count_fails_when_parents_json_diverges_from_meta(tmp_path: Path) -> None:
    inputs, ctx = _inputs_for(tmp_path)
    parents = dict(inputs.parents)
    first_key = next(iter(parents))
    del parents[first_key]
    inputs = dataclasses.replace(inputs, parents=parents)

    report = run_all_checks(inputs)

    assert not _find(report, "record_count_reconciliation").passed


# --- 3. child->parent referential integrity -----------------------------


def test_referential_integrity_fails_on_dangling_parent_id(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)
    metadatas = list(inputs.chroma.metadatas)
    metadatas[0] = dict(metadatas[0])
    metadatas[0]["parent_id"] = "does-not-exist-in-parents-json"
    new_chroma = inputs.chroma.__class__(ids=inputs.chroma.ids, metadatas=metadatas)
    inputs = dataclasses.replace(inputs, chroma=new_chroma)

    report = run_all_checks(inputs)

    check = _find(report, "child_parent_referential_integrity")
    assert not check.passed
    assert "does-not-exist-in-parents-json" in check.details["missing_parent_ids"]


def test_referential_integrity_skips_when_no_parent_store(tmp_path: Path) -> None:
    # recursive/markdown-style children never carry a parent_id key.
    inputs, _ = _inputs_for(tmp_path, chunking_strategy="recursive")
    report = run_all_checks(inputs)
    check = _find(report, "child_parent_referential_integrity")
    assert check.passed
    assert check.details.get("skipped") is True


# --- 4. chunk id <-> vector/bm25 consistency ------------------------------


def test_chunk_id_consistency_fails_when_vector_has_extra_id(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)
    ids = list(inputs.chroma.ids) + ["extra-vector-only-id"]
    metadatas = list(inputs.chroma.metadatas) + [{"chunk_type": "child"}]
    new_chroma = inputs.chroma.__class__(ids=ids, metadatas=metadatas)
    inputs = dataclasses.replace(inputs, chroma=new_chroma)

    report = run_all_checks(inputs)

    check = _find(report, "chunk_id_vector_bm25_consistency")
    assert not check.passed
    assert "extra-vector-only-id" in check.details["only_in_vector"]


def test_chunk_id_consistency_fails_when_bm25_has_extra_id(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)
    inputs = dataclasses.replace(
        inputs, bm25_chunk_ids=[*inputs.bm25_chunk_ids, "extra-bm25-only-id"]
    )

    report = run_all_checks(inputs)

    check = _find(report, "chunk_id_vector_bm25_consistency")
    assert not check.passed
    assert "extra-bm25-only-id" in check.details["only_in_bm25"]


# --- 5. profile model identity ------------------------------------------


def test_profile_model_identity_skipped_when_no_profile_given(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)
    check = _find(run_all_checks(inputs), "profile_model_identity_check")
    assert check.passed
    assert check.details.get("skipped") is True


def test_profile_model_identity_passes_on_matching_alias(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)
    inputs = dataclasses.replace(
        inputs, indexing_profile_embedding_model_alias=inputs.index_meta.embed_model
    )
    assert _find(run_all_checks(inputs), "profile_model_identity_check").passed


def test_profile_model_identity_fails_on_mismatched_alias(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)
    inputs = dataclasses.replace(
        inputs, indexing_profile_embedding_model_alias="some-other-model:1b"
    )

    report = run_all_checks(inputs)

    check = _find(report, "profile_model_identity_check")
    assert not check.passed
    assert check.details["profile_embedding_model_alias"] == "some-other-model:1b"


# --- 6. forbidden files / secret patterns --------------------------------


def test_forbidden_patterns_fails_on_absolute_path_leak(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)  # make_index_dir seeds /Users/... source_path by default

    report = run_all_checks(inputs)

    check = _find(report, "forbidden_files_and_secret_patterns")
    assert not check.passed
    assert any(f["pattern_id"] == "absolute_path_unix_users" for f in check.details["fatal"])


def test_forbidden_patterns_passes_when_paths_are_relative(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(
        tmp_path, absolute_source_path_prefix="source"  # not an absolute leak pattern
    )
    # Rewrite actual_files' parents.json bytes too so the scan sees the same
    # relative paths the fixture claims (make_index_dir always writes the
    # given prefix into both parents.json and Chroma consistently).
    report = run_all_checks(inputs)
    check = _find(report, "forbidden_files_and_secret_patterns")
    assert check.passed


# --- 7. checksum integrity ------------------------------------------------


def test_checksum_integrity_fails_on_tampered_file(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)
    inputs.actual_files["index/parents.json"] = b"tampered content, hash will not match"

    report = run_all_checks(inputs)

    check = _find(report, "checksum_integrity")
    assert not check.passed
    assert "index/parents.json" in check.details["mismatched"]


def test_checksum_integrity_passes_when_untampered(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)
    assert _find(run_all_checks(inputs), "checksum_integrity").passed


# --- index/chroma/** is fully covered, not excluded (D-054 correction,
# 2026-08-07: Chroma mutates its own bytes on every open, not just once, so
# the old exclusion is no longer needed once reads go through a throwaway
# copy — see verification.py / index_reader.py module docstrings) ---------


def test_manifest_file_list_fails_when_declared_chroma_file_is_missing(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)
    chroma_key = "index/chroma/chroma.sqlite3"
    chroma_bytes = b"pretend chroma.sqlite3 bytes"
    inputs.declared_files[chroma_key] = sha256_bytes(chroma_bytes)
    inputs.actual_files[chroma_key] = chroma_bytes
    # Sanity: this is a legitimate, passing declaration before we remove it.
    assert _find(run_all_checks(inputs), "manifest_file_list_consistency").passed

    del inputs.actual_files[chroma_key]

    report = run_all_checks(inputs)
    check = _find(report, "manifest_file_list_consistency")
    assert not check.passed
    assert chroma_key in check.details["missing_from_disk"]


def test_manifest_file_list_fails_on_undeclared_chroma_segment_file(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)
    sneaky_key = "index/chroma/deadbeef-0000-0000-0000-000000000000/data_level0.bin"
    inputs.actual_files[sneaky_key] = b"an undeclared segment file appeared on disk"

    report = run_all_checks(inputs)
    check = _find(report, "manifest_file_list_consistency")
    assert not check.passed
    assert sneaky_key in check.details["unexpected_on_disk"]


def test_checksum_integrity_fails_on_tampered_chroma_sqlite_bytes(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)
    chroma_key = "index/chroma/chroma.sqlite3"
    original_bytes = b"original chroma.sqlite3 bytes as recorded at build time"
    inputs.declared_files[chroma_key] = sha256_bytes(original_bytes)
    inputs.actual_files[chroma_key] = original_bytes
    # Sanity: this is a legitimate, passing declaration before tampering.
    assert _find(run_all_checks(inputs), "checksum_integrity").passed

    inputs.actual_files[chroma_key] = b"tampered chroma.sqlite3 bytes, hash will not match"

    report = run_all_checks(inputs)
    check = _find(report, "checksum_integrity")
    assert not check.passed
    assert chroma_key in check.details["mismatched"]


def test_checksum_integrity_fails_on_tampered_hnsw_segment_bytes(tmp_path: Path) -> None:
    inputs, _ = _inputs_for(tmp_path)
    hnsw_key = "index/chroma/56005ca6-29cb-4b16-8e51-e2f8717b98b3/data_level0.bin"
    original_bytes = b"\x00" * 64 + b"original HNSW vector graph bytes"
    inputs.declared_files[hnsw_key] = sha256_bytes(original_bytes)
    inputs.actual_files[hnsw_key] = original_bytes
    assert _find(run_all_checks(inputs), "checksum_integrity").passed

    tampered = bytearray(original_bytes)
    tampered[70] ^= 0xFF  # flip a single byte inside the "vector graph" payload
    inputs.actual_files[hnsw_key] = bytes(tampered)

    report = run_all_checks(inputs)
    check = _find(report, "checksum_integrity")
    assert not check.passed
    assert hnsw_key in check.details["mismatched"]
