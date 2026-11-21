"""[W2-2] Institute-owner dashboard (contract v3, API_CONTRACT.md):

- GET /api/owner/dashboard?institution_id -> OwnerDashboard; 404 unknown_institution
"""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()
