"""Classification levels and clearance comparison — M11 owns this per
CLAUDE.md 모듈 소유권 ("분류등급(Classification) 기반 접근 제어" was listed as
the M11 gap in `docs/implementation-spec/progress-log.md` before this file).

Used by two other modules over this package's public API (never by internal
folder import — CLAUDE.md 구현 원칙 2):

  - M07 `services/indexing-runtime` stamps `Classification` onto chunk/parent
    metadata at index time (04-knowledge-platform.md §2.7).
  - M08 `services/search-runtime` compares a caller's asserted clearance
    against a chunk's stamped classification to enforce the forced ACL
    filter (04-knowledge-platform.md §3.8).

Enum values mirror `packages/schemas/manifests/asset-manifest.schema.json`'s
`classification` enum (`PUBLIC_INTERNAL`/`INTERNAL`/`CONFIDENTIAL`/
`RESTRICTED`) plus `UNKNOWN`, which is *not* a real classification an asset
manifest can declare — it exists only to name "we do not know" (a legacy
index built before this feature, or a corrupt/foreign value) so that case
can be handled by an explicit policy decision instead of silently guessing a
level. See `clearance_covers` for exactly how `UNKNOWN` is handled.
"""

from __future__ import annotations

from enum import StrEnum


class Classification(StrEnum):
    PUBLIC_INTERNAL = "PUBLIC_INTERNAL"
    INTERNAL = "INTERNAL"
    CONFIDENTIAL = "CONFIDENTIAL"
    RESTRICTED = "RESTRICTED"
    UNKNOWN = "UNKNOWN"


# Ascending order of restriction. UNKNOWN is deliberately absent from this
# scale — it is not a level between two real ones, it is "no evidence either
# way". Slotting it into the ordering (e.g. treating it as the lowest or the
# highest level) would itself be a guessed default, exactly what this module
# exists to avoid. It is handled entirely by the `allow_unknown_classification`
# policy flag in `clearance_covers`, never by comparison.
_ORDER: dict[Classification, int] = {
    Classification.PUBLIC_INTERNAL: 0,
    Classification.INTERNAL: 1,
    Classification.CONFIDENTIAL: 2,
    Classification.RESTRICTED: 3,
}

# The classification levels a caller may assert as their own clearance.
# UNKNOWN is excluded on purpose: "my clearance is unknown" is not a
# meaningful access grant, so a caller cannot claim it (see
# search_runtime.access_control.validate_access_context, which rejects it).
CALLER_CLEARANCE_LEVELS: tuple[Classification, ...] = (
    Classification.PUBLIC_INTERNAL,
    Classification.INTERNAL,
    Classification.CONFIDENTIAL,
    Classification.RESTRICTED,
)

# The metadata field(s) a search request must never be able to set itself —
# 04-knowledge-platform.md §3.8: "사용자가 요청에서 ACL Field를 덮어쓸 수
# 없다." Centralized here (not duplicated as a literal in search-runtime) so
# a future additional ACL field only needs to change in one place.
ACL_METADATA_FIELDS: frozenset[str] = frozenset({"classification"})


def parse_classification(value: object) -> Classification:
    """Normalizes a possibly-missing/unrecognized classification value.

    Never guesses a real level for a missing/bad value — always UNKNOWN in
    that case. Whether UNKNOWN chunks are then visible to anyone is a
    separate, explicit policy decision (`clearance_covers`'s
    `allow_unknown_classification`), not something this parser decides."""
    if isinstance(value, Classification):
        return value
    if isinstance(value, str):
        try:
            return Classification(value)
        except ValueError:
            return Classification.UNKNOWN
    return Classification.UNKNOWN


def clearance_covers(
    caller_clearance: Classification,
    document_classification: Classification,
    *,
    allow_unknown_classification: bool,
) -> bool:
    """04-knowledge-platform.md §3.8 강제 ACL Filter 판정 규칙.

    - `document_classification is UNKNOWN` (레거시 인덱스 또는 미기재,
      §2.7): 호출자의 Clearance와 무관하게 `allow_unknown_classification`
      정책 값을 그대로 따른다. 등급을 모르는 문서를 누구에게는 보여주고
      누구에게는 막을 근거가 없기 때문에, "모르면 전부 허용" 또는 "모르면
      전부 차단" 둘 중 하나를 배포 단위로 명시적으로 고르게 한다.
    - 그 외: 문서의 등급이 호출자 Clearance 이하일 때만 허용한다
      (PUBLIC_INTERNAL < INTERNAL < CONFIDENTIAL < RESTRICTED).
    """
    if document_classification is Classification.UNKNOWN:
        return allow_unknown_classification
    return _ORDER[document_classification] <= _ORDER[caller_clearance]
