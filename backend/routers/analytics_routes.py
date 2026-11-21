"""[WP1] Analytics endpoints (see routers/__init__.py and API_CONTRACT.md).

- GET   /api/results/{id}/plan              what-if study plan (ROI engine v2, illustrative)
- GET   /api/weightage?exam=NEET            the illustrative chapter-weightage matrix
- GET   /api/exams                          target exams (only NEET has a matrix in this PoC)
- PATCH /api/batches/{id}                   exam / exam date (null = the assumed NEET_EXAM_DATE)
- POST  /api/results/{id}/consistency-check FR-3.5 re-grade (one live Claude call), tolerance +/-2
- POST  /api/rubrics/parse                  FR-3.4 rubric draft from text / PDF / DOCX / JSON
- POST  /api/rubrics                        save a rubric (AUTHOR_DRAFT or FACULTY_APPROVED)
"""
from __future__ import annotations

import json
import logging
from datetime import date
from pathlib import Path
from typing import Annotated, Any

import pymupdf
from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from pydantic import ValidationError
from sqlalchemy.orm import Session, selectinload

import ai
import analytics
import docx_reader
import insights
import pipeline
import provenance
import result_view
import rubric_store
from ai_schemas import ModelUsage, OcrAnswer, OcrResult
from config import get_settings
from database import (
    Batch,
    Rubric,
    RubricStatus,
    StudentSubmission,
    get_db,
    ist_today,
    utcnow,
)
from errors import ApiError
from schemas import (
    BatchOut,
    BatchPatchInput,
    ConsistencyCheck,
    ConsistencyDelta,
    ExamOption,
    RubricContentIn,
    RubricCreateInput,
    RubricDraft,
    RubricOut,
    StudyPlan,
    WeightageMatrix,
)

logger = logging.getLogger("3ilens.analytics")

router = APIRouter()
DbSession = Annotated[Session, Depends(get_db)]

CONSISTENCY_TOLERANCE = 2.0  # marks (FR-3.5)
CONSISTENCY_FILE = "consistency.json"
TRANSCRIPT_FILES = ("ocr_reviewed.json", "ocr.json")  # faculty-reviewed transcript first
MIN_PDF_TEXT_CHARS = 200  # a PDF with at least this much text is sent as text, else as a scan
MAX_RUBRIC_PDF_PAGES = 40
ZIP_MAGIC = b"PK\x03\x04"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _submission(db: Session, submission_id: int) -> StudentSubmission:
    sub = db.get(
        StudentSubmission,
        submission_id,
        options=[selectinload(StudentSubmission.result), selectinload(StudentSubmission.rubric)],
    )
    if sub is None:
        raise ApiError(404, f"Submission {submission_id} not found.", "not_found")
    return sub


def _require_completed(sub: StudentSubmission) -> None:
    if not result_view.is_completed(sub):
        raise ApiError(
            409, f"Submission {sub.id} is {sub.status}; this action needs a COMPLETED result.", "invalid_state"
        )


def _ai_not_configured(what: str) -> ApiError:
    return ApiError(
        503,
        f"{what} needs ANTHROPIC_API_KEY. Add it to the .env file in the project root and restart the backend.",
        "ai_not_configured",
    )


def _record_usages(db: Session, usages: list[ModelUsage], submission: StudentSubmission | None) -> None:
    """Persist one model_invocations row per provider call (cost tracking); never fails the request."""
    for usage in usages:
        try:
            provenance.record_invocation(db, usage=usage, submission=submission)
        except Exception:  # noqa: BLE001
            logger.exception("Could not record a %s model invocation", usage.purpose)
    try:
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("Could not commit model invocation rows")


def _format_validation(exc: ValidationError, limit: int = 5) -> str:
    parts = []
    for err in exc.errors(include_url=False, include_input=False)[:limit]:
        loc = ".".join(str(piece) for piece in err.get("loc", ())) or "rubric"
        parts.append(f"{loc}: {str(err.get('msg', 'invalid value')).removeprefix('Value error, ')}")
    extra = exc.error_count() - limit
    return "; ".join(parts) + (f" (+{extra} more)" if extra > 0 else "")


def _ai_failure(exc: ai.AIServiceError) -> ApiError:
    return ApiError(502, str(exc), exc.code or "ai_error")


# --------------------------------------------------------------------------- #
# Study plan, weightage, exams, batch
# --------------------------------------------------------------------------- #
@router.get("/api/results/{submission_id}/plan", response_model=StudyPlan)
def get_study_plan(
    submission_id: int,
    db: DbSession,
    days_to_exam: Annotated[int | None, Query(ge=0, le=400)] = None,
    study_hours: Annotated[float | None, Query(ge=1, le=80)] = None,
) -> StudyPlan:
    """What-if study plan: days_to_exam / study_hours override the batch exam date and
    STUDY_HOURS_PER_WEEK. Deterministic and illustrative (no AI call)."""
    sub = _submission(db, submission_id)
    _require_completed(sub)
    plan = analytics.build_study_plan(
        result=sub.result, rubric=sub.rubric, batch=sub.batch, days_to_exam=days_to_exam, study_hours=study_hours
    )
    return StudyPlan.model_validate(plan)


