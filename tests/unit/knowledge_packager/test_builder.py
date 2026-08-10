"""builder: build() + verify() integration — the round trip a real
`package-knowledge build` / `package-knowledge verify` CLI invocation goes
through, entirely offline against tmp_path fixtures."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from knowledge_packager.builder import BuildError, build, verify
from knowledge_packager.models import NOT_RECORDED
from knowledge_packager.policy import load_policy

from .conftest import make_index_dir


def _tree_hash(root: Path) -> str:
    """Deterministic hash of every file's bytes under `root`, keyed by its
    path relative to `root` — used to prove a directory's bytes are
    unaffected by an operation (D-054's throwaway-copy fix)."""
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.is_file():
            digest.update(path.relative_to(root).as_posix().encode("utf-8"))
            digest.update(path.read_bytes())
    return digest.hexdigest()

_POLICY_PATH = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "packages"
    / "knowledge-packager"
    / "config"
    / "package-policy.yaml"
)


def _policy():
    return load_policy(_POLICY_PATH)


def test_build_rejects_out_dir_under_index_base(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knowledge_packager import settings as settings_module

    fake_index_base = tmp_path / "data" / "indexes"
    fake_index_base.mkdir(parents=True)
    monkeypatch.setattr(settings_module.settings, "index_base", fake_index_base)

    fx = make_index_dir(tmp_path / "source", "kid-guard")

    with pytest.raises(BuildError):
        build(
            index_dir=fx.index_dir,
            out_dir=fake_index_base / "kid-guard",
            policy=_policy(),
        )


def test_build_happy_path_produces_valid_package(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path / "source", "kid-build", absolute_source_path_prefix="source")
    out_dir = tmp_path / "out" / "pkg"

    result, warnings = build(index_dir=fx.index_dir, out_dir=out_dir, policy=_policy())

    assert warnings == []
    assert result.verification.passed, [c.to_dict() for c in result.verification.failed_checks]
    assert (out_dir / "package-manifest.json").is_file()
    assert (out_dir / "source-manifest.json").is_file()
    assert (out_dir / "checksums.sha256").is_file()
    assert (out_dir / "index" / "index-meta.json").is_file()
    assert (out_dir / "index" / "chroma").is_dir()

    manifest = json.loads((out_dir / "package-manifest.json").read_text(encoding="utf-8"))
    assert manifest["knowledge_asset_version_id"] == "kid-build"
    assert manifest["counts"]["chunk_count"] == len(fx.chunk_ids)
    # D-054: the default fixture format is bm25.json (non-executable) now —
    # see test_build_happy_path_with_legacy_pickle_bm25 for the legacy case.
    assert manifest["artifact_notes"]["bm25_pkl_is_pickle"] is False


def test_build_happy_path_with_legacy_pickle_bm25(tmp_path: Path) -> None:
    """A package built from an index not yet migrated by
    indexing-runtime's convert-bm25-format CLI still builds and verifies
    successfully — bm25.pkl is copied through as-is, never unpickled."""
    fx = make_index_dir(
        tmp_path / "source",
        "kid-build-legacy",
        absolute_source_path_prefix="source",
        bm25_format="pickle",
    )
    out_dir = tmp_path / "out" / "pkg"

    result, warnings = build(index_dir=fx.index_dir, out_dir=out_dir, policy=_policy())

    assert warnings == []
    assert result.verification.passed, [c.to_dict() for c in result.verification.failed_checks]
    assert (out_dir / "index" / "bm25.pkl").is_file()
    assert not (out_dir / "index" / "bm25.json").exists()
    assert result.manifest["artifact_notes"]["bm25_pkl_is_pickle"] is True


def test_build_legacy_generation_round_trip(tmp_path: Path) -> None:
    fx = make_index_dir(
        tmp_path / "source", "kid-legacy-build", legacy=True, absolute_source_path_prefix="source"
    )
    out_dir = tmp_path / "out"

    result, _ = build(index_dir=fx.index_dir, out_dir=out_dir, policy=_policy())

    assert result.verification.passed, [c.to_dict() for c in result.verification.failed_checks]
    assert result.manifest["chunking_strategy"] == "미기재"  # legacy meta has no chunking_strategy


def test_build_then_verify_round_trip_passes(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path / "source", "kid-roundtrip", absolute_source_path_prefix="source")
    out_dir = tmp_path / "out"
    build(index_dir=fx.index_dir, out_dir=out_dir, policy=_policy())

    report, warnings = verify(package_dir=out_dir, policy=_policy())

    assert warnings == []
    assert report.passed, [c.to_dict() for c in report.failed_checks]


def test_verify_detects_tampering_after_build(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path / "source", "kid-tamper", absolute_source_path_prefix="source")
    out_dir = tmp_path / "out"
    build(index_dir=fx.index_dir, out_dir=out_dir, policy=_policy())

    # Tamper with a packaged file AFTER build — verify must catch it
    # independently, without trusting the embedded verification block.
    (out_dir / "source-manifest.json").write_text("tampered!", encoding="utf-8")

    report, _ = verify(package_dir=out_dir, policy=_policy())

    assert not report.passed
    checksum_check = next(c for c in report.checks if c.name == "checksum_integrity")
    assert not checksum_check.passed
    assert "source-manifest.json" in checksum_check.details["mismatched"]


def test_verify_detects_extra_file_dropped_into_package(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path / "source", "kid-extra", absolute_source_path_prefix="source")
    out_dir = tmp_path / "out"
    build(index_dir=fx.index_dir, out_dir=out_dir, policy=_policy())

    (out_dir / "sneaky.json").write_text("{}", encoding="utf-8")

    report, _ = verify(package_dir=out_dir, policy=_policy())

    assert not report.passed
    file_list_check = next(c for c in report.checks if c.name == "manifest_file_list_consistency")
    assert not file_list_check.passed
    assert "sneaky.json" in file_list_check.details["unexpected_on_disk"]


def test_verify_detects_file_removed_from_package(tmp_path: Path) -> None:
    """A declared file missing from disk is an integrity-gate failure
    (`manifest_file_list_consistency`), caught BEFORE `verify()` ever tries
    to open/parse anything — it must be a graceful FAIL report, never a
    raised exception (this used to raise `IndexReadError` from
    `index_reader.read_parents` because content reads ran unconditionally;
    see the D-054-crash fix and `test_verify_detects_tampered_chroma_sqlite_
    byte` below for the sibling case)."""
    fx = make_index_dir(tmp_path / "source", "kid-missing", absolute_source_path_prefix="source")
    out_dir = tmp_path / "out"
    build(index_dir=fx.index_dir, out_dir=out_dir, policy=_policy())

    (out_dir / "index" / "parents.json").unlink()

    report, _ = verify(package_dir=out_dir, policy=_policy())  # must not raise

    assert not report.passed
    file_list_check = next(c for c in report.checks if c.name == "manifest_file_list_consistency")
    assert not file_list_check.passed
    assert "index/parents.json" in file_list_check.details["missing_from_disk"]
    # Content checks never ran — they needed the very file that is missing.
    profile_check = next(c for c in report.checks if c.name == "profile_model_identity_check")
    assert not profile_check.passed
    assert profile_check.details.get("not_run") is True


def test_build_without_relativization_reports_fatal_absolute_path_leak(tmp_path: Path) -> None:
    # default prefix is /Users/testbuilder/... (a real leak).
    fx = make_index_dir(tmp_path / "source", "kid-leak")
    out_dir = tmp_path / "out"

    result, _ = build(
        index_dir=fx.index_dir, out_dir=out_dir, policy=_policy(), relativize_source_paths=False
    )

    assert not result.verification.passed
    scanner_check = next(
        c for c in result.verification.checks if c.name == "forbidden_files_and_secret_patterns"
    )
    assert not scanner_check.passed
    fatal_patterns = {f["pattern_id"] for f in scanner_check.details["fatal"]}
    assert "absolute_path_unix_users" in fatal_patterns
    assert result.manifest["path_relativization_applied"] is False


def test_build_with_relativization_cleans_the_leak(tmp_path: Path) -> None:
    # default prefix is /Users/testbuilder/... (a real leak, cleaned below).
    # default bm25_format is "json" — D-054's whole point: this is now ALSO
    # fully relativized, unlike the legacy bm25.pkl case covered separately
    # below.
    fx = make_index_dir(tmp_path / "source", "kid-clean")
    out_dir = tmp_path / "out"

    result, _ = build(
        index_dir=fx.index_dir, out_dir=out_dir, policy=_policy(), relativize_source_paths=True
    )

    scanner_check = next(
        c for c in result.verification.checks if c.name == "forbidden_files_and_secret_patterns"
    )
    # No FATAL leak survives relativization: parents.json and bm25.json are
    # both genuinely clean; the residual leak in chroma.sqlite3 (Chroma's
    # embeddings_queue retains the original add() metadata even after
    # Collection.update() — see relativize.py module docstring) is
    # downgraded to WARNING by policy and does not fail the check.
    assert scanner_check.passed, scanner_check.details
    assert result.manifest["path_relativization_applied"] is True
    assert result.manifest["path_relativization_details"]["parents_rewritten"] == len(fx.parent_ids)
    assert result.manifest["path_relativization_details"]["chroma_rewritten"] == len(fx.chunk_ids)

    # D-054: bm25.json IS relativized now — the whole point of the fix.
    assert result.manifest["artifact_notes"]["bm25_pkl_relativized"] is True
    warning_findings = {
        (f["pattern_id"], f["relative_path"].rsplit("/", 1)[-1])
        for f in scanner_check.details["warning"]
    }
    assert ("absolute_path_unix_users", "chroma.sqlite3") in warning_findings
    # bm25.json and parents.json must both carry NO finding at all (fully clean).
    assert not any(
        f["relative_path"].endswith(("parents.json", "bm25.json"))
        for f in scanner_check.details["warning"]
    )
    bm25_document = json.loads((out_dir / "index" / "bm25.json").read_text(encoding="utf-8"))
    assert all(
        not m.get("source_path", "").startswith("/Users/")
        for m in bm25_document["chunk_metadata"]
    )


def test_build_with_relativization_legacy_pickle_bm25_is_not_relativized(tmp_path: Path) -> None:
    """A not-yet-migrated index still has the legacy bm25.pkl residual-leak
    behavior — relativization cannot touch it without unpickling."""
    fx = make_index_dir(tmp_path / "source", "kid-clean-legacy", bm25_format="pickle")
    out_dir = tmp_path / "out"

    result, _ = build(
        index_dir=fx.index_dir, out_dir=out_dir, policy=_policy(), relativize_source_paths=True
    )

    scanner_check = next(
        c for c in result.verification.checks if c.name == "forbidden_files_and_secret_patterns"
    )
    assert scanner_check.passed, scanner_check.details
    assert result.manifest["artifact_notes"]["bm25_pkl_relativized"] is False
    warning_findings = {
        (f["pattern_id"], f["relative_path"].rsplit("/", 1)[-1])
        for f in scanner_check.details["warning"]
    }
    assert ("absolute_path_unix_users", "bm25.pkl") in warning_findings
    assert ("absolute_path_unix_users", "chroma.sqlite3") in warning_findings


def test_build_with_asset_manifest_populates_owner_classification(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path / "source", "kid-asset", absolute_source_path_prefix="source")
    asset_manifest_path = tmp_path / "asset-manifest.json"
    asset_manifest_path.write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "id": "550e8400-e29b-41d4-a716-446655440099",
                "type": "knowledge",
                "name": "Sample Knowledge",
                "version": "1.0.0",
                "owner": {"org": "miracom", "team": "hr", "creator_id": "admin@miracom.com"},
                "classification": "INTERNAL",
                "source": {
                    "type": "portal_upload",
                    "documents": [
                        {
                            "path": "documents/x.md",
                            "mime_type": "text/markdown",
                            "sha256": (
                                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca4"
                                "95991b7852b855"
                            ),
                        }
                    ],
                },
                "indexing_profile_ref": {"name": "default", "version": "1.0.0"},
            }
        ),
        encoding="utf-8",
    )
    out_dir = tmp_path / "out"

    build(
        index_dir=fx.index_dir,
        out_dir=out_dir,
        policy=_policy(),
        asset_manifest_path=asset_manifest_path,
    )

    source_manifest = json.loads((out_dir / "source-manifest.json").read_text(encoding="utf-8"))
    for doc in source_manifest["documents"]:
        assert doc["owner"] == {"org": "miracom", "team": "hr", "creator_id": "admin@miracom.com"}
        assert doc["classification"] == "INTERNAL"
        # Fields never available from any input stay honestly 미기재.
        assert doc["source_version"] == NOT_RECORDED
        assert doc["license_or_usage_basis"] == NOT_RECORDED
        assert doc["parser_identity"] == NOT_RECORDED


