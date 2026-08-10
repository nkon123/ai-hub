"""package-knowledge CLI — build/verify Knowledge Packages (M09).

Mirrors `evaluate-knowledge`'s style (click, PASS/FAIL text output,
non-zero exit code on failure) — see
`packages/evaluation-runner/src/evaluation_runner/cli.py`.
"""

from __future__ import annotations

import sys
from pathlib import Path

import click

from knowledge_packager.builder import BuildError, build, verify
from knowledge_packager.index_reader import IndexReadError
from knowledge_packager.models import VerificationReport
from knowledge_packager.policy import PackagePolicy, PackagePolicyError, load_policy
from knowledge_packager.scanner import sanitize_text
from knowledge_packager.settings import settings


def _fail(message: str, policy: PackagePolicy | None = None) -> None:
    """Print a FAIL line and exit non-zero — never a traceback. When a
    policy is available, the message is sanitized through the same
    redaction the package's own scanner uses, so an exception string from
    this process (including a third-party library's) can never leak a
    build-host absolute path into CLI output (see `builder.verify`
    docstring / open-decisions.md D-054)."""
    text = sanitize_text(message, policy) if policy is not None else message
    click.echo(f"FAIL: {text}", err=True)
    sys.exit(1)


def _print_report(report: VerificationReport) -> None:
    click.echo("")
    click.echo(f"검증 결과: {'PASS' if report.passed else 'FAIL'}")
    for check in report.checks:
        if check.details.get("not_run"):
            marker = "NOT_RUN"
        elif check.passed:
            marker = "PASS"
        else:
            marker = "FAIL"
        click.echo(f"  [{marker}] {check.name}: {check.message}")
        if not check.passed and check.details:
            for key, value in check.details.items():
                click.echo(f"           - {key}: {value}")


@click.group()
def main() -> None:
    """Knowledge Package 조립·검증 (04-knowledge-platform.md §4.1/§4.2)."""


@main.command("build")
@click.option(
    "--index-dir", required=True, type=click.Path(exists=True, file_okay=False, path_type=Path),
    help="services/indexing-runtime가 만든 data/indexes/{AssetVersion id}/ 디렉터리",
)
@click.option(
    "--out", "out_dir", required=True, type=click.Path(path_type=Path),
    help="Knowledge Package를 조립할 출력 디렉터리 (data/indexes/ 하위는 금지)",
)
@click.option(
    "--asset-manifest", "asset_manifest_path", default=None,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="Knowledge Asset Manifest — owner/classification을 여기서 가져옵니다(없으면 미기재)",
)
@click.option(
    "--indexing-profile", "indexing_profile_path", default=None,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="Indexing Profile — embedding_model_alias ↔ Build Identity 검사에 사용",
)
@click.option(
    "--evaluation-result", "evaluation_result_path", default=None,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="evaluation-runner의 evaluation-result.json — Package에 함께 포함",
)
@click.option(
    "--policy", "policy_path", default=None, type=click.Path(path_type=Path),
    help=f"검증 정책 파일. 기본값: {settings.default_package_policy}",
)
@click.option(
    "--relativize-source-paths", is_flag=True, default=False,
    help=(
        "parents.json/Chroma metadata/bm25.json의 build-host 절대경로(source_path)를 "
        "패키지 상대경로로 재작성합니다(§4.1 금지 패턴 FATAL을 해소). "
        "아직 bm25.json으로 변환되지 않은 legacy bm25.pkl 내부 값은 unpickle 없이 "
        "재작성할 수 없어 대상에서 제외됩니다(D-054, convert-bm25-format으로 먼저 변환 권장)."
    ),
)
def build_cmd(
    index_dir: Path,
    out_dir: Path,
    asset_manifest_path: Path | None,
    indexing_profile_path: Path | None,
    evaluation_result_path: Path | None,
    policy_path: Path | None,
    relativize_source_paths: bool,
) -> None:
    """Index 디렉터리로부터 Knowledge Package 디렉터리를 조립하고 §4.1 검증을 실행한다."""
    try:
        policy = load_policy(policy_path or settings.default_package_policy)
    except PackagePolicyError as exc:
        _fail(str(exc))
        return

    try:
        result, warnings = build(
            index_dir=index_dir,
            out_dir=out_dir,
            policy=policy,
            asset_manifest_path=asset_manifest_path,
            indexing_profile_path=indexing_profile_path,
            evaluation_result_path=evaluation_result_path,
            relativize_source_paths=relativize_source_paths,
        )
    except (BuildError, IndexReadError) as exc:
        _fail(str(exc), policy)
        return
    except Exception as exc:  # last-resort guard: build()/verify() already
        # convert every known artifact-read failure into a BuildError/
        # IndexReadError or a FAILED check — this only catches a genuinely
        # unexpected bug, and must still never leak a traceback or a
        # build-host path (open-decisions.md D-054).
        _fail(f"예상하지 못한 오류로 조립을 완료하지 못했습니다: {exc}", policy)
        return

    for warning in warnings:
        click.echo(f"경고: {warning}", err=True)

    click.echo(f"Package: {result.package_dir}")
    click.echo(f"Knowledge AssetVersion: {result.manifest['knowledge_asset_version_id']}")
    click.echo(f"Chunking Strategy: {result.manifest['chunking_strategy']}")
    click.echo(f"Embed Model: {result.manifest['embed_model']}")
    click.echo(f"Counts: {result.manifest['counts']}")
    _print_report(result.verification)

    if not result.verification.passed and policy.fail_on_fatal:
        sys.exit(1)


@main.command("verify")
@click.option(
    "--package-dir", required=True, type=click.Path(exists=True, file_okay=False, path_type=Path),
    help="package-knowledge build로 만든 Knowledge Package 디렉터리",
)
@click.option(
    "--indexing-profile", "indexing_profile_path", default=None,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="Indexing Profile — embedding_model_alias ↔ Build Identity 검사에 사용",
)
@click.option(
    "--policy", "policy_path", default=None, type=click.Path(path_type=Path),
    help=f"검증 정책 파일. 기본값: {settings.default_package_policy}",
)
def verify_cmd(
    package_dir: Path, indexing_profile_path: Path | None, policy_path: Path | None
) -> None:
    """기존 Knowledge Package 디렉터리를 처음부터 다시 독립적으로 검증한다
    (package-manifest.json에 기록된 이전 검증 결과를 신뢰하지 않는다)."""
    try:
        policy = load_policy(policy_path or settings.default_package_policy)
    except PackagePolicyError as exc:
        _fail(str(exc))
        return

    try:
        report, warnings = verify(
            package_dir=package_dir, policy=policy, indexing_profile_path=indexing_profile_path
        )
    except (BuildError, IndexReadError) as exc:
        _fail(str(exc), policy)
        return
    except Exception as exc:  # last-resort guard: verify() already converts
        # every known artifact-read failure (Chroma open/query, malformed
        # JSON, truncated pickle, unreadable file) into a FAILED check, not
        # a raised exception — this only catches a genuinely unexpected
        # bug, and must still never leak a traceback or a build-host path
        # (open-decisions.md D-054).
        _fail(f"예상하지 못한 오류로 검증을 완료하지 못했습니다: {exc}", policy)
        return

    for warning in warnings:
        click.echo(f"경고: {warning}", err=True)

    click.echo(f"Package: {package_dir}")
    _print_report(report)

    if not report.passed and policy.fail_on_fatal:
        sys.exit(1)


if __name__ == "__main__":
    main()