@router.get("/api/weightage", response_model=WeightageMatrix)
def get_weightage(exam: str = "NEET") -> WeightageMatrix:
    matrix = analytics.load_matrix(exam)
    if matrix is None:
        raise ApiError(
            404, f"No weightage matrix is loaded for '{exam}' in this PoC (only NEET).", "exam_not_available"
        )
    return WeightageMatrix.model_validate(matrix)


@router.get("/api/exams", response_model=list[ExamOption])
def list_exams() -> list[ExamOption]:
    return [ExamOption.model_validate(option) for option in analytics.exam_options()]


@router.patch("/api/batches/{batch_id}", response_model=BatchOut)
def patch_batch(batch_id: int, body: BatchPatchInput, db: DbSession) -> BatchOut:
    """Set the target exam, exam date and/or faculty lead. exam_date null resets to the assumed
    default (NEET_EXAM_DATE); a date must be ISO (YYYY-MM-DD) and not in the past. faculty_lead
    null (or blank) clears it (max 120 characters, whitespace normalised)."""
    batch = db.get(Batch, batch_id)
    if batch is None:
        raise ApiError(404, f"Batch {batch_id} not found.", "unknown_batch")
    fields = body.model_fields_set
    if "exam" in fields and body.exam is not None:
        wanted = " ".join(body.exam.split())
        enabled = {o["exam"].casefold(): o["exam"] for o in analytics.exam_options() if o["enabled"]}
        if wanted.casefold() not in enabled:
            raise ApiError(
                422, f"Exam '{wanted}' is not available in this PoC (matrix not loaded); use NEET.",
                "exam_not_available",
            )
        batch.exam = enabled[wanted.casefold()]
    if "exam_date" in fields:
        if body.exam_date is None or not body.exam_date.strip():
            batch.exam_date = None  # back to the assumed NEET_EXAM_DATE
        else:
            raw = body.exam_date.strip()
            try:
                parsed = date.fromisoformat(raw)
            except ValueError:
                parsed = None
            if parsed is None or len(raw) != 10:
                raise ApiError(422, f"exam_date must be an ISO date (YYYY-MM-DD), got '{raw}'.", "invalid_date")
            if parsed < ist_today():
                raise ApiError(422, f"exam_date {raw} is in the past.", "invalid_date")
            batch.exam_date = parsed.isoformat()
    if "faculty_lead" in fields:
        batch.faculty_lead = body.faculty_lead or None  # normalised by the schema; null / blank clears it
    db.commit()
    db.refresh(batch)
    return result_view.batch_out(batch)


# --------------------------------------------------------------------------- #
# Consistency check (FR-3.5)
# --------------------------------------------------------------------------- #
def _artifact_dir(sub: StudentSubmission) -> Path:
    return get_settings().artifact_dir / str(sub.id)


def _consistency_answers(sub: StudentSubmission) -> tuple[list[OcrAnswer], str]:
    """The transcript the stored result was graded from: the faculty-reviewed or raw OCR artifact,
    else the student answers stored on the result (demo / legacy rows)."""
    directory = _artifact_dir(sub)
    for name in TRANSCRIPT_FILES:
        try:
            data = json.loads((directory / name).read_text(encoding="utf-8"))
            return OcrResult.model_validate(data).answers, name
        except (OSError, ValueError, ValidationError):
            continue
    answers = []
    for item in sub.result.question_evaluations or []:
        if not isinstance(item, dict):
            continue
        text = str(item.get("student_answer") or "").strip()
        number = insights._as_int(item.get("question"))
        if text and number is not None:
            answers.append(
                OcrAnswer(question=number, answer=text, confidence=insights._clamp01(item.get("confidence")))
            )
    return answers, "stored answers"


def _compare(sub: StudentSubmission, rubric_content: dict, evaluation: Any) -> list[ConsistencyDelta]:
    original = {
        insights._as_int(q.get("question")): float(q.get("estimated_marks") or 0)
        for q in sub.result.question_evaluations or []
        if isinstance(q, dict)
    }
    grades = {g.question: g.estimated_marks for g in evaluation.evaluations}
    deltas = []
    for q in sorted(rubric_content.get("questions") or [], key=lambda item: insights._as_int(item.get("question")) or 0):
        number = insights._as_int(q.get("question"))
        if number is None:
            continue
        max_marks = float(q.get("max_marks") or 0)
        regrade = insights.bounded_marks(grades.get(number, 0.0), max_marks) if max_marks > 0 else 0.0
        before = original.get(number, 0.0)
        deltas.append(
            ConsistencyDelta(question=number, original=before, regrade=regrade, delta=round(regrade - before, 2))
        )
    return deltas


