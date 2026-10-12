"""Manual test result corrections — the single correction authority.

A correction is an append-only human decision about one recorded top-level
Test of one Task Run: set effective PASS/FAIL, or clear back to the recorded
result. The Check Report, assertions, judge evidence, and judgments are
immutable recorded evidence; corrections only change the *effective
projection* — the hot Run scalars (``status`` / ``pass_result`` /
``passed_checks`` / ``failed_checks`` / ``corrected_tests``) and the parent
Batch rollup are re-derived from the recorded report + active corrections in
one transaction.

This module owns the overlay logic. Every read path that must show effective
results (Run detail, CLI ``runs show``, comparison evidence) and every write
path (the corrections route) goes through :func:`effective_check_report` /
:func:`correct_test_result` — there is no second implementation of the
projection.
"""

# pyright: reportAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false, reportPrivateUsage=false

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Literal, cast

from sqlmodel import Session, col, select

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AgentTaskTestResultCorrectionDB,
    UserDB,
)
from apo.models.schemas import (
    ActiveTestResultCorrection,
    CorrectionAction,
    CorrectedTestResult,
    as_no_verdict_reason,
)
from apo.services.human_actor import HumanActor
from apo.services.check_report_storage import (
    caller_error_message,
    compose_no_verdict_error_message,
    derive_check_outcome,
    is_judge_no_verdict_run,
    judge_no_verdict_message,
    load_check_report,
)

CORRECTABLE_RUN_STATUSES = ("passed", "failed")

REASON_MIN_CHARS = 3
REASON_MAX_CHARS = 1000

_SET_ACTIONS: dict[str, bool] = {"set_pass": True, "set_fail": False}


class CorrectionError(ValueError):
    """Domain rejection. The route maps ``kind`` onto the error contract."""

    kind: str

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


CorrectionActor = HumanActor
"""Who is correcting, through which identity channel."""


def load_corrections(
    session: Session,
    run_ids: Sequence[str],
) -> dict[str, list[AgentTaskTestResultCorrectionDB]]:
    """All corrections for many runs in one query (no N+1 on bulk detail)."""
    unique_ids = list(dict.fromkeys(run_ids))
    if not unique_ids:
        return {}
    rows = session.exec(
        select(AgentTaskTestResultCorrectionDB)
        .where(col(AgentTaskTestResultCorrectionDB.task_run_id).in_(unique_ids))
        .order_by(
            col(AgentTaskTestResultCorrectionDB.created_at).desc(),
            col(AgentTaskTestResultCorrectionDB.id).desc(),
        )
    ).all()
    by_run: dict[str, list[AgentTaskTestResultCorrectionDB]] = {
        run_id: [] for run_id in unique_ids
    }
    for row in rows:
        by_run[row.task_run_id].append(row)
    return by_run


def resolve_actor_labels(
    session: Session,
    corrections: Sequence[AgentTaskTestResultCorrectionDB],
) -> dict[str, str | None]:
    """Email labels for every correcting user, one lookup per user id."""
    user_ids = {c.corrected_by_user_id for c in corrections if c.corrected_by_user_id}
    labels: dict[str, str | None] = {}
    for uid in user_ids:
        user = session.get(UserDB, uid)
        labels[uid] = user.email if user is not None else None
    return labels


def _active_by_test(
    corrections: Sequence[AgentTaskTestResultCorrectionDB],
    *,
    as_of: datetime | None = None,
) -> dict[str, AgentTaskTestResultCorrectionDB]:
    """Latest non-clear action per test at/before ``as_of``.

    Rows arrive newest-first from :func:`load_corrections`; the first row
    seen per test wins, and ``clear`` means "no active correction".
    """
    active: dict[str, AgentTaskTestResultCorrectionDB] = {}
    decided: set[str] = set()
    newest_first = sorted(
        corrections, key=lambda row: (row.created_at, row.id), reverse=True
    )
    for row in newest_first:
        if as_of is not None and row.created_at > as_of:
            continue
        if row.test_id in decided:
            continue
        # Rows are newest-first, so the first row seen per test decides —
        # including a `clear`, which leaves the test decided with no active
        # correction (older set-actions must not resurrect through it).
        decided.add(row.test_id)
        if row.action != "clear":
            active[row.test_id] = row
    return active


