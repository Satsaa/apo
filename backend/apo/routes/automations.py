"""Automation CRUD routes: create, list, get, patch, delete, rotate-secret, test, executions."""

# pyright: reportAny=false, reportArgumentType=false, reportCallInDefaultInitializer=false, reportImplicitStringConcatenation=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedImport=false

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from typing import cast

from sqlalchemy import delete as sa_delete
from sqlmodel import Session, col, select

from ..db_helpers import as_column

from ..auth.deps import get_user_id, require_api_key_scope
from ..db import get_session
from ..models.db import AutomationDB, AutomationExecutionDB
from ..services.automations import (
    ACTION_GITHUB_ISSUE,
    ACTION_WEBHOOK,
    MAX_AUTOMATIONS_PER_PROJECT,
    AutomationRequestError,
    AutomationSecretsUnavailable,
    deliver_test_event,
    encrypt_github_token,
    validate_action_config,
    validate_conditions,
    validate_event_type,
)
from ..services.demo_workspace import require_project_not_demo
from ..services.project_memberships import (
    enforce_project_role_from_request,
    require_project_role_strict,
)
from ..services.webhook_delivery import generate_secret

router = APIRouter(prefix="/v1/automations", tags=["automations"])


class AutomationCreate(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=100)
    description: str | None = None
    event_type: str
    conditions: list[dict[str, object]] = Field(default_factory=list)
    action_type: str
    action_config: dict[str, object]
    github_token: str | None = None


class AutomationUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
    event_type: str | None = None
    conditions: list[dict[str, object]] | None = None
    action_type: str | None = None
    action_config: dict[str, object] | None = None
    enabled: bool | None = None
    github_token: str | None = None


class AutomationResponse(BaseModel):
    id: str
    project_id: str
    name: str
    description: str | None
    event_type: str
    conditions: list[dict[str, object]]
    action_type: str
    action_config: dict[str, object]
    enabled: bool
    consecutive_failures: int
    last_delivery_at: datetime | None
    last_delivery_status: str | None
    created_at: datetime
    updated_at: datetime


class AutomationCreateResponse(AutomationResponse):
    # Present only for webhook actions: the one-time display of the signing
    # secret, mirrored from the create/rotate response only.
    secret: str | None = None


class AutomationSecretResponse(BaseModel):
    id: str
    secret: str


class AutomationTestResponse(BaseModel):
    success: bool
    error: str | None = None


class AutomationExecutionResponse(BaseModel):
    id: str
    event_type: str
    status: str
    input: dict[str, object]
    output: dict[str, object] | None
    error: str | None
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime


class AutomationExecutionPage(BaseModel):
    executions: list[AutomationExecutionResponse]


def _to_response(automation: AutomationDB) -> AutomationResponse:
    return AutomationResponse(
        id=automation.id,
        project_id=automation.project_id,
        name=automation.name,
        description=automation.description,
        event_type=automation.event_type,
        conditions=automation.conditions or [],
        action_type=automation.action_type,
        action_config=automation.action_config or {},
        enabled=automation.enabled,
        consecutive_failures=automation.consecutive_failures,
        last_delivery_at=automation.last_delivery_at,
        last_delivery_status=automation.last_delivery_status,
        created_at=automation.created_at,
        updated_at=automation.updated_at,
    )


def _get_automation_or_404(automation_id: str, session: Session) -> AutomationDB:
    automation = session.get(AutomationDB, automation_id)
    if automation is None:
        raise HTTPException(status_code=404, detail="Automation not found")
    return automation


def _map_automation_error(
    exc: AutomationRequestError | AutomationSecretsUnavailable,
) -> HTTPException:
    if isinstance(exc, AutomationRequestError):
        return HTTPException(status_code=exc.status_code, detail=exc.message)
    return HTTPException(status_code=503, detail=str(exc))


