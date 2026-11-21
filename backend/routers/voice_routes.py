"""[W2-2] Voice answers (contract v3, API_CONTRACT.md):

- GET /api/submissions/{id}/audio      -> audio bytes (inline); 404 no_audio
- GET /api/submissions/{id}/transcript -> VoiceTranscript; 404 no_transcript
"""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()
