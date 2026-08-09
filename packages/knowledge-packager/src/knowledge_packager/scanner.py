"""Forbidden-file and secret-pattern scanning (04-knowledge-platform.md
§4.1 "금지 파일과 Secret Pattern 없음").

Scans raw *bytes*, not decoded text, and runs the same byte-pattern search
against every packaged file regardless of type — including opaque binaries
like `bm25.pkl`/`chroma.sqlite3`. This is deliberate: a pickle's
SHORT_BINUNICODE opcodes store their string payload as literal UTF-8 bytes
in the file, so a substring like `/Users/victory/...` embedded in pickled
metadata is still found by a plain byte-level regex search — without ever
unpickling the file (see `knowledge_packager.bm25_inspect` for why that
matters). The same is true of a SQLite file's text columns.
"""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass

from knowledge_packager.policy import PackagePolicy

_MAX_FINDINGS_PER_FILE_PER_PATTERN = 5
_EXCERPT_RADIUS = 12


@dataclass(frozen=True)
class Finding:
    relative_path: str
    pattern_id: str
    severity: str
    description: str
    excerpt: str

    def to_dict(self) -> dict[str, str]:
        return {
            "relative_path": self.relative_path,
            "pattern_id": self.pattern_id,
            "severity": self.severity,
            "description": self.description,
            "excerpt": self.excerpt,
        }


def _redact_excerpt(data: bytes, start: int, end: int) -> str:
    """A short, still-diagnostic excerpt with the MATCHED SPAN ITSELF
    replaced by a placeholder — never the literal matched text (e.g. the
    build host's absolute path, complete with OS username).

    This matters beyond the general CLAUDE.md "Log에 Secret을 기본
    저장하지 않는다" principle: this excerpt gets embedded verbatim into
    `package-manifest.json`'s `verification` block (see `builder.py`), which
    is itself one of the files shipped in — and re-scanned as part of — the
    Knowledge Package. An earlier version of this function only cropped
    *context* around the match but still included the match text itself,
    which meant a genuinely leaking file's finding, once recorded, made
    `package-manifest.json` leak the exact same absolute path a second
    time — confirmed empirically: `package-knowledge build` on real data
    produced a package-manifest.json that FAILED `package-knowledge
    verify`'s own re-scan of itself, purely because of this. Only the
    surrounding context (never the match) is now shown.
    """
    lo = max(0, start - _EXCERPT_RADIUS)
    hi = min(len(data), end + _EXCERPT_RADIUS)
    before = data[lo:start].decode("utf-8", errors="replace")
    after = data[end:hi].decode("utf-8", errors="replace")
    prefix = "…" if lo > 0 else ""
    suffix = "…" if hi < len(data) else ""
    return f"{prefix}{before}[REDACTED]{after}{suffix}"


def scan_filename(relative_path: str, policy: PackagePolicy) -> Finding | None:
    basename = relative_path.rsplit("/", 1)[-1]
    for glob in policy.forbidden_filenames:
        if fnmatch.fnmatch(basename.lower(), glob.lower()):
            return Finding(
                relative_path=relative_path,
                pattern_id=f"forbidden_filename:{glob}",
                severity="FATAL",
                description=f"금지된 파일명 패턴과 일치: {glob}",
                excerpt=basename,
            )
    return None


def scan_content(relative_path: str, data: bytes, policy: PackagePolicy) -> list[Finding]:
    basename = relative_path.rsplit("/", 1)[-1]
    findings: list[Finding] = []
    for pattern in policy.forbidden_content_patterns:
        matches = list(pattern.regex.finditer(data))
        for match in matches[:_MAX_FINDINGS_PER_FILE_PER_PATTERN]:
            severity = policy.effective_severity(pattern, basename)
            findings.append(
                Finding(
                    relative_path=relative_path,
                    pattern_id=pattern.id,
                    severity=severity,
                    description=pattern.description,
                    excerpt=_redact_excerpt(data, match.start(), match.end()),
                )
            )
    return findings


def scan_files(files: dict[str, bytes], policy: PackagePolicy) -> list[Finding]:
    """Scan every (relative_path -> bytes) entry for forbidden filenames and
    forbidden content patterns. Returns every finding — callers decide how
    to turn that into a pass/fail CheckResult (see
    `knowledge_packager.verification`)."""
    findings: list[Finding] = []
    for relative_path, data in files.items():
        filename_finding = scan_filename(relative_path, policy)
        if filename_finding is not None:
            findings.append(filename_finding)
        findings.extend(scan_content(relative_path, data, policy))
    return findings


def sanitize_text(text: str, policy: PackagePolicy) -> str:
    """Redact every configured `forbidden_content_patterns` match found in an
    arbitrary string — not a packaged file's bytes, but free text this
    package is about to print or embed in a report (a caught exception's
    `str()`, most importantly).

    This exists because `verify()`/`build()` must never let a third-party
    library's exception message (chromadb's, in particular — its error
    strings can embed the path of the sqlite file it failed to open) leak a
    build-host absolute path into CLI output or a report. Reuses the exact
    same policy-driven patterns and matched-span-only redaction discipline
    as `_redact_excerpt`/`scan_content` — no second, hardcoded copy of
    "what a leaking path looks like" — the only difference is there is no
    surrounding byte offset to keep as context, since the input here is
    already a short message, not a whole file."""
    data = text.encode("utf-8", errors="replace")
    for pattern in policy.forbidden_content_patterns:
        data = pattern.regex.sub(b"[REDACTED]", data)
    return data.decode("utf-8", errors="replace")
