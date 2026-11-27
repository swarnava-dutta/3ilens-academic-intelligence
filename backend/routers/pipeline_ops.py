"""Pipeline operations (API_CONTRACT.md "Pipeline operations").

Student rename, DLQ re-drive, re-evaluation without OCR, faculty OCR review / rescan / re-run, page images, model
invocations, cost roll-ups, intake-batch progress, rubric versions and the previews of a rubric's
source files. Errors are coded (errors.ApiError); internal file paths never leave the server.

Every endpoint that queues a sheet again (retry, reevaluate, review, rescan, rerun) moves it to
PENDING with one conditional UPDATE (_claim: WHERE id AND status IN the allowed states) after its
checks pass and before it touches a file, so of two concurrent requests one wins and the other gets
409 invalid_state without side effects.
"""
from __future__ import annotations

import json
import logging
import math
import re
from pathlib import Path
from statistics import fmean
from typing import Annotated, Any, Literal, get_args

from fastapi import APIRouter, BackgroundTasks, Body, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image
from sqlalchemy import select, update
from sqlalchemy.orm import Session, selectinload

import ai
import hashing
import pipeline
import preprocessing
import provenance
import result_view
import results_store
import rubric_sources
import rubric_store
import uploads
import voice
from ai_schemas import OcrAnswer, OcrResult
from config import get_settings
from database import (
    INPUT_DOCUMENT,
    INPUT_VOICE,
    Batch,
    Institution,
    ModelInvocation,
    OcrReview,
    Rubric,
    StudentSubmission,
    SubmissionStatus,
    append_log,
    get_db,
    utc_iso,
    utcnow,
)
from errors import ApiError
from routers import preview_routes
from schemas import (
    IntakeBatchStatus,
    InvocationPurposeLit,
    InvocationStatusLit,
    ModelInvocationOut,
    OcrReviewData,
    OcrReviewOut,
    OpsCosts,
    PageRef,
    ReevaluateInput,
    RenameInput,
    RerunInput,
    ReviewActionLit,
    ReviewAnswer,
    ReviewInput,
    RubricCompatibility,
    RubricContentIn,
    RubricSourceFile,
    RubricVersionInput,
    RubricVersionResult,
    SubmissionOut,
)

logger = logging.getLogger("3ilens.pipeline_ops")

router = APIRouter()
DbSession = Annotated[Session, Depends(get_db)]

INTAKE_BATCH_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
PAGE_NUMBER_RE = re.compile(r"^\d{1,4}$")
PAGE_MEDIA_TYPES = {"png": "image/png", "jpg": "image/jpeg"}
INVOCATION_PURPOSES: tuple[str, ...] = get_args(InvocationPurposeLit)
INVOCATION_STATUSES: tuple[str, ...] = get_args(InvocationStatusLit)
# Artifacts that belong to one scan of the sheet (removed when a rescan replaces the file).
SCAN_ARTIFACTS = (
    pipeline.OCR_FILE, pipeline.REVIEWED_OCR_FILE, pipeline.EVALUATION_FILE, pipeline.REPORT_FILE,
    pipeline.RUN_FILE, pipeline.DEAD_LETTER_FILE, voice.TRANSCRIPT_FILE,
)
KIND_MISMATCH_DETAIL = "Upload the same kind of answer (voice or document) to replace this one."
DEFAULT_RESCAN_REVIEWER = "Faculty reviewer"
# Removed when a faculty re-run is accepted (ocr.json too when the rubric changes): approving the next
# hold must show the fresh OCR, and Retry after a restart (pipeline.last_run_mode prefers
# dead_letter.json, then run.json) must not re-grade the earlier run's transcript.
RERUN_ARTIFACTS = (pipeline.REVIEWED_OCR_FILE, pipeline.DEAD_LETTER_FILE, pipeline.RUN_FILE)
ACTIVE_STATUSES = (SubmissionStatus.PENDING, SubmissionStatus.PROCESSING)
HELD_OR_FAILED = (SubmissionStatus.HUMAN_REVIEW_REQUIRED, SubmissionStatus.FAILED)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _invalid_state(sub: StudentSubmission, needed: str) -> ApiError:
    return ApiError(409, f"Submission {sub.id} is {sub.status}; this action needs {needed}.", "invalid_state")


def _claim(db: Session, sub: StudentSubmission, allowed: tuple[SubmissionStatus, ...], needed: str) -> None:
    """Move the sheet to PENDING atomically - UPDATE ... WHERE id = :id AND status IN (allowed) - in
    the caller's transaction (the caller commits). 0 rows: another request queued or changed the
    sheet since it was read -> rollback and 409 invalid_state. Called once every check has passed and
    before any file is written or removed, so the request that loses the race changes nothing."""
    claimed = db.execute(
        update(StudentSubmission)
        .where(StudentSubmission.id == sub.id, StudentSubmission.status.in_([str(s) for s in allowed]))
        .values(status=SubmissionStatus.PENDING)
        .execution_options(synchronize_session=False)
    ).rowcount
    if not claimed:
        db.rollback()  # expires `sub`: the 409 names the status the other request left
        raise _invalid_state(sub, needed)
    sub.status = SubmissionStatus.PENDING


def safe_readiness() -> tuple[bool, list[str]]:
    """ai.ai_readiness(), never raising: a failed check reads as not ready (also GET /api/health)."""
    try:
        ready, missing = ai.ai_readiness()
        return bool(ready), [str(m) for m in missing]
    except Exception:  # noqa: BLE001
        logger.exception("ai.ai_readiness() failed")
        return False, ["AI readiness check failed - see the backend logs"]


def _require_ai() -> None:
    ready, missing = safe_readiness()
    if not ready:
        raise ApiError(
            503,
            "AI grading is not configured on the server (missing: "
            f"{', '.join(missing) or 'unknown'}). Fix the .env file and restart the backend.",
            "ai_not_configured",
        )


