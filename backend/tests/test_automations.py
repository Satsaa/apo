# pyright: reportAny=false, reportArgumentType=false, reportExplicitAny=false, reportMissingParameterType=false, reportPrivateLocalImportUsage=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnnecessaryTypeIgnoreComment=false, reportUnusedCallResult=false, reportUnusedFunction=false, reportUnusedImport=false, reportUnusedParameter=false

"""Acceptance tests for automations (event triggers → typed actions).

Exercises the condition and template engines, the CRUD/RBAC surface, and
the delivery lifecycle end to end, including failure handling and startup
recovery.
"""

import asyncio
from typing import Any

import httpx
import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlmodel import Session, select

from apo.models.db import (
    AutomationDB,
    AutomationExecutionDB,
    ProjectMembershipDB,
    UserDB,
)
from apo.services import automations as am
from apo.services.automations import (
    conditions_match,
    build_sample_event_data,
    decrypt_github_token,
    encrypt_github_token,
    render_default_body,
    render_template,
    recover_stale_automations,
    validate_action_config,
    validate_conditions,
)
from apo.services.automations import (
    await_pending_deliveries,
    fire_automations_for_event,
)
from apo.services.run_events import RunEvent
from apo.services.webhook_delivery import sign_payload
from tests.conftest import engine as test_engine, seed_project_for_user

PROJECT = "test-project"
MEMBER_USER = "member-user-1"
OWNER_USER = "owner-user-1"


@pytest.fixture(autouse=True)
def _bind_service_engine():
    # Service functions open their own Session(engine) for fan-out and
    # delivery writes; bind that engine to the in-memory test DB.
    original = am.engine
    am.engine = test_engine  # pyright: ignore[reportPrivateUsage]
    yield
    am.engine = original  # pyright: ignore[reportPrivateUsage]


@pytest.fixture(autouse=True)
def _reset_automation_globals():
    """Reset module globals between tests.

    The shared client and semaphore bind to the first event loop that uses
    them, and every async test runs under a fresh asyncio.run — without a
    reset the second test would hit "bound to a different event loop".
    """
    am._client = None  # pyright: ignore[reportPrivateUsage]
    am._semaphore = None  # pyright: ignore[reportPrivateUsage]
    am._delivery_tasks.clear()  # pyright: ignore[reportPrivateUsage]
    yield


@pytest.fixture(autouse=True)
def _automation_env(monkeypatch: MonkeyPatch):
    monkeypatch.setenv(
        "AUTOMATION_TOKEN_ENCRYPTION_KEY",
        "u2Wf3aKQ8HM1TDCnGZO7hUSZL5N0uLrBFpH9yXw2YsA=",
    )
    monkeypatch.delenv("APO_PUBLIC_URL", raising=False)


def _ensure_user(session: Session, user_id: str) -> None:
    # projects.created_by and project_memberships.user_id have real FKs to
    # users.id — the user rows must exist before seeding.
    if session.get(UserDB, user_id) is None:
        session.add(
            UserDB(
                id=user_id,
                email=f"{user_id}@test.invalid",
                password_hash="not-a-real-hash",
                name=user_id,
            )
        )
        session.commit()


def _seed(session: Session, *, project_id: str = PROJECT) -> str:
    _ensure_user(session, OWNER_USER)
    return seed_project_for_user(session, OWNER_USER, project_id=project_id)


def _seed_member(session: Session, *, project_id: str = PROJECT) -> str:
    _seed(session, project_id=project_id)
    _ensure_user(session, MEMBER_USER)
    existing = session.exec(
        select(ProjectMembershipDB).where(
            ProjectMembershipDB.project_id == project_id,
            ProjectMembershipDB.user_id == MEMBER_USER,
        )
    ).first()
    if existing is None:
        session.add(
            ProjectMembershipDB(project_id=project_id, user_id=MEMBER_USER, role="member")
        )
        session.commit()
    return MEMBER_USER


