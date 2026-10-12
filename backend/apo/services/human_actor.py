"""Who is acting, for writes that need a human-accountable credential.

Corrections and Task Notes are review, not execution: a session member, a
full-scope project API key, or the open-dev identity may write them; runtime
capability credentials (service / Attempt / Executor tokens) and ingest-scoped
keys may not. Project membership is checked separately by the caller.
"""

# pyright: reportAny=false

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from fastapi import HTTPException, Request, status
from sqlmodel import Session, col, select

from apo.models.db import UserDB


@dataclass(frozen=True, slots=True)
class HumanActor:
    """Who is acting, through which identity channel."""

    user_id: str | None
    label: str | None
    via: Literal["session", "api_key", "open_dev"]
    api_key_id: str | None


def derive_human_actor(request: Request, session: Session, *, action: str) -> HumanActor:
    """Resolve the acting human or raise a distinct 403.

    ``action`` completes the refusal message ("… cannot <action>").
    """
    auth_method = getattr(request.state, "auth_method", None)

    if auth_method in ("service_token", "attempt_token"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={
                "kind": "human_review_required",
                "msg": f"runtime capability credentials cannot {action}; use a session or full API key",
            },
        )

    user_id = getattr(request.state, "user_id", None)
    label = _user_email(session, user_id)

    if auth_method == "api_key":
        if getattr(request.state, "api_key_scope", "full") != "full":
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail={
                    "kind": "full_scope_required",
                    "msg": f"ingest-scoped API keys cannot {action}",
                },
            )
        return HumanActor(
            user_id=user_id,
            label=label,
            via="api_key",
            api_key_id=getattr(request.state, "api_key_id", None),
        )

    via: Literal["session", "open_dev"] = "session" if auth_method == "cookie" else "open_dev"
    return HumanActor(user_id=user_id, label=label, via=via, api_key_id=None)


def user_labels(session: Session, user_ids: set[str]) -> dict[str, str]:
    """Email per user id, for attributing many rows in one read."""
    if not user_ids:
        return {}
    users = session.exec(select(UserDB).where(col(UserDB.id).in_(user_ids))).all()
    return {user.id: user.email for user in users}


def _user_email(session: Session, user_id: str | None) -> str | None:
    if user_id is None:
        return None
    user = session.get(UserDB, user_id)
    return user.email if user is not None else None