def effective_check_report(
    recorded_checks: list[dict[str, object]],
    corrections: Sequence[AgentTaskTestResultCorrectionDB],
    *,
    as_of: datetime | None = None,
    actor_labels: dict[str, str | None] | None = None,
) -> list[dict[str, object]]:
    """Overlay active corrections onto a copy of the recorded report.

    Only ``pass``, ``recorded_pass``, and ``correction`` are overlaid;
    reasoning, assertions, and judge metadata are carried through unchanged.
    Input lists/dicts are never mutated — every check is a fresh dict.
    """
    active = _active_by_test(corrections, as_of=as_of)
    labels = actor_labels or {}
    projected: list[dict[str, object]] = []
    for check in recorded_checks:
        entry = dict(check)
        test_id = entry.get("id")
        correction = (
            active.get(test_id) if isinstance(test_id, str) else None
        )
        if correction is not None:
            entry["recorded_pass"] = entry.get("pass") is True
            entry["pass"] = _SET_ACTIONS.get(correction.action) is True
            entry["correction"] = ActiveTestResultCorrection(
                id=correction.id,
                action=cast(CorrectionAction, correction.action),
                pass_result=_SET_ACTIONS.get(correction.action) is True,
                reason=correction.reason or "",
                corrected_by_user_id=correction.corrected_by_user_id,
                corrected_by_label=labels.get(
                    correction.corrected_by_user_id or "",
                    correction.corrected_by_user_id,
                ),
                corrected_via=cast(
                    Literal["session", "api_key", "open_dev"],
                    correction.corrected_via,
                ),
                created_at=correction.created_at,
            ).model_dump(mode="json")
        projected.append(entry)
    return projected


def correct_test_result(
    session: Session,
    *,
    task_run: AgentTaskRunDB,
    project: str,
    test_id: str,
    action: str,
    reason: str | None,
    actor: CorrectionActor,
) -> CorrectedTestResult:
    """Append one correction and re-derive the effective projection.

    Validation, append, Run scalar update, and Batch rollup all happen inside
    the caller-visible state before the single commit at the end — no helper
    commits halfway through.
    """
    if action not in ("set_pass", "set_fail", "clear"):
        raise CorrectionError("invalid_action", f"unknown correction action {action!r}")
    verdict_bearing = (
        task_run.status in CORRECTABLE_RUN_STATUSES and task_run.pass_result is not None
    )
    if not verdict_bearing and not is_judge_no_verdict_run(task_run):
        raise CorrectionError(
            "run_not_correctable",
            f"only terminal verdict-bearing runs can be corrected; status is {task_run.status!r}",
        )

    recorded = load_check_report(session, task_run.id)
    if not recorded:
        raise CorrectionError(
            "run_not_correctable", "the run has no recorded Check Report to correct"
        )
    matches = [c for c in recorded if c.get("id") == test_id]
    if not matches:
        raise CorrectionError(
            "test_result_not_found", f"no recorded test {test_id!r} on this run"
        )
    if len(matches) > 1:
        raise CorrectionError(
            "ambiguous_test_id", f"test id {test_id!r} appears {len(matches)} times"
        )

    normalized_reason = reason.strip() if isinstance(reason, str) else None
    if action in _SET_ACTIONS:
        if (
            normalized_reason is None
            or not REASON_MIN_CHARS <= len(normalized_reason) <= REASON_MAX_CHARS
        ):
            raise CorrectionError(
                "reason_required",
                f"a {REASON_MIN_CHARS}–{REASON_MAX_CHARS} character reason is required for {action}",
            )

    corrections = load_corrections(session, [task_run.id]).get(task_run.id, [])
    active = _active_by_test(corrections)

    if action == "clear" and test_id not in active:
        raise CorrectionError(
            "no_active_correction", f"test {test_id!r} has no active correction to clear"
        )

    current = active.get(test_id)
    # Idempotent retry: same latest action and reason — no duplicate row.
    # The projection is still re-derived and persisted below, like any
    # correction, so a retry leaves Run and Batch consistent.
    is_retry = (
        current is not None
        and current.action == action
        and (current.reason or "") == (normalized_reason or "")
    )
    if not is_retry:
        session.add(
            AgentTaskTestResultCorrectionDB(
                task_run_id=task_run.id,
                project=project,
                test_id=test_id,
                action=action,
                reason=normalized_reason,
                corrected_by_user_id=actor.user_id,
                corrected_via=actor.via,
                api_key_id=actor.api_key_id,
            )
        )
        session.flush()
        corrections = load_corrections(session, [task_run.id]).get(task_run.id, [])

    result = _derive(session, task_run, recorded, corrections, test_id)

    # Batch rollup from child Run scalars, staged (never committed) here.
    batch = session.get(AgentTaskBatchRunDB, task_run.batch_run_id)
    if batch is not None:
        stage_batch_rollup(session, batch)
    session.commit()
    return result