def _upload_exists(sub: StudentSubmission) -> bool:
    return bool(sub.file_path) and Path(sub.file_path).is_file()


def _rubric_questions(rubric: Rubric) -> list[dict[str, Any]]:
    out = []
    for q in (rubric.content or {}).get("questions") or []:
        try:
            out.append({**q, "question": int(q["question"])})
        except (KeyError, TypeError, ValueError):
            continue
    return sorted(out, key=lambda q: q["question"])


def _qlist(numbers: list[int]) -> str:
    return ", ".join(f"Q{n}" for n in numbers)


# --------------------------------------------------------------------------- #
# Rename (faculty sets the student's name)
# --------------------------------------------------------------------------- #
@router.patch("/api/submissions/{submission_id}", response_model=SubmissionOut)
def rename_submission(submission_id: int, body: RenameInput, db: DbSession) -> SubmissionOut:
    """Set the student's name (a sheet saved under its file name, a typo), checked like upload's.
    student_ref is kept: it may be a roll number and it links this sheet to the student's history,
    so a rename never moves the sheet to another student. 409 while queued or processing (the
    pipeline rewrites the log)."""
    sub = result_view.get_submission(db, submission_id)
    name = uploads.validate_student_name(body.student_name)
    if sub.status in ACTIVE_STATUSES:
        raise _invalid_state(sub, "a sheet that is not queued or processing")
    if name != sub.student_name:
        append_log(sub, "Faculty edit", f"Student renamed from {sub.student_name} to {name} by faculty.")
        sub.student_name = name
        sub.updated_at = utcnow()
        db.commit()
    return result_view.submission_out(sub)


# --------------------------------------------------------------------------- #
# Retry (DLQ re-drive)
# --------------------------------------------------------------------------- #
@router.post("/api/submissions/{submission_id}/retry", status_code=202, response_model=SubmissionOut)
def retry_submission(submission_id: int, background_tasks: BackgroundTasks, db: DbSession) -> SubmissionOut:
    """Operator re-drive of a FAILED sheet: re-runs from the stored upload (OCR cache reused).

    Submission.attempts keeps counting across runs (max_attempts is the automatic retry budget
    of ONE run), so after a re-drive it can exceed max_attempts: current_step and the log name
    the attempt ("attempt N") for the UI."""
    sub = result_view.get_submission(db, submission_id)
    if sub.status != SubmissionStatus.FAILED:
        raise _invalid_state(sub, "FAILED")
    mode = pipeline.last_run_mode(sub.id)
    if mode == pipeline.MODE_FULL and not _upload_exists(sub):
        raise ApiError(
            409, "The stored upload for this sheet is missing - upload the answer sheet again.", "upload_missing"
        )
    _claim(db, sub, (SubmissionStatus.FAILED,), "FAILED")
    attempt = int(sub.attempts or 0) + 1
    what = (
        "evaluation-only re-run of the stored transcript (OCR reused - no vision call)"
        if mode == pipeline.MODE_EVALUATION_ONLY
        else "full re-run from the stored upload"
        + (" (OCR cache reused when the bytes match)" if get_settings().ocr_cache_enabled else "")
    )
    append_log(sub, "Queue", f"Operator re-drive from DLQ (attempt {attempt}): {what}.")
    sub.current_step = f"Queued - operator retry (attempt {attempt})"
    sub.error_message = None
    sub.last_error_code = None
    sub.review_reason = None
    sub.updated_at = utcnow()
    db.commit()
    background_tasks.add_task(pipeline.process_submission, sub.id, mode=mode, reason="retry")
    return result_view.submission_out(sub)


# --------------------------------------------------------------------------- #
# Re-evaluation without OCR (FR-5.7, acceptance 14.1)
# --------------------------------------------------------------------------- #
def prepare_reevaluation(db: Session, sub: StudentSubmission, target: Rubric) -> bool:
    """Demo rows are re-graded synthetically now (no AI) -> False. Live rows: claim the COMPLETED
    sheet (_claim), archive the current result, move the sheet to `target`, mark it PENDING -> True
    (the caller enqueues an evaluation-only run; OCR reused). A refusal (409 no_transcript /
    invalid_state) rolls back, so a snapshot the caller flushed for `target` is not stored."""
    if sub.is_demo:
        pipeline.synthetic_regrade(db, sub, target)
        return False
    transcript, _name, _raw = pipeline.stored_transcript(sub.id)
    if transcript is None:
        db.rollback()
        raise ApiError(
            409, f"Submission {sub.id} has no stored OCR transcript to re-use - re-scan it instead.", "no_transcript"
        )
    _claim(db, sub, (SubmissionStatus.COMPLETED,), "COMPLETED")
    previous = sub.rubric
    archived = results_store.archive_current_result(db, sub, superseded_by_rubric_id=target.id)
    sub.rubric_id = target.id
    sub.rubric = target
    before = (
        f" Result v{archived.version} ({previous.version}: {pipeline._fmt(archived.total_score)}/"
        f"{pipeline._fmt(archived.total_marks)}) archived."
        if archived is not None else ""
    )
    append_log(
        sub, "Queue",
        f"Re-evaluation queued against rubric {rubric_store.rubric_label(target)}.{before} "
        "OCR reused - no vision call.",
    )
    # The current result is archived above, so GET /api/results/{id} answers 202 with this step
    # until the new grade is stored (the report shows "Re-grading", not the old marks).
    sub.current_step = pipeline.REGRADE_QUEUED_STEP
    sub.error_message = None
    sub.last_error_code = None
    sub.review_reason = None
    sub.completed_at = None
    sub.updated_at = utcnow()
    db.commit()
    return True


