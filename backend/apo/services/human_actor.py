"""Who is acting, for writes that need a human-accountable credential.

Corrections and Task Notes are review, not execution: a session member, a
full-scope project API key, or the open-dev identity may write them; runtime
capability credentials (service / Attempt / Executor tokens) and ingest-scoped
keys may not. Project membership is checked separately by the caller.
"""

# pyright: reportAny=false

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, cast

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


_Channel = Literal["session", "api_key", "open_dev", "runtime", "ingest"]


def _channel(request: Request) -> _Channel:
    """Which identity channel a request came through. Only ``session`` and a
    full-scope ``api_key`` are human-accountable; ``open_dev`` names no User."""
    auth_method = getattr(request.state, "auth_method", None)
    if auth_method in ("service_token", "attempt_token"):
        return "runtime"
    if auth_method == "api_key":
        return "api_key" if getattr(request.state, "api_key_scope", "full") == "full" else "ingest"
    return "session" if auth_method == "cookie" else "open_dev"


def is_runtime_credential(request: Request) -> bool:
    """True when the request rides a service or Attempt token. Routes that
    hide identity fields from runtime credentials use this instead of
    re-reading ``auth_method``, so the channel list lives in one place."""
    return _channel(request) == "runtime"


def derive_human_actor(request: Request, session: Session, *, action: str) -> HumanActor:
    """Resolve the acting human or raise a distinct 403.

    ``action`` completes the refusal message ("… cannot <action>").
    """
    channel = _channel(request)

    if channel == "runtime":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={
                "kind": "human_review_required",
                "msg": f"runtime capability credentials cannot {action}; use a session or full API key",
            },
        )
    if channel == "ingest":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={
                "kind": "full_scope_required",
                "msg": f"ingest-scoped API keys cannot {action}",
            },
        )

    user_id = getattr(request.state, "user_id", None)
    return HumanActor(
        user_id=user_id,
        label=user_label(session, user_id),
        via=channel,
        api_key_id=getattr(request.state, "api_key_id", None) if channel == "api_key" else None,
    )


def requesting_user_id(request: Request, session: Session) -> str | None:
    """The User to record as having asked for a Batch, or None.

    The same channels ``derive_human_actor`` accepts as human: a session, or a
    full-scope API key (its creator). Runtime credentials, ingest keys, and the
    open-dev identity record nobody; nor does a user id with no User row.
    """
    if _channel(request) not in ("session", "api_key"):
        return None
    user_id = cast(str | None, getattr(request.state, "user_id", None))
    if not user_id or session.get(UserDB, user_id) is None:
        return None
    return user_id


def user_labels(session: Session, user_ids: set[str]) -> dict[str, str]:
    """Email per user id, for attributing many rows in one read."""
    if not user_ids:
        return {}
    users = session.exec(select(UserDB).where(col(UserDB.id).in_(user_ids))).all()
    return {user.id: user.email for user in users}


def user_label(session: Session, user_id: str | None) -> str | None:
    """Email of one user, or None when unknown."""
    if user_id is None:
        return None
    user = session.get(UserDB, user_id)
    return user.email if user is not None else None
