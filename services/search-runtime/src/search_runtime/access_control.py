"""04-knowledge-platform.md §3.8 "Filter와 ACL" — enforcement lives here.

순서 (spec 그대로, main.py가 정확히 이 순서로 호출한다):

  1. 사용자 Access Context 검증           -> validate_access_context
  2. 강제 ACL Filter 생성                 -> forced_allowed_classifications
  3. Profile Default Filter 적용          -> (main.py: retrieval_profile.metadata_filters)
  4. 사용자가 요청한 허용 Filter 적용      -> (main.py: request.metadata_filters)
  5. 충돌 시 더 제한적인 조건 사용         -> merge_business_filters

steps 3/4 are just "which dict main.py passes in" — the actual merge with
conflict resolution (step 5) happens in one function, `merge_business_filters`,
so the "more restrictive wins" rule has exactly one implementation.

"사용자가 요청에서 ACL Field를 덮어쓸 수 없다" is enforced by
`reject_acl_override`, called against *both* candidate sources of a
`classification` value in the request (`metadata_filters` and an inline
`retrieval_profile.metadata_filters` — this PoC has no Profile Registry, so a
"resolved profile" is just more caller-supplied JSON in the same HTTP body;
see indexing-runtime's `profile: dict | None` D-053 precedent for the same
"caller supplies a possibly-partial profile dict directly" shape). It raises
rather than drops the key — a silent drop would hide an attempted override
from logs/response alike; see open-decisions.md D-062.

HONESTY ABOUT THE LIMIT (open-decisions.md D-062, D-015): search-runtime has
no authentication. `access_context.clearance` is asserted by whoever calls
this HTTP endpoint (agent-runtime, evaluation-runner, or anyone else with
network access to it) and is never verified against a real session/identity
— there is no identity layer in this PoC. Everything in this module makes a
*stated* clearance impossible to silently escalate via the request body; it
does not, by itself, guarantee only genuinely-authorized users see classified
content until a real identity layer exists upstream of agent-runtime.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from security_policy import (
    ACL_METADATA_FIELDS,
    Classification,
    clearance_covers,
    parse_classification,
)

from search_runtime.errors import ErrorCode

_CALLER_CLEARANCE_VALUES = frozenset(
    level.value
    for level in (
        Classification.PUBLIC_INTERNAL,
        Classification.INTERNAL,
        Classification.CONFIDENTIAL,
        Classification.RESTRICTED,
    )
)

# Sentinel meaning "no metadata value can ever satisfy this field" — see
# merge_business_filters.
_UNSATISFIABLE: frozenset[str] = frozenset()


class AccessControlError(Exception):
    """Raised for any §3.8 access-control rejection. Always maps to
    KNOWLEDGE_ACCESS_DENIED today (see errors.py module docstring) — `code`
    is still carried explicitly rather than hardcoded at the catch site, in
    case a future, more specific code is added to the central list."""

    def __init__(
        self, code: ErrorCode, message: str, *, details: dict[str, Any] | None = None
    ) -> None:
        self.code = code
        self.message = message
        self.details = details or {}
        super().__init__(f"{code.value}: {message}")


@dataclass(frozen=True)
class AccessContext:
    clearance: Classification
    user_id: str | None = None
    organization_id: str | None = None
    permissions: tuple[str, ...] = ()


def validate_access_context(raw: dict[str, Any] | None) -> AccessContext:
    """Step 1.

    - Missing entirely -> least-privilege default (`PUBLIC_INTERNAL`), not a
      rejection. This keeps the endpoint backward-compatible for callers
      that predate this feature (direct manual calls, older adapters) —
      "no context asserted" degrades to "see only the least-restricted
      documents," never to "see everything" and never to a hard failure that
      would take an entire caller offline. This is a deliberate compatibility
      choice, not a loophole: it is still fail-closed relative to every
      classified document.
    - Present but with a missing/unrecognized `clearance` -> rejected. An
      access_context that exists but asserts nonsense is treated as an
      integration bug, not an absent caller, and must be visible rather than
      silently downgraded.
    """
    if raw is None:
        return AccessContext(clearance=Classification.PUBLIC_INTERNAL)

    clearance_raw = raw.get("clearance")
    if clearance_raw not in _CALLER_CLEARANCE_VALUES:
        raise AccessControlError(
            ErrorCode.KNOWLEDGE_ACCESS_DENIED,
            "access_context.clearance가 없거나 알 수 없는 값입니다.",
            details={"reason": "invalid_clearance", "clearance": clearance_raw},
        )

    permissions = raw.get("permissions") or []
    return AccessContext(
        clearance=Classification(clearance_raw),
        user_id=raw.get("user_id"),
        organization_id=raw.get("organization_id"),
        permissions=tuple(permissions),
    )


def reject_acl_override(metadata_filters: dict[str, Any] | None, *, source: str) -> None:
    """§3.8: '사용자가 요청에서 ACL Field를 덮어쓸 수 없다.' Call this against
    every dict-shaped filter source before merging anything from it — never
    merge first and overwrite after, which would risk a code path that
    forgets to overwrite. Raises (never silently drops the key)."""
    if not metadata_filters:
        return
    overridden = ACL_METADATA_FIELDS.intersection(metadata_filters)
    if overridden:
        raise AccessControlError(
            ErrorCode.KNOWLEDGE_ACCESS_DENIED,
            f"{source}에서 ACL 필드는 재정의할 수 없습니다: {sorted(overridden)}",
            details={
                "reason": "acl_field_override_attempted",
                "fields": sorted(overridden),
                "source": source,
            },
        )


def forced_allowed_classifications(
    clearance: Classification, *, allow_unknown_classification: bool
) -> frozenset[str]:
    """Step 2 — 강제 ACL Filter 생성. Computed *only* from the caller's
    validated clearance (step 1's output) and the service-level policy flag
    (search_runtime.settings.ALLOW_UNKNOWN_CLASSIFICATION) — there is no code
    path from the request body into this set, which is what makes it
    unoverridable (reject_acl_override closes the other route: smuggling a
    `classification` key into a business filter dict)."""
    allowed = {
        level
        for level in _CALLER_CLEARANCE_VALUES
        if clearance_covers(clearance, Classification(level), allow_unknown_classification=False)
    }
    if allow_unknown_classification:
        allowed.add(Classification.UNKNOWN.value)
    return frozenset(allowed)


def merge_business_filters(
    profile_default: dict[str, str] | None, user_filters: dict[str, str] | None
) -> dict[str, frozenset[str]]:
    """Steps 3-5 for non-ACL business fields (e.g. `department`) — ACL
    fields must already have been rejected by `reject_acl_override` before
    this is ever called; this function does not special-case them.

    Each field maps to the set of values a chunk's metadata may equal.
    '충돌 시 더 제한적인 조건 사용' (step 5): when the same field is present
    in both sources with *different* literal values, the result is
    unsatisfiable (empty set) for that field — a chunk cannot equal two
    different values at once, so requiring both is the strictest possible
    resolution of that conflict (it excludes every chunk for that field,
    rather than arbitrarily picking one source over the other)."""
    merged: dict[str, frozenset[str]] = {}
    for source in (profile_default or {}), (user_filters or {}):
        for key, value in source.items():
            if key not in merged:
                merged[key] = frozenset({value})
            elif value in merged[key]:
                pass  # same value already required; no change
            else:
                merged[key] = _UNSATISFIABLE
    return merged


def chunk_is_visible(
    metadata: dict[str, Any],
    *,
    allowed_classifications: frozenset[str],
    business_filters: dict[str, frozenset[str]],
) -> bool:
    """The single predicate hybrid_search applies to every candidate chunk —
    combines the step-2 forced filter with the step-3/4/5 business filter."""
    classification = parse_classification(metadata.get("classification")).value
    if classification not in allowed_classifications:
        return False
    for key, allowed_values in business_filters.items():
        if metadata.get(key) not in allowed_values:
            return False
    return True
