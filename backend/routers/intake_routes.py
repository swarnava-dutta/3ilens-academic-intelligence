"""Intake helpers (see API_CONTRACT.md):

- POST /api/intake/inspect   multipart `file` (+ optional `rubric_id`) -> PaperInspection

Reads the file's text layer locally (no AI call, nothing stored) and says whether it looks like a
student's answer sheet, a printed MCQ paper or a question paper with its answer key, so the intake
page can offer "draft the rubric from it" before anything is uploaded. Same size, type and
decoding checks as POST /api/upload; a PDF over the page limit is still described (200 with
within_page_limit=false).

With rubric_id, a printed paper (paper_detect.printed_paper: its text layer has printed questions
with option lists) is also checked against that rubric (rubric_match: same paper and version?
paper_match) - null otherwise, also for a typed answer sheet. The verdict is the pipeline's
(paper_detect.rubric_check): the printed-question comparison when it holds or finds the rubric's
questions on the paper; else, when it cannot tell, a printed paper with far more numbered questions
than a non-MCQ rubric has questions is reported as a mismatch (paper_match.shape_check, a factual
message - nothing has been uploaded yet). rubric_id errors use the upload's codes: 422
invalid_rubric (not an integer), 422 unknown_rubric.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, UploadFile
from sqlalchemy.orm import Session

import paper_detect
from config import get_settings
from database import Rubric, get_db
from errors import ApiError
from schemas import PaperInspection

router = APIRouter(tags=["Intake"])
DbSession = Annotated[Session, Depends(get_db)]


def _rubric(db: Session, rubric_id: str | None) -> Rubric | None:
    if rubric_id is None or not rubric_id.strip():
        return None
    try:
        rid = int(rubric_id.strip())
    except ValueError as exc:
        raise ApiError(422, "rubric_id must be an integer.", "invalid_rubric") from exc
    rubric = db.get(Rubric, rid)
    if rubric is None:
        raise ApiError(422, f"Rubric {rid} does not exist.", "unknown_rubric")
    return rubric


@router.post("/api/intake/inspect", response_model=PaperInspection)
def inspect_intake_file(
    db: DbSession,
    file: Annotated[UploadFile | None, File()] = None,
    rubric_id: Annotated[str | None, Form()] = None,
) -> PaperInspection:
    settings = get_settings()
    if file is None or not file.filename:
        raise ApiError(422, "Attach the file to inspect.", "missing_file")
    rubric = _rubric(db, rubric_id)
    limit = settings.max_upload_bytes
    if file.size is not None and file.size > limit:
        raise ApiError(413, f"File is larger than the {settings.max_upload_mb} MB limit.", "too_large")
    data = file.file.read(limit + 1)
    if len(data) > limit:
        raise ApiError(413, f"File is larger than the {settings.max_upload_mb} MB limit.", "too_large")
    inspection, texts = paper_detect.inspect_document(data, settings)
    if rubric is not None:
        # None unless a printed paper: a typed answer sheet's text would read as a different paper.
        match = paper_detect.rubric_check(
            inspection, texts, rubric.content, rubric_label=f"'{rubric.name}' ({rubric.version})"
        )
        if match is not None:
            inspection = inspection.model_copy(update={"rubric_match": match})
    return inspection
