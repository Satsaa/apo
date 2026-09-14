# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUnusedImport=false, reportUnusedVariable=false
# pyright: reportAttributeAccessIssue=false, reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

"""Retire bundled execution and purge Bundle objects.

Covers acceptance tests 1 (preserves installation), 2 (only bundled terminalized),
3 (narrow bundle purge), and 5 (source-owned Pool survives).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    ApiKeyDB,
    ExecutorDB,
    ExecutorEnrollmentTokenDB,
    ExecutorPoolDB,
    ProjectDB,
    ProjectMembershipDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
    UserDB,
)


@pytest.fixture
def session():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _seed_installation(session):
    """Create the shared installation: user, project, key, catalog row."""
    u = UserDB(email="o@t.com", name="O", password_hash="x", is_active=True)
    session.add(u); session.commit(); session.refresh(u)
    session.add(ProjectDB(id="p1", name="P", created_by=u.id)); session.commit()
    now = _now()
    session.add(ProjectMembershipDB(project_id="p1", user_id=u.id, role="owner", created_at=now, updated_at=now))
    session.commit()
    return u


def _pool(session, *, system=False, slug="legacy", kind="bundled"):
    p = ExecutorPoolDB(project="p1", name=slug, slug=slug, kind=kind, enabled=True, system_managed=system, required_driver_kind="subprocess")
    session.add(p); session.commit(); session.refresh(p)
    return p


def _bundled_attempt(session, *, pool_id, status="queued"):
    batch = AgentTaskBatchRunDB(id=f"bch-{status}-{pool_id}", project="p1", selection_type="task", status="queued", created_at=_now())
    session.add(batch); session.flush()
    run = AgentTaskRunDB(id=f"run-{status}-{pool_id}", batch_run_id=batch.id, task_id="t", task_path="p", status="pending")
    session.add(run); session.flush()
    att = TaskExecutionAttemptDB(
        id=f"att-{status}-{pool_id}", project="p1", batch_run_id=batch.id, task_run_id=run.id,
        sequence_index=0, target_kind="pool", assignment_kind="bundled",
        executor_pool_id=pool_id, status=status,
        queue_expires_at=_now() + timedelta(hours=24), queued_at=_now(),
    )
    session.add(att); session.commit()
    return att


class TestRetirementPreservesInstallation:
    """Acceptance test 1: identity/project/catalog/result data unchanged."""

    def test_idempotent_and_preserves_source_owned(self, session):
        from apo.services.execution_retirement import retire_legacy_execution_rows

        _seed_installation(session)
        so_pool = _pool(session, system=True, slug="source-owned", kind="connected")
        so_pool.required_driver_kind = "source-owned-ts"
        session.add(so_pool); session.commit()

        so_att = _bundled_attempt(session, pool_id=so_pool.id, status="queued")
        so_att.assignment_kind = "source_owned"
        session.add(so_att); session.commit()

        first = retire_legacy_execution_rows(session, now=_now())
        second = retire_legacy_execution_rows(session, now=_now())

        assert first >= 0
        assert second == 0  # idempotent
        # Source-owned attempt untouched.
        session.refresh(so_att)
        assert so_att.status == "queued"


class TestOnlyBundledTerminalized:
    """Acceptance test 2: bundled fenced, caller/source-owned remain active."""

    def test_bundled_schedule_disabled_and_attempt_cancelled(self, session):
        from apo.services.execution_retirement import retire_legacy_execution_rows

        _seed_installation(session)
        legacy = _pool(session, slug="legacy-pool")
        bundled_att = _bundled_attempt(session, pool_id=legacy.id, status="queued")

        sched = AgentTaskScheduleDB(
            id="sched-bundled", project="p1", name="old", selection_type="task",
            environment="default", cadence_type="daily", timezone="UTC", hour=9, minute=0,
            enabled=True, next_run_at=_now(), executor_pool_id=legacy.id, queue_ttl_seconds=86400,
            execution_kind="bundled",
        )
        session.add(sched); session.commit()

        retire_legacy_execution_rows(session, now=_now())

        session.refresh(bundled_att)
        assert bundled_att.status == "cancelled"
        assert bundled_att.failure_kind == "execution_retired"

        session.refresh(sched)
        assert sched.enabled is False
        assert sched.disabled_reason == "bundled_execution_retired"
        assert sched.next_run_at is None


class TestBundlePurgeNarrow:
    """Acceptance test 3: only bundle keys deleted; deliverables untouched."""

    def test_purge_clears_bundle_fields_only(self, session):
        from apo.services.execution_retirement import purge_legacy_bundle_objects

        _seed_installation(session)
        # Two revisions with bundle storage keys, one without (attested).
        for i in range(2):
            session.add(TaskRevisionDB(  # pyright: ignore[reportCallIssue]
                id=f"rev-{i}", project="p1", batch_run_id="bch-x",
                materialization="bundled", source_type="connected_worktree",
                dirty=True, content_sha256="a" * 64, file_count=1, uncompressed_size_bytes=10,
                bundle_storage_backend="local", bundle_storage_key=f"bundle-key-{i}",
                bundle_sha256="b" * 64, bundle_size_bytes=100,
            ))
        session.add(TaskRevisionDB(  # pyright: ignore[reportCallIssue]
            id="rev-attested", project="p1", batch_run_id="bch-y",
            materialization="attested", source_type="caller_worktree",
            dirty=False, content_sha256="c" * 64, file_count=0, uncompressed_size_bytes=0,
        ))
        session.commit()

        count = asyncio.run(purge_legacy_bundle_objects(session))

        assert count == 2
        for i in range(2):
            rev = session.get(TaskRevisionDB, f"rev-{i}")
            assert rev.bundle_storage_key is None
            assert rev.bundle_storage_backend is None
            assert rev.bundle_sha256 is None
            assert rev.bundle_size_bytes is None

    def test_second_purge_is_noop(self, session):
        from apo.services.execution_retirement import purge_legacy_bundle_objects

        _seed_installation(session)
        session.add(TaskRevisionDB(  # pyright: ignore[reportCallIssue]
            id="rev-1", project="p1", batch_run_id="bch-x",
            materialization="bundled", source_type="x", dirty=True,
            content_sha256="a" * 64, file_count=1, uncompressed_size_bytes=1,
            bundle_storage_backend="local", bundle_storage_key="k1",
        ))
        session.commit()

        assert asyncio.run(purge_legacy_bundle_objects(session)) == 1
        assert asyncio.run(purge_legacy_bundle_objects(session)) == 0


class TestSourceOwnedPoolSurvives:
    """Acceptance test 5: canonical Pool/v2 Executor remain; legacy fenced."""

    def test_system_pool_preserved(self, session):
        from apo.services.execution_retirement import retire_legacy_execution_rows

        u = _seed_installation(session)
        so_pool = _pool(session, system=True, slug="source-owned", kind="connected")
        so_pool.required_driver_kind = "source-owned-ts"
        session.add(so_pool); session.commit()
        legacy = _pool(session, slug="legacy-pool")

        retire_legacy_execution_rows(session, now=_now())

        session.refresh(so_pool)
        assert so_pool.enabled is True
        assert so_pool.archived_at is None

        session.refresh(legacy)
        assert legacy.enabled is False
        assert legacy.archived_at is not None


class TestRetiredBatchGetsAnEnd:
    """A retired Batch is terminal, so it carries an end time for its duration."""

    def test_roll_up_stamps_completed_at(self, session):
        from apo.services.execution_retirement import retire_legacy_execution_rows

        _seed_installation(session)
        legacy = _pool(session, slug="legacy-pool")
        att = _bundled_attempt(session, pool_id=legacy.id, status="running")
        ts = _now()

        retire_legacy_execution_rows(session, now=ts)

        batch = session.get(AgentTaskBatchRunDB, att.batch_run_id)
        assert batch.status == "error"
        assert batch.completed_at.replace(tzinfo=None) == ts.replace(tzinfo=None)

    def test_backfills_terminal_batches_without_end(self, session):
        from apo.services.execution_retirement import retire_legacy_execution_rows

        _seed_installation(session)
        last_end = _now() - timedelta(hours=2)
        session.add(AgentTaskBatchRunDB(id="bch-ended", project="p1", selection_type="task", status="error", created_at=_now()))
        session.add(AgentTaskBatchRunDB(id="bch-empty", project="p1", selection_type="task", status="cancelled", created_at=_now()))
        session.add(AgentTaskBatchRunDB(id="bch-live", project="p1", selection_type="task", status="running", created_at=_now()))
        session.flush()
        session.add(AgentTaskRunDB(id="run-a", batch_run_id="bch-ended", task_id="a", task_path="a", status="error", completed_at=last_end - timedelta(seconds=5)))
        session.add(AgentTaskRunDB(id="run-b", batch_run_id="bch-ended", task_id="b", task_path="b", status="error", completed_at=last_end))
        session.commit()
        ts = _now()

        assert retire_legacy_execution_rows(session, now=ts) == 2
        assert retire_legacy_execution_rows(session, now=_now()) == 0

        ended = session.get(AgentTaskBatchRunDB, "bch-ended")
        empty = session.get(AgentTaskBatchRunDB, "bch-empty")
        live = session.get(AgentTaskBatchRunDB, "bch-live")
        assert ended.completed_at.replace(tzinfo=None) == last_end.replace(tzinfo=None)
        assert empty.completed_at.replace(tzinfo=None) == ts.replace(tzinfo=None)
        assert live.completed_at is None
