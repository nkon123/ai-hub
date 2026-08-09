"""policy: package-policy.yaml loading and error handling."""

from __future__ import annotations

from pathlib import Path

import pytest
from knowledge_packager.policy import PackagePolicyError, load_policy

_REAL_POLICY_PATH = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "packages"
    / "knowledge-packager"
    / "config"
    / "package-policy.yaml"
)


def test_load_real_policy_file() -> None:
    policy = load_policy(_REAL_POLICY_PATH)
    assert policy.forbidden_content_patterns
    assert "bm25.pkl" in policy.known_residual_leak_artifacts
    assert policy.fail_on_fatal is True


def test_missing_policy_file_raises(tmp_path: Path) -> None:
    with pytest.raises(PackagePolicyError):
        load_policy(tmp_path / "does-not-exist.yaml")


def test_empty_policy_file_raises(tmp_path: Path) -> None:
    path = tmp_path / "empty.yaml"
    path.write_text("", encoding="utf-8")
    with pytest.raises(PackagePolicyError):
        load_policy(path)


def test_invalid_severity_raises(tmp_path: Path) -> None:
    path = tmp_path / "bad.yaml"
    path.write_text(
        "forbidden_content_patterns:\n"
        "  - id: x\n"
        "    pattern: 'abc'\n"
        "    severity: NOT_A_REAL_SEVERITY\n",
        encoding="utf-8",
    )
    with pytest.raises(PackagePolicyError):
        load_policy(path)


def test_invalid_regex_raises(tmp_path: Path) -> None:
    path = tmp_path / "bad-regex.yaml"
    path.write_text(
        "forbidden_content_patterns:\n"
        "  - id: x\n"
        "    pattern: '(unclosed'\n"
        "    severity: FATAL\n",
        encoding="utf-8",
    )
    with pytest.raises(PackagePolicyError):
        load_policy(path)
