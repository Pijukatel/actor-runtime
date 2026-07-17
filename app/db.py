"""Metadata persistence for Actors, versions, builds and runs (SQLAlchemy async)."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    username: Mapped[str] = mapped_column(String, primary_key=True)
    token: Mapped[str | None] = mapped_column(String, unique=True, nullable=True)
    # A second, runtime-fabricated credential injected into every container as
    # APIFY_TOKEN -- never the bound ``token`` above, which for local-user may
    # be a real externally-issued secret bound by the first-ever request (see
    # requirements/test.md's anti-leak guarantee). Minted once per user at
    # creation (service.ensure_default_user / create_user); safe to leak.
    container_token: Mapped[str | None] = mapped_column(String, unique=True, nullable=True)
    created_at: Mapped[str] = mapped_column(String, default=utcnow)


class Actor(Base):
    __tablename__ = "actors"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # username~name
    name: Mapped[str] = mapped_column(String)
    username: Mapped[str] = mapped_column(String)
    created_at: Mapped[str] = mapped_column(String, default=utcnow)
    modified_at: Mapped[str] = mapped_column(String, default=utcnow)
    default_run_options: Mapped[dict] = mapped_column(JSON, default=dict)
    # {isEnabled, idleTimeoutSecs, build, memoryMbytes, shouldPassActorInput} --
    # mirrors apify-core's actorStandby; see standby._normalize_standby_config.
    actor_standby: Mapped[dict] = mapped_column(JSON, default=dict)


class Version(Base):
    __tablename__ = "versions"

    actor_id: Mapped[str] = mapped_column(ForeignKey("actors.id"), primary_key=True)
    version_number: Mapped[str] = mapped_column(String, primary_key=True)
    build_tag: Mapped[str] = mapped_column(String, default="latest")
    source_type: Mapped[str] = mapped_column(String, default="SOURCE_FILES")
    source_files: Mapped[list] = mapped_column(JSON, default=list)
    tarball_url: Mapped[str | None] = mapped_column(String, default=None, nullable=True)


class Build(Base):
    __tablename__ = "builds"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("actors.id"))
    username: Mapped[str] = mapped_column(String, default="")
    version_number: Mapped[str] = mapped_column(String)
    build_number: Mapped[str] = mapped_column(String)
    build_tag: Mapped[str] = mapped_column(String, default="latest")
    status: Mapped[str] = mapped_column(String, default="RUNNING")
    image_tag: Mapped[str] = mapped_column(String, default="")
    log: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[str] = mapped_column(String, default=utcnow)
    finished_at: Mapped[str | None] = mapped_column(String, nullable=True)


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("actors.id"))
    username: Mapped[str] = mapped_column(String, default="")
    build_id: Mapped[str] = mapped_column(String)
    build_number: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="RUNNING")
    exit_code: Mapped[int | None] = mapped_column(nullable=True)
    options: Mapped[dict] = mapped_column(JSON, default=dict)
    run_input: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    kv_store_id: Mapped[str] = mapped_column(String)
    dataset_id: Mapped[str] = mapped_column(String)
    request_queue_id: Mapped[str] = mapped_column(String)
    # True for a run started by the standby manager (long-lived, reaped on
    # idle by Service.reap_idle_standby_runs) rather than a normal one-shot
    # POST /{actorId}/runs call.
    is_standby: Mapped[bool] = mapped_column(default=False)
    log: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[str] = mapped_column(String, default=utcnow)
    finished_at: Mapped[str | None] = mapped_column(String, nullable=True)


class Storage(Base):
    __tablename__ = "storages"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    type: Mapped[str] = mapped_column(String)  # key-value-store / dataset / request-queue
    owner: Mapped[str] = mapped_column(String)
    created_at: Mapped[str] = mapped_column(String, default=utcnow)


class AccessRight(Base):
    __tablename__ = "access_rights"
    __table_args__ = (UniqueConstraint("grantee", "resource_id", name="uq_grantee_resource"),)

    id: Mapped[str] = mapped_column(String, primary_key=True)
    resource_type: Mapped[str] = mapped_column(String)
    resource_id: Mapped[str] = mapped_column(String)
    grantee: Mapped[str] = mapped_column(String)
    level: Mapped[str] = mapped_column(String)  # READ / WRITE


class Database:
    """Owns the async engine and session factory for metadata."""

    def __init__(self, url: str) -> None:
        # Wait (up to ``timeout`` seconds) for a lock instead of failing
        # immediately, so the bootstrap compare-and-swap serializes cleanly under
        # concurrent first-token requests rather than raising "database is locked".
        self._engine = create_async_engine(url, future=True, connect_args={"timeout": 30})
        self._session_factory = async_sessionmaker(self._engine, expire_on_commit=False)

    async def create_all(self) -> None:
        async with self._engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    def session(self) -> AsyncSession:
        return self._session_factory()

    async def dispose(self) -> None:
        await self._engine.dispose()
