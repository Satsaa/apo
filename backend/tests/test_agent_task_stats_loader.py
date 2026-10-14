"""Regression guard for the task-list memory blowup (production OOM).

The task list used to load *every* ``AgentTaskRunDB`` row for every task to
compute pass-rate stats. Each row carries multi-MB ``transcript_json`` /
``deliverables_json`` JSON columns that the stats math never reads — so one
page load pulled hundreds of MB into memory and got the backend OOM-killed
(restart + browser "fetch error").

These tests pin the fix: the stats loader must SELECT only the scalar
columns + ``checks_json`` that aggregation needs, and must never fetch the
heavy transcript/deliverables blobs. The SQL is captured via SQLAlchemy's
``before_cursor_execute`` event and asserted on column name — the cheapest,
most direct way to lock "this column is not on the wire".
"""

from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event
from sqlmodel import Session

from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB
from apo.services.agent_task_stats import RunStatFields, compute_run_stats, load_run_stat_fields

# Reuse the in-memory test engine from conftest so the cursor-event listener
# actually sees the loader's queries.
from tests.conftest import engine

_NOW = datetime(2026, 7, 23, 12, 0, 0, tzinfo=timezone.utc)
_OLDER = _NOW - timedelta(hours=1)


def _batch(batch_id: str, project: str) -> AgentTaskBatchRunDB:
    return AgentTaskBatchRunDB(
        id=batch_id,
        project=project,
        selection_type="task",
        selection_query=None,
        task_root="/tmp/tasks",
        environment="default",
        status="completed",
        total_tasks=1,
        created_at=_NOW,
    )


def _run(
    run_id: str,
    batch_id: str,
    task_id: str,
    *,
    status: str = "passed",
    pass_result: bool | None = True,
    total_cost: float | None = 0.001,
    checks: list[dict[str, object]] | None = None,
    started_at: datetime | None = _NOW,
) -> AgentTaskRunDB:
    # The heavy columns are set deliberately. The whole point of these tests
    # The heavy columns are set deliberately. The whole point of these tests
    # is to prove the stats loader ignores them — so they must be present in
    # the seeded rows (otherwise "not loaded" would be vacuously true).
    check_list = checks or []
    return AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch_id,
        task_id=task_id,
        task_path=f"/tmp/tasks/{task_id}",
        status=status,
        pass_result=pass_result,
        started_at=started_at,
        completed_at=started_at,
        total_cost=total_cost,
        total_checks=len(check_list),
        passed_checks=sum(1 for c in check_list if c.get("pass") is True),
        transcript_json={"messages": ["x" * 100_000]},  # large, must stay on disk
    )


@pytest.fixture
def captured_sql() -> Iterator[list[str]]:
    """Record every SQL statement run on the test engine during the test.

    Untyped SQLAlchemy event-listener params mirror ``conftest.py``'s
    ``_enable_foreign_keys`` listener — the callback signature is fixed by
    SQLAlchemy's ``before_cursor_execute`` event and isn't worth the ``Any``
    noise of spelling it out.
    """
    statements: list[str] = []

    def _capture(
        _conn: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: object,
    ) -> None:
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", _capture)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", _capture)


def test_stats_loader_does_not_fetch_transcript_or_deliverables(
    session: Session,
    captured_sql: list[str],
) -> None:
    session.add_all([_batch("batch-1", "project-1")])
    session.add_all(
        [
            _run("run-a1", "batch-1", "task-a", checks=[{"pass": True}]),
            _run("run-a2", "batch-1", "task-a", status="failed", pass_result=False),
            _run("run-b1", "batch-1", "task-b", status="failed", pass_result=False),
        ]
    )
    session.commit()

    loaded = load_run_stat_fields(session, "project-1", ["task-a", "task-b"])
    assert loaded  # sanity: the loader returned grouped data

    # Only inspect SELECTs against agent_task_runs — the seeded INSERTs
    # legitimately write transcript_json (that's the test data), and the
    # invariant is about *reading* it for stats, not storing it.
    task_run_selects = [
        s for s in captured_sql
        if s.lower().startswith("select") and "agent_task_runs" in s
    ]
    assert task_run_selects, "expected the loader to query agent_task_runs"

    for sql in task_run_selects:
        lowered = sql.lower()
        assert "transcript_json" not in lowered, (
            "stats loader must not SELECT transcript_json — it can be MBs per "
            f"row and caused production OOM. Offending SQL:\n{sql}"
        )
        assert "deliverables_json" not in lowered, (
            "stats loader must not SELECT deliverables_json for the same reason. "
            f"Offending SQL:\n{sql}"
        )


