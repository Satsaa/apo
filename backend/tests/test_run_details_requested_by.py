"""Bulk Task Run details carry the parent Batch's requester (one read each)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB, ProjectDB, UserDB
from apo.services.agent_task_run_details import load_task_run_details
from sqlmodel import Session

_PROJECT = "proj-requested-by"


def test_bulk_details_label_each_run_with_its_batch_requester(session: Session) -> None:
    now = datetime.now(timezone.utc)
    user = UserDB(email="runner@test.com", name="Runner", password_hash="x", is_active=True)
    session.add(user)
    session.add(ProjectDB(id=_PROJECT, name=_PROJECT, created_at=now))
    session.commit()
    session.refresh(user)
    session.add_all(
        [
            AgentTaskBatchRunDB(
                id="b-mine", project=_PROJECT, created_at=now, status="completed",
                selection_type="task", requested_by_user_id=user.id,
            ),
            AgentTaskBatchRunDB(
                id="b-old", project=_PROJECT, created_at=now, status="completed",
                selection_type="task",
            ),
        ]
    )
    session.flush()
    session.add_all(
        [
            AgentTaskRunDB(id="r-mine", batch_run_id="b-mine", task_id="t", task_path="t", status="passed"),
            AgentTaskRunDB(id="r-old", batch_run_id="b-old", task_id="t", task_path="t", status="passed"),
        ]
    )
    session.commit()

    details = load_task_run_details(session, ["r-mine", "r-old"], project_id=_PROJECT)

    by_id = {detail.id: detail for detail in details}
    assert by_id["r-mine"].requested_by_user_id == user.id
    assert by_id["r-mine"].requested_by_label == "runner@test.com"
    assert by_id["r-old"].requested_by_user_id is None
    assert by_id["r-old"].requested_by_label is None


def _seed_requested_batches(session: Session, count: int) -> None:
    now = datetime.now(timezone.utc)
    session.add(ProjectDB(id=_PROJECT, name=_PROJECT, created_at=now))
    for i in range(count):
        session.add(UserDB(id=f"u-{i}", email=f"u{i}@test", name="U", password_hash="x"))
    session.commit()
    for i in range(count):
        session.add(
            AgentTaskBatchRunDB(
                id=f"b-{i}", project=_PROJECT, created_at=now, status="completed",
                selection_type="task", requested_by_user_id=f"u-{i}",
            )
        )
        session.flush()
        session.add(AgentTaskRunDB(id=f"r-{i}", batch_run_id=f"b-{i}", task_id="t", task_path="t", status="passed"))
    session.commit()


def _listing_statements(session: Session) -> tuple[int, list[str | None]]:
    from apo.services.agent_task_batch_listing import (
        BatchRunListFilters,
        BatchRunListPagination,
        list_batch_run_summaries,
    )
    from sqlalchemy import event

    statements: list[str] = []

    def _record(_conn: object, _cursor: object, statement: str, *_args: object) -> None:
        statements.append(statement)

    bind = session.get_bind()
    event.listen(bind, "before_cursor_execute", _record)
    try:
        page = list_batch_run_summaries(
            session, BatchRunListFilters(project=_PROJECT), BatchRunListPagination(page=0, page_size=50)
        )
    finally:
        event.remove(bind, "before_cursor_execute", _record)
    return len(statements), sorted(row.requested_by_label or "" for row in page.data)


# The listing's fixed statement count, including its one users read.
_BASELINE_STATEMENTS = 7


@pytest.mark.parametrize("count", [1, 6])
def test_listing_resolves_requesters_in_one_read(session: Session, count: int) -> None:
    _seed_requested_batches(session, count)
    n_statements, labels = _listing_statements(session)
    assert labels == sorted(f"u{i}@test" for i in range(count))
    # Fixed per listing whatever the number of distinct requesters.
    assert n_statements == _BASELINE_STATEMENTS

