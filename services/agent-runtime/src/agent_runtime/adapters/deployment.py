"""Deployment resolver backed by portal-api's slug-resolution endpoint."""

from __future__ import annotations

from typing import Any

import httpx

from agent_runtime.adapters import DeploymentResolver


class HttpDeploymentResolver(DeploymentResolver):
    """Calls portal-api's `GET /api/v1/deployments/by-slug/{slug}`.

    That endpoint is deliberately unauthenticated (server-to-server, D-035)
    and returns the exact same 404 body for an unknown slug and for a
    suspended/non-ACTIVE one, so slug existence is never leaked. This adapter
    preserves that property by collapsing both cases to `None`.
    """

    def __init__(self, portal_api_url: str) -> None:
        self._portal_api_url = portal_api_url

    async def resolve(self, slug: str) -> dict[str, Any] | None:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(f"{self._portal_api_url}/api/v1/deployments/by-slug/{slug}")
            if response.status_code == 404:
                return None
            response.raise_for_status()
            return response.json()  # type: ignore[no-any-return]
