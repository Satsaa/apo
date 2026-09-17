"""The password-login switch for SSO-only installations.

``AUTH_PASSWORD_LOGIN_ENABLED=false`` closes every path that creates or
proves a password — sign-in, first-user setup, reset, invitation and
hosted-access account creation, and the CLI's email+password bootstraps —
and the password-less dev sign-in, so an installation fronted by single
sign-on has no second door. Project
API keys are unaffected: executors and the CLI keep authenticating with
project-scoped credentials minted from the dashboard.
"""

import os

from fastapi import HTTPException

PASSWORD_LOGIN_DISABLED_CODE = "PASSWORD_LOGIN_DISABLED"


def password_login_enabled() -> bool:
    return os.environ.get("AUTH_PASSWORD_LOGIN_ENABLED", "true").strip().lower() not in (
        "false",
        "0",
        "no",
    )


def require_password_login_enabled() -> None:
    if password_login_enabled():
        return
    raise HTTPException(
        status_code=403,
        detail={
            "message": "Password sign-in is disabled on this installation",
            "code": PASSWORD_LOGIN_DISABLED_CODE,
        },
    )
