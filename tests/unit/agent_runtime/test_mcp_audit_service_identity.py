"""D-034 (i) 남은 절반 — MCP 감사 컨텍스트(mcp-audit-context.schema.json)의
`service_id`/`service_version`이 실재 ServiceVersion을 받았을 때와 그렇지
않을 때 각각 정확히 어떤 값을 담아야 하는지 고정한다.

Direct unit coverage of `agent_runtime.workflow._build_mcp_audit_context` and
`_derive_service_uuid` — no live LLM/Knowledge/MCP adapter needed, these are
pure functions of their inputs.
"""

from __future__ import annotations

import uuid

from agent_runtime.workflow import (
    _POC_SERVICE_VERSION,
    _build_mcp_audit_context,
    _derive_service_uuid,
)

_AGENT_MANIFEST = {"id": "agent-1", "version": "1.0.0"}
_OFFICE_PROFILE = {"org": "miracom", "sites": ["site-1"]}


def test_real_service_version_id_passes_through_unchanged_with_real_version() -> None:
    """A caller (Hosted Chat, once portal-api resolves a real ServiceVersion)
    passes an already-valid UUID as `service_id` plus a real `service_version`
    string. `_derive_service_uuid` must not re-derive it — the audit trail
    must show the exact same id a human could look up via portal-api's
    `GET /service-versions/{id}`, not a fresh UUID5."""
    real_service_version_id = "550e8400-e29b-41d4-a716-446655440abc"

    ctx = _build_mcp_audit_context(
        request_id="req-1",
        trace_id="trace-1",
        run_id="run-1",
        service_id=real_service_version_id,
        agent_manifest=_AGENT_MANIFEST,
        office_profile=_OFFICE_PROFILE,
        tool_name="table_count.query",
        service_version="2.3.1",
    )

    assert ctx["service_id"] == real_service_version_id
    assert ctx["service_version"] == "2.3.1"
    # Sanity: this is exactly what _derive_service_uuid would also return for
    # an already-valid UUID input — the passthrough branch, not the uuid5 one.
    assert ctx["service_id"] == _derive_service_uuid(real_service_version_id)


def test_opaque_service_id_and_omitted_service_version_reproduce_prior_fallback() -> None:
    """Every caller that does not pass `service_version` (every Local Run,
    every Hosted chatbot published before portal-api returned the new field)
    must get byte-for-byte the same fallback as before this change: a UUID5
    derived from the opaque string, and the `_POC_SERVICE_VERSION` sentinel."""
    opaque_slug = "remote-work-guide"

    ctx = _build_mcp_audit_context(
        request_id="req-2",
        trace_id="trace-2",
        run_id="run-2",
        service_id=opaque_slug,
        agent_manifest=_AGENT_MANIFEST,
        office_profile=_OFFICE_PROFILE,
        tool_name="table_count.query",
    )

    assert ctx["service_id"] != opaque_slug
    uuid.UUID(ctx["service_id"])  # must still be well-formed
    assert ctx["service_id"] == _derive_service_uuid(opaque_slug)
    assert ctx["service_version"] == _POC_SERVICE_VERSION
