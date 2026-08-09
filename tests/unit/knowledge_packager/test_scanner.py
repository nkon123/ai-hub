"""scanner: forbidden filename + secret/absolute-path pattern detection."""

from __future__ import annotations

from pathlib import Path

from knowledge_packager.policy import load_policy
from knowledge_packager.scanner import scan_files

_POLICY_PATH = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "packages"
    / "knowledge-packager"
    / "config"
    / "package-policy.yaml"
)


def _policy():
    return load_policy(_POLICY_PATH)


def test_clean_files_produce_no_findings() -> None:
    files = {
        "index/parents.json": b'{"p1": {"metadata": {"source_path": "doc.md"}}}',
        "source-manifest.json": b'{"documents": []}',
    }
    findings = scan_files(files, _policy())
    assert findings == []


def test_detects_macos_absolute_path_leak() -> None:
    files = {
        "index/parents.json": (
            b'{"p1": {"metadata": {"source_path": '
            b'"/Users/victory/Dev/ai/miracom/enterprise-ai-asset-hub/apps/portal-api/'
            b'storage/knowledge/x/1.0.0/doc.md"}}}'
        )
    }
    findings = scan_files(files, _policy())
    assert any(
        f.pattern_id == "absolute_path_unix_users" and f.severity == "FATAL" for f in findings
    )


def test_detects_linux_home_path_leak() -> None:
    files = {"a.json": b'{"source_path": "/home/builder/storage/doc.md"}'}
    findings = scan_files(files, _policy())
    assert any(f.pattern_id == "absolute_path_unix_home" for f in findings)


def test_detects_private_key_header() -> None:
    files = {
        "leaked.pem": b"-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----"
    }
    findings = scan_files(files, _policy())
    fatal = [f for f in findings if f.pattern_id == "private_key_header"]
    assert fatal and fatal[0].severity == "FATAL"


def test_detects_forbidden_filename() -> None:
    files = {"secrets/.env": b"SOME_VAR=value"}
    findings = scan_files(files, _policy())
    assert any(f.pattern_id.startswith("forbidden_filename:") for f in findings)


def test_scan_works_on_binary_content_without_decoding() -> None:
    """The scanner must not crash on non-UTF-8 bytes (e.g. a real
    chroma.sqlite3), and must still find an embedded leak as a byte
    substring — this is the property that lets it catch a leak inside
    bm25.pkl without ever unpickling it."""
    binary_blob = b"\x80\x04\x95\x00\x00\x00\x00\x00\x00\x00\x00}\x94" + (
        b"/Users/someone/project/doc.md"
    ) + b"\xff\xfe\x00\x01"
    findings = scan_files({"bm25.pkl": binary_blob}, _policy())
    assert any(f.pattern_id == "absolute_path_unix_users" for f in findings)


def test_finding_excerpt_never_reproduces_the_leaked_text_verbatim() -> None:
    """Regression test: an earlier version cropped context around a match
    but still included the matched text itself, which meant a Finding's
    excerpt — embedded verbatim into package-manifest.json's verification
    block — leaked the exact same absolute path a second time (confirmed
    against real data: package-manifest.json failed its own re-scan). The
    excerpt must show surrounding context but never the sensitive span."""
    leaked_path = "/Users/victory/Dev/ai/miracom/enterprise-ai-asset-hub/doc.md"
    files = {"parents.json": f'{{"source_path": "{leaked_path}"}}'.encode()}

    findings = scan_files(files, _policy())

    leak_findings = [f for f in findings if f.pattern_id == "absolute_path_unix_users"]
    assert leak_findings
    for finding in leak_findings:
        assert leaked_path not in finding.excerpt
        assert "victory" not in finding.excerpt
        assert "[REDACTED]" in finding.excerpt


def test_residual_leak_severity_override_downgrades_to_warning() -> None:
    policy = _policy()
    binary_blob = b"pickle-bytes-" + b"/Users/someone/project/doc.md"
    findings = scan_files({"bm25.pkl": binary_blob}, policy)
    leak_findings = [f for f in findings if f.pattern_id == "absolute_path_unix_users"]
    assert leak_findings
    assert all(f.severity == policy.residual_leak_severity_override for f in leak_findings)
    # The identical pattern in a non-pickle file must stay FATAL.
    findings_other_file = scan_files({"parents.json": binary_blob}, policy)
    assert any(
        f.pattern_id == "absolute_path_unix_users" and f.severity == "FATAL"
        for f in findings_other_file
    )