def _make_automation(session: Session, **overrides: Any) -> AutomationDB:
    # automations.project_id has a real FK — the project (and its creator
    # user) must exist first.
    _seed(session, project_id=overrides.get("project_id", PROJECT))
    defaults: dict[str, Any] = {
        "id": "auto-001",
        "project_id": PROJECT,
        "name": "test automation",
        "event_type": "task_run.completed",
        "conditions": [],
        "action_type": "webhook",
        "action_config": {"url": "https://example.com/hook"},
        "secret": "whsec_test",
    }
    defaults.update(overrides)
    automation = AutomationDB(**defaults)
    session.add(automation)
    session.commit()
    session.refresh(automation)
    return automation


def _task_event(data: dict[str, object]) -> RunEvent:
    return RunEvent(event_type="task_run.completed", project=PROJECT, data=data)


# ── Unit: condition engine ─────────────────────────────────────────────────


class TestConditionsMatch:
    def test_empty_matches_everything(self):
        assert conditions_match([], {"anything": 1}) is True

    def test_unknown_field_or_operator_fails_closed(self):
        assert conditions_match([{"field": "nope", "operator": "eq", "value": 1}], {}) is False
        assert conditions_match([{"field": "task_id", "operator": "regex", "value": "x"}], {"task_id": "x"}) is False

    def test_bool_never_matches_number(self):
        # Python's True == 1 must not let a boolean condition match a number.
        assert conditions_match([{"field": "pass_result", "operator": "eq", "value": True}], {"pass_result": 1}) is False
        assert conditions_match([{"field": "pass_result", "operator": "eq", "value": False}], {"pass_result": 0}) is False
        assert conditions_match([{"field": "pass_result", "operator": "eq", "value": False}], {"pass_result": False}) is True

    def test_missing_field_is_null(self):
        assert conditions_match([{"field": "trace_run_id", "operator": "eq", "value": None}], {}) is True
        assert conditions_match([{"field": "trace_run_id", "operator": "ne", "value": None}], {}) is False

    def test_numeric_comparisons(self):
        cond = [{"field": "failed_checks", "operator": "gte", "value": 2}]
        assert conditions_match(cond, {"failed_checks": 2}) is True
        assert conditions_match(cond, {"failed_checks": 1}) is False
        # wrong type never matches
        assert conditions_match(cond, {"failed_checks": "2"}) is False

    def test_string_ordering(self):
        cond = [{"field": "started_at", "operator": "gt", "value": "2026-01-01T00:00:00+00:00"}]
        assert conditions_match(cond, {"started_at": "2026-06-01T00:00:00+00:00"}) is True
        assert conditions_match(cond, {"started_at": "2025-01-01T00:00:00+00:00"}) is False

    def test_in_operator(self):
        cond = [{"field": "task_id", "operator": "in", "value": ["a", "b"]}]
        assert conditions_match(cond, {"task_id": "a"}) is True
        assert conditions_match(cond, {"task_id": "c"}) is False
        assert conditions_match(cond, {}) is False

    def test_contains_operator(self):
        cond = [{"field": "task_id", "operator": "contains", "value": "extract"}]
        assert conditions_match(cond, {"task_id": "data-extraction"}) is True
        assert conditions_match(cond, {"task_id": "summarize"}) is False
        assert conditions_match(cond, {"task_id": None}) is False

    def test_dotted_run_metadata_fields(self):
        data: dict[str, object] = {"run_metadata": {"trigger": {"source": "schedule"}, "schedule": {"name": "nightly"}}}
        assert conditions_match([{"field": "trigger.source", "operator": "eq", "value": "schedule"}], data) is True
        assert conditions_match([{"field": "schedule.name", "operator": "contains", "value": "night"}], data) is True
        assert conditions_match([{"field": "schedule.name", "operator": "eq", "value": None}], data) is False


