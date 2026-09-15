"""Archiving models out of a project's filter dropdowns.

The model palette on the Runs and Tasks pages is derived from the distinct
``configured_model`` values on runs, so it only ever grows. This route lets any
project member retire a model from those lists, and put it back.

Archiving is shared across the project and display-only — see
``services/archived_models``. There is no GET here: the ``archived`` flag rides
the two existing facet payloads, so the dropdown needs no extra request.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, SQLModel

from ..auth.deps import get_user_id
from ..db import get_session
from ..models.db import ProjectDB
from ..services.archived_models import set_model_archived
from ..services.project_memberships import require_project_role

router = APIRouter(prefix="/v1/projects/{project_id}", tags=["model-prefs"])
SessionDependency = Annotated[Session, Depends(get_session)]


class ArchivedModelRequest(SQLModel):
    """``archived=True`` retires the model; ``False`` restores it."""

    model: str
    archived: bool


class ArchivedModelResponse(SQLModel):
    model: str
    archived: bool


def _authorize(session: Session, project_id: str, request: Request) -> str:
    """404 if the project is missing, 403 if the caller is not a member."""
    project = session.get(ProjectDB, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    user_id = get_user_id(request)
    _ = require_project_role(session, project_id, user_id, minimum_role="member")
    return user_id


@router.put("/archived-models", response_model=ArchivedModelResponse)
async def set_archived_model(
    project_id: str,
    body: ArchivedModelRequest,
    request: Request,
    session: SessionDependency,
) -> ArchivedModelResponse:
    """Archive or un-archive one model for the project. Idempotent.

    The model travels in the body rather than the path because model ids can
    contain a provider prefix (``openai/gpt-5.1``), which no encoding makes
    safe in a path segment.

    Any string is accepted — there is no model table to validate against, and
    refusing a name that has no runs yet would just be a race with ingestion.
    """
    user_id = _authorize(session, project_id, request)
    model = body.model.strip()
    if not model:
        raise HTTPException(status_code=422, detail="Model is required")

    set_model_archived(
        session, project_id, model, archived=body.archived, user_id=user_id
    )
    session.commit()
    return ArchivedModelResponse(model=model, archived=body.archived)
