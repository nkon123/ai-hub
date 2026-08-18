"""Fixtures for portal-api integration tests (M02).

Uses an isolated in-memory SQLite database per test (StaticPool keeps the
same connection alive across sessions within one test) so these tests never
touch the real `apps/portal-api/portal.db` used by the running dev server.
`httpx.ASGITransport` never invokes the app's `lifespan` (which calls the
real `init_db()` against `settings.database_url`), so the production
database is never opened here either.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from portal_api.database import Base, get_db
from portal_api.main import app
from portal_api.models import Asset, AssetVersion, IndexingJob  # noqa: F401 — registers metadata
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool


@pytest.fixture
async def db_engine():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest.fixture
def session_factory(db_engine):
    return async_sessionmaker(db_engine, expire_on_commit=False)


@pytest.fixture
async def db(session_factory) -> AsyncIterator[AsyncSession]:
    async with session_factory() as session:
        yield session


@pytest.fixture
async def client(session_factory) -> AsyncIterator[httpx.AsyncClient]:
    async def _get_db() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db] = _get_db
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _isolated_index_base(tmp_path, monkeypatch):
    """이 패키지의 모든 테스트를 저장소의 실제 `data/indexes/` 에서 격리한다.

    두 가지를 동시에 막는다: (a) 테스트가 실제 색인 디렉터리를 우연히 읽어
    "없어야 할 것이 있는" 상태로 통과하는 것(`hr-policy-v1` 은 이 체크아웃에
    실제로 존재한다), (b) 테스트가 실제 운영 데이터에 쓰는 것. 아래
    `make_indexed_knowledge` 가 만드는 색인 산출물도 전부 이 tmp 아래에
    생성된다."""
    from portal_api.config import settings

    base = tmp_path / "indexes"
    base.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "index_base", base)
    return base


def auth_header(token: str = "dev-user-token") -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def make_indexed_knowledge(db: AsyncSession, *, indexed: bool = True) -> AssetVersion:
    """Insert a Knowledge Asset + AssetVersion (+ optional COMPLETED IndexingJob)."""
    asset = Asset(
        type="knowledge",
        name="hr-policy-knowledge",
        owner_org="miracom",
        owner_creator_id="dev-user@miracom.com",
        classification="INTERNAL",
    )
    db.add(asset)
    await db.flush()

    version = AssetVersion(
        asset_id=asset.id,
        version="1.0.0",
        status="APPROVED",
        manifest={"type": "knowledge", "name": asset.name},
    )
    db.add(version)
    await db.flush()

    if indexed:
        # 예전에는 존재하지 않는 경로 문자열만 넣었다. 그러면 "승인된
        # Knowledge" 픽스처가 실제로는 **반출할 수 없는** 상태를 대표하게 되고,
        # 2026-08-14 에 Distribution 생성 Gate(색인이 온전할 때만 반출 허용)를
        # 넣자 12개 테스트가 한꺼번에 막혔다 — 테스트가 틀린 계약을 담고 있던
        # 것이 아니라, 픽스처가 현실을 대표하지 못했던 것이다. 이제 검사가
        # 요구하는 산출물을 실제로 만든다(`portal_api.knowledge_readiness`).
        from portal_api.config import settings

        index_dir = Path(settings.index_base) / version.id
        (index_dir / "chroma").mkdir(parents=True, exist_ok=True)
        (index_dir / "index-meta.json").write_text(
            json.dumps(
                {
                    "knowledge_id": version.id,
                    "embed_model": "qwen3-embedding:0.6b",
                    "classification": "INTERNAL",
                    "chunk_count": 42,
                }
            ),
            encoding="utf-8",
        )
        (index_dir / "bm25.json").write_text("{}", encoding="utf-8")

        job = IndexingJob(
            asset_version_id=version.id,
            status="COMPLETED",
            chunk_count=42,
            index_path=str(index_dir),
        )
        db.add(job)

    await db.commit()
    await db.refresh(version)
    return version


async def make_draft_asset_version(
    db: AsyncSession,
    *,
    owner_creator_id: str = "dev-user@miracom.com",
    name: str = "draft-knowledge",
) -> AssetVersion:
    """Insert a DRAFT Knowledge Asset + AssetVersion for review-workflow tests."""
    asset = Asset(
        type="knowledge",
        name=name,
        owner_org="miracom",
        owner_creator_id=owner_creator_id,
        classification="INTERNAL",
    )
    db.add(asset)
    await db.flush()

    version = AssetVersion(
        asset_id=asset.id,
        version="1.0.0",
        status="DRAFT",
        manifest={"type": "knowledge", "name": asset.name},
        manifest_hash="deadbeef",
    )
    db.add(version)
    await db.commit()
    await db.refresh(version)
    return version


def build_service_definition(knowledge_version: AssetVersion, **overrides: object) -> dict:
    definition: dict = {
        "schema_version": "1.0",
        "id": str(uuid.uuid4()),
        "type": "service",
        "name": "HR 정책 챗봇",
        "version": "1.0.0",
        "owner": {"org": "miracom", "team": "hr", "creator_id": "dev-user@miracom.com"},
        "classification": "INTERNAL",
        "description": "사내 HR 정책 질문에 답변하는 Knowledge 챗봇",
        "agent_ref": {"id": str(uuid.uuid4()), "version": "1.0.0"},
        "knowledge_bindings": [
            {
                "role_id": "answerer",
                "knowledge_id": knowledge_version.id,
                "knowledge_version": knowledge_version.version,
                "retrieval_profile_ref": {"name": "default-korean", "version": "1.0.0"},
                "context_token_limit": 4096,
            }
        ],
        "prompt_bindings": [],
        "model_policy": {
            "model_alias": "default-chat",
            "fallback_allowed": False,
            "max_context_tokens": 8192,
        },
        "target_users": {"orgs": ["miracom"], "roles": ["USER", "CREATOR"]},
        "limits": {
            "timeout_seconds": 60,
            "max_mcp_calls": 0,
            "max_context_tokens": 8192,
            "audit_level": "standard",
        },
        "chatbot_config": {
            "welcome_message": "안녕하세요! HR 정책에 대해 궁금한 점을 물어보세요.",
            "suggested_questions": ["연차 휴가는 몇 일인가요?"],
            "citation_display": True,
        },
    }
    definition.update(overrides)
    return definition