def test_build_with_indexing_profile_alias_mismatch_fails_check(tmp_path: Path) -> None:
    fx = make_index_dir(tmp_path / "source", "kid-profile", absolute_source_path_prefix="source")
    profile_path = tmp_path / "indexing-profile.json"
    profile_path.write_text(
        json.dumps(
            {
                "name": "wrong-profile",
                "version": "1.0.0",
                "chunking_strategy": "parent_child",
                "embedding_model_alias": "totally-different-model",
            }
        ),
        encoding="utf-8",
    )
    out_dir = tmp_path / "out"

    result, warnings = build(
        index_dir=fx.index_dir,
        out_dir=out_dir,
        policy=_policy(),
        indexing_profile_path=profile_path,
    )

    assert warnings == []
    check = next(
        c for c in result.verification.checks if c.name == "profile_model_identity_check"
    )
    assert not check.passed
    assert not result.verification.passed


def test_build_writes_package_even_when_verification_fails(tmp_path: Path) -> None:
    """A failed §4.1 check must not silently prevent producing a package to
    inspect — same precedent as evaluation_runner writing its result file
    even when the Quality Gate fails."""
    fx = make_index_dir(tmp_path / "source", "kid-inspect")  # leaks absolute paths -> FATAL
    out_dir = tmp_path / "out"

    result, _ = build(index_dir=fx.index_dir, out_dir=out_dir, policy=_policy())

    assert not result.verification.passed
    assert (out_dir / "package-manifest.json").is_file()


