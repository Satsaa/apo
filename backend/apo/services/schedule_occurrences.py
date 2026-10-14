"""Idempotent source-owned Schedule Occurrence delivery.

Owns the durable transition from a due Schedule to either one pending 24-hour
queued source-owned Batch (a ``pending`` Occurrence) or a recorded miss. The
unique ``(schedule_id, kind, scheduled_for)`` Occurrence identity makes
dispatch idempotent across duplicate polls and restarts.

At most one non-terminal Batch may exist per Schedule: a later due time while
one is active is recorded as ``missed/previous_occurrence_active`` and creates
no Batch, so offline time can never accumulate an execution backlog.

The caller (scheduler / Run Now route) owns the commit so Occurrence, Batch,
Attempts, active pointer, and cadence advancement land in one transaction.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import cast

from sqlmodel import Session, select

from apo.db_helpers import as_column
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskScheduleDB,
    AgentTaskScheduleOccurrenceDB,
    ProjectMembershipDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
)
from apo.models.execution import ConnectedEnvironmentState
from apo.services.execution_queue import (
    SourceOwnedSelectionError,
    create_source_owned_batch_run,
)
from apo.services.lifecycle import BATCH_RUN_TERMINAL

#: Fixed 24-hour queue deadline for every scheduled Occurrence.
SCHEDULE_QUEUE_DEADLINE_SECONDS = 24 * 60 * 60

#: Reasons a due Occurrence was recorded as missed without execution.
MISSED_PREVIOUS_ACTIVE = "previous_occurrence_active"
MISSED_EXECUTOR_UNAVAILABLE = "executor_unavailable"
MISSED_CATALOG_CHANGED = "catalog_changed"
MISSED_SELECTION_EMPTY = "selection_empty"


@dataclass(frozen=True)
class OccurrenceDeliveryResult:
    """Outcome of attempting to deliver one due Occurrence."""

    occurrence_id: str
    batch_run_id: str | None
    created: bool
    missed_reason: str | None


def deliver_due_occurrence(
    session: Session,
    *,
    schedule: AgentTaskScheduleDB,
    now: datetime,
    kind: str = "scheduled",
    requested_by_user_id: str | None = None,
) -> OccurrenceDeliveryResult:
    """Deliver one due Occurrence for a source-owned Schedule.

    Idempotent: a retry for the same ``scheduled_for`` re-reads the existing
    Occurrence and returns ``created=False``. Creates at most one Batch per
    Schedule; later due times while one is active are missed. Resolves the
    current Task Catalog selection each time and pauses the Schedule on an
    invalid/empty selection. Does NOT commit — the caller owns the transaction.

    ``requested_by_user_id`` is the admin who pressed Run Now; a cron
    Occurrence has none. The Execution Owner is the target either way.
    """
    scheduled_for = schedule.next_run_at or now

    existing = _find_occurrence(
        session, schedule_id=schedule.id, kind=kind, scheduled_for=scheduled_for
    )
    if existing is not None:
        return OccurrenceDeliveryResult(
            occurrence_id=existing.id,
            batch_run_id=existing.batch_run_id,
            created=False,
            missed_reason=existing.missed_reason if existing.status == "missed" else None,
        )

    # One non-terminal Batch per Schedule: later due times are missed, not backlogged.
    if _has_active_batch(session, schedule):
        return _record_missed(
            session,
            schedule=schedule,
            kind=kind,
            scheduled_for=scheduled_for,
            reason=MISSED_PREVIOUS_ACTIVE,
            now=now,
        )

    resolved = _resolve_selection(session, schedule)
    if isinstance(resolved, _SelectionPause):
        _pause_schedule(session, schedule, reason=resolved.reason)
        return _record_missed(
            session,
            schedule=schedule,
            kind=kind,
            scheduled_for=scheduled_for,
            reason=resolved.reason,
            now=now,
        )

    task_ids, selection_snapshot = resolved.task_ids, resolved.snapshot
    queue_deadline = scheduled_for + timedelta(seconds=SCHEDULE_QUEUE_DEADLINE_SECONDS)
    batch = create_source_owned_batch_run(
        session,
        project_id=schedule.project,
        user_id=_require_owner(schedule),
        requested_by_user_id=requested_by_user_id,
        task_ids=task_ids,
        environment=schedule.environment,
        run_metadata=_schedule_run_metadata(schedule, now=now),
        queue_deadline=queue_deadline,
        selection_snapshot=selection_snapshot,
        commit=False,
    )

    occurrence = _create_occurrence(
        session,
        schedule=schedule,
        kind=kind,
        scheduled_for=scheduled_for,
        status="pending",
        batch_run_id=batch.id,
        now=now,
    )
    schedule.active_batch_run_id = batch.id
    schedule.last_triggered_at = now
    schedule.last_batch_run_id = batch.id
    session.add(schedule)
    return OccurrenceDeliveryResult(
        occurrence_id=occurrence.id,
        batch_run_id=batch.id,
        created=True,
        missed_reason=None,
    )


def resolve_occurrence_on_terminal_batch(
    session: Session,
    *,
    batch: AgentTaskBatchRunDB,
    now: datetime,
) -> None:
    """Clear the active pointer and resolve a pending Occurrence on terminal state.

    A Batch that exhausted its 24-hour queue with no Attempt started marks its
    Occurrence ``missed/executor_unavailable``. Any Attempt that started means
    the Occurrence was delivered; the Batch owns that outcome. Does NOT commit.
    """
    schedule = _schedule_for_active_batch(session, batch)
    if schedule is not None and schedule.active_batch_run_id == batch.id:
        schedule.active_batch_run_id = None
        session.add(schedule)

    occurrence = _occurrence_for_batch(session, batch.id)
    if occurrence is None or occurrence.status != "pending":
        return

    started = _batch_has_started_attempt(session, batch.id)
    if started:
        occurrence.status = "delivered"
    elif _batch_failed_unavailable(session, batch.id):
        occurrence.status = "missed"
        occurrence.missed_reason = MISSED_EXECUTOR_UNAVAILABLE
    else:
        occurrence.status = "delivered"
    occurrence.resolved_at = now
    session.add(occurrence)
    session.flush()


def resolve_occurrence_if_terminal(
    session: Session, batch: AgentTaskBatchRunDB
) -> None:
    """Clear the Schedule active pointer and resolve the linked pending
    Occurrence once the Batch reaches a terminal state. No-op if non-terminal."""
    if batch.status not in BATCH_RUN_TERMINAL:
        return
    resolve_occurrence_on_terminal_batch(
        session, batch=batch, now=datetime.now(timezone.utc)
    )


def mark_occurrence_cancelled_for_batch(
    session: Session,
    *,
    batch_run_id: str,
    now: datetime,
) -> None:
    """Mark a pending Occurrence cancelled (used by pause/delete in execution_leases)."""
    occurrence = _occurrence_for_batch(session, batch_run_id)
    if occurrence is not None and occurrence.status == "pending":
        occurrence.status = "cancelled"
        occurrence.resolved_at = now
        session.add(occurrence)
        session.flush()


def mark_occurrence_delivered_on_start(
    session: Session,
    *,
    batch_run_id: str,
    now: datetime,
) -> None:
    """Mark a pending Occurrence delivered the moment its first Attempt starts."""
    occurrence = _occurrence_for_batch(session, batch_run_id)
    if occurrence is None or occurrence.status != "pending":
        return
    occurrence.status = "delivered"
    occurrence.resolved_at = now
    session.add(occurrence)
    session.flush()


def schedule_connected_environment_state(
    session: Session,
    *,
    schedule: AgentTaskScheduleDB,
) -> ConnectedEnvironmentState | None:
    """Aggregate state of the Schedule Execution Owner's Connected Executors."""
    if not schedule.execution_owner_user_id:
        return None
    from apo.services.connected_executor_status import compute_connected_environment_state

    return compute_connected_environment_state(
        session,
        project_id=schedule.project,
        user_id=schedule.execution_owner_user_id,
    )


