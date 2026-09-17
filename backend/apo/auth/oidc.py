"""OpenID Connect single sign-on: configuration, token verification and
identity provisioning.

The dashboard's Auth.js provider completes the authorization-code flow and
then hands the ID and access tokens to ``POST /auth/oidc/exchange``. Nothing
the browser or the Next.js server asserts about the person is trusted: the
backend re-verifies the ID token against the issuer's published keys, calls
UserInfo with the access token, and only then provisions or refreshes the
apo identity keyed on the verified ``(issuer, subject)`` pair.

Configuration is environment-driven so any standards-compliant provider can
be used without patching:

``AUTH_OIDC_ISSUER``              issuer URL (discovery is fetched from it)
``AUTH_OIDC_CLIENT_ID``           the client registered at the issuer
``AUTH_OIDC_CLIENT_SECRET``       optional; omit for a public PKCE client
``AUTH_OIDC_PROVIDER_NAME``       the button label ("Sign in with <name>")
``AUTH_OIDC_REQUIRED_CLAIM``      claim that must be present (default ``roles``)
``AUTH_OIDC_REQUIRED_CLAIM_VALUE``value the claim must equal or contain
``AUTH_OIDC_PROJECT_ID``          the project every authorized user joins
``AUTH_OIDC_PROJECT_NAME``        its display name when first created
``AUTH_OIDC_PROJECT_ROLE``        the membership granted (default ``admin``)
``AUTH_OIDC_REVALIDATE_SECONDS``  how often a live session re-checks UserInfo
``AUTH_OIDC_SESSION_MAX_AGE_SECONDS`` upper bound on an SSO session
"""

# pyright: reportAny=false, reportExplicitAny=false

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Final, Literal, cast
from urllib.parse import urlencode

import httpx
from jose import JWTError, jwt
from sqlmodel import Session, select

from ..models.db import OidcIdentityDB, ProjectDB, ProjectMembershipDB, UserDB

logger = logging.getLogger(__name__)

# Non-bcrypt marker stored as the password hash of SSO-provisioned users.
# ``verify_password`` refuses anything that is not a bcrypt hash, so this
# can never satisfy a password check; it differs from the demo fixture's
# ``"!"`` so these rows still count as real accounts for installation
# initialization.
SSO_PASSWORD_HASH: Final = "!sso"

SsoProjectRole = Literal["viewer", "member", "admin"]
_VALID_PROJECT_ROLES: Final[frozenset[str]] = frozenset({"viewer", "member", "admin"})
_ROLE_RANK: Final[dict[str, int]] = {"viewer": 0, "member": 1, "admin": 2, "owner": 3}

_DEFAULT_REVALIDATE_SECONDS: Final = 300
_DEFAULT_SESSION_MAX_AGE_SECONDS: Final = 60 * 60
_DISCOVERY_TTL_SECONDS: Final = 60 * 60
_HTTP_TIMEOUT_SECONDS: Final = 10.0
_ALLOWED_ALGORITHMS: Final = ("RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256")


class OidcConfigError(RuntimeError):
    """Invalid SSO configuration. Never includes secret values."""

    def __init__(self, message: str, *, variable: str) -> None:
        super().__init__(message)
        self.variable = variable


