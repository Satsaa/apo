"""Safe installation secret lifecycle — centralized validation.

Parses deployment and database profile selectors, validates installation
secrets (AUTH_SECRET, POSTGRES_PASSWORD, GitHub OAuth), and provides a shared
auth-secret strength helper consumed by both app construction and the
readiness endpoint.

Release profiles (``local``, ``server``) never start with an absent, weak, or
known-placeholder ``AUTH_SECRET``. Development remains zero-config. An unknown
explicit profile fails rather than falling back.
"""

# pyright: reportImplicitStringConcatenation=false, reportUnannotatedClassAttribute=false, reportUnnecessaryIsInstance=false, reportUnusedCallResult=false

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal, cast


DeploymentProfile = Literal["development", "local", "server"]
DatabaseProfile = Literal["sqlite", "postgres"]

_VALID_PROFILES = frozenset({"development", "local", "server"})
_VALID_DATABASES = frozenset({"sqlite", "postgres"})

_KNOWN_PLACEHOLDERS = frozenset(
    {
        "change-me-in-production",
        "change-me",
        "dev-secret",
        "dev-secret-change-me",
        "secret",
    }
)

_GITHUB_OAUTH_VARS = (
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_REDIRECT_URI",
    "GITHUB_TOKEN_ENCRYPTION_KEY",
)

_MIN_AUTH_SECRET_LENGTH = 32


class InstallationConfigError(RuntimeError):
    """Configuration validation failure. Never includes secret values."""

    def __init__(self, message: str, *, variable: str = "") -> None:
        super().__init__(message)
        self.variable = variable


@dataclass(frozen=True)
class InstallationConfig:
    """Parsed deployment shape derived from environment variables."""

    deployment_profile: DeploymentProfile
    database_profile: DatabaseProfile
    public_url: str


def load_installation_config() -> InstallationConfig:
    """Parse deployment/database profile selectors from the environment.

    Raises :class:`InstallationConfigError` on an unknown explicit value.
    """
    profile_raw = os.environ.get("APO_DEPLOYMENT_PROFILE", "").strip().lower()
    if profile_raw == "":
        profile: DeploymentProfile = "development"
    elif profile_raw in _VALID_PROFILES:
        profile = cast(DeploymentProfile, profile_raw)
    else:
        raise InstallationConfigError(
            f"APO_DEPLOYMENT_PROFILE must be one of development, local, server "
            f"(got {profile_raw!r})",
            variable="APO_DEPLOYMENT_PROFILE",
        )

    db_raw = os.environ.get("APO_DATABASE_PROFILE", "").strip().lower()
    if db_raw == "":
        database: DatabaseProfile = "sqlite"
    elif db_raw in _VALID_DATABASES:
        database = cast(DatabaseProfile, db_raw)
    else:
        raise InstallationConfigError(
            f"APO_DATABASE_PROFILE must be sqlite or postgres (got {db_raw!r})",
            variable="APO_DATABASE_PROFILE",
        )

    public_url = os.environ.get("APO_PUBLIC_URL", "").strip()

    return InstallationConfig(
        deployment_profile=profile,
        database_profile=database,
        public_url=public_url,
    )


def auth_secret_problem(value: str, *, required: bool) -> str | None:
    """Return a problem description if the auth secret is unsafe, else None.

    Rules:
      - not required and empty → None (OK);
      - required and empty → problem;
      - not required and present → None (development accepts any value);
      - required and case-insensitive match against known placeholders → problem;
      - required and < 32 chars → problem.
    """
    trimmed = value.strip()
    if not trimmed:
        return "AUTH_SECRET is required for this deployment profile" if required else None
    if not required:
        return None
    if trimmed.lower() in _KNOWN_PLACEHOLDERS:
        return "AUTH_SECRET is set to a known insecure placeholder"
    if len(trimmed) < _MIN_AUTH_SECRET_LENGTH:
        return f"AUTH_SECRET must be at least {_MIN_AUTH_SECRET_LENGTH} characters"
    return None


def validate_installation_secrets(config: InstallationConfig) -> None:
    """Validate all installation secrets for the parsed configuration.

    Raises :class:`InstallationConfigError` on any failure. Never includes
    secret values in the error message.
    """
    is_release = config.deployment_profile in ("local", "server")

    # AUTH_SECRET
    secret = os.environ.get("AUTH_SECRET", "")
    problem = auth_secret_problem(secret, required=is_release)
    if problem is not None:
        raise InstallationConfigError(problem, variable="AUTH_SECRET")

    # Single sign-on — partial or invalid AUTH_OIDC_* fails here, not at the
    # first login; an SSO-only installation with no provider has no way in.
    from ..auth.oidc import OidcConfigError, load_oidc_config
    from ..auth.password_login import password_login_enabled

    try:
        oidc = load_oidc_config()
    except OidcConfigError as exc:
        raise InstallationConfigError(str(exc), variable=exc.variable) from None
    if oidc is None and not password_login_enabled():
        raise InstallationConfigError(
            "AUTH_PASSWORD_LOGIN_ENABLED=false requires AUTH_OIDC_ISSUER and "
            "AUTH_OIDC_CLIENT_ID, otherwise nobody can sign in",
            variable="AUTH_PASSWORD_LOGIN_ENABLED",
        )

    # POSTGRES_PASSWORD
    if config.database_profile == "postgres":
        pg_password = os.environ.get("POSTGRES_PASSWORD", "").strip()
        if not pg_password:
            raise InstallationConfigError(
                "POSTGRES_PASSWORD is required when APO_DATABASE_PROFILE is postgres",
                variable="POSTGRES_PASSWORD",
            )

    # GitHub OAuth — all-or-nothing group with valid Fernet key.
    present = {v for v in _GITHUB_OAUTH_VARS if os.environ.get(v, "").strip()}
    if present and len(present) != len(_GITHUB_OAUTH_VARS):
        all_vars: set[str] = set(_GITHUB_OAUTH_VARS)
        missing = sorted(all_vars - present)
        raise InstallationConfigError(
            f"Partial GitHub OAuth configuration: when any GitHub OAuth variable "
            f"is set, all four are required. Missing: {', '.join(missing)}",
            variable="GITHUB_OAUTH",
        )
    if "GITHUB_TOKEN_ENCRYPTION_KEY" in present:
        key = os.environ.get("GITHUB_TOKEN_ENCRYPTION_KEY", "").strip()
        try:
            from cryptography.fernet import Fernet

            Fernet(key.encode() if isinstance(key, str) else key)
        except Exception:
            raise InstallationConfigError(
                "GITHUB_TOKEN_ENCRYPTION_KEY is not a valid Fernet key",
                variable="GITHUB_TOKEN_ENCRYPTION_KEY",
            ) from None

    # Automation GitHub-token encryption — optional; when set it must be a
    # valid Fernet key. Without it, github_issue automations that supply a
    # token are rejected with a 503 rather than storing a plaintext PAT.
    automation_key = os.environ.get("AUTOMATION_TOKEN_ENCRYPTION_KEY", "").strip()
    if automation_key:
        try:
            from cryptography.fernet import Fernet

            Fernet(automation_key.encode())
        except Exception:
            raise InstallationConfigError(
                "AUTOMATION_TOKEN_ENCRYPTION_KEY is not a valid Fernet key",
                variable="AUTOMATION_TOKEN_ENCRYPTION_KEY",
            ) from None
