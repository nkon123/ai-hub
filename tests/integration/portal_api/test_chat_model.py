"""Integration tests for the P15 채팅 모델 설정 (open-decisions.md D-092):

- `GET /api/v1/admin/settings`'s new `chat_model` section
- `GET /api/v1/admin/chat-models` (`routers/admin.py::list_chat_models`)
- `PUT /api/v1/admin/chat-model` (`routers/admin.py::set_chat_model`)
- `GET /api/v1/admin/chat-model-setting` (`routers/admin.py::get_chat_model_setting`)
  — the one endpoint in this file NOT gated behind `ADMIN_SETTINGS_READ`,
  because agent-runtime calls it server-to-server with its fixed
  `portal_api_token` (default `dev-user-token` = role CREATOR, D-034).

`routers.admin.get_chat_models_caller` is a FastAPI dependency seam
(mirrors `get_embedding_models_caller` exactly) — this suite never needs a
real agent-runtime process or Ollama listening anywhere.
"""

from __future__ import annotations

import pytest
from portal_api.main import app
from portal_api.models import AuditEvent, PlatformSetting
from portal_api.platform_settings import CHAT_MODEL_KEY
from portal_api.routers.admin import get_chat_models_caller
from security_policy import Role
from sqlalchemy import select

from tests.integration.portal_api.conftest import auth_header

SETTINGS_URL = "/api/v1/admin/settings"
MODELS_URL = "/api/v1/admin/chat-models"
UPDATE_URL = "/api/v1/admin/chat-model"
SETTING_URL = "/api/v1/admin/chat-model-setting"

pytestmark = pytest.mark.asyncio

NON_ADMIN_TOKENS = [
    ("dev-user-token", Role.CREATOR),
    ("dev-reviewer-token", Role.TECH_REVIEWER),
    ("dev-security-token", Role.SECURITY_REVIEWER),
    ("dev-release-token", Role.RELEASE_MANAGER),
    ("dev-auditor-token", Role.AUDITOR),
]

_FAKE_MODELS = [
    {"name": "exaone3.5:7.8b", "chat_capable": True, "size": 200, "modified_at": None},
    {"name": "qwen3-embedding:0.6b", "chat_capable": False, "size": 100, "modified_at": None},
]


@pytest.fixture
def fake_models_available():
    """Overrides `get_chat_models_caller` with a canned "Ollama has these
    two models" response — no real agent-runtime/Ollama needed."""

    async def _fake_caller():
        return list(_FAKE_MODELS), "exaone3.5:7.8b", None

    app.dependency_overrides[get_chat_models_caller] = lambda: _fake_caller
    yield
    app.dependency_overrides.pop(get_chat_models_caller, None)


@pytest.fixture
def fake_models_unreachable():
    """Deterministically exercises the MODEL_UNAVAILABLE path — same shape
    `_call_agent_runtime_chat_models_http` returns on a real connection
    failure, without depending on whether anything is listening on :8100."""

    async def _fake_caller():
        return [], None, "agent-runtime(http://localhost:8100)에 연결할 수 없습니다"

    app.dependency_overrides[get_chat_models_caller] = lambda: _fake_caller
    yield
    app.dependency_overrides.pop(get_chat_models_caller, None)


# --- GET /api/v1/admin/settings — new section -------------------------------


async def test_admin_settings_reports_unset_chat_model(client) -> None:
    resp = await client.get(SETTINGS_URL, headers=auth_header("dev-admin-token"))
    assert resp.status_code == 200
    section = resp.json()["chat_model"]

    assert section["status"] == "AVAILABLE"
    assert section["configured_model"] is None
    assert section["updated_at"] is None
    # D-092: the "settings changed but running Run keeps the old value"
    # warning must be present so the screen doesn't lie about when a save
    # takes effect.
    assert "즉시 적용되지" in section["note"]


