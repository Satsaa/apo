# pyright: reportCallInDefaultInitializer=false, reportUnusedCallResult=false

"""Hosted access invitation routes.

Two explicitly separated route groups on one router:

- **administrator** endpoints under ``/v1/admin/hosted-access-invitations``
  — list, issue, resend, revoke. Guarded by
  ``require_installation_admin`` (browser-session authority only).
- **admission** endpoints under ``/auth/hosted-access`` — public token
  preview and new-account acceptance (bearer token authority, added to
  ``AuthMiddleware.PUBLIC_PATHS``), plus existing-account acceptance
  which requires an authenticated session before the route runs.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlmodel import Session

from ..auth.client_ip import get_client_ip
from ..auth.password_login import require_password_login_enabled
from ..auth.rate_limit import LoginRateLimiter
from ..db import get_session
from ..models.schemas import (
    AcceptHostedAccessCreateAccountRequest,
    AcceptHostedAccessExistingAccountRequest,
    AcceptHostedAccessResponse,
    CreateHostedAccessInvitationRequest,
    CreateHostedAccessInvitationResponse,
    HostedAccessInvitationPreview,
    HostedAccessInvitationSummary,
)
from ..services.hosted_access_invitations import (
    accept_hosted_access_create_account,
    accept_hosted_access_existing_account,
    create_or_refresh_hosted_access_invitation,
    list_hosted_access_invitations,
    preview_hosted_access_invitation,
    resend_hosted_access_invitation,
    revoke_hosted_access_invitation,
)
from ..services.installation_admin import require_installation_admin

router = APIRouter(tags=["hosted-access"])

# Public admission endpoints are bearer-capability probes; rate-limit
# them per IP like the other pre-authentication endpoints.
hosted_access_rate_limiter = LoginRateLimiter(max_attempts=30, window_seconds=60)


def _enforce_public_rate_limit(request: Request) -> None:
    ip = get_client_ip(request)
    if not hosted_access_rate_limiter.is_allowed(ip):
        retry_after = hosted_access_rate_limiter.get_retry_after(ip)
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please try again later.",
            headers={"Retry-After": str(retry_after)},
        )
    hosted_access_rate_limiter.record_attempt(ip)


# ---------------------------------------------------------------------------
# Administrator endpoints
# ---------------------------------------------------------------------------


@router.get("/v1/admin/hosted-access-invitations")
def list_invitations(
    request: Request,
    session: Session = Depends(get_session),
) -> list[HostedAccessInvitationSummary]:
    """List every hosted access invitation (newest first).

    Includes expired, revoked, and accepted rows for auditing; the
    summary carries acceptance state. Installation Administrator only.
    """
    _ = require_installation_admin(request, session)
    return list_hosted_access_invitations(session)


@router.post(
    "/v1/admin/hosted-access-invitations",
    status_code=201,
)
async def create_invitation(
    body: CreateHostedAccessInvitationRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> CreateHostedAccessInvitationResponse:
    """Invite one person to this apo installation.

    Creates no User, Project, or membership. When email delivery is not
    configured the response carries a one-time ``invite_url`` to share
    out-of-band. Re-inviting the same email rotates the active
    invitation in place.
    """
    admin = require_installation_admin(request, session)
    return await create_or_refresh_hosted_access_invitation(
        session, email=body.email, invited_by_user_id=admin.id
    )


@router.post(
    "/v1/admin/hosted-access-invitations/{invitation_id}/resend",
)
async def resend_invitation(
    invitation_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> CreateHostedAccessInvitationResponse:
    """Rotate an invitation's token and expiry, then re-attempt delivery.

    The previous token stops working immediately.
    """
    _ = require_installation_admin(request, session)
    return await resend_hosted_access_invitation(
        session, invitation_id=invitation_id
    )


@router.delete("/v1/admin/hosted-access-invitations/{invitation_id}", status_code=204)
def revoke_invitation(
    invitation_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> Response:
    """Revoke an invitation. Idempotent; the token stops working immediately."""
    _ = require_installation_admin(request, session)
    revoke_hosted_access_invitation(session, invitation_id=invitation_id)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Admission endpoints (public bearer token / authenticated session)
# ---------------------------------------------------------------------------


@router.get("/auth/hosted-access/preview")
def preview_invitation(
    request: Request,
    token: str = Query(...),
    session: Session = Depends(get_session),
) -> HostedAccessInvitationPreview:
    """Public preview of an admission token.

    Distinguishes invalid/expired/revoked/accepted without revealing the
    invited email for anything but a valid, active invitation.
    """
    _enforce_public_rate_limit(request)
    return preview_hosted_access_invitation(session, token)


@router.post("/auth/hosted-access/accept/create-account")
async def accept_create_account(
    body: AcceptHostedAccessCreateAccountRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> AcceptHostedAccessResponse:
    """Accept an admission by creating the invited User and their Project.

    The bearer token alone is the authority (no session yet). Atomic:
    User, Project, owner membership, and invitation consumption commit
    together or not at all. Single-use; replays are rejected.
    """
    require_password_login_enabled()
    _enforce_public_rate_limit(request)
    return accept_hosted_access_create_account(
        session,
        raw_token=body.token,
        name=body.name,
        password=body.password,
        project_name=body.project_name,
    )


@router.post("/auth/hosted-access/accept/existing-account")
async def accept_existing_account(
    body: AcceptHostedAccessExistingAccountRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> AcceptHostedAccessResponse:
    """Accept an admission while signed in as the invited User.

    Requires an authenticated session whose email matches the
    invitation; a mismatch is a 409 that consumes nothing.
    """
    user_id = getattr(request.state, "user_id", None)
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")
    return accept_hosted_access_existing_account(
        session,
        raw_token=body.token,
        accepting_user_id=user_id,
        project_name=body.project_name,
    )
