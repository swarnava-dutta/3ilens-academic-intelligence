"""Intake helpers (see API_CONTRACT.md):

- POST /api/intake/inspect   multipart `file` -> PaperInspection

Reads the file's text layer locally (no AI call, nothing stored) and says whether it looks like a
student's answer sheet, a printed MCQ paper or a question paper with its answer key, so the intake
page can offer "draft the rubric from it" before anything is uploaded. Same size, type and
decoding checks as POST /api/upload; a PDF over the page limit is still described (200 with
within_page_limit=false).
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, File, UploadFile

import paper_detect
from config import get_settings
from errors import ApiError
from schemas import PaperInspection

router = APIRouter(tags=["Intake"])


@router.post("/api/intake/inspect", response_model=PaperInspection)
def inspect_intake_file(file: Annotated[UploadFile | None, File()] = None) -> PaperInspection:
    settings = get_settings()
    if file is None or not file.filename:
        raise ApiError(422, "Attach the file to inspect.", "missing_file")
    limit = settings.max_upload_bytes
    if file.size is not None and file.size > limit:
        raise ApiError(413, f"File is larger than the {settings.max_upload_mb} MB limit.", "too_large")
    data = file.file.read(limit + 1)
    if len(data) > limit:
        raise ApiError(413, f"File is larger than the {settings.max_upload_mb} MB limit.", "too_large")
    return paper_detect.inspect_bytes(data, settings)
