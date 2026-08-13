"""Drift guard for M02's D-079 반출 준비 상태 점검
(`GET /api/v1/assets/{asset_id}/versions/{version_id}/distribution-readiness`).

This endpoint *predicts* whether search-runtime's D-079 registration
(`POST /search/v1/local-indexes`) would accept this version's index after a
Desktop install — without importing anything from `services/search-runtime`
(CLAUDE.md 구현 원칙 2). The only thing connecting the two services is the
shared contract file, `knowledge-local-index.schema.json`'s
`RegisterLocalIndexResponse` description, which enumerates every reason
search-runtime actually raises.

If portal-api's prediction code ever names a reason that service doesn't
raise (or misspells one it does), the prediction goes silently wrong — a
version could be shown "반출 가능" and then genuinely fail to activate, or
the reverse. This test is the same style as
`tests/contract/test_knowledge_local_index_contract.py`'s
`test_every_documented_refusal_reason_is_actually_raised_somewhere`, applied
to the second implementer of this vocabulary.
"""

from __future__ import annotations

import json
import re

import pytest

from .conftest import API_DIR

SCHEMA_PATH = API_DIR / "knowledge-local-index.schema.json"
DIAGNOSTICS_SOURCE_PATH = (
    API_DIR.parent.parent.parent
    / "apps"
    / "portal-api"
    / "src"
    / "portal_api"
    / "routers"
    / "knowledge_diagnostics.py"
)


@pytest.fixture(scope="module")
def documented_reasons() -> set[str]:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    description = schema["definitions"]["RegisterLocalIndexResponse"]["description"]
    # Reasons are documented as `` `reason_name` `` (backtick-quoted single
    # tokens) throughout the description prose — extract every such token
    # that looks like a reason (snake_case, no spaces).
    return set(re.findall(r"`([a-z][a-z0-9_]*)`", description))


@pytest.fixture(scope="module")
def emitted_reasons() -> set[str]:
    """Every `activation_reason` value `_distribution_readiness_checks` can
    emit, extracted from its own `_REASON_*` constants — not re-typed by
    hand here, so a renamed constant can't silently desync this test from
    the actual source."""
    source = DIAGNOSTICS_SOURCE_PATH.read_text(encoding="utf-8")
    return set(re.findall(r'^_REASON_[A-Z0-9_]+ = "([a-z0-9_]+)"', source, re.MULTILINE))


def test_diagnostics_source_defines_at_least_one_reason(emitted_reasons: set[str]) -> None:
    # Sanity check on the extraction regex itself — if this ever finds
    # zero reasons, the real assertion below would pass vacuously.
    assert len(emitted_reasons) >= 5


def test_every_emitted_activation_reason_is_documented_in_the_contract(
    emitted_reasons: set[str], documented_reasons: set[str]
) -> None:
    undocumented = emitted_reasons - documented_reasons
    assert not undocumented, (
        f"distribution-readiness emits activation_reason(s) not documented in "
        f"{SCHEMA_PATH.name}'s RegisterLocalIndexResponse: {undocumented}"
    )


def test_every_emitted_reason_actually_appears_as_a_string_literal_in_the_router() -> None:
    """Belt-and-suspenders: confirm the reasons are wired into an actual
    `activation_reason=` call, not just declared as unused constants."""
    source = DIAGNOSTICS_SOURCE_PATH.read_text(encoding="utf-8")
    reason_constants = re.findall(r"^(_REASON_[A-Z0-9_]+) = ", source, re.MULTILINE)
    for const in reason_constants:
        assert f"activation_reason={const}" in source, (
            f"{const} is declared but never passed as activation_reason in the router"
        )