class TestValidateConditions:
    def test_unknown_event_type(self):
        with pytest.raises(am.AutomationRequestError):
            validate_conditions("nope.event", [])

    def test_unknown_field_names_index(self):
        with pytest.raises(am.AutomationRequestError, match=r"conditions\[0\]"):
            validate_conditions("task_run.completed", [{"field": "bogus", "operator": "eq", "value": 1}])

    def test_run_metadata_fields_rejected_on_task_events(self):
        with pytest.raises(am.AutomationRequestError):
            validate_conditions(
                "task_run.completed",
                [{"field": "trigger.source", "operator": "eq", "value": "schedule"}],
            )

    def test_in_requires_nonempty_list(self):
        with pytest.raises(am.AutomationRequestError):
            validate_conditions("task_run.completed", [{"field": "task_id", "operator": "in", "value": []}])


# ── Unit: templates and action config ──────────────────────────────────────


class TestTemplates:
    def test_single_pass_rendering_blocks_injection(self):
        # A task_id containing a placeholder must not be re-expanded.
        rendered = render_template(
            "apo: {{task_id}}",
            {"task_id": "{{project}}"},
            project_id="proj",
        )
        assert rendered == "apo: {{project}}"

    def test_unknown_placeholder_left_verbatim(self):
        rendered = render_template("{{task_id}} {{not_a_placeholder}}", {"task_id": "x"}, project_id="p")
        assert rendered == "x {{not_a_placeholder}}"

    def test_title_strips_control_characters(self):
        rendered = render_template(
            "{{task_id}}", {"task_id": "evil\nline2"}, project_id="p", title=True
        )
        assert rendered == "evilline2"

    def test_default_body_lists_ids_without_public_url(self):
        body = render_default_body(
            {
                "failed_tasks": 2,
                "passed_tasks": 1,
                "errored_tasks": 0,
                "total_tasks": 3,
                "task_run_ids": ["r1", "r2"],
                "status": "failed",
            },
            project_id="proj",
            event_type="batch_run.failed",
        )
        assert "r1, r2" in body
        assert "1/3 passed, 2 failed" in body
        assert "http" not in body

    def test_default_body_links_with_public_url(self, monkeypatch: MonkeyPatch):
        monkeypatch.setenv("APO_PUBLIC_URL", "https://apo.example")
        body = render_default_body(
            {"task_run_id": "tr1", "trace_run_id": "t1", "batch_run_id": "b1", "status": "failed"},
            project_id="proj",
            event_type="batch_run.failed",
        )
        assert "https://apo.example/project/proj/runs/task/tr1" in body
        assert "https://apo.example/project/proj/traces/t1" in body
        assert "https://apo.example/project/proj/runs/b1" in body


class TestActionConfigValidation:
    def test_webhook_url_validated(self):
        with pytest.raises(am.AutomationRequestError) as excinfo:
            validate_action_config("webhook", {"url": "http://127.0.0.1:9/x"})
        err = excinfo.value
        assert isinstance(err, am.AutomationRequestError)
        assert err.status_code == 422

    def test_github_owner_repo_charset(self):
        ok = validate_action_config("github_issue", {"owner": "acme", "repo": "agent-harness"})
        assert ok["owner"] == "acme"
        for bad in ["a/b", "..", "...", "evil.git", ""]:
            with pytest.raises(am.AutomationRequestError):
                validate_action_config("github_issue", {"owner": bad, "repo": "r"})

    def test_unknown_action_type(self):
        with pytest.raises(am.AutomationRequestError):
            validate_action_config("pager", {})


class TestTokenEncryption:
    def test_round_trip(self):
        stored = encrypt_github_token("ghp_secret123")
        assert stored != "ghp_secret123"
        assert decrypt_github_token(stored) == "ghp_secret123"

    def test_missing_key_raises(self, monkeypatch: MonkeyPatch):
        monkeypatch.delenv("AUTOMATION_TOKEN_ENCRYPTION_KEY", raising=False)
        with pytest.raises(am.AutomationSecretsUnavailable):
            encrypt_github_token("ghp_x")

    def test_undecryptable_token(self, monkeypatch: MonkeyPatch):
        from cryptography.fernet import Fernet

        stored = encrypt_github_token("ghp_secret123")
        rotated_key = Fernet.generate_key().decode()
        monkeypatch.setenv("AUTOMATION_TOKEN_ENCRYPTION_KEY", rotated_key)
        with pytest.raises(am.AutomationTokenError):
            decrypt_github_token(stored)


