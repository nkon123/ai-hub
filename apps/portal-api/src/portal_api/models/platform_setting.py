"""PlatformSetting model — M02, P15 관리자 설정의 편집 가능 하위 영역들
(open-decisions.md D-065 UPDATE, D-092).

A small generic key/value table, not a dedicated single-purpose table like
`AssetVersionRevocation` — deliberately, because P15's storage gap (D-065)
is not specific to any one setting: it is any small admin-configurable
scalar that doesn't warrant its own migration + model + router wiring on its
own. Keys stored here today are `portal_api.platform_settings.
INDEXING_EMBED_MODEL_KEY`(D-065 UPDATE/D-075) and `CHAT_MODEL_KEY`(D-092) —
see that module for the read/write helpers and `routers/admin.py` for the
endpoints. Adding another setting later means adding a new key constant, not
a new table.

Every write is attributed (`updated_by_user_id`) and trace-correlated
(`trace_id`, CLAUDE.md 원칙 9) — this is a real operational knob (D-075: the
model used for all NEW indexing going forward), not read-only reporting like
the rest of P15.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from portal_api.database import Base


def _now() -> datetime:
    return datetime.now(UTC)


class PlatformSetting(Base):
    __tablename__ = "platform_settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )
    updated_by_user_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
    trace_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
