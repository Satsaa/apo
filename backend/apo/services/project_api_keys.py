"""Minting a project's public/secret API key pair.

Shared by ``POST /v1/api-keys`` and ``python -m apo.admin create-api-key``:
both authorize their caller their own way, then create the key here, so a key
from either is the same row.
"""

import os
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from sqlmodel import Session

from ..auth.api_key_auth import generate_key_pair
from ..models.db import ApiKeyDB

type ApiKeyScope = Literal["full", "ingest"]


@dataclass(frozen=True)
class MintedApiKey:
    row: ApiKeyDB
    public_key: str
    secret_key: str  # plaintext; shown once, only its hash is stored
    display_secret_key: str


def _default_daily_span_quota() -> int | None:
    """``APO_DEFAULT_DAILY_SPAN_QUOTA`` for new keys; unset, invalid or 0 is unlimited."""
    try:
        quota = int(os.environ.get("APO_DEFAULT_DAILY_SPAN_QUOTA", "0"))
    except ValueError:
        return None
    return quota if quota > 0 else None


def create_project_api_key(
    session: Session,
    *,
    project: str,
    name: str,
    scope: ApiKeyScope,
    created_by: str,
    expires_at: datetime | None = None,
    daily_span_quota: int | None = None,
) -> MintedApiKey:
    """Create and commit a ``pk-apo-…``/``sk-apo-…`` key for ``project``.

    The key acts as ``created_by``, whose project membership is rechecked on
    every request, so callers must pass a member of ``project``. An explicit
    ``daily_span_quota`` wins; otherwise the environment default applies to
    new keys only.
    """
    public_key, secret_key, hashed_secret_key, display_secret_key = generate_key_pair()
    api_key = ApiKeyDB(
        name=name,
        prefix=public_key[:8],
        public_key=public_key,
        hashed_secret_key=hashed_secret_key,
        display_secret_key=display_secret_key,
        project=project,
        created_by=created_by,
        scope=scope,
        expires_at=expires_at,
        daily_span_quota=daily_span_quota if daily_span_quota is not None else _default_daily_span_quota(),
    )
    session.add(api_key)
    session.commit()
    session.refresh(api_key)
    return MintedApiKey(
        row=api_key,
        public_key=public_key,
        secret_key=secret_key,
        display_secret_key=display_secret_key,
    )