# --- D-054 correction: index/chroma/** is no longer excluded from
# manifest_file_list_consistency / checksum_integrity, because Chroma is now
# always read through a throwaway copy (index_reader.read_chroma_snapshot)
# instead of the package's own bytes. -------------------------------------


def test_build_declares_and_checksums_the_full_chroma_tree(tmp_path: Path) -> None:
    """Every physical file under index/chroma/** — the sqlite store and
    every HNSW segment file — must get a manifest entry and participate in
    both file-list and checksum verification. Before the fix, only 4 of the
    package's ~13 declarable files (everything outside index/chroma/) were
    ever actually checked by these two checks."""
    fx = make_index_dir(
        tmp_path / "source", "kid-full-chroma", absolute_source_path_prefix="source"
    )
    out_dir = tmp_path / "out"

    result, _ = build(index_dir=fx.index_dir, out_dir=out_dir, policy=_policy())

    assert result.verification.passed, [c.to_dict() for c in result.verification.failed_checks]

    chroma_files_on_disk = sorted(
        p.relative_to(out_dir).as_posix()
        for p in (out_dir / "index" / "chroma").rglob("*")
        if p.is_file()
    )
    assert len(chroma_files_on_disk) >= 1  # sqlite + at least one HNSW segment file
    declared_chroma_files = sorted(
        f["relative_path"]
        for f in result.manifest["files"]
        if f["relative_path"].startswith("index/chroma/")
    )
    assert declared_chroma_files == chroma_files_on_disk

    all_declarable_files = [
        p
        for p in out_dir.rglob("*")
        if p.is_file() and p.name not in {"package-manifest.json", "checksums.sha256"}
    ]
    file_list_check = next(
        c for c in result.verification.checks if c.name == "manifest_file_list_consistency"
    )
    checksum_check = next(c for c in result.verification.checks if c.name == "checksum_integrity")
    assert file_list_check.passed
    assert checksum_check.passed
    assert f"{len(all_declarable_files)}개 파일" in checksum_check.message
    # Sanity: this must be strictly more than the pre-fix count of 4
    # (index-meta.json, parents.json, bm25.pkl, source-manifest.json).
    assert len(all_declarable_files) > 4


