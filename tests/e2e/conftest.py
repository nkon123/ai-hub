"""tests/e2e fixtures and shared helpers — M12, 06-quality-delivery.md §8.

Why this suite must hit REAL services (not fakes/mocks): a chunking change
once collapsed a document from 4 chunks into 1; the live published chatbot
stopped answering a real question ("장비 지원은 무엇이 있나요?" -> 0
citations) while all 60 chunker unit tests passed AND the evaluation
Quality Gate reported PASS. Only poking the real chatbot exposed it. Every
test in this package therefore talks HTTP to the actual running processes
and asserts on real answer content/citations, never on a fake adapter.

Execution model:
  - `_require_live_services` (session-scoped, autouse) probes every required
    service's health endpoint once per session and `pytest.skip`s the whole
    suite with a clear message if any are unreachable — CI without Ollama
    must skip, not fail (see task brief).
  - Every test module sets `pytestmark = pytest.mark.e2e`. The marker is
    registered in the root `pyproject.toml` with `addopts = -m "not e2e"`,
    so `uv run pytest tests/ -q` (the fast, offline default suite) never
    collects/runs these; `make e2e-test` overrides with `-m e2e`.

Data hygiene: the live `apps/portal-api/portal.db` serves real demo traffic
(4 Knowledge assets, 6 services, 5 published deployments). Nothing in this
package deletes/recreates it, re-indexes an existing knowledge id, or
mutates the pre-existing seeded deployments' (`remote-work-guide`,
`langchain`, `remote-work-approved`, `unapproved-test`, `chatbot-chura7`)
state. Everything this suite creates is namespaced with an `e2e-` prefix and
a random suffix so repeated runs never collide (`DEPLOYMENT_SLUG_CONFLICT`
otherwise) and so seeded data stays distinguishable from test data in the
live DB.

Cleanup (net-neutrality): a run used to leave every asset/service/deployment
it created permanently in the live DB plus orphaned `data/indexes/<id>/`
directories, polluting the demo. This module now removes everything a test
run creates:
  - `_e2e_created_ids` (function-scoped, autouse) tracks the id of every
    asset/service/deployment/distribution this suite creates, via a single
    choke point each: `register_knowledge_asset`, `create_service`,
    `create_deployment`, `wait_for_distribution`. Its teardown deletes
    exactly those tracked rows (plus what FK joins pull in — asset_versions,
    indexing_jobs, review_requests/decisions, service_versions,
    deployment_revisions) after every test, pass or fail.
  - `_e2e_final_sweep` (session-scoped, autouse) runs once after the whole
    session as a belt-and-braces safety net: an `e2e-` name/slug prefix
    sweep (`sweep_e2e_prefixed_artifacts`) in case any id was ever missed.
  - `make e2e-clean` runs that same prefix sweep standalone, for recovering
    pre-existing polluted state from before this cleanup existed.
  - There is no DELETE API for any of this (by design — "자산 삭제 대신
    상태 전환을 사용한다"), so cleanup goes straight to the sqlite file plus
    filesystem removal of index dirs. See `_delete_e2e_rows` for the single
    place that does this, and its FK-safe deletion order.
  - Every deletion is guarded against the seeded demo identifiers
    (`PROTECTED_ASSET_IDS`/`PROTECTED_ASSET_NAMES`/`EXISTING_DEPLOYMENT_SLUGS`)
    and against ever touching `data/indexes/hr-policy-v1` or an index dir
    still referenced by a surviving `asset_versions` row. A cleanup failure
    is caught and warned, never raised, so it can't mask a real test result.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import sqlite3
import time
import uuid
import warnings
import zipfile
from collections.abc import Generator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest

# --- Live service base URLs (overridable so a differently-configured
# environment can still run this suite without editing test files) ---

PORTAL_API_URL = os.environ.get("E2E_PORTAL_API_URL", "http://localhost:8000")
AGENT_RUNTIME_URL = os.environ.get("E2E_AGENT_RUNTIME_URL", "http://localhost:8100")
INDEXING_RUNTIME_URL = os.environ.get("E2E_INDEXING_RUNTIME_URL", "http://localhost:8200")
SEARCH_RUNTIME_URL = os.environ.get("E2E_SEARCH_RUNTIME_URL", "http://localhost:8300")
DISTRIBUTION_SERVICE_URL = os.environ.get("E2E_DISTRIBUTION_SERVICE_URL", "http://localhost:8400")
OFFICE_MCP_URL = os.environ.get("E2E_OFFICE_MCP_URL", "http://localhost:8500")
OLLAMA_URL = os.environ.get("E2E_OLLAMA_URL", "http://localhost:11434")

# --- Seeded live demo data (read-only references — never mutated) ---
# 재택근무 정책 Knowledge: APPROVED, already indexed (4 chunks, 1 per
# H2 section of remote-work-policy.md). Safe to *read* (search/run queries,
# or as a distribution root — bundling only copies existing index files, it
# never re-indexes) but this suite must never suspend/deprecate/re-approve
# it or touch `data/indexes/2f157a86.../` or `.../d9e660b7.../` on disk.
APPROVED_KNOWLEDGE_ASSET_ID = "2f157a86-29c2-41d7-a8a8-e3d34a36e515"
APPROVED_KNOWLEDGE_VERSION_ID = "d9e660b7-ca76-4f46-899e-2e1621bac139"
APPROVED_KNOWLEDGE_KNOWN_SECTION = "장비 지원"
APPROVED_KNOWLEDGE_KNOWN_QUESTION = "장비 지원은 무엇이 있나요?"

EXISTING_DEPLOYMENT_SLUGS = frozenset(
    {"remote-work-guide", "langchain", "remote-work-approved", "unapproved-test", "chatbot-chura7"}
)

# Seeded demo Knowledge assets, by id and by display name — both are
# hard-guarded in `_delete_e2e_rows` below, in addition to
# `EXISTING_DEPLOYMENT_SLUGS` above. Never match `E2E_NAME_PREFIX`, so a
# correct prefix sweep can never select them; kept as an explicit
# belt-and-braces assertion anyway (see task brief: "assert/skip rather than
# delete if a target ever matches").
PROTECTED_ASSET_IDS = frozenset(
    {
        "550e8400-e29b-41d4-a716-446655440001",  # HR 정책 Knowledge
        "d0b4c0ec-4f20-4d0f-a455-beed143c1c38",  # TEST
        APPROVED_KNOWLEDGE_ASSET_ID,  # 재택근무 정책 Knowledge
        "075e6123-c609-4789-bdef-aad5f19b8abb",  # ㅇ
    }
)
PROTECTED_ASSET_NAMES = frozenset({"HR 정책 Knowledge", "TEST", "재택근무 정책 Knowledge", "ㅇ"})

# `data/indexes/<dir>` names that must never be removed even if nothing in
# `asset_versions` references them any more (e.g. a legacy/orphaned fixture
# directory pre-dating this cleanup).
PROTECTED_INDEX_DIR_NAMES = frozenset({"hr-policy-v1"})

# --- Test Identity tokens (apps/portal-api/src/portal_api/auth.py) ---
TOKENS: dict[str, str] = {
    "CREATOR": "dev-user-token",
    "TECH_REVIEWER": "dev-reviewer-token",
    "SECURITY_REVIEWER": "dev-security-token",
    "RELEASE_MANAGER": "dev-release-token",
    "AUDITOR": "dev-auditor-token",
    "ADMIN": "dev-admin-token",
}


def auth(role: str = "CREATOR") -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKENS[role]}"}


# The namespace prefix every name/slug this suite creates carries — the
# join point between "created by tests/e2e" and the cleanup sweep below.
E2E_NAME_PREFIX = "e2e-"


def unique_suffix() -> str:
    return uuid.uuid4().hex[:8]


def e2e_name(prefix: str) -> str:
    """A Korean/free-text display name, namespaced for easy identification
    in the live DB (not a slug — see `e2e_slug` for the URL-safe form)."""
    return f"{E2E_NAME_PREFIX}{prefix}-{unique_suffix()}"


def e2e_slug(prefix: str) -> str:
    """A Deployment slug: lowercase ascii/digits/hyphen only, 5-64 chars,
    matching `services.py`'s `SLUG_PATTERN`."""
    return f"{E2E_NAME_PREFIX}{prefix}-{unique_suffix()}"