@router.post("/api/submissions/{submission_id}/reevaluate", status_code=202, response_model=SubmissionOut)
def reevaluate_submission(
    submission_id: int,
    background_tasks: BackgroundTasks,
    db: DbSession,
    body: Annotated[ReevaluateInput | None, Body()] = None,
) -> SubmissionOut:
    """Re-grade a COMPLETED sheet from its stored transcript (no OCR) against rubric_id, an inline
    `rubric` (an edited answer key: validated like upload's rubric_json and stored as a new rubric
    snapshot row - one call instead of POST /api/rubrics + reevaluate), or its current rubric."""
    sub = result_view.get_submission(db, submission_id)
    if sub.status != SubmissionStatus.COMPLETED or sub.result is None:
        raise _invalid_state(sub, "COMPLETED")
    target, inline = _target_rubric(db, sub, body)
    if not sub.is_demo:
        _require_ai()
    if inline is not None:  # flushed only: a refused re-evaluation rolls it back
        # No source files for it: the report drafts an inline key from a newly uploaded question
        # paper, so the previous snapshot's files would preview the wrong paper.
        target = rubric_store.create_rubric(db, inline)
    if prepare_reevaluation(db, sub, target):
        background_tasks.add_task(
            pipeline.process_submission, sub.id, mode=pipeline.MODE_EVALUATION_ONLY, reason="reevaluate"
        )
    db.refresh(sub)
    return result_view.submission_out(sub)


def _target_rubric(
    db: Session, sub: StudentSubmission, body: ReevaluateInput | RerunInput | None
) -> tuple[Rubric, RubricContentIn | None]:
    """(rubric, None) for body.rubric_id or the sheet's current rubric; (current rubric, validated
    content) for an inline body.rubric (the caller stores it once every other check has passed).
    Both -> 422 invalid_rubric; an unknown rubric_id -> 422 unknown_rubric."""
    if body is not None and body.rubric is not None:
        if body.rubric_id is not None:
            raise ApiError(422, "Send either rubric_id or rubric, not both.", "invalid_rubric")
        return sub.rubric, rubric_store.validate_content(body.rubric, "rubric")
    if body is not None and body.rubric_id is not None:
        target = db.get(Rubric, body.rubric_id)
        if target is None:
            raise ApiError(422, f"Rubric {body.rubric_id} does not exist.", "unknown_rubric")
        return target, None
    return sub.rubric, None


# --------------------------------------------------------------------------- #
# OCR review (FR-2.4 human in the loop)
# --------------------------------------------------------------------------- #
def _answers_from_result(sub: StudentSubmission) -> dict[int, OcrAnswer]:
    """Transcript reconstructed from a stored result (demo / legacy rows without ocr.json)."""
    out: dict[int, OcrAnswer] = {}
    for item in (sub.result.question_evaluations if sub.result is not None else None) or []:
        try:
            number = int(item["question"])
        except (KeyError, TypeError, ValueError):
            continue
        text = str(item.get("student_answer") or "")
        if not text.strip():
            continue
        out[number] = OcrAnswer(
            question=number, answer=text, confidence=float(item.get("confidence") or 0.0),
            pages=[p for p in item.get("source_pages") or [] if isinstance(p, int)],
            uncertain_words=[w for w in item.get("uncertain_words") or [] if isinstance(w, dict)],
            source="faculty" if item.get("corrected_by_faculty") else "ocr",
        )
    return out


def _review_out(review: OcrReview) -> OcrReviewOut:
    after = review.after if isinstance(review.after, dict) else {}
    changed = [n for n in after.get("changed_questions") or [] if isinstance(n, int)]
    action = review.action if review.action in get_args(ReviewActionLit) else "correct"
    return OcrReviewOut(
        id=review.id, reviewer=review.reviewer, action=action, note=review.note,
        changed_questions=changed, created_at=review.created_at,
    )


@router.get("/api/submissions/{submission_id}/ocr", response_model=OcrReviewData)
def get_ocr_review(submission_id: int, db: DbSession) -> OcrReviewData:
    sub = result_view.get_submission(db, submission_id)
    transcript, _name, _raw = pipeline.stored_transcript(sub.id)
    if transcript is not None:
        by_question = {a.question: a for a in transcript.answers}
        has_transcript = True
    else:
        by_question = _answers_from_result(sub)
        has_transcript = bool(by_question)
    answers = []
    for q in _rubric_questions(sub.rubric):
        answer = by_question.get(q["question"])
        answers.append(ReviewAnswer(
            question=q["question"],
            topic=str(q.get("topic") or f"Q{q['question']}"),
            prompt=q.get("prompt"),
            answer=answer.answer if answer else "",
            confidence=round(float(answer.confidence), 3) if answer else None,
            source_pages=list(answer.pages) if answer else [],
            uncertain_words=[w.model_dump() for w in answer.uncertain_words] if answer else [],
        ))
    reviews = db.scalars(
        select(OcrReview).where(OcrReview.submission_id == sub.id).order_by(OcrReview.id)
    ).all()
    return OcrReviewData(
        submission_id=sub.id,
        status=sub.status,
        threshold=get_settings().ocr_confidence_threshold,
        has_transcript=has_transcript,
        answers=answers,
        page_confidences=provenance._page_confidences(sub.page_confidences),
        flagged_pages=[p for p in sub.flagged_pages or [] if isinstance(p, int)],
        pages=page_refs(sub),
        reviews=[_review_out(r) for r in reviews],
    )


