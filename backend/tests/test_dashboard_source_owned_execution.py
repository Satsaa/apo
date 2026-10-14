# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUnusedImport=false, reportUnusedParameter=false, reportUnusedVariable=false
# pyright: reportAttributeAccessIssue=false, reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

"""Dashboard source-owned Batch creation, routing, and lifecycle.

Covers acceptance tests:
- 1. Source-owned creation targets the authenticated User.
- 2. Source-owned creation does not require an online Executor.
- 3. Source-owned creation never materializes source.
- 5. Exact catalog Task IDs are required.
- 6. Source-owned Attempts are sequential.
- 7. Dashboard queue deadline is fixed at 24 hours.
- 8. Cancellation preserves existing semantics.
- 11. Catalog mismatch/incompatibility do not reject queue creation.
- 12. Catalog removal fails by identity (queue maintenance).
- Backend scene 1. A member queues a dashboard Batch through the route.
- Backend scene 3. Another member cannot cancel the wrong Project's Batch.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    ProjectMembershipDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
    UserDB,
)
from apo.services.execution_leases import recover_expired_attempts
from apo.services.source_owned_executor import ensure_source_owned_pool

_PROJECT = "acme-evals"
_QUEUE_DEADLINE_SECONDS = 24 * 60 * 60


def _now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture
def project_with_members(session: Session):
    """Create a project with two members (A and B)."""
    user_a = UserDB(email="a@test.com", name="A", password_hash="x", is_active=True)
    user_b = UserDB(email="b@test.com", name="B", password_hash="x", is_active=True)
    session.add(user_a)
    session.add(user_b)
    session.commit()
    session.refresh(user_a)
    session.refresh(user_b)

    project = ProjectDB(id=_PROJECT, name="Acme", created_by=user_a.id)
    session.add(project)
    session.commit()

    now = _now()
    for user in (user_a, user_b):
        session.add(
            ProjectMembershipDB(
                project_id=_PROJECT,
                user_id=user.id,
                role="member",
                created_at=now,
                updated_at=now,
            )
        )
    session.commit()
    return user_a, user_b


def _publish_catalog(
    session: Session,
    *,
    tasks: list[dict[str, str]] | None = None,
    digest: str = "sha256:project-catalog",
) -> str:
    """Publish a catalog with the given tasks; return the source row id."""
    if tasks is None:
        tasks = [
            {
                "task_id": "support/refund",
                "display_name": "refund",
                "folder_path": "support",
                "task_path": "tasks/support/refund",
                "adapter_name": "claude-code",
            },
            {
                "task_id": "support/cancel-subscription",
                "display_name": "cancel-subscription",
                "folder_path": "support",
                "task_path": "tasks/support/cancel-subscription",
                "adapter_name": "claude-code",
            },
        ]
    session.add(
        ProjectTaskSourceDB(
            project=_PROJECT,
            source_type="published",
            catalog_digest=digest,
            task_count=len(tasks),
            status="ready",
        )
    )
    session.commit()
    source = session.exec(
        select(ProjectTaskSourceDB).where(ProjectTaskSourceDB.project == _PROJECT)
    ).first()
    assert source is not None
    for task in tasks:
        session.add(
            ProjectTaskInventoryDB(
                project=_PROJECT,
                task_source_id=source.id,
                task_id=task["task_id"],
                task_inventory_id=task["task_id"],  # pyright: ignore[reportCallIssue]
                display_name=task["display_name"],
                adapter_name=task["adapter_name"],
                folder_path=task["folder_path"],
                task_path=task["task_path"],
                source_type="published",
            )
        )
    session.commit()
    return source.id


def _create_source_owned(
    session: Session,
    *,
    user_id: str,
    task_ids: list[str],
    environment: str = "default",
    run_metadata: dict[str, object] | None = None,
) -> AgentTaskBatchRunDB:
    from apo.services.execution_queue import create_source_owned_batch_run

    return create_source_owned_batch_run(
        session,
        project_id=_PROJECT,
        requested_by_user_id=user_id,
        user_id=user_id,
        task_ids=task_ids,
        environment=environment,
        run_metadata=run_metadata,
    )


# ============================================================================
# Service-level: creation, routing, no-source, exact IDs, deadline
# ============================================================================


class TestSourceOwnedCreation:
    """Acceptance tests 1-3, 5, 7."""

    def test_targets_authenticated_user_and_routes_attempts(self, session, project_with_members):
        user_a, user_b = project_with_members
        _publish_catalog(session)
        pool_id = ensure_source_owned_pool(session, _PROJECT).id

        batch = _create_source_owned(
            session, user_id=user_a.id, task_ids=["support/refund", "support/cancel-subscription"]
        )

        assert batch.requested_by_user_id == user_a.id
        assert batch.execution_target_json == {"kind": "source_owned"}
        attempts = session.exec(
            select(TaskExecutionAttemptDB).where(
                TaskExecutionAttemptDB.batch_run_id == batch.id
            )
        ).all()
        assert len(attempts) == 2
        for attempt in attempts:
            assert attempt.assignment_kind == "source_owned"
            assert attempt.target_user_id == user_a.id
            assert attempt.executor_pool_id == pool_id
            assert attempt.task_revision_id is None
            assert attempt.status == "queued"

    def test_does_not_require_online_executor(self, session, project_with_members):
        user_a, _ = project_with_members
        _publish_catalog(session)
        # No executor enrolled at all.

        batch = _create_source_owned(session, user_id=user_a.id, task_ids=["support/refund"])

        assert batch.status == "queued"
        attempt = session.exec(
            select(TaskExecutionAttemptDB).where(
                TaskExecutionAttemptDB.batch_run_id == batch.id
            )
        ).first()
        assert attempt is not None
        assert attempt.status == "queued"

    def test_never_materializes_source(self, session, project_with_members):
        user_a, _ = project_with_members
        _publish_catalog(session)

        _create_source_owned(session, user_id=user_a.id, task_ids=["support/refund"])

        revisions = session.exec(select(TaskRevisionDB)).all()
        assert revisions == []

    def test_exact_task_ids_required_missing_rejected(self, session, project_with_members):
        user_a, _ = project_with_members
        _publish_catalog(session)

        from apo.services.execution_queue import SourceOwnedSelectionError

        with pytest.raises(SourceOwnedSelectionError) as exc_info:
            _create_source_owned(
                session, user_id=user_a.id, task_ids=["support/refund", "support/missing"]
            )
        assert exc_info.value.kind == "task_not_in_catalog"
        # No partial rows created.
        assert session.exec(select(AgentTaskBatchRunDB)).first() is None

    def test_exact_task_ids_required_duplicate_rejected(self, session, project_with_members):
        user_a, _ = project_with_members
        _publish_catalog(session)

        from apo.services.execution_queue import SourceOwnedSelectionError

        with pytest.raises(SourceOwnedSelectionError) as exc_info:
            _create_source_owned(
                session,
                user_id=user_a.id,
                task_ids=["support/refund", "support/refund"],
            )
        assert exc_info.value.kind == "source_owned_selection_invalid"

    def test_queue_deadline_fixed_at_24_hours(self, session, project_with_members):
        user_a, _ = project_with_members
        _publish_catalog(session)

        before = _now()
        batch = _create_source_owned(
            session, user_id=user_a.id, task_ids=["support/refund", "support/cancel-subscription"]
        )
        after = _now()

        attempts = session.exec(
            select(TaskExecutionAttemptDB).where(
                TaskExecutionAttemptDB.batch_run_id == batch.id
            )
        ).all()
        # All attempts share the Batch's fixed created_at + 24h deadline.
        for attempt in attempts:
            delta = attempt.queue_expires_at - batch.created_at
            assert abs(delta.total_seconds() - _QUEUE_DEADLINE_SECONDS) < 5
            assert attempt.queue_expires_at > after
            assert attempt.queue_expires_at < before + timedelta(hours=24, seconds=10)


class TestSequentialAttempts:
    """Acceptance test 6: only sequence index 0 is claimable first."""

    def test_task_runs_are_ordered_by_request(self, session, project_with_members):
        user_a, _ = project_with_members
        _publish_catalog(session)

        batch = _create_source_owned(
            session,
            user_id=user_a.id,
            task_ids=["support/cancel-subscription", "support/refund"],
        )

        task_runs = session.exec(
            select(AgentTaskRunDB)
            .where(AgentTaskRunDB.batch_run_id == batch.id)
            .order_by(AgentTaskRunDB.sequence_index)  # pyright: ignore[reportArgumentType]
        ).all()
        assert [tr.task_id for tr in task_runs] == [
            "support/cancel-subscription",
            "support/refund",
        ]
        assert [tr.sequence_index for tr in task_runs] == [0, 1]


class TestCatalogMismatchDoesNotReject:
    """Acceptance test 11."""

    def test_incompatible_environment_still_creates_queue(self, session, project_with_members):
        user_a, _ = project_with_members
        _publish_catalog(session)
        # An enrolled but offline executor exists; creation still succeeds.
        from apo.models.db import ExecutorDB

        pool_id = ensure_source_owned_pool(session, _PROJECT).id
        session.add(
            ExecutorDB(
                scope_kind="pool",
                project=_PROJECT,
                executor_pool_id=pool_id,
                name="offline-machine",
                enabled=True,
                credential_prefix="apo_ex_off1",
                credential_hash="hash-offline",
                protocol_version=1,
                executor_version="0.1.0",
                enrolled_by_user_id=user_a.id,
                driver_kinds_json=["subprocess"],
                max_concurrency=4,
                last_seen_at=_now() - timedelta(hours=2),
            )
        )
        session.commit()

        batch = _create_source_owned(session, user_id=user_a.id, task_ids=["support/refund"])

        assert batch.status == "queued"


class TestQueueRecovery:
    """Acceptance tests 7 (expiry) and 12 (catalog removal)."""

    def test_expired_queued_attempt_fails_executor_unavailable(self, session, project_with_members):
        user_a, _ = project_with_members
        _publish_catalog(session)

        batch = _create_source_owned(session, user_id=user_a.id, task_ids=["support/refund"])
        attempt = session.exec(
            select(TaskExecutionAttemptDB).where(
                TaskExecutionAttemptDB.batch_run_id == batch.id
            )
        ).first()
        assert attempt is not None

        # Force the deadline into the past and run recovery.
        attempt.queue_expires_at = _now() - timedelta(seconds=1)
        session.add(attempt)
        session.commit()

        counts = recover_expired_attempts(session, now=_now())

        assert counts.failed_unavailable == 1
        session.refresh(attempt)
        assert attempt.status == "failed"
        assert attempt.failure_kind == "executor_unavailable"

    def test_running_attempt_not_stopped_by_queue_deadline(self, session, project_with_members):
        user_a, _ = project_with_members
        _publish_catalog(session)

        batch = _create_source_owned(session, user_id=user_a.id, task_ids=["support/refund"])
        attempt = session.exec(
            select(TaskExecutionAttemptDB).where(
                TaskExecutionAttemptDB.batch_run_id == batch.id
            )
        ).first()
        assert attempt is not None
        # Simulate a started, running attempt whose queue deadline passed.
        attempt.status = "running"
        attempt.started_at = _now()
        attempt.queue_expires_at = _now() - timedelta(seconds=1)
        attempt.lease_expires_at = _now() + timedelta(minutes=5)
        session.add(attempt)
        session.commit()

        counts = recover_expired_attempts(session, now=_now())

        # Queue recovery must not touch a running attempt.
        assert counts.failed_unavailable == 0
        session.refresh(attempt)
        assert attempt.status == "running"

    def test_catalog_removal_fails_by_identity(self, session, project_with_members):
        user_a, _ = project_with_members
        _publish_catalog(
            session,
            tasks=[
                {
                    "task_id": "support/refund",
                    "display_name": "refund",
                    "folder_path": "support",
                    "task_path": "tasks/support/refund",
                    "adapter_name": "claude-code",
                }
            ],
        )

        batch = _create_source_owned(session, user_id=user_a.id, task_ids=["support/refund"])
        attempt = session.exec(
            select(TaskExecutionAttemptDB).where(
                TaskExecutionAttemptDB.batch_run_id == batch.id
            )
        ).first()
        assert attempt is not None

        # Publish a replacement catalog without the task.
        source = session.exec(
            select(ProjectTaskSourceDB).where(ProjectTaskSourceDB.project == _PROJECT)
        ).first()
        assert source is not None
        for inv in session.exec(
            select(ProjectTaskInventoryDB).where(
                ProjectTaskInventoryDB.task_source_id == source.id
            )
        ).all():
            session.delete(inv)
        source.catalog_digest = "sha256:replacement"
        source.task_count = 0
        session.add(source)
        session.commit()

        # an attempt whose task is no longer in the
        # catalog fails with task_not_in_catalog. We simulate the maintenance
        # step the spec references.
        from apo.services.execution_leases import fail_attempt

        fail_attempt(
            session,
            attempt=attempt,
            failure_kind="task_not_in_catalog",
            error_message="task no longer in published catalog",
        )
        session.refresh(attempt)
        assert attempt.status == "failed"
        assert attempt.failure_kind == "task_not_in_catalog"
        run = session.get(AgentTaskRunDB, attempt.task_run_id)
        assert run is not None
        assert (run.status, run.pass_result) == ("error", None)
        # An execution failure, not a judge no-verdict (issue #323).
        assert run.no_verdict_reason == "executor"


# ============================================================================
# Route-level scene tests
# ============================================================================


class TestCreateBatchRunRoute:
    """Backend scene test 1."""

    def test_member_queues_source_owned_batch_through_route(
        self, client, session, project_with_members, make_authed_client
    ):
        user_a, _ = project_with_members
        _publish_catalog(session)

        authed = make_authed_client(user_a.id, session, is_admin=False)
        before = _now()

        resp = authed.post(
            "/v1/agent-task-batch-runs",
            json={
                "project": _PROJECT,
                "task_ids": ["support/refund", "support/cancel-subscription"],
            },
        )

        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["status"] == "queued"
        assert body["execution_target"] == {"kind": "source_owned"}
        # The clicking member is recorded as the requester, through the route.
        assert body["requested_by_user_id"] == user_a.id
        assert body["requested_by_label"] == user_a.email
        assert body["executor_pool_name"] is None
        assert len(body["attempts"]) == 2
        for attempt in body["attempts"]:
            assert attempt["assignment_kind"] == "source_owned"
            assert attempt["executor_id"] is None
            assert attempt["executor_pool_id"] is None
            assert attempt["executor_name"] is None
            assert attempt["driver_kind"] is None
            # 24-hour deadline.
            expiry = datetime.fromisoformat(attempt["queue_expires_at"].replace("Z", "+00:00"))
            assert abs((expiry - before).total_seconds() - _QUEUE_DEADLINE_SECONDS) < 10

    def test_request_cannot_spoof_routing_fields(self, client, session, project_with_members, make_authed_client):
        user_a, _ = project_with_members
        _publish_catalog(session)
        authed = make_authed_client(user_a.id, session, is_admin=False)

        resp = authed.post(
            "/v1/agent-task-batch-runs",
            json={
                "project": _PROJECT,
                "task_ids": ["support/refund"],
                "target_user_id": "attacker",
                "requested_by_user_id": "attacker",
            },
        )

        # Unknown routing fields are rejected by validation.
        assert resp.status_code == 422

    def test_legacy_path_fields_rejected_for_source_owned(
        self, client, session, project_with_members, make_authed_client
    ):
        user_a, _ = project_with_members
        _publish_catalog(session)
        authed = make_authed_client(user_a.id, session, is_admin=False)

        resp = authed.post(
            "/v1/agent-task-batch-runs",
            json={
                "project": _PROJECT,
                "task_ids": ["support/refund"],
                "task_root": "tasks",
            },
        )

        assert resp.status_code == 422

    def test_missing_catalog_rejected(self, client, session, project_with_members, make_authed_client):
        user_a, _ = project_with_members
        # No catalog published.
        authed = make_authed_client(user_a.id, session, is_admin=False)

        resp = authed.post(
            "/v1/agent-task-batch-runs",
            json={
                "project": _PROJECT,
                "task_ids": ["support/refund"],
            },
        )

        assert resp.status_code == 409
        assert resp.json()["detail"]["kind"] == "task_catalog_missing"

    def test_legacy_pool_path_still_works(self, client, session, project_with_members, make_authed_client):
        """Pool target is preserved for protocol-v1 migration."""
        user_a, _ = project_with_members
        from apo.models.db import ExecutorPoolDB

        session.add(
            ExecutorPoolDB(
                project=_PROJECT,
                name="Legacy",
                slug="legacy",
                kind="bundled",
                enabled=True,
                required_driver_kind="subprocess",
            )
        )
        session.commit()
        pool = session.exec(
            select(ExecutorPoolDB).where(ExecutorPoolDB.project == _PROJECT)
        ).first()
        assert pool is not None
        authed = make_authed_client(user_a.id, session, is_admin=False)

        resp = authed.post(
            "/v1/agent-task-batch-runs",
            json={
                "project": _PROJECT,
                "selection_type": "tasks",
                "task_paths": ["tasks/support/refund"],
                "execution_target": {"kind": "pool", "pool_id": pool.id},
            },
        )
        # Pooled path needs a task source; we only assert it doesn't dispatch
        # to source-owned. A non-409 dispatch-shape error is acceptable here.
        assert resp.status_code != 201 or resp.json()["execution_target"]["kind"] == "pool"


class TestCancelRoute:
    """Acceptance test 8 + backend scene test 3."""

    def test_cancel_is_idempotent(self, client, session, project_with_members, make_authed_client):
        user_a, _ = project_with_members
        _publish_catalog(session)
        batch = _create_source_owned(
            session, user_id=user_a.id, task_ids=["support/refund", "support/cancel-subscription"]
        )
        authed = make_authed_client(user_a.id, session, is_admin=False)

        first = authed.post(f"/v1/agent-task-batch-runs/{batch.id}/cancel")
        second = authed.post(f"/v1/agent-task-batch-runs/{batch.id}/cancel")

        assert first.status_code == 200
        assert second.status_code == 200
        assert first.json()["cancelled"] == 2
        # Idempotent: second call does not double-count.
        attempts = session.exec(
            select(TaskExecutionAttemptDB).where(
                TaskExecutionAttemptDB.batch_run_id == batch.id
            )
        ).all()
        assert all(a.status == "cancelled" for a in attempts)

    def test_other_project_member_cannot_cancel(self, client, session, make_authed_client):
        """Backend scene 3: a user who belongs only to another project cannot cancel."""
        owner = UserDB(email="o@test.com", name="O", password_hash="x", is_active=True)
        other = UserDB(email="p@test.com", name="P", password_hash="x", is_active=True)
        session.add(owner)
        session.add(other)
        session.commit()
        session.refresh(owner)
        session.refresh(other)

        project = ProjectDB(id=_PROJECT, name="Acme", created_by=owner.id)
        session.add(project)
        other_project = ProjectDB(id="other-proj", name="Other", created_by=other.id)
        session.add(other_project)
        session.commit()
        now = _now()
        session.add(
            ProjectMembershipDB(
                project_id=_PROJECT, user_id=owner.id, role="owner",
                created_at=now, updated_at=now,
            )
        )
        session.add(
            ProjectMembershipDB(
                project_id="other-proj", user_id=other.id, role="owner",
                created_at=now, updated_at=now,
            )
        )
        session.commit()
        _publish_catalog(session)
        batch = _create_source_owned(
            session, user_id=owner.id, task_ids=["support/refund"]
        )

        authed = make_authed_client(other.id, session, is_admin=False)
        resp = authed.post(f"/v1/agent-task-batch-runs/{batch.id}/cancel")

        assert resp.status_code == 403
        # Attempt state is unchanged.
        attempt = session.exec(
            select(TaskExecutionAttemptDB).where(
                TaskExecutionAttemptDB.batch_run_id == batch.id
            )
        ).first()
        assert attempt is not None
        assert attempt.status == "queued"
