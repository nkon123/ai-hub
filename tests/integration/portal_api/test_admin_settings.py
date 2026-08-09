"""Integration tests for P15 관리자 설정 —
`GET /api/v1/admin/settings` (`routers/admin.py::get_admin_settings`).

Covers: ADMIN sees the full read-only "정책·구성 현황" payload sourced from
real config/policy (role matrix, Office Profile, model aliases, asset size/
extension policy, approval workflow, classification levels); every
non-ADMIN role is denied with the standard `PERMISSION_DENIED` envelope and
a `DENIED` `AuditEvent`; no secret-shaped value ever reaches the response
body; and every 미구현 sub-area is reported explicitly (reason +
open-decisions.md id), never silently dropped from the payload.
"""

from __future__ import annotations

import httpx
import pytest
from portal_api.models import AuditEvent
from security_policy import Role, looks_like_secret
from sqlalchemy import select

from tests.integration.portal_api.conftest import auth_header

URL = "/api/v1/admin/settings"

NON_ADMIN_TOKENS = [
    ("dev-user-token", Role.CREATOR),
    ("dev-reviewer-token", Role.TECH_REVIEWER),
    ("dev-security-token", Role.SECURITY_REVIEWER),
    ("dev-release-token", Role.RELEASE_MANAGER),
    ("dev-auditor-token", Role.AUDITOR),
]


def _iter_strings(value: object):
    """Yield every string leaf in a (possibly nested) dict/list structure —
    used to sweep the whole response body for secret-shaped values without
    hand-listing every field."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _iter_strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _iter_strings(v)


async def test_admin_sees_full_settings_payload(client: httpx.AsyncClient) -> None:
    resp = await client.get(URL, headers=auth_header("dev-admin-token"))

    assert resp.status_code == 200
    body = resp.json()

    assert body["trace_id"]
    assert body["generated_at"]

    # 사용자·역할 매핑 — real 7-role matrix, not a placeholder.
    mapping = body["user_role_mapping"]
    assert mapping["status"] == "AVAILABLE"
    assert "security_policy" in mapping["source"]
    roles_seen = {row["role"] for row in mapping["roles"]}
    assert roles_seen == {r.value for r in Role}
    admin_row = next(row for row in mapping["roles"] if row["role"] == "ADMIN")
    assert "ADMIN_SETTINGS_READ" in admin_row["permissions"]
    creator_row = next(row for row in mapping["roles"] if row["role"] == "CREATOR")
    assert "ASSET_CREATE" in creator_row["permissions"]

    # Office Profile — real file, not a stub.
    office = body["office_profile"]
    assert office["status"] == "AVAILABLE"
    assert office["name"] == "miracom-default"
    assert office["org"] == "miracom"
    assert "headquarters" in office["sites"]

    # 허용 모델과 Endpoint Alias — same source file, model_aliases populated.
    aliases = body["model_endpoint_alias"]
    assert aliases["status"] == "AVAILABLE"
    alias_names = {a["alias"] for a in aliases["model_aliases"]}
    assert "default-chat" in alias_names
    chat_alias = next(a for a in aliases["model_aliases"] if a["alias"] == "default-chat")
    assert chat_alias["endpoint"] == "http://127.0.0.1:11434"

    # 자산 크기·확장자 정책 — real numbers/lists from package-policy.yaml +
    # bundle-verify.ts, parsed without error.
    size_policy = body["asset_size_extension_policy"]
    assert size_policy["status"] == "AVAILABLE"
    assert size_policy["parse_error"] is None
    assert size_policy["desktop_bundle_max_total_uncompressed_bytes"] == 2 * 1024 * 1024 * 1024
    assert ".exe" in size_policy["desktop_bundle_forbidden_executable_extensions"]
    assert "*.pem" in size_policy["knowledge_package_forbidden_filenames"]

    # 승인 Workflow — real TECHNICAL->SECURITY->RELEASE chain + gate flag.
    workflow = body["approval_workflow"]
    assert workflow["status"] == "AVAILABLE"
    assert workflow["stage_chain"] == ["TECHNICAL", "SECURITY", "RELEASE"]
    assert workflow["require_service_version_approval"] is False

    # 보안등급과 보관기간 — mixed: classification real, retention 미구현.
    sec = body["security_classification_retention"]
    assert sec["classification"]["status"] == "AVAILABLE"
    assert set(sec["classification"]["classification_levels"]) == {
        "PUBLIC_INTERNAL",
        "INTERNAL",
        "CONFIDENTIAL",
        "RESTRICTED",
        "UNKNOWN",
    }
    assert sec["retention"]["status"] == "NOT_IMPLEMENTED"
    assert sec["retention"]["not_implemented"]["decision_id"]

    # 조직·사업장, Package Trust/Signature — 미구현, explicitly reported.
    assert body["organization_site"]["status"] == "NOT_IMPLEMENTED"
    assert body["organization_site"]["not_implemented"]["reason"]
    assert body["organization_site"]["not_implemented"]["decision_id"]
    assert body["package_trust_signature"]["status"] == "NOT_IMPLEMENTED"
    assert body["package_trust_signature"]["not_implemented"]["decision_id"] == "D-016"


@pytest.mark.parametrize("token,role", NON_ADMIN_TOKENS, ids=[t for t, _ in NON_ADMIN_TOKENS])
async def test_non_admin_role_denied_and_audited(
    client: httpx.AsyncClient, db, token: str, role: Role
) -> None:
    resp = await client.get(URL, headers=auth_header(token))

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    audit_rows = (
        (
            await db.execute(
                select(AuditEvent).where(
                    AuditEvent.event_type == "PERMISSION_DENIED:ADMIN_SETTINGS_READ"
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(audit_rows) == 1
    assert audit_rows[0].result == "DENIED"
    assert audit_rows[0].metadata_["role"] == role.value


async def test_response_contains_no_secret_shaped_value(client: httpx.AsyncClient) -> None:
    resp = await client.get(URL, headers=auth_header("dev-admin-token"))
    assert resp.status_code == 200
    body = resp.json()

    offenders = [s for s in _iter_strings(body) if looks_like_secret(s)]
    assert offenders == [], f"secret-shaped value(s) reached the response: {offenders}"


async def test_missing_token_is_unauthorized(client: httpx.AsyncClient) -> None:
    resp = await client.get(URL)
    assert resp.status_code == 401
