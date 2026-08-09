"""Unit tests for the sequential TECHNICAL→SECURITY→RELEASE review chain — M11."""

from __future__ import annotations

import pytest
from security_policy import (
    NEXT_STAGE,
    STAGE_PERMISSION,
    Permission,
    ReviewDecisionType,
    ReviewStatus,
    Stage,
    VersionStatus,
    resolve_review_decision,
)


def test_stage_chain_order() -> None:
    assert NEXT_STAGE[Stage.TECHNICAL] is Stage.SECURITY
    assert NEXT_STAGE[Stage.SECURITY] is Stage.RELEASE
    assert NEXT_STAGE[Stage.RELEASE] is None


def test_stage_permission_mapping() -> None:
    assert STAGE_PERMISSION[Stage.TECHNICAL] is Permission.REVIEW_DECIDE_TECHNICAL
    assert STAGE_PERMISSION[Stage.SECURITY] is Permission.REVIEW_DECIDE_SECURITY
    assert STAGE_PERMISSION[Stage.RELEASE] is Permission.REVIEW_DECIDE_RELEASE


def test_approve_at_technical_opens_security_and_keeps_version_in_review() -> None:
    outcome = resolve_review_decision(Stage.TECHNICAL, ReviewDecisionType.APPROVE)
    assert outcome.review_status is ReviewStatus.APPROVED
    assert outcome.version_status is VersionStatus.IN_REVIEW
    assert outcome.next_stage is Stage.SECURITY


def test_approve_at_security_opens_release_and_keeps_version_in_review() -> None:
    outcome = resolve_review_decision(Stage.SECURITY, ReviewDecisionType.APPROVE)
    assert outcome.review_status is ReviewStatus.APPROVED
    assert outcome.version_status is VersionStatus.IN_REVIEW
    assert outcome.next_stage is Stage.RELEASE


def test_approve_at_release_finalizes_version_as_approved() -> None:
    outcome = resolve_review_decision(Stage.RELEASE, ReviewDecisionType.APPROVE)
    assert outcome.review_status is ReviewStatus.APPROVED
    assert outcome.version_status is VersionStatus.APPROVED
    assert outcome.next_stage is None


@pytest.mark.parametrize("stage", list(Stage))
def test_reject_at_any_stage_terminates_the_chain(stage: Stage) -> None:
    outcome = resolve_review_decision(stage, ReviewDecisionType.REJECT)
    assert outcome.review_status is ReviewStatus.REJECTED
    assert outcome.version_status is VersionStatus.REJECTED
    assert outcome.next_stage is None


@pytest.mark.parametrize("stage", list(Stage))
def test_request_changes_at_any_stage_sends_version_back_to_changes_requested(
    stage: Stage,
) -> None:
    outcome = resolve_review_decision(stage, ReviewDecisionType.REQUEST_CHANGES)
    assert outcome.review_status is ReviewStatus.CHANGES_REQUESTED
    assert outcome.version_status is VersionStatus.CHANGES_REQUESTED
    assert outcome.next_stage is None
