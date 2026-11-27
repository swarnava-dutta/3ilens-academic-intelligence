"""Analytics endpoints (see routers/__init__.py and API_CONTRACT.md).

- GET   /api/results/{id}/plan              what-if study plan (ROI engine v2, illustrative)
- GET   /api/weightage?exam=NEET            the illustrative chapter-weightage matrix
- GET   /api/exams                          target exams (only NEET has a matrix in this PoC)
- PATCH /api/batches/{id}                   exam / exam date (null = the assumed NEET_EXAM_DATE)
- POST  /api/results/{id}/consistency-check FR-3.5 re-grade (one live Claude call), tolerance +/-2
- POST  /api/rubrics/parse                  FR-3.4 rubric draft from text / PDF / DOCX / JSON; a PDF of
                                            3+ pages (a full printed paper) is read as page images; an
                                            optional key_file (answer key) is applied to the draft;
                                            a key-only file and a paper may come in either order
- POST  /api/rubrics/answer-key             the answer key in a key-only file or pasted text (answer_keys)
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
from sqlalchemy.orm import Session

import ai
import analytics
import answer_keys
import docx_reader
import insights
import marking
import paper_detect
import paper_pages
import pipeline
import provenance
import result_view
import results_store
import rubric_store
import uploads
from ai_schemas import ModelUsage, OcrAnswer
from config import get_settings
from database import (
    Batch,
    Rubric,
    RubricStatus,
    StudentSubmission,
    append_log,
    get_db,
    ist_today,
    utcnow,
)
from errors import ApiError
from schemas import (
    AnswerKeyEntry,
    AnswerKeyExtraction,
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
MIN_PDF_TEXT_CHARS = 200  # a PDF with at least this much text is sent as text, else as a scan
MAX_RUBRIC_PDF_PAGES = 40
# A PDF with at least this many pages is a full printed paper: drafted from page images, a few
# pages per AI call (ai.parse_rubric_pages), whatever its text layer holds.
PAGED_RUBRIC_MIN_PAGES = 3
# ... when it is a printed paper: paper_detect sees a question paper (with or without a printed
# key), faculty say the ticks mark the key, or there is no usable text layer. A typed descriptive
# marking scheme with a text layer keeps the single text call.
PAGED_PAPER_ROLES = ("answer_key_paper", "question_paper")
SPARSE_PAGE_CHARS = 100  # a page with less text than this counts as scanned (no text layer)
PAGED_MIN_QUESTIONS = 30  # an unplaced layout with this many numbered questions is still paged
KEY_SOURCES = ("auto", "marks")  # rubric parse key_source: printed key / table / ticks, or "ticks are the key"
UNSUPPORTED_DETAIL = "Unsupported file type: upload a PDF, Word (.docx), JSON or text file."


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
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
    sub = result_view.get_submission(db, submission_id)
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
def _consistency_answers(sub: StudentSubmission) -> tuple[list[OcrAnswer], str]:
    """The transcript the stored result was graded from: the faculty-reviewed or raw OCR artifact,
    else the student answers stored on the result (demo / legacy rows)."""
    ocr, name, _raw = pipeline.stored_transcript(sub.id)
    if ocr is not None:
        return ocr.answers, name
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


def _compare(
    sub: StudentSubmission, rubric_content: dict, evaluation: Any, answers: list[OcrAnswer]
) -> list[ConsistencyDelta]:
    """Score the re-grade exactly like the original (marking.py): MCQs keep their deterministic
    +4/-1/0 marks from the transcript, descriptive questions apply the rubric's marking scheme."""
    original = {
        insights._as_int(q.get("question")): float(q.get("estimated_marks") or 0)
        for q in sub.result.question_evaluations or []
        if isinstance(q, dict)
    }
    grades = {g.question: g for g in evaluation.evaluations}
    texts = {a.question: a.answer for a in answers}
    policy = marking.policy_for(rubric_content)
    deltas = []
    for q in sorted(rubric_content.get("questions") or [], key=lambda item: insights._as_int(item.get("question")) or 0):
        number = insights._as_int(q.get("question"))
        if number is None:
            continue
        grade = grades.get(number)
        is_mcq = marking.question_type(q) == "mcq"
        if not is_mcq and (grade is None or float(q.get("max_marks") or 0) <= 0):
            regrade = 0.0
        else:
            regrade = float(marking.score_question(
                q,
                answer_text=texts.get(number, ""),
                estimated_marks=grade.estimated_marks if grade is not None else 0.0,
                criteria_awards=[a.model_dump() for a in grade.criteria_awards] if grade is not None else [],
                policy=policy,
            )["marks"])
        before = original.get(number, 0.0)
        deltas.append(
            ConsistencyDelta(question=number, original=before, regrade=regrade, delta=round(regrade - before, 2))
        )
    return deltas


