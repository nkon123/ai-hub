"""Shared Error Envelope helper — 07-data-api-contracts.md §10.2.

```json
{"error": {"code": "...", "message": "...", "trace_id": "...", "details": {}}}
```
"""

from __future__ import annotations

from fastapi.responses import JSONResponse


def error_response(
    status_code: int,
    code: str,
    message: str,
    trace_id: str,
    details: dict | None = None,
) -> JSONResponse:
    payload: dict = {"error": {"code": code, "message": message, "trace_id": trace_id}}
    if details:
        payload["error"]["details"] = details
    return JSONResponse(status_code=status_code, content=payload)


def not_found(message: str, trace_id: str) -> JSONResponse:
    return error_response(404, "RESOURCE_NOT_FOUND", message, trace_id)
