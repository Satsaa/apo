# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnusedParameter=false, reportExplicitAny=false, reportUnusedFunction=false

"""Tests for the two-key API model.

Covers key pair generation, Basic auth validation, and legacy Bearer backward
compat. The public-key-only Bearer authentication path is removed: a
``pk-apo-*`` value used alone must never authenticate (security invariant #2).
These tests document both supported wire formats (Basic pair, legacy secret
Bearer) and the explicit rejection of public identifiers.
"""

import base64
from typing import Any

import pytest
from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo import auth as auth_module
from apo.auth import middleware as auth_middleware
from apo.auth.api_key_auth import (
    generate_key_pair,
    is_public_key,
    validate_basic_auth,
    validate_legacy_bearer,
)
from apo.models.db import ApiKeyDB, UserDB

from .conftest import TEST_PROJECT_ID, seed_project_for_user

_TEST_EMAIL = "test@example.com"
_TEST_PASSWORD = "TestPass123"
_TEST_NAME = "Test User"


def _setup_and_get_authed_client(
    client: TestClient, session: Session, make_authed_client: Any
) -> TestClient:
    client.post(
        "/auth/setup",
        json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": _TEST_NAME},
    )
    user = session.exec(select(UserDB)).first()
    assert user is not None
    # Issue #11: mint paths require a real project + membership.
    seed_project_for_user(session, user.id)
    return make_authed_client(user.id, session)


@pytest.fixture(autouse=True)
def _force_auth_secret(monkeypatch: MonkeyPatch) -> None:
    """Enable AuthMiddleware by setting AUTH_SECRET."""
    monkeypatch.setattr(auth_module, "AUTH_SECRET", "test-auth-secret")
    monkeypatch.setattr(auth_middleware, "AUTH_SECRET", "test-auth-secret")


@pytest.fixture(autouse=True)
def _patch_middleware_engine(monkeypatch: MonkeyPatch, session: Session) -> None:
    """Point middleware at the in-memory test DB so it can find keys created in tests."""
    monkeypatch.setattr(auth_middleware, "engine", session.get_bind())


# ---------------------------------------------------------------------------
# Unit tests: key generation and format
# ---------------------------------------------------------------------------


class TestKeyGeneration:
    def test_generate_key_pair_produces_correct_prefixes(self) -> None:
        public_key, secret_key, hashed_secret_key, display_secret_key = (
            generate_key_pair()
        )
        assert public_key.startswith("pk-apo-")
        assert secret_key.startswith("sk-apo-")
        assert hashed_secret_key != secret_key
        assert display_secret_key.startswith("sk-apo-")
        assert "..." in display_secret_key
        assert len(display_secret_key) < len(secret_key)

    def test_generate_key_pair_produces_unique_keys(self) -> None:
        public_keys = {generate_key_pair()[0] for _ in range(10)}
        secret_keys = {generate_key_pair()[1] for _ in range(10)}
        assert len(public_keys) == 10
        assert len(secret_keys) == 10

    def test_is_public_key_detects_prefix(self) -> None:
        assert is_public_key("pk-apo-some-uuid") is True
        assert is_public_key("sk-apo-some-uuid") is False
        assert is_public_key("sk-legacylegacy") is False


# ---------------------------------------------------------------------------
# Unit tests: validation functions (using test DB session)
# ---------------------------------------------------------------------------


class TestValidationFunctions:
    def test_validate_basic_auth_finds_key(
        self, session: Session
    ) -> None:
        public_key, secret_key, hashed_secret_key, display = generate_key_pair()
        session.add(
            ApiKeyDB(
                name="Test",
                prefix=public_key[:8],
                public_key=public_key,
                hashed_secret_key=hashed_secret_key,
                display_secret_key=display,
                project="test",
                created_by="user1",
                scope="full",
            )
        )
        session.commit()

        result = validate_basic_auth(public_key, secret_key, session)
        assert result is not None
        assert result.public_key == public_key
        assert result.project == "test"

    def test_validate_basic_auth_rejects_wrong_secret(
        self, session: Session
    ) -> None:
        public_key, _, hashed_secret_key, display = generate_key_pair()
        session.add(
            ApiKeyDB(
                name="Test",
                prefix=public_key[:8],
                public_key=public_key,
                hashed_secret_key=hashed_secret_key,
                display_secret_key=display,
                project="test",
                created_by="user1",
            )
        )
        session.commit()

        result = validate_basic_auth(public_key, "sk-apo-wrong-secret", session)
        assert result is None

    def test_public_key_only_validator_is_removed(self) -> None:
        """Acceptance Test #1: ``validate_bearer_public_key`` and its
        cache-key helper no longer exist in the public API. A public
        identifier must not authorize ingestion on its own."""
        import apo.auth.api_key_auth as auth_module

        assert not hasattr(auth_module, "validate_bearer_public_key")
        import apo.auth.api_key_cache as cache_module

        assert not hasattr(cache_module, "cache_key_for_bearer_public")

    def test_validate_legacy_bearer_finds_key(
        self, session: Session
    ) -> None:
        import hashlib

        token = "sk-abcdef1234567890"
        hashed = hashlib.sha256(token.encode()).hexdigest()
        session.add(
            ApiKeyDB(
                name="Legacy",
                prefix=token[:8],
                hashed_key=hashed,
                project="test",
                created_by="user1",
            )
        )
        session.commit()

        result = validate_legacy_bearer(token, session)
        assert result is not None
        assert result.name == "Legacy"

    def test_validate_legacy_bearer_returns_none_for_invalid(
        self, session: Session
    ) -> None:
        result = validate_legacy_bearer("sk-nonexistent", session)
        assert result is None


