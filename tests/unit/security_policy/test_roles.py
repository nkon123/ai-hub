"""Unit tests for the M11 RBAC permission matrix — pure, no DB, no FastAPI."""

from __future__ import annotations

import pytest
from security_policy import (
    ROLE_PERMISSIONS,
    Permission,
    PermissionDeniedError,
    Role,
    has_permission,
    require_permission,
)


def test_admin_has_every_permission() -> None:
    for permission in Permission:
        assert has_permission(Role.ADMIN, permission), f"ADMIN should have {permission}"


def test_user_cannot_create_assets() -> None:
    assert not has_permission(Role.USER, Permission.ASSET_CREATE)


def test_creator_can_create_and_submit_but_not_decide_reviews() -> None:
    assert has_permission(Role.CREATOR, Permission.ASSET_CREATE)
    assert has_permission(Role.CREATOR, Permission.ASSET_SUBMIT_REVIEW)
    assert not has_permission(Role.CREATOR, Permission.REVIEW_DECIDE_TECHNICAL)
    assert not has_permission(Role.CREATOR, Permission.REVIEW_DECIDE_SECURITY)
    assert not has_permission(Role.CREATOR, Permission.REVIEW_DECIDE_RELEASE)


@pytest.mark.parametrize(
    ("role", "permission"),
    [
        (Role.TECH_REVIEWER, Permission.REVIEW_DECIDE_TECHNICAL),
        (Role.SECURITY_REVIEWER, Permission.REVIEW_DECIDE_SECURITY),
        (Role.RELEASE_MANAGER, Permission.REVIEW_DECIDE_RELEASE),
    ],
)
def test_each_reviewer_role_owns_exactly_its_own_stage(role: Role, permission: Permission) -> None:
    assert has_permission(role, permission)
    other_stage_permissions = {
        Permission.REVIEW_DECIDE_TECHNICAL,
        Permission.REVIEW_DECIDE_SECURITY,
        Permission.REVIEW_DECIDE_RELEASE,
    } - {permission}
    for other in other_stage_permissions:
        assert not has_permission(role, other), f"{role} must not hold {other}"


def test_release_manager_can_suspend_and_deprecate_and_publish() -> None:
    assert has_permission(Role.RELEASE_MANAGER, Permission.ASSET_SUSPEND)
    assert has_permission(Role.RELEASE_MANAGER, Permission.ASSET_DEPRECATE)
    assert has_permission(Role.RELEASE_MANAGER, Permission.DEPLOYMENT_PUBLISH)


def test_creator_cannot_publish_or_suspend_or_deprecate() -> None:
    """§3.2 assigns publish/suspend/deprecate to RELEASE_MANAGER only."""
    assert not has_permission(Role.CREATOR, Permission.DEPLOYMENT_PUBLISH)
    assert not has_permission(Role.CREATOR, Permission.ASSET_SUSPEND)
    assert not has_permission(Role.CREATOR, Permission.ASSET_DEPRECATE)


def test_auditor_can_read_audit_but_not_decide_reviews_or_publish() -> None:
    assert has_permission(Role.AUDITOR, Permission.AUDIT_READ)
    assert not has_permission(Role.AUDITOR, Permission.REVIEW_DECIDE_TECHNICAL)
    assert not has_permission(Role.AUDITOR, Permission.DEPLOYMENT_PUBLISH)


def test_only_admin_and_auditor_can_read_audit_events() -> None:
    for role in Role:
        expected = role in (Role.ADMIN, Role.AUDITOR)
        assert has_permission(role, Permission.AUDIT_READ) is expected


def test_require_permission_raises_on_denial() -> None:
    with pytest.raises(PermissionDeniedError) as exc_info:
        require_permission(Role.USER, Permission.ASSET_CREATE)
    assert exc_info.value.role is Role.USER
    assert exc_info.value.permission is Permission.ASSET_CREATE


def test_require_permission_is_silent_on_grant() -> None:
    require_permission(Role.ADMIN, Permission.AUDIT_READ)  # must not raise


def test_every_role_has_a_matrix_entry() -> None:
    for role in Role:
        assert role in ROLE_PERMISSIONS