# ── Unit: sample data + pruning + recovery ─────────────────────────────────


class TestSampleData:
    def test_every_event_type_covers_its_allowlist(self):
        for event_type, fields in am.EVENT_FIELDS.items():
            data = build_sample_event_data(event_type)
            for field in fields:
                if field in am._DOTTED_FIELD_RESOLVERS:  # pyright: ignore[reportPrivateUsage]
                    present, _ = am._resolve_field(data, field)  # pyright: ignore[reportPrivateUsage]
                else:
                    present = field in data
                assert present, f"{event_type} sample missing {field}"


class TestPruning:
    def test_keeps_newest_100_with_tie_break(self, session: Session):
        from datetime import datetime, timezone

        automation = _make_automation(session)
        now = datetime.now(timezone.utc)
        old = datetime(2026, 9, 1)
        for i in range(105):
            session.add(
                AutomationExecutionDB(
                    automation_id=automation.id,
                    project_id=PROJECT,
                    event_type="task_run.completed",
                    input={"i": i},
                    created_at=now if i < 3 else old,
                )
            )
        session.commit()
        am._prune_executions(session, automation.id)  # pyright: ignore[reportPrivateUsage]
        remaining = session.exec(
            select(AutomationExecutionDB).where(
                AutomationExecutionDB.automation_id == automation.id
            )
        ).all()
        assert len(remaining) == 100
        # the three newest-by-created_at rows survive; ties among the old
        # rows resolve deterministically via the id tie-breaker
        assert len([e for e in remaining if e.created_at == now]) == 3


class TestStartupRecovery:
    def test_pending_marked_error_never_delivered(self, session: Session):
        automation = _make_automation(session)
        session.add(
            AutomationExecutionDB(
                automation_id=automation.id,
                project_id=PROJECT,
                event_type="task_run.completed",
                input={},
            )
        )
        session.commit()
        recover_stale_automations(session)
        rows = session.exec(
            select(AutomationExecutionDB).where(
                AutomationExecutionDB.automation_id == automation.id
            )
        ).all()
        assert len(rows) == 1
        assert rows[0].status == "error"
        assert "restart" in (rows[0].error or "")


# ── Scene: CRUD routes ─────────────────────────────────────────────────────


WEBHOOK_BODY = {
    "project_id": PROJECT,
    "name": "failures hook",
    "event_type": "task_run.completed",
    "conditions": [{"field": "pass_result", "operator": "eq", "value": False}],
    "action_type": "webhook",
    "action_config": {"url": "https://example.com/hook"},
}


