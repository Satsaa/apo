# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnusedParameter=false

import logging
from datetime import datetime, timezone
from typing import Any
from unittest.mock import patch

import pytest
from sqlmodel import Session, select

from apo.bootstrap import bootstrap_initial_user
from apo.models.db import UserDB


@pytest.fixture
def clear_env(monkeypatch: Any) -> None:
    for var in ("INIT_USER_EMAIL", "INIT_USER_PASSWORD", "INIT_USER_NAME"):
        monkeypatch.delenv(var, raising=False)


class TestBootstrapCreatesUser:
    def test_creates_first_user(
        self, session: Session, clear_env: None, monkeypatch: Any
    ) -> None:
        monkeypatch.setenv("INIT_USER_EMAIL", "admin@test.com")
        monkeypatch.setenv("INIT_USER_PASSWORD", "Pass1234")

        bootstrap_initial_user(session)

        users = session.exec(select(UserDB)).all()
        assert len(users) == 1
        assert users[0].email == "admin@test.com"
        assert users[0].is_admin is True

    def test_password_is_hashed(
        self, session: Session, clear_env: None, monkeypatch: Any
    ) -> None:
        monkeypatch.setenv("INIT_USER_EMAIL", "admin@test.com")
        monkeypatch.setenv("INIT_USER_PASSWORD", "Pass1234")

        bootstrap_initial_user(session)

        user = session.exec(select(UserDB)).first()
        assert user is not None
        assert user.password_hash != "Pass1234"
        assert len(user.password_hash) > 20

    def test_default_name_is_admin(
        self, session: Session, clear_env: None, monkeypatch: Any
    ) -> None:
        monkeypatch.setenv("INIT_USER_EMAIL", "admin@test.com")
        monkeypatch.setenv("INIT_USER_PASSWORD", "Pass1234")

        bootstrap_initial_user(session)

        user = session.exec(select(UserDB)).first()
        assert user is not None
        assert user.name == "Admin"

    def test_custom_name(
        self, session: Session, clear_env: None, monkeypatch: Any
    ) -> None:
        monkeypatch.setenv("INIT_USER_EMAIL", "admin@test.com")
        monkeypatch.setenv("INIT_USER_PASSWORD", "Pass1234")
        monkeypatch.setenv("INIT_USER_NAME", "John Doe")

        bootstrap_initial_user(session)

        user = session.exec(select(UserDB)).first()
        assert user is not None
        assert user.name == "John Doe"

    def test_email_lowercased(
        self, session: Session, clear_env: None, monkeypatch: Any
    ) -> None:
        monkeypatch.setenv("INIT_USER_EMAIL", "Admin@Test.COM")
        monkeypatch.setenv("INIT_USER_PASSWORD", "Pass1234")

        bootstrap_initial_user(session)

        user = session.exec(select(UserDB)).first()
        assert user is not None
        assert user.email == "admin@test.com"


class TestBootstrapIdempotent:
    def test_skips_when_user_exists(
        self, session: Session, clear_env: None, monkeypatch: Any
    ) -> None:
        monkeypatch.setenv("INIT_USER_EMAIL", "admin@test.com")
        monkeypatch.setenv("INIT_USER_PASSWORD", "Pass1234")

        bootstrap_initial_user(session)
        bootstrap_initial_user(session)

        users = session.exec(select(UserDB)).all()
        assert len(users) == 1

    def test_skips_when_different_user_exists(
        self, session: Session, clear_env: None, monkeypatch: Any
    ) -> None:
        session.add(
            UserDB(
                email="other@test.com",
                name="Other",
                password_hash="hash",
                is_admin=True,
            )
        )
        session.commit()

        monkeypatch.setenv("INIT_USER_EMAIL", "admin@test.com")
        monkeypatch.setenv("INIT_USER_PASSWORD", "Pass1234")

        bootstrap_initial_user(session)

        users = session.exec(select(UserDB)).all()
        assert len(users) == 1
        assert users[0].email == "other@test.com"

    def test_case_insensitive_existing_user(
        self, session: Session, clear_env: None, monkeypatch: Any
    ) -> None:
        session.add(
            UserDB(
                email="Admin@Test.com",
                name="Admin",
                password_hash="hash",
                is_admin=True,
            )
        )
        session.commit()

        monkeypatch.setenv("INIT_USER_EMAIL", "admin@test.com")
        monkeypatch.setenv("INIT_USER_PASSWORD", "Pass1234")

        bootstrap_initial_user(session)

        users = session.exec(select(UserDB)).all()
        assert len(users) == 1