@router.post("/api/submissions/{submission_id}/review", status_code=202, response_model=SubmissionOut)
def review_submission(
    submission_id: int, body: ReviewInput, background_tasks: BackgroundTasks, db: DbSession
) -> SubmissionOut:
    """approve: grade the OCR transcript as is. correct: replace the given answers (source
    'faculty', confidence 1.0; an empty answer marks the question unattempted). Either way the
    sheet is graded next WITHOUT a new OCR call (evaluation-only run, no confidence gate)."""
    sub = result_view.get_submission(db, submission_id)
    if sub.status != SubmissionStatus.HUMAN_REVIEW_REQUIRED:
        raise _invalid_state(sub, "HUMAN_REVIEW_REQUIRED")
    reviewer = " ".join(body.reviewer.split())
    if not reviewer:
        raise ApiError(422, "Reviewer name is required.", "invalid_reviewer")
    rubric = sub.rubric
    numbers = [q["question"] for q in _rubric_questions(rubric)]
    transcript, _name, _raw = pipeline.stored_transcript(sub.id)
    answers: dict[int, OcrAnswer] = {a.question: a for a in transcript.answers} if transcript else {}
    before: list[dict[str, Any]] = []
    after: list[dict[str, Any]] = []
    changed: list[int] = []

    if body.action == "approve":
        if transcript is None:
            raise ApiError(
                422,
                "There is no OCR transcript to approve for this sheet - type the answers (correct) or re-scan it.",
                "no_transcript",
            )
    else:
        unknown = sorted({a.question for a in body.answers if a.question not in numbers})
        if unknown:
            raise ApiError(
                422, f"{_qlist(unknown)} {'is' if len(unknown) == 1 else 'are'} not in rubric {rubric.version}.",
                "invalid_question",
            )
        seen = [a.question for a in body.answers]
        dupes = sorted({n for n in seen if seen.count(n) > 1})
        if dupes:
            raise ApiError(422, f"{_qlist(dupes)} given more than once.", "invalid_question")
        if transcript is None and not any(a.answer.strip() for a in body.answers):
            raise ApiError(
                422, "There is no OCR transcript for this sheet - type at least one answer or re-scan it.",
                "no_transcript",
            )
        for item in body.answers:
            text = item.answer.strip()
            old = answers.get(item.question)
            if (old.answer.strip() if old else "") == text:
                continue  # unchanged - keep the OCR answer (and its confidence)
            changed.append(item.question)
            before.append({"question": item.question, "answer": old.answer if old else ""})
            after.append({"question": item.question, "answer": text})
            if text:
                answers[item.question] = OcrAnswer(
                    question=item.question, answer=text, confidence=1.0,
                    pages=list(old.pages) if old else [], source="faculty",
                )
            else:
                answers.pop(item.question, None)

    _require_ai()
    ordered = [answers[n] for n in sorted(answers)]
    reviewed = OcrResult(
        answers=ordered,
        overall_confidence=round(fmean(a.confidence for a in ordered), 4) if ordered else 0.0,
        provider=transcript.provider if transcript else "faculty",
        model=transcript.model if transcript else "manual transcription",
        page_assessments=list(transcript.page_assessments) if transcript else [],
        dropped_questions=list(transcript.dropped_questions) if transcript else [],
        language_hints=list(transcript.language_hints) if transcript else [],
    )
    artifact = pipeline.transcript_artifact(
        reviewed, rubric, reviewed_by=reviewer, reviewed_at=utc_iso(), review_action=body.action,
        changed_questions=sorted(changed),
    )
    _claim(db, sub, (SubmissionStatus.HUMAN_REVIEW_REQUIRED,), "HUMAN_REVIEW_REQUIRED")
    try:
        job_dir = results_store.job_dir(sub.id)
        job_dir.mkdir(parents=True, exist_ok=True)
        # Written strictly (not best effort): grading must never silently fall back to the raw OCR.
        (job_dir / pipeline.REVIEWED_OCR_FILE).write_text(json.dumps(artifact, indent=2), encoding="utf-8")
    except OSError as exc:
        db.rollback()
        logger.exception("Could not save the reviewed transcript for submission %s", sub.id)
        raise HTTPException(500, "Could not save the reviewed transcript - see the backend logs.") from exc

    db.add(OcrReview(
        submission_id=sub.id, reviewer=reviewer, action=body.action,
        before={"answers": before}, after={"answers": after, "changed_questions": sorted(changed)},
        note=(body.note or "").strip() or None,
    ))
    if body.action == "approve":
        message = f"Faculty approved the OCR transcript - cleared for grading by {reviewer}."
    elif changed:
        message = f"Faculty corrected {_qlist(sorted(changed))} - cleared for grading by {reviewer}."
    else:
        message = f"Faculty reviewed the transcript with no changes - cleared for grading by {reviewer}."
    append_log(sub, "Human review", message)
    append_log(
        sub, "Queue", "Queued for grading (evaluation only): reviewed transcript re-used - no new OCR call."
    )
    sub.current_step = "Queued"
    sub.error_message = None
    sub.last_error_code = None
    sub.review_reason = None
    sub.updated_at = utcnow()
    db.commit()
    background_tasks.add_task(pipeline.process_submission, sub.id, mode=pipeline.MODE_EVALUATION_ONLY, reason="review")
    return result_view.submission_out(sub)


