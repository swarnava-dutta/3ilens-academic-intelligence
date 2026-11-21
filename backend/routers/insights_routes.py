"""Intervention log, effectiveness and what-if (contract v3, API_CONTRACT.md):

- POST   /api/interventions (InterventionInput) -> 201 InterventionRecord
         404 unknown_submission / 409 invalid_state / 422 unknown_topic / 422 invalid_applied_at
- GET    /api/interventions?batch_id&student_ref&submission_id&institution_id -> InterventionRecord[]
- DELETE /api/interventions/{id} -> 204 (404 unknown_intervention)
- GET    /api/interventions/effectiveness?batch_id&institution_id -> InterventionEffectiveness
- POST   /api/whatif (WhatIfInput) -> WhatIfResult (404 unknown_batch / 422 no_results / 422 unknown_topic)
- GET    /api/whatif/options?batch_id&institution_id -> WhatIfOptions

Deterministic and illustrative; no AI call. Effectiveness is observational, never causal.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

import outcomes
import whatif
from database import get_db
from schemas import (
    InterventionEffectiveness,
    InterventionInput,
    InterventionRecordOut,
    WhatIfInput,
    WhatIfOptions,
    WhatIfResult,
)

router = APIRouter()
DbSession = Annotated[Session, Depends(get_db)]


@router.post("/api/interventions", response_model=InterventionRecordOut, status_code=201)
def create_intervention(body: InterventionInput, db: DbSession) -> InterventionRecordOut:
    """Log a teaching action on one student's topic; captures baseline mastery and the effort-model
    prediction now. Its outcome is read later from the student's next test covering the topic."""
    row = outcomes.record(db, body)
    return InterventionRecordOut.model_validate(outcomes.record_out(db, row))


@router.get("/api/interventions", response_model=list[InterventionRecordOut])
def list_interventions(
    db: DbSession,
    batch_id: int | None = None,
    student_ref: str | None = None,
    submission_id: int | None = None,
    institution_id: int | None = None,
) -> list[InterventionRecordOut]:
    """Intervention records, newest applied first, each with its outcome status."""
    rows = outcomes.records_out(
        db, batch_id=batch_id, student_ref=student_ref, submission_id=submission_id, institution_id=institution_id
    )
    return [InterventionRecordOut.model_validate(r) for r in rows]


@router.get("/api/interventions/effectiveness", response_model=InterventionEffectiveness)
def intervention_effectiveness(
    db: DbSession, batch_id: int | None = None, institution_id: int | None = None
) -> InterventionEffectiveness:
    """Treated vs untreated topics of the same students (observational - not causal)."""
    return InterventionEffectiveness.model_validate(
        outcomes.effectiveness(db, institution_id=institution_id, batch_id=batch_id)
    )


@router.delete("/api/interventions/{intervention_id}", status_code=204)
def delete_intervention(intervention_id: int, db: DbSession) -> Response:
    outcomes.delete(db, intervention_id)
    return Response(status_code=204)


@router.post("/api/whatif", response_model=WhatIfResult)
def run_whatif(body: WhatIfInput, db: DbSession) -> WhatIfResult:
    """Illustrative effort-response projection for extra study hours on 1-5 topics."""
    return WhatIfResult.model_validate(whatif.run(db, body))


@router.get("/api/whatif/options", response_model=WhatIfOptions)
def whatif_options(db: DbSession, batch_id: int | None = None, institution_id: int | None = None) -> WhatIfOptions:
    return WhatIfOptions.model_validate(whatif.options(db, batch_id=batch_id, institution_id=institution_id))