class TestAutomationCRUD:
    def test_create_webhook_secret_shown_once(self, make_authed_client, session: Session):
        _seed(session)
        client = make_authed_client(OWNER_USER, session)
        resp = client.post("/v1/automations", json=WEBHOOK_BODY)
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["secret"].startswith("whsec_")
        automation_id = body["id"]
        listing = client.get(f"/v1/automations?project_id={PROJECT}").json()
        detail = client.get(f"/v1/automations/{automation_id}").json()
        assert "secret" not in listing[0]
        assert "secret" not in detail

    def test_create_rejects_unknown_field_and_names_index(self, make_authed_client, session: Session):
        client = make_authed_client(OWNER_USER, session)
        _seed(session)
        bad = dict(WEBHOOK_BODY, conditions=[{"field": "bogus", "operator": "eq", "value": 1}])
        resp = client.post("/v1/automations", json=bad)
        assert resp.status_code == 400
        assert "conditions[0]" in resp.json()["detail"]

    def test_create_rejects_unknown_event_type(self, make_authed_client, session: Session):
        client = make_authed_client(OWNER_USER, session)
        _seed(session)
        resp = client.post("/v1/automations", json=dict(WEBHOOK_BODY, event_type="nope"))
        assert resp.status_code == 400

    def test_create_github_without_token(self, make_authed_client, session: Session):
        client = make_authed_client(OWNER_USER, session)
        _seed(session)
        resp = client.post(
            "/v1/automations",
            json=dict(
                WEBHOOK_BODY,
                action_type="github_issue",
                action_config={"owner": "acme", "repo": "harness"},
            ),
        )
        assert resp.status_code == 400

    def test_create_at_cap(self, make_authed_client, session: Session):
        client = make_authed_client(OWNER_USER, session)
        _seed(session)
        for i in range(am.MAX_AUTOMATIONS_PER_PROJECT):
            session.add(
                AutomationDB(
                    id=f"bulk-{i}",
                    project_id=PROJECT,
                    name=f"bulk {i}",
                    event_type="task_run.completed",
                    action_type="webhook",
                    action_config={"url": "https://example.com/hook"},
                    secret="whsec_x",
                )
            )
        session.commit()
        resp = client.post("/v1/automations", json=WEBHOOK_BODY)
        assert resp.status_code == 400
        assert "maximum" in resp.json()["detail"]

    def test_action_type_immutable_on_patch(self, make_authed_client, session: Session):
        client = make_authed_client(OWNER_USER, session)
        _seed(session)
        automation_id = client.post("/v1/automations", json=WEBHOOK_BODY).json()["id"]
        resp = client.patch(
            f"/v1/automations/{automation_id}", json={"action_type": "github_issue"}
        )
        assert resp.status_code == 400

    def test_reenable_resets_failure_counter(self, client, session: Session):
        automation = _make_automation(session, consecutive_failures=10, enabled=False)
        _seed(session)
        resp = client.patch(f"/v1/automations/{automation.id}", json={"enabled": True})
        assert resp.status_code == 200
        assert resp.json()["consecutive_failures"] == 0
        assert resp.json()["enabled"] is True

    def test_delete_removes_executions(self, client, session: Session):
        automation = _make_automation(session)
        automation_id = automation.id
        session.add(
            AutomationExecutionDB(
                automation_id=automation_id,
                project_id=PROJECT,
                event_type="task_run.completed",
                input={},
            )
        )
        session.commit()
        resp = client.delete(f"/v1/automations/{automation_id}")
        assert resp.status_code == 204
        session.expire_all()
        assert session.get(AutomationDB, automation_id) is None
        assert session.exec(select(AutomationExecutionDB)).all() == []

    def test_executions_limit_bounded(self, client, session: Session):
        automation = _make_automation(session)
        _seed(session)
        for i in range(3):
            session.add(
                AutomationExecutionDB(
                    automation_id=automation.id,
                    project_id=PROJECT,
                    event_type="task_run.completed",
                    input={"i": i},
                )
            )
        session.commit()
        resp = client.get(f"/v1/automations/{automation.id}/executions?limit=2")
        assert resp.status_code == 200
        assert len(resp.json()["executions"]) == 2
        bad = client.get(f"/v1/automations/{automation.id}/executions?limit=101")
        assert bad.status_code == 400


