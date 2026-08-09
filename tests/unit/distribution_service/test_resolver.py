"""Unit tests for the §4.3 dependency resolver (M03) — pure-function tests
over a hand-built `BundleJobRequest`, no DB/HTTP involved."""

from __future__ import annotations

import pytest
from distribution_service.contracts import BundleJobRequest, BundleJobRequestItem
from distribution_service.resolver import (
    DependencyMissingError,
    DependencyVersionConflictError,
    PackageRevokedError,
    resolve,
)


def _item(**overrides) -> BundleJobRequestItem:
    base = dict(
        asset_id="asset-1",
        asset_type="knowledge",
        asset_name="HR Policy",
        role="knowledge",
        required=True,
        asset_version_id="v1",
        version="1.0.0",
        status="APPROVED",
    )
    base.update(overrides)
    return BundleJobRequestItem(**base)


def _request(items: list[BundleJobRequestItem], **overrides) -> BundleJobRequest:
    base = dict(
        job_id="job-1",
        trace_id="trace-1",
        root_type="SERVICE_VERSION",
        root_id="service-version-1",
        requested_by="dev-user@miracom.com",
        items=items,
    )
    base.update(overrides)
    return BundleJobRequest(**base)


def test_single_knowledge_root_resolves_with_no_conflicts():
    root = _item(role="root", asset_type="knowledge")
    plan = resolve(_request([root]))

    assert plan.items == [root]
    assert plan.install_order == ["knowledge"]


def test_missing_required_dependency_raises_dependency_missing():
    root = _item(role="root", asset_type="service", asset_id="svc-1", status="APPROVED")
    missing_knowledge = _item(
        asset_id="asset-missing", role="knowledge", status="NOT_FOUND", storage_path=None
    )

    with pytest.raises(DependencyMissingError) as exc_info:
        resolve(_request([root, missing_knowledge]))

    assert exc_info.value.items == [missing_knowledge]


def test_optional_missing_dependency_does_not_raise():
    root = _item(role="root", asset_type="service", asset_id="svc-1")
    optional_missing = _item(
        asset_id="asset-optional", role="knowledge", status="NOT_FOUND", required=False
    )

    plan = resolve(_request([root, optional_missing]))

    assert optional_missing in plan.items


def test_same_asset_two_versions_raises_version_conflict():
    item_a = _item(asset_id="asset-1", version="1.0.0", asset_version_id="v1")
    item_b = _item(asset_id="asset-1", version="2.0.0", asset_version_id="v2")

    with pytest.raises(DependencyVersionConflictError) as exc_info:
        resolve(_request([item_a, item_b]))

    assert exc_info.value.conflicts == {"asset-1": ["1.0.0", "2.0.0"]}


def test_optional_conflicting_versions_do_not_raise():
    item_a = _item(asset_id="asset-1", version="1.0.0", required=False)
    item_b = _item(asset_id="asset-1", version="2.0.0", required=False)

    plan = resolve(_request([item_a, item_b]))

    assert len(plan.items) == 2


@pytest.mark.parametrize("blocking_status", ["SUSPENDED", "RETIRED"])
def test_suspended_or_retired_required_dependency_raises_package_revoked(blocking_status):
    root = _item(role="root", asset_type="service", asset_id="svc-1")
    revoked = _item(asset_id="asset-revoked", status=blocking_status)

    with pytest.raises(PackageRevokedError) as exc_info:
        resolve(_request([root, revoked]))

    assert exc_info.value.items == [revoked]


def test_deprecated_required_dependency_is_allowed():
    root = _item(role="root", asset_type="service", asset_id="svc-1")
    deprecated = _item(asset_id="asset-deprecated", status="DEPRECATED")

    plan = resolve(_request([root, deprecated]))

    assert deprecated in plan.items


def test_standard_local_copy_items_are_excluded_from_conflict_and_missing_checks():
    root = _item(role="root", asset_type="service", asset_id="svc-1")
    agent = _item(
        asset_id="std-agent",
        role="agent",
        asset_type="agent",
        status="STANDARD_LOCAL_COPY",
        version=None,
        asset_version_id=None,
    )
    prompt = _item(
        asset_id="std-agent",  # same asset_id as agent, would look like a conflict if checked
        role="prompt",
        asset_type="prompt",
        status="STANDARD_LOCAL_COPY",
        version=None,
        asset_version_id=None,
    )

    plan = resolve(_request([root, agent, prompt]))

    assert agent in plan.items and prompt in plan.items


def test_install_order_follows_prompt_knowledge_agent_mcp_service():
    service_root = _item(role="root", asset_type="service", asset_id="svc-1")
    knowledge = _item(asset_id="k1", role="knowledge")
    prompt = _item(
        asset_id="p1",
        role="prompt",
        status="STANDARD_LOCAL_COPY",
        asset_version_id=None,
        version=None,
    )
    agent = _item(
        asset_id="a1",
        role="agent",
        status="STANDARD_LOCAL_COPY",
        asset_version_id=None,
        version=None,
    )
    mcp = _item(asset_id="m1", role="mcp_tool")

    plan = resolve(_request([service_root, knowledge, prompt, agent, mcp]))

    assert plan.install_order == ["prompt", "knowledge", "agent", "mcp_tool", "service"]
    # And the concrete item order matches (root sorts by its own asset_type == "service").
    roles_in_order = [i.role if i.role != "root" else i.asset_type for i in plan.items]
    assert roles_in_order == ["prompt", "knowledge", "agent", "mcp_tool", "service"]