@router.post("/api/submissions/{submission_id}/rescan", status_code=202, response_model=SubmissionOut)
def rescan_submission(
    submission_id: int,
    background_tasks: BackgroundTasks,
    db: DbSession,
    file: Annotated[UploadFile | None, File()] = None,
    reviewer: Annotated[str | None, Form()] = None,
) -> SubmissionOut:
    """Replace the stored scan (same validation as upload) and run the full pipeline again. The kind
    is kept: a voice answer is replaced by audio, a document by a document (422 input_kind_mismatch)."""
    sub = result_view.get_submission(db, submission_id)
    if sub.status not in (SubmissionStatus.HUMAN_REVIEW_REQUIRED, SubmissionStatus.FAILED):
        raise _invalid_state(sub, "HUMAN_REVIEW_REQUIRED or FAILED")
    if file is None or not file.filename:
        raise uploads.unprocessable(f"Attach the re-scanned answer sheet ({uploads.ACCEPTED_LABEL}).", "missing_file")
    settings = get_settings()
    display = uploads.display_filename(file.filename)
    path, mime_type, size, sha256 = uploads.store_upload(file, display, settings)
    old_path = sub.file_path
    try:
        kind = INPUT_VOICE if uploads.is_audio_mime(mime_type) else INPUT_DOCUMENT
        if kind != (sub.input_kind or INPUT_DOCUMENT):
            raise uploads.unprocessable(KIND_MISMATCH_DETAIL, "input_kind_mismatch")
        description, page_count = uploads.inspect_document(path, mime_type, settings)
        _claim(db, sub, HELD_OR_FAILED, "HUMAN_REVIEW_REQUIRED or FAILED")
        name = " ".join((reviewer or "").split())[:120] or DEFAULT_RESCAN_REVIEWER
        db.add(OcrReview(
            submission_id=sub.id, reviewer=name, action="rescan",
            before={"file_sha256": sub.file_hash, "original_filename": sub.original_filename,
                    "file_size": sub.file_size, "page_count": sub.page_count},
            after={"file_sha256": sha256, "original_filename": display, "file_size": size,
                   "page_count": page_count, "changed_questions": []},
        ))
        old_hash = sub.file_hash
        sub.file_path = str(path.resolve())
        sub.original_filename = display
        sub.mime_type = mime_type
        sub.file_hash = sha256
        sub.file_size = size
        sub.page_count = page_count
        sub.ocr_confidence = None
        sub.ocr_cache_hit = False
        sub.custody_verified = None
        sub.flagged_pages = []
        sub.page_confidences = []
        sub.error_message = None
        sub.last_error_code = None
        sub.review_reason = None
        sub.completed_at = None
        if kind == INPUT_VOICE:
            sub.audio_seconds = uploads.audio_seconds(path, mime_type)
            sub.detected_languages = []
        replaced = f" (replaces SHA-256 {hashing.short_hash(old_hash)})" if old_hash else ""
        what = f"voice answer, {description}" if kind == INPUT_VOICE else f"{description}, {uploads.human_size(size)}"
        append_log(
            sub, "Ingestion",
            f"Rescan received - full re-run: {display} ({what}) by {name}; "
            f"SHA-256 {sha256[:12]}... recorded for chain of custody{replaced}.",
        )
        uploads.duplicate_notice(db, sub)
        pipeline.log_queued(sub, sub.rubric)
        sub.current_step = "Queued"
        sub.updated_at = utcnow()
        db.commit()
    except BaseException:
        db.rollback()
        uploads.discard(path)
        raise

    _clear_scan_artifacts(sub)
    if old_path and Path(old_path).resolve() != path.resolve():
        uploads.discard(Path(old_path))
    background_tasks.add_task(pipeline.process_submission, sub.id, mode=pipeline.MODE_FULL, reason="rescan")
    return result_view.submission_out(sub)


def _clear_scan_artifacts(sub: StudentSubmission) -> None:
    job_dir = results_store.job_dir(sub.id)
    if not job_dir.is_dir():
        return
    for item in job_dir.iterdir():
        if item.name in SCAN_ARTIFACTS or preprocessing.PAGE_FILE_RE.match(item.name):
            try:
                item.unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not remove stale artifact %s for submission %s", item.name, sub.id)


# --------------------------------------------------------------------------- #
# Faculty re-run (the sheet was uploaded with the wrong rubric, or held / failed for another reason)
# --------------------------------------------------------------------------- #
@router.post("/api/submissions/{submission_id}/rerun", status_code=202, response_model=SubmissionOut)
def rerun_submission(
    submission_id: int,
    background_tasks: BackgroundTasks,
    db: DbSession,
    body: Annotated[RerunInput | None, Body()] = None,
) -> SubmissionOut:
    """Full re-run of a HUMAN_REVIEW_REQUIRED or FAILED sheet from its stored upload, against
    rubric_id, or an inline `rubric` (validated like upload's rubric_json and stored as a new
    rubric snapshot row), or neither = its current rubric: pre-processing, OCR and the same-paper
    check run again. Once accepted, the earlier run's files that could steer a later run are removed
    (RERUN_ARTIFACTS: the faculty-reviewed transcript, run.json and dead_letter.json - a Retry after
    a restart would otherwise re-grade the old transcript - plus ocr.json when the rubric changes);
    a current result, if any, is archived."""
    sub = result_view.get_submission(db, submission_id)
    if sub.status not in HELD_OR_FAILED:
        raise _invalid_state(sub, "HUMAN_REVIEW_REQUIRED or FAILED")
    previous = sub.rubric
    target, inline = _target_rubric(db, sub, body)
    if not _upload_exists(sub):
        raise ApiError(
            409, "The stored upload for this sheet is missing - upload the answer sheet again.", "upload_missing"
        )
    _require_ai()
    given = body.reviewer if body is not None else None
    reviewer = " ".join((given or "").split())[:120] or DEFAULT_RESCAN_REVIEWER

    _claim(db, sub, HELD_OR_FAILED, "HUMAN_REVIEW_REQUIRED or FAILED")
    if inline is not None:  # every check passed: store the drafted answer key as this sheet's snapshot
        # (no source files: it was drafted from a newly uploaded paper, not the previous snapshot's)
        target = rubric_store.create_rubric(db, inline)
    same = previous is not None and target.id == previous.id
    try:
        _remove_artifacts(sub, RERUN_ARTIFACTS if same else (*RERUN_ARTIFACTS, pipeline.OCR_FILE))
    except HTTPException:
        db.rollback()
        raise
    archived = results_store.archive_current_result(db, sub, superseded_by_rubric_id=target.id)
    sub.rubric_id = target.id
    sub.rubric = target
    notes = ""
    if archived is not None:
        old_version = archived.rubric_version or (previous.version if previous is not None else "?")
        notes += (
            f" Result v{archived.version} ({old_version}: "
            f"{pipeline._fmt(archived.total_score)}/{pipeline._fmt(archived.total_marks)}) archived."
        )
    target_numbers = {q["question"] for q in _rubric_questions(target)}
    if sub.voice_question is not None and sub.voice_question not in target_numbers:
        notes += (
            f" Q{sub.voice_question} is not in rubric {target.version} - the whole recording is mapped to its "
            "questions."
        )
        sub.voice_question = None
    was = "same rubric" if same else f"was {rubric_store.rubric_label(previous)}"
    append_log(
        sub, "Queue",
        f"Faculty re-run with rubric {rubric_store.rubric_label(target)} by {reviewer} - full re-run from the "
        f"stored upload ({was}).{notes}",
    )
    sub.current_step = "Queued - re-run"
    sub.error_message = None
    sub.last_error_code = None
    sub.review_reason = None
    sub.ocr_confidence = None
    sub.ocr_cache_hit = False
    sub.flagged_pages = []
    sub.page_confidences = []
    sub.completed_at = None
    sub.updated_at = utcnow()
    db.commit()
    background_tasks.add_task(pipeline.process_submission, sub.id, mode=pipeline.MODE_FULL, reason="rerun")
    return result_view.submission_out(sub)