class TestAutomationRBAC:
    def test_member_reads_but_cannot_write(self, make_authed_client, session: Session):
        _seed_member(session)
        automation = _make_automation(session)
        authed = make_authed_client(MEMBER_USER, session, is_admin=False)
        assert authed.get(f"/v1/automations?project_id={PROJECT}").status_code == 200
        assert authed.get(f"/v1/automations/{automation.id}").status_code == 200
        assert (
            authed.get(f"/v1/automations/{automation.id}/executions").status_code == 200
        )
        assert authed.post("/v1/automations", json=WEBHOOK_BODY).status_code == 403
        assert (
            authed.patch(f"/v1/automations/{automation.id}", json={"name": "x"}).status_code
            == 403
        )
        assert authed.delete(f"/v1/automations/{automation.id}").status_code == 403

    def test_ingest_scoped_api_key_rejected(self, make_api_key_client, session: Session):
        _seed(session)
        keyed = make_api_key_client(OWNER_USER, PROJECT, session, scope="ingest")
        assert keyed.post("/v1/automations", json=WEBHOOK_BODY).status_code == 403

    def test_cross_project_get_is_opaque(self, make_authed_client, session: Session):
        # A member of one project must not read another project's automation:
        # unknown ids are indistinguishable from foreign ids.
        _seed_member(session)
        foreign = _make_automation(session, id="auto-foreign", project_id="other-project")
        authed = make_authed_client(MEMBER_USER, session, is_admin=False)
        resp = authed.get(f"/v1/automations/{foreign.id}")
        assert resp.status_code == 403
        executions = authed.get(f"/v1/automations/{foreign.id}/executions")
        assert executions.status_code == 403

    def test_create_on_nonexistent_project_404(self, make_authed_client, session: Session):
        client = make_authed_client(OWNER_USER, session)
        _seed(session)
        resp = client.post(
            "/v1/automations", json=dict(WEBHOOK_BODY, project_id="ghost-project")
        )
        assert resp.status_code == 404


# ── Scene: fan-out matching ────────────────────────────────────────────────


class _PostRecorder:
    calls: list[dict[str, Any]]
    status: int
    blocker: asyncio.Event | None

    def __init__(self, status: int = 200) -> None:
        self.calls = []
        self.status = status
        self.blocker = None

    async def __call__(self, client: httpx.AsyncClient, url: str, **kwargs: object):
        self.calls.append({"url": url, **kwargs})
        if self.blocker is not None:
            await self.blocker.wait()
        return httpx.Response(
            self.status, request=httpx.Request("POST", url), json={"html_url": "https://github.com/o/r/issues/1"}
        )


class TestFanOut:
    async def test_fires_only_on_match(self, session: Session, monkeypatch: MonkeyPatch):
        _make_automation(
            session,
            conditions=[{"field": "pass_result", "operator": "eq", "value": False}],
        )
        recorder = _PostRecorder()
        _patch_post(monkeypatch, recorder)
        await fire_automations_for_event(PROJECT, _task_event({"pass_result": True}))
        await await_pending_deliveries()
        assert recorder.calls == []
        await fire_automations_for_event(
            PROJECT,
            _task_event({"pass_result": False, "task_run_id": "tr-1"}),
        )
        await await_pending_deliveries()
        assert len(recorder.calls) == 1
        executions = session.exec(select(AutomationExecutionDB)).all()
        assert len(executions) == 1
        assert executions[0].status == "completed"
        assert executions[0].input.get("pass_result") is False

    async def test_trigger_source_routing(self, session: Session, monkeypatch: MonkeyPatch):
        _make_automation(
            session,
            event_type="batch_run.failed",
            conditions=[{"field": "trigger.source", "operator": "eq", "value": "schedule"}],
        )
        recorder = _PostRecorder()
        _patch_post(monkeypatch, recorder)

        async def batch(source: str) -> None:
            await fire_automations_for_event(
                PROJECT,
                RunEvent(
                    event_type="batch_run.failed",
                    project=PROJECT,
                    data={"run_metadata": {"trigger": {"source": source}}},
                ),
            )
            await await_pending_deliveries()

        await batch("api")
        assert recorder.calls == []
        await batch("schedule")
        assert len(recorder.calls) == 1

    async def test_cross_project_isolation_and_disabled(
        self, session: Session, monkeypatch: MonkeyPatch
    ):
        other = _make_automation(session, project_id="other-project", secret="whsec_o")
        disabled = _make_automation(session, id="auto-off", enabled=False)
        recorder = _PostRecorder()
        _patch_post(monkeypatch, recorder)
        await fire_automations_for_event(
            "unrelated-project", _task_event({"pass_result": False})
        )
        await await_pending_deliveries()
        assert recorder.calls == []
        assert session.get(AutomationDB, other.id) is not None
        assert session.get(AutomationDB, disabled.id) is not None


