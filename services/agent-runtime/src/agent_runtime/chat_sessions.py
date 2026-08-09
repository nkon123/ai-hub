"""In-memory Hosted Chat session store (PoC — no persistence, D-029).

A session binds slug -> resolved deployment identity (revision id, knowledge
id, model alias) at creation time. Binding at creation, rather than
re-resolving the slug on every message, means a deployment that gets
suspended or republished mid-conversation cannot silently redirect an
in-flight session to different underlying Knowledge.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from uuid import uuid4

SESSION_TTL_SECONDS = 30 * 60
RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMIT_MAX_MESSAGES = 20


@dataclass
class ChatSessionRecord:
    id: str
    slug: str
    deployment_revision_id: str
    knowledge_id: str
    model_alias: str
    status: str  # ACTIVE | EXPIRED | TERMINATED
    trace_id: str
    created_at: datetime
    expires_at: datetime
    message_count: int = 0
    in_flight: bool = False
    _message_timestamps: list[datetime] = field(default_factory=list, repr=False)


class ChatSessionStore:
    """In-memory registry of Hosted Chat sessions and their per-session rate limit."""

    def __init__(self, ttl_seconds: int = SESSION_TTL_SECONDS) -> None:
        self._sessions: dict[str, ChatSessionRecord] = {}
        self._ttl_seconds = ttl_seconds

    def create(
        self,
        slug: str,
        deployment_revision_id: str,
        knowledge_id: str,
        model_alias: str,
        trace_id: str,
    ) -> ChatSessionRecord:
        now = datetime.now(UTC)
        record = ChatSessionRecord(
            id=str(uuid4()),
            slug=slug,
            deployment_revision_id=deployment_revision_id,
            knowledge_id=knowledge_id,
            model_alias=model_alias,
            status="ACTIVE",
            trace_id=trace_id,
            created_at=now,
            expires_at=now + timedelta(seconds=self._ttl_seconds),
        )
        self._sessions[record.id] = record
        return record

    def get_active(self, session_id: str) -> ChatSessionRecord | None:
        """Return the session only if it exists and is still within its TTL.

        Lazily flips an expired record's status to EXPIRED on read instead of
        relying on a background sweep — acceptable for a PoC in-memory store.
        """
        record = self._sessions.get(session_id)
        if record is None:
            return None
        if record.status != "ACTIVE":
            return None
        if datetime.now(UTC) >= record.expires_at:
            record.status = "EXPIRED"
            return None
        return record

    def check_rate_limit(self, record: ChatSessionRecord) -> bool:
        """Enforce the ~20 messages/minute per-session limit.

        Returns True (and records this call's timestamp) if under the limit,
        False if the limit is already reached.
        """
        now = datetime.now(UTC)
        window_start = now - timedelta(seconds=RATE_LIMIT_WINDOW_SECONDS)
        record._message_timestamps = [t for t in record._message_timestamps if t >= window_start]
        if len(record._message_timestamps) >= RATE_LIMIT_MAX_MESSAGES:
            return False
        record._message_timestamps.append(now)
        return True


chat_session_store = ChatSessionStore()