# ---------------------------------------------------------------------------
# Integration tests: middleware (Basic auth, public-key Bearer, legacy Bearer)
# ---------------------------------------------------------------------------


class TestMiddlewareBasicAuth:
    def test_basic_auth_grants_access(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        # omitting scope defaults to ingest; /v1/api-keys requires
        # full, so the Basic pair test must mint an explicit full key.
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Pair", "project": "example-service", "scope": "full"},
        )
        public_key = create_resp.json()["public_key"]
        secret_key = create_resp.json()["secret_key"]

        credentials = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
        resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": f"Basic {credentials}"},
        )
        assert resp.status_code == 200

    def test_basic_auth_wrong_secret_returns_401(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Pair", "project": "example-service", "scope": "full"},
        )
        public_key = create_resp.json()["public_key"]

        credentials = base64.b64encode(
            f"{public_key}:sk-apo-wrong".encode()
        ).decode()
        resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": f"Basic {credentials}"},
        )
        assert resp.status_code == 401

    def test_malformed_basic_auth_returns_401(self, client: TestClient) -> None:
        resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": "Basic not-valid-base64!!!"},
        )
        assert resp.status_code == 401


class TestMiddlewarePublicKeyBearerRejection:
    """A ``Bearer pk-apo-*`` value must fail authentication with the
    same generic 401 as any invalid credential, before scope authorization,
    before any DB lookup, and before any telemetry is persisted."""

    def test_public_key_bearer_cannot_ingest_legacy_batch(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        """Acceptance Test #6: ``POST /api/v1/ingestion`` with a
        Bearer public key returns 401 and persists nothing."""
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Pair", "project": "example-service", "scope": "full"},
        )
        public_key = create_resp.json()["public_key"]

        from apo.models.db import RunDB

        runs_before = session.exec(select(RunDB)).all()

        resp = client.post(
            "/api/v1/ingestion",
            headers={"Authorization": f"Bearer {public_key}"},
            json={"batch": []},
        )
        assert resp.status_code == 401
        # No ingestion side effect.
        assert session.exec(select(RunDB)).all() == runs_before

    def test_public_key_bearer_cannot_reach_key_management(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        """A Bearer public key is rejected at authentication (401), not at
        scope authorization (403). The response is the same generic 401 as an
        unknown credential."""
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Pair", "project": "example-service", "scope": "full"},
        )
        public_key = create_resp.json()["public_key"]

        resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": f"Bearer {public_key}"},
        )
        assert resp.status_code == 401

    def test_public_key_bearer_nonexistent_returns_401(
        self, client: TestClient
    ) -> None:
        resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": "Bearer pk-apo-nonexistent-uuid"},
        )
        assert resp.status_code == 401

    def test_public_key_bearer_response_matches_unknown_credential(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        """The 401 body for a known-but-public identifier is identical to the
        body for an unknown credential (security invariant #7: no
        credential-state enumeration)."""
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Pair", "project": "example-service", "scope": "full"},
        )
        public_key = create_resp.json()["public_key"]

        known_resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": f"Bearer {public_key}"},
        )
        unknown_resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": "Bearer pk-apo-does-not-exist"},
        )
        assert known_resp.status_code == 401
        assert unknown_resp.status_code == 401
        assert known_resp.json() == unknown_resp.json()

    def test_public_key_bearer_cannot_ingest_otlp_traces(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        """Acceptance Test #7: ``POST /api/public/otel/v1/traces``
        with a Bearer public key returns 401 and persists no inbox batch or
        canonical span."""
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "Pair", "project": "example-service", "scope": "full"},
        )
        public_key = create_resp.json()["public_key"]

        from apo.models.db import OtlpIngestBatchDB, OtlpSpanDB

        batches_before = session.exec(select(OtlpIngestBatchDB)).all()
        spans_before = session.exec(select(OtlpSpanDB)).all()

        # Minimal OTLP/JSON payload (a single no-op resourceSpans block).
        resp = client.post(
            "/api/public/otel/v1/traces",
            headers={
                "Authorization": f"Bearer {public_key}",
                "Content-Type": "application/json",
            },
            json={"resourceSpans": []},
        )
        assert resp.status_code == 401
        # No ingestion side effect on either store.
        assert session.exec(select(OtlpIngestBatchDB)).all() == batches_before
        assert session.exec(select(OtlpSpanDB)).all() == spans_before


