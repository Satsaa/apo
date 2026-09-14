# pyright: reportAny=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""SSE routes must give their DB session back before streaming.

A yield dependency is normally cleaned up only after the response has been
sent, which for an SSE stream means when the browser disconnects — so every
open dashboard tab would hold a pooled connection for its whole lifetime, and
a few dozen tabs exhaust the pool (and, with sync sessions, stall the event
loop). The routes scope their session to the handler instead.
"""

import asyncio
from collections.abc import Iterator

from fastapi import FastAPI
from sqlmodel import Session

from apo.api import app
from apo.db import get_session
from apo.models.db import UserDB
from tests.conftest import engine, seed_project_for_user

USER_ID = "user-sse-session-release"
PROJECT_ID = "sse-session-release"


def _seed_member_project(session: Session) -> None:
    session.add(
        UserDB(id=USER_ID, email="sse-session@test", name="SSE", password_hash="x")
    )
    session.commit()
    seed_project_for_user(session, USER_ID, project_id=PROJECT_ID)


def _authed_app(session_log: list[str]):
    inner = FastAPI()
    inner.include_router(app.router)

    def logged_session() -> Iterator[Session]:
        with Session(engine) as session:
            session_log.append("open")
            try:
                yield session
            finally:
                session_log.append("closed")

    inner.dependency_overrides[get_session] = logged_session

    async def authed(scope, receive, send):
        scope.setdefault("state", {}).update(
            user_id=USER_ID, is_admin=False, auth_method="cookie"
        )
        await inner(scope, receive, send)

    return authed


def _session_state_when_response_starts(path: str, query: str) -> tuple[int, list[str]]:
    session_log: list[str] = []
    asgi_app = _authed_app(session_log)

    async def run() -> tuple[int, list[str]]:
        disconnected = asyncio.Event()
        started: asyncio.Future[tuple[int, list[str]]] = asyncio.get_running_loop().create_future()

        async def receive():
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.start" and not started.done():
                started.set_result((message["status"], list(session_log)))
                disconnected.set()

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": query.encode(),
            "root_path": "",
            "headers": [],
            "client": ("testclient", 50000),
            "server": ("testserver", 80),
        }
        task = asyncio.create_task(asgi_app(scope, receive, send))
        try:
            return await asyncio.wait_for(started, timeout=10)
        finally:
            disconnected.set()
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    return asyncio.run(run())


def test_run_events_stream_releases_session_before_streaming(session: Session):
    _seed_member_project(session)

    status, session_log = _session_state_when_response_starts(
        "/v1/events", f"project={PROJECT_ID}"
    )

    assert status == 200
    assert session_log == ["open", "closed"]


def test_trace_stream_releases_session_before_streaming(session: Session):
    _seed_member_project(session)

    status, session_log = _session_state_when_response_starts(
        "/v1/traces/run-that-does-not-exist/stream", f"project={PROJECT_ID}"
    )

    assert status == 200
    assert session_log == ["open", "closed"]
