"""Contract test for `packages/schemas/policies/bundle-install-policy.json` —
the shared Desktop Offline Bundle install policy read by both
`apps/desktop-client/electron/bundle-verify.ts` (M04) and
`apps/portal-api/src/portal_api/routers/admin.py` (M02, P15). Prior to this
contract, M02 regex-parsed M04's TypeScript source text directly, which
CLAUDE.md 원칙 2/3 forbid (no cross-module folder import, common types must
travel through `packages/schemas` or a public API). This file is not under
`fixtures/valid/` like manifest fixtures because it isn't a registered asset
instance — it's a live policy file both runtimes load directly — so it gets
its own narrow contract test here instead of the generic fixture sweep.
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
    / "bundle-install-policy.json"
)


def _load_policy() -> dict:
    with _POLICY_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def test_bundle_install_policy_is_schema_valid() -> None:
    policy = _load_policy()
    validate(policy, SchemaType.BUNDLE_INSTALL_POLICY)  # must not raise


def test_bundle_install_policy_is_structurally_inferable() -> None:
    """Guards the `infer_schema_type` structural-detection branch itself,
    not just the explicit `SchemaType.BUNDLE_INSTALL_POLICY` call above."""
    policy = _load_policy()
    assert infer_schema_type(policy) == SchemaType.BUNDLE_INSTALL_POLICY


def test_bundle_install_policy_matches_known_poc_values() -> None:
    """Pins the exact values `docs/implementation-spec/open-decisions.md`
    (D-018/D-065) and `tests/integration/portal_api/test_admin_settings.py`
    document as the current PoC policy (2GB total / 500MB single file /
    ratio 200) — a regression here means the *policy*, not just its storage
    location, silently changed."""
    policy = _load_policy()
    assert policy["size_caps"]["max_total_uncompressed_bytes"] == 2 * 1024 * 1024 * 1024
    assert policy["size_caps"]["max_single_file_uncompressed_bytes"] == 500 * 1024 * 1024
    assert policy["size_caps"]["max_compression_ratio"] == 200
    assert ".exe" in policy["executable_extensions"]
    assert ".zip" in policy["archive_extensions"]
