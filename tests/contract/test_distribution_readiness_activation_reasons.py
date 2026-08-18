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
from pathlib import Path

import pytest

from .conftest import API_DIR

SCHEMA_PATH = API_DIR / "knowledge-local-index.schema.json"


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
    """Every `activation_reason` value `distribution_readiness_checks` can
    emit, read from the module's own `REASON_*` constants.

    Reads the real values by import rather than by regexing source text.
    The earlier regex version broke the moment these constants were moved
    out of `routers/knowledge_diagnostics.py` into `knowledge_readiness.py`
    — and it broke by finding *nothing*, which would have made the real
    assertion below pass vacuously if the sanity check were not there. An
    import cannot drift that way: if the module or a name disappears, this
    fails loudly instead of quietly matching zero."""
    import portal_api.knowledge_readiness as readiness

    return {
        value
        for name, value in vars(readiness).items()
        if name.startswith("REASON_") and isinstance(value, str)
    }


def test_readiness_module_defines_at_least_one_reason(emitted_reasons: set[str]) -> None:
    # Guards the extraction itself — zero reasons would make the real
    # assertion below pass without checking anything.
    assert len(emitted_reasons) >= 5


def test_every_emitted_activation_reason_is_documented_in_the_contract(
    emitted_reasons: set[str], documented_reasons: set[str]
) -> None:
    undocumented = emitted_reasons - documented_reasons
    assert not undocumented, (
        f"distribution-readiness emits activation_reason(s) not documented in "
        f"{SCHEMA_PATH.name}'s RegisterLocalIndexResponse: {undocumented}"
    )


def test_every_declared_reason_is_actually_wired_into_a_check() -> None:
    """Belt-and-suspenders: a constant that is declared but never passed as
    `activation_reason=` would satisfy the contract test while predicting
    nothing in practice."""
    import portal_api.knowledge_readiness as readiness

    source = Path(readiness.__file__).read_text(encoding="utf-8")
    declared = [n for n in vars(readiness) if n.startswith("REASON_")]
    assert declared, "no REASON_* constants found in knowledge_readiness"
    for const in declared:
        assert f"activation_reason={const}" in source, (
            f"{const} is declared but never passed as activation_reason"
        )