@router.post("/api/results/{submission_id}/consistency-check", response_model=ConsistencyCheck)
def consistency_check(submission_id: int, db: DbSession) -> ConsistencyCheck:
    """Re-grade the stored transcript once (purpose 'consistency') and compare per-question marks
    with the stored result; within tolerance when the totals differ by at most 2 marks."""
    sub = result_view.get_submission(db, submission_id)
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

    deltas = _compare(sub, content, evaluation, answers)
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
        directory = results_store.job_dir(sub.id)
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
    append_log(
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


def _peek(file: UploadFile) -> bytes:
    """What _read_upload would read, with the file rewound for it (an oversize file is reported there)."""
    data = file.file.read(get_settings().max_upload_bytes + 1)
    file.file.seek(0)
    return data


def _pdf_source(data: bytes) -> tuple[str | None, bytes | None, int, list[str]]:
    """(text, None, pages, page texts) for a PDF with a text layer, (None, pdf bytes, pages, page
    texts) for a scanned one."""
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
        pages = doc.page_count
        page_texts = [page.get_text() for page in doc]
        text = "\n".join(page_texts).strip()
    finally:
        doc.close()
    if len(text) >= MIN_PDF_TEXT_CHARS:
        return text, None, pages, page_texts
    return None, data, pages, page_texts


def _sparse_text_layer(page_texts: list[str]) -> bool:
    """True when fewer than half of the pages carry real text (SPARSE_PAGE_CHARS non-space
    characters): a scan with only a cover page or a header typed in, whose text would hide most of
    the paper from a single text call."""
    if not page_texts:
        return True
    filled = sum(1 for text in page_texts if len("".join(str(text or "").split())) >= SPARSE_PAGE_CHARS)
    return filled * 2 < len(page_texts)


def _paged_paper(source_text: str | None, page_texts: list[str], pages: int, key_from_marks: bool) -> bool:
    """True when a PDF is drafted from page images (ai.parse_rubric_pages): PAGED_RUBRIC_MIN_PAGES or
    more pages AND one of: the ticks mark the key; no usable text layer, or text on fewer than half
    of its pages; paper_detect reads it as a printed question paper (with or without its key); or
    it has PAGED_MIN_QUESTIONS or more numbered questions in a layout paper_detect cannot place
    (a long paper would overflow a single call). Detection never fails the request: an error falls
    back to paged."""
    if pages < PAGED_RUBRIC_MIN_PAGES:
        return False
    if key_from_marks or source_text is None or _sparse_text_layer(page_texts):
        return True
    try:
        found = paper_detect.classify(page_texts, file_type="pdf", pages=pages, settings=get_settings())
    except Exception:  # noqa: BLE001 - a routing hint only
        logger.warning("Paper detection failed for a %d-page rubric PDF - drafting it from page images", pages)
        return True
    logger.info(
        "Rubric PDF (%d pages) detected as %s (%d numbered questions)", pages, found.role, found.numbered_questions
    )
    if not found.text_layer or found.role in PAGED_PAPER_ROLES:
        return True
    return found.role == "unknown" and found.numbered_questions >= PAGED_MIN_QUESTIONS


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
    key_source: Annotated[str | None, Form(max_length=20)] = None,
    key_file: Annotated[UploadFile | None, File()] = None,
) -> RubricDraft:
    """Draft a rubric. JSON is validated locally (no AI). key_source=marks: faculty confirm that the
    ticks / circles on a PDF mark the answer key (read from page images, never from the text layer).
    A PDF of PAGED_RUBRIC_MIN_PAGES or more pages that is a printed paper (paper_detect: question
    paper with or without its key; or key_source=marks; or no usable text layer) is read as page
    images a few pages per call. Any other PDF with a text layer (e.g. a typed descriptive marking
    scheme), a DOCX or plain text is sent to Claude as text, and a short scanned PDF as a document
    block. AI-drafted expected answers are listed in ai_drafted_questions and must be reviewed
    before the rubric is approved.

    key_file: an answer key in a separate file (answer_keys.extract), applied to the draft on every
    path (answer_keys.apply_to_draft); the first warning (after any "Fix before saving") sums it up.
    A key file that cannot be read leaves the draft as drafted, with a warning saying why. The two
    files may come in either order: when file looks like a key alone (_key_only_source, no AI) and
    key_file does not, they are swapped (files_swapped); when both do, file is drafted and key_file
    applied."""
    swapped = bool(file is not None and key_file is not None and _key_only_source(_peek(file), None)
                   and not _key_only_source(_peek(key_file), None))
    if swapped:
        file, key_file = key_file, file
    draft = _draft_rubric(db, file=file, text=text, subject=subject, exam=exam, key_source=key_source)
    if key_file is not None:
        draft = _apply_key_file(db, draft, key_file)
    return draft.model_copy(update={"files_swapped": swapped})