def test_stats_loader_returns_correct_grouped_fields(session: Session) -> None:
    session.add_all([_batch("batch-1", "project-1"), _batch("batch-2", "project-2")])
    session.add_all(
        [
            _run(
                "run-a1",
                "batch-1",
                "task-a",
                status="passed",
                pass_result=True,
                total_cost=0.002,
                checks=[{"pass": True}, {"pass": False}],
                started_at=_NOW,
            ),
            _run(
                "run-a2",
                "batch-1",
                "task-a",
                status="failed",
                pass_result=False,
                total_cost=0.004,
                started_at=_OLDER,
            ),
            # Different project's batch — must be excluded by the project filter.
            _run("run-c1", "batch-2", "task-a", status="passed", pass_result=True),
        ]
    )
    session.commit()

    grouped = load_run_stat_fields(session, "project-1", ["task-a"])

    assert set(grouped.keys()) == {"task-a"}
    runs = grouped["task-a"]
    assert len(runs) == 2
    assert all(isinstance(r, RunStatFields) for r in runs)

    # Descending started_at: run-a1 (newer) first, run-a2 (older) second.
    assert runs[0].started_at == _NOW
    assert runs[0].status == "passed"
    assert runs[0].pass_result is True
    assert runs[0].total_cost == 0.002
    assert runs[0].total_checks == 2
    assert runs[0].passed_checks == 1
    assert runs[1].started_at == _OLDER
    assert runs[1].status == "failed"


def test_stats_loader_excludes_other_projects(session: Session) -> None:
    session.add_all([_batch("b-p1", "project-1"), _batch("b-p2", "project-2")])
    session.add_all(
        [
            _run("r1", "b-p1", "shared-task", status="passed", pass_result=True),
            _run("r2", "b-p2", "shared-task", status="failed", pass_result=False),
        ]
    )
    session.commit()

    grouped = load_run_stat_fields(session, "project-1", ["shared-task"])
    assert len(grouped["shared-task"]) == 1


def test_stats_loader_empty_task_ids_returns_empty(session: Session) -> None:
    assert load_run_stat_fields(session, "project-1", []) == {}


def test_stats_loader_carries_errored_checks(session: Session) -> None:
    """Issue #323: judge-errored checks reach the stats rollup, not a silent 0."""
    session.add_all([_batch("batch-1", "project-1")])
    run = _run(
        "run-nv",
        "batch-1",
        "task-a",
        status="error",
        pass_result=None,
        checks=[{"pass": True}, {"pass": False}],
    )
    run.errored_checks = 1
    run.no_verdict_reason = "judge"
    crash = _run(
        "run-crash",
        "batch-1",
        "task-b",
        status="error",
        pass_result=None,
        checks=[{"pass": True}, {"pass": False}],
    )
    crash.errored_checks = 1
    crash.error_message = "adapter crashed"
    crash.no_verdict_reason = "executor"
    session.add_all([run, crash])
    session.commit()

    grouped = load_run_stat_fields(session, "project-1", ["task-a", "task-b"])

    assert grouped["task-a"][0].errored_checks == 1
    # The Tasks page tells a judge no-verdict apart from an execution error.
    assert grouped["task-a"][0].judge_no_verdict is True
    assert grouped["task-b"][0].judge_no_verdict is False
    assert compute_run_stats(grouped["task-a"]).last_run_no_verdict is True
    assert compute_run_stats(grouped["task-b"]).last_run_no_verdict is False
    assert compute_run_stats(grouped["task-a"]).last_run_no_verdict_reason == "judge"
    assert compute_run_stats(grouped["task-b"]).last_run_no_verdict_reason == "executor"


