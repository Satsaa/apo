"""Scene tests for selection-scoped view comparison.

Exercises POST (resolve + freeze) and GET (immutable read) through the
registered routes, and the comparison state across the four cases that matter:
aligned, task-definition-revision mismatch, execution-revision mismatch, and a
task with no run on one side.
"""

# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

from datetime import datetime, timedelta, timezone

from typing import cast

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlmodel import Session

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskCheckReportDB,
    AgentTaskRunDB,
    TaskDefinitionRevisionDB,
    TaskRevisionDB,
    UserDB,
)
from apo.services.agent_task_run_details import load_task_run_details, load_task_run_summaries
from tests.conftest import seed_project_for_user

_PROJECT = "proj-cmp"
_OWNER = "owner-cmp"
_W = "evals/cmp-comparable"  # both sides, same def + same exec (same batch)
_X = "evals/cmp-def-mismatch"  # def revisions differ
_Y = "evals/cmp-exec-mismatch"  # exec (batch) revisions differ
_Z = "evals/cmp-no-deepseek"  # no DeepSeek run
_S1 = "evals/cmp-selfpair"  # issue #140: latest run is the pinned model's
_S2 = "evals/cmp-null-model"  # legacy NULL-model run stays in unpinned cohort


def _seed(session: Session) -> None:
    now = datetime.now(timezone.utc)
    session.add(UserDB(id=_OWNER, email="owner-cmp@test", name="Owner", password_hash="x"))
    session.flush()
    seed_project_for_user(session, _OWNER, project_id=_PROJECT)

    # two batches → two distinct exec (batch) revision shas
    session.add_all(
        [
            AgentTaskBatchRunDB(id="b-opus", project=_PROJECT, created_at=now, status="completed", total_tasks=4, task_root="/t", environment="default", selection_type="task"),
            AgentTaskBatchRunDB(id="b-deep", project=_PROJECT, created_at=now, status="completed", total_tasks=3, task_root="/t", environment="default", selection_type="task"),
        ]
    )
    session.add_all(
        [
            TaskRevisionDB(id="rev-opus", project=_PROJECT, batch_run_id="b-opus", materialization="attested", source_type="git", content_sha256="e" * 64, file_count=1, uncompressed_size_bytes=1, manifest_summary_json={}),
            TaskRevisionDB(id="rev-deep", project=_PROJECT, batch_run_id="b-deep", materialization="attested", source_type="git", content_sha256="f" * 64, file_count=1, uncompressed_size_bytes=1, manifest_summary_json={}),
        ]
    )
    session.flush()
    # two task-definition revisions → def mismatch when sides point at different ones
    session.add_all(
        [
            TaskDefinitionRevisionDB(id="d1", project=_PROJECT, task_id=_W, content_sha256="a" * 64, source_size_bytes=1),
            TaskDefinitionRevisionDB(id="d2", project=_PROJECT, task_id=_X, content_sha256="b" * 64, source_size_bytes=1),
        ]
    )
    session.flush()

    def _run(rid: str, batch: str, task: str, model: str | None, def_rev: str | None, at: datetime | None = None) -> AgentTaskRunDB:
        when = at or now
        run = AgentTaskRunDB(
            id=rid, batch_run_id=batch, task_id=task, task_path=f"/t/{task}",
            status="passed", pass_result=True, configured_model=model,
            configured_effort=None, task_definition_revision_id=def_rev,
            started_at=when, completed_at=when,
            total_checks=1, passed_checks=1, failed_checks=0,
        )
        session.add(run)
        session.flush()
        session.add(
            AgentTaskCheckReportDB(
                run_id=rid,
                value_json=[{"id": f"check-{rid}", "pass": True, "reasoning": model}],
                created_at=now,
            )
        )
        return run

    # W: opus + deepseek both in b-opus, def d1 -> aligned
    _run("w-opus", "b-opus", _W, "claude-opus", "d1")
    _run("w-deep", "b-opus", _W, "deepseek", "d1")
    # X: opus (d1) + deepseek (d2) -> def mismatch
    _run("x-opus", "b-opus", _X, "claude-opus", "d1")
    _run("x-deep", "b-deep", _X, "deepseek", "d2")
    # Y: opus (b-opus, d1) + deepseek (b-deep, d1) -> exec mismatch (def matches)
    _run("y-opus", "b-opus", _Y, "claude-opus", "d1")
    _run("y-deep", "b-deep", _Y, "deepseek", "d1")
    # Z: opus only -> deepseek side has no run
    _run("z-opus", "b-opus", _Z, "claude-opus", "d1")
    # S1 (issue #140 repro): the deepseek run is the LATEST overall. The
    # unpinned side must resolve to the older opus run instead of pairing
    # deepseek's latest run against itself.
    _run("s1-opus", "b-opus", _S1, "claude-opus", "d1", at=now - timedelta(hours=2))
    _run("s1-deep", "b-deep", _S1, "deepseek", "d1", at=now - timedelta(hours=1))
    # S2: a legacy NULL-model run + a deepseek run. NULL-model rows must stay
    # in the unpinned cohort when the member model is excluded (SQL ``!=``
    # drops NULLs; the cohort condition is explicitly NULL-safe).
    _run("s2-null", "b-opus", _S2, None, "d1", at=now - timedelta(hours=2))
    _run("s2-deep", "b-deep", _S2, "deepseek", "d1", at=now - timedelta(hours=1))
    session.commit()


