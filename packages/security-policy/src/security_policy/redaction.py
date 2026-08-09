"""Secret-shaped value detection — M11, shared by any module that must
render *configuration* to a screen without ever echoing a live credential
(01-portal-and-distribution.md §2 P15: "실제 Secret 값은 화면에서 재표시하지
않는다").

Why this lives here and not in `knowledge_packager.scanner` (which already
has an almost identical `sanitize_text`/pattern set): that function is not
part of `knowledge_packager`'s public contract (absent from its
`__init__.py` `__all__`), so importing it from another module would reach
past a package boundary into an internal file — exactly what CLAUDE.md 구현
원칙 2 ("모듈 간 내부 폴더 직접 Import를 금지") forbids. `knowledge_packager`
also pulls in `chromadb` as a dependency, which would be a heavy, unrelated
addition to any module (e.g. `portal_api`) that only wants "does this string
look like a secret" and has no business scanning package bytes. Rather than
either violate 원칙 2 or hand-copy `knowledge_packager`'s patterns a second
time with no shared home, this is a *small* deliberately independent helper
in `security_policy` (M11 already owns RBAC/audit/classification policy —
"does this value look like a credential" is the same kind of policy
decision) that `portal_api` can depend on the same way it already depends on
this package for `Role`/`Permission`/`Classification`.

This is intentionally narrower than `knowledge_packager`'s scanner: no
absolute-path detection (that scanner's concern is build-host leakage, not
credentials), no FATAL/WARNING severity model, no file/byte scanning — just
"would this string, if rendered on an admin config screen, expose something
that looks like a live secret". A false positive here only means a value is
over-cautiously hidden, never under-cautiously shown.
"""

from __future__ import annotations

import re

_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9\-_.]{16,}"),
    re.compile(r"(?i)api[_-]?key[\"'\s:=]+[A-Za-z0-9\-_]{16,}"),
    re.compile(r"(?i)(password|secret|token)\s*[=:]\s*[^\s\"']{4,}"),
    # Credential embedded in a URL authority, e.g. https://user:pass@host —
    # the one shape a structurally-valid endpoint string could still hide a
    # secret in (office-profile.json's `endpoint` fields are otherwise plain
    # loopback/internal URLs per its schema).
    re.compile(r"(?i)[a-z][a-z0-9+.\-]*://[^\s/@]+:[^\s/@]+@"),
)


def looks_like_secret(value: str) -> bool:
    """True if `value` contains anything matching a known credential shape.

    Deliberately conservative (biased toward flagging, not toward missing a
    real secret) — callers use this to decide whether a config value is safe
    to render at all, not to decide whether to log it, so an over-broad match
    only costs a masked field, never an exposed one."""
    return any(p.search(value) for p in _SECRET_PATTERNS)


def redact_if_secret(value: str, *, placeholder: str = "***REDACTED***") -> str:
    """Return `value` unchanged, or `placeholder` if it looks like a secret.

    Whole-value replacement (not span-level redaction like
    `knowledge_packager.scanner._redact_excerpt`) — this helper's callers are
    rendering short, discrete config fields (an endpoint, a model id), not
    excerpting a match out of a large document, so there is no surrounding
    context worth preserving once a field is flagged."""
    return placeholder if looks_like_secret(value) else value
