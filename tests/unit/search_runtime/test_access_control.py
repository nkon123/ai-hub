"""04-knowledge-platform.md §3.8 Filter와 ACL — search_runtime.access_control.

Covers: the five-step order (via chunk_is_visible + the building blocks main.py
composes), the forced filter being unoverridable (rejection, not a silent
drop), conflict resolution -> more restrictive, and UNKNOWN handling under
both policy settings. No live service/network anywhere in this file."""

from __future__ import annotations

import pytest
from search_runtime import access_control
from search_runtime.errors import ErrorCode


class TestValidateAccessContext:
    def test_missing_access_context_defaults_to_least_privilege(self) -> None:
        ctx = access_control.validate_access_context(None)
        assert ctx.clearance.value == "PUBLIC_INTERNAL"

    def test_valid_clearance_is_parsed(self) -> None:
        ctx = access_control.validate_access_context(
            {"clearance": "CONFIDENTIAL", "user_id": "u1", "permissions": ["knowledge.read"]}
        )
        assert ctx.clearance.value == "CONFIDENTIAL"
        assert ctx.user_id == "u1"
        assert ctx.permissions == ("knowledge.read",)

    def test_missing_clearance_field_within_present_context_is_rejected(self) -> None:
        with pytest.raises(access_control.AccessControlError) as exc_info:
            access_control.validate_access_context({"user_id": "u1"})
        assert exc_info.value.code == ErrorCode.KNOWLEDGE_ACCESS_DENIED

    def test_unrecognized_clearance_value_is_rejected(self) -> None:
        with pytest.raises(access_control.AccessControlError) as exc_info:
            access_control.validate_access_context({"clearance": "SUPERADMIN"})
        assert exc_info.value.code == ErrorCode.KNOWLEDGE_ACCESS_DENIED

    def test_unknown_cannot_be_asserted_as_a_caller_clearance(self) -> None:
        """A caller cannot claim 'my clearance is UNKNOWN' — that value only
        ever describes a document, never a caller."""
        with pytest.raises(access_control.AccessControlError):
            access_control.validate_access_context({"clearance": "UNKNOWN"})


class TestRejectAclOverride:
    def test_none_or_empty_is_a_noop(self) -> None:
        access_control.reject_acl_override(None, source="metadata_filters")
        access_control.reject_acl_override({}, source="metadata_filters")

    def test_business_filter_passes(self) -> None:
        access_control.reject_acl_override({"department": "HR"}, source="metadata_filters")

    def test_classification_in_metadata_filters_is_rejected_not_dropped(self) -> None:
        with pytest.raises(access_control.AccessControlError) as exc_info:
            access_control.reject_acl_override(
                {"classification": "PUBLIC_INTERNAL"}, source="metadata_filters"
            )
        err = exc_info.value
        assert err.code == ErrorCode.KNOWLEDGE_ACCESS_DENIED
        assert err.details["reason"] == "acl_field_override_attempted"
        assert err.details["fields"] == ["classification"]
        assert err.details["source"] == "metadata_filters"

    def test_classification_in_retrieval_profile_filters_is_also_rejected(self) -> None:
        """Same rule applies to the profile-default source, not just the
        user's own metadata_filters — both are caller-supplied JSON in this
        PoC (no Profile Registry)."""
        with pytest.raises(access_control.AccessControlError) as exc_info:
            access_control.reject_acl_override(
                {"classification": "RESTRICTED"}, source="retrieval_profile.metadata_filters"
            )
        assert exc_info.value.details["source"] == "retrieval_profile.metadata_filters"