@pytest.fixture(name="cmp_client")
def cmp_client_fixture(session: Session, make_authed_client):
    _seed(session)
    return make_authed_client(_OWNER, session)


def _create(cmp_client: TestClient, task_ids: list[str]) -> dict[str, object]:
    resp = cmp_client.post(
        f"/v1/projects/{_PROJECT}/task-view-comparisons",
        json={
            "task_ids": task_ids,
            "view_a": {"model": "claude-opus", "effort": None},
            "view_b": {"model": "deepseek", "effort": None},
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_comparison_resolves_and_classifies_state(cmp_client: TestClient) -> None:
    snap = _create(cmp_client, [_W, _X, _Y, _Z])
    assert snap["coverage"] == {"both_run": 3, "aligned": 2, "scope": 4}
    by_task = {c["task_id"]: c for c in snap["resolved"]}  # pyright: ignore[reportGeneralTypeIssues]
    assert by_task[_W]["state"] == "aligned"
    assert by_task[_X]["state"] == "different_definition"  # def mismatch
    assert by_task[_Y]["state"] == "aligned"  # same def, different bundle — still aligned
    # Z has no DeepSeek run -> b_run_id None, not counted in both_run
    assert by_task[_Z]["b_run_id"] is None
    assert by_task[_Z]["state"] == "not_run"


def test_comparison_snapshot_is_immutable_on_read(cmp_client: TestClient) -> None:
    snap = _create(cmp_client, [_W])
    # GET by the opaque id round-trips the frozen resolved set + coverage.
    got = cmp_client.get(f"/v1/projects/{_PROJECT}/task-view-comparisons/{snap['id']}").json()
    assert got["resolved"] == snap["resolved"]
    assert got["coverage"] == snap["coverage"]
    assert got["id"].startswith("tvc_")


def test_comparison_overview_returns_summaries_not_details(
    cmp_client: TestClient,
) -> None:
    snap = _create(cmp_client, [_W, _X, _Y, _Z])

    response = cmp_client.get(
        f"/v1/projects/{_PROJECT}/task-view-comparisons/{snap['id']}/overview"
    )

    assert response.status_code == 200, response.text
    overview = response.json()
    assert overview["snapshot"] == snap
    assert [run["id"] for run in overview["runs"]] == [
        "w-opus",
        "w-deep",
        "x-opus",
        "x-deep",
        "y-opus",
        "y-deep",
        "z-opus",
    ]
    # Summaries must not carry detail-only keys.
    assert "checks_json" not in overview["runs"][0]
    assert "transcript_json" not in overview["runs"][0]
    assert "deliverables_json" not in overview["runs"][0]
    assert "task_definition" not in overview["runs"][0]
    # Scalar fields are present.
    assert overview["runs"][0]["total_checks"] == 1
    assert overview["runs"][0]["passed_checks"] == 1


def test_comparison_task_evidence_resolves_frozen_pair(
    cmp_client: TestClient,
) -> None:
    snap = _create(cmp_client, [_W, _X, _Y, _Z])

    response = cmp_client.get(
        f"/v1/projects/{_PROJECT}/task-view-comparisons/{snap['id']}/task-evidence",
        params={"task_id": _W},
    )

    assert response.status_code == 200, response.text
    evidence = response.json()
    assert evidence["task_id"] == _W
    assert evidence["left"]["id"] == "w-opus"
    assert evidence["right"]["id"] == "w-deep"
    # Detail fields are present.
    assert evidence["left"]["checks_json"] == [
        {"id": "check-w-opus", "pass": True, "reasoning": "claude-opus"}
    ]
    assert evidence["left"]["task_definition"]["id"] == "d1"


def test_comparison_task_evidence_one_sided(
    cmp_client: TestClient,
) -> None:
    snap = _create(cmp_client, [_W, _X, _Y, _Z])

    response = cmp_client.get(
        f"/v1/projects/{_PROJECT}/task-view-comparisons/{snap['id']}/task-evidence",
        params={"task_id": _Z},
    )

    assert response.status_code == 200, response.text
    evidence = response.json()
    assert evidence["task_id"] == _Z
    assert evidence["left"]["id"] == "z-opus"
    assert evidence["right"] is None


def test_comparison_task_evidence_rejects_unknown_task(
    cmp_client: TestClient,
) -> None:
    snap = _create(cmp_client, [_W])

    response = cmp_client.get(
        f"/v1/projects/{_PROJECT}/task-view-comparisons/{snap['id']}/task-evidence",
        params={"task_id": "not-in-snapshot"},
    )
    assert response.status_code == 404


def test_comparison_old_evidence_route_is_gone(
    cmp_client: TestClient,
) -> None:
    snap = _create(cmp_client, [_W])
    response = cmp_client.get(
        f"/v1/projects/{_PROJECT}/task-view-comparisons/{snap['id']}/evidence"
    )
    assert response.status_code == 404


def test_summary_loader_excludes_heavy_evidence(session: Session) -> None:
    _seed(session)
    statements: list[str] = []

    def _record_statement(_conn, _cursor, statement, _params, _context, _many) -> None:
        statements.append(statement)

    bind = session.get_bind()
    event.listen(bind, "before_cursor_execute", _record_statement)
    try:
        summaries = load_task_run_summaries(
            session,
            ["w-opus", "w-deep", "z-opus"],
            project_id=_PROJECT,
        )
    finally:
        event.remove(bind, "before_cursor_execute", _record_statement)

    assert len(summaries) == 3
    assert [s.id for s in summaries] == ["w-opus", "w-deep", "z-opus"]
    # No detail-only keys.
    assert not hasattr(summaries[0], "checks_json")
    # No Check Report or Task Definition query occurred.
    joined_sql = " ".join(statements).lower()
    assert "agent_task_check_reports" not in joined_sql
    assert "task_definition_revisions" not in joined_sql


def test_summary_loader_is_project_scoped(session: Session) -> None:
    _seed(session)
    summaries = load_task_run_summaries(
        session,
        ["w-opus", "w-deep"],
        project_id="other-project",
    )
    assert len(summaries) == 0


def test_bulk_run_evidence_uses_a_fixed_number_of_queries(session: Session) -> None:
    _seed(session)
    statements: list[str] = []

    def _record_statement(_conn, _cursor, statement, _params, _context, _many) -> None:
        statements.append(statement)

    bind = session.get_bind()
    event.listen(bind, "before_cursor_execute", _record_statement)
    try:
        details = load_task_run_details(
            session,
            ["w-opus", "w-deep", "x-opus", "x-deep", "y-opus", "y-deep", "z-opus"],
            project_id=_PROJECT,
        )
    finally:
        event.remove(bind, "before_cursor_execute", _record_statement)

    assert len(details) == 7
    # runs + batches/triggers + definitions + checks + corrections
    # + deliverables — the corrections overlay is one bulk query, not per-run.
    assert len(statements) == 6


def test_comparison_rejects_empty_selection(cmp_client: TestClient) -> None:
    resp = cmp_client.post(
        f"/v1/projects/{_PROJECT}/task-view-comparisons",
        json={"task_ids": [], "view_a": {"model": "claude-opus"}, "view_b": {"model": "deepseek"}},
    )
    assert resp.status_code == 422


def test_comparison_requires_membership(session: Session, make_authed_client) -> None:
    _seed(session)
    other = make_authed_client("intruder-cmp", session)
    resp = other.post(
        f"/v1/projects/{_PROJECT}/task-view-comparisons",
        json={"task_ids": [_W], "view_a": {"model": "claude-opus"}, "view_b": {"model": "deepseek"}},
    )
    assert resp.status_code == 403


def test_overview_response_is_independent_of_check_report_size(
    cmp_client: TestClient,
    session: Session,
) -> None:
    """Acceptance test: the production incident that caused the OOM
    had ~69 MiB of Check Report JSON behind 53 runs. The overview response
    must stay bounded regardless of report size."""
    import json

    snap = _create(cmp_client, [_W, _X, _Y, _Z])

    # Insert multi-megabyte sentinel reports directly, bypassing normalization.
    big_sentinel = "OVERFLOW_" * 500_000  # ~4.5 MiB per report
    for run_id in ("w-opus", "w-deep", "x-opus", "x-deep", "y-opus", "y-deep", "z-opus"):
        report = session.get(AgentTaskCheckReportDB, run_id)
        assert report is not None
        report.value_json = [{"id": "c", "pass": True, "reasoning": big_sentinel}]
        session.add(report)
    session.commit()

    response = cmp_client.get(
        f"/v1/projects/{_PROJECT}/task-view-comparisons/{snap['id']}/overview"
    )

    assert response.status_code == 200, response.text
    body = response.json()
    serialized = json.dumps(body)

    # The multi-megabyte sentinel must not appear in the overview response.
    assert big_sentinel not in serialized
    # Response should be well under 100 KiB — it carries only scalar summaries.
    assert len(serialized) < 100_000


# ---------------------------------------------------------------------------
# Issue #140 — superset-vs-member comparison
# ---------------------------------------------------------------------------


def _create_with_views(
    cmp_client: TestClient,
    task_ids: list[str],
    view_a: dict[str, str | None],
    view_b: dict[str, str | None],
) -> dict[str, object]:
    resp = cmp_client.post(
        f"/v1/projects/{_PROJECT}/task-view-comparisons",
        json={"task_ids": task_ids, "view_a": view_a, "view_b": view_b},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_unpinned_side_excludes_pinned_model(cmp_client: TestClient) -> None:
    """"All models" vs a pinned model must resolve the unpinned side to the
    other models' runs. Before the fix, side A picked the globally-latest run
    — the pinned model's own run — and every row paired a run against itself,
    reporting "all tasks are identical"."""
    snap = _create_with_views(
        cmp_client,
        [_S1],
        {"model": None, "effort": None},
        {"model": "deepseek", "effort": None},
    )
    cell = cast(list[dict[str, object]], snap["resolved"])[0]
    assert cell["a_run_id"] == "s1-opus"
    assert cell["b_run_id"] == "s1-deep"
    assert cell["a_run_id"] != cell["b_run_id"]


def test_reverse_unpinned_side_excludes_pinned_model(cmp_client: TestClient) -> None:
    """The reverse pairing (pinned A vs "All models" B) applies the same rule."""
    snap = _create_with_views(
        cmp_client,
        [_S1],
        {"model": "deepseek", "effort": None},
        {"model": None, "effort": None},
    )
    cell = cast(list[dict[str, object]], snap["resolved"])[0]
    assert cell["a_run_id"] == "s1-deep"
    assert cell["b_run_id"] == "s1-opus"


def test_null_model_runs_stay_in_unpinned_cohort(cmp_client: TestClient) -> None:
    """Legacy runs without a configured model remain part of "everything
    else" when the member model is excluded (SQL ``!=`` silently drops
    NULLs; the cohort condition must not)."""
    snap = _create_with_views(
        cmp_client,
        [_S2],
        {"model": None, "effort": None},
        {"model": "deepseek", "effort": None},
    )
    cell = cast(list[dict[str, object]], snap["resolved"])[0]
    assert cell["a_run_id"] == "s2-null"
    assert cell["b_run_id"] == "s2-deep"


def test_both_sides_pinned_bypasses_exclusion(cmp_client: TestClient) -> None:
    """Two pinned models compare exactly as before — the rule only exists
    for the superset-vs-member shape."""
    snap = _create_with_views(
        cmp_client,
        [_S1],
        {"model": "claude-opus", "effort": None},
        {"model": "deepseek", "effort": None},
    )
    cell = cast(list[dict[str, object]], snap["resolved"])[0]
    assert cell["a_run_id"] == "s1-opus"
    assert cell["b_run_id"] == "s1-deep"


def test_a_side_whose_only_run_never_started_is_not_run(
    cmp_client: TestClient, session: Session
) -> None:
    """A deepseek run that expired in the queue has no outcome: the comparison
    reads that side as not run, as the task card does, not as an error."""
    task = "evals/cmp-never-started"
    now = datetime.now(timezone.utc)
    session.add_all(
        [
            AgentTaskRunDB(
                id="n-opus", batch_run_id="b-opus", task_id=task, task_path=f"/t/{task}",
                status="passed", pass_result=True, configured_model="claude-opus",
                task_definition_revision_id="d1", started_at=now, completed_at=now,
                total_checks=1, passed_checks=1, failed_checks=0,
            ),
            AgentTaskRunDB(
                id="n-deep-expired", batch_run_id="b-deep", task_id=task, task_path=f"/t/{task}",
                status="error", pass_result=None, configured_model="deepseek",
                no_verdict_reason="executor", started_at=None, completed_at=now,
            ),
        ]
    )
    session.commit()

    cell = cast(list[dict[str, object]], _create(cmp_client, [task])["resolved"])[0]
    assert cell["a_run_id"] == "n-opus"
    assert cell["b_run_id"] is None
    assert cell["state"] == "not_run"
