"""E2E-07 — Knowledge Version 회귀 (06-quality-delivery.md §8).

Drives `packages/evaluation-runner` as a library (not a subprocess) against
the LIVE search-runtime (:8300), per the task brief. Honest caveat, carried
over verbatim from open-decisions.md D-045: the evaluation dataset used here
(`fixtures/valid/hr-policy-knowledge/evaluation-dataset.json`) is
`AI_GENERATED_UNREVIEWED` with only 6 cases — this test demonstrates the
Quality Gate *mechanism* blocks a knowingly-bad candidate, it does not claim
the dataset itself is an authoritative quality bar yet.

  1. "1.0 평가 기준 저장"       -> `baseline`: real evaluation of the
     seeded, live-indexed, APPROVED Knowledge (`APPROVED_KNOWLEDGE_VERSION_ID`)
     against real search-runtime.
  2. "1.1 후보 생성"            -> `candidate`: a deliberately broken
     candidate — an unindexed knowledge_id (search-runtime's hybrid search
     short-circuits to `[]` when no index exists on disk for that id, see
     `hybrid.py`), standing in for a real bad re-index without touching the
     seeded knowledge's actual index files.
  3. "동일 Dataset 평가"        -> both runs use the exact same
     `EvaluationDataset` object/version.
  4. "Recall 기준 미달"         -> asserted directly on the candidate's
     Quality Gate result.
  5. "승인 차단과 비교 Report 확인" -> `evaluation_runner.comparison.compare_versions`
     produces a `ComparisonReport` whose `recommendation` is the PoC's
     literal block signal ("게시 차단") — there is no live Portal workflow
     wired to enforce this gate automatically (a real, separate gap; see
     the skip test below), so this test verifies the Gate/Report primitives
     Portal *would* need to consult, not an end-to-end Portal block.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from evaluation_runner.comparison import compare_versions
from evaluation_runner.quality_gate import load_policy
from evaluation_runner.runner import load_dataset, run_evaluation
from evaluation_runner.search_client import HttpSearchClient

from tests.e2e.conftest import APPROVED_KNOWLEDGE_VERSION_ID, SEARCH_RUNTIME_URL

pytestmark = pytest.mark.e2e

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DATASET_PATH = (
    _REPO_ROOT / "fixtures" / "valid" / "hr-policy-knowledge" / "evaluation-dataset.json"
)
_QUALITY_GATE_PATH = (
    _REPO_ROOT / "packages" / "evaluation-runner" / "config" / "quality-gate.yaml"
)

# Never indexed on disk -- search-runtime's hybrid_search returns []
# immediately when data/indexes/{knowledge_id}/bm25/ does not exist,
# deterministically producing recall_at_5 == 0.0 without touching any real
# knowledge id's index files.
_NEVER_INDEXED_KNOWLEDGE_ID = "00000000-0000-0000-0000-000000000000"


async def test_e2e_07_quality_gate_blocks_a_knowingly_bad_candidate() -> None:
    assert _DATASET_PATH.exists(), f"missing fixture: {_DATASET_PATH}"
    dataset = load_dataset(_DATASET_PATH)
    assert dataset.review_status == "AI_GENERATED_UNREVIEWED", (
        "honest-caveat guard: this dataset must stay flagged unreviewed until a "
        "domain expert signs off (04-knowledge-platform.md §4.3) -- if this assert "
        "fails, the fixture's review_status changed and this test's docstring caveat "
        "needs updating too."
    )
    policy = load_policy(_QUALITY_GATE_PATH)
    client = HttpSearchClient(base_url=SEARCH_RUNTIME_URL, timeout_seconds=30.0)

    # Step 1: "1.0" baseline -- real evaluation against the real, live,
    # already-indexed, APPROVED seeded Knowledge.
    baseline = await run_evaluation(
        search_client=client,
        dataset=dataset,
        knowledge_id=APPROVED_KNOWLEDGE_VERSION_ID,
        knowledge_version="1.0.0",
        top_k=5,
        alpha=0.5,
        policy=policy,
    )

    # Step 2/3: "1.1" candidate -- same dataset, deliberately-empty index.
    candidate = await run_evaluation(
        search_client=client,
        dataset=dataset,
        knowledge_id=_NEVER_INDEXED_KNOWLEDGE_ID,
        knowledge_version="1.1.0",
        top_k=5,
        alpha=0.5,
        policy=policy,
    )

    # Step 4: Recall 기준 미달 -- deterministic, not a flaky real-content check.
    assert candidate.metrics.recall_at_5 == 0.0, candidate.metrics.to_dict()
    assert not candidate.gate.passed, candidate.gate.to_dict()
    failed_names = {c.name for c in candidate.gate.failed_checks}
    assert "recall_at_5_min" in failed_names, candidate.gate.to_dict()

    # Step 5: 승인 차단과 비교 Report 확인.
    report = compare_versions(baseline, candidate)
    assert report.recall_at_5_delta < 0, report.to_dict()
    assert report.recommendation == "게시 차단", report.to_dict()
    assert report.blocking_reasons, "expected at least one blocking reason from the failed gate"


def test_e2e_07_step5_portal_approval_gate_integration_not_wired() -> None:
    pytest.skip(
        "E2E-07 step 5's 'Portal 승인 차단' half (an actual Portal review/approval "
        "action refusing to proceed because of a failed Quality Gate result) is not "
        "wired up: packages/evaluation-runner has no caller inside "
        "apps/portal-api/src/portal_api/routers/reviews.py today -- Knowledge "
        "AssetVersion approval only checks the TECHNICAL/SECURITY/RELEASE review chain "
        "(security_policy), never an evaluation result. The Quality Gate/ComparisonReport "
        "PRIMITIVES this integration would need to consult are verified end-to-end above."
    )
