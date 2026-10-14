# pyright: reportAny=false, reportImplicitOverride=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUnusedImport=false, reportUnusedParameter=false
# pyright: reportAttributeAccessIssue=false, reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

"""Scene: the registered scheduler path delivers source-owned work.

Covers backend scene test 2: ``run_due_schedules_once`` against the test
engine creates one Occurrence, one source-owned Batch, ordered Attempts,
a next UTC run time, and owner routing.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool

from apo.models.db import (
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    AgentTaskScheduleOccurrenceDB,
    ProjectDB,
    ProjectMembershipDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    TaskExecutionAttemptDB,
    UserDB,
)

_PROJECT = "acme-evals"


def _now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture
def bound_engine(monkeypatch):
    """Create an isolated engine and bind the scheduler module to it."""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    import apo.services.agent_task_scheduler as sched

    monkeypatch.setattr(sched, "engine", engine)
    return engine, sched


def _seed_source_owned_schedule(engine) -> str:
    with Session(engine) as session:
        owner = UserDB(email="owner@test.com", name="Owner", password_hash="x", is_active=True)
        session.add(owner)
        session.commit()
        session.refresh(owner)

        session.add(ProjectDB(id=_PROJECT, name="Acme", created_by=owner.id))
        session.commit()
        now = _now()
        session.add(
            ProjectMembershipDB(
                project_id=_PROJECT, user_id=owner.id, role="admin",
                created_at=now, updated_at=now,
            )
        )
        source = ProjectTaskSourceDB(
            project=_PROJECT, source_type="published",
            catalog_digest="sha256:c", task_count=2, status="ready",
        )
        session.add(source)
        session.commit()
        session.refresh(source)
        for tid in ("support/refund", "support/cancel"):
            display = tid.split("/")[-1]
            session.add(
                ProjectTaskInventoryDB(
                    project=_PROJECT, task_source_id=source.id, task_id=tid,
                    task_inventory_id=tid, display_name=display, adapter_name="cc",  # pyright: ignore[reportCallIssue]
                    folder_path="support", task_path=f"tasks/{tid}", source_type="published",
                )
            )
        schedule = AgentTaskScheduleDB(
            id="sched-1", project=_PROJECT, name="Nightly",
            selection_type="tasks",
            selection_query={"kind": "tasks", "task_ids": ["support/refund", "support/cancel"]},
            environment="default", cadence_type="daily", timezone="UTC",
            hour=9, minute=0, next_run_at=now - timedelta(minutes=5),
            execution_kind="source_owned", execution_owner_user_id=owner.id,
        )
        session.add(schedule)
        session.commit()
        return owner.id


def test_run_due_schedules_once_creates_occurrence_and_source_owned_batch(bound_engine):
    engine, sched = bound_engine
    owner_id = _seed_source_owned_schedule(engine)

    created = sched.run_due_schedules_once()

    assert created == 1
    with Session(engine) as session:
        occs = list(
            session.exec(
                select(AgentTaskScheduleOccurrenceDB).where(
                    AgentTaskScheduleOccurrenceDB.schedule_id == "sched-1"
                )
            ).all()
        )
        assert len(occs) == 1
        assert occs[0].status == "pending"
        assert occs[0].kind == "scheduled"
        assert occs[0].batch_run_id is not None

        from apo.models.db import AgentTaskBatchRunDB

        batch = session.get(AgentTaskBatchRunDB, occs[0].batch_run_id)
        assert batch.execution_target_json == {"kind": "source_owned"}  # pyright: ignore[reportOptionalMemberAccess]
        # The owner is the target; nobody asked for a cron Occurrence.
        assert batch.requested_by_user_id is None  # pyright: ignore[reportOptionalMemberAccess]
        runs = list(
            session.exec(
                select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch.id)  # pyright: ignore[reportOptionalMemberAccess]
            ).all()
        )
        assert [r.sequence_index for r in runs] == [0, 1]
        attempts = list(
            session.exec(
                select(TaskExecutionAttemptDB).where(
                    TaskExecutionAttemptDB.batch_run_id == batch.id  # pyright: ignore[reportOptionalMemberAccess]
                )
            ).all()
        )
        assert all(a.target_user_id == owner_id for a in attempts)
        assert all(a.assignment_kind == "source_owned" for a in attempts)

        schedule = session.get(AgentTaskScheduleDB, "sched-1")
        assert schedule.active_batch_run_id == batch.id  # pyright: ignore[reportOptionalMemberAccess]
        assert schedule.next_run_at is not None  # pyright: ignore[reportOptionalMemberAccess]
        # next_run_at round-trips through SQLite naive (UTC implied); compare
        # as UTC so the next cadence is provably in the future.
        next_run = schedule.next_run_at  # pyright: ignore[reportOptionalMemberAccess]
        if next_run.tzinfo is None:
            next_run = next_run.replace(tzinfo=timezone.utc)
        assert next_run > _now()


def test_run_due_schedules_once_is_idempotent_across_duplicate_polls(bound_engine):
    engine, sched = bound_engine
    _seed_source_owned_schedule(engine)

    sched.run_due_schedules_once()
    # Re-running before the cadence advanced past the next poll window: the
    # Schedule is no longer due (next_run_at is now future), so no second Batch.
    second = sched.run_due_schedules_once()

    assert second == 0
    with Session(engine) as session:
        occs = list(
            session.exec(select(AgentTaskScheduleOccurrenceDB)).all()
        )
        assert len(occs) == 1


# ============================================================================
# Route scene tests (create / trigger / occurrences)
# ============================================================================


def _seed_project_member(engine, *, email: str, role: str = "admin"):
    from apo.models.db import UserDB

    with Session(engine) as session:
        user = UserDB(email=email, name=email, password_hash="x", is_active=True)
        session.add(user)
        session.commit()
        session.refresh(user)
        if session.get(ProjectDB, _PROJECT) is None:
            session.add(ProjectDB(id=_PROJECT, name="Acme", created_by=user.id))
            session.commit()
        now = _now()
        session.add(
            ProjectMembershipDB(
                project_id=_PROJECT, user_id=user.id, role=role,
                created_at=now, updated_at=now,
            )
        )
        session.commit()
        return user.id


def _seed_catalog(engine) -> None:
    with Session(engine) as session:
        source = ProjectTaskSourceDB(
            project=_PROJECT, source_type="published",
            catalog_digest="sha256:c", task_count=2, status="ready",
        )
        session.add(source)
        session.commit()
        session.refresh(source)
        for tid in ("support/refund", "support/cancel"):
            display = tid.split("/")[-1]
            session.add(
                ProjectTaskInventoryDB(
                    project=_PROJECT, task_source_id=source.id, task_id=tid,
                    task_inventory_id=tid, display_name=display, adapter_name="cc",  # pyright: ignore[reportCallIssue]
                    folder_path="support", task_path=f"tasks/{tid}", source_type="published",
                )
            )
        session.commit()


def test_create_source_owned_schedule_route(bound_engine, monkeypatch):
    """Admin creates a native source-owned Schedule through the route."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from starlette.middleware.base import BaseHTTPMiddleware
    from apo.api import app
    from apo.db import get_session

    engine, _ = bound_engine
    owner_id = _seed_project_member(engine, email="owner@test.com")
    _seed_catalog(engine)

    class Inject(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            request.state.user_id = owner_id
            request.state.is_admin = True
            return await call_next(request)

    test_app = FastAPI()
    test_app.include_router(app.router)
    test_app.add_middleware(Inject)
    test_app.dependency_overrides[get_session] = lambda: Session(engine)
    client = TestClient(test_app)

    resp = client.post(
        "/v1/agent-task-schedules",
        json={
            "project": _PROJECT,
            "name": "Nightly",
            "selection": {"kind": "tasks", "task_ids": ["support/refund", "support/cancel"]},
            "cadence_type": "daily",
            "timezone": "UTC",
            "hour": 9,
            "minute": 0,
        },
    )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["execution_kind"] == "source_owned"
    assert body["execution_owner"] == {"id": owner_id, "name": "owner@test.com"}
    assert body["active_batch_run_id"] is None
    assert body["missed_occurrences"] == 0
    # No Pool/source/path data leaks.
    assert body["executor_pool_id"] is None


def test_trigger_route_creates_manual_occurrence(bound_engine):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from starlette.middleware.base import BaseHTTPMiddleware
    from apo.api import app
    from apo.db import get_session

    engine, _ = bound_engine
    owner_id = _seed_project_member(engine, email="owner@test.com")
    _seed_catalog(engine)
    schedule_id = _create_source_owned_schedule_row(engine, owner_id)

    class Inject(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            request.state.user_id = owner_id
            request.state.is_admin = True
            return await call_next(request)

    test_app = FastAPI()
    test_app.include_router(app.router)
    test_app.add_middleware(Inject)
    test_app.dependency_overrides[get_session] = lambda: Session(engine)
    client = TestClient(test_app)

    first = client.post(f"/v1/agent-task-schedules/{schedule_id}/trigger")
    second = client.post(f"/v1/agent-task-schedules/{schedule_id}/trigger")

    assert first.status_code == 200, first.text
    body1 = first.json()
    assert body1["created"] is True
    assert body1["batch_run_id"] is not None
    assert body1["occurrence_id"] is not None
    # Second trigger returns the now-active Batch with created=False.
    assert second.status_code == 200
    body2 = second.json()
    assert body2["created"] is False
    assert body2["batch_run_id"] == body1["batch_run_id"]


def test_run_now_records_the_presser_and_still_targets_the_owner(bound_engine):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from starlette.middleware.base import BaseHTTPMiddleware
    from apo.api import app
    from apo.db import get_session
    from apo.models.db import AgentTaskBatchRunDB

    engine, _ = bound_engine
    owner_id = _seed_project_member(engine, email="owner@test.com")
    presser_id = _seed_project_member(engine, email="presser@test.com")
    _seed_catalog(engine)
    schedule_id = _create_source_owned_schedule_row(engine, owner_id)

    class Inject(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            request.state.user_id = presser_id
            request.state.auth_method = "cookie"
            request.state.is_admin = False
            return await call_next(request)

    test_app = FastAPI()
    test_app.include_router(app.router)
    test_app.add_middleware(Inject)
    test_app.dependency_overrides[get_session] = lambda: Session(engine)
    client = TestClient(test_app)

    resp = client.post(f"/v1/agent-task-schedules/{schedule_id}/trigger")

    assert resp.status_code == 200, resp.text
    batch_id = resp.json()["batch_run_id"]
    with Session(engine) as session:
        batch = session.get(AgentTaskBatchRunDB, batch_id)
        assert batch is not None and batch.requested_by_user_id == presser_id
        attempts = session.exec(
            select(TaskExecutionAttemptDB).where(TaskExecutionAttemptDB.batch_run_id == batch_id)
        ).all()
        assert attempts and all(a.target_user_id == owner_id for a in attempts)


def test_occurrences_history_is_membership_scoped(bound_engine):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from starlette.middleware.base import BaseHTTPMiddleware
    from apo.api import app
    from apo.db import get_session

    engine, _ = bound_engine
    owner_id = _seed_project_member(engine, email="owner@test.com")
    _seed_catalog(engine)
    schedule_id = _create_source_owned_schedule_row(engine, owner_id)

    # An outsider with no membership.
    from apo.models.db import UserDB

    with Session(engine) as session:
        outsider = UserDB(email="x@test.com", name="X", password_hash="x", is_active=True)
        session.add(outsider)
        session.commit()
        session.refresh(outsider)
        outsider_id = outsider.id

    def client_for(uid):
        class Inject(BaseHTTPMiddleware):
            async def dispatch(self, request, call_next):
                request.state.user_id = uid
                request.state.is_admin = False
                return await call_next(request)

        test_app = FastAPI()
        test_app.include_router(app.router)
        test_app.add_middleware(Inject)
        test_app.dependency_overrides[get_session] = lambda: Session(engine)
        return TestClient(test_app)

    owner_resp = client_for(owner_id).get(
        f"/v1/agent-task-schedules/{schedule_id}/occurrences"
    )
    outsider_resp = client_for(outsider_id).get(
        f"/v1/agent-task-schedules/{schedule_id}/occurrences"
    )

    assert owner_resp.status_code == 200
    assert outsider_resp.status_code in (403, 404)


def _create_source_owned_schedule_row(engine, owner_id) -> str:
    from apo.models.db import AgentTaskScheduleDB

    with Session(engine) as session:
        schedule = AgentTaskScheduleDB(
            id="sched-route", project=_PROJECT, name="Nightly",
            selection_type="tasks",
            selection_query={"kind": "tasks", "task_ids": ["support/refund"]},
            environment="default", cadence_type="daily", timezone="UTC",
            hour=9, minute=0, next_run_at=_now() - timedelta(minutes=5),
            execution_kind="source_owned", execution_owner_user_id=owner_id,
        )
        session.add(schedule)
        session.commit()
        return schedule.id


def test_owner_membership_removal_pauses_their_schedules(bound_engine):
    """Acceptance 17: an owner who leaves pauses their schedules (never retargets)."""
    from apo.services.project_memberships import remove_member

    engine, _ = bound_engine
    owner_id = _seed_project_member(engine, email="owner@test.com")
    _seed_catalog(engine)
    schedule_id = _create_source_owned_schedule_row(engine, owner_id)

    with Session(engine) as session:
        # Owner is the sole member; add a second owner so removal is allowed.
        from apo.models.db import UserDB

        second = UserDB(email="admin2@test.com", name="A2", password_hash="x", is_active=True)
        session.add(second)
        session.commit()
        session.refresh(second)
        now = _now()
        session.add(
            ProjectMembershipDB(
                project_id=_PROJECT, user_id=second.id, role="owner",
                created_at=now, updated_at=now,
            )
        )
        session.commit()

        remove_member(
            session, _PROJECT, owner_id, actor_id=second.id, actor_role="owner"
        )

        schedule = session.get(AgentTaskScheduleDB, schedule_id)
        assert schedule is not None
        assert schedule.enabled is False
        assert schedule.disabled_reason == "execution_owner_unavailable"
        assert schedule.next_run_at is None