# --- Service liveness gate -------------------------------------------------

_REQUIRED_SERVICES: dict[str, tuple[str, str]] = {
    "portal-api": (PORTAL_API_URL, "/health"),
    "agent-runtime": (AGENT_RUNTIME_URL, "/health"),
    "indexing-runtime": (INDEXING_RUNTIME_URL, "/health"),
    "search-runtime": (SEARCH_RUNTIME_URL, "/health"),
    "distribution-service": (DISTRIBUTION_SERVICE_URL, "/health"),
    "office-mcp-server": (OFFICE_MCP_URL, "/health/live"),
    "ollama": (OLLAMA_URL, "/api/tags"),
}


def _probe_services() -> list[str]:
    problems: list[str] = []
    for name, (base, path) in _REQUIRED_SERVICES.items():
        try:
            resp = httpx.get(f"{base}{path}", timeout=3.0)
            if resp.status_code >= 400:
                problems.append(f"{name} ({base}{path} -> HTTP {resp.status_code})")
        except httpx.HTTPError as exc:
            problems.append(f"{name} ({base}{path} -> {exc.__class__.__name__})")
    return problems


@pytest.fixture(scope="session", autouse=True)
def _require_live_services() -> None:
    """Skip the whole `tests/e2e` session (never fail it) when the live
    stack this suite is designed to exercise isn't running — e.g. plain CI
    without Ollama. See task brief: "CI without Ollama must not fail, it
    must skip." This fixture is autouse at session scope so every test in
    this package is gated without each file repeating the check."""
    problems = _probe_services()
    if problems:
        pytest.skip(
            "tests/e2e requires the live service stack; not reachable:\n  - "
            + "\n  - ".join(problems)
            + "\nStart services first (see Makefile `dev-*` targets and `ollama serve`), "
            "then run `make e2e-test`."
        )


