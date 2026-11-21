"""[W2-2] Institute-owner dashboard (FR-5.9; contract v3, API_CONTRACT.md):

- GET /api/owner/dashboard?institution_id -> OwnerDashboard; 404 unknown_institution

PoC: no login (the payload's role_note says so). Production: the owner role from the identity
provider and row-level security per institution.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

import owner
from database import get_db
from schemas import OwnerDashboard

router = APIRouter(tags=["Owner"])
DbSession = Annotated[Session, Depends(get_db)]


@router.get("/api/owner/dashboard", response_model=OwnerDashboard)
def owner_dashboard(db: DbSession, institution_id: int | None = None) -> OwnerDashboard:
    """Batches, faculty, tests, trend, weakest topics, operations and intervention effect for one
    institution (the first one when institution_id is omitted)."""
    return OwnerDashboard.model_validate(owner.dashboard(db, institution_id))
