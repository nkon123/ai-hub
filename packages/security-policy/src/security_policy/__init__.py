"""Security Policy — M11: RBAC, version state machine, review stage chain.

Framework-free by design (no FastAPI/SQLAlchemy imports anywhere in this
package): `apps/portal-api` (M02) depends on this package for authorization
and workflow decisions; this package never depends back on M02 or any web
framework (CLAUDE.md 구현 원칙 2, 7).
"""

from security_policy.classification import (
    ACL_METADATA_FIELDS,
    CALLER_CLEARANCE_LEVELS,
    Classification,
    clearance_covers,
    parse_classification,
)
from security_policy.redaction import looks_like_secret, redact_if_secret
from security_policy.review import (
    NEXT_STAGE,
    STAGE_PERMISSION,
    ReviewDecisionType,
    ReviewOutcome,
    ReviewStatus,
    Stage,
    resolve_review_decision,
)
from security_policy.roles import (
    ROLE_PERMISSIONS,
    Permission,
    PermissionDeniedError,
    Role,
    has_permission,
    require_permission,
)
from security_policy.transitions import (
    ALLOWED_TRANSITIONS,
    MUTABLE_STATUSES,
    InvalidTransitionError,
    VersionStatus,
    can_transition,
    is_mutable,
    require_transition,
)

__all__ = [
    "Role",
    "Permission",
    "ROLE_PERMISSIONS",
    "has_permission",
    "require_permission",
    "PermissionDeniedError",
    "VersionStatus",
    "ALLOWED_TRANSITIONS",
    "MUTABLE_STATUSES",
    "can_transition",
    "require_transition",
    "is_mutable",
    "InvalidTransitionError",
    "Stage",
    "NEXT_STAGE",
    "STAGE_PERMISSION",
    "ReviewDecisionType",
    "ReviewStatus",
    "ReviewOutcome",
    "resolve_review_decision",
    "Classification",
    "CALLER_CLEARANCE_LEVELS",
    "ACL_METADATA_FIELDS",
    "parse_classification",
    "clearance_covers",
    "looks_like_secret",
    "redact_if_secret",
]