_CONTENT_CHECK_NAMES_FOR_TEST = (
    "record_count_reconciliation",
    "child_parent_referential_integrity",
    "chunk_id_vector_bm25_consistency",
    "profile_model_identity_check",
    "forbidden_files_and_secret_patterns",
)


def test_verify_detects_tampered_chroma_sqlite_byte(tmp_path: Path) -> None:
    """The exact defect this task fixes, reproduced faithfully: ONE byte
    flipped at the MIDPOINT of a real chroma.sqlite3 — not a byte
    deliberately chosen inside a text payload to dodge SQLite's own
    on-disk structure. Before the fix, this flip landed inside SQLite's
    btree page structure often enough that opening the file via
    `chromadb.PersistentClient(...).get_collection(...).get()` raised
    `chromadb.errors.InternalError: ... database disk image is malformed`
    as an UNHANDLED exception out of `verify()` — a full Python traceback,
    leaking this repo's build-host absolute paths, instead of a reported
    integrity failure. Confirmed empirically (see this task's session
    notes) that this exact byte offset crashes chromadb on this fixture
    shape when opened directly, which is exactly why the fix must stop
    `verify()` from ever opening Chroma before checksum_integrity has
    already passed — not just widen what checksum_integrity happens to
    catch."""
    fx = make_index_dir(
        tmp_path / "source", "kid-sqlite-tamper", absolute_source_path_prefix="source"
    )
    out_dir = tmp_path / "out"
    build(index_dir=fx.index_dir, out_dir=out_dir, policy=_policy())

    sqlite_path = out_dir / "index" / "chroma" / "chroma.sqlite3"
    data = bytearray(sqlite_path.read_bytes())
    midpoint = len(data) // 2
    data[midpoint] ^= 0x01  # exact reproduction: XOR-flip one bit at the midpoint
    sqlite_path.write_bytes(bytes(data))

    report, _ = verify(package_dir=out_dir, policy=_policy())  # must NOT raise

    assert not report.passed
    checksum_check = next(c for c in report.checks if c.name == "checksum_integrity")
    assert not checksum_check.passed
    assert "index/chroma/chroma.sqlite3" in checksum_check.details["mismatched"]
    file_list_check = next(c for c in report.checks if c.name == "manifest_file_list_consistency")
    assert file_list_check.passed  # tamper changed bytes, not the file list

    # The integrity gate fired BEFORE Chroma was ever opened: none of the
    # five content checks ran — each is reported NOT_RUN, not a silent PASS
    # and not a fabricated FAIL.
    for name in _CONTENT_CHECK_NAMES_FOR_TEST:
        check = next(c for c in report.checks if c.name == name)
        assert not check.passed
        assert check.details.get("not_run") is True