# --- E2E artifact cleanup ---------------------------------------------------
#
# There is no DELETE API for assets/services/deployments/etc. by design
# ("자산 삭제 대신 상태 전환을 사용한다" — CLAUDE.md). That is correct product
# behavior, but it means this test suite has no supported way to remove what
# it creates. The functions below are the one place that bypasses the API
# and writes directly to `apps/portal-api/portal.db` (plus removing
# `data/indexes/<asset_version_id>/` directories) — this is a TEST-ONLY
# operation, never a pattern to reuse for a product feature.
#
# Two ways rows are found for deletion:
#   1. Tracked ids (primary): `_track()` records the id of every asset/
#      service/deployment/distribution this suite creates, called from a
#      single choke-point helper each (`register_knowledge_asset`,
#      `create_service`, `create_deployment`, `wait_for_distribution`).
#      `cleanup_tracked_e2e_artifacts` deletes exactly those, expanded via FK
#      joins to their asset_versions/service_versions/indexing_jobs/
#      review_requests/review_decisions/deployment_revisions.
#   2. Name/slug prefix sweep (belt-and-braces + standalone recovery):
#      `sweep_e2e_prefixed_artifacts` finds anything still carrying the
#      `e2e-` namespace prefix (`E2E_NAME_PREFIX`) this suite's `e2e_name`/
#      `e2e_slug` helpers always apply. Used once at the end of the session
#      as a safety net beyond (1), and standalone via `make e2e-clean` to
#      recover state from before this cleanup existed (no tracked ids exist
#      across separate process invocations, so that path is prefix-only).
#
# Both paths funnel into `_delete_e2e_rows`, which re-validates every
# candidate against the seeded demo identifiers before deleting anything —
# never trusts that a caller filtered correctly.

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_DB_PATH = _REPO_ROOT / "apps" / "portal-api" / "portal.db"
_DEFAULT_INDEX_DIR = _REPO_ROOT / "data" / "indexes"

# FK-safe deletion order (verified manually against this schema — see task
# brief): children before parents, always.
_DELETE_ORDER = (
    "deployment_revisions",
    "service_deployments",
    "service_versions",
    "services",
    "indexing_jobs",
    "review_decisions",
    "review_requests",
    "distribution_requests",
    "asset_versions",
    "assets",
)


def _db_path() -> Path:
    return Path(os.environ.get("E2E_PORTAL_DB_PATH", str(_DEFAULT_DB_PATH)))


def _index_dir() -> Path:
    return Path(os.environ.get("E2E_INDEX_DIR", str(_DEFAULT_INDEX_DIR)))


def _is_e2e_name(value: str | None) -> bool:
    return bool(value) and value.startswith(E2E_NAME_PREFIX)


@dataclass
class _CreatedIds:
    """Ids this suite created, tracked live during a single test's run."""

    asset_ids: set[str] = field(default_factory=set)
    service_ids: set[str] = field(default_factory=set)
    deployment_ids: set[str] = field(default_factory=set)
    distribution_ids: set[str] = field(default_factory=set)

    def is_empty(self) -> bool:
        return not (
            self.asset_ids or self.service_ids or self.deployment_ids or self.distribution_ids
        )


_active_tracker: _CreatedIds | None = None


def _track(kind: str, value: str | None) -> None:
    """Record an id created by the currently-running test, if any. A no-op
    outside a test (e.g. `make e2e-clean`'s standalone process, where
    `_active_tracker` is never set) — that path relies solely on the prefix
    sweep instead."""
    if value and _active_tracker is not None:
        getattr(_active_tracker, kind).add(value)


def _fetch_ids(conn: sqlite3.Connection, sql: str, params: list[str] | None = None) -> set[str]:
    cur = conn.execute(sql, params or [])
    return {row[0] for row in cur.fetchall()}


def _ids_where_in(
    conn: sqlite3.Connection, select_sql: str, column_values: set[str]
) -> set[str]:
    """`select_sql` must contain exactly one `{ph}` placeholder marker for
    the `IN (...)` clause. Returns an empty set without querying when
    `column_values` is empty (SQLite chokes on `IN ()`)."""
    if not column_values:
        return set()
    placeholders = ",".join("?" * len(column_values))
    return _fetch_ids(conn, select_sql.format(ph=placeholders), list(column_values))


def _delete_by_ids(conn: sqlite3.Connection, table: str, ids: set[str]) -> int:
    if not ids:
        return 0
    placeholders = ",".join("?" * len(ids))
    cur = conn.execute(f"DELETE FROM {table} WHERE id IN ({placeholders})", list(ids))  # noqa: S608
    return cur.rowcount


def _resolve_candidates_by_prefix(
    conn: sqlite3.Connection,
) -> tuple[set[str], set[str], set[str]]:
    """Find asset/service/deployment ids whose name/slug carries the `e2e-`
    namespace prefix, already excluding anything matching a hard-guarded
    seeded demo identifier."""
    asset_rows = conn.execute("SELECT id, name FROM assets").fetchall()
    asset_ids = {
        row[0]
        for row in asset_rows
        if _is_e2e_name(row[1])
        and row[0] not in PROTECTED_ASSET_IDS
        and row[1] not in PROTECTED_ASSET_NAMES
    }

    service_rows = conn.execute("SELECT id, name FROM services").fetchall()
    service_ids = {row[0] for row in service_rows if _is_e2e_name(row[1])}

    deployment_rows = conn.execute("SELECT id, slug FROM service_deployments").fetchall()
    deployment_ids = {
        row[0]
        for row in deployment_rows
        if _is_e2e_name(row[1]) and row[1] not in EXISTING_DEPLOYMENT_SLUGS
    }
    return asset_ids, service_ids, deployment_ids


