"""[W2-2] Read-only LMS export with hashed API keys (contract v3, API_CONTRACT.md):

- key management (local admin): GET /api/lms/info, GET/POST /api/lms/keys, POST /api/lms/keys/{id}/revoke
- export (header X-API-Key): GET /api/lms/v1/batches, /students, /results, /results.csv, /topic-mastery.csv
"""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(tags=["LMS export (read-only)"])
