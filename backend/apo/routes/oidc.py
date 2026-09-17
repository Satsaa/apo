# pyright: reportCallInDefaultInitializer=false, reportUnusedCallResult=false

"""Single sign-on routes.

``GET /auth/sso/config`` tells the login page which sign-in methods this
installation offers. ``POST /auth/oidc/exchange`` is where the dashboard's
Auth.js callback turns provider tokens into an apo identity — the backend
verifies them itself, so nothing the Next.js server asserts is trusted.
``POST /auth/oidc/logout`` ends every apo session of the caller and hands
back the issuer's end-session URL so the browser can sign out there too.
"""

from __future__ import annotations

import os
import time
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlmodel import Session

from ..auth import decode_nextauth_token, invalidate_user_sessions
from ..auth.client_ip import get_client_ip
from ..auth.middleware import get_session_cookie
from ..auth.oidc import (
    OidcAuthError,
    end_session_url,
    load_oidc_config,
    provision_identity,
    revalidation_clock,
    verify_login,
)
from ..auth.password_login import password_login_enabled
from ..auth.rate_limit import LoginRateLimiter
from ..db import get_session

router = APIRouter(prefix="/auth", tags=["sso"])

# The exchange verifies a signed token and calls the issuer; budget it per IP
# like the other pre-authentication endpoints so a flood cannot turn the
# backend into a UserInfo relay.
exchange_rate_limiter = LoginRateLimiter(max_attempts=30, window_seconds=60)


class OidcProviderInfo(BaseModel):
    enabled: bool
    provider_name: str | None = None


class SsoConfigResponse(BaseModel):
    oidc: OidcProviderInfo
    password_login_enabled: bool


class OidcExchangeRequest(BaseModel):
    id_token: str = Field(min_length=1)
    access_token: str = Field(min_length=1)


class OidcExchangeResponse(BaseModel):
    id: str
    email: str
    name: str
    is_admin: bool
    expires_at: int
    """Unix seconds after which the backend refuses this session regardless
    of the Auth.js cookie's own lifetime."""


class OidcLogoutResponse(BaseModel):
    end_session_url: str | None


@router.get("/sso/config")
def sso_config() -> SsoConfigResponse:
    """Which sign-in methods the login page should offer. Public."""
    config = load_oidc_config()
    return SsoConfigResponse(
        oidc=OidcProviderInfo(
            enabled=config is not None,
            provider_name=config.provider_name if config is not None else None,
        ),
        password_login_enabled=password_login_enabled(),
    )


@router.post("/oidc/exchange")
def oidc_exchange(
    body: OidcExchangeRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> OidcExchangeResponse:
    """Turn a completed provider login into an apo user. Public, rate-limited.

    Verifies the ID token against the issuer's keys and confirms the access
    token at UserInfo, refusing anyone without the required claim; then
    provisions or refreshes the account keyed on ``(issuer, subject)``.
    """
    config = load_oidc_config()
    if config is None:
        raise HTTPException(status_code=404, detail="Single sign-on is not configured")

    ip = get_client_ip(request)
    if not exchange_rate_limiter.is_allowed(ip):
        raise HTTPException(
            status_code=429,
            detail="Too many sign-in attempts. Please try again later.",
            headers={"Retry-After": str(exchange_rate_limiter.get_retry_after(ip))},
        )
    exchange_rate_limiter.record_attempt(ip)

    try:
        identity = verify_login(body.id_token, body.access_token, config)
        user = provision_identity(session, identity, config)
    except OidcAuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from None

    # The provider just confirmed this person; the first periodic
    # re-check is one interval away, not on the next request.
    revalidation_clock.confirm(user.id, body.access_token)
    exp = identity.claims.get("exp")
    token_expiry = int(exp) if isinstance(exp, (int, float)) else 0
    session_cap = int(time.time()) + config.session_max_age_seconds
    return OidcExchangeResponse(
        id=user.id,
        email=user.email,
        name=user.name,
        is_admin=user.is_admin,
        expires_at=min(token_expiry, session_cap) if token_expiry > 0 else session_cap,
    )


@router.post("/oidc/logout")
def oidc_logout(
    request: Request,
    session: Session = Depends(get_session),
) -> OidcLogoutResponse:
    """End the caller's apo sessions and name the issuer's end-session URL.

    Cookie-authenticated. Invalidating server-side means a copied cookie
    stops working immediately rather than at its own expiry.
    """
    user_id = cast(str | None, getattr(request.state, "user_id", None))
    if not user_id or getattr(request.state, "auth_method", None) != "cookie":
        raise HTTPException(status_code=401, detail="Authentication required")

    invalidate_user_sessions(session, user_id)
    revalidation_clock.forget(user_id)

    config = load_oidc_config()
    if config is None:
        return OidcLogoutResponse(end_session_url=None)

    id_token: str | None = None
    cookie = get_session_cookie(request)
    if cookie:
        payload = decode_nextauth_token(cookie)
        if payload is not None:
            hint = payload.get("oidc_id_token")
            if isinstance(hint, str) and hint:
                id_token = hint
    # The bare origin, not a page: providers register post-logout URIs exactly,
    # and an origin is what a relying party can be expected to have registered.
    frontend_url = os.environ.get("FRONTEND_URL", "http://localhost:3000").rstrip("/")
    return OidcLogoutResponse(
        end_session_url=end_session_url(config, id_token, frontend_url)
    )