def _draft_rubric(
    db: Session,
    *,
    file: UploadFile | None,
    text: str | None,
    subject: str | None,
    exam: str | None,
    key_source: str | None,
) -> RubricDraft:
    key_mode = (key_source or "auto").strip().lower() or "auto"
    if key_mode not in KEY_SOURCES:
        raise ApiError(422, "key_source must be 'auto' or 'marks'.", "invalid_request")
    key_from_marks = key_mode == "marks"
    source: str = "text"
    source_text: str | None = None
    pdf_bytes: bytes | None = None
    data = _read_upload(file) if file is not None else b""
    if not key_from_marks:
        key_only = _key_only_draft(db, data, text, name=Path(file.filename or "").stem if file else "", subject=subject)
        if key_only is not None:
            return key_only
    if data:
        if data.startswith(b"%PDF"):
            source = "pdf"
            source_text, pdf_bytes, pages, page_texts = _pdf_source(data)
            if _paged_paper(source_text, page_texts, pages, key_from_marks):
                return _parse_paper_pages(db, data, subject=subject, exam=exam, key_from_marks=key_from_marks)
            if key_from_marks:  # ticks are only visible on the page images, not in the text layer
                source_text, pdf_bytes = None, data
        elif data.startswith(uploads.ZIP_SIGNATURE):
            if docx_reader.package_kind(data) == "zip":
                raise ApiError(415, UNSUPPORTED_DETAIL, "unsupported_signature")
            try:
                docx_reader.validate_docx(data)
                source_text = docx_reader.docx_text(data)
            except docx_reader.DocxError as exc:
                raise ApiError(422, str(exc), exc.code) from exc
            source = "docx"
        else:
            source_text = uploads.decode_text(data, UNSUPPORTED_DETAIL)
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
            key_from_marks=key_from_marks and pdf_bytes is not None,
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


# NEET section layouts by question count (subject, questions); other counts get one section.
_NEET_SECTIONS = {
    180: (("Physics", 45), ("Chemistry", 45), ("Biology", 90)),
    200: (("Physics", 50), ("Chemistry", 50), ("Biology", 100)),
}
KEY_ONLY_MIN_ENTRIES = 10
KEY_ONLY_MAX_CHARS_PER_ENTRY = 40  # a key is ~10 characters per entry; a question paper hundreds


