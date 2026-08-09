"""Test Identity Adapter — D-001 PoC assumption.

In production, replace with SSO/OIDC integration.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Header, HTTPException, status


@dataclass
class UserContext:
    user_id: str
    org: str
    site: str
    role: str
    display_name: str


_TEST_TOKENS: dict[str, UserContext] = {
    "dev-user-token": UserContext(
        user_id="dev-user@miracom.com",
        org="miracom",
        site="headquarters",
        role="CREATOR",
        display_name="개발자",
    ),
    "dev-admin-token": UserContext(
        user_id="admin@miracom.com",
        org="miracom",
        site="headquarters",
        role="ADMIN",
        display_name="관리자",
    ),
    "dev-reviewer-token": UserContext(
        user_id="reviewer@miracom.com",
        org="miracom",
        site="headquarters",
        role="TECH_REVIEWER",
        display_name="기술검토자",
    ),
    "dev-release-token": UserContext(
        user_id="release-manager@miracom.com",
        org="miracom",
        site="headquarters",
        role="RELEASE_MANAGER",
        display_name="배포관리자",
    ),
    "dev-security-token": UserContext(
        user_id="security-reviewer@miracom.com",
        org="miracom",
        site="headquarters",
        role="SECURITY_REVIEWER",
        display_name="보안검토자",
    ),
    "dev-auditor-token": UserContext(
        user_id="auditor@miracom.com",
        org="miracom",
        site="headquarters",
        role="AUDITOR",
        display_name="감사자",
    ),
}


async def get_current_user(authorization: str | None = Header(default=None)) -> UserContext:
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Authorization header required"
        )

    token = authorization.removeprefix("Bearer ").strip()
    user = _TEST_TOKENS.get(token)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    return user