def _delete_e2e_rows(
    conn: sqlite3.Connection,
    *,
    asset_ids: set[str],
    service_ids: set[str],
    deployment_ids: set[str],
    distribution_ids: set[str],
    index_dir: Path,
) -> dict[str, int]:
    """Delete exactly the given candidate rows (plus what FK joins pull in),
    in FK-safe order, after re-validating every candidate against the
    seeded demo identifiers. Never trusts that a caller filtered correctly —
    this is the last line of defense before a live DELETE."""
    # --- Guard: refuse (loudly) rather than delete anything that looks like
    # seeded demo data, no matter which path produced the candidate id. ---
    if asset_ids:
        rows = conn.execute(
            f"SELECT id, name FROM assets WHERE id IN ({','.join('?' * len(asset_ids))})",  # noqa: S608
            list(asset_ids),
        ).fetchall()
        for asset_id, name in rows:
            assert asset_id not in PROTECTED_ASSET_IDS, (
                f"refusing to delete protected demo asset id {asset_id!r}"
            )
            assert name not in PROTECTED_ASSET_NAMES, (
                f"refusing to delete protected demo asset {name!r}"
            )
            assert _is_e2e_name(name), (
                f"refusing to delete asset without the e2e- prefix: {name!r} ({asset_id})"
            )
    if deployment_ids:
        rows = conn.execute(
            "SELECT id, slug FROM service_deployments WHERE id IN "
            f"({','.join('?' * len(deployment_ids))})",  # noqa: S608
            list(deployment_ids),
        ).fetchall()
        for deployment_id, slug in rows:
            assert slug not in EXISTING_DEPLOYMENT_SLUGS, (
                f"refusing to delete protected demo deployment {slug!r}"
            )
            assert _is_e2e_name(slug), (
                f"refusing to delete deployment without the e2e- prefix: {slug!r} ({deployment_id})"
            )

    # --- Expand via FK joins ---
    asset_version_ids = _ids_where_in(
        conn, "SELECT id FROM asset_versions WHERE asset_id IN ({ph})", asset_ids
    )
    service_version_ids = _ids_where_in(
        conn, "SELECT id FROM service_versions WHERE service_id IN ({ph})", service_ids
    )
    # A tracked Deployment's own service_version_id is always one this suite
    # created too (every call site builds it via `create_service` first —
    # see conftest helpers), but pull it in explicitly rather than assume,
    # so a Deployment is never left pointing at a since-deleted version.
    service_version_ids |= _ids_where_in(
        conn,
        "SELECT DISTINCT service_version_id FROM service_deployments WHERE id IN ({ph})",
        deployment_ids,
    )
    deployment_revision_ids = _ids_where_in(
        conn, "SELECT id FROM deployment_revisions WHERE deployment_id IN ({ph})", deployment_ids
    )
    indexing_job_ids = _ids_where_in(
        conn, "SELECT id FROM indexing_jobs WHERE asset_version_id IN ({ph})", asset_version_ids
    )
    # This PoC only ever reviews ASSET_VERSION subjects (services.py never
    # creates a review_requests row for a SERVICE_VERSION) — see
    # reviews.py's hardcoded `subject_type="ASSET_VERSION"`.
    review_request_ids = _ids_where_in(
        conn,
        "SELECT id FROM review_requests "
        "WHERE subject_type = 'ASSET_VERSION' AND subject_id IN ({ph})",
        asset_version_ids,
    )
    review_decision_ids = _ids_where_in(
        conn, "SELECT id FROM review_decisions WHERE review_id IN ({ph})", review_request_ids
    )
    # distribution_requests has no FK to asset/service versions, but its
    # `root_id` IS one when `root_type` is ASSET_VERSION/SERVICE_VERSION —
    # sweep those in too (covers e.g. E2E-01's own fresh Knowledge as a
    # bundle root) in addition to whatever was explicitly tracked (covers
    # E2E-03/04/08's bundles rooted at the PROTECTED seeded Knowledge, which
    # this join would never find since that root is never in our own id
    # sets).
    all_distribution_ids = set(distribution_ids) | _ids_where_in(
        conn,
        "SELECT id FROM distribution_requests WHERE root_id IN ({ph})",
        asset_version_ids | service_version_ids,
    )

    counts: dict[str, int] = {}
    counts["deployment_revisions"] = _delete_by_ids(
        conn, "deployment_revisions", deployment_revision_ids
    )
    counts["service_deployments"] = _delete_by_ids(conn, "service_deployments", deployment_ids)
    counts["service_versions"] = _delete_by_ids(conn, "service_versions", service_version_ids)
    counts["services"] = _delete_by_ids(conn, "services", service_ids)
    counts["indexing_jobs"] = _delete_by_ids(conn, "indexing_jobs", indexing_job_ids)
    counts["review_decisions"] = _delete_by_ids(conn, "review_decisions", review_decision_ids)
    counts["review_requests"] = _delete_by_ids(conn, "review_requests", review_request_ids)
    counts["distribution_requests"] = _delete_by_ids(
        conn, "distribution_requests", all_distribution_ids
    )
    counts["asset_versions"] = _delete_by_ids(conn, "asset_versions", asset_version_ids)
    counts["assets"] = _delete_by_ids(conn, "assets", asset_ids)
    conn.commit()

    counts["index_dirs"] = _sweep_orphaned_index_dirs(conn, index_dir)
    return counts


