# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false
# pyright: reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

"""Source attestation re-pins a dashboard Run to the eval source it executed.

A dashboard-queued Run copies its Definition Revision from the catalog at
enqueue time. The executor only proves the catalog *metadata* digest, so a
stale worktree or a publish after enqueue can execute other source. When the
executor sends its prepared ``task_definition``, the Run is re-pinned to it.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.api import app
from apo.db import get_session
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    TaskDefinitionRevisionDB,
    TaskExecutionAttemptDB,
    UserDB,
)
from apo.services.task_definition_revisions import ensure_task_definition_revision

_ATTESTATION = {"source_type": "connected_worktree", "content_sha256": "sha256:" + "a" * 64}


def _document(source: str) -> dict[str, object]:
    return {"schema_version": 1, "files": [{"path": "t.eval.ts", "content": source}]}


@pytest.fixture
def engine(monkeypatch):
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, create_engine

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    import apo.db as db_module

    monkeypatch.setattr(db_module, "engine", engine)
    monkeypatch.setattr("apo.services.executor_auth.AUTH_SECRET", "test-secret")
    return engine


def _seed(engine, published_source: str = "task('published');") -> str:
    """A leased Attempt whose Run carries the published catalog pin; returns the JWT."""
    from apo.services.executor_auth import create_attempt_jwt

    now = datetime.now(timezone.utc)
    with Session(engine) as s:
        u = UserDB(email="o@t.com", name="O", password_hash="x", is_active=True)
        s.add(u); s.commit(); s.refresh(u)
        s.add(ProjectDB(id="p1", name="P", created_by=u.id)); s.commit()
        published = ensure_task_definition_revision(
            s, project_id="p1", task_id="t", document=_document(published_source)
        )
        s.add(AgentTaskBatchRunDB(
            id="bch-1", project="p1", selection_type="tasks", status="queued",
            execution_target_json={"kind": "source_owned"}, created_at=now,
        ))
        s.flush()
        s.add(AgentTaskRunDB(
            id="run-1", batch_run_id="bch-1", task_id="t", task_path="t",
            sequence_index=0, status="pending", task_definition_revision_id=published.id,
        ))
        s.flush()
        attempt = TaskExecutionAttemptDB(
            id="att-1", project="p1", batch_run_id="bch-1", task_run_id="run-1",
            sequence_index=0, target_kind="pool", assignment_kind="source_owned",
            executor_pool_id="pool-1", status="leased", phase="claimed",
            queue_expires_at=now + timedelta(hours=24), queued_at=now, claimed_at=now,
            heartbeat_at=now, lease_generation=1, lease_expires_at=now + timedelta(minutes=5),
        )
        s.add(attempt); s.commit()
        return create_attempt_jwt(attempt=attempt, lease_generation=1, expires_in_seconds=3600)


def _attest(engine, jwt: str, **extra: object):
    def _sess():
        with Session(engine) as sx:
            yield sx

    app.dependency_overrides[get_session] = _sess
    try:
        return TestClient(app).post(
            "/v1/executor-protocol/v2/attempts/att-1/source-attestation",
            headers={"Authorization": f"Bearer {jwt}"},
            json={**_ATTESTATION, **extra},
        )
    finally:
        app.dependency_overrides.clear()


def _pinned_source(engine) -> str:
    with Session(engine) as s:
        run = s.get(AgentTaskRunDB, "run-1")
        assert run is not None and run.task_definition_revision_id is not None
        revision = s.get(TaskDefinitionRevisionDB, run.task_definition_revision_id)
        assert revision is not None
        return revision.source_files_json[0]["content"]


def test_executed_source_replaces_the_catalog_pin(engine):
    jwt = _seed(engine)

    resp = _attest(engine, jwt, task_definition=_document("task('local edit');"))

    assert resp.status_code == 200, resp.text
    assert _pinned_source(engine) == "task('local edit');"


def test_an_old_executor_keeps_the_catalog_pin(engine):
    jwt = _seed(engine)

    resp = _attest(engine, jwt)

    assert resp.status_code == 200, resp.text
    assert _pinned_source(engine) == "task('published');"


def test_a_replayed_attestation_keeps_the_first_pin(engine):
    jwt = _seed(engine)
    assert _attest(engine, jwt, task_definition=_document("task('executed');")).status_code == 200

    resp = _attest(engine, jwt, task_definition=_document("task('other');"))

    assert resp.status_code == 200, resp.text
    assert _pinned_source(engine) == "task('executed');"


def test_an_invalid_definition_is_rejected_and_attaches_nothing(engine):
    jwt = _seed(engine)
    bad = _document("x")
    bad["files"] = []

    resp = _attest(engine, jwt, task_definition=bad)

    assert resp.status_code == 422
    with Session(engine) as s:
        attempt = s.get(TaskExecutionAttemptDB, "att-1")
        assert attempt is not None and attempt.task_revision_id is None
    assert _pinned_source(engine) == "task('published');"