# ---------------------------------------------------------------------------
# Implementation helpers (below public logic)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _ResolvedSelection:
    task_ids: list[str]
    snapshot: dict[str, object]


@dataclass(frozen=True)
class _SelectionPause:
    reason: str


def _resolve_selection(
    session: Session,
    schedule: AgentTaskScheduleDB,
) -> _ResolvedSelection | _SelectionPause:
    selection = schedule.selection_query or {}
    kind = selection.get("kind")

    if kind == "tasks":
        raw_ids = selection.get("task_ids")
        task_ids = (
            _unique_strings(cast(list[object], raw_ids)) if isinstance(raw_ids, list) else []
        )
        if not task_ids:
            return _SelectionPause(MISSED_SELECTION_EMPTY)
        catalog_ids = _catalog_task_ids(session, schedule.project)
        if any(tid not in catalog_ids for tid in task_ids):
            return _SelectionPause(MISSED_CATALOG_CHANGED)
        return _ResolvedSelection(
            task_ids=task_ids,
            snapshot={"kind": "tasks", "task_ids": task_ids},
        )

    if kind == "folder":
        folder_id = str(selection.get("folder_id") or "")
        if not folder_id:
            return _SelectionPause(MISSED_SELECTION_EMPTY)
        rows = _inventory_for_folder(session, schedule.project, folder_id)
        if not rows:
            return _SelectionPause(MISSED_SELECTION_EMPTY)
        task_ids = [r.task_id for r in rows]
        return _ResolvedSelection(
            task_ids=task_ids,
            snapshot={"kind": "folder", "folder_id": folder_id, "task_ids": task_ids},
        )

    if kind == "all":
        rows = _catalog_inventory(session, schedule.project)
        if not rows:
            return _SelectionPause(MISSED_SELECTION_EMPTY)
        task_ids = [r.task_id for r in rows]
        return _ResolvedSelection(
            task_ids=task_ids,
            snapshot={"kind": "all", "task_ids": task_ids},
        )

    # Legacy/unknown selection shape — treat as empty rather than guess.
    return _SelectionPause(MISSED_SELECTION_EMPTY)