class TestMiddlewareLegacyBearer:
    def test_legacy_bearer_still_works(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        """Bootstrap creates legacy keys; they must still authenticate via Bearer."""
        client.post(
            "/auth/setup",
            json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": _TEST_NAME},
        )
        user = session.exec(select(UserDB)).first()
        assert user is not None
        seed_project_for_user(session, user.id)
        bootstrap_resp = client.post(
            "/v1/api-keys/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "project": TEST_PROJECT_ID,
            },
        )
        legacy_key = bootstrap_resp.json()["key"]

        resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": f"Bearer {legacy_key}"},
        )
        assert resp.status_code == 200


class TestRotationUpgradesLegacyKey:
    def test_rotation_upgrades_legacy_to_pair(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        """Rotating a legacy key should upgrade it to the two-key model."""
        client.post(
            "/auth/setup",
            json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": _TEST_NAME},
        )
        user = session.exec(select(UserDB)).first()
        assert user is not None
        seed_project_for_user(session, user.id)
        bootstrap_resp = client.post(
            "/v1/api-keys/bootstrap",
            json={
                "email": _TEST_EMAIL,
                "password": _TEST_PASSWORD,
                "project": TEST_PROJECT_ID,
            },
        )
        key_id = bootstrap_resp.json()["id"]
        old_legacy_key = bootstrap_resp.json()["key"]

        db_key = session.get(ApiKeyDB, key_id)
        assert db_key is not None
        assert db_key.hashed_key is not None
        assert db_key.public_key is None

        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        rotate_resp = authed.post(f"/v1/api-keys/{key_id}/rotate")
        assert rotate_resp.status_code == 200
        data = rotate_resp.json()
        assert data["public_key"].startswith("pk-apo-")
        assert data["secret_key"].startswith("sk-apo-")

        session.refresh(db_key)
        assert db_key.public_key == data["public_key"]
        assert db_key.hashed_secret_key is not None
        assert db_key.hashed_key is None  # Legacy key cleared

        # Old legacy key should no longer validate
        old_result = validate_legacy_bearer(old_legacy_key, session)
        assert old_result is None


# ---------------------------------------------------------------------------
# revoke/rotate invalidate the Basic
# positive cache immediately (before the DB mutation commits). The old
# credential must fail on its next request, not after the positive TTL.
# ---------------------------------------------------------------------------


class TestCacheInvalidationOnRevoke:
    def test_revoke_invalidates_basic_cache(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        # default scope is ingest; /v1/api-keys requires full, so
        # the Basic pair test mints an explicit full key.
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "To Revoke", "project": "example-service", "scope": "full"},
        )
        assert create_resp.status_code == 200
        public_key = create_resp.json()["public_key"]
        secret_key = create_resp.json()["secret_key"]
        key_id = create_resp.json()["id"]

        # Prime the positive Basic cache by authenticating once.
        credentials = base64.b64encode(
            f"{public_key}:{secret_key}".encode()
        ).decode()
        authed_resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": f"Basic {credentials}"},
        )
        assert authed_resp.status_code == 200

        # Revoke via API.
        revoke_resp = authed.delete(f"/v1/api-keys/{key_id}")
        assert revoke_resp.status_code == 200

        # The next request with the old pair must fail immediately —
        # the positive cache entry must not survive revoke.
        immediate_resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": f"Basic {credentials}"},
        )
        assert immediate_resp.status_code == 401


class TestCacheInvalidationOnRotate:
    def test_rotate_invalidates_basic_cache_for_old_pair(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "To Rotate", "project": "example-service", "scope": "full"},
        )
        assert create_resp.status_code == 200
        old_public_key = create_resp.json()["public_key"]
        old_secret_key = create_resp.json()["secret_key"]
        key_id = create_resp.json()["id"]

        # Prime the positive Basic cache for the OLD pair.
        old_credentials = base64.b64encode(
            f"{old_public_key}:{old_secret_key}".encode()
        ).decode()
        prime_resp = client.get(
            "/v1/api-keys",
            headers={"Authorization": f"Basic {old_credentials}"},
        )
        assert prime_resp.status_code == 200

        # Rotate via API.
        rotate_resp = authed.post(f"/v1/api-keys/{key_id}/rotate")
        assert rotate_resp.status_code == 200
        new_public_key = rotate_resp.json()["public_key"]
        new_secret_key = rotate_resp.json()["secret_key"]
        assert new_public_key != old_public_key

        # The OLD pair must fail immediately — no positive cache bypass.
        old_repeat = client.get(
            "/v1/api-keys",
            headers={"Authorization": f"Basic {old_credentials}"},
        )
        assert old_repeat.status_code == 401

        # The NEW pair must succeed immediately.
        new_credentials = base64.b64encode(
            f"{new_public_key}:{new_secret_key}".encode()
        ).decode()
        new_repeat = client.get(
            "/v1/api-keys",
            headers={"Authorization": f"Basic {new_credentials}"},
        )
        assert new_repeat.status_code == 200