class OidcAuthError(Exception):
    """A verified-identity failure the caller turns into an HTTP refusal."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class OidcConfig:
    issuer: str
    client_id: str
    client_secret: str | None
    provider_name: str
    required_claim: str | None
    required_claim_value: str | None
    project_id: str
    project_name: str
    project_role: SsoProjectRole
    revalidate_seconds: int
    session_max_age_seconds: int


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def _positive_int_env(name: str, default: int) -> int:
    raw = _env(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise OidcConfigError(f"{name} must be a positive integer", variable=name) from None
    if value <= 0:
        raise OidcConfigError(f"{name} must be a positive integer", variable=name)
    return value


def load_oidc_config() -> OidcConfig | None:
    """Parse the ``AUTH_OIDC_*`` variables; ``None`` when SSO is not configured.

    Raises :class:`OidcConfigError` for a partial or invalid configuration so a
    misconfigured installation fails at startup rather than at first login.
    """
    issuer = _env("AUTH_OIDC_ISSUER").rstrip("/")
    client_id = _env("AUTH_OIDC_CLIENT_ID")
    if not issuer and not client_id:
        return None
    if not issuer.startswith("https://") and not issuer.startswith("http://"):
        raise OidcConfigError(
            "AUTH_OIDC_ISSUER must be an http(s) URL", variable="AUTH_OIDC_ISSUER"
        )
    if not client_id:
        raise OidcConfigError(
            "AUTH_OIDC_CLIENT_ID is required when AUTH_OIDC_ISSUER is set",
            variable="AUTH_OIDC_CLIENT_ID",
        )
    role = _env("AUTH_OIDC_PROJECT_ROLE").lower() or "admin"
    if role not in _VALID_PROJECT_ROLES:
        raise OidcConfigError(
            "AUTH_OIDC_PROJECT_ROLE must be viewer, member or admin",
            variable="AUTH_OIDC_PROJECT_ROLE",
        )
    required_claim = _env("AUTH_OIDC_REQUIRED_CLAIM") or "roles"
    required_value = _env("AUTH_OIDC_REQUIRED_CLAIM_VALUE") or None
    return OidcConfig(
        issuer=issuer,
        client_id=client_id,
        client_secret=_env("AUTH_OIDC_CLIENT_SECRET") or None,
        provider_name=_env("AUTH_OIDC_PROVIDER_NAME") or "Single sign-on",
        required_claim=required_claim if required_value else None,
        required_claim_value=required_value,
        project_id=_env("AUTH_OIDC_PROJECT_ID") or "sso",
        project_name=_env("AUTH_OIDC_PROJECT_NAME") or "Single sign-on",
        project_role=cast(SsoProjectRole, role),
        revalidate_seconds=_positive_int_env(
            "AUTH_OIDC_REVALIDATE_SECONDS", _DEFAULT_REVALIDATE_SECONDS
        ),
        session_max_age_seconds=_positive_int_env(
            "AUTH_OIDC_SESSION_MAX_AGE_SECONDS", _DEFAULT_SESSION_MAX_AGE_SECONDS
        ),
    )


def oidc_enabled() -> bool:
    return load_oidc_config() is not None


# ---------------------------------------------------------------------------
# Issuer metadata
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IssuerMetadata:
    issuer: str
    jwks_uri: str
    userinfo_endpoint: str | None
    end_session_endpoint: str | None


class _IssuerClient:
    """Discovery document and JWKS, cached per issuer with a bounded TTL."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._metadata: dict[str, tuple[float, IssuerMetadata]] = {}
        self._jwks: dict[str, tuple[float, dict[str, object]]] = {}

    def metadata(self, issuer: str) -> IssuerMetadata:
        now = time.monotonic()
        with self._lock:
            cached = self._metadata.get(issuer)
            if cached and cached[0] > now:
                return cached[1]
        document = self._get_json(f"{issuer}/.well-known/openid-configuration")
        advertised = document.get("issuer")
        if advertised != issuer:
            raise OidcAuthError(502, "Issuer discovery document names a different issuer")
        jwks_uri = document.get("jwks_uri")
        if not isinstance(jwks_uri, str) or not jwks_uri:
            raise OidcAuthError(502, "Issuer discovery document has no jwks_uri")
        userinfo = document.get("userinfo_endpoint")
        end_session = document.get("end_session_endpoint")
        metadata = IssuerMetadata(
            issuer=issuer,
            jwks_uri=jwks_uri,
            userinfo_endpoint=userinfo if isinstance(userinfo, str) else None,
            end_session_endpoint=end_session if isinstance(end_session, str) else None,
        )
        with self._lock:
            self._metadata[issuer] = (now + _DISCOVERY_TTL_SECONDS, metadata)
        return metadata

    def jwks(self, issuer: str, *, force_refresh: bool = False) -> dict[str, object]:
        now = time.monotonic()
        if not force_refresh:
            with self._lock:
                cached = self._jwks.get(issuer)
                if cached and cached[0] > now:
                    return cached[1]
        keys = self._get_json(self.metadata(issuer).jwks_uri)
        with self._lock:
            self._jwks[issuer] = (now + _DISCOVERY_TTL_SECONDS, keys)
        return keys

    def userinfo(self, issuer: str, access_token: str) -> dict[str, object]:
        endpoint = self.metadata(issuer).userinfo_endpoint
        if endpoint is None:
            raise OidcAuthError(502, "Issuer publishes no userinfo endpoint")
        try:
            response = httpx.get(
                endpoint,
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=_HTTP_TIMEOUT_SECONDS,
            )
        except httpx.HTTPError as exc:
            raise OidcAuthError(502, "Identity provider unavailable") from exc
        if response.status_code in (401, 403):
            raise OidcAuthError(401, "Identity provider rejected the access token")
        if response.status_code != 200:
            raise OidcAuthError(502, "Identity provider returned an unexpected status")
        body = response.json()
        if not isinstance(body, dict):
            raise OidcAuthError(502, "Identity provider returned a malformed userinfo response")
        return cast(dict[str, object], body)

    def reset(self) -> None:
        with self._lock:
            self._metadata.clear()
            self._jwks.clear()

    @staticmethod
    def _get_json(url: str) -> dict[str, object]:
        try:
            response = httpx.get(url, timeout=_HTTP_TIMEOUT_SECONDS)
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise OidcAuthError(502, "Identity provider unavailable") from exc
        if not isinstance(body, dict):
            raise OidcAuthError(502, "Identity provider returned a malformed document")
        return cast(dict[str, object], body)