class TestForcedAllowedClassifications:
    def test_internal_clearance_excludes_confidential_and_restricted(self) -> None:
        allowed = access_control.forced_allowed_classifications(
            access_control.Classification.INTERNAL, allow_unknown_classification=False
        )
        assert allowed == {"PUBLIC_INTERNAL", "INTERNAL"}

    def test_restricted_clearance_sees_all_four_real_levels(self) -> None:
        allowed = access_control.forced_allowed_classifications(
            access_control.Classification.RESTRICTED, allow_unknown_classification=False
        )
        assert allowed == {"PUBLIC_INTERNAL", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"}

    def test_unknown_excluded_when_policy_denies(self) -> None:
        allowed = access_control.forced_allowed_classifications(
            access_control.Classification.RESTRICTED, allow_unknown_classification=False
        )
        assert "UNKNOWN" not in allowed

    def test_unknown_included_for_every_clearance_when_policy_allows(self) -> None:
        for clearance in access_control.Classification:
            if clearance is access_control.Classification.UNKNOWN:
                continue
            allowed = access_control.forced_allowed_classifications(
                clearance, allow_unknown_classification=True
            )
            assert "UNKNOWN" in allowed


class TestMergeBusinessFilters:
    def test_no_filters_is_empty(self) -> None:
        assert access_control.merge_business_filters(None, None) == {}

    def test_single_source_passes_through(self) -> None:
        merged = access_control.merge_business_filters({"department": "HR"}, None)
        assert merged == {"department": frozenset({"HR"})}

    def test_matching_values_from_both_sources_are_kept(self) -> None:
        merged = access_control.merge_business_filters(
            {"department": "HR"}, {"department": "HR"}
        )
        assert merged["department"] == frozenset({"HR"})

    def test_conflicting_values_become_unsatisfiable(self) -> None:
        """The 'more restrictive wins' rule: department cannot equal both
        HR and Legal, so nothing may satisfy this field."""
        merged = access_control.merge_business_filters(
            {"department": "HR"}, {"department": "Legal"}
        )
        assert merged["department"] == frozenset()

    def test_independent_fields_from_each_source_both_survive(self) -> None:
        merged = access_control.merge_business_filters(
            {"department": "HR"}, {"document_type": "policy"}
        )
        assert merged == {
            "department": frozenset({"HR"}),
            "document_type": frozenset({"policy"}),
        }


class TestChunkIsVisible:
    def test_confidential_chunk_withheld_from_internal_clearance(self) -> None:
        allowed = access_control.forced_allowed_classifications(
            access_control.Classification.INTERNAL, allow_unknown_classification=False
        )
        assert not access_control.chunk_is_visible(
            {"classification": "CONFIDENTIAL"},
            allowed_classifications=allowed,
            business_filters={},
        )

    def test_internal_chunk_visible_to_internal_clearance(self) -> None:
        allowed = access_control.forced_allowed_classifications(
            access_control.Classification.INTERNAL, allow_unknown_classification=False
        )
        assert access_control.chunk_is_visible(
            {"classification": "INTERNAL"},
            allowed_classifications=allowed,
            business_filters={},
        )

    def test_unknown_chunk_denied_under_default_policy(self) -> None:
        allowed = access_control.forced_allowed_classifications(
            access_control.Classification.RESTRICTED, allow_unknown_classification=False
        )
        assert not access_control.chunk_is_visible(
            {"classification": None},  # legacy chunk, field entirely absent
            allowed_classifications=allowed,
            business_filters={},
        )

    def test_unknown_chunk_allowed_under_explicit_override(self) -> None:
        allowed = access_control.forced_allowed_classifications(
            access_control.Classification.PUBLIC_INTERNAL, allow_unknown_classification=True
        )
        assert access_control.chunk_is_visible(
            {},  # no classification key at all — same as legacy index metadata
            allowed_classifications=allowed,
            business_filters={},
        )

    def test_business_filter_excludes_non_matching_chunk(self) -> None:
        allowed = access_control.forced_allowed_classifications(
            access_control.Classification.RESTRICTED, allow_unknown_classification=False
        )
        assert not access_control.chunk_is_visible(
            {"classification": "PUBLIC_INTERNAL", "department": "Legal"},
            allowed_classifications=allowed,
            business_filters={"department": frozenset({"HR"})},
        )

    def test_unsatisfiable_business_filter_excludes_every_chunk(self) -> None:
        allowed = access_control.forced_allowed_classifications(
            access_control.Classification.RESTRICTED, allow_unknown_classification=False
        )
        assert not access_control.chunk_is_visible(
            {"classification": "PUBLIC_INTERNAL", "department": "HR"},
            allowed_classifications=allowed,
            business_filters={"department": frozenset()},
        )
