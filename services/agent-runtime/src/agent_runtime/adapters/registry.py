"""Asset Registry resolver backed by portal-api (D-034).

`HttpAssetRegistryResolver` is the production implementation of
`AssetRegistryResolver` — see that interface's docstring
(`agent_runtime.adapters.__init__`) and `agent_runtime.manifests`' module
docstring for the resolution order this backs.
"""

from __future__ import annotations

from typing import Any

import httpx

from agent_runtime.adapters import AssetRegistryResolver


class HttpAssetRegistryResolver(AssetRegistryResolver):
    """Calls portal-api's authenticated `GET /api/v1/asset-versions/{id}`
    and `GET /api/v1/asset-versions/{id}/template`.

    `token` is a PoC Test Identity Adapter bearer token (D-001,
    `apps/portal-api/src/portal_api/auth.py`) — there is no service-identity
    concept yet, so this runtime authenticates as a fixed dev identity with
    ASSET_READ (granted to every role). Not a secret: the same literal token
    is already hardcoded in `apps/portal-web/app/knowledge/new/page.tsx`.
    """

    def __init__(self, portal_api_url: str, token: str) -> None:
        self._portal_api_url = portal_api_url
        self._headers = {"Authorization": f"Bearer {token}"}

    async def get_asset_version(self, version_id: str) -> dict[str, Any] | None:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                f"{self._portal_api_url}/api/v1/asset-versions/{version_id}",
                headers=self._headers,
            )
            if response.status_code == 404:
                return None
            response.raise_for_status()
            return response.json()  # type: ignore[no-any-return]

    async def get_prompt_template(self, version_id: str) -> str | None:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                f"{self._portal_api_url}/api/v1/asset-versions/{version_id}/template",
                headers=self._headers,
            )
            if response.status_code == 404:
                return None
            response.raise_for_status()
            return response.json()["content"]  # type: ignore[no-any-return]