def _key_only_source(data: bytes, text: str | None) -> str | None:
    """"image" / "pdf" / "docx" / "text" when a file (or, with no file, pasted text) looks like an
    answer key alone: an image (only ever a key here), or text in which answer_keys.parse_text finds
    KEY_ONLY_MIN_ENTRIES+ entries at no more than KEY_ONLY_MAX_CHARS_PER_ENTRY characters each.
    None for anything else or an unreadable file. No AI call."""
    if uploads.sniff_mime(data[:8192]) in uploads.PIL_FORMATS:
        return "image"
    try:
        if data.startswith(b"%PDF"):
            texts, source = answer_keys._pdf_page_texts(data), "pdf"
        elif data.startswith(uploads.ZIP_SIGNATURE):
            texts, source = [docx_reader.docx_text(data)], "docx"
        elif data:
            texts, source = [uploads.decode_text(data, UNSUPPORTED_DETAIL)], "text"
        else:
            texts, source = [text or ""], "text"
    except Exception:  # noqa: BLE001 - not readable here: the normal path reports it
        return None
    joined = "\n".join(texts)
    # ponytail: a scanned key (no text layer) still goes to the AI drafter; read it here too if that is common.
    # ponytail: key-only by density, not by question stems ("Que. 1 2 3 ..." rows on one line read as stems).
    found = len(answer_keys.parse_text(joined)[0])
    return source if KEY_ONLY_MIN_ENTRIES <= found and len(joined) <= KEY_ONLY_MAX_CHARS_PER_ENTRY * found else None


def _key_only_draft(
    db: Session, data: bytes, text: str | None, *, name: str, subject: str | None
) -> RubricDraft | None:
    """A file or pasted text that is only an answer key (numbers and options, no question text - a
    publisher's "Que. / Ans." grid, "1-B, 2-C", a key table) becomes an all-MCQ rubric straight from
    the key: one MCQ per number, 4 marks, -1 for a wrong answer, no AI drafting (the AI drafter
    would have no questions to read). None for anything with question text, or no readable key. A
    photo of a key (JPEG / PNG / WEBP) is read by answer_keys.extract (AI); its errors are raised,
    as no other path takes an image."""
    source = _key_only_source(data, text)  # free text check before any AI read
    if source is None:
        return None
    image = source == "image"
    usages: list[ModelUsage] = []
    try:
        extraction = answer_keys.extract(data or None, None if data else (text or ""), on_usage=usages.append)
    except (ApiError, ai.AIConfigurationError, ai.AIServiceError) as exc:
        if not image:
            return None
        if isinstance(exc, ApiError):
            raise
        if isinstance(exc, ai.AIServiceError):
            raise _ai_failure(exc) from exc
        raise _ai_not_configured("Reading an answer key from an image") from exc
    finally:
        _record_usages(db, usages, None)
    if len(extraction.entries) < KEY_ONLY_MIN_ENTRIES:
        if image:
            raise ApiError(422, answer_keys.NO_ANSWER_KEY, "no_answer_key")
        return None
    total = max(entry.question for entry in extraction.entries)
    sections = _NEET_SECTIONS.get(total) or (((subject or "").strip() or "General", total),)
    placeholders = [ai.UNTRANSCRIBED_OPTION.format(letter=letter) for letter in "ABCD"]
    questions, number = [], 1
    for section, count in sections:
        for number in range(number, number + count):
            questions.append({
                "question": number, "topic": section, "subject": section, "max_marks": 4, "question_type": "mcq",
                "options": list(placeholders), "expected_answer": "", "grading_criteria": ["4 marks: correct option"],
                "effort_hours": 1,
            })
        number += 1
    content = {
        "name": " ".join(name.replace("_", " ").replace("-", " ").split()) or "Answer key",
        "subject": "NEET" if total in _NEET_SECTIONS else sections[0][0],
        "questions": questions,
        "marking_policy": {"partial_credit": "all_or_nothing", "negative_marks": 1, "scheme_name": "+4 / -1"},
        "paper_code": extraction.paper_code,
    }
    content, warnings, _stats = answer_keys.apply_to_draft(content, [], extraction)
    note = (
        f"Built from the answer key alone: {total} MCQs, 4 marks each, -1 for a wrong answer"
        + (", topics by NEET section" if total in _NEET_SECTIONS else "")
        + " - no question text, so no AI drafting."
    )
    return RubricDraft(draft=content, warnings=[note, *warnings], source=source, ai_drafted_questions=[])