def _remove_artifacts(sub: StudentSubmission, names: tuple[str, ...]) -> None:
    """Strict (not best effort): a file left behind would steer the next run (500 when one cannot
    be removed; the caller rolls back)."""
    job_dir = results_store.job_dir(sub.id)
    for name in names:
        try:
            (job_dir / name).unlink(missing_ok=True)
        except OSError as exc:
            logger.exception("Could not remove %s of submission %s", name, sub.id)
            raise HTTPException(500, "Could not clear the earlier run's files - see the backend logs.") from exc


# --------------------------------------------------------------------------- #
# Page images (FR-2.3 viewer)
# --------------------------------------------------------------------------- #
def _page_files(job_dir: Path) -> dict[int, dict[str, Path]]:
    found: dict[int, dict[str, Path]] = {}
    if not job_dir.is_dir():
        return found
    for item in job_dir.iterdir():
        match = preprocessing.PAGE_FILE_RE.match(item.name)
        if match and item.is_file():
            variant = "original" if match.group(2) else "processed"
            found.setdefault(int(match.group(1)), {})[variant] = item
    return found


def _image_size(path: Path) -> tuple[int | None, int | None]:
    try:
        with Image.open(path) as image:
            return image.size
    except Exception:  # noqa: BLE001
        return None, None


def page_refs(sub: StudentSubmission) -> list[PageRef]:
    """Processed (+ original) page images. Sheets that never reached pre-processing (the blurry
    mock, held or failed sheets) are rendered lazily from the stored upload, unenhanced. Demo
    rows have no scan: []. A voice answer has no pages: []."""
    if voice.is_voice(sub):
        return []
    job_dir = results_store.job_dir(sub.id)
    found = _page_files(job_dir)
    if not found and _upload_exists(sub) and sub.status not in ACTIVE_STATUSES:
        try:
            preprocessing.render_review_pages(Path(sub.file_path), sub.mime_type, job_dir)
        except preprocessing.PreprocessingError as exc:
            logger.warning("Could not render review pages for submission %s: %s", sub.id, exc)
            return []
        found = _page_files(job_dir)
    refs = []
    for number in sorted(found):
        files = found[number]
        processed = files.get("processed") or files.get("original")
        if processed is None:
            continue
        width, height = _image_size(processed)
        base = f"/api/submissions/{sub.id}/pages/{number}"
        refs.append(PageRef(
            page_number=number,
            url=f"{base}?variant=processed",
            original_url=f"{base}?variant=original" if "original" in files else None,
            media_type=PAGE_MEDIA_TYPES.get(processed.suffix.lstrip(".").lower(), "image/png"),
            width=width,
            height=height,
        ))
    return refs


@router.get("/api/submissions/{submission_id}/pages", response_model=list[PageRef])
def list_pages(submission_id: int, db: DbSession) -> list[PageRef]:
    return page_refs(result_view.get_submission(db, submission_id))


@router.get("/api/submissions/{submission_id}/pages/{page_number}")
def page_image(
    submission_id: int,
    page_number: str,
    db: DbSession,
    variant: Literal["processed", "original"] = "processed",
) -> FileResponse:
    """One page image. Only page_<n>[_original].png|jpg inside the submission's own artifact
    folder can be served; anything else (traversal attempts included) is a 404."""
    not_found = ApiError(404, f"Page {page_number} of submission {submission_id} was not found.", "page_not_found")
    if not PAGE_NUMBER_RE.fullmatch(page_number):
        raise not_found
    sub = result_view.get_submission(db, submission_id)
    job_dir = results_store.job_dir(sub.id).resolve()
    suffix = "_original" if variant == "original" else ""
    for extension, media_type in PAGE_MEDIA_TYPES.items():
        candidate = (job_dir / f"page_{int(page_number)}{suffix}.{extension}").resolve()
        if candidate.parent == job_dir and candidate.is_file():
            return FileResponse(candidate, media_type=media_type, headers={"Cache-Control": "no-store"})
    raise not_found


