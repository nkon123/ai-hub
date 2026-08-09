"""Sequential review stage chain — TECHNICAL → SECURITY → RELEASE (M11).

Pure policy: given the stage a `ReviewDecision` was made at and the decision
itself, `resolve_review_decision` returns what should happen to the
`ReviewRequest` and to the subject `AssetVersion`/`ServiceVersion` — no I/O,
no DB session, so M02 can unit-test its review endpoint against this
directly instead of re-deriving the rules.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from security_policy.roles import Permission
from security_policy.transitions import VersionStatus


class Stage(StrEnum):
    TECHNICAL = "TECHNICAL"
    SECURITY = "SECURITY"
    RELEASE = "RELEASE"


class ReviewDecisionType(StrEnum):
    APPROVE = "APPROVE"
    REJECT = "REJECT"
    REQUEST_CHANGES = "REQUEST_CHANGES"


class ReviewStatus(StrEnum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    CHANGES_REQUESTED = "CHANGES_REQUESTED"
    CANCELLED = "CANCELLED"


# TECHNICAL → SECURITY → RELEASE → (done)
NEXT_STAGE: dict[Stage, Stage | None] = {
    Stage.TECHNICAL: Stage.SECURITY,
    Stage.SECURITY: Stage.RELEASE,
    Stage.RELEASE: None,
}

# Which Permission a reviewer must hold to decide a given stage.
STAGE_PERMISSION: dict[Stage, Permission] = {
    Stage.TECHNICAL: Permission.REVIEW_DECIDE_TECHNICAL,
    Stage.SECURITY: Permission.REVIEW_DECIDE_SECURITY,
    Stage.RELEASE: Permission.REVIEW_DECIDE_RELEASE,
}


@dataclass(frozen=True)
class ReviewOutcome:
    review_status: ReviewStatus
    version_status: VersionStatus
    next_stage: Stage | None


def resolve_review_decision(stage: Stage, decision: ReviewDecisionType) -> ReviewOutcome:
    """What happens to the `ReviewRequest` and the subject version.

    - REJECT at any stage terminates the whole chain: version → REJECTED.
    - REQUEST_CHANGES at any stage sends the version back to the editable
      CHANGES_REQUESTED status and does not open a new stage review.
    - APPROVE advances to the next stage (version stays IN_REVIEW) or, at
      RELEASE (the last stage), finalizes the version as APPROVED.
    """
    if decision is ReviewDecisionType.REJECT:
        return ReviewOutcome(ReviewStatus.REJECTED, VersionStatus.REJECTED, None)
    if decision is ReviewDecisionType.REQUEST_CHANGES:
        return ReviewOutcome(ReviewStatus.CHANGES_REQUESTED, VersionStatus.CHANGES_REQUESTED, None)

    next_stage = NEXT_STAGE[stage]
    if next_stage is None:
        return ReviewOutcome(ReviewStatus.APPROVED, VersionStatus.APPROVED, None)
    return ReviewOutcome(ReviewStatus.APPROVED, VersionStatus.IN_REVIEW, next_stage)