class TestBootstrapPartialEnv:
    def test_only_email_set(
        self, session: Session, clear_env: None, monkeypatch: Any
    ) -> None:
        monkeypatch.setenv("INIT_USER_EMAIL", "admin@test.com")

        bootstrap_initial_user(session)

        assert session.exec(select(UserDB)).first() is None

    def test_only_password_set(
        self, session: Session, clear_env: None, monkeypatch: Any
    ) -> None:
        monkeypatch.setenv("INIT_USER_PASSWORD", "Pass1234")

        bootstrap_initial_user(session)

        assert session.exec(select(UserDB)).first() is None

    def test_neither_set(
        self, session: Session, clear_env: None
    ) -> None:
        bootstrap_initial_user(session)

        assert session.exec(select(UserDB)).first() is None


class TestBootstrapWeakPassword:
    def test_weak_password_no_user_created(
        self, session: Session, clear_env: None, monkeypatch: Any
    ) -> None:
        monkeypatch.setenv("INIT_USER_EMAIL", "admin@test.com")
        monkeypatch.setenv("INIT_USER_PASSWORD", "short")

        bootstrap_initial_user(session)

        assert session.exec(select(UserDB)).first() is None

    def test_weak_password_logs_error(
        self, session: Session, clear_env: None, monkeypatch: Any
    ) -> None:
        monkeypatch.setenv("INIT_USER_EMAIL", "admin@test.com")
        monkeypatch.setenv("INIT_USER_PASSWORD", "short")

        with patch.object(
            logging.getLogger("apo.bootstrap"), "error"
        ) as mock_error:
            bootstrap_initial_user(session)

        log_calls = [str(call) for call in mock_error.call_args_list]
        assert any("Bootstrap skipped — weak password" in c for c in log_calls)


class TestBootstrapErrorHandling:
    def test_query_failure_does_not_raise(
        self, session: Session, clear_env: None, monkeypatch: Any
    ) -> None:
        monkeypatch.setenv("INIT_USER_EMAIL", "admin@test.com")
        monkeypatch.setenv("INIT_USER_PASSWORD", "Pass1234")

        with patch.object(
            Session, "exec", side_effect=RuntimeError("DB connection lost")
        ):
            bootstrap_initial_user(session)

    def test_commit_failure_does_not_raise(
        self,
        session: Session,
        clear_env: None,
        monkeypatch: Any,
        caplog: Any,
    ) -> None:
        monkeypatch.setenv("INIT_USER_EMAIL", "admin@test.com")
        monkeypatch.setenv("INIT_USER_PASSWORD", "Pass1234")

        with patch.object(
            Session, "commit", side_effect=RuntimeError("DB write failed")
        ):
            bootstrap_initial_user(session)

        # bootstrap reads installation state first; a commit failure
        # surfaces there and is swallowed (logged) rather than reaching the
        # user-creation step. Either way it must not raise.
        assert any(
            "Failed to read installation state" in r.message
            or "Failed to create bootstrap user" in r.message
            for r in caplog.records
        )


class TestInitialUserAdminRepair:
    """#152: installs initialized before the admin invariant existed get
    their recorded initial user promoted on startup."""

    def test_promotes_recorded_initial_user(self, session: Session, clear_env: None) -> None:
        # An initialized installation whose first user lost the role: the
        # pre-fix /auth/setup created users with is_admin=False.
        first = UserDB(email="founder@test.com", password_hash="x", is_admin=False)
        session.add(first)
        session.commit()
        from apo.models.db import InstallationStateDB
        from apo.services.installation_initialization import INSTALLATION_STATE_ID

        state = InstallationStateDB(
            id=INSTALLATION_STATE_ID,
            initialized_at=datetime.now(timezone.utc),
            initial_user_id=first.id,
        )
        session.add(state)
        session.commit()

        bootstrap_initial_user(session)

        refreshed = session.get(UserDB, first.id)
        assert refreshed is not None
        assert refreshed.is_admin is True

    def test_no_promotion_when_admin_exists(self, session: Session, clear_env: None) -> None:
        first = UserDB(email="founder@test.com", password_hash="x", is_admin=True)
        session.add(first)
        session.commit()
        from apo.models.db import InstallationStateDB
        from apo.services.installation_initialization import INSTALLATION_STATE_ID

        state = InstallationStateDB(
            id=INSTALLATION_STATE_ID,
            initialized_at=datetime.now(timezone.utc),
            initial_user_id=first.id,
        )
        session.add(state)
        session.commit()

        bootstrap_initial_user(session)

        refreshed = session.get(UserDB, first.id)
        assert refreshed is not None
        assert refreshed.is_admin is True
        others = session.exec(
            select(UserDB).where(UserDB.email != "founder@test.com")
        ).all()
        assert others == []