def test_verify_detects_tampered_hnsw_segment_byte(tmp_path: Path) -> None:
    """Same defect, the other half: tampering with an HNSW `data_level0.bin`
    vector-graph segment file — not just the sqlite metadata store — must
    also fail checksum_integrity, without `verify()` raising, and the
    content checks must be reported NOT_RUN rather than silently passing."""
    fx = make_index_dir(
        tmp_path / "source", "kid-hnsw-tamper", absolute_source_path_prefix="source"
    )
    out_dir = tmp_path / "out"
    build(index_dir=fx.index_dir, out_dir=out_dir, policy=_policy())

    bin_path = next((out_dir / "index" / "chroma").glob("*/data_level0.bin"))
    data = bytearray(bin_path.read_bytes())
    data[len(data) // 2] ^= 0xFF
    bin_path.write_bytes(bytes(data))
    tampered_relpath = "index/chroma/" + bin_path.relative_to(
        out_dir / "index" / "chroma"
    ).as_posix()

    report, _ = verify(package_dir=out_dir, policy=_policy())  # must NOT raise

    assert not report.passed
    checksum_check = next(c for c in report.checks if c.name == "checksum_integrity")
    assert not checksum_check.passed
    assert tampered_relpath in checksum_check.details["mismatched"]
    for name in _CONTENT_CHECK_NAMES_FOR_TEST:
        check = next(c for c in report.checks if c.name == name)
        assert not check.passed
        assert check.details.get("not_run") is True


def test_verify_detects_truncated_chroma_sqlite(tmp_path: Path) -> None:
    """Third required reproduction: `chroma.sqlite3` truncated to half its
    size (a plausible transit-corruption failure mode, distinct from a
    single-bit flip) must also fail checksum_integrity gracefully, never
    raise, and never reach chromadb at all."""
    fx = make_index_dir(
        tmp_path / "source", "kid-sqlite-truncate", absolute_source_path_prefix="source"
    )
    out_dir = tmp_path / "out"
    build(index_dir=fx.index_dir, out_dir=out_dir, policy=_policy())

    sqlite_path = out_dir / "index" / "chroma" / "chroma.sqlite3"
    original_size = sqlite_path.stat().st_size
    with sqlite_path.open("r+b") as f:
        f.truncate(original_size // 2)

    report, _ = verify(package_dir=out_dir, policy=_policy())  # must NOT raise

    assert not report.passed
    checksum_check = next(c for c in report.checks if c.name == "checksum_integrity")
    assert not checksum_check.passed
    assert "index/chroma/chroma.sqlite3" in checksum_check.details["mismatched"]
    for name in _CONTENT_CHECK_NAMES_FOR_TEST:
        check = next(c for c in report.checks if c.name == name)
        assert not check.passed
        assert check.details.get("not_run") is True


def test_verify_content_read_failure_after_integrity_passes_is_a_reported_fail(
    tmp_path: Path,
) -> None:
    """Distinct from the integrity-gate-skip case above: if the bytes on
    disk ARE byte-for-byte what the Manifest declares (checksum_integrity
    passes) but the artifact still cannot be parsed/opened — e.g. bm25.json
    replaced with equal-length garbage that happens to still hash to a
    *different* stale declared value is not representable without breaking
    the checksum; instead we simulate the "well-formed bytes, malformed
    content" case directly: corrupt bm25.json AND re-declare its checksum in
    package-manifest.json so checksum_integrity still passes, matching what
    a legitimately-signed-but-buggy build could produce. This must surface
    as a real FAIL (content_check_error), not NOT_RUN and not a crash."""
    fx = make_index_dir(
        tmp_path / "source", "kid-bm25-malformed", absolute_source_path_prefix="source"
    )
    out_dir = tmp_path / "out"
    build(index_dir=fx.index_dir, out_dir=out_dir, policy=_policy())

    bm25_path = out_dir / "index" / "bm25.json"
    garbage = b"\xff" * len(bm25_path.read_bytes())  # same length, not valid JSON/UTF-8
    bm25_path.write_bytes(garbage)

    manifest_path = out_dir / "package-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for entry in manifest["files"]:
        if entry["relative_path"] == "index/bm25.json":
            entry["sha256"] = hashlib.sha256(garbage).hexdigest()
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    checksums_path = out_dir / "checksums.sha256"
    checksums = {e["relative_path"]: e["sha256"] for e in manifest["files"]}
    from knowledge_packager.checksums import render_checksums_file

    checksums_path.write_text(render_checksums_file(checksums), encoding="utf-8")

    report, _ = verify(package_dir=out_dir, policy=_policy())  # must NOT raise

    checksum_check = next(c for c in report.checks if c.name == "checksum_integrity")
    assert checksum_check.passed, checksum_check.details  # bytes match the (re-declared) hash
    assert not report.passed
    for name in _CONTENT_CHECK_NAMES_FOR_TEST:
        check = next(c for c in report.checks if c.name == name)
        assert not check.passed
        assert check.details.get("content_check_error") is True
        assert check.details.get("not_run") is not True  # attempted, not skipped


def test_verify_run_twice_is_idempotent_and_leaves_package_byte_identical(tmp_path: Path) -> None:
    """Reproduces the measurement behind this fix: repeated `verify()` calls
    must return the same result AND must never mutate the package's own
    bytes — the whole point of reading Chroma through a throwaway copy
    (index_reader.read_chroma_snapshot) instead of the package's own
    index/chroma/ directory."""
    fx = make_index_dir(
        tmp_path / "source", "kid-verify-twice", absolute_source_path_prefix="source"
    )
    out_dir = tmp_path / "out"
    build(index_dir=fx.index_dir, out_dir=out_dir, policy=_policy())

    hash_before = _tree_hash(out_dir)

    report1, warnings1 = verify(package_dir=out_dir, policy=_policy())
    hash_after_first = _tree_hash(out_dir)

    report2, warnings2 = verify(package_dir=out_dir, policy=_policy())
    hash_after_second = _tree_hash(out_dir)

    report3, warnings3 = verify(package_dir=out_dir, policy=_policy())
    hash_after_third = _tree_hash(out_dir)

    assert hash_before == hash_after_first == hash_after_second == hash_after_third
    assert report1.passed and report2.passed and report3.passed
    assert [c.to_dict() for c in report1.checks] == [c.to_dict() for c in report2.checks]
    assert [c.to_dict() for c in report2.checks] == [c.to_dict() for c in report3.checks]
    assert warnings1 == warnings2 == warnings3 == []