def _catalog_task_ids(session: Session, project_id: str) -> set[str]:
    return {row.task_id for row in _catalog_inventory(session, project_id)}


def _catalog_inventory(session: Session, project_id: str) -> list[ProjectTaskInventoryDB]:
    source = _published_source(session, project_id)
    if source is None:
        return []
    return list(
        session.exec(
            select(ProjectTaskInventoryDB).where(
                ProjectTaskInventoryDB.project == project_id,
                ProjectTaskInventoryDB.task_source_id == source.id,
            )
        ).all()
    )


def _inventory_for_folder(
    session: Session, project_id: str, folder_id: str
) -> list[ProjectTaskInventoryDB]:
    return [
        row
        for row in _catalog_inventory(session, project_id)
        if (row.folder_path or "") == folder_id
    ]


def _published_source(session: Session, project_id: str) -> ProjectTaskSourceDB | None:
    source = session.exec(
        select(ProjectTaskSourceDB).where(ProjectTaskSourceDB.project == project_id)
    ).first()
    if source is None or source.source_type != "published" or not source.catalog_digest:
        return None
    return source


def _unique_strings(raw: list[object]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in raw:
        if isinstance(item, str) and item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def _require_owner(schedule: AgentTaskScheduleDB) -> str:
    if not schedule.execution_owner_user_id:
        raise SourceOwnedSelectionError(
            "execution_owner_unavailable",
            "source-owned schedule has no execution owner",
        )
    return schedule.execution_owner_user_id


def _has_active_batch(session: Session, schedule: AgentTaskScheduleDB) -> bool:
    if schedule.active_batch_run_id is None:
        return False
    batch = session.get(AgentTaskBatchRunDB, schedule.active_batch_run_id)
    return batch is not None and batch.status not in (
        "completed", "error", "cancelled",
    )


def _find_occurrence(
    session: Session,
    *,
    schedule_id: str,
    kind: str,
    scheduled_for: datetime,
) -> AgentTaskScheduleOccurrenceDB | None:
    return session.exec(
        select(AgentTaskScheduleOccurrenceDB).where(
            AgentTaskScheduleOccurrenceDB.schedule_id == schedule_id,
            AgentTaskScheduleOccurrenceDB.kind == kind,
            as_column(AgentTaskScheduleOccurrenceDB.scheduled_for) == scheduled_for,
        )
    ).first()


def _record_missed(
    session: Session,
    *,
    schedule: AgentTaskScheduleDB,
    kind: str,
    scheduled_for: datetime,
    reason: str,
    now: datetime,
) -> OccurrenceDeliveryResult:
    occurrence = _create_occurrence(
        session,
        schedule=schedule,
        kind=kind,
        scheduled_for=scheduled_for,
        status="missed",
        batch_run_id=None,
        now=now,
    )
    occurrence.missed_reason = reason
    session.add(occurrence)
    return OccurrenceDeliveryResult(
        occurrence_id=occurrence.id,
        batch_run_id=None,
        created=False,
        missed_reason=reason,
    )


def _create_occurrence(
    session: Session,
    *,
    schedule: AgentTaskScheduleDB,
    kind: str,
    scheduled_for: datetime,
    status: str,
    batch_run_id: str | None,
    now: datetime,
) -> AgentTaskScheduleOccurrenceDB:
    occurrence = AgentTaskScheduleOccurrenceDB(
        id="occ_" + secrets.token_hex(12),
        project=schedule.project,
        schedule_id=schedule.id,
        schedule_name=schedule.name,
        kind=kind,
        scheduled_for=scheduled_for,
        status=status,
        batch_run_id=batch_run_id,
        created_at=now,
    )
    session.add(occurrence)
    session.flush()
    return occurrence


def _pause_schedule(
    session: Session, schedule: AgentTaskScheduleDB, *, reason: str
) -> None:
    schedule.enabled = False
    schedule.disabled_reason = reason
    session.add(schedule)


def _schedule_for_active_batch(
    session: Session, batch: AgentTaskBatchRunDB
) -> AgentTaskScheduleDB | None:
    return session.exec(
        select(AgentTaskScheduleDB).where(
            AgentTaskScheduleDB.active_batch_run_id == batch.id
        )
    ).first()


def _occurrence_for_batch(
    session: Session, batch_run_id: str
) -> AgentTaskScheduleOccurrenceDB | None:
    return session.exec(
        select(AgentTaskScheduleOccurrenceDB).where(
            AgentTaskScheduleOccurrenceDB.batch_run_id == batch_run_id
        )
    ).first()


def _batch_has_started_attempt(session: Session, batch_run_id: str) -> bool:
    from apo.models.db import TaskExecutionAttemptDB

    row = session.exec(
        select(TaskExecutionAttemptDB.id).where(
            TaskExecutionAttemptDB.batch_run_id == batch_run_id,
            as_column(TaskExecutionAttemptDB.started_at).is_not(None),
        ).limit(1)
    ).first()
    return row is not None


def _batch_failed_unavailable(session: Session, batch_run_id: str) -> bool:
    from apo.models.db import TaskExecutionAttemptDB

    row = session.exec(
        select(TaskExecutionAttemptDB.id).where(
            TaskExecutionAttemptDB.batch_run_id == batch_run_id,
            TaskExecutionAttemptDB.failure_kind == "executor_unavailable",
        ).limit(1)
    ).first()
    return row is not None


def _schedule_run_metadata(
    schedule: AgentTaskScheduleDB,
    *,
    now: datetime,
) -> dict[str, object]:
    from typing import cast

    metadata = dict(schedule.run_metadata) if schedule.run_metadata else {}
    trigger = metadata.get("trigger")
    trigger_dict = (
        dict(cast(dict[str, object], trigger)) if isinstance(trigger, dict) else {}
    )
    trigger_dict["source"] = "schedule"
    if "entrypoint" not in trigger_dict:
        trigger_dict["entrypoint"] = "/agent-task-schedules"
    trigger_dict["initiated_at"] = now.isoformat()
    metadata["trigger"] = trigger_dict
    metadata["schedule"] = {"id": schedule.id, "name": schedule.name}
    return metadata


def owner_is_project_member(
    session: Session, *, schedule: AgentTaskScheduleDB
) -> bool:
    """Whether the fixed Execution Owner is still a Project member."""
    if not schedule.execution_owner_user_id:
        return False
    membership = session.exec(
        select(ProjectMembershipDB).where(
            ProjectMembershipDB.project_id == schedule.project,
            ProjectMembershipDB.user_id == schedule.execution_owner_user_id,
        )
    ).first()
    return membership is not None


__all__ = [
    "MISSED_CATALOG_CHANGED",
    "MISSED_EXECUTOR_UNAVAILABLE",
    "MISSED_PREVIOUS_ACTIVE",
    "MISSED_SELECTION_EMPTY",
    "OccurrenceDeliveryResult",
    "SCHEDULE_QUEUE_DEADLINE_SECONDS",
    "deliver_due_occurrence",
    "mark_occurrence_cancelled_for_batch",
    "mark_occurrence_delivered_on_start",
    "owner_is_project_member",
    "resolve_occurrence_on_terminal_batch",
    "schedule_connected_environment_state",
]