def _sweep_orphaned_index_dirs(conn: sqlite3.Connection, index_dir: Path) -> int:
    """Remove every `data/indexes/<dir>` entry that is NOT `hr-policy-v1`
    (`PROTECTED_INDEX_DIR_NAMES`) and NOT referenced by any surviving
    `asset_versions` row — i.e. exactly the rule the task brief states.

    Deliberately NOT scoped to "only the version ids this call just deleted":
    `_trigger_indexing` runs as a portal-api background task, and two of
    this suite's fixtures (E2E-05's `_pending_technical_review`, E2E-10's
    unapproved-knowledge registration) never await its completion before the
    test ends — indexing-runtime can still be writing that directory to disk
    *after* our per-test cleanup already deleted the row and looked for (but
    didn't yet find) it. Re-scanning the whole directory on every call
    (cheap; a handful of entries) means the NEXT call to this function
    (the next test's cleanup, the end-of-session sweep, or `make e2e-clean`)
    still catches it, closing that race instead of leaking the directory
    permanently.
    """
    if not index_dir.is_dir():
        return 0
    surviving = _fetch_ids(conn, "SELECT id FROM asset_versions")
    removed = 0
    for entry in index_dir.iterdir():
        if not entry.is_dir():
            continue
        if entry.name in PROTECTED_INDEX_DIR_NAMES or entry.name in surviving:
            continue
        shutil.rmtree(entry)
        removed += 1
    return removed


def cleanup_tracked_e2e_artifacts(tracker: _CreatedIds) -> dict[str, int]:
    """Primary cleanup path: delete exactly what one test tracked creating."""
    if tracker.is_empty():
        return {}
    conn = sqlite3.connect(_db_path())
    try:
        return _delete_e2e_rows(
            conn,
            asset_ids=set(tracker.asset_ids),
            service_ids=set(tracker.service_ids),
            deployment_ids=set(tracker.deployment_ids),
            distribution_ids=set(tracker.distribution_ids),
            index_dir=_index_dir(),
        )
    finally:
        conn.close()


def sweep_e2e_prefixed_artifacts() -> dict[str, int]:
    """Belt-and-braces / standalone recovery path: delete anything still
    carrying the `e2e-` name/slug prefix. See module docstring."""
    conn = sqlite3.connect(_db_path())
    try:
        asset_ids, service_ids, deployment_ids = _resolve_candidates_by_prefix(conn)
        return _delete_e2e_rows(
            conn,
            asset_ids=asset_ids,
            service_ids=service_ids,
            deployment_ids=deployment_ids,
            distribution_ids=set(),
            index_dir=_index_dir(),
        )
    finally:
        conn.close()


@pytest.fixture(autouse=True)
def _e2e_created_ids() -> Generator[None, None, None]:
    """Function-scoped, autouse: gives every test a fresh id tracker, then
    cleans up exactly what that test created — via `finally`, so this runs
    whether the test passed, failed, or errored. A cleanup bug is caught and
    warned, never raised, so it can never mask the test's own result."""
    global _active_tracker
    tracker = _CreatedIds()
    _active_tracker = tracker
    try:
        yield
    finally:
        _active_tracker = None
        try:
            cleanup_tracked_e2e_artifacts(tracker)
        except Exception as exc:  # noqa: BLE001 - intentionally broad, see docstring
            warnings.warn(
                f"tests/e2e per-test cleanup failed (test result is unaffected): {exc!r}",
                stacklevel=2,
            )


@pytest.fixture(scope="session", autouse=True)
def _e2e_final_sweep() -> Generator[None, None, None]:
    """Session-scoped safety net: after every test in the session has run
    (and been individually cleaned up above), sweep once more for anything
    still `e2e-` prefixed. Same non-raising guarantee as the per-test
    cleanup above."""
    yield
    try:
        sweep_e2e_prefixed_artifacts()
    except Exception as exc:  # noqa: BLE001 - intentionally broad, see docstring
        warnings.warn(f"tests/e2e final prefix sweep failed: {exc!r}", stacklevel=2)


# --- HTTP client fixtures ---------------------------------------------------
# Generous timeouts: real Ollama generation (exaone3.5:7.8b) measured ~10s
# end-to-end for a simple grounded answer; allow headroom under load.


@pytest.fixture
async def portal() -> Any:
    async with httpx.AsyncClient(base_url=PORTAL_API_URL, timeout=30.0) as client:
        yield client


@pytest.fixture
async def agent() -> Any:
    async with httpx.AsyncClient(base_url=AGENT_RUNTIME_URL, timeout=90.0) as client:
        yield client


@pytest.fixture
async def mcp() -> Any:
    async with httpx.AsyncClient(base_url=OFFICE_MCP_URL, timeout=30.0) as client:
        yield client


@pytest.fixture
async def search() -> Any:
    async with httpx.AsyncClient(base_url=SEARCH_RUNTIME_URL, timeout=30.0) as client:
        yield client


@pytest.fixture
async def distribution() -> Any:
    async with httpx.AsyncClient(base_url=DISTRIBUTION_SERVICE_URL, timeout=60.0) as client:
        yield client


# --- Knowledge registration / indexing / review helpers ---------------------