@router.post("", response_model=AutomationCreateResponse, status_code=201)
def create_automation(
    body: AutomationCreate,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """Create an automation. Project admin only; demo excluded.

    Webhook actions get a server-generated signing secret, shown once in this
    response. github_issue actions require a GitHub token, encrypted at rest.
    """
    require_project_not_demo(body.project_id)
    # Strict variant: a nonexistent project id must be a 404, not a mint.
    _ = require_project_role_strict(
        session,
        body.project_id,
        get_user_id(request),
        minimum_role="admin",
    )
    try:
        validate_event_type(body.event_type)
        validate_conditions(body.event_type, body.conditions)
        action_config = validate_action_config(body.action_type, body.action_config)
    except (AutomationRequestError, AutomationSecretsUnavailable) as exc:
        raise _map_automation_error(exc) from exc

    existing = session.exec(
        select(AutomationDB).where(
            col(AutomationDB.project_id) == body.project_id
        )
    ).all()
    if len(existing) >= MAX_AUTOMATIONS_PER_PROJECT:
        raise HTTPException(
            status_code=400,
            detail=f"Project already has the maximum of "
            f"{MAX_AUTOMATIONS_PER_PROJECT} automations",
        )

    secret: str | None = None
    github_token_encrypted: str | None = None
    if body.action_type == ACTION_WEBHOOK:
        secret = generate_secret()
    elif body.action_type == ACTION_GITHUB_ISSUE:
        if not body.github_token:
            raise HTTPException(
                status_code=400,
                detail="github_token is required for github_issue automations",
            )
        try:
            github_token_encrypted = encrypt_github_token(body.github_token)
        except AutomationSecretsUnavailable as exc:
            raise _map_automation_error(exc) from exc

    automation = AutomationDB(
        project_id=body.project_id,
        name=body.name,
        description=body.description,
        event_type=body.event_type,
        conditions=body.conditions,
        action_type=body.action_type,
        action_config=action_config,
        secret=secret,
        github_token_encrypted=github_token_encrypted,
    )
    session.add(automation)
    session.commit()
    session.refresh(automation)
    response = AutomationCreateResponse(**_to_response(automation).model_dump())
    response.secret = secret
    return response


@router.get("", response_model=list[AutomationResponse])
def list_automations(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """List a project's automations (never any secrets). Viewer-readable."""
    _ = enforce_project_role_from_request(
        request, session, project_id, minimum_role="viewer"
    )
    automations = session.exec(
        select(AutomationDB)
        .where(col(AutomationDB.project_id) == project_id)
        .order_by(as_column(cast(object, AutomationDB.created_at)).desc())
    ).all()
    return [_to_response(a) for a in automations]


@router.get("/{automation_id}", response_model=AutomationResponse)
def get_automation(
    automation_id: str,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """Return one automation's configuration (never its secrets)."""
    automation = _get_automation_or_404(automation_id, session)
    _ = enforce_project_role_from_request(
        request, session, automation.project_id, minimum_role="viewer"
    )
    return _to_response(automation)


@router.patch("/{automation_id}", response_model=AutomationResponse)
def update_automation(
    automation_id: str,
    body: AutomationUpdate,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """Patch an automation. Project admin only; demo excluded.

    action_type is immutable — delete and recreate to switch actions.
    Re-enabling (enabled=true) resets the failure counter.
    """
    automation = _get_automation_or_404(automation_id, session)
    require_project_not_demo(automation.project_id)
    _ = enforce_project_role_from_request(
        request, session, automation.project_id, minimum_role="admin"
    )

    if body.action_type is not None and body.action_type != automation.action_type:
        raise HTTPException(
            status_code=400,
            detail="action_type is immutable; create a new automation instead",
        )

    event_type = body.event_type or automation.event_type
    conditions = body.conditions
    if conditions is None:
        conditions = automation.conditions or []
    try:
        if body.event_type is not None:
            validate_event_type(event_type)
        validate_conditions(event_type, conditions)
        action_config = (
            validate_action_config(automation.action_type, body.action_config)
            if body.action_config is not None
            else automation.action_config
        )
    except (AutomationRequestError, AutomationSecretsUnavailable) as exc:
        raise _map_automation_error(exc) from exc

    if body.name is not None:
        automation.name = body.name
    if body.description is not None:
        automation.description = body.description
    if body.event_type is not None:
        automation.event_type = event_type
    if body.conditions is not None:
        automation.conditions = conditions
    if body.action_config is not None:
        automation.action_config = action_config
    if body.enabled is not None:
        automation.enabled = body.enabled
        if body.enabled:
            # Re-enabling is a human "I fixed it" signal: start the
            # auto-disable counter fresh instead of staying poisoned at the
            # threshold.
            automation.consecutive_failures = 0
    if body.github_token is not None and body.github_token != "":
        try:
            automation.github_token_encrypted = encrypt_github_token(
                body.github_token
            )
        except AutomationSecretsUnavailable as exc:
            raise _map_automation_error(exc) from exc

    session.add(automation)
    session.commit()
    session.refresh(automation)
    return _to_response(automation)


@router.delete("/{automation_id}", status_code=204)
def delete_automation(
    automation_id: str,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """Delete an automation and its execution log. Project admin only."""
    automation = _get_automation_or_404(automation_id, session)
    require_project_not_demo(automation.project_id)
    _ = enforce_project_role_from_request(
        request, session, automation.project_id, minimum_role="admin"
    )
    # Executions must be gone before the automation row: the FK is enforced
    # immediately, and SQLAlchemy's unit of work does not order bulk deletes
    # ahead of the parent delete in one flush.
    session.exec(
        sa_delete(AutomationExecutionDB).where(
            col(AutomationExecutionDB.automation_id) == automation_id
        )
    )
    session.commit()
    session.delete(automation)
    session.commit()


@router.post("/{automation_id}/rotate-secret", response_model=AutomationSecretResponse)
def rotate_secret(
    automation_id: str,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """Replace the webhook action's signing secret; shown once."""
    automation = _get_automation_or_404(automation_id, session)
    require_project_not_demo(automation.project_id)
    _ = enforce_project_role_from_request(
        request, session, automation.project_id, minimum_role="admin"
    )
    if automation.action_type != ACTION_WEBHOOK:
        raise HTTPException(
            status_code=400,
            detail="Only webhook automations have a signing secret to rotate",
        )
    automation.secret = generate_secret()
    session.add(automation)
    session.commit()
    session.refresh(automation)
    assert automation.secret is not None
    return AutomationSecretResponse(id=automation.id, secret=automation.secret)


@router.post("/{automation_id}/test", response_model=AutomationTestResponse)
async def test_automation(
    automation_id: str,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """Deliver a synthetic event through the automation and report the result.

    Awaits delivery inline so the response reflects the real outcome. On
    github_issue automations this creates a real issue in the configured repo.
    Test deliveries never count toward the failure counter.
    """
    automation = _get_automation_or_404(automation_id, session)
    require_project_not_demo(automation.project_id)
    _ = enforce_project_role_from_request(
        request, session, automation.project_id, minimum_role="admin"
    )
    success, error = await deliver_test_event(automation, session)
    return AutomationTestResponse(success=success, error=error)


@router.get("/{automation_id}/executions", response_model=AutomationExecutionPage)
def list_executions(
    automation_id: str,
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
    limit: int = 50,
):
    """List an automation's execution log, newest first (capped at 100)."""
    automation = _get_automation_or_404(automation_id, session)
    _ = enforce_project_role_from_request(
        request, session, automation.project_id, minimum_role="viewer"
    )
    if limit < 1 or limit > 100:
        raise HTTPException(
            status_code=400, detail="limit must be between 1 and 100"
        )
    executions = session.exec(
        select(AutomationExecutionDB)
        .where(col(AutomationExecutionDB.automation_id) == automation_id)
        .order_by(
            as_column(cast(object, AutomationExecutionDB.created_at)).desc(),
            as_column(cast(object, AutomationExecutionDB.id)).desc(),
        )
        .limit(limit)
    ).all()
    return AutomationExecutionPage(
        executions=[
            AutomationExecutionResponse(
                id=e.id,
                event_type=e.event_type,
                status=e.status,
                input=e.input or {},
                output=e.output,
                error=e.error,
                started_at=e.started_at,
                finished_at=e.finished_at,
                created_at=e.created_at,
            )
            for e in executions
        ]
    )
