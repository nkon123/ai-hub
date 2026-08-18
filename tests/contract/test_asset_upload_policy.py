"""Contract test for `packages/schemas/policies/asset-upload-policy.json` —
the inbound Portal asset-registration upload policy read by
`apps/portal-api/src/portal_api/routers/assets.py::create_asset` (M02,
POST /api/v1/assets). This is a separate contract from
`bundle-install-policy.json`: that one bounds uncompressed contents of an
already-downloaded Desktop Offline Bundle (M04, zip-bomb defense), this one
bounds a single inbound multipart HTTP registration request (no archive
involved). Not under `fixtures/valid/` for the same reason
`test_bundle_install_policy.py` isn't — it's a live policy file a runtime
reads directly, not a registered asset instance, so it gets its own narrow
contract test here.
"""

from __future__ import annotations

import json
from pathlib import Path

from ai_asset_schemas.validator import SchemaType, infer_schema_type, validate

_POLICY_PATH = (
    Path(__file__).parent.parent.parent
    / "packages"
    / "schemas"
    / "policies"
    / "asset-upload-policy.json"
)


def _load_policy() -> dict:
    with _POLICY_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def test_asset_upload_policy_is_schema_valid() -> None:
    policy = _load_policy()
    validate(policy, SchemaType.ASSET_UPLOAD_POLICY)  # must not raise


def test_asset_upload_policy_is_structurally_inferable() -> None:
    """Guards the `infer_schema_type` structural-detection branch itself,
    not just the explicit `SchemaType.ASSET_UPLOAD_POLICY` call above."""
    policy = _load_policy()
    assert infer_schema_type(policy) == SchemaType.ASSET_UPLOAD_POLICY


def test_asset_upload_policy_is_not_confused_with_bundle_install_policy() -> None:
    """The two policy shapes must stay structurally distinguishable —
    asset-upload-policy.json has no archive_extensions/size_caps keys, and
    bundle-install-policy.json has no max_single_file_bytes/
    rejected_extensions keys."""
    policy = _load_policy()
    assert "archive_extensions" not in policy
    assert "size_caps" not in policy


def test_asset_upload_policy_matches_known_poc_values() -> None:
    """Pins the current PoC defaults (50MB single file / 150MB request total
    / 20 files) so a silent drift in the *policy*, not just its storage
    location, is caught here rather than surfacing as a confusing upload
    failure/success in `tests/integration/portal_api/
    test_asset_upload_limits.py`."""
    policy = _load_policy()
    assert policy["max_single_file_bytes"] == 50 * 1024 * 1024
    assert policy["max_total_request_bytes"] == 150 * 1024 * 1024
    assert policy["max_file_count"] == 20
    assert ".exe" in policy["rejected_extensions"]
    assert ".zip" in policy["rejected_extensions"]


def test_asset_upload_policy_total_is_not_smaller_than_single_file_cap() -> None:
    """A single request containing exactly one max-size file must not itself
    be rejected as exceeding the request total."""
    policy = _load_policy()
    assert policy["max_total_request_bytes"] >= policy["max_single_file_bytes"]