def _parse_paper_pages(
    db: Session, data: bytes, *, subject: str | None, exam: str | None, key_from_marks: bool = False
) -> RubricDraft:
    """A full printed paper: page images -> ai.parse_rubric_pages (parallel page chunks)."""
    if not get_settings().anthropic_api_key:
        raise _ai_not_configured("AI rubric drafting (paste a JSON rubric to skip AI)")
    try:
        pages = paper_pages.render_pdf_pages(data)
    except paper_pages.PaperPagesError as exc:
        raise ApiError(422, str(exc), exc.code) from exc
    usages: list[ModelUsage] = []
    try:
        result = ai.parse_rubric_pages(
            pages, subject_hint=subject, exam_hint=exam, on_usage=usages.append, key_from_marks=key_from_marks
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
        draft=result["draft"], warnings=result["warnings"], source="pdf",
        ai_drafted_questions=result["ai_drafted_questions"],
    )


def _apply_key_file(db: Session, draft: RubricDraft, key_file: UploadFile) -> RubricDraft:
    """The parse route's key_file applied to the draft; any failure becomes a warning."""
    usages: list[ModelUsage] = []
    reason: str | None = None
    extraction: AnswerKeyExtraction | None = None
    try:
        extraction = answer_keys.extract(_read_upload(key_file), None, on_usage=usages.append)
        if not extraction.entries:
            reason = answer_keys.NO_ANSWER_KEY
    except ApiError as exc:
        reason = str(exc.detail)
    except ai.AIConfigurationError:
        reason = "reading it from page images needs ANTHROPIC_API_KEY."
    except ai.AIServiceError as exc:
        reason = str(exc)
    except Exception:  # noqa: BLE001 - the draft is still returned
        logger.exception("Answer key file could not be read")
        reason = "it could not be read."
    finally:
        _record_usages(db, usages, None)
    if reason is not None or extraction is None:
        return draft.model_copy(update={"warnings": answer_keys.not_applied(draft.warnings, reason or "")})
    content, warnings, stats = answer_keys.apply_to_draft(draft.draft, draft.warnings, extraction)
    keyed = set(stats["keyed"])
    logger.info(
        "Answer key file (%s, %s): %d entries; %d set, %d changed, %d unchanged",
        extraction.source, extraction.method, len(extraction.entries), stats["set"], stats["changed"],
        stats["unchanged"],
    )
    return RubricDraft(
        draft=content, warnings=warnings, source=draft.source,
        ai_drafted_questions=[n for n in draft.ai_drafted_questions if n not in keyed],
    )


@router.post("/api/rubrics/answer-key", response_model=AnswerKeyExtraction)
def read_answer_key(
    db: DbSession,
    file: Annotated[UploadFile | None, File()] = None,
    text: Annotated[str | None, Form()] = None,
) -> AnswerKeyExtraction:
    """The answer key in a key-only file (PDF / DOCX / JPEG / PNG / WEBP / text, sniffed by its
    bytes) or pasted text: a table such as "1-2, 2-4" or "Q1 (B)", a "Que. / Ans." grid, or a
    question paper with "Ans." lines. Text is parsed with no AI call; a scanned PDF (or one whose
    text layer gives too few entries) and an image are read by Claude from page images. Nothing is
    stored; the client applies the entries to a rubric draft by question number."""
    data = _read_upload(file) if file is not None else None
    usages: list[ModelUsage] = []
    try:
        result = answer_keys.extract(data, text, on_usage=usages.append)
    except ai.AIConfigurationError as exc:
        raise _ai_not_configured("Reading an answer key from page images") from exc
    except ai.AIServiceError as exc:
        raise _ai_failure(exc) from exc
    finally:
        _record_usages(db, usages, None)
    accepted, bonus, special = answer_keys.special_entries(result)
    if not result.entries and not accepted and not bonus:
        raise ApiError(422, answer_keys.NO_ANSWER_KEY, "no_answer_key")
    # Send the multi-answer and bonus entries too (the client applies them like the parse route
    # does); their "set them by hand" warnings no longer apply.
    extra = [AnswerKeyEntry(question=n, accepted_options=letters) for n, letters in accepted.items()]
    extra += [AnswerKeyEntry(question=n, bonus=True) for n in bonus if n not in accepted]
    if not extra:
        return result
    return AnswerKeyExtraction(
        entries=sorted([*result.entries, *extra], key=lambda e: e.question),
        source=result.source, method=result.method, paper_code=result.paper_code,
        warnings=[w for w in result.warnings if w not in special],
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
