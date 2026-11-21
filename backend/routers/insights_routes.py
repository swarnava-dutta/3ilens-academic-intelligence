"""[W2-3] Intervention log, effectiveness and what-if (contract v3, API_CONTRACT.md):

- POST   /api/interventions (InterventionInput) -> 201 InterventionRecord
- GET    /api/interventions?batch_id&student_ref&submission_id&institution_id -> InterventionRecord[]
- DELETE /api/interventions/{id} -> 204
- GET    /api/interventions/effectiveness?batch_id&institution_id -> InterventionEffectiveness
- POST   /api/whatif (WhatIfInput) -> WhatIfResult
- GET    /api/whatif/options?batch_id&institution_id -> WhatIfOptions
"""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()
