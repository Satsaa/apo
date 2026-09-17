# pyright: reportAny=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnusedCallResult=false, reportExplicitAny=false

"""Single sign-on: verification, provisioning, live-session revalidation and
the password-path gates.

The issuer is faked at the HTTP boundary (discovery, JWKS, UserInfo) with a
key generated per test module, so every ID token here is really signed and
really verified — only the network is replaced.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from typing import Any
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jose import jwk, jwt
from sqlmodel import Session, select

from apo.auth import hash_password, verify_password
from apo.auth import oidc as oidc_module
from apo.auth.oidc import (
    SSO_PASSWORD_HASH,
    IssuerMetadata,
    OidcAuthError,
    OidcConfigError,
    cookie_session_authorized,
    load_oidc_config,
    revalidation_clock,
)
from apo.auth.password_login import PASSWORD_LOGIN_DISABLED_CODE
from apo.models.db import OidcIdentityDB, ProjectMembershipDB, UserDB
from apo.routes.oidc import exchange_rate_limiter
from apo.services.installation_initialization import get_installation_setup_status
from apo.services.installation_secrets import (
    InstallationConfigError,
    load_installation_config,
    validate_installation_secrets,
)

ISSUER = "https://auth.example.test"
CLIENT_ID = "apo"
KID = "test-key"

_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_private_pem = _private_key.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.PKCS8,
    serialization.NoEncryption(),
).decode()
_public_pem = (
    _private_key.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)
_stranger_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_stranger_pem = _stranger_key.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.PKCS8,
    serialization.NoEncryption(),
).decode()


def _jwks() -> dict[str, object]:
    key = jwk.construct(_public_pem, algorithm="RS256").to_dict()
    key["kid"] = KID
    key["use"] = "sig"
    return {"keys": [key]}


class FakeIssuer:
    """Stands in for the network half of ``_IssuerClient``."""

    def __init__(self) -> None:
        self.userinfo_by_token: dict[str, dict[str, object]] = {}
        self.userinfo_calls = 0
        self.end_session_endpoint: str | None = f"{ISSUER}/session/end"

    def metadata(self, issuer: str) -> IssuerMetadata:
        assert issuer == ISSUER
        return IssuerMetadata(
            issuer=ISSUER,
            jwks_uri=f"{ISSUER}/jwks",
            userinfo_endpoint=f"{ISSUER}/me",
            end_session_endpoint=self.end_session_endpoint,
        )

    def jwks(self, issuer: str, *, force_refresh: bool = False) -> dict[str, object]:
        assert issuer == ISSUER
        return _jwks()

    def userinfo(self, issuer: str, access_token: str) -> dict[str, object]:
        assert issuer == ISSUER
        self.userinfo_calls += 1
        info = self.userinfo_by_token.get(access_token)
        if info is None:
            raise OidcAuthError(401, "Identity provider rejected the access token")
        return info

    def reset(self) -> None:
        pass


@pytest.fixture(name="issuer")
def issuer_fixture(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeIssuer]:
    fake = FakeIssuer()
    monkeypatch.setattr(oidc_module, "issuer_client", fake)
    monkeypatch.setenv("AUTH_OIDC_ISSUER", ISSUER)
    monkeypatch.setenv("AUTH_OIDC_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("AUTH_OIDC_PROVIDER_NAME", "Agentio")
    monkeypatch.setenv("AUTH_OIDC_REQUIRED_CLAIM", "roles")
    monkeypatch.setenv("AUTH_OIDC_REQUIRED_CLAIM_VALUE", "agentio_super_admin")
    monkeypatch.setenv("AUTH_OIDC_PROJECT_ID", "sso")
    monkeypatch.setenv("AUTH_OIDC_PROJECT_ROLE", "admin")
    monkeypatch.delenv("AUTH_OIDC_CLIENT_SECRET", raising=False)
    revalidation_clock.reset()
    exchange_rate_limiter._attempts.clear()
    yield fake
    revalidation_clock.reset()
    exchange_rate_limiter._attempts.clear()


def _id_token(
    subject: str,
    *,
    email: str | None = None,
    email_verified: bool = True,
    name: str = "Test Person",
    roles: list[str] | None = None,
    signing_pem: str = _private_pem,
    audience: str = CLIENT_ID,
    exp_in: int = 3600,
) -> str:
    now = int(time.time())
    claims: dict[str, Any] = {
        "iss": ISSUER,
        "sub": subject,
        "aud": audience,
        "iat": now,
        "exp": now + exp_in,
        "name": name,
    }
    if email is not None:
        claims["email"] = email
        claims["email_verified"] = email_verified
    if roles is not None:
        claims["roles"] = roles
    return jwt.encode(claims, signing_pem, algorithm="RS256", headers={"kid": KID})


def _login(
    issuer: FakeIssuer,
    subject: str,
    *,
    roles: list[str],
    email: str | None = None,
    name: str = "Test Person",
    email_verified: bool = True,
) -> tuple[str, str]:
    """Register a person at the fake issuer; returns ``(id_token, access_token)``."""
    access_token = f"at-{uuid4().hex}"
    info: dict[str, object] = {"sub": subject, "roles": roles, "name": name}
    if email is not None:
        info["email"] = email
        info["email_verified"] = email_verified
    issuer.userinfo_by_token[access_token] = info
    return (
        _id_token(subject, email=email, email_verified=email_verified, name=name, roles=roles),
        access_token,
    )


def _exchange(client: TestClient, id_token: str, access_token: str):
    return client.post(
        "/auth/oidc/exchange", json={"id_token": id_token, "access_token": access_token}
    )


class TestExchange:
    def test_refuses_person_without_required_role(
        self, client: TestClient, session: Session, issuer: FakeIssuer
    ) -> None:
        id_token, access_token = _login(
            issuer, "user-1", roles=["agentio_admin"], email="admin@example.test"
        )
        resp = _exchange(client, id_token, access_token)
        assert resp.status_code == 403, resp.text
        assert session.exec(select(UserDB)).first() is None, "a refused login must provision nothing"

    def test_refuses_token_signed_by_unknown_key(
        self, client: TestClient, session: Session, issuer: FakeIssuer
    ) -> None:
        _, access_token = _login(issuer, "user-1", roles=["agentio_super_admin"])
        forged = _id_token("user-1", roles=["agentio_super_admin"], signing_pem=_stranger_pem)
        assert _exchange(client, forged, access_token).status_code == 401

    def test_refuses_token_for_another_audience(
        self, client: TestClient, issuer: FakeIssuer
    ) -> None:
        _, access_token = _login(issuer, "user-1", roles=["agentio_super_admin"])
        other = _id_token("user-1", roles=["agentio_super_admin"], audience="dashboard")
        assert _exchange(client, other, access_token).status_code == 401

    def test_refuses_access_token_belonging_to_someone_else(
        self, client: TestClient, issuer: FakeIssuer
    ) -> None:
        id_token, _ = _login(issuer, "user-1", roles=["agentio_super_admin"])
        _, other_access = _login(issuer, "user-2", roles=["agentio_super_admin"])
        assert _exchange(client, id_token, other_access).status_code == 401

    def test_userinfo_is_the_authority_for_the_role(
        self, client: TestClient, issuer: FakeIssuer
    ) -> None:
        # The ID token still carries the role; the issuer no longer does.
        access_token = f"at-{uuid4().hex}"
        issuer.userinfo_by_token[access_token] = {"sub": "user-1", "roles": ["agentio_user"]}
        id_token = _id_token("user-1", roles=["agentio_super_admin"])
        assert _exchange(client, id_token, access_token).status_code == 403

    def test_first_login_claims_installation_and_owns_sso_project(
        self, client: TestClient, session: Session, issuer: FakeIssuer
    ) -> None:
        assert get_installation_setup_status(session).setup_available
        id_token, access_token = _login(
            issuer, "user-1", roles=["agentio_super_admin"], email="samuel@example.test"
        )
        resp = _exchange(client, id_token, access_token)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["is_admin"] is True
        assert body["email"] == "samuel@example.test"
        assert body["expires_at"] <= int(time.time()) + 3600

        session.expire_all()
        user = session.get(UserDB, body["id"])
        assert user is not None
        assert user.password_hash == SSO_PASSWORD_HASH
        assert user.email_verified_at is not None
        assert not get_installation_setup_status(session).setup_available
        membership = session.exec(
            select(ProjectMembershipDB).where(ProjectMembershipDB.user_id == user.id)
        ).one()
        assert (membership.project_id, membership.role) == ("sso", "owner")
        identity = session.exec(select(OidcIdentityDB)).one()
        assert (identity.issuer, identity.subject, identity.user_id) == (ISSUER, "user-1", user.id)

    def test_later_logins_get_configured_role_not_ownership(
        self, client: TestClient, session: Session, issuer: FakeIssuer
    ) -> None:
        first = _login(issuer, "user-1", roles=["agentio_super_admin"], email="a@example.test")
        assert _exchange(client, *first).status_code == 200
        second = _login(issuer, "user-2", roles=["agentio_super_admin"], email="b@example.test")
        resp = _exchange(client, *second)
        assert resp.status_code == 200, resp.text
        assert resp.json()["is_admin"] is False
        membership = session.exec(
            select(ProjectMembershipDB).where(ProjectMembershipDB.user_id == resp.json()["id"])
        ).one()
        assert (membership.project_id, membership.role) == ("sso", "admin")

    def test_repeat_login_reuses_identity_and_refreshes_profile(
        self, client: TestClient, session: Session, issuer: FakeIssuer
    ) -> None:
        first = _login(issuer, "user-1", roles=["agentio_super_admin"], email="a@example.test")
        user_id = _exchange(client, *first).json()["id"]
        renamed = _login(
            issuer,
            "user-1",
            roles=["agentio_super_admin"],
            email="renamed@example.test",
            name="Renamed Person",
        )
        resp = _exchange(client, *renamed)
        assert resp.status_code == 200
        assert resp.json()["id"] == user_id, "identity is keyed on subject, not email"
        assert len(session.exec(select(UserDB)).all()) == 1
        session.expire_all()
        user = session.get(UserDB, user_id)
        assert user is not None
        assert (user.email, user.name) == ("renamed@example.test", "Renamed Person")

    def test_refuses_verified_email_held_by_unlinked_account(
        self, client: TestClient, session: Session, issuer: FakeIssuer
    ) -> None:
        session.add(
            UserDB(
                email="taken@example.test",
                name="Local",
                password_hash=hash_password("SecretPass123"),
            )
        )
        session.commit()
        tokens = _login(issuer, "user-9", roles=["agentio_super_admin"], email="taken@example.test")
        assert _exchange(client, *tokens).status_code == 409
        assert session.exec(select(OidcIdentityDB)).first() is None

    def test_unverified_email_is_not_trusted_for_linking_or_display(
        self, client: TestClient, session: Session, issuer: FakeIssuer
    ) -> None:
        session.add(
            UserDB(
                email="taken@example.test",
                name="Local",
                password_hash=hash_password("SecretPass123"),
            )
        )
        session.commit()
        tokens = _login(
            issuer,
            "user-9",
            roles=["agentio_super_admin"],
            email="taken@example.test",
            email_verified=False,
        )
        resp = _exchange(client, *tokens)
        assert resp.status_code == 200, resp.text
        assert resp.json()["email"] != "taken@example.test"

    def test_deactivated_account_is_refused(
        self, client: TestClient, session: Session, issuer: FakeIssuer
    ) -> None:
        tokens = _login(issuer, "user-1", roles=["agentio_super_admin"], email="a@example.test")
        user_id = _exchange(client, *tokens).json()["id"]
        user = session.get(UserDB, user_id)
        assert user is not None
        user.is_active = False
        session.add(user)
        session.commit()
        assert _exchange(client, *tokens).status_code == 403

    def test_not_configured_is_404(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("AUTH_OIDC_ISSUER", raising=False)
        monkeypatch.delenv("AUTH_OIDC_CLIENT_ID", raising=False)
        assert _exchange(client, "x", "y").status_code == 404


class TestLiveSession:
    def _sso_user(self, session: Session) -> UserDB:
        user = UserDB(email="sso@example.test", name="SSO", password_hash=SSO_PASSWORD_HASH)
        session.add(user)
        session.commit()
        session.refresh(user)
        session.add(OidcIdentityDB(issuer=ISSUER, subject="user-1", user_id=user.id))
        session.commit()
        return user

    def _payload(self, access_token: str, *, expires_in: int = 600) -> dict[str, object]:
        return {
            "auth_provider": "oidc",
            "oidc_access_token": access_token,
            "oidc_expires_at": int(time.time()) + expires_in,
        }

    def test_password_session_is_untouched(self, session: Session, issuer: FakeIssuer) -> None:
        user = UserDB(email="pw@example.test", name="PW", password_hash=hash_password("SecretPass123"))
        session.add(user)
        session.commit()
        assert cookie_session_authorized(session, user, {"sub": user.id}) is True
        assert issuer.userinfo_calls == 0

    def test_expired_provider_session_is_refused(self, session: Session, issuer: FakeIssuer) -> None:
        user = self._sso_user(session)
        _, access_token = _login(issuer, "user-1", roles=["agentio_super_admin"])
        payload = self._payload(access_token, expires_in=-1)
        assert cookie_session_authorized(session, user, payload) is False
        assert issuer.userinfo_calls == 0, "an expired session is refused without asking the issuer"

    def test_revalidation_is_periodic(self, session: Session, issuer: FakeIssuer) -> None:
        user = self._sso_user(session)
        _, access_token = _login(issuer, "user-1", roles=["agentio_super_admin"])
        payload = self._payload(access_token)
        assert cookie_session_authorized(session, user, payload) is True
        assert cookie_session_authorized(session, user, payload) is True
        assert issuer.userinfo_calls == 1

    def test_role_removal_ends_session_within_interval(
        self, session: Session, issuer: FakeIssuer
    ) -> None:
        user = self._sso_user(session)
        _, access_token = _login(issuer, "user-1", roles=["agentio_super_admin"])
        payload = self._payload(access_token)
        assert cookie_session_authorized(session, user, payload) is True
        issuer.userinfo_by_token[access_token]["roles"] = ["agentio_admin"]
        revalidation_clock.reset()  # the interval elapsed
        assert cookie_session_authorized(session, user, payload) is False
        session.refresh(user)
        assert user.token_invalid_before is not None, "a revoked role invalidates every session"

    def test_revoked_access_token_ends_session(self, session: Session, issuer: FakeIssuer) -> None:
        user = self._sso_user(session)
        payload = self._payload("at-revoked")
        assert cookie_session_authorized(session, user, payload) is False

    def test_unreachable_issuer_fails_closed(
        self, session: Session, issuer: FakeIssuer, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        user = self._sso_user(session)

        def down(issuer_url: str, access_token: str) -> dict[str, object]:
            raise OidcAuthError(502, "Identity provider unavailable")

        monkeypatch.setattr(issuer, "userinfo", down)
        assert cookie_session_authorized(session, user, self._payload("at-1")) is False
        session.refresh(user)
        assert user.token_invalid_before is None, "an outage is not a revocation"

    def test_sso_session_refused_when_sso_switched_off(
        self, session: Session, issuer: FakeIssuer, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        user = self._sso_user(session)
        monkeypatch.delenv("AUTH_OIDC_ISSUER")
        monkeypatch.delenv("AUTH_OIDC_CLIENT_ID")
        assert cookie_session_authorized(session, user, self._payload("at-1")) is False


class TestPasswordPaths:
    def test_sso_marker_never_verifies(self) -> None:
        assert verify_password("anything", SSO_PASSWORD_HASH) is False
        assert verify_password("", "!") is False

    def test_sso_config_reports_both_methods(
        self, client: TestClient, issuer: FakeIssuer, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AUTH_PASSWORD_LOGIN_ENABLED", "false")
        body = client.get("/auth/sso/config").json()
        assert body == {
            "oidc": {"enabled": True, "provider_name": "Agentio"},
            "password_login_enabled": False,
        }

    @pytest.mark.parametrize(
        ("method", "path", "body"),
        [
            ("post", "/auth/verify-password", {"email": "a@b.c", "password": "SecretPass123"}),
            (
                "post",
                "/auth/setup",
                {"email": "a@b.c", "password": "SecretPass123", "name": "A"},
            ),
            ("post", "/auth/forgot-password", {"email": "a@b.c"}),
            ("post", "/auth/reset-password", {"token": "t", "new_password": "SecretPass123"}),
            (
                "post",
                "/v1/api-keys/bootstrap",
                {"email": "a@b.c", "password": "SecretPass123"},
            ),
        ],
    )
    def test_password_paths_closed_in_sso_mode(
        self,
        client: TestClient,
        issuer: FakeIssuer,
        monkeypatch: pytest.MonkeyPatch,
        method: str,
        path: str,
        body: dict[str, object],
    ) -> None:
        monkeypatch.setenv("AUTH_PASSWORD_LOGIN_ENABLED", "false")
        resp = getattr(client, method)(path, json=body)
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"]["code"] == PASSWORD_LOGIN_DISABLED_CODE

    def test_password_paths_open_by_default(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("AUTH_PASSWORD_LOGIN_ENABLED", raising=False)
        resp = client.post(
            "/auth/verify-password", json={"email": "nobody@b.c", "password": "SecretPass123"}
        )
        assert resp.status_code == 401


class TestConfiguration:
    def test_partial_config_is_refused(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("AUTH_OIDC_ISSUER", ISSUER)
        monkeypatch.delenv("AUTH_OIDC_CLIENT_ID", raising=False)
        with pytest.raises(OidcConfigError) as exc:
            load_oidc_config()
        assert exc.value.variable == "AUTH_OIDC_CLIENT_ID"

    def test_required_claim_needs_a_value_to_bind(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("AUTH_OIDC_ISSUER", ISSUER)
        monkeypatch.setenv("AUTH_OIDC_CLIENT_ID", CLIENT_ID)
        monkeypatch.delenv("AUTH_OIDC_REQUIRED_CLAIM_VALUE", raising=False)
        config = load_oidc_config()
        assert config is not None
        assert config.required_claim is None, "a claim name with no value gates nothing"

    def test_sso_only_installation_without_provider_cannot_start(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("AUTH_OIDC_ISSUER", raising=False)
        monkeypatch.delenv("AUTH_OIDC_CLIENT_ID", raising=False)
        monkeypatch.setenv("AUTH_PASSWORD_LOGIN_ENABLED", "false")
        with pytest.raises(InstallationConfigError) as exc:
            validate_installation_secrets(load_installation_config())
        assert exc.value.variable == "AUTH_PASSWORD_LOGIN_ENABLED"
