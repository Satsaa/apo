"""A published catalog pins each task's eval source.

``apo task publish`` sends every task's ``definition`` (the canonical
``*.eval.ts``). Publication must store it as a Definition Revision and pin it
on the inventory row, because dashboard-started Runs copy their revision from
inventory (``execution_queue``) and rejudge and Notes read it from the Run.

The catalog digest must not change with the definition: ``apo connect``
computes its digest from task metadata alone (``computeCatalogDigest``), and
claims gate on the two being equal.
"""

from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import (
    ProjectDB,
    ProjectMembershipDB,
    ProjectTaskInventoryDB,
    TaskDefinitionRevisionDB,
    UserDB,
)
from apo.services.task_catalog import compute_catalog_digest

_USER = "user-catalog-def"
_PROJECT = "proj-catalog-def"


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


def _task(source: str | None) -> dict[str, Any]:
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
    return task


def _metadata_digest() -> str:
    task = _task(None)
    return compute_catalog_digest([task])


def _pinned(session: Session) -> TaskDefinitionRevisionDB | None:
    session.expire_all()
    row = session.exec(
        select(ProjectTaskInventoryDB).where(ProjectTaskInventoryDB.project == _PROJECT)
    ).one()
    if row.task_definition_revision_id is None:
        return None
    return session.get(TaskDefinitionRevisionDB, row.task_definition_revision_id)


def _inventory_row_id(session: Session) -> int | str | None:
    session.expire_all()
    return session.exec(
        select(ProjectTaskInventoryDB).where(ProjectTaskInventoryDB.project == _PROJECT)
    ).one().id


def _publish(client: TestClient, source: str | None) -> Any:
    return client.put(
        f"/v1/projects/{_PROJECT}/task-catalog",
        json={"schema_version": 2, "tasks": [_task(source)]},
    )


def test_publish_pins_the_definition_revision(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)

    resp = _publish(client, "task('alpha', {});\n")

    assert resp.status_code == 200, resp.text
    revision = _pinned(session)
    assert revision is not None
    assert revision.source_files_json == [
        {"path": "alpha.eval.ts", "content": "task('alpha', {});\n"}
    ]


def test_digest_matches_the_connect_digest(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)

    with_source = _publish(client, "task('alpha', {});\n").json()["catalog_digest"]

    assert with_source == _metadata_digest()


def test_editing_only_the_source_repins_without_moving_the_digest(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)

    first = _publish(client, "task('alpha', {});\n").json()
    first_revision = _pinned(session)
    second = _publish(client, "task('alpha', { maxTurns: 2 });\n").json()
    second_revision = _pinned(session)

    assert first["catalog_digest"] == second["catalog_digest"]
    assert first_revision is not None and second_revision is not None
    assert first_revision.id != second_revision.id
    assert second_revision.source_files_json[0]["content"] == "task('alpha', { maxTurns: 2 });\n"


def test_republishing_the_same_source_keeps_inventory_and_refreshes_published_at(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)

    first = _publish(client, "task('alpha', {});\n").json()
    first_row = _inventory_row_id(session)
    second = _publish(client, "task('alpha', {});\n").json()

    assert _inventory_row_id(session) == first_row
    assert second["catalog_digest"] == first["catalog_digest"]
    assert second["published_at"] > first["published_at"]


def test_publication_without_definitions_still_works(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)

    resp = _publish(client, None)

    assert resp.status_code == 200, resp.text
    assert resp.json()["catalog_digest"] == _metadata_digest()
    assert _pinned(session) is None


def test_invalid_definition_is_rejected_with_422(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)
    task = _task("x")
    task["definition"]["files"][0]["path"] = "../escape.eval.ts"

    resp = client.put(f"/v1/projects/{_PROJECT}/task-catalog", json={"tasks": [task]})

    assert resp.status_code == 422
