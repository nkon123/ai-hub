"""Unit tests for P16 긴급 Revocation enforcement in the M03 resolver
(01-portal-and-distribution.md §2 P16) — pure-function tests over a
hand-built `BundleJobRequest`, same style as `test_resolver.py`.

portal-api (M02) is the one that decides whether a revocation is
*effective* (`effective_at <= now()`, see
`routers/distributions.py::_effective_revoked_version_ids`) — this service
has no DB connection and only ever sees the resulting boolean
(`BundleJobRequestItem.revoked`). So "a future-dated revocation does not
block" is exercised here as "an item whose revocation is not yet effective
arrives with `revoked=False`" — the boolean portal-api would have computed
for it — rather than by passing a raw effective_at timestamp into this
service.
"""

from __future__ import annotations

import pytest
from distribution_service.contracts import BundleJobRequest, BundleJobRequestItem
from distribution_service.resolver import (
    AssetVersionRevokedError,
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


def test_effectively_revoked_required_item_blocks_the_bundle():
    root = _item(role="root", asset_type="service", asset_id="svc-1", status="APPROVED")
    revoked_knowledge = _item(
        asset_id="asset-revoked", status="APPROVED", revoked=True
    )

    with pytest.raises(AssetVersionRevokedError) as exc_info:
        resolve(_request([root, revoked_knowledge]))

    assert exc_info.value.items == [revoked_knowledge]


def test_not_yet_effective_revocation_does_not_block():
    """A future-dated revocation is not yet in force — portal-api would
    compute `revoked=False` for it (see module docstring), so the resolver
    must let it through exactly like any other APPROVED item."""
    root = _item(role="root", asset_type="service", asset_id="svc-1", status="APPROVED")
    not_yet_revoked = _item(asset_id="asset-scheduled", status="APPROVED", revoked=False)

    plan = resolve(_request([root, not_yet_revoked]))

    assert not_yet_revoked in plan.items


def test_optional_revoked_item_does_not_block():
    root = _item(role="root", asset_type="service", asset_id="svc-1", status="APPROVED")
    optional_revoked = _item(
        asset_id="asset-optional", status="APPROVED", revoked=True, required=False
    )

    plan = resolve(_request([root, optional_revoked]))

    assert optional_revoked in plan.items


def test_emergency_revocation_is_checked_before_lifecycle_status_revocation():
    """An APPROVED-but-revoked item must raise `AssetVersionRevokedError`
    (-> `ASSET_VERSION_REVOKED`), not `PackageRevokedError` (->
    `PACKAGE_REVOKED`, which only fires for SUSPENDED/RETIRED lifecycle
    status) — these are orthogonal gates and the emergency one is checked
    first (see resolver.py module docstring)."""
    root = _item(role="root", asset_type="service", asset_id="svc-1", status="APPROVED")
    revoked_and_suspended = _item(
        asset_id="asset-both", status="SUSPENDED", revoked=True
    )

    with pytest.raises(AssetVersionRevokedError):
        resolve(_request([root, revoked_and_suspended]))

    # Sanity check the two error types really are distinct.
    assert not issubclass(AssetVersionRevokedError, PackageRevokedError)
    assert not issubclass(PackageRevokedError, AssetVersionRevokedError)
