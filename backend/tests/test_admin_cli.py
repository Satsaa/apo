# pyright: reportAny=false, reportAttributeAccessIssue=false, reportCallIssue=false, reportPrivateUsage=false, reportUnknownParameterType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUntypedFunctionDecorator=false, reportUnusedParameter=false

"""``python -m apo.admin create-api-key``.

The command writes through ``apo.db.engine`` like the server, so these tests
seed the file-backed database the auth middleware also reads.
"""

import base64
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.admin import main
from apo.api import app
from apo.auth.api_key_auth import validate_basic_auth
from apo.db import engine as file_engine
from apo.db import reset_apo_file_db
from apo.models.db import ApiKeyDB, ProjectDB, ProjectMembershipDB, UserDB
from apo.services import executor_auth
from tests.test_caller_execution_protocol import _caller_body

PROJECT = "proj-admin"


@pytest.fixture()
def users() -> dict[str, str]:
    """A project with a first and a later owner, a member and an outsider."""
    reset_apo_file_db()
    now = datetime.now(timezone.utc)
    with Session(file_engine) as session:
        ids: dict[str, str] = {}
        for handle in ("founder", "coowner", "member", "outsider"):
            user = UserDB(email=f"{handle}@example.test", name=handle, password_hash="x", is_active=True)
            session.add(user)
            session.commit()
            session.refresh(user)
            ids[handle] = user.id
        session.add(ProjectDB(id=PROJECT, name=PROJECT, created_by=ids["founder"]))
        for handle, role, age in (("coowner", "owner", 1), ("founder", "owner", 2), ("member", "member", 0)):
            at = now - timedelta(days=age)
            session.add(
                ProjectMembershipDB(
                    project_id=PROJECT, user_id=ids[handle], role=role, created_at=at, updated_at=at
                )
            )
        session.commit()
    return ids


def _run(capsys: pytest.CaptureFixture[str], *args: str) -> tuple[int, str, str]:
    code = main(["create-api-key", *args])
    out, err = capsys.readouterr()
    return code, out, err


def _keys() -> list[ApiKeyDB]:
    with Session(file_engine) as session:
        return list(session.exec(select(ApiKeyDB)).all())


def test_prints_one_json_object_for_a_key_acting_as_the_first_owner(
    users: dict[str, str], capsys: pytest.CaptureFixture[str]
) -> None:
    code, out, _ = _run(capsys, "--project", PROJECT, "--name", "ci")
    assert code == 0
    printed = json.loads(out)
    assert set(printed) == {"public_key", "secret_key", "name", "project", "scope"}, (
        "stdout is exactly the documented JSON object"
    )
    assert printed["name"] == "ci" and printed["project"] == PROJECT
    assert printed["scope"] == "ingest", "the default scope matches the dashboard's"
    with Session(file_engine) as session:
        key = validate_basic_auth(printed["public_key"], printed["secret_key"], session)
        assert key is not None, "the printed pair authenticates like a dashboard-made key"
        assert key.created_by == users["founder"], "the key acts as the project's earliest owner"
        assert key.hashed_secret_key != printed["secret_key"], "only the secret's hash is stored"


def test_created_by_accepts_a_member_by_email_and_refuses_an_outsider(
    users: dict[str, str], capsys: pytest.CaptureFixture[str]
) -> None:
    code, out, _ = _run(
        capsys, "--project", PROJECT, "--name", "m", "--scope", "full", "--created-by", "member@example.test"
    )
    assert code == 0
    assert json.loads(out)["scope"] == "full"
    assert [k.created_by for k in _keys()] == [users["member"]]

    code, out, err = _run(capsys, "--project", PROJECT, "--name", "x", "--created-by", users["outsider"])
    assert code == 1 and out == "", "a key acting as a non-member would never authenticate"
    assert "cannot act in project" in err
    assert len(_keys()) == 1


@pytest.mark.parametrize("project", ["no-such-project", "demo"])
def test_refuses_an_unknown_or_demo_project(
    users: dict[str, str], capsys: pytest.CaptureFixture[str], project: str
) -> None:
    code, out, err = _run(capsys, "--project", project, "--name", "ci")
    assert code == 1 and out == "" and err.startswith("error: ")
    assert _keys() == [], "a refused project gets no key"


@pytest.mark.real_auth
def test_a_minted_key_runs_a_caller_batch_end_to_end(
    users: dict[str, str], capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The default scope is enough to create a caller batch and report its result."""
    monkeypatch.setattr(executor_auth, "AUTH_SECRET", "test-admin-secret")
    code, out, _ = _run(capsys, "--project", PROJECT, "--name", "caller")
    assert code == 0
    printed = json.loads(out)
    basic = base64.b64encode(f"{printed['public_key']}:{printed['secret_key']}".encode()).decode()

    client = TestClient(app)
    forged = base64.b64encode(f"{printed['public_key']}:sk-apo-wrong".encode()).decode()
    refused = client.post(
        "/v1/agent-task-batch-runs/caller",
        json=_caller_body(PROJECT),
        headers={"Authorization": f"Basic {forged}"},
    )
    assert refused.status_code == 401, "this test must run through real key authentication"

    created = client.post(
        "/v1/agent-task-batch-runs/caller",
        json=_caller_body(PROJECT),
        headers={"Authorization": f"Basic {basic}"},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    attempt = {"Authorization": f"Bearer {body['attempt_jwt']}"}
    base = f"/v1/executor-protocol/v1/attempts/{body['attempt_id']}"
    started = client.post(f"{base}/start", json={"driver_kind": "caller", "runtime": {}}, headers=attempt)
    assert started.status_code == 200, started.text
    result = client.post(
        f"{base}/result",
        json={"completion_id": "c-1", "pass_result": True, "adapter_name": "real-agent", "checks": []},
        headers=attempt,
    )
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "succeeded"
