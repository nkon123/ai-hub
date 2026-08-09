"""CLI-level tests for `package-knowledge verify` (M09) — the actual
user-facing entry point this task's defect was reported against.

`test_builder.py` already proves `verify()` (the Python API) never raises
and correctly gates content checks behind integrity. This file proves the
same guarantee holds end-to-end through the real `package-knowledge` CLI
(click), which is what a person actually runs: exit code, printed text, and
— the specific defect this task fixes — that the combined stdout+stderr
output of a failed `verify` NEVER contains a Python traceback or a
build-host absolute path (`chromadb.errors.InternalError: ... database disk
image is malformed`, uncaught, used to print exactly that; see
open-decisions.md D-054's correction and `builder.verify`'s docstring).

Entirely offline, tmp_path-based — no dependency on `data/indexes/` or any
running service, same fixture discipline as the rest of this package's
tests (`.conftest.make_index_dir`).
"""

from __future__ import annotations

from pathlib import Path

from click.testing import CliRunner
from knowledge_packager.builder import build
from knowledge_packager.cli import main
from knowledge_packager.policy import load_policy

from .conftest import make_index_dir

_POLICY_PATH = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "packages"
    / "knowledge-packager"
    / "config"
    / "package-policy.yaml"
)


def _build_package(tmp_path: Path, knowledge_id: str) -> Path:
    fx = make_index_dir(tmp_path / "source", knowledge_id, absolute_source_path_prefix="source")
    out_dir = tmp_path / "out" / knowledge_id
    build(index_dir=fx.index_dir, out_dir=out_dir, policy=load_policy(_POLICY_PATH))
    return out_dir


def test_cli_verify_on_tampered_chroma_sqlite_reports_failure_without_crashing(
    tmp_path: Path,
) -> None:
    """The exact reproduction from this task, run through the real CLI
    (not the Python API): one byte flipped at the midpoint of a real
    chroma.sqlite3. Must exit non-zero and name the tampered file — must
    NOT print a traceback."""
    out_dir = _build_package(tmp_path, "kid-cli-sqlite-tamper")
    sqlite_path = out_dir / "index" / "chroma" / "chroma.sqlite3"
    data = bytearray(sqlite_path.read_bytes())
    data[len(data) // 2] ^= 0x01
    sqlite_path.write_bytes(bytes(data))

    runner = CliRunner()
    result = runner.invoke(
        main, ["verify", "--package-dir", str(out_dir), "--policy", str(_POLICY_PATH)]
    )

    assert result.exit_code != 0
    assert "Traceback" not in result.output
    assert "/Users/" not in result.output
    assert "checksum_integrity" in result.output
    assert "chroma.sqlite3" in result.output
    assert "FAIL" in result.output


def test_cli_verify_output_never_leaks_traceback_or_host_path(tmp_path: Path) -> None:
    """The test this task explicitly asks for: grep the FULL CLI output of
    a failed `verify` for `/Users/` and `Traceback` and assert neither
    appears — across all three required corruption modes (chroma.sqlite3
    byte flip, HNSW segment byte flip, chroma.sqlite3 truncation)."""
    package_dirs: list[Path] = []

    out1 = _build_package(tmp_path, "kid-cli-case-sqlite-flip")
    p1 = out1 / "index" / "chroma" / "chroma.sqlite3"
    b1 = bytearray(p1.read_bytes())
    b1[len(b1) // 2] ^= 0x01
    p1.write_bytes(bytes(b1))
    package_dirs.append(out1)

    out2 = _build_package(tmp_path, "kid-cli-case-hnsw-flip")
    p2 = next((out2 / "index" / "chroma").glob("*/data_level0.bin"))
    b2 = bytearray(p2.read_bytes())
    b2[len(b2) // 2] ^= 0x01
    p2.write_bytes(bytes(b2))
    package_dirs.append(out2)

    out3 = _build_package(tmp_path, "kid-cli-case-sqlite-truncate")
    p3 = out3 / "index" / "chroma" / "chroma.sqlite3"
    with p3.open("r+b") as f:
        f.truncate(p3.stat().st_size // 2)
    package_dirs.append(out3)

    runner = CliRunner()
    for package_dir in package_dirs:
        result = runner.invoke(
            main, ["verify", "--package-dir", str(package_dir), "--policy", str(_POLICY_PATH)]
        )
        assert result.exit_code != 0, (package_dir, result.output)
        assert "Traceback" not in result.output, (package_dir, result.output)
        assert "/Users/" not in result.output, (package_dir, result.output)
        assert "checksum_integrity" in result.output, (package_dir, result.output)


def test_cli_verify_happy_path_still_passes_and_exits_zero(tmp_path: Path) -> None:
    """Sanity check that the integrity-gate rework did not break the normal
    passing case through the CLI."""
    out_dir = _build_package(tmp_path, "kid-cli-happy")

    runner = CliRunner()
    result = runner.invoke(
        main, ["verify", "--package-dir", str(out_dir), "--policy", str(_POLICY_PATH)]
    )

    assert result.exit_code == 0, result.output
    assert "검증 결과: PASS" in result.output
    assert "Traceback" not in result.output
    assert "/Users/" not in result.output
