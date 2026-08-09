"""Package Assembler orchestration (04-knowledge-platform.md §4.1).

`build()` assembles a Knowledge Package **directory** (not a ZIP — see
module docstring note below) from one `data/indexes/{AssetVersion id}/`
directory, then runs every §4.1 verification check against the artifacts it
just wrote. `verify()` re-runs the identical checks against an existing
package directory without trusting anything the package's own
`package-manifest.json` claims about itself.

Scope note (explicit, per task brief): this module produces a package
*directory* plus `package-manifest.json`/`source-manifest.json`/
`checksums.sha256` — it never calls `zipfile`. Transport bundling (ZIP
assembly, zip-slip/symlink hardening, the 0755/0644 permission fix) is
`services/distribution-service`'s job
(`distribution_service.bundler.build_zip_bytes`) and already exists there;
duplicating it here would violate CLAUDE.md's module-ownership table (M09
vs M03) for no benefit — a future `POST /bundle/v1/jobs` caller can zip a
Knowledge Package directory exactly the way it already zips everything else
under `assets/knowledge/{asset_id}/`.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ai_asset_schemas.validator import SchemaType, ValidationError, validate

from knowledge_packager import index_reader, relativize, source_manifest
from knowledge_packager.bm25_inspect import peek_bm25_pickle
from knowledge_packager.checksums import render_checksums_file, sha256_bytes
from knowledge_packager.index_reader import IndexReadError
from knowledge_packager.models import CheckResult, VerificationReport
from knowledge_packager.policy import PackagePolicy
from knowledge_packager.scanner import sanitize_text
from knowledge_packager.settings import settings
from knowledge_packager.verification import (
    VerificationInputs,
    check_checksum_integrity,
    check_child_parent_referential_integrity,
    check_chunk_id_consistency,
    check_forbidden_files_and_secrets,
    check_manifest_file_list,
    check_profile_model_identity,
    check_record_count_reconciliation,
    run_all_checks,
)

_INDEX_ARTIFACT_FILES = ("index-meta.json", "parents.json", "bm25.pkl")

# The five §4.1 checks that need parsed index content (Chroma opened via the
# `chromadb` API, `bm25.pkl` opcode-peeked, `index-meta.json`/`parents.json`
# JSON-parsed) — as opposed to `check_manifest_file_list`/
# `check_checksum_integrity`, which only ever touch raw bytes already on
# disk. See `verify()`'s docstring for why this split exists.
_CONTENT_CHECK_NAMES = (
    "record_count_reconciliation",
    "child_parent_referential_integrity",
    "chunk_id_vector_bm25_consistency",
    "profile_model_identity_check",
    "forbidden_files_and_secret_patterns",
)
_CONTENT_CHECK_FUNCS = (
    check_record_count_reconciliation,
    check_child_parent_referential_integrity,
    check_chunk_id_consistency,
    check_profile_model_identity,
    check_forbidden_files_and_secrets,
)


@dataclass(frozen=True)
class _IntegrityProbe:
    """Duck-typed stand-in for `VerificationInputs` carrying only the two
    attributes `check_manifest_file_list`/`check_checksum_integrity` ever
    read (`declared_files`/`actual_files`). Lets `verify()` run exactly
    those two checks before it has read anything beyond raw file bytes —
    long before any Chroma open, bm25 peek, or JSON parse is attempted."""

    declared_files: dict[str, str]
    actual_files: dict[str, bytes]


def _not_run_check(name: str, reason: str) -> CheckResult:
    """A content check that was never attempted because the integrity gate
    (checksum_integrity / manifest_file_list_consistency) failed first —
    distinct from both a silent PASS and a fabricated FAIL: the message and
    `details.not_run` make explicit that this check simply did not run."""
    return CheckResult(
        name=name,
        passed=False,
        message=f"실행되지 않음(NOT_RUN) — {reason}",
        details={"not_run": True, "reason": reason},
    )


def _content_check_read_error(name: str, reason: str) -> CheckResult:
    """A content check that WAS attempted (integrity had already passed)
    but could not run to completion because reading its required artifact
    raised — a malformed/truncated/corrupt file that is nonetheless
    byte-for-byte what the Manifest declared. A real, reported FAIL — never
    an unhandled exception out of `verify()`."""
    return CheckResult(
        name=name,
        passed=False,
        message=f"검사를 실행할 수 없습니다 — {reason}",
        details={"content_check_error": True, "reason": reason},
    )


class BuildError(Exception):
    """Raised for setup problems that make building meaningless (as
    distinct from a verification CHECK failing, which is still a completed
    build — see module docstring)."""


@dataclass(frozen=True)
class BuildResult:
    package_dir: Path
    manifest: dict[str, Any]
    verification: VerificationReport


def _reject_if_under_index_base(out_dir: Path) -> None:
    """Guard against ever writing (or rmtree-ing) into
    `data/indexes/` — that tree is strictly read-only source material for
    this package, never a build target (task instruction, and CLAUDE.md:
    승인 Version을 수정하는 코드를 만들지 않는다)."""
    resolved_out = out_dir.resolve()
    resolved_base = settings.index_base.resolve()
    if resolved_out == resolved_base or resolved_base in resolved_out.parents:
        raise BuildError(
            f"--out 경로가 data/indexes/ 아래를 가리킵니다 ({out_dir}) — 이 디렉터리는 "
            "읽기 전용이며 Package 출력 대상이 될 수 없습니다."
        )
    if resolved_out in resolved_base.parents or resolved_out == resolved_base.parent:
        raise BuildError(
            f"--out 경로가 data/indexes/의 상위입니다 ({out_dir}) — 실수로 index를 "
            "덮어쓸 수 있는 경로는 허용하지 않습니다."
        )


def _load_asset_manifest_owner_classification(
    path: Path | None,
) -> tuple[dict[str, Any] | str | None, str | None, list[str]]:
    warnings: list[str] = []
    if path is None:
        return None, None, warnings
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        warnings.append(f"--asset-manifest 읽기 실패({path}): {exc} — owner/classification 미사용")
        return None, None, warnings
    try:
        validate(data, SchemaType.KNOWLEDGE)
    except ValidationError as exc:
        warnings.append(
            f"--asset-manifest이 knowledge-manifest 스키마에 맞지 않습니다({path}): {exc} "
            "— owner/classification은 있는 필드만 참고합니다"
        )
    owner = data.get("owner")
    classification = data.get("classification")
    return owner, classification, warnings


def _load_indexing_profile_alias(path: Path | None) -> tuple[str | None, list[str]]:
    warnings: list[str] = []
    if path is None:
        return None, warnings
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        warnings.append(f"--indexing-profile 읽기 실패({path}): {exc} — Profile 검사를 건너뜁니다")
        return None, warnings
    try:
        validate(data, SchemaType.INDEXING_PROFILE)
    except ValidationError as exc:
        warnings.append(
            f"--indexing-profile이 indexing-profile 스키마에 맞지 않습니다({path}): {exc}"
        )
    alias = data.get("embedding_model_alias")
    if not isinstance(alias, str):
        warnings.append(f"--indexing-profile에 embedding_model_alias가 없습니다({path})")
        return None, warnings
    return alias, warnings


def _walk_files(base: Path) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    for path in sorted(base.rglob("*")):
        if path.is_file():
            relpath = path.relative_to(base).as_posix()
            result[relpath] = path.read_bytes()
    return result


def build(
    *,
    index_dir: Path,
    out_dir: Path,
    policy: PackagePolicy,
    asset_manifest_path: Path | None = None,
    indexing_profile_path: Path | None = None,
    evaluation_result_path: Path | None = None,
    relativize_source_paths: bool = False,
) -> tuple[BuildResult, list[str]]:
    """Assemble a Knowledge Package directory at `out_dir` from `index_dir`
    (a `data/indexes/{AssetVersion id}/` directory) and verify it. Returns
    `(BuildResult, warnings)` — `warnings` are non-fatal notices (e.g. an
    optional input file that didn't validate) the CLI should print."""
    warnings: list[str] = []
    _reject_if_under_index_base(out_dir)

    index_meta = index_reader.read_index_meta(index_dir)
    parents = index_reader.read_parents(index_dir)
    knowledge_id = index_meta.knowledge_id

    owner, classification, w = _load_asset_manifest_owner_classification(asset_manifest_path)
    warnings.extend(w)
    profile_alias, w = _load_indexing_profile_alias(indexing_profile_path)
    warnings.extend(w)

    # --- Assemble: copy index artifacts into the package's own index/ ---
    index_out = out_dir / "index"
    if index_out.exists():
        shutil.rmtree(index_out)
    index_out.mkdir(parents=True)
    for filename in _INDEX_ARTIFACT_FILES:
        src = index_dir / filename
        if src.is_file():
            shutil.copy2(src, index_out / filename)
    chroma_src = index_dir / "chroma"
    if chroma_src.is_dir():
        shutil.copytree(chroma_src, index_out / "chroma")

    relativized = relativize.RelativizeResult(parents_rewritten=0, chroma_rewritten=0)
    if relativize_source_paths:
        relative_map = source_manifest.relative_source_path_by_document_id(knowledge_id, parents)
        parents_rewritten = relativize.rewrite_parents_json(
            index_out / "parents.json", knowledge_id, relative_map
        )
        chroma_rewritten = 0
        if (index_out / "chroma").is_dir():
            chroma_rewritten = relativize.rewrite_chroma_metadata(
                index_out / "chroma", index_meta.collection_name, knowledge_id, relative_map
            )
        relativized = relativize.RelativizeResult(
            parents_rewritten=parents_rewritten, chroma_rewritten=chroma_rewritten
        )

    # --- Source Manifest (§4.2), derived from the pre-copy parents dict ---
    documents = source_manifest.build_source_manifest(knowledge_id, parents, owner, classification)
    source_manifest_doc = {
        "schema_version": "1.0",
        "type": "source_manifest",
        "knowledge_asset_version_id": knowledge_id,
        "documents": [d.to_dict() for d in documents],
    }
    try:
        validate(source_manifest_doc, SchemaType.SOURCE_MANIFEST)
    except ValidationError as exc:
        raise BuildError(
            f"내부 오류: 생성한 source-manifest.json이 스키마에 맞지 않습니다: {exc}"
        ) from exc
    (out_dir / "source-manifest.json").write_text(
        json.dumps(source_manifest_doc, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    evaluation_result_ref: str | None = None
    if evaluation_result_path is not None:
        eval_out_dir = out_dir / "evaluation"
        eval_out_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(evaluation_result_path, eval_out_dir / "evaluation-result.json")
        evaluation_result_ref = "evaluation/evaluation-result.json"

    # --- Re-read everything from the package's own copy for verification —
    # never trust the original data/indexes/ state for what we just wrote.
    #
    # Ordering no longer matters here (see index_reader.read_chroma_snapshot
    # and open-decisions.md D-054): that function opens Chroma against a
    # throwaway copy of index_out/chroma, so this read never touches the
    # package's own bytes. The manifest/checksums.sha256 hashes computed
    # below from `_walk_files(out_dir)` are therefore final and stable
    # regardless of whether this read happens before or after them.
    try:
        copied_index_meta = index_reader.read_index_meta(index_out)
        copied_parents = index_reader.read_parents(index_out)
        chroma_snapshot = index_reader.read_chroma_snapshot(
            index_out, copied_index_meta.collection_name
        )
        bm25_pkl_path = index_out / "bm25.pkl"
        bm25_bytes = bm25_pkl_path.read_bytes() if bm25_pkl_path.is_file() else b""
        bm25_summary = peek_bm25_pickle(bm25_bytes)
    except Exception as exc:
        # Never let a third-party read failure (chromadb, JSON, pickle
        # opcodes) escape as an unhandled exception/traceback — same
        # discipline as verify() below, applied here because build() reads
        # back its own freshly-written copy via the identical functions.
        raise BuildError(
            f"방금 조립한 Package 내용을 다시 읽는 중 오류가 발생했습니다: "
            f"{sanitize_text(str(exc), policy)}"
        ) from exc

    actual_files = _walk_files(out_dir)
    declared_files_sha256 = {relpath: sha256_bytes(data) for relpath, data in actual_files.items()}

    verification_inputs = VerificationInputs(
        knowledge_id=knowledge_id,
        index_meta=copied_index_meta,
        parents=copied_parents,
        chroma=chroma_snapshot,
        bm25_chunk_ids=bm25_summary.chunk_ids,
        bm25_record_count=bm25_summary.record_count,
        declared_files=declared_files_sha256,
        actual_files=actual_files,
        policy=policy,
        indexing_profile_embedding_model_alias=profile_alias,
    )
    report = run_all_checks(verification_inputs)

    files_entries = [
        {
            "relative_path": relpath,
            "sha256": sha,
            "size_bytes": len(actual_files[relpath]),
            "role": _classify_role(relpath),
        }
        for relpath, sha in sorted(declared_files_sha256.items())
    ]

    manifest = {
        "schema_version": "1.0",
        "type": "knowledge_package",
        "package_id": f"pkg-{knowledge_id}",
        "knowledge_asset_version_id": knowledge_id,
        "built_at": datetime.now(UTC).isoformat(),
        "chunking_strategy": copied_index_meta.chunking_strategy or "미기재",
        "embed_model": copied_index_meta.embed_model,
        "counts": {
            "chunk_count": copied_index_meta.chunk_count,
            "parent_count": copied_index_meta.parent_count,
            "document_count": copied_index_meta.document_count,
            "chroma_record_count": chroma_snapshot.count,
            "bm25_record_count": bm25_summary.record_count,
        },
        "files": files_entries,
        "artifact_notes": {
            "bm25_pkl_is_pickle": True,
            "bm25_pkl_relativized": False,
            "notes": (
                "bm25.pkl은 Python pickle입니다 — package-knowledge는 이를 절대 "
                "unpickle하지 않습니다(임의 코드 실행 위험, open-decisions.md D-054). "
                "이 파일에 내장된 source_path 절대경로는 path relativization 대상이 "
                "아니며(같은 이유), scanner가 이를 발견하면 정책의 "
                "residual_leak_severity_override 수준으로 보고됩니다. "
                "index/chroma/chroma.sqlite3도 동일한 수준으로 보고될 수 있습니다 — "
                "Chroma의 내부 embeddings_queue 테이블은 add/update를 모두 보존하는 "
                "append-only 로그이므로, relativization이 Collection.update()로 "
                "조회 결과는 정정하지만 원본 add() 시점의 절대경로 기록 자체는 파일에 "
                "물리적으로 남습니다(VACUUM으로도 제거되지 않음, D-054)."
            ),
        },
        "verification": report.to_dict(),
        "path_relativization_applied": relativize_source_paths,
        "path_relativization_details": {
            "parents_rewritten": relativized.parents_rewritten,
            "chroma_rewritten": relativized.chroma_rewritten,
        },
        "source_manifest_ref": "source-manifest.json",
        "evaluation_result_ref": evaluation_result_ref,
    }
    try:
        validate(manifest, SchemaType.KNOWLEDGE_PACKAGE)
    except ValidationError as exc:
        raise BuildError(
            f"내부 오류: 생성한 package-manifest.json이 스키마에 맞지 않습니다: {exc}"
        ) from exc

    (out_dir / "package-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (out_dir / "checksums.sha256").write_text(
        render_checksums_file(declared_files_sha256), encoding="utf-8"
    )

    return BuildResult(package_dir=out_dir, manifest=manifest, verification=report), warnings


def _classify_role(relative_path: str) -> str:
    if relative_path == "source-manifest.json":
        return "source_manifest"
    if relative_path.startswith("evaluation/"):
        return "evaluation"
    if relative_path.startswith("index/"):
        return "index"
    return "other"


def verify(
    *,
    package_dir: Path,
    policy: PackagePolicy,
    indexing_profile_path: Path | None = None,
) -> tuple[VerificationReport, list[str]]:
    """Independently re-verify an existing Knowledge Package directory —
    never assumes the package's own `package-manifest.json.verification`
    block (written by a possibly different, possibly untrusted `build` run)
    is accurate. A Knowledge Package may have traveled through an untrusted
    distribution channel before anyone runs `package-knowledge verify`
    against it, so this function treats every artifact on disk as
    potentially tampered with or corrupted — not just logically wrong.

    Two-phase, in this exact order (see open-decisions.md D-054's
    correction — this is the actual fix for the crash it describes):

    1. **Integrity gate** — `manifest_file_list_consistency` and
       `checksum_integrity`, using only raw bytes already read from disk and
       the Manifest's declared hashes. Nothing here opens Chroma, unpickles
       `bm25.pkl`, or JSON-parses `index-meta.json`/`parents.json`. If
       either check fails, this function stops: the on-disk bytes cannot be
       trusted, so it makes no sense (and is not safe) to hand them to
       chromadb/pickletools/json — the five remaining §4.1 checks are
       reported as NOT_RUN, each naming why, never as a silent PASS or a
       fabricated FAIL.
    2. **Content checks** — the remaining five checks, which DO need to
       open Chroma (via `index_reader.read_chroma_snapshot`), peek
       `bm25.pkl`'s opcodes, and parse `index-meta.json`/`parents.json`.
       Only reached once integrity has already passed. Still wrapped:
       byte-identical-to-declared is not the same guarantee as
       "chromadb/json/pickletools can successfully parse this" (e.g. a
       package built by a future/incompatible chromadb version) — any
       failure here becomes a reported FAIL with a sanitized message, never
       an unhandled exception.

    Concretely, this is what fixes the reported defect: a single tampered
    byte inside `index/chroma/chroma.sqlite3` almost always changes its
    sha256 (checksum_integrity fails in phase 1), so this function returns
    a clean FAIL report *before* it ever calls `chromadb`'s
    `collection.get()` — which is exactly the call that used to raise
    `chromadb.errors.InternalError: ... database disk image is malformed`
    as an unhandled exception, with a full Python traceback (leaking this
    repo's build-host absolute paths) reaching the CLI. The bare
    `except Exception` in phase 2 is a second, independent line of defense
    for the remaining case: bytes that are byte-for-byte what the Manifest
    declares yet still fail to open/parse for some other reason.
    """
    warnings: list[str] = []
    manifest_path = package_dir / "package-manifest.json"
    if not manifest_path.is_file():
        raise IndexReadError(f"package-manifest.json이 없습니다: {manifest_path}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        sanitized = sanitize_text(str(exc), policy)
        raise IndexReadError(
            f"package-manifest.json을 읽는 중 오류가 발생했습니다: {sanitized}"
        ) from exc

    try:
        actual_files = _walk_files(package_dir)
    except OSError as exc:
        raise IndexReadError(
            f"Package 파일을 읽는 중 오류가 발생했습니다: {sanitize_text(str(exc), policy)}"
        ) from exc
    declared_files_sha256 = {
        entry["relative_path"]: entry["sha256"] for entry in manifest.get("files", [])
    }

    # --- Phase 1: integrity gate (see docstring above). ---
    integrity_probe = _IntegrityProbe(
        declared_files=declared_files_sha256, actual_files=actual_files
    )
    file_list_check = check_manifest_file_list(integrity_probe)
    checksum_check = check_checksum_integrity(integrity_probe)

    if not (file_list_check.passed and checksum_check.passed):
        reason = (
            "무결성 검사(manifest_file_list_consistency / checksum_integrity)가 "
            "실패하여 Package 내용을 신뢰할 수 없습니다 — 이후 검사는 실행하지 않습니다"
        )
        not_run_checks = [_not_run_check(name, reason) for name in _CONTENT_CHECK_NAMES]
        report = VerificationReport(checks=[file_list_check, checksum_check, *not_run_checks])
        return report, warnings

    # --- Phase 2: content checks (see docstring above). ---
    index_dir = package_dir / "index"
    try:
        index_meta = index_reader.read_index_meta(index_dir)
        parents = index_reader.read_parents(index_dir)
        chroma_snapshot = index_reader.read_chroma_snapshot(index_dir, index_meta.collection_name)
        bm25_path = index_dir / "bm25.pkl"
        bm25_bytes = bm25_path.read_bytes() if bm25_path.is_file() else b""
        bm25_summary = peek_bm25_pickle(bm25_bytes)
    except Exception as exc:
        reason = f"Package 내용을 읽는 중 오류가 발생했습니다: {sanitize_text(str(exc), policy)}"
        failed_checks = [_content_check_read_error(name, reason) for name in _CONTENT_CHECK_NAMES]
        report = VerificationReport(checks=[file_list_check, checksum_check, *failed_checks])
        return report, warnings

    profile_alias, w = _load_indexing_profile_alias(indexing_profile_path)
    warnings.extend(w)

    inputs = VerificationInputs(
        knowledge_id=index_meta.knowledge_id,
        index_meta=index_meta,
        parents=parents,
        chroma=chroma_snapshot,
        bm25_chunk_ids=bm25_summary.chunk_ids,
        bm25_record_count=bm25_summary.record_count,
        declared_files=declared_files_sha256,
        actual_files=actual_files,
        policy=policy,
        indexing_profile_embedding_model_alias=profile_alias,
    )
    content_checks = [check(inputs) for check in _CONTENT_CHECK_FUNCS]
    report = VerificationReport(checks=[file_list_check, checksum_check, *content_checks])
    return report, warnings
