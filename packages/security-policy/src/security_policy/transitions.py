"""AssetVersion/ServiceVersion state machine — M11.

`is_mutable` is the concrete enforcement of CLAUDE.md's "승인 Version을
수정하는 Update 코드를 만들지 않는다" and the registry rule "승인 버전은
불변이다" (01-portal-and-distribution.md §3.3): once a version leaves
DRAFT/CHANGES_REQUESTED it can never be edited in place again, only
transitioned or replaced by a new version.
"""

from __future__ import annotations

from enum import StrEnum


class VersionStatus(StrEnum):
    DRAFT = "DRAFT"
    VALIDATING = "VALIDATING"
    READY_FOR_REVIEW = "READY_FOR_REVIEW"
    IN_REVIEW = "IN_REVIEW"
    CHANGES_REQUESTED = "CHANGES_REQUESTED"
    REJECTED = "REJECTED"
    APPROVED = "APPROVED"
    SUSPENDED = "SUSPENDED"
    DEPRECATED = "DEPRECATED"
    RETIRED = "RETIRED"


class InvalidTransitionError(Exception):
    """Package-local — never `fastapi.HTTPException`."""

    def __init__(self, current: VersionStatus, target: VersionStatus) -> None:
        self.current = current
        self.target = target
        super().__init__(f"Cannot transition from {current.value} to {target.value}")


# 07-data-api-contracts.md §4.1 / 01-portal-and-distribution.md §3.5:
#   DRAFT → READY_FOR_REVIEW → IN_REVIEW ├→ CHANGES_REQUESTED → DRAFT
#                                        ├→ REJECTED
#                                        └→ APPROVED → DEPRECATED → RETIRED
#                                                    └→ SUSPENDED
# `submit` (M02) moves DRAFT/CHANGES_REQUESTED straight to IN_REVIEW, so both
# are allowed here; READY_FOR_REVIEW remains a valid intermediate status for
# future explicit "mark ready" steps. VALIDATING mirrors the same shape.
ALLOWED_TRANSITIONS: dict[VersionStatus, frozenset[VersionStatus]] = {
    VersionStatus.DRAFT: frozenset({VersionStatus.READY_FOR_REVIEW, VersionStatus.IN_REVIEW}),
    VersionStatus.VALIDATING: frozenset({VersionStatus.READY_FOR_REVIEW, VersionStatus.DRAFT}),
    VersionStatus.READY_FOR_REVIEW: frozenset({VersionStatus.IN_REVIEW}),
    VersionStatus.IN_REVIEW: frozenset(
        {
            VersionStatus.CHANGES_REQUESTED,
            VersionStatus.REJECTED,
            VersionStatus.APPROVED,
        }
    ),
    VersionStatus.CHANGES_REQUESTED: frozenset({VersionStatus.DRAFT, VersionStatus.IN_REVIEW}),
    VersionStatus.REJECTED: frozenset(),
    VersionStatus.APPROVED: frozenset({VersionStatus.DEPRECATED, VersionStatus.SUSPENDED}),
    VersionStatus.SUSPENDED: frozenset(),
    VersionStatus.DEPRECATED: frozenset({VersionStatus.RETIRED}),
    VersionStatus.RETIRED: frozenset(),
}

# §4.1 "허용 행동": only DRAFT (편집·삭제·검증) and CHANGES_REQUESTED
# (편집·재검증) permit in-place edits.
MUTABLE_STATUSES: frozenset[VersionStatus] = frozenset(
    {
        VersionStatus.DRAFT,
        VersionStatus.CHANGES_REQUESTED,
    }
)


def can_transition(current: VersionStatus, target: VersionStatus) -> bool:
    return target in ALLOWED_TRANSITIONS.get(current, frozenset())


def require_transition(current: VersionStatus, target: VersionStatus) -> None:
    if not can_transition(current, target):
        raise InvalidTransitionError(current, target)


def is_mutable(status: VersionStatus) -> bool:
    return status in MUTABLE_STATUSES
