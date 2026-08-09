"""tests/security fixtures — M12, 05-mcp-security-governance.md §12/§13.

This suite proves the **cross-cutting, end-to-end security properties**
listed in the task brief hold *through the running system*, not just inside
an isolated unit-tested function — the same category of gap that let a
chunking regression pass 60 unit tests while the real published chatbot
answered with 0 citations (see `tests/e2e/conftest.py`'s module docstring
for that incident). It deliberately does NOT re-test what
`tests/unit/office_mcp_server/`, `tests/unit/distribution_service/`,
`tests/unit/security_policy/`, and `tests/integration/portal_api/` already
cover well in isolation (allowlist rejection, RBAC matrix, zip-slip,
approved-version immutability, publish gate) — see each test module's
docstring for the specific cross-service property it adds instead.

Why this file is almost entirely *imports*, not new fixtures: the task
brief is explicit — "Reuse `tests/e2e/conftest.py`'s tracking + cleanup so
this suite is also net-neutral on the live DB." `tests/e2e/conftest.py`
already solved every piece of infrastructure this suite also needs:

  - `_require_live_services` (session-scoped, autouse) — skip (never fail)
    when the live stack isn't up.
  - `_e2e_created_ids` / `_e2e_final_sweep` (autouse) — track every asset/
    service/deployment/distribution a test creates and delete exactly that
    (plus a belt-and-braces `e2e-` prefix sweep) so this suite leaves the
    live `portal.db` and `data/indexes/` byte-for-byte as it found them.
  - The `portal`/`agent`/`mcp`/`search`/`distribution` HTTP client fixtures,
    the `TOKENS`/`auth`/`auth_header` Test Identity helpers, and the
    `register_knowledge_asset`/`approve_asset_version`/`create_service`/
    `create_deployment`/`publish_deployment`/`mcp_audit_context` builders.

Pytest fixture resolution works by scanning a conftest module's namespace
for `@pytest.fixture`-marked callables, regardless of which module they were
originally *defined* in — importing a fixture here makes it just as valid a
fixture for `tests/security/*` as it is for `tests/e2e/*`, autouse ones
included. This is the standard "fixture library conftest" pattern, not a
workaround. `e2e_name`/`e2e_slug` are reused as-is (still applying the same
`e2e-` prefix) rather than inventing a parallel `security-` namespace, so a
single cleanup sweep (`sweep_e2e_prefixed_artifacts`, `make e2e-clean`)
covers whatever either suite left behind.

Never touches the demo data this repo ships with (`HR 정책 Knowledge`/
`TEST`/`재택근무 정책 Knowledge`/`ㅇ`; deployment slugs `remote-work-guide`/
`langchain`/`remote-work-approved`/`unapproved-test`/`chatbot-chura7`;
`data/indexes/hr-policy-v1`) — same `PROTECTED_*` guards as `tests/e2e`,
imported unchanged rather than re-declared, so there is exactly one place in
the repo that lists them.
"""

from __future__ import annotations

import re
import uuid

import pytest

# --- Re-exported wholesale from tests/e2e/conftest.py (see module docstring
# for why importing, not duplicating, is the correct approach here). Ruff's
# unused-import check (F401) would otherwise flag every one of these as dead
# — they are alive as pytest fixtures / shared helpers the moment this
# conftest module is collected, even though nothing in *this* file calls
# them directly. noqa: F401 per name would be noisy; a single module-level
# ignore comment covers this whole reuse block instead.
from tests.e2e.conftest import (  # noqa: F401
    AGENT_RUNTIME_URL,
    APPROVED_KNOWLEDGE_ASSET_ID,
    APPROVED_KNOWLEDGE_VERSION_ID,
    DISTRIBUTION_SERVICE_URL,
    EXISTING_DEPLOYMENT_SLUGS,
    OFFICE_MCP_URL,
    PORTAL_API_URL,
    PROTECTED_ASSET_IDS,
    PROTECTED_ASSET_NAMES,
    TOKENS,
    _e2e_created_ids,
    _e2e_final_sweep,
    _require_live_services,
    agent,
    approve_asset_version,
    auth,
    auth_header,
    build_service_definition,
    create_deployment,
    create_service,
    distribution,
    e2e_name,
    e2e_slug,
    mcp,
    mcp_audit_context,
    parse_sse_response,
    portal,
    publish_deployment,
    register_knowledge_asset,
    search,
    stream_run_events,
    unique_suffix,
    wait_for_distribution,
    wait_for_indexing_completed,
    wait_for_run_terminal,
)