issuer_client = _IssuerClient()


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VerifiedIdentity:
    issuer: str
    subject: str
    email: str | None
    email_verified: bool
    name: str
    claims: dict[str, object]


def _claim_satisfied(claims: dict[str, object], config: OidcConfig) -> bool:
    if config.required_claim is None or config.required_claim_value is None:
        return True
    value = claims.get(config.required_claim)
    if isinstance(value, list):
        return config.required_claim_value in cast(list[object], value)
    return value == config.required_claim_value


def _decode_id_token(id_token: str, config: OidcConfig) -> dict[str, object]:
    try:
        header = jwt.get_unverified_header(id_token)
    except JWTError as exc:
        raise OidcAuthError(401, "Malformed ID token") from exc
    kid = header.get("kid")
    keys = issuer_client.jwks(config.issuer)
    known = {k.get("kid") for k in cast(list[dict[str, object]], keys.get("keys", []))}
    if kid is not None and kid not in known:
        keys = issuer_client.jwks(config.issuer, force_refresh=True)
    try:
        claims = jwt.decode(
            id_token,
            keys,
            algorithms=list(_ALLOWED_ALGORITHMS),
            audience=config.client_id,
            issuer=config.issuer,
            options={"require_exp": True, "require_iat": True, "require_sub": True},
        )
    except JWTError as exc:
        raise OidcAuthError(401, "ID token verification failed") from exc
    return cast(dict[str, object], claims)


def verify_login(id_token: str, access_token: str, config: OidcConfig) -> VerifiedIdentity:
    """Verify an ID token and confirm it with UserInfo; refuse an unauthorized person.

    UserInfo is the authority for the role claim because it is answered by
    the issuer at the moment of the call; the ID token only proves who the
    access token belongs to.
    """
    id_claims = _decode_id_token(id_token, config)
    subject = id_claims.get("sub")
    if not isinstance(subject, str) or not subject:
        raise OidcAuthError(401, "ID token has no subject")
    info = issuer_client.userinfo(config.issuer, access_token)
    if info.get("sub") != subject:
        raise OidcAuthError(401, "UserInfo subject does not match the ID token")
    claims: dict[str, object] = {**id_claims, **info}
    if not _claim_satisfied(claims, config):
        raise OidcAuthError(403, "Your account is not authorized to use this installation")
    email = claims.get("email")
    name = claims.get("name")
    return VerifiedIdentity(
        issuer=config.issuer,
        subject=subject,
        email=email.strip().lower() if isinstance(email, str) and email.strip() else None,
        email_verified=claims.get("email_verified") is True,
        name=name.strip() if isinstance(name, str) else "",
        claims=claims,
    )


