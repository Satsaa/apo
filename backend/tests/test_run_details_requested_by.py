"""Bulk Task Run details carry the parent Batch's requester (one read each)."""

from __future__ import annotations

from datetime import datetime, timezone

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
