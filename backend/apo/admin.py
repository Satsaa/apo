"""Operator commands run against the control plane's database.

    python -m apo.admin create-api-key --project ID --name NAME [--scope ingest|full] [--created-by USER]

``create-api-key`` mints a project API key exactly as ``POST /v1/api-keys``
does and prints one JSON object on stdout:

    {"public_key": "pk-apo-…", "secret_key": "sk-apo-…", "name": …, "project": …, "scope": …}

The secret is shown only here. A key acts as the user who created it, whose
project membership is rechecked on every request, so ``--created-by`` (a user
id or email) must be a member of the project; it defaults to the project's
first owner. Errors go to stderr with a nonzero exit.
"""

# pyright: reportAny=false

from __future__ import annotations

import argparse
import json
import sys
from typing import get_args

from fastapi import HTTPException
from sqlmodel import Session, col, select

from .db import engine
from .models.db import ProjectDB, ProjectMembershipDB, UserDB
from .services.demo_workspace import DEMO_PROJECT_ID
from .services.project_api_keys import ApiKeyScope, create_project_api_key
from .services.project_memberships import require_project_role


class AdminError(Exception):
    """A refusal reported to the operator as ``error: …`` with exit status 1."""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="apo.admin",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    create = sub.add_parser("create-api-key", help="Mint a project API key and print it as JSON")
    _ = create.add_argument("--project", required=True, metavar="ID", help="Project id")
    _ = create.add_argument("--name", required=True, help="Key name shown in the dashboard")
    _ = create.add_argument(
        "--scope",
        choices=get_args(ApiKeyScope.__value__),
        default="ingest",
        help="Key scope (default: ingest, as in the dashboard)",
    )
    _ = create.add_argument(
        "--created-by",
        default=None,
        metavar="USER",
        help="User id or email the key acts as (default: the project's first owner)",
    )

    args = parser.parse_args(argv)
    try:
        if args.command == "create-api-key":
            return cmd_create_api_key(
                project=str(args.project),
                name=str(args.name),
                scope=args.scope,
                created_by=args.created_by,
            )
    except AdminError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 2


def cmd_create_api_key(
    *, project: str, name: str, scope: ApiKeyScope, created_by: str | None
) -> int:
    with Session(engine) as session:
        if project == DEMO_PROJECT_ID:
            raise AdminError("the demo project is read-only")
        if session.get(ProjectDB, project) is None:
            raise AdminError(f"project {project!r} not found")
        user_id = (
            _project_member(session, project, created_by)
            if created_by is not None
            else _first_owner(session, project)
        )
        minted = create_project_api_key(
            session, project=project, name=name, scope=scope, created_by=user_id
        )
        print(
            json.dumps(
                {
                    "public_key": minted.public_key,
                    "secret_key": minted.secret_key,
                    "name": minted.row.name,
                    "project": minted.row.project,
                    "scope": minted.row.scope,
                }
            )
        )
    return 0


def _first_owner(session: Session, project: str) -> str:
    owner = session.exec(
        select(ProjectMembershipDB)
        .where(ProjectMembershipDB.project_id == project, ProjectMembershipDB.role == "owner")
        .order_by(col(ProjectMembershipDB.created_at), col(ProjectMembershipDB.id))
    ).first()
    if owner is None:
        raise AdminError(f"project {project!r} has no owner; pass --created-by")
    return owner.user_id


def _project_member(session: Session, project: str, user: str) -> str:
    """Resolve ``user`` (id or email) to a member of ``project`` able to run tasks."""
    row = session.get(UserDB, user) or session.exec(
        select(UserDB).where(UserDB.email == user)
    ).first()
    if row is None:
        raise AdminError(f"user {user!r} not found")
    try:
        _ = require_project_role(session, project, row.id, minimum_role="member")
    except HTTPException as refusal:
        raise AdminError(f"user {user!r} cannot act in project {project!r}: {refusal.detail}") from None
    return row.id


if __name__ == "__main__":
    sys.exit(main())