def revalidate_access(access_token: str, expected_subject: str, config: OidcConfig) -> None:
    """Confirm a live session's access token still names an authorized person."""
    info = issuer_client.userinfo(config.issuer, access_token)
    if info.get("sub") != expected_subject:
        raise OidcAuthError(401, "UserInfo subject changed")
    if not _claim_satisfied(info, config):
        raise OidcAuthError(403, "Your account is no longer authorized to use this installation")


# ---------------------------------------------------------------------------
# Provisioning
# ---------------------------------------------------------------------------


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def find_identity(session: Session, issuer: str, subject: str) -> OidcIdentityDB | None:
    return session.exec(
        select(OidcIdentityDB).where(
            OidcIdentityDB.issuer == issuer, OidcIdentityDB.subject == subject
        )
    ).first()


def identity_for_user(session: Session, user_id: str) -> OidcIdentityDB | None:
    return session.exec(select(OidcIdentityDB).where(OidcIdentityDB.user_id == user_id)).first()


def _placeholder_email(identity: VerifiedIdentity) -> str:
    return f"{identity.subject}@{_hostname(identity.issuer)}.sso.invalid"


def _hostname(issuer: str) -> str:
    return issuer.split("//", 1)[-1].split("/", 1)[0].replace(":", "-")


def _ensure_project(session: Session, config: OidcConfig, user: UserDB) -> bool:
    """Create the SSO project on first use; ``True`` when this user became its owner."""
    if session.get(ProjectDB, config.project_id) is not None:
        return False
    project = ProjectDB(id=config.project_id, name=config.project_name, created_by=user.id)
    session.add(project)
    now = _utcnow()
    session.add(
        ProjectMembershipDB(
            project_id=project.id, user_id=user.id, role="owner", created_at=now, updated_at=now
        )
    )
    session.commit()
    from ..services.bundled_executor import bundled_executor_enabled, ensure_bundled_pool

    if bundled_executor_enabled():
        _ = ensure_bundled_pool(session, project_id=project.id)
    return True


def _ensure_membership(session: Session, config: OidcConfig, user: UserDB) -> None:
    """Grant the configured role, raising a lower one but never lowering or touching an owner."""
    membership = session.exec(
        select(ProjectMembershipDB).where(
            ProjectMembershipDB.project_id == config.project_id,
            ProjectMembershipDB.user_id == user.id,
        )
    ).first()
    now = _utcnow()
    if membership is None:
        session.add(
            ProjectMembershipDB(
                project_id=config.project_id,
                user_id=user.id,
                role=config.project_role,
                created_at=now,
                updated_at=now,
            )
        )
        session.commit()
        return
    if _ROLE_RANK[membership.role] < _ROLE_RANK[config.project_role]:
        membership.role = config.project_role
        membership.updated_at = now
        session.add(membership)
        session.commit()


def provision_identity(
    session: Session, identity: VerifiedIdentity, config: OidcConfig
) -> UserDB:
    """Return the apo user for a verified identity, creating it on first login.

    Identity is the ``(issuer, subject)`` pair: an email change at the
    provider updates the display email but never re-keys the account, and a
    new subject whose email already belongs to an unrelated apo account is
    refused rather than linked. The first SSO user on an uninitialized
    installation claims it (becoming instance admin) and owns the SSO
    project; everyone else receives the configured project role.
    """
    from ..services.installation_initialization import (
        InstallationAlreadyInitializedError,
        claim_installation_for_user,
        get_installation_setup_status,
    )

    existing = find_identity(session, identity.issuer, identity.subject)
    if existing is not None:
        user = session.get(UserDB, existing.user_id)
        if user is None:
            session.delete(existing)
            session.commit()
        elif not user.is_active:
            raise OidcAuthError(403, "This account has been deactivated")
        else:
            _refresh_profile(session, user, identity)
            existing.last_login_at = _utcnow()
            session.add(existing)
            session.commit()
            _ensure_project(session, config, user)
            _ensure_membership(session, config, user)
            return user

    email = identity.email if identity.email_verified else None
    if email is not None:
        collision = session.exec(select(UserDB).where(UserDB.email == email)).first()
        if collision is not None:
            raise OidcAuthError(
                409,
                "An apo account with this email already exists and is not linked to "
                "your single sign-on identity",
            )
    user = UserDB(
        email=email or _placeholder_email(identity),
        name=identity.name,
        password_hash=SSO_PASSWORD_HASH,
        is_admin=False,
        is_active=True,
        email_verified_at=_utcnow() if email is not None else None,
    )
    if get_installation_setup_status(session).setup_available:
        try:
            claim_installation_for_user(session, user, is_instance_admin=True)
        except InstallationAlreadyInitializedError:
            session.add(user)
            session.commit()
    else:
        session.add(user)
        session.commit()
    session.refresh(user)
    session.add(
        OidcIdentityDB(
            issuer=identity.issuer,
            subject=identity.subject,
            user_id=user.id,
            last_login_at=_utcnow(),
        )
    )
    session.commit()
    _ensure_project(session, config, user)
    _ensure_membership(session, config, user)
    return user


