"""The seven §4.1 Package Assembler verification checks.

Every check here is written to be capable of failing on realistic corrupt
input — `tests/unit/knowledge_packager/test_verification.py` deliberately
corrupts each one independently and asserts the check catches it. This
module never trusts a `package-manifest.json`'s embedded "it passed before"
claim: `package-knowledge verify` calls the exact same functions the
`build` command uses, against whatever is physically on disk right now.

Order matches 04-knowledge-platform.md §4.1's bullet list:
  1. Manifest File List ↔ 실제 파일 일치
  2. Record 수 대사
  3. Child→Parent 참조 무결성
  4. Chunk ID ↔ Vector/BM25 Record ID 일치
  5. Profile 모델 Identity ↔ Build Identity 일치
  6. 금지 파일과 Secret Pattern 없음
  7. Checksum 생성 (recomputation / integrity, not just presence)

Corrected finding (2026-08-07, see open-decisions.md D-054): an earlier
version of this module excluded `index/chroma/**` from checks 1 (file
list) and 7 (checksum) entirely, on the theory that opening a Chroma
directory with a *new* `chromadb.PersistentClient` mutates
`chroma.sqlite3` bytes only once (a "first open of a copy" reconciliation)
and settles after that. That theory was tested directly — hashing the same
untouched package's `index/chroma/` tree across three consecutive
`package-knowledge verify` runs — and is false: Chroma rewrites bytes on
*every* open, indefinitely. Excluding the subtree from checksumming under
that reasoning meant a package whose vector index was tampered with in
transit passed `checksum_integrity` outright — precisely the property this
check exists to provide, for the bulk of a Knowledge Package's actual data.

The real fix lives in `knowledge_packager.index_reader.read_chroma_snapshot`:
every Chroma open (`build`'s own read and every `package-knowledge verify`
run) happens against a **throwaway copy** in a `tempfile.TemporaryDirectory`
that is discarded immediately after use, so the package's own
`index/chroma/**` bytes are never touched by this package's own
verification machinery and stay checksum-stable forever. With that in
place, `index/chroma/**` no longer needs (or gets) any special-casing here:
every file in the package — Chroma's sqlite file and every HNSW segment
file included — gets a manifest entry, a checksum, and full participation
in checks 1 and 7, exactly like every other file. Checks 2-4 still
independently re-read Chroma's live content via the `chromadb` API (through
the same throwaway-copy mechanism) rather than trust static bytes, so
tamper-detection for Chroma's logical content and its raw bytes are both
covered now, not just the former.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from knowledge_packager.checksums import sha256_bytes
from knowledge_packager.index_reader import ChromaSnapshot, IndexMeta
from knowledge_packager.models import CheckResult, VerificationReport
from knowledge_packager.policy import PackagePolicy
from knowledge_packager.scanner import scan_files

_EXEMPT_SELF_REFERENTIAL_FILES = frozenset({"package-manifest.json", "checksums.sha256"})
_MAX_LISTED = 20


@dataclass(frozen=True)
class VerificationInputs:
    knowledge_id: str
    index_meta: IndexMeta
    parents: dict[str, dict[str, Any]]
    chroma: ChromaSnapshot
    bm25_chunk_ids: list[str]
    bm25_record_count: int
    declared_files: dict[str, str]  # relative_path -> declared sha256
    actual_files: dict[str, bytes]  # relative_path -> bytes physically present
    policy: PackagePolicy
    indexing_profile_embedding_model_alias: str | None = None


def check_manifest_file_list(inputs: VerificationInputs) -> CheckResult:
    """Manifest ↔ disk file list, covering every file including
    `index/chroma/**` (see module docstring — Chroma is read through a
    throwaway copy now, so its bytes are checksum-stable and need no
    special-casing here)."""
    declared = set(inputs.declared_files)
    actual = {p for p in inputs.actual_files if p not in _EXEMPT_SELF_REFERENTIAL_FILES}
    missing = sorted(declared - actual)  # declared but not on disk
    unexpected = sorted(actual - declared)  # on disk but not declared
    passed = not missing and not unexpected
    if passed:
        message = f"Manifest에 선언된 {len(declared)}개 파일이 실제 파일과 정확히 일치합니다"
    else:
        message = (
            f"Manifest 파일 목록 불일치 — 누락 {len(missing)}건, 미선언 {len(unexpected)}건"
        )
    return CheckResult(
        name="manifest_file_list_consistency",
        passed=passed,
        message=message,
        details={
            "missing_from_disk": missing[:_MAX_LISTED],
            "unexpected_on_disk": unexpected[:_MAX_LISTED],
        },
    )


def check_record_count_reconciliation(inputs: VerificationInputs) -> CheckResult:
    meta = inputs.index_meta
    parent_count_actual = len(inputs.parents)
    chunk_counts = {
        "index_meta.chunk_count": meta.chunk_count,
        "chroma.count": inputs.chroma.count,
        "bm25.record_count": inputs.bm25_record_count,
    }
    parent_counts = {
        "index_meta.parent_count": meta.parent_count,
        "parents_json.count": parent_count_actual,
    }
    chunk_mismatch = len(set(chunk_counts.values())) > 1
    parent_mismatch = len(set(parent_counts.values())) > 1
    passed = not chunk_mismatch and not parent_mismatch
    if passed:
        message = (
            f"Record 수 일치 (chunk={meta.chunk_count}, parent={meta.parent_count}, "
            f"document={meta.document_count})"
        )
    else:
        message = "Record 수 불일치가 발견되었습니다 — details 참고"
    return CheckResult(
        name="record_count_reconciliation",
        passed=passed,
        message=message,
        details={"chunk_counts": chunk_counts, "parent_counts": parent_counts},
    )


def check_child_parent_referential_integrity(inputs: VerificationInputs) -> CheckResult:
    parent_ids = set(inputs.parents.keys())
    child_parent_ids = [m.get("parent_id") for m in inputs.chroma.metadatas if m.get("parent_id")]
    if not child_parent_ids:
        return CheckResult(
            name="child_parent_referential_integrity",
            passed=True,
            message=(
                "이 Knowledge는 Parent Store가 없는 청킹 전략(recursive/markdown)으로 "
                "보입니다 — 검사 대상 없음(SKIPPED)"
            ),
            details={"skipped": True},
        )
    missing = sorted({pid for pid in child_parent_ids if pid not in parent_ids})
    passed = not missing
    message = (
        "모든 Child의 parent_id가 parents.json에서 해석됩니다"
        if passed
        else f"parents.json에 없는 parent_id를 참조하는 Child가 {len(missing)}건 있습니다"
    )
    return CheckResult(
        name="child_parent_referential_integrity",
        passed=passed,
        message=message,
        details={"missing_parent_ids": missing[:_MAX_LISTED]},
    )


def check_chunk_id_consistency(inputs: VerificationInputs) -> CheckResult:
    vector_ids = set(inputs.chroma.ids)
    bm25_ids = set(inputs.bm25_chunk_ids)
    only_in_vector = sorted(vector_ids - bm25_ids)
    only_in_bm25 = sorted(bm25_ids - vector_ids)
    passed = not only_in_vector and not only_in_bm25
    message = (
        f"Vector/BM25 Chunk ID {len(vector_ids)}건이 정확히 일치합니다"
        if passed
        else (
            f"Vector/BM25 Chunk ID 불일치 — Vector에만 {len(only_in_vector)}건, "
            f"BM25에만 {len(only_in_bm25)}건"
        )
    )
    return CheckResult(
        name="chunk_id_vector_bm25_consistency",
        passed=passed,
        message=message,
        details={
            "only_in_vector": only_in_vector[:_MAX_LISTED],
            "only_in_bm25": only_in_bm25[:_MAX_LISTED],
        },
    )


def check_profile_model_identity(inputs: VerificationInputs) -> CheckResult:
    """Compares an Indexing Profile's declared `embedding_model_alias`
    against `index-meta.json`'s `embed_model`.

    PoC assumption (documented, not silently assumed — same pattern as
    D-034/D-053): there is no Office Profile Registry in this codebase that
    resolves an alias to a literal model id, so this check compares the
    alias string directly against the literal `embed_model` string. Callers
    that name their Indexing Profile's alias after the literal model id
    (the only convention this codebase currently has) get a real check;
    this is recorded as a known limitation, not fabricated as a full
    alias-resolution feature this package does not have.
    """
    if inputs.indexing_profile_embedding_model_alias is None:
        return CheckResult(
            name="profile_model_identity_check",
            passed=True,
            message="Indexing Profile이 제공되지 않아 검사를 건너뜁니다(SKIPPED)",
            details={"skipped": True},
        )
    alias = inputs.indexing_profile_embedding_model_alias
    embed_model = inputs.index_meta.embed_model
    passed = alias == embed_model
    message = (
        f"Indexing Profile의 embedding_model_alias({alias!r})가 Build의 "
        f"embed_model({embed_model!r})과 일치합니다"
        if passed
        else (
            f"Indexing Profile의 embedding_model_alias({alias!r})가 Build의 "
            f"embed_model({embed_model!r})과 다릅니다"
        )
    )
    return CheckResult(
        name="profile_model_identity_check",
        passed=passed,
        message=message,
        details={"profile_embedding_model_alias": alias, "build_embed_model": embed_model},
    )


def check_forbidden_files_and_secrets(inputs: VerificationInputs) -> CheckResult:
    findings = scan_files(inputs.actual_files, inputs.policy)
    fatal = [f for f in findings if f.severity == "FATAL"]
    warnings = [f for f in findings if f.severity == "WARNING"]
    passed = not fatal
    if not findings:
        message = "금지 파일/Secret 패턴이 발견되지 않았습니다"
    elif passed:
        message = f"WARNING 수준 findings {len(warnings)}건 (build를 막지 않음)"
    else:
        message = f"FATAL findings {len(fatal)}건 — 다음 파일을 확인하세요"
    return CheckResult(
        name="forbidden_files_and_secret_patterns",
        passed=passed,
        message=message,
        details={
            "fatal": [f.to_dict() for f in fatal[:_MAX_LISTED]],
            "warning": [f.to_dict() for f in warnings[:_MAX_LISTED]],
        },
    )


def check_checksum_integrity(inputs: VerificationInputs) -> CheckResult:
    """Recomputed sha256 vs the Manifest's declared value, for every
    declared file including `index/chroma/**` (see module docstring — a
    throwaway-copy read makes those bytes checksum-stable, so tampering
    with the vector index is caught exactly like tampering with anything
    else in the package)."""
    mismatched: list[str] = []
    unverifiable: list[str] = []
    checked = 0
    for relpath, declared_sha in inputs.declared_files.items():
        data = inputs.actual_files.get(relpath)
        if data is None:
            unverifiable.append(relpath)
            continue
        checked += 1
        if sha256_bytes(data) != declared_sha:
            mismatched.append(relpath)
    passed = not mismatched
    message = (
        f"{checked}개 파일의 Checksum이 Manifest와 일치합니다"
        if passed
        else f"Checksum이 일치하지 않는 파일 {len(mismatched)}건"
    )
    return CheckResult(
        name="checksum_integrity",
        passed=passed,
        message=message,
        details={
            "mismatched": mismatched[:_MAX_LISTED],
            "unverifiable_missing_from_disk": unverifiable[:_MAX_LISTED],
        },
    )


_ALL_CHECKS = (
    check_manifest_file_list,
    check_record_count_reconciliation,
    check_child_parent_referential_integrity,
    check_chunk_id_consistency,
    check_profile_model_identity,
    check_forbidden_files_and_secrets,
    check_checksum_integrity,
)


def run_all_checks(inputs: VerificationInputs) -> VerificationReport:
    return VerificationReport(checks=[check(inputs) for check in _ALL_CHECKS])
