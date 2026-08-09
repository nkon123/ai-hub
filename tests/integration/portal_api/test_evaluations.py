"""Integration tests for the M02 Knowledge Evaluation API (P12 Knowledge 품질).

Covers: happy path (create -> background job completes synchronously against
a faked `EvaluationCaller` -> list/detail), empty list (no evaluations yet),
RBAC denial (+ audit row), per-case content visibility (the stored
evaluation result carries no document content, so `per_case` is never
masked for any role — see open-decisions.md D-056), and validation failure
(no Evaluation Dataset registered for the Knowledge Asset).

`evaluation_runner.run_evaluation`/`HttpSearchClient` are never invoked here
— `get_evaluation_caller` is overridden with a fake, same pattern as
`test_distributions.py`'s `get_distribution_caller` override, so nothing in
this file depends on search-runtime actually running.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from portal_api.auth import UserContext, get_current_user
from portal_api.main import app
from portal_api.models import Asset, AuditEvent, EvaluationResultRecord
from portal_api.routers.evaluations import get_evaluation_caller, get_session_factory
from sqlalchemy import select

from tests.integration.portal_api.conftest import auth_header, make_indexed_knowledge

_DATASET_ID = "test-eval-dataset"


def _write_dataset(
    tmp_path, knowledge_asset_id: str, *, review_status: str = "AI_GENERATED_UNREVIEWED"
):
    folder = tmp_path / "test-knowledge"
    folder.mkdir(parents=True, exist_ok=True)
    dataset = {
        "schema_version": "1.0",
        "type": "evaluation_dataset",
        "dataset_id": _DATASET_ID,
        "name": "테스트 평가 데이터셋",
        "version": "1.0.0",
        "knowledge_asset_id": knowledge_asset_id,
        "review_status": review_status,
        "cases": [
            {
                "case_id": "T-001",
                "question": "테스트 질문입니다 — 원문 정책 문구를 포함합니다.",
                "expected_document_ids": ["remote-work-policy"],
            }
        ],
    }
    (folder / "evaluation-dataset.json").write_text(json.dumps(dataset, ensure_ascii=False))
    return dataset


def _fake_result_payload(*, knowledge_id: str, gate_passed: bool = True) -> dict:
    return {
        "schema_version": "1.0",
        "type": "evaluation_result",
        "result_id": "11111111-1111-1111-1111-111111111111",
        "knowledge_asset_version_id": knowledge_id,
        "dataset_id": _DATASET_ID,
        "dataset_version": "1.0.0",
        "evaluated_at": datetime.now(UTC).isoformat(),
        "run_id": "22222222-2222-2222-2222-222222222222",
        "retrieval_settings": {"top_k": 5, "alpha": 0.5, "knowledge_version": "latest"},
        "metrics": {
            "case_count": 1,
            "cases_with_ground_truth": 1,
            "recall_at_1": 1.0,
            "recall_at_5": 1.0,
            "mrr": 1.0,
            "no_result_rate": 0.0,
            "latency_p50_ms": 120.0,
            "latency_p95_ms": 180.0,
            "avg_context_tokens": 256.0,
            "forbidden_hit_rate": 0.0,
        },
        "gate": {
            "passed": gate_passed,
            "checks": [
                {
                    "name": "recall_at_5_min",
                    "passed": gate_passed,
                    "actual": 1.0,
                    "threshold": 0.8,
                    "comparison": ">=",
                    "message": "Recall@5 100%는 기준 80% 이상 충족",
                }
            ],
        },
        "per_case": [
            {
                "case_id": "T-001",
                "question": "테스트 질문입니다 — 원문 정책 문구를 포함합니다.",
                "expected_document_ids": ["remote-work-policy"],
                "retrieved_document_ids": ["remote-work-policy"],
                "hit_at_1": True,
                "hit_at_5": True,
                "reciprocal_rank": 1.0,
                "latency_ms": 120,
                "returned_count": 1,
                "context_tokens": 256,
                "forbidden_hit": False,
                "tags": [],
            }
        ],
    }


@pytest.fixture(autouse=True)
def override_session_factory(session_factory):
    """`_run_evaluation_job` opens its own DB session — point it at this
    test's isolated in-memory engine (see test_distributions.py's identical
    fixture for the full rationale)."""
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    yield
    app.dependency_overrides.pop(get_session_factory, None)


@pytest.fixture
def fake_caller_result():
    """Mutable holder so a test can swap in a different payload before the
    request is made."""
    return {"payload": None}


@pytest.fixture
def override_evaluation_caller(fake_caller_result):
    calls: list[dict] = []

    async def _fake_caller(*, dataset, knowledge_id, policy, baseline_recall_at_5):
        calls.append(
            {
                "dataset_id": dataset.dataset_id,
                "knowledge_id": knowledge_id,
                "baseline_recall_at_5": baseline_recall_at_5,
            }
        )
        return fake_caller_result["payload"] or _fake_result_payload(knowledge_id=knowledge_id)

    app.dependency_overrides[get_evaluation_caller] = lambda: _fake_caller
    yield calls
    app.dependency_overrides.pop(get_evaluation_caller, None)


@pytest.fixture
def override_evaluation_caller_error():
    async def _fake_caller(*, dataset, knowledge_id, policy, baseline_recall_at_5):
        raise RuntimeError("simulated search-runtime failure")

    app.dependency_overrides[get_evaluation_caller] = lambda: _fake_caller
    yield
    app.dependency_overrides.pop(get_evaluation_caller, None)


@pytest.fixture
def dataset_fixture_root(monkeypatch, tmp_path):
    """Points `settings.evaluation_fixtures_root` (the PoC dataset discovery
    convention, open-decisions.md D-055) at an isolated tmp_path instead of
    the repo's real `fixtures/valid/` — tests never depend on / mutate the
    real hr-policy-knowledge fixture."""
    from portal_api.config import settings
    from portal_api.routers import evaluations as evaluations_module

    monkeypatch.setattr(settings, "evaluation_fixtures_root", tmp_path)
    assert evaluations_module.settings is settings  # same singleton, sanity check
    return tmp_path


async def _create_indexed_knowledge_with_dataset(db, dataset_fixture_root, **dataset_kwargs):
    version = await make_indexed_knowledge(db)
    _write_dataset(dataset_fixture_root, version.asset_id, **dataset_kwargs)
    return version


class TestCreateEvaluation:
    async def test_happy_path_completes_synchronously_and_is_listed(
        self, client, db, dataset_fixture_root, override_evaluation_caller
    ):
        version = await _create_indexed_knowledge_with_dataset(db, dataset_fixture_root)

        res = await client.post(
            f"/api/v1/assets/{version.asset_id}/versions/{version.id}/evaluations",
            headers=auth_header("dev-user-token"),  # CREATOR, owner
        )
        assert res.status_code == 202
        body = res.json()
        evaluation_id = body["id"]
        assert body["status"] in ("PENDING", "RUNNING", "COMPLETED")
        assert len(override_evaluation_caller) == 1  # the fake caller was actually invoked

        record = (
            await db.execute(
                select(EvaluationResultRecord).where(EvaluationResultRecord.id == evaluation_id)
            )
        ).scalar_one()
        assert record.status == "COMPLETED"
        assert record.gate_passed is True
        assert record.dataset_id == _DATASET_ID

        list_res = await client.get(
            f"/api/v1/assets/{version.asset_id}/versions/{version.id}/evaluations",
            headers=auth_header("dev-user-token"),
        )
        assert list_res.status_code == 200
        items = list_res.json()["items"]
        assert len(items) == 1
        assert items[0]["id"] == evaluation_id
        assert items[0]["status"] == "COMPLETED"

    async def test_reviewer_role_can_run_without_owning_asset(
        self, client, db, dataset_fixture_root, override_evaluation_caller
    ):
        version = await _create_indexed_knowledge_with_dataset(db, dataset_fixture_root)

        res = await client.post(
            f"/api/v1/assets/{version.asset_id}/versions/{version.id}/evaluations",
            headers=auth_header("dev-reviewer-token"),  # TECH_REVIEWER, not the owner
        )
        assert res.status_code == 202

    async def test_failed_search_client_marks_evaluation_failed(
        self, client, db, dataset_fixture_root, override_evaluation_caller_error
    ):
        version = await _create_indexed_knowledge_with_dataset(db, dataset_fixture_root)

        res = await client.post(
            f"/api/v1/assets/{version.asset_id}/versions/{version.id}/evaluations",
            headers=auth_header("dev-user-token"),
        )
        assert res.status_code == 202
        evaluation_id = res.json()["id"]

        detail = await client.get(
            f"/api/v1/evaluations/{evaluation_id}", headers=auth_header("dev-user-token")
        )
        assert detail.status_code == 200
        assert detail.json()["status"] == "FAILED"
        assert "실패" in detail.json()["error_message"]

    async def test_rbac_denial_non_owner_creator_is_audited(
        self, client, db, dataset_fixture_root, override_evaluation_caller
    ):
        """A CREATOR who does not own the Knowledge Asset cannot run an
        evaluation on it — task brief item 4 ("owning CREATOR for running")."""
        version = await _create_indexed_knowledge_with_dataset(db, dataset_fixture_root)

        asset = (
            await db.execute(select(Asset).where(Asset.id == version.asset_id))
        ).scalar_one()
        asset.owner_creator_id = "someone-else@miracom.com"
        await db.commit()

        res = await client.post(
            f"/api/v1/assets/{version.asset_id}/versions/{version.id}/evaluations",
            headers=auth_header("dev-user-token"),
        )
        assert res.status_code == 403
        assert res.json()["error"]["code"] == "PERMISSION_DENIED"
        assert len(override_evaluation_caller) == 0  # never reached the job

        audit_rows = (
            await db.execute(
                select(AuditEvent).where(AuditEvent.event_type == "EVALUATION_RUN_DENIED")
            )
        ).scalars().all()
        assert len(audit_rows) == 1
        assert audit_rows[0].result == "DENIED"

    async def test_rbac_denial_auditor_cannot_run(
        self, client, db, dataset_fixture_root, override_evaluation_caller
    ):
        version = await _create_indexed_knowledge_with_dataset(db, dataset_fixture_root)

        res = await client.post(
            f"/api/v1/assets/{version.asset_id}/versions/{version.id}/evaluations",
            headers=auth_header("dev-auditor-token"),
        )
        assert res.status_code == 403
        assert res.json()["error"]["code"] == "PERMISSION_DENIED"

        audit_rows = (
            await db.execute(
                select(AuditEvent).where(
                    AuditEvent.event_type == "PERMISSION_DENIED:EVALUATION_RUN"
                )
            )
        ).scalars().all()
        assert len(audit_rows) == 1

    async def test_no_dataset_registered_returns_validation_error(
        self, client, db, dataset_fixture_root, override_evaluation_caller
    ):
        """No `evaluation-dataset.json` matches this Knowledge Asset's id —
        the D-055 PoC discovery convention finds nothing."""
        version = await make_indexed_knowledge(db)

        res = await client.post(
            f"/api/v1/assets/{version.asset_id}/versions/{version.id}/evaluations",
            headers=auth_header("dev-user-token"),
        )
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "EVALUATION_DATASET_NOT_FOUND"
        assert len(override_evaluation_caller) == 0

    async def test_not_indexed_returns_validation_error(
        self, client, db, dataset_fixture_root, override_evaluation_caller
    ):
        version = await make_indexed_knowledge(db, indexed=False)
        _write_dataset(dataset_fixture_root, version.asset_id)

        res = await client.post(
            f"/api/v1/assets/{version.asset_id}/versions/{version.id}/evaluations",
            headers=auth_header("dev-user-token"),
        )
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "VALIDATION_ERROR"


class TestListEvaluations:
    async def test_empty_before_any_run(self, client, db):
        version = await make_indexed_knowledge(db)

        res = await client.get(
            f"/api/v1/assets/{version.asset_id}/versions/{version.id}/evaluations",
            headers=auth_header("dev-user-token"),
        )
        assert res.status_code == 200
        assert res.json()["items"] == []


class TestGetEvaluationPerCaseNotMasked:
    """P12 says '운영 사용자가 원문 전체를 볼 권한이 없다면 평가 결과에서도
    문서 내용을 마스킹한다', but `evaluation-result.schema.json`'s `per_case[]`
    carries no document content at all — only ids, verdicts, and timings
    (open-decisions.md D-056). So every authenticated role, regardless of
    `EVALUATION_SOURCE_VIEW`, sees the identical `per_case` table; only
    `source_masking_note` explains why nothing is redacted."""

    async def _create_completed_evaluation(
        self, client, db, dataset_fixture_root, override_evaluation_caller
    ):
        version = await _create_indexed_knowledge_with_dataset(db, dataset_fixture_root)
        res = await client.post(
            f"/api/v1/assets/{version.asset_id}/versions/{version.id}/evaluations",
            headers=auth_header("dev-user-token"),
        )
        return res.json()["id"]

    async def test_creator_owner_sees_full_per_case_table(
        self, client, db, dataset_fixture_root, override_evaluation_caller
    ):
        evaluation_id = await self._create_completed_evaluation(
            client, db, dataset_fixture_root, override_evaluation_caller
        )
        res = await client.get(
            f"/api/v1/evaluations/{evaluation_id}", headers=auth_header("dev-user-token")
        )
        assert res.status_code == 200
        body = res.json()
        assert body["source_masking_note"]
        assert "question_masked" not in body["per_case"][0]
        assert body["per_case"][0]["question"] == "테스트 질문입니다 — 원문 정책 문구를 포함합니다."
        assert body["per_case"][0]["expected_document_ids"] == ["remote-work-policy"]
        assert body["per_case"][0]["hit_at_5"] is True

    async def test_auditor_sees_full_per_case_table_too(
        self, client, db, dataset_fixture_root, override_evaluation_caller
    ):
        """AUDITOR lacks EVALUATION_SOURCE_VIEW (open-decisions.md D-056),
        but that permission has no target today — AUDITOR sees the exact
        same `per_case` content as CREATOR, unlike P14's audit log content
        masking (a different control, over a field that does carry document
        text)."""
        evaluation_id = await self._create_completed_evaluation(
            client, db, dataset_fixture_root, override_evaluation_caller
        )
        res = await client.get(
            f"/api/v1/evaluations/{evaluation_id}", headers=auth_header("dev-auditor-token")
        )
        assert res.status_code == 200
        body = res.json()
        assert body["source_masking_note"]
        case = body["per_case"][0]
        assert case["question"] == "테스트 질문입니다 — 원문 정책 문구를 포함합니다."
        assert case["expected_document_ids"] == ["remote-work-policy"]
        assert case["retrieved_document_ids"] == ["remote-work-policy"]
        assert case["hit_at_1"] is True
        assert case["hit_at_5"] is True
        assert case["forbidden_hit"] is False

    async def test_plain_user_role_sees_full_per_case_table(
        self, client, db, dataset_fixture_root, override_evaluation_caller
    ):
        """P12's display requirement ('평가 질문별 기대 문서와 검색 결과')
        names 전체 as its audience. `Role.USER` also lacks
        `EVALUATION_SOURCE_VIEW` (`security_policy.roles.ROLE_PERMISSIONS`),
        and the Test Identity Adapter has no `dev-*-token` for a pure USER
        role (open-decisions.md D-056), so this overrides `get_current_user`
        directly — the same dependency-override seam already used for
        `get_evaluation_caller`/`get_session_factory` — instead of adding a
        new token. This is the P12 requirement this correction restores: a
        non-privileged role must not see an emptied-out main table."""
        evaluation_id = await self._create_completed_evaluation(
            client, db, dataset_fixture_root, override_evaluation_caller
        )

        app.dependency_overrides[get_current_user] = lambda: UserContext(
            user_id="plain-user@miracom.com",
            org="miracom",
            site="headquarters",
            role="USER",
            display_name="일반 사용자",
        )
        try:
            res = await client.get(f"/api/v1/evaluations/{evaluation_id}", headers=auth_header())
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert res.status_code == 200
        body = res.json()
        assert body["source_masking_note"]
        case = body["per_case"][0]
        assert case["question"] == "테스트 질문입니다 — 원문 정책 문구를 포함합니다."
        assert case["expected_document_ids"] == ["remote-work-policy"]
        assert case["retrieved_document_ids"] == ["remote-work-policy"]
        assert case["hit_at_1"] is True
        assert case["hit_at_5"] is True
        assert case["forbidden_hit"] is False

    async def test_known_limitations_reflect_ai_generated_dataset(
        self, client, db, dataset_fixture_root, override_evaluation_caller
    ):
        evaluation_id = await self._create_completed_evaluation(
            client, db, dataset_fixture_root, override_evaluation_caller
        )
        res = await client.get(
            f"/api/v1/evaluations/{evaluation_id}", headers=auth_header("dev-user-token")
        )
        limitations = res.json()["known_limitations"]
        assert any("AI_GENERATED_UNREVIEWED" in line for line in limitations)
        assert any("ACL Test" in line for line in limitations)

    async def test_comparison_unavailable_for_first_version(
        self, client, db, dataset_fixture_root, override_evaluation_caller
    ):
        evaluation_id = await self._create_completed_evaluation(
            client, db, dataset_fixture_root, override_evaluation_caller
        )
        res = await client.get(
            f"/api/v1/evaluations/{evaluation_id}", headers=auth_header("dev-user-token")
        )
        comparison = res.json()["comparison"]
        assert comparison["available"] is False
        assert comparison["reason"]


class TestEvaluationNotes:
    async def test_reviewer_can_record_note(
        self, client, db, dataset_fixture_root, override_evaluation_caller
    ):
        version = await _create_indexed_knowledge_with_dataset(db, dataset_fixture_root)
        create_res = await client.post(
            f"/api/v1/assets/{version.asset_id}/versions/{version.id}/evaluations",
            headers=auth_header("dev-user-token"),
        )
        evaluation_id = create_res.json()["id"]

        res = await client.post(
            f"/api/v1/evaluations/{evaluation_id}/notes",
            headers=auth_header("dev-reviewer-token"),
            json={"reason": "Recall@5가 기준에 미달하여 재인덱싱이 필요합니다."},
        )
        assert res.status_code == 201
        body = res.json()
        assert body["reason"] == "Recall@5가 기준에 미달하여 재인덱싱이 필요합니다."
        assert body["author_role"] == "TECH_REVIEWER"

        detail = await client.get(
            f"/api/v1/evaluations/{evaluation_id}", headers=auth_header("dev-user-token")
        )
        assert len(detail.json()["notes"]) == 1

    async def test_creator_cannot_record_note(
        self, client, db, dataset_fixture_root, override_evaluation_caller
    ):
        """P12: only reviewers record 기준 미달 사유, not the asset owner
        (task brief item 4 — CREATOR gets EVALUATION_RUN but not
        EVALUATION_NOTE)."""
        version = await _create_indexed_knowledge_with_dataset(db, dataset_fixture_root)
        create_res = await client.post(
            f"/api/v1/assets/{version.asset_id}/versions/{version.id}/evaluations",
            headers=auth_header("dev-user-token"),
        )
        evaluation_id = create_res.json()["id"]

        res = await client.post(
            f"/api/v1/evaluations/{evaluation_id}/notes",
            headers=auth_header("dev-user-token"),
            json={"reason": "사유"},
        )
        assert res.status_code == 403

    async def test_blank_reason_is_rejected(
        self, client, db, dataset_fixture_root, override_evaluation_caller
    ):
        version = await _create_indexed_knowledge_with_dataset(db, dataset_fixture_root)
        create_res = await client.post(
            f"/api/v1/assets/{version.asset_id}/versions/{version.id}/evaluations",
            headers=auth_header("dev-user-token"),
        )
        evaluation_id = create_res.json()["id"]

        res = await client.post(
            f"/api/v1/evaluations/{evaluation_id}/notes",
            headers=auth_header("dev-reviewer-token"),
            json={"reason": "   "},
        )
        assert res.status_code == 400