def _refresh_profile(session: Session, user: UserDB, identity: VerifiedIdentity) -> None:
    changed = False
    if identity.name and identity.name != user.name:
        user.name = identity.name
        changed = True
    if identity.email_verified and identity.email and identity.email != user.email:
        taken = session.exec(select(UserDB).where(UserDB.email == identity.email)).first()
        if taken is None:
            user.email = identity.email
            user.email_verified_at = _utcnow()
            changed = True
        else:
            logger.warning(
                "SSO email for user %s changed to one held by another account; keeping %s",
                user.id,
                user.email,
            )
    if changed:
        session.add(user)
        session.commit()


# ---------------------------------------------------------------------------
# Live-session revalidation
# ---------------------------------------------------------------------------


class _RevalidationClock:
    """Per-user timestamp of the last successful UserInfo confirmation."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._confirmed: dict[str, float] = {}

    def is_due(self, user_id: str, interval_seconds: int) -> bool:
        with self._lock:
            last = self._confirmed.get(user_id)
        return last is None or time.monotonic() - last >= interval_seconds

    def confirm(self, user_id: str) -> None:
        with self._lock:
            self._confirmed[user_id] = time.monotonic()

    def forget(self, user_id: str) -> None:
        with self._lock:
            self._confirmed.pop(user_id, None)

    def reset(self) -> None:
        with self._lock:
            self._confirmed.clear()


revalidation_clock = _RevalidationClock()


def cookie_session_authorized(
    session: Session, user: UserDB, payload: dict[str, object]
) -> bool:
    """Decide whether an SSO-minted session cookie still grants access.

    Returns ``True`` for password sessions untouched by SSO. For SSO
    sessions: refuses past the provider-bounded expiry, and every
    ``revalidate_seconds`` re-asks UserInfo whether the person still holds
    the required claim — a removed role or a revoked token ends the session
    within that window, and an unreachable issuer fails closed.
    """
    if payload.get("auth_provider") != "oidc":
        return True
    config = load_oidc_config()
    if config is None:
        return False
    expires_at = payload.get("oidc_expires_at")
    if not isinstance(expires_at, (int, float)) or expires_at <= time.time():
        return False
    if not revalidation_clock.is_due(user.id, config.revalidate_seconds):
        return True
    access_token = payload.get("oidc_access_token")
    identity = identity_for_user(session, user.id)
    if not isinstance(access_token, str) or not access_token or identity is None:
        return False
    try:
        revalidate_access(access_token, identity.subject, config)
    except OidcAuthError as exc:
        logger.info("SSO revalidation refused user %s: %s", user.id, exc.detail)
        if exc.status_code == 403:
            from . import invalidate_user_sessions

            invalidate_user_sessions(session, user.id)
        return False
    revalidation_clock.confirm(user.id)
    return True


def end_session_url(config: OidcConfig, id_token: str | None, post_logout_redirect: str) -> str | None:
    """RP-initiated logout URL at the issuer, or ``None`` when it offers none."""
    try:
        endpoint = issuer_client.metadata(config.issuer).end_session_endpoint
    except OidcAuthError:
        return None
    if endpoint is None:
        return None
    params: dict[str, str] = {
        "client_id": config.client_id,
        "post_logout_redirect_uri": post_logout_redirect,
    }
    if id_token:
        params["id_token_hint"] = id_token
    return f"{endpoint}?{urlencode(params)}"