def test_stats_loader_orders_unstarted_runs_after_started_ones(
    session: Session, captured_sql: list[str]
) -> None:
    # Postgres sorts NULLs first under DESC and SQLite last; the cohort pins
    # NULLs last so the "latest run" is the same on both databases. SQLite
    # already agrees, so the SQL is checked too.
    session.add_all([_batch("b-old", "project-1"), _batch("b-new", "project-1")])
    session.add_all(
        [
            _run("r-started", "b-old", "task-a", started_at=_OLDER),
            _run(
                "r-expired",
                "b-new",
                "task-a",
                status="error",
                pass_result=None,
                started_at=None,
            ),
        ]
    )
    session.commit()

    runs = load_run_stat_fields(session, "project-1", ["task-a"])["task-a"]
    assert any("NULLS LAST" in sql for sql in captured_sql)
    assert [r.started_at is None for r in runs] == [False, True]
    stats = compute_run_stats(runs)
    assert stats.total_runs == 1
    assert stats.not_started_runs == 1
    assert stats.last_run_status == "passed"


def test_stats_loader_puts_a_queued_run_first_so_the_card_reads_running(
    session: Session,
) -> None:
    # A task waiting in a sequential batch: its queued run (no started_at yet)
    # is its latest run on every database, ahead of the last finished one.
    live_batch = _batch("b-new", "project-1")
    live_batch.created_at = datetime.now(timezone.utc)
    session.add_all([_batch("b-old", "project-1"), live_batch])
    session.add_all(
        [
            _run("r-done", "b-old", "task-a", started_at=_OLDER),
            _run("r-queued", "b-new", "task-a", status="pending", pass_result=None, started_at=None),
        ]
    )
    session.commit()

    runs = load_run_stat_fields(session, "project-1", ["task-a"])["task-a"]
    stats = compute_run_stats(runs)
    assert stats.last_run_status == "pending"
    assert stats.not_started_runs == 0
    # No verdict yet, so the queued run is outside the totals.
    assert stats.total_runs == 1
    assert stats.pass_rate == 1.0


def test_stats_loader_ignores_a_pending_row_stuck_in_an_ancient_batch(
    session: Session,
) -> None:
    # A pending row nobody reaped (no attempt, batch long gone) is not live:
    # it neither reads as Running nor sits in a since window.
    session.add_all([_batch("b-ancient", "project-1"), _batch("b-done", "project-1")])
    session.add_all(
        [
            _run("r-stuck", "b-ancient", "task-a", status="pending", pass_result=None, started_at=None),
            _run("r-done", "b-done", "task-a", started_at=_OLDER),
        ]
    )
    session.commit()

    stats = compute_run_stats(load_run_stat_fields(session, "project-1", ["task-a"])["task-a"])
    assert stats.last_run_status == "passed"
    assert stats.total_runs == 1
    windowed = load_run_stat_fields(session, "project-1", ["task-a"], since="7d")
    assert "task-a" not in windowed


def test_since_scoped_stats_keep_queued_runs_like_the_run_list(session: Session) -> None:
    # The view's since window and the drill-down run list share one rule: a
    # queued run is inside every window, an expired one by its end time.
    live_batch = _batch("b-1", "project-1")
    live_batch.created_at = datetime.now(timezone.utc)
    session.add_all([live_batch])
    expired = _run("r-expired-old", "b-1", "task-a", status="error", pass_result=None, started_at=None)
    expired.completed_at = datetime.now(timezone.utc) - timedelta(days=30)
    session.add_all(
        [
            _run("r-queued", "b-1", "task-a", status="pending", pass_result=None, started_at=None),
            expired,
        ]
    )
    session.commit()

    runs = load_run_stat_fields(session, "project-1", ["task-a"], since="7d")["task-a"]
    assert [r.status for r in runs] == ["pending"]
