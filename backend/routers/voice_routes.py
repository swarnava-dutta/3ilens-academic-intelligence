"""[W2-2] Voice answers (FR-2.8; contract v3, API_CONTRACT.md):

- GET /api/submissions/{id}/audio      -> audio bytes (inline); 404 no_audio
- GET /api/submissions/{id}/transcript -> VoiceTranscript; 404 no_transcript

The audio is served only for voice submissions whose stored file lies inside UPLOAD_DIR (resolved
path check), never an arbitrary path. Sample / demo voice rows have no audio file (404 no_audio)
and a synthetic transcript built from the stored answer text.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session, selectinload

import voice
from database import StudentSubmission, get_db
from errors import ApiError
from schemas import VoiceTranscript

router = APIRouter(tags=["Voice answers"])
DbSession = Annotated[Session, Depends(get_db)]


def _submission(db: Session, submission_id: int) -> StudentSubmission:
    sub = db.get(StudentSubmission, submission_id, options=[selectinload(StudentSubmission.result)])
    if sub is None:
        raise ApiError(404, f"Submission {submission_id} not found.", "not_found")
    return sub


@router.get(
    "/api/submissions/{submission_id}/audio",
    response_class=FileResponse,
    responses={200: {"content": {"audio/mpeg": {}, "audio/wav": {}, "audio/mp4": {}, "audio/ogg": {}}},
               404: {"description": "Not a voice answer, or no audio file is stored (no_audio)"}},
)
def submission_audio(submission_id: int, db: DbSession) -> FileResponse:
    """The stored voice answer, inline (for an <audio> player)."""
    sub = _submission(db, submission_id)
    path = voice.audio_path(sub)
    if path is None:
        raise ApiError(404, f"Submission {submission_id} has no stored voice answer.", "no_audio")
    return FileResponse(
        path, media_type=sub.mime_type,
        headers={"Content-Disposition": "inline", "Cache-Control": "no-store"},
    )


@router.get("/api/submissions/{submission_id}/transcript", response_model=VoiceTranscript)
def submission_transcript(submission_id: int, db: DbSession) -> VoiceTranscript:
    """The speech-to-text transcript of a voice answer (synthetic for sample rows)."""
    sub = _submission(db, submission_id)
    data = voice.transcript_out(db, sub)
    if data is None:
        raise ApiError(404, f"Submission {submission_id} has no voice transcript.", "no_transcript")
    return VoiceTranscript.model_validate(data)
