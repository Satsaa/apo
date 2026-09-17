"""Dev sign-in endpoints.

One-click dashboard access for AI agents (and local developers) on
deployments that opt in. ``GET /auth/dev-signin/available`` tells the login
page whether to render the "Sign in as dev" button; ``POST /auth/dev-signin``
provisions the dev workspace (see ``services/dev_workspace``) and returns the
same user payload shape ``/auth/verify-password`` produces, plus the landing
path the dashboard should navigate to after sign-in.

Both endpoints are public paths — the ``DEV_SIGNIN_ENABLED`` / deployment
profile gate is the credential, and it is enforced here in the backend, not
in the UI. Outside the gate both endpoints 404, so the button never renders
and the marker password carries no authority.
"""

# pyright: reportCallInDefaultInitializer=false

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from ..auth.password_login import password_login_enabled, require_password_login_enabled
from ..db import get_session
from ..services.dev_workspace import (
    dev_landing_path,
    dev_project_id,
    ensure_dev_workspace,
    is_dev_signin_enabled,
)

router = APIRouter(tags=["auth"])


class DevSigninAvailableResponse(BaseModel):
    enabled: bool
    landing_path: str | None
    project_id: str | None


class DevSigninResponse(BaseModel):
    id: str
    email: str
    name: str
    is_admin: bool
    landing_path: str


@router.get("/auth/dev-signin/available")
async def dev_signin_available() -> DevSigninAvailableResponse:
    """Report whether dev sign-in is enabled, for login-page rendering."""
    if not is_dev_signin_enabled() or not password_login_enabled():
        return DevSigninAvailableResponse(
            enabled=False, landing_path=None, project_id=None
        )
    return DevSigninAvailableResponse(
        enabled=True,
        landing_path=dev_landing_path(),
        project_id=dev_project_id(),
    )


@router.post("/auth/dev-signin")
async def dev_signin(
    session: Session = Depends(get_session),
) -> DevSigninResponse:
    """Provision (idempotently) and return the dev user for a browser session."""
    if not is_dev_signin_enabled():
        raise HTTPException(status_code=404, detail="Dev sign-in is not enabled")
    # A dev session is a password-less local login; on an SSO-only installation
    # it would be a session the provider never checks.
    require_password_login_enabled()

    user = ensure_dev_workspace(session)
    return DevSigninResponse(
        id=user.id,
        email=user.email,
        name=user.name,
        is_admin=user.is_admin,
        landing_path=dev_landing_path(),
    )
