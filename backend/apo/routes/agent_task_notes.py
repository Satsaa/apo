"""Routes: Task Notes.

- ``GET /v1/projects/{project_id}/task-notes`` — Notes that apply to a Task
  (``?task_id=``), Notes at or under a Folder (``?folder=``), or the whole
  Project. Project viewers.
- ``POST /v1/projects/{project_id}/task-notes`` — write a Note on a Folder,
  Task, or Test.
- ``PATCH /v1/task-notes/{note_id}`` — replace the body, archive, or restore.

A Run's detail (``GET /v1/agent-task-runs/{id}``) carries the Notes that apply
to its Task, so readers of a Run need no second request.

Writes need a Project member acting through a human-accountable credential
(the corrections rule, :mod:`apo.services.human_actor`) and are refused on the
demo Project. A Note id the caller cannot see is an opaque 404.
"""

# pyright: reportAny=false

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlmodel import Session

from apo.db import get_session
from apo.models.db import AgentTaskNoteDB
from apo.models.schemas import (
    CreateTaskNoteRequest,
    TaskNote,
    TaskNoteList,
    UpdateTaskNoteRequest,
)
from apo.services.demo_workspace import require_project_not_demo
from apo.services.human_actor import derive_human_actor
from apo.services.project_memberships import authorize_project_request
from apo.services.task_notes import TaskNoteError, create_note, list_notes, update_note

router = APIRouter(prefix="/v1", tags=["agent-tasks"])

_WRITE_ACTION = "write task notes"


@router.get("/projects/{project_id}/task-notes", response_model=TaskNoteList)
async def list_task_notes(
    project_id: str,
    request: Request,
    task_id: str | None = Query(default=None),
    folder: str | None = Query(default=None),
    include_archived: bool = Query(default=False),
    session: Session = Depends(get_session),
) -> TaskNoteList:
    """List Notes that apply to a Task, sit under a Folder, or belong to the Project."""
    _ = authorize_project_request(request, session, project_id, minimum_role="viewer")
    try:
        notes = list_notes(
            session,
            project=project_id,
            task_id=task_id,
            folder=folder,
            include_archived=include_archived,
        )
    except TaskNoteError as exc:
        raise _http_error(exc) from exc
    return TaskNoteList(notes=notes)


@router.post(
    "/projects/{project_id}/task-notes",
    response_model=TaskNote,
    status_code=status.HTTP_201_CREATED,
)
async def create_task_note(
    project_id: str,
    body: CreateTaskNoteRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> TaskNote:
    """Write a Note on a Folder, a Task, or one Test of a Task."""
    _ = authorize_project_request(request, session, project_id, minimum_role="member")
    require_project_not_demo(project_id)
    actor = derive_human_actor(request, session, action=_WRITE_ACTION)
    try:
        return create_note(
            session,
            project=project_id,
            folder=body.folder,
            task_id=body.task_id,
            test_id=body.test_id,
            body=body.body,
            actor=actor,
        )
    except TaskNoteError as exc:
        raise _http_error(exc) from exc


@router.patch("/task-notes/{note_id}", response_model=TaskNote)
async def update_task_note(
    note_id: str,
    body: UpdateTaskNoteRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> TaskNote:
    """Replace a Note's body, archive it, or restore it."""
    note = session.get(AgentTaskNoteDB, note_id)
    if note is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Task note not found")
    try:
        _ = authorize_project_request(request, session, note.project, minimum_role="member")
    except HTTPException as exc:
        if exc.status_code == status.HTTP_403_FORBIDDEN:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Task note not found") from exc
        raise
    require_project_not_demo(note.project)
    actor = derive_human_actor(request, session, action=_WRITE_ACTION)
    try:
        return update_note(session, note, body=body.body, archived=body.archived, actor=actor)
    except TaskNoteError as exc:
        raise _http_error(exc) from exc


def _http_error(exc: TaskNoteError) -> HTTPException:
    return HTTPException(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail={"kind": exc.kind, "msg": str(exc)},
    )