async def register_knowledge_asset(
    portal_client: httpx.AsyncClient,
    *,
    name: str,
    markdown_content: str,
    filename: str = "e2e-doc.md",
    token: str = TOKENS["CREATOR"],
    extra_headers: dict[str, str] | None = None,
) -> dict:
    """POST /api/v1/assets (multipart) for a fresh KNOWLEDGE asset.

    Mirrors the exact wire shape `apps/portal-web/app/knowledge/new/page.tsx`
    sends: form field `manifest` (JSON string) + form field `files` (repeated
    file parts). Returns the `AssetVersionOut` dict (includes `asset_id`).
    """
    manifest = {
        "schema_version": "1.0",
        "id": str(uuid.uuid4()),
        "type": "knowledge",
        "name": name,
        "version": "1.0.0",
        "owner": {"org": "miracom", "creator_id": "dev-user@miracom.com"},
        "classification": "INTERNAL",
        "description": f"{name} (tests/e2e fixture, safe to delete)",
        "source": {
            "type": "portal_upload",
            "documents": [
                {"path": f"documents/{filename}", "mime_type": "text/markdown", "sha256": "0" * 64}
            ],
        },
        "indexing_profile_ref": {"name": "default-korean-parent-child", "version": "1.0.0"},
    }
    headers = {"Authorization": f"Bearer {token}", **(extra_headers or {})}
    resp = await portal_client.post(
        "/api/v1/assets",
        data={"manifest": json.dumps(manifest, ensure_ascii=False)},
        files={"files": (filename, markdown_content.encode("utf-8"), "text/markdown")},
        headers=headers,
    )
    resp.raise_for_status()
    data = resp.json()
    _track("asset_ids", data.get("asset_id"))
    # Every asset creation kicks off indexing as a portal-api background
    # task (`_trigger_indexing`) that this HTTP response does not wait on.
    # Two callers in this suite (E2E-05's `_pending_technical_review`,
    # E2E-10's unapproved-knowledge registration) never poll indexing to
    # completion themselves because their scenario doesn't care about it --
    # but that left a real race for cleanup: indexing-runtime can still be
    # writing `data/indexes/<version_id>/` to disk *after* the test (and its
    # per-test/end-of-session cleanup) has already finished, permanently
    # orphaning the directory no matter how late the sweep runs. Waiting
    # here, unconditionally, for every caller closes that race at the
    # source instead of chasing it in cleanup. Callers that already poll
    # again afterward (test_e2e_01/09) just get an instant "already
    # COMPLETED" on that second call -- harmless. Outcome (COMPLETED vs
    # FAILED) is intentionally not asserted here -- that's each test's own
    # concern, not this shared helper's.
    await wait_for_indexing_completed(portal_client, data["asset_id"], token=token)
    return data


async def wait_for_indexing_completed(
    portal_client: httpx.AsyncClient,
    asset_id: str,
    *,
    token: str = TOKENS["CREATOR"],
    timeout: float = 90.0,
    interval: float = 2.0,
) -> dict:
    """Poll GET /api/v1/assets/{asset_id}/indexing-jobs until the most
    recent job reaches a terminal status (COMPLETED/FAILED)."""
    deadline = time.monotonic() + timeout
    last: dict | None = None
    while time.monotonic() < deadline:
        resp = await portal_client.get(
            f"/api/v1/assets/{asset_id}/indexing-jobs", headers=auth_header(token)
        )
        resp.raise_for_status()
        jobs = resp.json()
        if jobs:
            last = jobs[0]  # ordered by created_at desc
            if last["status"] in ("COMPLETED", "FAILED"):
                return last
        await asyncio.sleep(interval)
    raise TimeoutError(
        f"indexing job for asset {asset_id} did not complete within {timeout}s "
        f"(last observed: {last})"
    )


def auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def approve_asset_version(portal_client: httpx.AsyncClient, version_id: str) -> None:
    """Drive a fresh DRAFT AssetVersion through submit -> TECHNICAL ->
    SECURITY -> RELEASE approval, using the matching Test Identity token at
    each stage (`security_policy.roles.STAGE_PERMISSION`)."""
    resp = await portal_client.post(
        f"/api/v1/asset-versions/{version_id}/submit", headers=auth("CREATOR")
    )
    resp.raise_for_status()

    for stage, role in (
        ("TECHNICAL", "TECH_REVIEWER"),
        ("SECURITY", "SECURITY_REVIEWER"),
        ("RELEASE", "RELEASE_MANAGER"),
    ):
        resp = await portal_client.get(
            "/api/v1/reviews",
            params={"subject_type": "ASSET_VERSION", "stage": stage, "status": "PENDING"},
            headers=auth(role),
        )
        resp.raise_for_status()
        pending = [r for r in resp.json()["items"] if r["subject_id"] == version_id]
        assert pending, f"no PENDING {stage} review found for version {version_id}"
        review_id = pending[0]["id"]

        resp = await portal_client.post(
            f"/api/v1/reviews/{review_id}/decisions",
            json={"decision": "APPROVE", "comments": f"tests/e2e 자동 {stage} 승인"},
            headers=auth(role),
        )
        resp.raise_for_status()


# --- Service / Deployment helpers -------------------------------------------