async def test_admin_settings_reports_configured_chat_model(client, db) -> None:
    db.add(
        PlatformSetting(
            key=CHAT_MODEL_KEY,
            value="exaone3.5:7.8b",
            updated_by_user_id="admin@miracom.com",
            trace_id="t-1",
        )
    )
    await db.commit()

    resp = await client.get(SETTINGS_URL, headers=auth_header("dev-admin-token"))
    section = resp.json()["chat_model"]
    assert section["configured_model"] == "exaone3.5:7.8b"
    assert section["updated_by"] == "admin@miracom.com"
    assert section["updated_at"] is not None


# --- GET /api/v1/admin/chat-models ------------------------------------------


async def test_list_chat_models_happy_path(client, fake_models_available) -> None:
    resp = await client.get(MODELS_URL, headers=auth_header("dev-admin-token"))
    assert resp.status_code == 200
    body = resp.json()

    assert body["default_chat_model"] == "exaone3.5:7.8b"
    assert body["trace_id"]
    by_name = {m["name"]: m for m in body["models"]}
    assert by_name["exaone3.5:7.8b"]["chat_capable"] is True
    assert by_name["qwen3-embedding:0.6b"]["chat_capable"] is False


async def test_list_chat_models_unreachable_returns_503(client, fake_models_unreachable) -> None:
    resp = await client.get(MODELS_URL, headers=auth_header("dev-admin-token"))
    assert resp.status_code == 503
    body = resp.json()
    assert body["error"]["code"] == "MODEL_UNAVAILABLE"
    # Never a silently-empty models list disguised as a normal response.
    assert "models" not in body