def effective_verdict_counts(
    effective: Sequence[dict[str, object]],
) -> tuple[int, int, int, int]:
    """``(total, passed, failed, errored)`` of an effective report.

    A correction is a human verdict on the check — PASS or FAIL — so a
    corrected judge-errored check leaves the errored bucket either way. Shared
    by corrections and the v50 backfill so both count the same way.
    """
    total = len(effective)
    passed = sum(1 for c in effective if c.get("pass") is True)
    errored = sum(
        1
        for c in effective
        if "correction" not in c and derive_check_outcome(c) == "error"
    )
    return total, passed, total - passed - errored, errored


def _derive(
    session: Session,
    task_run: AgentTaskRunDB,
    recorded: list[dict[str, object]],
    corrections: Sequence[AgentTaskTestResultCorrectionDB],
    test_id: str,
) -> CorrectedTestResult:
    """Project the effective report, update Run scalars, build the response."""
    labels = resolve_actor_labels(session, corrections)
    effective = effective_check_report(recorded, corrections, actor_labels=labels)

    total, passed, failed, errored = effective_verdict_counts(effective)
    corrected_count = sum(1 for c in effective if "correction" in c)
    # Only the rule's own message is rewritten; a caller-supplied message
    # (an executor's) survives every correction and clear.
    caller_message = caller_error_message(task_run)
    no_verdict = judge_no_verdict_message(
        total_checks=total, failed_checks=failed, errored_checks=errored
    )
    if no_verdict is not None:
        # Issue #323: the same run-level rule as finalization — only
        # judge-errored checks left non-passing means no verdict.
        task_run.status = "error"
        task_run.pass_result = None
        task_run.no_verdict_reason = "judge"
        task_run.error_message = compose_no_verdict_error_message(no_verdict, caller_message)
    else:
        task_run.status = "passed" if passed == total and total > 0 else "failed"
        task_run.pass_result = task_run.status == "passed"
        task_run.no_verdict_reason = None
        # Kept on a corrected PASS too: a correction reinterprets checks, it
        # does not retract what the executor reported, and a later clear must
        # be able to bring the run back with it. Surfaces show it on a passed
        # run as a note, not an error.
        task_run.error_message = caller_message
    task_run.total_checks = total
    task_run.passed_checks = passed
    task_run.errored_checks = errored
    task_run.failed_checks = failed
    task_run.corrected_tests = corrected_count
    session.add(task_run)
    session.flush()

    target = next(c for c in effective if c.get("id") == test_id)
    correction_obj: ActiveTestResultCorrection | None = None
    raw = target.get("correction")
    if isinstance(raw, dict):
        correction_obj = ActiveTestResultCorrection.model_validate(raw)

    return CorrectedTestResult(
        test_id=test_id,
        recorded_pass=target.get("recorded_pass") is (
            True if "recorded_pass" in target else target.get("pass")
        ),
        effective_pass=target.get("pass") is True,
        correction=correction_obj,
        run_status=task_run.status,  # type: ignore[arg-type]
        run_pass_result=task_run.pass_result,
        run_no_verdict_reason=as_no_verdict_reason(task_run.no_verdict_reason),
        total_tests=total,
        passed_tests=passed,
        failed_tests=failed,
        errored_tests=errored,
        corrected_tests=corrected_count,
    )


def stage_batch_rollup(session: Session, batch: AgentTaskBatchRunDB) -> None:
    """Recompute Batch scalars from children without committing.

    Same arithmetic as ``agent_task_runner.update_batch_run_status`` minus
    the commit and minus the lifecycle timestamp side effects — a correction
    is interpretation after execution and must not touch batch lifecycle.
    """
    from sqlmodel import select as _select

    runs = session.exec(
        _select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch.id)
    ).all()
    batch.total_tasks = len(runs)
    batch.passed_tasks = sum(1 for r in runs if r.status == "passed")
    batch.failed_tasks = sum(1 for r in runs if r.status == "failed")
    batch.errored_tasks = sum(1 for r in runs if r.status == "error")
    batch.total_checks = sum(r.total_checks for r in runs)
    batch.passed_checks = sum(r.passed_checks for r in runs)
    session.add(batch)


def projected_check_report(
    session: Session,
    task_run: AgentTaskRunDB,
    *,
    as_of: datetime | None = None,
) -> list[dict[str, object]] | None:
    """Effective report for one run (recorded + active corrections).

    Returns ``None`` when the run has no recorded report — mirroring
    ``load_check_report``.
    """
    recorded = load_check_report(session, task_run.id)
    if recorded is None:
        return None
    corrections = load_corrections(session, [task_run.id]).get(task_run.id, [])
    return effective_check_report(
        recorded,
        corrections,
        as_of=as_of,
        actor_labels=resolve_actor_labels(session, corrections),
    )
