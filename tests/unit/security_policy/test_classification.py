"""Classification parsing + clearance comparison (04-knowledge-platform.md
§3.8, §2.7) — see security_policy.classification module docstring."""

from __future__ import annotations

import pytest
from security_policy import (
    ACL_METADATA_FIELDS,
    Classification,
    clearance_covers,
    parse_classification,
)


class TestParseClassification:
    @pytest.mark.parametrize(
        "value",
        ["PUBLIC_INTERNAL", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
    )
    def test_valid_string_round_trips(self, value: str) -> None:
        assert parse_classification(value) == Classification(value)

    def test_none_is_unknown(self) -> None:
        assert parse_classification(None) == Classification.UNKNOWN

    def test_unrecognized_string_is_unknown_not_a_guess(self) -> None:
        """A typo or a value from some future/foreign scheme must never be
        silently coerced into a real level (e.g. defaulting to INTERNAL) —
        only UNKNOWN, which is a distinct, separately-policed state."""
        assert parse_classification("SECRET") == Classification.UNKNOWN
        # case-sensitive — lowercase must not be silently normalized either
        assert parse_classification("internal") == Classification.UNKNOWN

    def test_non_string_is_unknown(self) -> None:
        assert parse_classification(123) == Classification.UNKNOWN
        assert parse_classification({}) == Classification.UNKNOWN

    def test_already_parsed_enum_passes_through(self) -> None:
        assert parse_classification(Classification.CONFIDENTIAL) == Classification.CONFIDENTIAL


class TestClearanceCovers:
    def test_confidential_document_withheld_from_internal_clearance(self) -> None:
        assert (
            clearance_covers(
                Classification.INTERNAL,
                Classification.CONFIDENTIAL,
                allow_unknown_classification=False,
            )
            is False
        )

    def test_internal_document_visible_to_internal_clearance(self) -> None:
        assert (
            clearance_covers(
                Classification.INTERNAL,
                Classification.INTERNAL,
                allow_unknown_classification=False,
            )
            is True
        )

    def test_public_internal_document_visible_to_every_real_clearance(self) -> None:
        for clearance in (
            Classification.PUBLIC_INTERNAL,
            Classification.INTERNAL,
            Classification.CONFIDENTIAL,
            Classification.RESTRICTED,
        ):
            assert clearance_covers(
                clearance, Classification.PUBLIC_INTERNAL, allow_unknown_classification=False
            )

    def test_restricted_document_withheld_from_confidential_clearance(self) -> None:
        """Edge case one level below the top: CONFIDENTIAL clearance must
        not reach RESTRICTED documents."""
        assert (
            clearance_covers(
                Classification.CONFIDENTIAL,
                Classification.RESTRICTED,
                allow_unknown_classification=False,
            )
            is False
        )

    def test_restricted_clearance_sees_restricted_document(self) -> None:
        assert clearance_covers(
            Classification.RESTRICTED, Classification.RESTRICTED, allow_unknown_classification=False
        )

    def test_unknown_document_denied_when_policy_denies(self) -> None:
        """Fail-closed default: even the highest caller clearance does not
        unlock an UNKNOWN (legacy/unstamped) document when the deployment
        policy says not to."""
        assert (
            clearance_covers(
                Classification.RESTRICTED,
                Classification.UNKNOWN,
                allow_unknown_classification=False,
            )
            is False
        )

    def test_unknown_document_allowed_when_policy_allows_regardless_of_clearance(self) -> None:
        """The explicit override applies uniformly — it is not scaled by the
        caller's clearance, because there is no classification evidence to
        scale against."""
        assert clearance_covers(
            Classification.PUBLIC_INTERNAL,
            Classification.UNKNOWN,
            allow_unknown_classification=True,
        )


def test_acl_metadata_fields_contains_classification() -> None:
    assert "classification" in ACL_METADATA_FIELDS
