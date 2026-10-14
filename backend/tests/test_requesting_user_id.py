"""Who a Batch records as its requester: the channels ``derive_human_actor``
accepts as human, and nothing else."""

from __future__ import annotations

from types import SimpleNamespace
from typing import cast

import pytest
from apo.models.db import UserDB
from apo.services.human_actor import derive_human_actor, requesting_user_id
from fastapi import HTTPException, Request
from sqlmodel import Session

_USER = "user-requester"


def _request(**state: object) -> Request:
    return cast(Request, SimpleNamespace(state=SimpleNamespace(**state)))


@pytest.fixture
def user(session: Session) -> str:
    session.add(UserDB(id=_USER, email="requester@test", name="R", password_hash="x"))
    session.commit()
    return _USER


@pytest.mark.parametrize(
    ("state", "expected"),
    [
        ({"auth_method": "cookie", "user_id": _USER}, _USER),
        ({"auth_method": "api_key", "api_key_scope": "full", "user_id": _USER}, _USER),
        ({"auth_method": "api_key", "api_key_scope": "ingest", "user_id": _USER}, None),
        ({"auth_method": "service_token", "user_id": _USER}, None),
        ({"auth_method": "attempt_token", "user_id": _USER}, None),
        ({"auth_method": "anonymous", "user_id": "dev"}, None),
        ({"auth_method": "cookie", "user_id": "no-such-user"}, None),
    ],
)
def test_requester_follows_the_human_channels(
    session: Session, user: str, state: dict[str, object], expected: str | None
) -> None:
    request = _request(**state)
    assert requesting_user_id(request, session) == expected
    if expected is not None:
        assert derive_human_actor(request, session, action="x").user_id == expected


@pytest.mark.parametrize("auth_method,scope", [("api_key", "ingest"), ("service_token", None)])
def test_channels_that_record_no_requester_are_refused_as_human(
    session: Session, user: str, auth_method: str, scope: str | None
) -> None:
    request = _request(auth_method=auth_method, api_key_scope=scope, user_id=user)
    assert requesting_user_id(request, session) is None
    with pytest.raises(HTTPException):
        _ = derive_human_actor(request, session, action="x")