def build_service_definition(
    *,
    name: str,
    knowledge_version_id: str,
    knowledge_version: str = "1.0.0",
    suggested_questions: list[str] | None = None,
    welcome_message: str = "안녕하세요! 무엇을 도와드릴까요?",
    max_mcp_calls: int = 0,
) -> dict:
    return {
        "schema_version": "1.0",
        "id": str(uuid.uuid4()),
        "type": "service",
        "name": name,
        "version": "1.0.0",
        "owner": {"org": "miracom", "team": "e2e", "creator_id": "dev-user@miracom.com"},
        "classification": "INTERNAL",
        "description": f"{name} (tests/e2e fixture)",
        "agent_ref": {"id": str(uuid.uuid4()), "version": "1.0.0"},
        "knowledge_bindings": [
            {
                "role_id": "answerer",
                "knowledge_id": knowledge_version_id,
                "knowledge_version": knowledge_version,
                "retrieval_profile_ref": {"name": "default-korean", "version": "1.0.0"},
                "context_token_limit": 4096,
            }
        ],
        "prompt_bindings": [],
        "model_policy": {
            "model_alias": "default-chat",
            "fallback_allowed": False,
            "max_context_tokens": 8192,
        },
        "target_users": {"orgs": ["miracom"], "roles": ["USER", "CREATOR"]},
        "limits": {
            "timeout_seconds": 60,
            "max_mcp_calls": max_mcp_calls,
            "max_context_tokens": 8192,
            "audit_level": "standard",
        },
        "chatbot_config": {
            "welcome_message": welcome_message,
            "suggested_questions": suggested_questions or ["질문 예시를 입력하세요"],
            "citation_display": True,
        },
    }


async def create_service(
    portal_client: httpx.AsyncClient, definition: dict, *, token: str = TOKENS["CREATOR"]
) -> dict:
    resp = await portal_client.post(
        "/api/v1/services",
        json={"name": definition["name"], "service_definition": definition},
        headers=auth_header(token),
    )
    resp.raise_for_status()
    data = resp.json()
    _track("service_ids", data.get("service_id"))
    return data


async def create_deployment(
    portal_client: httpx.AsyncClient,
    *,
    service_version_id: str,
    slug: str,
    token: str = TOKENS["CREATOR"],
    environment: str = "internal",
    access_policy: str = "INTERNAL_AUTHENTICATED",
) -> httpx.Response:
    resp = await portal_client.post(
        "/api/v1/deployments",
        json={
            "service_version_id": service_version_id,
            "slug": slug,
            "environment": environment,
            "access_policy": access_policy,
        },
        headers=auth_header(token),
    )
    if resp.status_code == 201:
        try:
            _track("deployment_ids", resp.json().get("id"))
        except ValueError:
            # unexpected non-JSON 201 body -- nothing to track, not this
            # helper's job to assert on the response shape
            pass
    return resp


async def publish_deployment(
    portal_client: httpx.AsyncClient, deployment_id: str, *, token: str = TOKENS["RELEASE_MANAGER"]
) -> httpx.Response:
    return await portal_client.post(
        f"/api/v1/deployments/{deployment_id}/publish", headers=auth_header(token)
    )


# --- Distribution / Bundle helpers ------------------------------------------


async def wait_for_distribution(
    portal_client: httpx.AsyncClient,
    distribution_id: str,
    *,
    token: str = TOKENS["CREATOR"],
    timeout: float = 60.0,
    interval: float = 1.5,
) -> dict:
    # Tracked here (rather than at the POST /api/v1/distributions call site)
    # because every caller in this suite passes the freshly-created id
    # straight into this single choke point -- including E2E-03/04/08, whose
    # bundles are rooted at the PROTECTED seeded Knowledge, so the
    # distribution_requests row itself is the only thing about that call
    # that's actually ours to clean up.
    _track("distribution_ids", distribution_id)
    deadline = time.monotonic() + timeout
    last: dict | None = None
    while time.monotonic() < deadline:
        resp = await portal_client.get(
            f"/api/v1/distributions/{distribution_id}", headers=auth_header(token)
        )
        resp.raise_for_status()
        last = resp.json()
        if last["status"] in ("SUCCEEDED", "FAILED"):
            return last
        await asyncio.sleep(interval)
    raise TimeoutError(f"distribution {distribution_id} did not finish within {timeout}s: {last}")


# --- agent-runtime run helpers -----------------------------------------------


async def wait_for_run_terminal(
    agent_client: httpx.AsyncClient, run_id: str, *, timeout: float = 120.0, interval: float = 1.5
) -> dict:
    deadline = time.monotonic() + timeout
    last: dict | None = None
    terminal = {"SUCCEEDED", "FAILED", "CANCELLED", "INSUFFICIENT_EVIDENCE"}
    while time.monotonic() < deadline:
        resp = await agent_client.get(f"/local/v1/runs/{run_id}")
        resp.raise_for_status()
        last = resp.json()
        if last["status"] in terminal:
            return last
        await asyncio.sleep(interval)
    raise TimeoutError(f"run {run_id} did not reach a terminal status within {timeout}s: {last}")


async def wait_for_run_status(
    agent_client: httpx.AsyncClient,
    run_id: str,
    status: str,
    *,
    timeout: float = 30.0,
    interval: float = 0.5,
) -> dict:
    """Like `wait_for_run_terminal` but waits for one specific status —
    needed for WAITING_FOR_USER (02-desktop-and-agent-runtime.md §5.3),
    which is not terminal and so `wait_for_run_terminal` would never stop
    on it."""
    deadline = time.monotonic() + timeout
    last: dict | None = None
    while time.monotonic() < deadline:
        resp = await agent_client.get(f"/local/v1/runs/{run_id}")
        resp.raise_for_status()
        last = resp.json()
        if last["status"] == status:
            return last
        await asyncio.sleep(interval)
    raise TimeoutError(f"run {run_id} did not reach status {status} within {timeout}s: {last}")