@pytest.mark.parametrize("token,role", NON_ADMIN_TOKENS, ids=[t for t, _ in NON_ADMIN_TOKENS])
async def test_list_chat_models_non_admin_denied_and_audited(
    client, db, fake_models_available, token: str, role: Role
) -> None:
    resp = await client.get(MODELS_URL, headers=auth_header(token))
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    rows = (
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
    assert len(rows) == 1
    assert rows[0].result == "DENIED"
    assert rows[0].metadata_["role"] == role.value


# --- PUT /api/v1/admin/chat-model -------------------------------------------


async def test_set_chat_model_happy_path(client, db, fake_models_available) -> None:
    resp = await client.put(
        UPDATE_URL,
        json={"model": "exaone3.5:7.8b"},
        headers=auth_header("dev-admin-token"),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["configured_model"] == "exaone3.5:7.8b"

    row = (
        await db.execute(select(PlatformSetting).where(PlatformSetting.key == CHAT_MODEL_KEY))
    ).scalar_one()
    assert row.value == "exaone3.5:7.8b"

    audit_rows = (
        (
            await db.execute(
                select(AuditEvent).where(AuditEvent.event_type == "CHAT_MODEL_UPDATED")
            )
        )
        .scalars()
        .all()
    )
    assert len(audit_rows) == 1
    assert audit_rows[0].result == "SUCCESS"
    assert audit_rows[0].metadata_["new_model"] == "exaone3.5:7.8b"
    assert audit_rows[0].metadata_["previous_model"] is None


async def test_set_chat_model_rejects_uninstalled_model(client, db, fake_models_available) -> None:
    """The core benefit this feature exists for (D-091): a model that
    isn't installed must be rejected at save time, not discovered when a
    Run 404s later."""
    resp = await client.put(
        UPDATE_URL,
        json={"model": "not-installed-model:1b"},
        headers=auth_header("dev-admin-token"),
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "VALIDATION_ERROR"
    assert "not-installed-model:1b" in body["error"]["details"]["requested_model"]
    assert "exaone3.5:7.8b" in body["error"]["details"]["available_chat_models"]

    row = (
        await db.execute(select(PlatformSetting).where(PlatformSetting.key == CHAT_MODEL_KEY))
    ).scalar_one_or_none()
    assert row is None

    audit_rows = (
        (
            await db.execute(
                select(AuditEvent).where(
                    AuditEvent.event_type == "CHAT_MODEL_UPDATE_REJECTED"
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(audit_rows) == 1
    assert audit_rows[0].result == "FAILED"


async def test_set_chat_model_rejects_embedding_only_model(
    client, db, fake_models_available
) -> None:
    """Installed but not `chat_capable` (an embedding-only model) must also
    be rejected — symmetric with the embedding card's `embedding_capable`
    check."""
    resp = await client.put(
        UPDATE_URL,
        json={"model": "qwen3-embedding:0.6b"},
        headers=auth_header("dev-admin-token"),
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "VALIDATION_ERROR"
    assert "qwen3-embedding:0.6b" not in body["error"]["details"]["available_chat_models"]

    row = (
        await db.execute(select(PlatformSetting).where(PlatformSetting.key == CHAT_MODEL_KEY))
    ).scalar_one_or_none()
    assert row is None


async def test_set_chat_model_unreachable_returns_503_and_persists_nothing(
    client, db, fake_models_unreachable
) -> None:
    resp = await client.put(
        UPDATE_URL,
        json={"model": "exaone3.5:7.8b"},
        headers=auth_header("dev-admin-token"),
    )
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "MODEL_UNAVAILABLE"

    row = (
        await db.execute(select(PlatformSetting).where(PlatformSetting.key == CHAT_MODEL_KEY))
    ).scalar_one_or_none()
    assert row is None


@pytest.mark.parametrize("token,role", NON_ADMIN_TOKENS, ids=[t for t, _ in NON_ADMIN_TOKENS])
async def test_set_chat_model_non_admin_denied_and_audited(
    client, db, fake_models_available, token: str, role: Role
) -> None:
    resp = await client.put(
        UPDATE_URL,
        json={"model": "exaone3.5:7.8b"},
        headers=auth_header(token),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED"

    rows = (
        (
            await db.execute(
                select(AuditEvent).where(
                    AuditEvent.event_type == "PERMISSION_DENIED:ADMIN_SETTINGS_WRITE"
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].result == "DENIED"
    assert rows[0].metadata_["role"] == role.value

    row = (
        await db.execute(select(PlatformSetting).where(PlatformSetting.key == CHAT_MODEL_KEY))
    ).scalar_one_or_none()
    assert row is None


async def test_set_chat_model_requires_non_empty_model(client, fake_models_available) -> None:
    resp = await client.put(
        UPDATE_URL, json={"model": "   "}, headers=auth_header("dev-admin-token")
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


# --- GET /api/v1/admin/chat-model-setting -----------------------------------
# agent-runtime calls this server-to-server with its own portal_api_token
# (default dev-user-token = CREATOR). Must NOT require ADMIN_SETTINGS_READ.


async def test_get_chat_model_setting_returns_null_when_unset(client) -> None:
    resp = await client.get(SETTING_URL, headers=auth_header("dev-user-token"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["configured_model"] is None
    assert body["trace_id"]


async def test_get_chat_model_setting_returns_configured_value(client, db) -> None:
    db.add(
        PlatformSetting(
            key=CHAT_MODEL_KEY,
            value="exaone3.5:7.8b",
            updated_by_user_id="admin@miracom.com",
            trace_id="t-2",
        )
    )
    await db.commit()

    resp = await client.get(SETTING_URL, headers=auth_header("dev-user-token"))
    assert resp.status_code == 200
    assert resp.json()["configured_model"] == "exaone3.5:7.8b"


@pytest.mark.parametrize("token,role", NON_ADMIN_TOKENS, ids=[t for t, _ in NON_ADMIN_TOKENS])
async def test_get_chat_model_setting_readable_by_any_authenticated_role(
    client, token: str, role: Role
) -> None:
    """The whole point of D-092's auth choice: agent-runtime authenticates
    as CREATOR (or whatever `portal_api_token` maps to), not ADMIN — this
    endpoint must not become unreachable for it. Proven here across every
    non-admin role, not just CREATOR, to show it's genuinely not
    permission-gated (rather than accidentally matching one role's grant)."""
    resp = await client.get(SETTING_URL, headers=auth_header(token))
    assert resp.status_code == 200, resp.text


async def test_get_chat_model_setting_requires_authentication(client) -> None:
    resp = await client.get(SETTING_URL)
    assert resp.status_code == 401