@router.post("/api/results/{submission_id}/consistency-check", response_model=ConsistencyCheck)
def consistency_check(submission_id: int, db: DbSession) -> ConsistencyCheck:
    """Re-grade the stored transcript once (purpose 'consistency') and compare per-question marks
    with the stored result; within tolerance when the totals differ by at most 2 marks."""
    sub = _submission(db, submission_id)
    _require_completed(sub)
    if not get_settings().anthropic_api_key:
        raise _ai_not_configured("The consistency re-grade")
    rubric = sub.rubric
    content = rubric.content or {}
    answers, source = _consistency_answers(sub)
    usages: list[ModelUsage] = []
    try:
        evaluation = ai.run_evaluation(answers, content, on_usage=usages.append, purpose="consistency")
    except ai.AIConfigurationError as exc:
        raise ApiError(503, str(exc), "ai_not_configured") from exc
    except ai.AIServiceError as exc:
        raise _ai_failure(exc) from exc
    finally:
        _record_usages(db, usages, sub)

    deltas = _compare(sub, content, evaluation)
    total_original = round(float(sub.result.total_score or 0), 2)
    total_regrade = round(sum(d.regrade for d in deltas), 2)
    delta_total = round(total_regrade - total_original, 2)
    check = ConsistencyCheck(
        submission_id=sub.id,
        runs=1,
        tolerance=CONSISTENCY_TOLERANCE,
        total_original=total_original,
        total_regrade=total_regrade,
        max_abs_delta_total=abs(delta_total),
        within_tolerance=abs(delta_total) <= CONSISTENCY_TOLERANCE,
        deltas=deltas,
        checked_at=utcnow(),
    )
    try:
        directory = _artifact_dir(sub)
        directory.mkdir(parents=True, exist_ok=True)
        payload = {**check.model_dump(mode="json"), "transcript_source": source, "rubric_id": rubric.id,
                   "rubric_version": rubric.version, "prompt_version": ai.EVALUATION_PROMPT_VERSION}
        (directory / CONSISTENCY_FILE).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except OSError:
        logger.exception("Could not write %s for submission %s", CONSISTENCY_FILE, sub.id)
    verdict = (
        f"within +/-{CONSISTENCY_TOLERANCE:g}" if check.within_tolerance
        else f"outside +/-{CONSISTENCY_TOLERANCE:g} - review the grading before release"
    )
    pipeline.append_log(
        sub, "Consistency check",
        f"Re-grade delta {abs(delta_total):g} marks ({total_regrade:g} vs {total_original:g}) - {verdict}.",
    )
    db.commit()
    return check


# --------------------------------------------------------------------------- #
# Rubric drafting (FR-3.4) and creation
# --------------------------------------------------------------------------- #
def _read_upload(file: UploadFile) -> bytes:
    limit = get_settings().max_upload_bytes
    data = file.file.read(limit + 1)
    if len(data) > limit:
        raise ApiError(413, f"File is larger than the {limit // (1024 * 1024)} MB limit.", "too_large")
    return data


def _decode_text(data: bytes) -> str:
    if b"\x00" in data[:4096]:
        raise ApiError(415, "Unsupported file type: upload a PDF, Word (.docx), JSON or text file.",
                       "unsupported_signature")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ApiError(415, "Unsupported file type: upload a PDF, Word (.docx), JSON or text file.",
                       "unsupported_signature") from exc


def _pdf_source(data: bytes) -> tuple[str | None, bytes | None]:
    """(text, None) for a PDF with a text layer, (None, pdf bytes) for a scanned one."""
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001 - pymupdf raises several types for corrupt files
        raise ApiError(422, "The PDF could not be opened - it may be corrupt.", "corrupt_pdf") from exc
    try:
        if doc.needs_pass:
            raise ApiError(422, "The PDF is password-protected. Upload an unlocked copy.", "password_pdf")
        if doc.page_count == 0:
            raise ApiError(422, "The PDF has no pages.", "no_pages")
        if doc.page_count > MAX_RUBRIC_PDF_PAGES:
            raise ApiError(
                422, f"The PDF has {doc.page_count} pages; the limit for rubric drafting is {MAX_RUBRIC_PDF_PAGES}.",
                "too_many_pages",
            )
        text = "\n".join(page.get_text() for page in doc).strip()
    finally:
        doc.close()
    if len(text) >= MIN_PDF_TEXT_CHARS:
        return text, None
    return None, data