# --------------------------------------------------------------------------- #
# Invocations, costs, intake batches
# --------------------------------------------------------------------------- #
def _invocation_out(row: ModelInvocation) -> ModelInvocationOut:
    return ModelInvocationOut(
        id=row.id,
        submission_id=row.submission_id,
        purpose=row.purpose if row.purpose in INVOCATION_PURPOSES else "evaluation",
        provider=row.provider,
        model_requested=row.model_requested,
        model_served=row.model_served,
        request_id=row.request_id,
        input_tokens=int(row.input_tokens or 0),
        output_tokens=int(row.output_tokens or 0),
        cache_creation_input_tokens=int(row.cache_creation_input_tokens or 0),
        cache_read_input_tokens=int(row.cache_read_input_tokens or 0),
        image_count=int(row.image_count or 0),
        latency_ms=int(row.latency_ms or 0),
        status=row.status if row.status in INVOCATION_STATUSES else "error",
        error_code=row.error_code,
        fell_back=bool(row.fell_back),
        cost_usd=row.cost_usd,
        cost_inr=row.cost_inr,
        created_at=row.created_at,
    )


@router.get("/api/submissions/{submission_id}/invocations", response_model=list[ModelInvocationOut])
def list_invocations(submission_id: int, db: DbSession) -> list[ModelInvocationOut]:
    sub = result_view.get_submission(db, submission_id)
    return [_invocation_out(row) for row in provenance.invocations_for(db, sub.id)]


@router.get("/api/ops/costs", response_model=OpsCosts)
def ops_costs(
    db: DbSession, group_by: Literal["purpose", "batch", "institution", "model"] = "purpose"
) -> OpsCosts:
    """Spend across every recorded provider call (acceptance 14.3: cost per student vs target)."""
    settings = get_settings()
    rows = db.scalars(select(ModelInvocation).order_by(ModelInvocation.id)).all()
    batches = {b.id: b.name for b in db.scalars(select(Batch)).all()}
    institutions = {i.id: i.name for i in db.scalars(select(Institution)).all()}

    def key_for(row: ModelInvocation) -> str:
        if group_by == "batch":
            return batches.get(row.batch_id, f"batch {row.batch_id}") if row.batch_id is not None else "unassigned"
        if group_by == "institution":
            if row.institution_id is None:
                return "unassigned"
            return institutions.get(row.institution_id, f"institution {row.institution_id}")
        if group_by == "model":
            return row.model_served or row.model_requested or "unknown"
        return row.purpose or "unknown"

    groups: dict[str, dict[str, Any]] = {}
    total = 0.0
    calls = cache_hits = 0
    for row in rows:
        group = groups.setdefault(key_for(row), {
            "calls": 0, "cost_inr": 0.0, "input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0,
        })
        if row.status == "cache_hit":
            cache_hits += 1
        else:
            calls += 1
            group["calls"] += 1
        cost = float(row.cost_inr or 0.0)
        total += cost
        group["cost_inr"] += cost
        group["input_tokens"] += int(row.input_tokens or 0)
        group["output_tokens"] += int(row.output_tokens or 0)
        group["cache_read_input_tokens"] += int(row.cache_read_input_tokens or 0)
    # Completed live sheets with at least one traced call (rows graded before cost tracking have
    # none and would dilute the average).
    traced_ids = {row.submission_id for row in rows if row.submission_id is not None}
    students = len([
        sid for sid in db.scalars(
            select(StudentSubmission.id).where(
                StudentSubmission.status == SubmissionStatus.COMPLETED, StudentSubmission.is_demo.is_(False)
            )
        ).all()
        if sid in traced_ids
    ])
    ordered = sorted(groups.items(), key=lambda item: (-item[1]["cost_inr"], item[0]))
    return OpsCosts(
        group_by=group_by,
        groups=[{"key": key, **{**values, "cost_inr": round(values["cost_inr"], 4)}} for key, values in ordered],
        total_cost_inr=round(total, 4),
        calls=calls,
        students=students,
        avg_cost_per_student_inr=round(total / students, 2) if students and rows else None,
        ocr_cache_hits=cache_hits,
        target_inr=settings.cost_target_inr,
        usd_inr=settings.usd_inr,
    )


@router.get("/api/intake-batches/{intake_batch_id}", response_model=IntakeBatchStatus)
def intake_batch_status(intake_batch_id: str, db: DbSession) -> IntakeBatchStatus:
    """Progress of one folder/bulk intake (acceptance 14.1: 50 sheets in 30 minutes)."""
    unknown = ApiError(404, f"Intake batch '{intake_batch_id}' not found.", "unknown_intake_batch")
    if not INTAKE_BATCH_RE.fullmatch(intake_batch_id):
        raise unknown
    subs = db.scalars(
        select(StudentSubmission).where(StudentSubmission.intake_batch_id == intake_batch_id)
    ).all()
    if not subs:
        raise unknown
    settings = get_settings()
    counts = {status: sum(1 for s in subs if s.status == status) for status in SubmissionStatus}
    remaining = counts[SubmissionStatus.PENDING] + counts[SubmissionStatus.PROCESSING]
    started_at = min(s.created_at for s in subs)
    if remaining:
        end = utcnow()
    else:
        end = max((s.completed_at or s.updated_at or s.created_at) for s in subs)
    durations = [
        (s.completed_at - s.started_at).total_seconds()
        for s in subs
        if s.status == SubmissionStatus.COMPLETED and s.completed_at and s.started_at
    ]
    if remaining == 0:
        eta: float | None = 0.0
    elif durations:
        # Sheets run WORKER_CONCURRENCY at a time.
        eta = round(math.ceil(remaining / settings.worker_concurrency) * fmean(durations), 1)
    else:
        eta = None
    return IntakeBatchStatus(
        intake_batch_id=intake_batch_id,
        total=len(subs),
        completed=counts[SubmissionStatus.COMPLETED],
        human_review=counts[SubmissionStatus.HUMAN_REVIEW_REQUIRED],
        failed=counts[SubmissionStatus.FAILED],
        processing=remaining,
        started_at=started_at,
        elapsed_seconds=round(max(0.0, (end - started_at).total_seconds()), 1),
        eta_seconds=eta,
        target_seconds=settings.batch_target_seconds,
    )


