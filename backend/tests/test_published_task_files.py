"""The task Files tab on a project whose tasks come from a published catalog.

``apo task publish`` uploads each task's metadata and its ``*.eval.ts``; the
fixture files stay in the publisher's checkout. The files routes must serve
the uploaded eval source rather than failing on the missing checkout.
"""

from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models.db import ProjectDB, ProjectMembershipDB, UserDB

_USER = "user-published-files"
_PROJECT = "proj-published-files"
_SOURCE = "import { task } from '@apo-ai/sdk/agent-task';\ntask('alpha', {});\n"


def _seed(session: Session) -> None:
    now = datetime.now(timezone.utc)
    session.add(UserDB(id=_USER, email=f"{_USER}@test", name=_USER, password_hash="x"))
    session.commit()
    session.add(ProjectDB(id=_PROJECT, name=_PROJECT, created_by=_USER, created_at=now))
    session.commit()
    session.add(
        ProjectMembershipDB(
            project_id=_PROJECT, user_id=_USER, role="owner", created_at=now, updated_at=now
        )
    )
    session.commit()


def _publish(client: TestClient, source: str | None) -> None:
    task: dict[str, Any] = {
        "task_id": "chat/alpha",
        "display_name": "alpha",
        "task_path": "chat/alpha",
        "folder_path": "chat",
        "adapter_name": "chatAdapter",
        "has_checks": True,
        "tags": [],
    }
    if source is not None:
        task["definition"] = {
            "schema_version": 1,
            "files": [{"path": "alpha.eval.ts", "content": source}],
        }
    resp = client.put(
        f"/v1/projects/{_PROJECT}/task-catalog",
        json={"schema_version": 2, "tasks": [task]},
    )
    assert resp.status_code == 200, resp.text


def _files_url(file_path: str | None = None) -> str:
    base = f"/v1/projects/{_PROJECT}/agent-tasks/chat/alpha/files"
    return base if file_path is None else f"{base}/{file_path}"


def test_list_serves_the_published_eval_source(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)
    _publish(client, _SOURCE)

    resp = client.get(_files_url())

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source_type"] == "published"
    assert body["task_path"] == "chat/alpha"
    assert [(f["path"], f["type"], f["size_bytes"]) for f in body["files"]] == [
        ("alpha.eval.ts", "file", len(_SOURCE.encode("utf-8")))
    ]


def test_read_returns_the_published_eval_source(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)
    _publish(client, _SOURCE)

    resp = client.get(_files_url("alpha.eval.ts"))

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["content"] == _SOURCE
    assert body["language"] == "typescript"
    assert body["lines"] == 2


def test_read_of_an_unpublished_file_is_404(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)
    _publish(client, _SOURCE)

    resp = client.get(_files_url("files/brief.md"))

    assert resp.status_code == 404


def test_catalog_without_definitions_lists_nothing(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)
    _publish(client, None)

    resp = client.get(_files_url())

    assert resp.status_code == 200, resp.text
    assert resp.json()["files"] == []
    assert resp.json()["source_type"] == "published"


def test_non_member_cannot_list_or_read(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    _publish(make_authed_client(_USER, session), _SOURCE)
    session.add(UserDB(id="outsider", email="outsider@test", name="outsider", password_hash="x"))
    session.commit()
    outsider = make_authed_client("outsider", session, is_admin=False)

    assert outsider.get(_files_url()).status_code in (403, 404)
    assert outsider.get(_files_url("alpha.eval.ts")).status_code in (403, 404)


def test_member_who_is_not_admin_reads_the_source(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session, is_admin=False)
    _publish(make_authed_client(_USER, session), _SOURCE)

    resp = client.get(_files_url("alpha.eval.ts"))

    assert resp.status_code == 200, resp.text
    assert resp.json()["content"] == _SOURCE