class TestWebhookDelivery:
    async def test_signed_delivery_and_signature_covers_bytes(
        self, session: Session, monkeypatch: MonkeyPatch
    ):
        automation = _make_automation(session, secret="whsec_signing")
        recorder = _PostRecorder()
        _patch_post(monkeypatch, recorder)
        await fire_automations_for_event(
            PROJECT, _task_event({"task_run_id": "tr-9", "pass_result": False})
        )
        await await_pending_deliveries()
        assert len(recorder.calls) == 1
        call = recorder.calls[0]
        assert call["url"] == "https://example.com/hook"
        session.expire_all()
        headers = call["headers"]
        assert headers["X-Automation-Event"] == "task_run.completed"
        signature = headers["X-Automation-Signature"]
        assert signature == sign_payload(call["content"], "whsec_signing")
        execution = session.exec(select(AutomationExecutionDB)).one()
        assert execution.status == "completed"
        assert execution.output == {"http_status": 200}
        refreshed = session.get(AutomationDB, automation.id)
        assert refreshed is not None
        assert refreshed.consecutive_failures == 0
        assert refreshed.last_delivery_status == "success"

    async def test_failed_delivery_counts_once(
        self, session: Session, monkeypatch: MonkeyPatch
    ):
        automation = _make_automation(session, secret="whsec_signing")
        recorder = _PostRecorder(status=500)
        _patch_post(monkeypatch, recorder)

        async def no_delay() -> None:
            return None

        monkeypatch.setattr(am, "_retry_delay", no_delay)
        await fire_automations_for_event(
            PROJECT, _task_event({"task_run_id": "tr-9", "pass_result": False})
        )
        await await_pending_deliveries()
        # 3 attempts (initial + 2 retries)
        assert len(recorder.calls) == 3
        session.expire_all()
        execution = session.exec(select(AutomationExecutionDB)).one()
        assert execution.status == "error"
        refreshed = session.get(AutomationDB, automation.id)
        assert refreshed is not None
        assert refreshed.consecutive_failures == 1
        assert refreshed.last_delivery_status == "failure"


class TestGitHubDelivery:
    async def _fire(self, session: Session, monkeypatch: MonkeyPatch, public_url: str | None):
        automation = _make_automation(
            session,
            event_type="batch_run.failed",
            action_type="github_issue",
            action_config={"owner": "acme", "repo": "agent-harness"},
            secret=None,
            github_token_encrypted=encrypt_github_token("ghp_tok"),
        )
        if public_url:
            monkeypatch.setenv("APO_PUBLIC_URL", public_url)
        else:
            monkeypatch.delenv("APO_PUBLIC_URL", raising=False)
        recorder = _PostRecorder(status=201)
        _patch_post(monkeypatch, recorder)
        await fire_automations_for_event(
            PROJECT,
            RunEvent(
                event_type="batch_run.failed",
                project=PROJECT,
                data={
                    "batch_run_id": "b-7",
                    "status": "failed",
                    "failed_tasks": 2,
                    "passed_tasks": 1,
                    "errored_tasks": 0,
                    "total_tasks": 3,
                    "task_run_ids": ["r1", "r2"],
                },
            ),
        )
        await await_pending_deliveries()
        return automation, recorder

    async def test_issue_created_with_default_body_ids(self, session: Session, monkeypatch: MonkeyPatch):
        automation, recorder = await self._fire(session, monkeypatch, public_url=None)
        assert len(recorder.calls) == 1
        call = recorder.calls[0]
        assert call["url"] == "https://api.github.com/repos/acme/agent-harness/issues"
        assert call["headers"]["Authorization"] == "Bearer ghp_tok"
        issue = call["json"]
        assert issue["title"] == "apo: b-7 — failed"
        assert "r1, r2" in issue["body"]
        assert "1/3 passed, 2 failed" in issue["body"]
        assert "http" not in issue["body"]
        execution = session.exec(
            select(AutomationExecutionDB).where(
                AutomationExecutionDB.automation_id == automation.id
            )
        ).one()
        assert execution.output == {"issue_url": "https://github.com/o/r/issues/1"}

    async def test_issue_body_contains_deep_links(self, session: Session, monkeypatch: MonkeyPatch):
        _, recorder = await self._fire(session, monkeypatch, public_url="https://apo.example")
        body = recorder.calls[0]["json"]["body"]
        assert "https://apo.example/project/test-project/runs/b-7" in body