async def parse_sse_response(response: httpx.Response) -> list[tuple[str, dict]]:
    """Parse an already-open `text/event-stream` httpx streaming response
    into its full ordered (event, data) log. Shared by both the local-run
    events endpoint (GET, replay-from-start) and the Hosted Chat message
    endpoint (POST, single live stream) — both use the same
    `id:`/`event:`/`data:` wire framing (see agent-runtime's `runs.py`/
    `chat.py`)."""
    events: list[tuple[str, dict]] = []
    event_name: str | None = None
    data_lines: list[str] = []

    async def _flush() -> None:
        nonlocal event_name, data_lines
        if event_name is not None:
            raw = "".join(data_lines)
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = {"_raw": raw}
            events.append((event_name, payload))
        event_name = None
        data_lines = []

    async for line in response.aiter_lines():
        if line == "":
            await _flush()
            continue
        if line.startswith("id:"):
            continue
        if line.startswith("event:"):
            event_name = line[len("event:") :].strip()
        elif line.startswith("data:"):
            data_lines.append(line[len("data:") :].strip())
    await _flush()
    return events


async def stream_run_events(
    agent_client: httpx.AsyncClient, run_id: str, *, timeout: float = 120.0
) -> list[tuple[str, dict]]:
    """Consume `GET /local/v1/runs/{run_id}/events` (SSE) to completion and
    return the full ordered (event, data) log — needed to observe events
    (e.g. `mcp.call.started`/`mcp.call.completed`) that never appear in the
    final `RunResponse.output`. Omitting `Last-Event-ID` replays the full
    log from the start regardless of whether the run has already finished.
    """
    async with agent_client.stream(
        "GET", f"/local/v1/runs/{run_id}/events", timeout=timeout
    ) as response:
        response.raise_for_status()
        return await parse_sse_response(response)


# --- office-mcp-server helpers -----------------------------------------------


def mcp_audit_context(
    *,
    requested_tool: str,
    roles: list[str],
    trace_id: str | None = None,
    run_id: str | None = None,
    service_id: str | None = None,
    user_id: str = "e2e-test-user",
    org: str = "miracom",
    site: str = "headquarters",
    agent_id: str = "550e8400-e29b-41d4-a716-446655440011",
    agent_version: str = "1.0.0",
) -> dict:
    """Build a `RequestContext`-shaped `audit_context` for a direct
    `POST /mcp/v1/tools/{tool_name}/call` against office-mcp-server. Every
    field is required and `extra="forbid"` in the real schema — see
    `services/office-mcp-server/src/office_mcp_server/request_context.py`.
    """
    return {
        "request_id": str(uuid.uuid4()),
        "trace_id": trace_id or str(uuid.uuid4()),
        "run_id": run_id or str(uuid.uuid4()),
        "service_id": service_id or str(uuid.uuid4()),
        "service_version": "0.0.0-poc-unregistered",
        "agent_id": agent_id,
        "agent_version": agent_version,
        "user": {"id": user_id, "organization_id": org, "site_id": site, "roles": roles},
        "requested_tool": requested_tool,
    }


# --- Bundle checksum verification (Python port of
# apps/desktop-client/electron/bundle-verify.ts) ----------------------------
#
# `bundle-verify.ts` is a pure, Electron-free TypeScript module (no Electron
# API calls) — this is a line-for-line behavioral port of its
# `parseChecksumsFile`/`checkChecksums` so tests/e2e can exercise the same
# tamper/missing-file DETECTION logic the Desktop Client relies on, on a
# machine where Electron itself cannot launch (see E2E-03/E2E-04 skip
# reasons for the Desktop-side install/quarantine behavior this feeds).

_CHECKSUM_LINE_RE = re.compile(r"^([0-9a-fA-F]{64})\s+(.+)$")


def parse_checksums_file(content: str) -> dict[str, str]:
    """Port of `parseChecksumsFile`: arcname -> lower-cased sha256 hex."""
    declared: dict[str, str] = {}
    for line in content.splitlines():
        if not line.strip():
            continue
        match = _CHECKSUM_LINE_RE.match(line)
        if match:
            declared[match.group(2)] = match.group(1).lower()
    return declared


def check_checksums(
    declared: dict[str, str], zf: zipfile.ZipFile
) -> tuple[list[str], list[str]]:
    """Port of `checkChecksums`: returns (missing, mismatched) arcnames."""
    missing: list[str] = []
    mismatched: list[str] = []
    names = set(zf.namelist())
    for arcname, expected in declared.items():
        if arcname not in names:
            missing.append(arcname)
            continue
        actual = hashlib.sha256(zf.read(arcname)).hexdigest().lower()
        if actual != expected:
            mismatched.append(arcname)
    return missing, mismatched


# --- `make e2e-clean` standalone entry point --------------------------------
#
# Run as `uv run python -m tests.e2e.conftest` (see Makefile). A separate
# process has no tracked ids from any prior `make e2e-test` run, so this is
# necessarily the prefix-only sweep (`sweep_e2e_prefixed_artifacts`) -- the
# same one that already runs automatically as a safety net at the end of
# every `make e2e-test` session. Its purpose here is recovering pre-existing
# polluted state (e.g. from before this cleanup existed) without needing to
# run the full live-service E2E suite first.


def _main() -> None:
    summary = sweep_e2e_prefixed_artifacts()
    if not any(summary.values()):
        print(f"[e2e-clean] nothing to remove (checked {_db_path()}).")
    else:
        print(f"[e2e-clean] removed from {_db_path()}: {summary}")


if __name__ == "__main__":
    _main()