# --- Security-suite-specific helpers (nothing above already provides these) -


def unknown_token(role_hint: str = "user") -> str:
    """A Bearer token shaped exactly like a real Test Identity token
    (`dev-<role>-token`, see `apps/portal-api/src/portal_api/auth.py`'s
    `_TEST_TOKENS`) but never registered there — the "valid-looking-but-
    unknown token" case property 1 asks for, distinct from pure garbage."""
    return f"dev-{role_hint}-token-{uuid.uuid4().hex[:8]}-nope"


# Patterns a security-conscious error response must never contain — Python
# tracebacks, absolute filesystem paths from this machine, sqlite/SQL
# fragments, or any of this suite's own real bearer tokens. Checked against
# the raw HTTP response body text (not parsed JSON) so nothing has a chance
# to hide inside a nested field this list doesn't know about yet.
_LEAK_PATTERNS: tuple[str, ...] = (
    "Traceback (most recent call last)",
    "/Users/",
    "sqlite3.",
    "SELECT ",
    "INSERT INTO",
    "DELETE FROM",
    "  File \"",
)


def assert_no_secret_leak(body_text: str, *, context: str = "") -> None:
    """07-data-api-contracts.md §10.2 / CLAUDE.md 로그 규칙: an error body may
    say *that* something failed, never leak *how* the system is built or
    what it holds. Checks both the fixed `_LEAK_PATTERNS` above and every
    real Test Identity token value from `TOKENS` (a response must never
    reflect a caller's own -- or anyone else's -- bearer token back)."""
    for pattern in _LEAK_PATTERNS:
        assert pattern not in body_text, (
            f"{context}: response body leaked an internal pattern {pattern!r}: {body_text[:500]}"
        )
    for token_value in TOKENS.values():
        assert token_value not in body_text, (
            f"{context}: response body leaked a real bearer token value: {body_text[:500]}"
        )


_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


def strip_trace_id(payload: dict) -> dict:
    """Return a copy of an `{"error": {...}}` envelope with any uuid-shaped
    `trace_id`replaced by a constant placeholder, so two independently
    generated error responses (e.g. unknown vs. suspended Hosted Chat slug)
    can be compared for the "same code + same message" safe-404 property
    without a fresh random trace_id per request making a literal `==` fail."""
    import copy

    clone = copy.deepcopy(payload)
    error = clone.get("error")
    if isinstance(error, dict) and isinstance(error.get("trace_id"), str):
        error["trace_id"] = "<trace_id>"
    return clone


@pytest.fixture(autouse=True)
def _security_marker_sanity(request: pytest.FixtureRequest) -> None:
    """Defensive check: every test in this package must carry
    `pytest.mark.security` (via each module's `pytestmark`) so it is
    excluded from the default `uv run pytest tests/ -q` run exactly like
    `tests/e2e` is. A test missing the marker would silently join the fast
    offline default suite instead of `make security-test` -- this fixture
    turns that mistake into an immediate, loud failure instead of a quiet
    CI surprise."""
    if "security" not in {m.name for m in request.node.iter_markers()}:
        pytest.fail(
            f"{request.node.nodeid} is in tests/security/ but missing "
            "`pytestmark = pytest.mark.security` -- it would otherwise leak "
            "into the default `pytest tests/` run."
        )