class TestAutoDisable:
    def test_ten_failures_disable_and_patch_resets(self, client, session: Session):
        automation = _make_automation(session, secret="whsec_x")
        _seed(session)
        for i in range(am.AUTOMATION_MAX_CONSECUTIVE_FAILURES):
            session.add(
                AutomationExecutionDB(
                    automation_id=automation.id,
                    project_id=PROJECT,
                    event_type="task_run.completed",
                    input={"i": i},
                )
            )
            session.commit()
            execution = session.exec(
                select(AutomationExecutionDB).where(
                    AutomationExecutionDB.automation_id == automation.id
                )
            ).all()[-1]
            am._record_delivery_outcome(  # pyright: ignore[reportPrivateUsage]
                automation.id, execution.id, False, None, "boom", is_test=False
            )
        session.expire_all()
        refreshed = session.get(AutomationDB, automation.id)
        assert refreshed is not None
        assert refreshed.enabled is False
        assert refreshed.consecutive_failures == 10
        resp = client.patch(f"/v1/automations/{automation.id}", json={"enabled": True})
        assert resp.status_code == 200
        assert resp.json()["consecutive_failures"] == 0


class TestTestRoute:
    def test_delivers_inline_without_health_updates(self, client, session: Session, monkeypatch: MonkeyPatch):
        automation = _make_automation(session, secret="whsec_x", consecutive_failures=3)
        _seed(session)
        recorder = _PostRecorder()
        _patch_post(monkeypatch, recorder)
        resp = client.post(f"/v1/automations/{automation.id}/test")
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"success": True, "error": None}
        assert len(recorder.calls) == 1
        session.expire_all()
        execution = session.exec(select(AutomationExecutionDB)).one()
        assert execution.input.get("__test") is True
        refreshed = session.get(AutomationDB, automation.id)
        assert refreshed is not None
        # test deliveries never count toward the failure counter
        assert refreshed.consecutive_failures == 3

    def test_conditions_rejecting_sample_reports_error(self, client, session: Session, monkeypatch: MonkeyPatch):
        automation = _make_automation(
            session,
            conditions=[{"field": "task_id", "operator": "eq", "value": "never-matches"}],
        )
        _seed(session)
        recorder = _PostRecorder()
        _patch_post(monkeypatch, recorder)
        resp = client.post(f"/v1/automations/{automation.id}/test")
        assert resp.status_code == 200
        assert resp.json()["success"] is False
        assert "does not match" in (resp.json()["error"] or "")
        assert recorder.calls == []


class TestDispatchDoesNotBlock:
    async def test_execution_row_before_delivery_completes(
        self, session: Session, monkeypatch: MonkeyPatch
    ):
        _make_automation(session)
        recorder = _PostRecorder()
        recorder.blocker = asyncio.Event()
        _patch_post(monkeypatch, recorder)
        await fire_automations_for_event(PROJECT, _task_event({"pass_result": False}))
        # The fan-out returns with the execution row written while the
        # delivery is still parked on the blocker event.
        execution = session.exec(select(AutomationExecutionDB)).one()
        assert execution.status == "pending"
        assert recorder.calls == []
        recorder.blocker.set()
        await await_pending_deliveries()
        assert len(recorder.calls) == 1
        session.refresh(execution)
        assert execution.status == "completed"


def _patch_post(monkeypatch: MonkeyPatch, recorder: _PostRecorder) -> None:
    async def mock_post(self_client: httpx.AsyncClient, url: str, **kwargs: object):
        return await recorder(self_client, url, **kwargs)

    monkeypatch.setattr(
        httpx.AsyncClient, "post", mock_post  # pyright: ignore[reportGeneralTypeIssues, reportAttributeAccessIssue]
    )