# --------------------------------------------------------------------------- #
# Rubric versions (FR-5.7 "rubric edited after reports exist")
# --------------------------------------------------------------------------- #
@router.post("/api/rubrics/{rubric_id}/versions", status_code=201, response_model=RubricVersionResult)
def create_rubric_version(
    rubric_id: int, body: RubricVersionInput, background_tasks: BackgroundTasks, db: DbSession
) -> RubricVersionResult:
    """Save edited content as the next version (v{n+1}). reprocess=true re-grades every COMPLETED
    submission on the parent rubric WITHOUT OCR (the UI confirms first with the estimate). Held and
    FAILED sheets on the parent always move to the new version (their ocr_reviewed.json is removed
    when the question numbers changed)."""
    parent = db.get(Rubric, rubric_id)
    if parent is None:
        raise ApiError(404, f"Rubric {rubric_id} not found.", "unknown_rubric")
    subs: list[StudentSubmission] = []
    if body.reprocess:
        subs = list(db.scalars(
            select(StudentSubmission)
            .options(selectinload(StudentSubmission.result))
            .where(StudentSubmission.rubric_id == parent.id, StudentSubmission.status == SubmissionStatus.COMPLETED)
            .order_by(StudentSubmission.id)
        ).all())
        if any(not s.is_demo for s in subs):
            _require_ai()
    rubric = rubric_store.create_rubric(db, body.content, parent=parent, change_note=body.change_note)
    compatibility = rubric_store.compatibility(parent.content, rubric.content)
    # Held / failed sheets have no grade yet: approving or retrying them must use the edited key.
    for sub in db.scalars(select(StudentSubmission).where(
        StudentSubmission.rubric_id == parent.id, StudentSubmission.status.in_(HELD_OR_FAILED)
    )).all():
        note = ""
        if not compatibility["reusable"]:  # a reviewed transcript was mapped to the old question numbers
            _remove_artifacts(sub, (pipeline.REVIEWED_OCR_FILE,))
            note = " The question numbers changed, so any faculty-reviewed transcript was cleared."
        sub.rubric_id = rubric.id
        append_log(
            sub, "Queue", f"Answer key edited - moved to rubric {rubric_store.rubric_label(rubric)} "
            f"(was {rubric_store.rubric_label(parent)}).{note}",
        )
    db.commit()
    rubric_sources.inherit(parent.id, rubric.id)  # a new version keeps its question-paper preview

    queued: list[int] = []
    live: list[int] = []
    for sub in subs:
        if sub.result is None:
            continue
        try:
            if prepare_reevaluation(db, sub, rubric):
                live.append(sub.id)
            queued.append(sub.id)
        except ApiError as exc:
            db.rollback()
            logger.warning("Re-evaluation of submission %s skipped: %s", sub.id, exc.detail)
        except Exception:  # noqa: BLE001 - one bad row must not block the rest
            db.rollback()
            logger.exception("Re-evaluation of submission %s failed to queue", sub.id)
    if live:
        # One task for the whole set: process_many grades WORKER_CONCURRENCY sheets at a time.
        background_tasks.add_task(
            pipeline.process_many, live, mode=pipeline.MODE_EVALUATION_ONLY, reason="reevaluate"
        )
    db.refresh(rubric)
    return RubricVersionResult(
        rubric=result_view.rubric_out(rubric),
        compatibility=RubricCompatibility(**compatibility),
        queued_submission_ids=queued,
    )


# --------------------------------------------------------------------------- #
# Rubric sources (the files an intake's answer key was drafted from - rubric_sources.py)
# --------------------------------------------------------------------------- #
def _rubric_or_404(db: Session, rubric_id: int) -> Rubric:
    rubric = db.get(Rubric, rubric_id)
    if rubric is None:
        raise ApiError(404, f"Rubric {rubric_id} not found.", "unknown_rubric")
    return rubric


@router.get("/api/rubrics/{rubric_id}/sources", response_model=list[RubricSourceFile])
def list_rubric_sources(rubric_id: int, db: DbSession) -> list[RubricSourceFile]:
    """The question paper ("paper") and separate answer-key file ("key") the rubric was drafted from,
    as sent with the intake's first upload, each with its role (question_paper / rubric_file /
    marked_copy / answer_key); [] when none were kept. 404 unknown_rubric."""
    _rubric_or_404(db, rubric_id)
    return [
        RubricSourceFile(kind=e["kind"], role=e["role"], filename=e["filename"], file_type=e["file_type"],
                         pages=e["pages"])
        for e in rubric_sources.list_sources(rubric_id)
    ]


@router.get(
    "/api/rubrics/{rubric_id}/sources/{kind}/preview",
    response_class=Response,
    responses=preview_routes.IMAGE_RESPONSES,
)
def preview_rubric_source(
    rubric_id: int, kind: str, db: DbSession, page: str | None = None, width: str | None = None
) -> Response:
    """A page of a kept rubric source as an image - the renderer, headers (X-Page-Count,
    X-File-Type) and page / width rules of POST /api/intake/preview; a page already rendered at that
    width comes from the rubric's preview cache (rubric_sources.render_preview). 404 unknown_rubric;
    404 no_source when the rubric has no such file (kind other than paper / key included); 422
    invalid_page / invalid_request."""
    _rubric_or_404(db, rubric_id)
    no_source = ApiError(
        404, f"Rubric {rubric_id} has no {rubric_sources.LABELS.get(kind, 'source file').lower()} to preview.",
        "no_source",
    )
    if kind not in rubric_sources.KINDS or rubric_sources.source_file(rubric_id, kind) is None:
        raise no_source
    page_number = preview_routes.page_number_of(page)
    size = preview_routes.width_of(width)
    rendered = rubric_sources.render_preview(rubric_id, kind, page_number, size)
    if rendered is None:
        raise no_source
    return preview_routes.image_response(rendered)
