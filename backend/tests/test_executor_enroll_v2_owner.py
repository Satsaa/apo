# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

"""v2 enrollment binds the Executor to the member who issued the redeemed token.

Every member's Connected Executor enrolls into the one shared source-owned
Pool, and claims match ``target_user_id`` against ``enrolled_by_user_id``. If
enrollment read the owner from any used token in the Pool, a second member's
Executor would be bound to the first member: it would claim their dashboard
runs against the wrong checkout, and the second member's runs would never be
claimed.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.api import app
from apo.db import get_session
from apo.models.db import ExecutorDB, ProjectDB, ProjectMembershipDB, UserDB
from apo.services.source_owned_executor import bootstrap_connected_executor


@pytest.fixture
def engine(monkeypatch):
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, create_engine

    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    import apo.db as db_module

    monkeypatch.setattr(db_module, "engine", eng)

    def _sess():
        with Session(eng) as s:
            yield s

    app.dependency_overrides[get_session] = _sess
    yield eng
    app.dependency_overrides.pop(get_session, None)


def _member(s: Session, email: str) -> str:
    user = UserDB(email=email, name=email, password_hash="x", is_active=True)
    s.add(user)
    s.commit()
    s.refresh(user)
    if s.get(ProjectDB, "p1") is None:
        s.add(ProjectDB(id="p1", name="P", created_by=user.id))
        s.commit()
    now = datetime.now(timezone.utc)
    s.add(ProjectMembershipDB(
        project_id="p1", user_id=user.id, role="member", created_at=now, updated_at=now,
    ))
    s.commit()
    return user.id


def _enroll(client: TestClient, token: str, name: str) -> str:
    res = client.post(
        "/v1/executor-protocol/v2/enroll",
        json={
            "token": token,
            "name": name,
            "capabilities": {
                "protocol_version": 2,
                "executor_version": "0.0.0-test",
                "driver_kinds": ["source-owned-ts"],
                "os": "linux",
                "architecture": "x64",
                "runtimes": {"node": "22"},
                "max_concurrency": 1,
            },
        },
    )
    assert res.status_code == 200, res.text
    return res.json()["executor_id"]


def test_each_member_executor_is_bound_to_that_member(engine):
    with Session(engine) as s:
        alice = _member(s, "alice@t.com")
        bob = _member(s, "bob@t.com")
        alice_token = bootstrap_connected_executor(
            s, project_id="p1", user_id=alice, name="alice-laptop"
        ).enrollment_token
        bob_token = bootstrap_connected_executor(
            s, project_id="p1", user_id=bob, name="bob-laptop"
        ).enrollment_token

    client = TestClient(app)
    alice_executor = _enroll(client, alice_token, "alice-laptop")
    bob_executor = _enroll(client, bob_token, "bob-laptop")

    with Session(engine) as s:
        assert s.get(ExecutorDB, alice_executor).enrolled_by_user_id == alice
        assert s.get(ExecutorDB, bob_executor).enrolled_by_user_id == bob