def _json_rubric(text: str) -> dict[str, Any] | None:
    """A JSON rubric parsed locally (no AI), or None when the text is not JSON."""
    stripped = text.strip()
    if not stripped.startswith("{"):
        return None
    try:
        data = json.loads(stripped)
    except ValueError as exc:
        raise ApiError(422, f"The rubric JSON is not valid JSON: {exc}", "invalid_rubric") from exc
    if not isinstance(data, dict):
        raise ApiError(422, "The rubric JSON must be an object with name and questions.", "invalid_rubric")
    try:
        return RubricContentIn.model_validate(data).model_dump(exclude_none=True)
    except ValidationError as exc:
        raise ApiError(422, f"The rubric JSON is invalid: {_format_validation(exc)}", "invalid_rubric") from exc


@router.post("/api/rubrics/parse", response_model=RubricDraft)
def parse_rubric(
    db: DbSession,
    file: Annotated[UploadFile | None, File()] = None,
    text: Annotated[str | None, Form()] = None,
    subject: Annotated[str | None, Form(max_length=100)] = None,
    exam: Annotated[str | None, Form(max_length=50)] = None,
) -> RubricDraft:
    """Draft a rubric. JSON is validated locally (no AI). A PDF with a text layer, a DOCX or plain
    text is sent to Claude as text; a scanned PDF as a document block. AI-drafted expected answers
    are listed in ai_drafted_questions and must be reviewed before the rubric is approved."""
    source: str = "text"
    source_text: str | None = None
    pdf_bytes: bytes | None = None
    data = _read_upload(file) if file is not None else b""
    if data:
        if data.startswith(b"%PDF"):
            source = "pdf"
            source_text, pdf_bytes = _pdf_source(data)
        elif data.startswith(ZIP_MAGIC):
            kind = docx_reader.package_kind(data) if hasattr(docx_reader, "package_kind") else "docx"
            if kind == "zip":
                raise ApiError(415, "Unsupported file type: upload a PDF, Word (.docx), JSON or text file.",
                               "unsupported_signature")
            try:
                docx_reader.validate_docx(data)
                source_text = docx_reader.docx_text(data)
            except docx_reader.DocxError as exc:
                raise ApiError(422, str(exc), exc.code) from exc
            source = "docx"
        else:
            source_text = _decode_text(data)
    elif text is not None:
        source_text = text

    if pdf_bytes is None:
        source_text = (source_text or "").strip()
        if not source_text:
            raise ApiError(
                422, "Nothing to draft from: upload a question paper / marking scheme or paste its text.",
                "empty_rubric_source",
            )
        local = _json_rubric(source_text)
        if local is not None:
            return RubricDraft(draft=local, warnings=ai.rubric_draft_warnings(local), source="json",
                               ai_drafted_questions=[])
        if len(source_text) > ai.MAX_RUBRIC_SOURCE_CHARS:
            raise ApiError(
                422, f"The rubric source is too long ({len(source_text):,} characters; the limit is "
                f"{ai.MAX_RUBRIC_SOURCE_CHARS:,}). Split the paper and draft it in parts.", "rubric_source_too_long",
            )

    if not get_settings().anthropic_api_key:
        raise _ai_not_configured("AI rubric drafting (paste a JSON rubric to skip AI)")
    usages: list[ModelUsage] = []
    try:
        result = ai.parse_rubric(
            text=source_text if pdf_bytes is None else None,
            pdf_bytes=pdf_bytes,
            subject_hint=subject,
            exam_hint=exam,
            on_usage=usages.append,
        )
    except ai.AIConfigurationError as exc:
        raise ApiError(503, str(exc), "ai_not_configured") from exc
    except ai.AIServiceError as exc:
        raise _ai_failure(exc) from exc
    except ValueError as exc:
        raise ApiError(422, str(exc), "empty_rubric_source") from exc
    finally:
        _record_usages(db, usages, None)
    return RubricDraft(
        draft=result["draft"], warnings=result["warnings"], source=source,
        ai_drafted_questions=result["ai_drafted_questions"],
    )


@router.post("/api/rubrics", response_model=RubricOut, status_code=201)
def create_rubric(body: RubricCreateInput, db: DbSession) -> RubricOut:
    """Save a rubric (e.g. a reviewed draft). approved -> FACULTY_APPROVED, else AUTHOR_DRAFT;
    parent_id makes it the next version (v{n+1}) of that rubric."""
    parent = None
    if body.parent_id is not None:
        parent = db.get(Rubric, body.parent_id)
        if parent is None:
            raise ApiError(404, f"Rubric {body.parent_id} not found.", "unknown_rubric")
    status = RubricStatus.FACULTY_APPROVED if body.approved else RubricStatus.AUTHOR_DRAFT
    rubric = rubric_store.create_rubric(db, body.content, parent=parent, change_note=body.change_note, status=status)
    db.commit()
    db.refresh(rubric)
    return result_view.rubric_out(rubric)
