"""Unit tests for the AssetVersion/ServiceVersion state machine — M11."""

from __future__ import annotations

import pytest
from security_policy import (
    InvalidTransitionError,
    VersionStatus,
    can_transition,
    is_mutable,
    require_transition,
)


def test_draft_can_move_to_in_review_or_ready_for_review() -> None:
    assert can_transition(VersionStatus.DRAFT, VersionStatus.IN_REVIEW)
    assert can_transition(VersionStatus.DRAFT, VersionStatus.READY_FOR_REVIEW)


def test_draft_cannot_jump_to_approved() -> None:
    assert not can_transition(VersionStatus.DRAFT, VersionStatus.APPROVED)


def test_in_review_can_go_to_changes_requested_rejected_or_approved() -> None:
    for target in (
        VersionStatus.CHANGES_REQUESTED,
        VersionStatus.REJECTED,
        VersionStatus.APPROVED,
    ):
        assert can_transition(VersionStatus.IN_REVIEW, target)


def test_changes_requested_returns_to_draft_or_back_into_review() -> None:
    assert can_transition(VersionStatus.CHANGES_REQUESTED, VersionStatus.DRAFT)
    assert can_transition(VersionStatus.CHANGES_REQUESTED, VersionStatus.IN_REVIEW)


def test_approved_is_illegal_to_re_enter() -> None:
    """승인 버전은 불변이다 — no path back into DRAFT/IN_REVIEW from APPROVED."""
    assert not can_transition(VersionStatus.APPROVED, VersionStatus.DRAFT)
    assert not can_transition(VersionStatus.APPROVED, VersionStatus.IN_REVIEW)
    assert not can_transition(VersionStatus.APPROVED, VersionStatus.CHANGES_REQUESTED)


def test_approved_can_only_go_to_deprecated_or_suspended() -> None:
    assert can_transition(VersionStatus.APPROVED, VersionStatus.DEPRECATED)
    assert can_transition(VersionStatus.APPROVED, VersionStatus.SUSPENDED)
    assert not can_transition(VersionStatus.APPROVED, VersionStatus.RETIRED)


def test_deprecated_can_only_retire() -> None:
    assert can_transition(VersionStatus.DEPRECATED, VersionStatus.RETIRED)
    assert not can_transition(VersionStatus.DEPRECATED, VersionStatus.APPROVED)


@pytest.mark.parametrize(
    "terminal",
    [VersionStatus.REJECTED, VersionStatus.SUSPENDED, VersionStatus.RETIRED],
)
def test_terminal_statuses_have_no_outgoing_transitions(terminal: VersionStatus) -> None:
    for target in VersionStatus:
        assert not can_transition(terminal, target)


def test_require_transition_raises_with_current_and_target() -> None:
    with pytest.raises(InvalidTransitionError) as exc_info:
        require_transition(VersionStatus.APPROVED, VersionStatus.DRAFT)
    assert exc_info.value.current is VersionStatus.APPROVED
    assert exc_info.value.target is VersionStatus.DRAFT


def test_require_transition_is_silent_when_legal() -> None:
    require_transition(VersionStatus.DRAFT, VersionStatus.IN_REVIEW)  # must not raise


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (VersionStatus.DRAFT, True),
        (VersionStatus.CHANGES_REQUESTED, True),
        (VersionStatus.VALIDATING, False),
        (VersionStatus.READY_FOR_REVIEW, False),
        (VersionStatus.IN_REVIEW, False),
        (VersionStatus.REJECTED, False),
        (VersionStatus.APPROVED, False),
        (VersionStatus.SUSPENDED, False),
        (VersionStatus.DEPRECATED, False),
        (VersionStatus.RETIRED, False),
    ],
)
def test_is_mutable_matches_spec_allowed_actions(status: VersionStatus, expected: bool) -> None:
    """§4.1: only DRAFT (편집·삭제·검증) and CHANGES_REQUESTED (편집·재검증)
    permit in-place edits; APPROVED/SUSPENDED/DEPRECATED/RETIRED/IN_REVIEW
    must all be immutable (this is what blocks editing an approved
    version's chunk-tags in M02)."""
    assert is_mutable(status) is expected
