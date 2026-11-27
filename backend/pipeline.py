"""Pipeline worker (spec Section 3, steps 3-7; BRD FR-2.x; acceptance 14.1 / 14.3).

process_submission() runs inside FastAPI BackgroundTasks (the local mock of SQS + an ECS
worker). It opens its own DB session, persists progress after every step so the 3-second UI
poll shows movement, and NEVER raises: any failure marks the submission FAILED and writes a
dead_letter.json artifact (the simulated DLQ route; POST /api/submissions/{id}/retry re-drives).

What a run does (mode "full"):
  custody check (SHA-256 of the stored upload == the hash recorded at ingestion)
  -> pre-processing (real: 300 DPI master, deskew / contrast / unsharp; preprocessing.py)
  -> OCR (AI call 1) or an OCR-cache hit (FR-2.5: same bytes + rubric questions + model)
  -> same-paper check for a printed MCQ paper (paper_match: its printed questions and code against
     the rubric; another paper or version -> faculty review); a PDF / Word upload read as handwriting
     gets the same check from its text layer when it is a printed paper, plus the shape check (a long
     printed paper against a small non-MCQ rubric is not that paper's rubric) - its comparison holds
     only a sheet whose answers mostly did not map (a typed answer sheet's text is its answers)
  -> review gate (review_decision; FR-2.4: another paper, no answers on legible pages, the sheet or
     any page below the threshold, or a mostly blank sheet -> faculty review, with a review_reason)
  -> grading (AI call 2) -> deterministic insights -> persistence (results_store).
A voice answer (FR-2.8, input_kind "voice") replaces pre-processing + OCR with speech-to-text
(OpenAI, a PoC stand-in) and maps the transcript onto the rubric questions - with no AI call when
the recording answers one question (voice_question) - then joins the same gate and grading.
Mode "evaluation_only" re-uses the stored transcript (faculty-reviewed first) and skips
pre-processing, OCR and the gate: faculty corrections and rubric re-evaluations.

Transient AI errors (rate limit, overload, timeout) are retried with exponential backoff up to
settings.max_job_attempts; every provider call is recorded in model_invocations with tokens,
latency, request id and cost, and the run's cost is stored on the result.
"""
from __future__ import annotations

import json
import logging
import random
import threading
import time
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from statistics import fmean
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select, update
from sqlalchemy.orm import Session

import ai
import hashing
import insights
import preprocessing
import marking
import mcq_marks
import paper_match
import provenance
import results_store
import voice
from ai_schemas import EvaluationOutput, ModelUsage, OcrAnswer, OcrResult, QuestionGrade, Transcript
from config import DOCX_MIME, Settings, get_settings
from database import (
    INPUT_VOICE,
    EvaluationResult,
    OcrCache,
    Rubric,
    SessionLocal,
    StudentSubmission,
    SubmissionStatus,
    utc_iso,
    utcnow,
)
from schemas import ReportPayload, RubricMatch

logger = logging.getLogger("3ilens.pipeline")

BLURRY_MOCK_CONFIDENCE = 0.65
PICKUP_MESSAGE = "Job picked up by the pipeline worker (BackgroundTasks mock of SQS/ECS)."
INTERRUPTED_MESSAGE = "Interrupted by server restart - use Retry to re-run."
GENERIC_FAILURE = "Unexpected processing error - see the backend logs for details."
NO_FALLBACK_NOTE = "No approved fallback model configured - held (FR-3.10 fallback needs residency approval)."
OCR_REUSED_MESSAGE = "OCR reused - no vision call, Rs 0.00"
TRANSCRIPT_CACHE_HIT_LABEL = "Transcript cache hit - no transcription call (Rs 0.00)"
TRANSCRIPT_CACHE_VERSION = "transcript-v1"  # OCR-cache rows holding a voice transcript
DEMO_REGRADE_MESSAGE = "Synthetic demo re-run - no AI call"
DEMO_NEW_QUESTION_GAP = "Not graded - new in this rubric version (demo)"
ALL_MCQ_MESSAGE = "All questions are MCQs - auto-scored deterministically (no grading call)"
PAPER_CHECK_PREFIX = "Paper check: "
PAPER_CHECK_FAILED = "skipped - the printed questions could not be compared with the rubric."
PAPER_HOLD_MESSAGE = (
    "Held for faculty review - not scored. Approve the sheet in the review editor to score it with this "
    "rubric anyway, or upload it again with the right rubric."
)
# Added to a shape-check verdict (paper_match.shape_check states the fact only) when it holds a sheet.
PAPER_SHAPE_ACTION = "Re-run the sheet with the paper's rubric, or approve it to score it with this rubric anyway."
# ocr.json "paper_check_source": which reader's check is stored - the marks reader's own printed stems,
# or the upload's text layer (a sheet read as handwriting; see review_decision).
CHECK_SOURCE_MARKS = "marks"
CHECK_SOURCE_TEXT_LAYER = "text_layer"
MAX_ERROR_CHARS = 500

# review_reason (schemas.ReviewReasonLit): why a sheet is HUMAN_REVIEW_REQUIRED. Reset to None
# whenever a run is picked up, completes or fails.
REVIEW_LOW_CONFIDENCE = "low_confidence"            # sheet confidence below the threshold
REVIEW_LOW_PAGE_CONFIDENCE = "low_page_confidence"  # one or more pages below the threshold
REVIEW_NO_ANSWERS = "no_answers"                    # no rubric question answered on legible pages
REVIEW_MOSTLY_BLANK = "mostly_blank"                # fewer than half the rubric questions answered
REVIEW_PAPER_MISMATCH = "paper_mismatch"            # another paper / not this paper's rubric
REVIEW_PAPER_REORDERED = "paper_reordered"          # the same paper, another code / set
REVIEW_REASONS = (
    REVIEW_LOW_CONFIDENCE, REVIEW_LOW_PAGE_CONFIDENCE, REVIEW_NO_ANSWERS, REVIEW_MOSTLY_BLANK,
    REVIEW_PAPER_MISMATCH, REVIEW_PAPER_REORDERED,
)
RECHECK_PREFIX = "Re-checked with the updated review rules (no AI call): "
TEXT_LAYER_MIME_TYPES = ("application/pdf", DOCX_MIME)        # uploads with a text layer to check

# current_step while a re-evaluation is queued / running: GET /api/results/{id} answers 202
# (PENDING / PROCESSING, "Re-grading") until the new grade is stored.
REGRADE_QUEUED_STEP = "Re-grading (queued)"
REGRADE_STEP = "Re-grading"

MODE_FULL = "full"
MODE_EVALUATION_ONLY = "evaluation_only"
MODES = (MODE_FULL, MODE_EVALUATION_ONLY)

# Artifacts under artifact_dir/<submission id>/ (the local S3 mock).
OCR_FILE = "ocr.json"
REVIEWED_OCR_FILE = "ocr_reviewed.json"
EVALUATION_FILE = "evaluation.json"
REPORT_FILE = "report.json"
RUN_FILE = "run.json"
DEAD_LETTER_FILE = "dead_letter.json"

LANGUAGE_CODES = ("en", "hi", "ta", "kn", "te")


class CustodyError(RuntimeError):
    """The stored upload no longer matches the SHA-256 recorded at ingestion (permanent)."""

    code = "custody_mismatch"


class TranscriptMissingError(RuntimeError):
    """evaluation_only run without a stored transcript (permanent)."""

    code = "no_transcript"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def append_log(sub: StudentSubmission, step: str, message: str) -> None:
    """Append a {step, message, timestamp} entry (re-assigned so the JSON column is flagged dirty)."""
    entry = {"step": step, "message": message, "timestamp": utc_iso()}
    sub.processing_log = [*(sub.processing_log or []), entry]


def _record(db: Session, sub: StudentSubmission, step: str, message: str, **changes: Any) -> None:
    for name, value in changes.items():
        setattr(sub, name, value)
    append_log(sub, step, message)
    sub.updated_at = utcnow()
    db.commit()
    logger.info("[submission %s] %s: %s", sub.id, step, message)


def _write_artifact(directory: Path, name: str, payload: Any) -> None:
    """Best effort: an artifact write failure must never fail the job."""
    try:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / name).write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    except Exception:  # noqa: BLE001
        logger.exception("Could not write artifact %s/%s", directory, name)


def read_artifact(submission_id: int, name: str) -> dict[str, Any] | None:
    """A JSON artifact of a submission, or None when missing/unreadable."""
    path = get_settings().artifact_dir / str(submission_id) / name
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def write_artifact(submission_id: int, name: str, payload: Any) -> None:
    _write_artifact(get_settings().artifact_dir / str(submission_id), name, payload)


def _scrub(message: str) -> str:
    """Belt and braces: never let an API key reach the DB/API even if a provider echoes it."""
    settings = get_settings()
    for secret in (settings.anthropic_api_key, settings.openai_api_key):
        if secret and secret in message:
            message = message.replace(secret, "[redacted]")
    return message


def failure_message(exc: BaseException) -> str:
    """Short, user-safe reason for a failed job (no stack traces, no secrets)."""
    if isinstance(exc, (ai.AIConfigurationError, ai.AIServiceError, CustodyError, TranscriptMissingError)):
        message = str(exc).strip() or "The AI provider call failed."
    elif isinstance(exc, preprocessing.PreprocessingError):
        message = f"Pre-processing failed: {str(exc).strip() or 'the file could not be read.'}"
    elif isinstance(exc, insights.InsightsValidationError):
        message = f"AI evaluation was inconsistent with the rubric: {str(exc).strip()}"
    elif isinstance(exc, ValidationError):
        message = "The AI response did not match the expected JSON schema."
    elif isinstance(exc, json.JSONDecodeError):
        message = "The AI response was not valid JSON."
    elif isinstance(exc, NotImplementedError):
        message = "This pipeline step is not implemented yet on the server."
    else:
        message = GENERIC_FAILURE
    message = _scrub(" ".join(message.split()))
    return message if len(message) <= MAX_ERROR_CHARS else message[: MAX_ERROR_CHARS - 3] + "..."


def error_code(exc: BaseException) -> str:
    """snake_case reason stored as submissions.last_error_code."""
    code = getattr(exc, "code", None)
    if isinstance(code, str) and code.strip():
        return code.strip()
    if isinstance(exc, ai.AIConfigurationError):
        return "ai_not_configured"
    if isinstance(exc, insights.InsightsValidationError):
        return "evaluation_inconsistent"
    if isinstance(exc, ValidationError):
        return "schema_mismatch"
    if isinstance(exc, json.JSONDecodeError):
        return "invalid_json"
    if isinstance(exc, NotImplementedError):
        return "not_implemented"
    return "internal_error"


def _validated_report(report: Any) -> dict:
    try:
        ReportPayload.model_validate(report)
    except ValidationError as exc:
        raise insights.InsightsValidationError(
            f"insights report is missing or has invalid fields ({exc.error_count()} problem(s))."
        ) from exc
    return report


def _fmt(value: Any) -> str:
    number = float(value)
    return f"{number:g}" if number == int(number) else f"{number:.1f}"


def _qlist(numbers: list[int]) -> str:
    return ", ".join(f"Q{n}" for n in numbers)


def _rubric_numbers(content: dict[str, Any] | None) -> list[int]:
    numbers = []
    for q in (content or {}).get("questions") or []:
        try:
            numbers.append(int(q["question"]))
        except (KeyError, TypeError, ValueError):
            continue
    return sorted(set(numbers))


def _language_hints(sub: StudentSubmission) -> list[str]:
    return sorted({h for h in (sub.language_hints or []) if h in LANGUAGE_CODES}) or ["en"]


def vision_model(settings: Settings | None = None) -> tuple[str, str]:
    settings = settings or get_settings()
    provider = settings.vision_provider
    return provider, settings.openai_vision_model if provider == "openai" else settings.anthropic_model


# --------------------------------------------------------------------------- #
# Worker concurrency (acceptance 14.1: 50 sheets / 30 min)
# --------------------------------------------------------------------------- #
_slots: threading.BoundedSemaphore | None = None
_slots_size = 0
_slots_lock = threading.Lock()


def worker_slots() -> threading.BoundedSemaphore:
    """Module-level semaphore sized by WORKER_CONCURRENCY (created lazily; re-created when the
    setting changes - running jobs keep releasing the semaphore they acquired)."""
    global _slots, _slots_size
    size = get_settings().worker_concurrency
    with _slots_lock:
        if _slots is None or _slots_size != size:
            _slots = threading.BoundedSemaphore(size)
            _slots_size = size
        return _slots


# --------------------------------------------------------------------------- #
# Per-run state
# --------------------------------------------------------------------------- #
@dataclass
class _Job:
    db: Session
    sub: StudentSubmission
    job_dir: Path
    mode: str
    reason: str
    max_attempts: int
    run_attempt: int = 1
    attempts: list[dict[str, Any]] = field(default_factory=list)
    # (usage, cost_inr) of the provider calls made by the AI call in progress
    call_log: list[tuple[ModelUsage, float | None]] = field(default_factory=list)
    # Where this run's paper check came from (CHECK_SOURCE_*), None when no check was made.
    check_source: str | None = None


def _usage_recorder(job: _Job) -> Callable[[ModelUsage], None]:
    """on_usage callback: every provider call (incl. failed ones) becomes a model_invocations row."""

    def on_usage(usage: ModelUsage) -> None:
        try:
            if not isinstance(usage, ModelUsage):
                usage = ModelUsage.model_validate(usage)
            row = provenance.record_invocation(job.db, usage=usage, submission=job.sub, commit=True)
            job.call_log.append((usage, row.cost_inr))
        except Exception:  # noqa: BLE001 - bookkeeping must never fail the job
            logger.exception("Could not record model usage for submission %s", job.sub.id)
            try:
                job.db.rollback()
            except Exception:  # noqa: BLE001
                pass

    return on_usage


def _request_id(exc: BaseException | None, call_log: list[tuple[ModelUsage, float | None]]) -> str | None:
    rid = getattr(exc, "request_id", None) if exc is not None else None
    if isinstance(rid, str) and rid:
        return rid
    for usage, _cost in reversed(call_log):
        if usage.request_id:
            return usage.request_id
    return None


def _log_call(job: _Job, step: str, label: str, seconds: float) -> None:
    """'AI call 1 (OCR): 14,210 in / 2,380 out tokens, cache read 0 = Rs 1.84 (request req_...; 41.2 s)'."""
    entries = job.call_log
    if not entries:
        _record(job.db, job.sub, step, f"{label}: token usage not reported by the AI layer ({seconds:.1f} s).")
        return
    tokens_in = sum(u.input_tokens for u, _ in entries)
    tokens_out = sum(u.output_tokens for u, _ in entries)
    cache_read = sum(u.cache_read_input_tokens for u, _ in entries)
    cache_write = sum(u.cache_creation_input_tokens for u, _ in entries)
    costs = [c for _, c in entries if c is not None]
    cost_text = f"Rs {sum(costs):.2f}" if costs else "cost unknown (model not in the price table)"
    cache = f"cache read {cache_read:,}" + (f", cache write {cache_write:,}" if cache_write else "")
    rid = _request_id(None, entries) or "n/a"
    calls = f"; {len(entries)} provider calls" if len(entries) > 1 else ""
    _record(
        job.db, job.sub, step,
        f"{label}: {tokens_in:,} in / {tokens_out:,} out tokens, {cache} = {cost_text} "
        f"(request {rid}; {seconds:.1f} s{calls}).",
    )


def _ai_call(
    job: _Job, step: str, label: str, call: Callable[[Callable[[ModelUsage], None]], Any], *,
    quiet_without_usage: bool = False,
) -> Any:
    """Run one AI stage. Transient AIServiceErrors are retried (exponential backoff + jitter)
    while the run has attempts left; anything else propagates to the DLQ handler.
    quiet_without_usage: no token line when the stage made no provider call (all-MCQ papers)."""
    while True:
        job.call_log = []
        started = time.monotonic()
        try:
            result = call(_usage_recorder(job))
        except ai.AIServiceError as exc:
            if not getattr(exc, "transient", False) or job.run_attempt >= job.max_attempts:
                raise
            _schedule_retry(job, step, exc)
            continue
        if job.call_log or not quiet_without_usage:
            _log_call(job, step, label, time.monotonic() - started)
        return result


def _schedule_retry(job: _Job, step: str, exc: BaseException) -> None:
    settings = get_settings()
    base = settings.retry_backoff_base_seconds
    next_attempt = job.run_attempt + 1
    delay = base * 2 ** (next_attempt - 1) + random.uniform(0, base / 2) if base > 0 else 0.0
    code = error_code(exc)
    rid = _request_id(exc, job.call_log)
    job.attempts.append({
        "attempt": int(job.sub.attempts or job.run_attempt),
        "step": step,
        "error_code": code,
        "transient": True,
        "message": failure_message(exc),
        "request_id": rid,
        "backoff_seconds": round(delay, 1),
        "timestamp": utc_iso(),
    })
    job.run_attempt = next_attempt
    _record(
        job.db, job.sub, step,
        f"Transient error: {failure_message(exc)} Attempt {next_attempt}/{job.max_attempts} after "
        f"{delay:.0f} s backoff ({code}; request {rid or 'n/a'}).",
        attempts=int(job.sub.attempts or 0) + 1,
        current_step=f"Retrying ({next_attempt}/{job.max_attempts})",
    )
    if delay > 0:
        time.sleep(delay)


# --------------------------------------------------------------------------- #
# Worker entry point
# --------------------------------------------------------------------------- #
def process_submission(submission_id: int, *, mode: str = MODE_FULL, reason: str | None = None) -> None:
    """Steps 3-7 for one submission. Never raises.

    mode "full" (upload, retry, rescan) or "evaluation_only" (faculty review, re-evaluation:
    re-uses the stored transcript, no pre-processing / OCR / confidence gate). reason labels the
    run ("upload", "retry", "review", "reevaluate", "rescan") in run.json and the log."""
    if mode not in MODES:
        logger.error("Unknown pipeline mode %r for submission %s - using 'full'", mode, submission_id)
        mode = MODE_FULL
    try:
        with worker_slots():
            with SessionLocal() as db:
                _run(db, submission_id, mode, reason or ("upload" if mode == MODE_FULL else "review"))
    except Exception:  # noqa: BLE001 - last-resort guard; the worker thread must never crash
        logger.exception("Pipeline crashed outside the guarded steps for submission %s", submission_id)


def process_many(submission_ids: Iterable[int], *, mode: str = MODE_FULL, reason: str | None = None) -> None:
    """Run several queued jobs in parallel - ONE BackgroundTask for a bulk re-run (Starlette runs a
    request's background tasks one after another). Parallelism is bounded by WORKER_CONCURRENCY
    (the pool size and the worker semaphore). Never raises."""
    ids = list(dict.fromkeys(submission_ids))
    if not ids:
        return
    workers = min(get_settings().worker_concurrency, len(ids))
    if workers <= 1:
        for submission_id in ids:
            process_submission(submission_id, mode=mode, reason=reason)
        return
    try:
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="3ilens-worker") as pool:
            list(pool.map(lambda submission_id: process_submission(submission_id, mode=mode, reason=reason), ids))
    except Exception:  # noqa: BLE001 - process_submission never raises; guard the pool itself
        logger.exception("Bulk run of %d submission(s) crashed", len(ids))


def _claim(db: Session, submission_id: int) -> StudentSubmission | None:
    """Atomically move PENDING -> PROCESSING so a double-queued job runs once."""
    sub = db.get(StudentSubmission, submission_id)
    if sub is None:
        logger.warning("Submission %s vanished before processing", submission_id)
        return None
    if sub.status != SubmissionStatus.PENDING:
        logger.info("Submission %s is %s, not PENDING - skipping", submission_id, sub.status)
        return None
    claimed = db.execute(
        update(StudentSubmission)
        .where(StudentSubmission.id == submission_id, StudentSubmission.status == SubmissionStatus.PENDING)
        .values(status=SubmissionStatus.PROCESSING)
    ).rowcount
    db.commit()
    if not claimed:
        logger.info("Submission %s was claimed by another worker - skipping", submission_id)
        return None
    db.refresh(sub)
    return sub


def _run(db: Session, submission_id: int, mode: str, reason: str) -> None:
    sub = _claim(db, submission_id)
    if sub is None:
        return

    settings = get_settings()
    job = _Job(
        db=db, sub=sub, job_dir=settings.artifact_dir / str(sub.id), mode=mode, reason=reason,
        max_attempts=settings.max_job_attempts,
    )
    sub.attempts = int(sub.attempts or 0) + 1
    sub.started_at = utcnow()
    sub.completed_at = None
    is_voice = (sub.input_kind or "document") == INPUT_VOICE
    step = "Pre-processing" if mode == MODE_FULL else "OCR & Parse"
    try:
        # Phase 4 mock: a "blurry" sheet pauses before ANY pre-processing or AI call, so its
        # log has no Pre-processing entry - only the worker pickup and the human-review hand-off.
        if mode == MODE_FULL and not is_voice and "blurry" in (sub.original_filename or "").lower():
            _blurry_mock(job)
            return

        if mode == MODE_FULL:
            # A voice answer has no pre-processing: its pickup is logged as a Queue step.
            _record(
                db, sub, "Queue" if is_voice else step, PICKUP_MESSAGE,
                current_step="Transcription" if is_voice else step, error_message=None, last_error_code=None,
                review_reason=None, ocr_cache_hit=False, flagged_pages=[], page_confidences=[],
            )
            _write_artifact(job.job_dir, RUN_FILE, _run_info(job))
            step = "Custody"
            _verify_custody(job)

            if is_voice:
                # ---- Steps 3-4 for a voice answer: speech-to-text + transcript mapping -- #
                step = "Transcription"
                ocr = _voice_stage(job)
                step = "OCR & Parse"
                if _gate(job, ocr, 0):
                    return  # held for faculty review (FR-2.4); no pages to gate
                answers = list(ocr.answers)
            else:
                # ---- Step 3: pre-processing --------------------------------------- #
                step = "Pre-processing"

                def log_preprocessing(message: str) -> None:
                    _record(db, sub, "Pre-processing", str(message))

                pages = preprocessing.preprocess_document(
                    Path(sub.file_path), sub.mime_type, job.job_dir, log=log_preprocessing
                )
                _record(db, sub, step, f"Prepared {len(pages)} page image(s) for the vision model.")

                # ---- Step 4: OCR (AI call 1) or OCR-cache hit --------------------- #
                step = "OCR & Parse"
                ocr, cache_key, paper_check = _ocr_stage(job, pages)
                if _gate(job, ocr, len(pages), paper_check=paper_check):
                    return  # held for faculty review (FR-2.4, or another paper / version)
                _cache_store(job, cache_key, ocr)
                answers = list(ocr.answers)
        else:
            _record(
                db, sub, "Queue",
                f"{PICKUP_MESSAGE} Evaluation-only run ({reason}): the stored transcript is re-used.",
                current_step=REGRADE_STEP if reason == "reevaluate" else "Rubric evaluation",
                error_message=None, last_error_code=None, review_reason=None,
            )
            _write_artifact(job.job_dir, RUN_FILE, _run_info(job))
            answers = _stored_answers(job)

        # ---- Step 5: rubric evaluation (AI call 2) ---------------------------------- #
        step = "Rubric Evaluation"
        rubric = sub.rubric
        all_mcq = _all_mcq(rubric.content)
        medium = "speech" if is_voice else "handwriting"
        _record(
            db, sub, step,
            f"{ALL_MCQ_MESSAGE}." if all_mcq else
            f"Grading {len(answers)} answer(s) against rubric '{rubric.name}' ({rubric.version}) "
            f"with {settings.anthropic_model} (AI call 2" + ("; transcribed voice answer" if is_voice else "") + ").",
            current_step=REGRADE_STEP if job.reason == "reevaluate" else "Rubric evaluation",
        )
        evaluation = _ai_call(
            job, step, "AI call 2 (evaluation)",
            lambda on_usage: ai.run_evaluation(answers, rubric.content, on_usage=on_usage, answer_medium=medium),
            quiet_without_usage=all_mcq,
        )
        _write_artifact(job.job_dir, EVALUATION_FILE, evaluation.model_dump(mode="json"))
        _record(db, sub, step, f"Received grades for {len(evaluation.evaluations)} question(s).")

        # ---- Step 6: deterministic insights & Preparation ROI ----------------------- #
        step = "Insights & ROI"
        _record(
            db, sub, step,
            "Computing topic mastery and Preparation ROI = (weightage x gain potential) / effort hours.",
            current_step="Insights & ROI",
        )
        # The marks reader's chapters live in ocr.json (also after a faculty review or re-evaluation).
        content = chapter_rubric(rubric.content, (read_artifact(sub.id, OCR_FILE) or {}).get("question_chapters"))
        report = _validated_report(insights.build_evaluation_report(content, answers, evaluation))
        n_priorities = len(report["roi_recommendations"])
        _record(
            db, sub, step,
            f"Mastery computed for {len(report['topic_mastery'])} topic(s)"
            f"{' (by the chapter of each printed question - the key has no question text)' if content is not rubric.content else ''}; "
            f"{n_priorities} study {'priority' if n_priorities == 1 else 'priorities'} generated.",
        )

        # ---- Step 7: persistence ----------------------------------------------------- #
        step = "Persistence"
        _persist(job, report)
    except Exception as exc:  # noqa: BLE001 - every failure goes to the simulated DLQ
        _fail(job, step, exc)


def _run_info(job: _Job) -> dict[str, Any]:
    """run.json: the run's mode and reason, plus the submission's cumulative attempt number (it
    keeps counting across operator re-drives) next to the per-run automatic retry budget."""
    return {
        "mode": job.mode,
        "reason": job.reason,
        "attempt": int(job.sub.attempts or 1),
        "max_attempts_per_run": job.max_attempts,
        "started_at": utc_iso(),
    }


def _blurry_mock(job: _Job) -> None:
    db, sub = job.db, job.sub
    step = "Human review"
    threshold = get_settings().ocr_confidence_threshold
    message = (
        f"OCR confidence {BLURRY_MOCK_CONFIDENCE:.2f} is below the {threshold:.2f} threshold - "
        "routed to faculty review; AI evaluation skipped."
    )
    _record(
        db, sub, "Queue", PICKUP_MESSAGE,
        current_step=step, error_message=None, last_error_code=None, review_reason=None,
    )
    _record(
        db, sub, step,
        "Low-quality scan (file name contains 'blurry'): stopped before pre-processing, OCR and "
        f"AI evaluation - no AI call made. {message}",
        status=SubmissionStatus.HUMAN_REVIEW_REQUIRED, current_step=step,
        ocr_confidence=BLURRY_MOCK_CONFIDENCE, error_message=message, review_reason=REVIEW_LOW_CONFIDENCE,
        page_confidences=[], flagged_pages=[],
    )


# --------------------------------------------------------------------------- #
# Custody (FR-1.4)
# --------------------------------------------------------------------------- #
def _verify_custody(job: _Job) -> None:
    db, sub = job.db, job.sub
    path = Path(sub.file_path) if sub.file_path else None
    if path is None or not path.is_file():
        raise preprocessing.PreprocessingError(
            "The uploaded answer sheet could not be found on the server.", "upload_missing"
        )
    if not sub.file_hash:
        _record(db, sub, "Custody", "Custody check skipped - this older upload has no ingestion SHA-256 on record.")
        return
    actual = hashing.sha256_file(path)
    if actual != sub.file_hash:
        raise CustodyError(
            f"Chain of custody failed: the stored file's SHA-256 ({hashing.short_hash(actual)}) no longer "
            f"matches the hash recorded at ingestion ({hashing.short_hash(sub.file_hash)}). "
            "The sheet was not processed - upload it again."
        )
    _record(
        db, sub, "Custody",
        f"Custody verified: SHA-256 matches ingestion ({hashing.short_hash(sub.file_hash)}).",
        custody_verified=True,
    )


def chapter_rubric(content: dict[str, Any], chapters: dict[Any, Any] | None) -> dict[str, Any]:
    """A key without question text or chapters (a key-only rubric) graded by chapter: a COPY whose
    questions take the chapter the marks reader gave from the printed paper as topic and chapter
    (subject kept), so topic mastery, ROI, strengths / gaps and the study plan are per chapter.
    Scoring is unchanged and the stored rubric is never written. Else `content` itself."""
    chapters = chapters if isinstance(chapters, dict) else {}
    by_number = {n: str(name) for key, name in chapters.items() if (n := mcq_marks._number(key)) and name}
    questions = content.get("questions") if isinstance(content, dict) else None
    if (
        not by_number or not isinstance(questions, list) or paper_match._rubric_texts(content)[0]
        or any(isinstance(q, dict) and q.get("chapter") for q in questions)
    ):
        return content
    copied = []
    for q in questions:
        name = by_number.get(mcq_marks._number(q.get("question"))) if isinstance(q, dict) else None
        copied.append({**q, "topic": name, "chapter": name} if name else q)
    return {**content, "questions": copied}


def _all_mcq(content: dict[str, Any] | None) -> bool:
    """Every rubric question is an MCQ: scored deterministically, no grading call (FR-4.8)."""
    questions = [q for q in (content or {}).get("questions") or [] if isinstance(q, dict)]
    return bool(questions) and all(marking.question_type(q) == "mcq" for q in questions)


# --------------------------------------------------------------------------- #
# Voice answers (FR-2.8)
# --------------------------------------------------------------------------- #
def _voice_stage(job: _Job) -> OcrResult:
    """Speech-to-text (OpenAI, a labelled stand-in), transcript.json, then the transcript mapped
    onto rubric questions: the whole transcript for voice_question (no AI call), else the
    mapping call. Returns an OcrResult so the gate, review and grading are unchanged."""
    db, sub = job.db, job.sub
    settings = get_settings()
    rubric = sub.rubric
    hints = _language_hints(sub)
    model = settings.openai_transcribe_model
    keywords = voice.rubric_keywords(rubric.content)
    cache_key = None
    if settings.ocr_cache_enabled and sub.file_hash:
        cache_key = hashing.sha256_json({
            "file_hash": sub.file_hash, "institution_id": sub.batch.institution_id if sub.batch else None,
            "provider": "openai", "model": model, "prompt_version": TRANSCRIPT_CACHE_VERSION,
            "language_hints": sorted(hints), "keywords": keywords,
        })
    transcript = _transcript_cache_hit(job, cache_key, model) if cache_key else None
    if transcript is None:
        _record(
            db, sub, "Transcription",
            f"Transcribing the voice answer with OpenAI {model} (languages {', '.join(hints)}) - PoC stand-in "
            "for Whisper large-v3 / Sarvam Saarika.",
            current_step="Transcription",
        )
        transcript = _ai_call(
            job, "Transcription", "Speech-to-text",
            lambda on_usage: voice.transcribe(
                Path(sub.file_path), sub.mime_type, language_hints=hints, keywords=keywords, on_usage=on_usage,
            ),
        )
        if cache_key:
            _store_cache_row(job, OcrCache(
                cache_key=cache_key, file_hash=sub.file_hash,
                institution_id=sub.batch.institution_id if sub.batch else None, provider="openai", model=model,
                prompt_version=TRANSCRIPT_CACHE_VERSION, language_hints=hints, ocr_result=transcript.model_dump(mode="json"),
            ))
    languages = [c for c in dict.fromkeys(transcript.languages or []) if isinstance(c, str) and c]
    _write_artifact(job.job_dir, voice.TRANSCRIPT_FILE, {
        "text": transcript.text,
        "model": transcript.model,
        "languages": languages,
        "seconds": transcript.seconds,
        "request_id": transcript.request_id,
        "created_at": utc_iso(),
    })
    changes: dict[str, Any] = {"detected_languages": languages}
    if sub.audio_seconds is None and transcript.seconds is not None:
        changes["audio_seconds"] = round(float(transcript.seconds), 2)
    _record(
        db, sub, "Transcription",
        f"Transcribed {len(transcript.text):,} characters"
        + (f" from {transcript.seconds:.1f} s of audio" if transcript.seconds else "")
        + "; the transcript is stored as an artifact (never written to the log).",
        **changes,
    )

    question = sub.voice_question
    if question is not None:
        _record(
            db, sub, "OCR & Parse",
            f"One recording per question: the whole transcript is the answer to Q{question} - no mapping call.",
            current_step="OCR & answer structuring",
        )
        ocr = ai.structure_transcript(transcript.text, rubric.content, language_hints=hints, question_hint=question)
    else:
        _record(
            db, sub, "OCR & Parse",
            f"Mapping the whole-recording transcript to rubric questions with {settings.anthropic_model} "
            "(transcript mapping call).",
            current_step="OCR & answer structuring",
        )
        ocr = _ai_call(
            job, "OCR & Parse", "Transcript mapping",
            lambda on_usage: ai.structure_transcript(
                transcript.text, rubric.content, language_hints=hints, on_usage=on_usage,
            ),
        )
    mapped = sorted({a.question for a in ocr.answers})
    _record(
        db, sub, "OCR & Parse",
        f"Mapped the transcript to {_qlist(mapped) or 'no rubric question'} ({len(ocr.answers)} answer(s)); "
        f"detected language(s) {', '.join(languages) or 'not reported'}.",
    )
    _write_artifact(job.job_dir, OCR_FILE, transcript_artifact(ocr, rubric, source="voice"))
    return ocr


# --------------------------------------------------------------------------- #
# OCR + cache (FR-2.5)
# --------------------------------------------------------------------------- #
READER_OCR = "ocr"            # handwriting transcription (ai.run_ocr)
READER_MARKS = mcq_marks.READER  # marked-option reader for printed MCQ papers (mcq_marks)
MARKS_MIN_PAGES = 3             # an all-MCQ PDF this long is read as a printed paper


def ocr_cache_key(
    sub: StudentSubmission, rubric: Rubric, provider: str, model: str, hints: list[str], reader: str = READER_OCR
) -> str:
    """Same file bytes + institution + rubric question list + OCR engine + reader and its prompt
    version + hints. The two readers never share a cache row."""
    batch = sub.batch
    marks = reader == READER_MARKS
    return hashing.sha256_json({
        "file_hash": sub.file_hash,
        "institution_id": batch.institution_id if batch is not None else None,
        "rubric_questions_hash": hashing.rubric_questions_hash(rubric.content or {}),
        "provider": provider,
        "model": model,
        "reader": READER_MARKS if marks else READER_OCR,
        "prompt_version": mcq_marks.MARKS_PROMPT_VERSION if marks else getattr(ai, "OCR_PROMPT_VERSION", "ocr-v1"),
        "language_hints": sorted(hints),
    })


def ocr_reader(sub: StudentSubmission, rubric_content: dict[str, Any] | None, page_count: int) -> str:
    """READER_MARKS for a PDF read against an all-MCQ rubric of at least 10 questions that is at
    least MARKS_MIN_PAGES long or whose text layer looks like a printed question paper
    (paper_detect), and for a photo / scan (image) read against such a rubric - answer sheets are
    printed papers, so a photo of one is a marked printed paper; READER_OCR otherwise (typed DOCX,
    and any rubric with a written question: the tick reader skips those, the transcription reader
    reads ticks and text). Detection is a hint: if it fails, the page rule alone decides."""
    mime = sub.mime_type or ""
    if not mcq_marks.reads_ticks(rubric_content):
        return READER_OCR
    if mime.startswith("image/"):
        return READER_MARKS
    if mime != "application/pdf":
        return READER_OCR
    if page_count >= MARKS_MIN_PAGES:
        return READER_MARKS
    try:
        import paper_detect  # local import: paper_detect -> uploads -> pipeline

        role = paper_detect.inspect_bytes(Path(sub.file_path).read_bytes(), get_settings()).role
    except Exception as exc:  # noqa: BLE001 - detection must never fail the job
        logger.debug("Printed-paper detection skipped for submission %s: %s", sub.id, exc)
        return READER_OCR
    return READER_MARKS if role in ("question_paper", "answer_key_paper") else READER_OCR


def _paper_check(job: _Job, ocr: OcrResult) -> RubricMatch | None:
    """Same-paper check (paper_match) of a printed MCQ paper read by the marks reader: its printed
    question stems and paper code against the rubric. Only on a full run of an upload or a retry -
    never on a rescan (faculty already looked at the sheet); evaluation-only runs (review approval,
    re-evaluation) never reach OCR. None when not run. Never raises: a failed check is logged and
    the sheet carries on."""
    if job.mode != MODE_FULL or job.reason == "rescan":
        return None
    if not ocr.question_stems and not ocr.paper_code:
        return None
    try:
        match = paper_match.compare(ocr.question_stems, job.sub.rubric.content or {}, sheet_code=ocr.paper_code)
    except Exception:  # noqa: BLE001 - the check must never fail the job
        logger.exception("Paper check failed for submission %s - continuing without it", job.sub.id)
        _record(job.db, job.sub, "OCR & Parse", f"{PAPER_CHECK_PREFIX}{PAPER_CHECK_FAILED}")
        return None
    _record(job.db, job.sub, "OCR & Parse", f"{PAPER_CHECK_PREFIX}{match.message}")
    job.check_source = CHECK_SOURCE_MARKS
    return match


def rubric_label(rubric: Rubric) -> str:
    """"'Biology - Genetics' (v1)" - how review messages name a rubric."""
    return f"'{rubric.name}' ({rubric.version})"


def document_paper_check(
    data: bytes, rubric_content: dict[str, Any] | None, *, rubric_label: str | None = None,
    settings: Settings | None = None,
) -> RubricMatch | None:
    """Same-paper check of a PDF / Word upload from its text layer alone (paper_detect, no AI call),
    with the verdict of paper_detect.ingestion_hint and POST /api/intake/inspect
    (paper_detect.rubric_check): None unless the text reads as a printed paper
    (paper_detect.printed_paper - not a typed answer sheet with a few (a)-(d) sub-parts). Then the
    printed question stems and code against the rubric when that can tell - another paper / version
    (a hold verdict), or the rubric's questions found on this paper (paper_match.found_on_paper, e.g.
    a rubric for one section of it: only logged); else, when the text cannot tell, the shape check
    (a long printed paper against a small non-MCQ rubric), its message followed by
    PAPER_SHAPE_ACTION; else None. Whether a hold verdict holds the sheet is review_decision's call
    (text_layer=True). Raises when the file cannot be read (callers guard)."""
    import paper_detect  # local import: paper_detect -> uploads -> pipeline

    inspection, texts = paper_detect.inspect_document(data, settings or get_settings())
    verdict = paper_detect.rubric_check(inspection, texts, rubric_content, rubric_label=rubric_label)
    if verdict is None:
        return None
    if paper_match.structural(verdict):
        return verdict.model_copy(update={"message": f"{verdict.message} {PAPER_SHAPE_ACTION}"})
    if verdict.verdict in paper_match.HOLD_VERDICTS or paper_match.found_on_paper(verdict):
        return verdict
    return None


def _text_layer_check(job: _Job) -> RubricMatch | None:
    """Same-paper check of a PDF / Word upload read as handwriting (READER_OCR): its text layer
    (document_paper_check, no AI call), logged here; review_decision decides whether its verdict
    holds the sheet (job.check_source = CHECK_SOURCE_TEXT_LAYER). The run rules of _paper_check: a
    full run that is not a rescan. None when not run or nothing to say. Never raises."""
    sub = job.sub
    if job.mode != MODE_FULL or job.reason == "rescan":
        return None
    if (sub.mime_type or "") not in TEXT_LAYER_MIME_TYPES:
        return None
    rubric = sub.rubric
    try:
        match = document_paper_check(
            Path(sub.file_path).read_bytes(), rubric.content, rubric_label=rubric_label(rubric)
        )
    except Exception:  # noqa: BLE001 - the check must never fail the job
        logger.exception("Text-layer paper check failed for submission %s - continuing without it", sub.id)
        _record(job.db, sub, "OCR & Parse", f"{PAPER_CHECK_PREFIX}{PAPER_CHECK_FAILED}")
        return None
    if match is not None:
        _record(job.db, sub, "OCR & Parse", f"{PAPER_CHECK_PREFIX}{match.message}")
        job.check_source = CHECK_SOURCE_TEXT_LAYER
    return match


def _check_for(job: _Job, ocr: OcrResult, reader: str) -> RubricMatch | None:
    return _paper_check(job, ocr) if reader == READER_MARKS else _text_layer_check(job)


def _ocr_artifact(job: _Job, ocr: OcrResult, check: RubricMatch | None) -> None:
    extra = (
        {"paper_check": check.model_dump(mode="json"), "paper_check_source": job.check_source}
        if check is not None else {}
    )
    _write_artifact(job.job_dir, OCR_FILE, transcript_artifact(ocr, job.sub.rubric, **extra))


def _ocr_stage(job: _Job, pages: list[Any]) -> tuple[OcrResult, str | None, RubricMatch | None]:
    """(OCR result, cache key to store it under or None, same-paper check or None)."""
    db, sub = job.db, job.sub
    settings = get_settings()
    rubric = sub.rubric
    provider, model = vision_model(settings)
    hints = _language_hints(sub)
    reader = ocr_reader(sub, rubric.content, len(pages))
    cache_key: str | None = None
    if settings.ocr_cache_enabled and sub.file_hash:
        cache_key = ocr_cache_key(sub, rubric, provider, model, hints, reader)
        cached = _cache_hit(job, cache_key, provider, model)
        if cached is not None:
            check = _check_for(job, cached, reader)
            _ocr_artifact(job, cached, check)
            return cached, None, check  # already cached - nothing to store

    if reader == READER_MARKS:
        per_call = max(1, settings.mcq_ocr_pages_per_call)
        calls = mcq_marks.calls_for(len(pages), settings)
        _record(
            db, sub, "OCR & Parse",
            f"Printed MCQ paper: reading the marked option of every printed question on {len(pages)} page(s) with "
            f"the {provider} vision model ({model}), {per_call} page(s) per call, "
            f"{min(settings.ai_chunk_concurrency, calls)} at a time ({calls} call{'s' if calls != 1 else ''}; "
            f"options printed (1)-(4) are scored as A-D).",
            current_step="OCR & answer structuring",
        )
        ocr = _ai_call(
            job, "OCR & Parse", "AI call 1 (OCR)",
            lambda on_usage: mcq_marks.read_marked_options(
                pages, rubric.content, language_hints=hints, on_usage=on_usage
            ),
        )
        check = _paper_check(job, ocr)
        _ocr_artifact(job, ocr, check)
        return ocr, cache_key, check

    per_call = ai.ocr_pages_per_call(settings, rubric.content)
    split = (
        f" in {-(-len(pages) // per_call)} calls of up to {per_call} pages, "
        f"{settings.ai_chunk_concurrency} at a time"
        if len(pages) > per_call else ""
    )
    _record(
        db, sub, "OCR & Parse",
        f"Sending {len(pages)} page(s) to the {provider} vision model ({model}){split} to read the "
        f"answers and map them to question numbers (AI call 1; language hints: {', '.join(hints)}).",
        current_step="OCR & answer structuring",
    )
    ocr = _ai_call(
        job, "OCR & Parse", "AI call 1 (OCR)",
        lambda on_usage: ai.run_ocr(pages, rubric.content, language_hints=hints, on_usage=on_usage),
    )
    # A printed paper uploaded with a non-MCQ rubric lands here: its text layer is checked (no AI
    # call). The OCR call above stays - approving a held sheet grades this transcript.
    check = _text_layer_check(job)
    _ocr_artifact(job, ocr, check)
    return ocr, cache_key, check


def _transcript_cache_hit(job: _Job, cache_key: str, model: str) -> Transcript | None:
    """Same audio bytes (SHA-256) + model + hints + keywords: reuse the stored transcript, no call."""
    db, sub = job.db, job.sub
    row = db.scalar(select(OcrCache).where(OcrCache.cache_key == cache_key))
    if row is None:
        return None
    try:
        transcript = Transcript.model_validate(row.ocr_result)
    except ValidationError:
        logger.warning("Ignoring unreadable transcript cache row %s", row.id)
        return None
    row.hit_count = int(row.hit_count or 0) + 1
    row.last_hit_at = utcnow()
    provenance.record_invocation(
        db,
        usage=ModelUsage(purpose="transcription", provider="cache", model_requested=model,
                         model_served=row.model or model, status="cache_hit"),
        submission=sub,
    )
    logger.info("Transcript cache hit for submission %s - no transcription call", sub.id)
    _record(
        db, sub, "Transcription",
        f"{TRANSCRIPT_CACHE_HIT_LABEL}: SHA-256 {hashing.short_hash(sub.file_hash)} matched a stored "
        f"{row.model or model} transcript (reused {row.hit_count}x).",
        current_step="Transcription", ocr_cache_hit=True,
    )
    return transcript


def _store_cache_row(job: _Job, row: OcrCache) -> None:
    """Insert a cache row once (never errors: e.g. a concurrent insert of the same key)."""
    db = job.db
    try:
        if db.scalar(select(OcrCache.id).where(OcrCache.cache_key == row.cache_key)) is None:
            db.add(row)
            db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.warning("Could not store the cache entry for submission %s", job.sub.id, exc_info=True)


def _cache_hit(job: _Job, cache_key: str, provider: str, model: str) -> OcrResult | None:
    db, sub = job.db, job.sub
    row = db.scalar(select(OcrCache).where(OcrCache.cache_key == cache_key))
    if row is None:
        return None
    try:
        ocr = OcrResult.model_validate(row.ocr_result)
    except ValidationError:
        logger.warning("Ignoring unreadable OCR cache row %s", row.id)
        return None
    row.hit_count = int(row.hit_count or 0) + 1
    row.last_hit_at = utcnow()
    provenance.record_invocation(
        db,
        usage=ModelUsage(
            purpose="ocr", provider="cache", model_requested=model, model_served=row.model or model,
            status="cache_hit",
        ),
        submission=sub,
    )
    _record(
        db, sub, "OCR & Parse",
        f"{provenance.OCR_CACHE_HIT_LABEL}: SHA-256 {hashing.short_hash(sub.file_hash)} matched a stored "
        f"{row.provider or provider}/{row.model or model} transcript (reused {row.hit_count}x).",
        current_step="OCR & answer structuring", ocr_cache_hit=True,
    )
    return ocr


def _cache_store(job: _Job, cache_key: str | None, ocr: OcrResult) -> None:
    """Cache the model's own OCR once it passed the gate. Never errors, refusals or held sheets;
    faculty corrections live in ocr_reviews / ocr_reviewed.json, never in the cache."""
    if cache_key is None:
        return
    db, sub = job.db, job.sub
    provider, model = vision_model()
    if ocr.provider and ocr.provider != provider:
        # Served by the fallback model (FR-3.10): never stored under the primary model's cache key.
        logger.info("OCR for submission %s came from %s - not cached", sub.id, ocr.provider)
        return
    batch = sub.batch
    _store_cache_row(job, OcrCache(
        cache_key=cache_key,
        file_hash=sub.file_hash,
        institution_id=batch.institution_id if batch is not None else None,
        rubric_questions_hash=hashing.rubric_questions_hash(sub.rubric.content or {}),
        provider=ocr.provider or provider,
        model=ocr.model or model,
        prompt_version=getattr(ai, "OCR_PROMPT_VERSION", "ocr-v1"),
        language_hints=_language_hints(sub),
        ocr_result=ocr.model_dump(mode="json"),
    ))


# --------------------------------------------------------------------------- #
# Confidence gate (FR-2.4)
# --------------------------------------------------------------------------- #
def page_confidences(ocr: OcrResult, page_total: int | None) -> list[dict[str, Any]]:
    """[{page, confidence}]: the model's page legibility when given, else the mean confidence of
    the answers mapped to that page (single-page sheets map every answer to page 1)."""
    def clamp(value: Any) -> float:
        try:
            return max(0.0, min(1.0, float(value)))
        except (TypeError, ValueError):
            return 0.0

    def valid(page: Any) -> bool:
        return isinstance(page, int) and page >= 1 and (not page_total or page <= page_total)

    assessed = {a.page: clamp(a.legibility_confidence) for a in ocr.page_assessments if valid(a.page)}
    by_page: dict[int, list[float]] = {}
    for answer in ocr.answers:
        pages = [p for p in answer.pages if valid(p)] or ([1] if page_total == 1 else [])
        for page in set(pages):
            by_page.setdefault(page, []).append(clamp(answer.confidence))
    out = []
    for page in sorted(set(assessed) | set(by_page)):
        confidence = assessed[page] if page in assessed else fmean(by_page[page])
        out.append({"page": page, "confidence": round(confidence, 3)})
    return out


def coverage_message(ocr: OcrResult, rubric_content: dict[str, Any]) -> str:
    """'Mapped 4/5 rubric questions; Q5 not attempted; model returned Q7 (not in rubric) - discarded.'"""
    numbers = _rubric_numbers(rubric_content)
    answered = {a.question for a in ocr.answers if (a.answer or "").strip()}
    missing = [n for n in numbers if n not in answered]
    parts = [f"Mapped {len(numbers) - len(missing)}/{len(numbers)} rubric questions"]
    if missing:
        parts.append(f"{_qlist(missing)} not attempted")
    dropped = sorted(set(ocr.dropped_questions))
    if dropped:
        parts.append(f"model returned {_qlist(dropped)} (not in rubric) - discarded")
    return "; ".join(parts) + "."


@dataclass(frozen=True)
class ReviewDecision:
    """review_decision(): whether the gate holds a sheet, why, and the confidences it records."""

    hold: bool
    reason: str | None                  # review_reason when held (REVIEW_*), else None
    message: str | None                 # the held sheet's error_message, else None
    confidence: float                   # the sheet confidence stored as ocr_confidence
    pages: list[dict[str, Any]]         # [{page, confidence}] (page_confidences)
    flagged: list[int]                  # pages below the threshold
    answered: int                       # rubric questions with a non-empty answer
    questions: int                      # rubric questions
    page_legibility: bool = False       # nothing mapped: confidence is the mean page legibility
    paper_check_set_aside: bool = False  # a text-layer comparison's hold verdict not applied (answers mapped)


def _percent_range(values: list[float]) -> str:
    low, high = round(min(values) * 100), round(max(values) * 100)
    return f"{low}%" if low == high else f"{low}-{high}%"


def paper_check_set_aside_message(decision: ReviewDecision) -> str:
    """The log line for a text-layer comparison that review_decision set aside."""
    return (
        f"{PAPER_CHECK_PREFIX}not applied - {decision.answered} of {decision.questions} rubric questions have a "
        "transcribed answer, so the document's text is read as the student's answers, not another paper's "
        "questions."
    )


def review_decision(
    ocr: OcrResult, page_total: int, rubric_content: dict[str, Any] | None, threshold: float, *,
    paper_check: RubricMatch | None = None, rubric_label: str | None = None, voice: bool = False,
    text_layer: bool = False,
) -> ReviewDecision:
    """The review gate as a pure function (no DB, no I/O): used by _gate and recheck_held_sheets.

    Sheet confidence: the OCR's overall confidence, except when no rubric question has an answer
    and the pages were assessed - then the mean page legibility (the reading quality of the sheet;
    a mean over zero answers is not a confidence). Hold order:
      1. same-paper check verdict reordered / mismatch -> paper_reordered / paper_mismatch (its message).
         text_layer: the check came from the upload's text layer (a sheet read as handwriting,
         document_paper_check), which explains a sheet the reader could not map. Its comparison
         verdict holds only when fewer than half the rubric questions have an answer - a typed
         answer sheet's text is the student's answers, which never read like the rubric's questions;
         otherwise it is set aside (paper_check_set_aside) and the sheet goes on to 2-5. Its shape
         verdict (paper_match.structural: far more printed questions with option lists than the
         rubric has) holds either way. The marks reader's own check always holds;
      2. no answers, no page below the threshold and the sheet at or above it (a voice answer: no
         part of the recording mapped) -> no_answers;
      3. sheet confidence below the threshold -> low_confidence;
      4. any page below the threshold -> low_page_confidence;
      5. a document sheet with an answer for fewer than half the rubric questions -> mostly_blank."""
    pages = page_confidences(ocr, page_total)
    numbers = set(_rubric_numbers(rubric_content))
    answered = len(numbers & {a.question for a in ocr.answers if (a.answer or "").strip()})
    nothing = bool(numbers) and answered == 0
    legibility = nothing and bool(pages)
    confidence = (
        round(fmean(p["confidence"] for p in pages), 3) if legibility else round(float(ocr.overall_confidence), 3)
    )
    flagged = [p["page"] for p in pages if p["confidence"] < threshold]
    label = f"rubric {rubric_label}" if rubric_label else "the selected rubric"
    paper_hold = paper_check is not None and paper_check.verdict in paper_match.HOLD_VERDICTS
    set_aside = (
        paper_hold and text_layer and not paper_match.structural(paper_check) and answered * 2 >= len(numbers)
    )

    def decide(reason: str | None, message: str | None = None) -> ReviewDecision:
        if message is not None and len(message) > MAX_ERROR_CHARS:
            message = message[: MAX_ERROR_CHARS - 3] + "..."
        return ReviewDecision(
            hold=reason is not None, reason=reason, message=message, confidence=confidence, pages=pages,
            flagged=flagged, answered=answered, questions=len(numbers), page_legibility=legibility,
            paper_check_set_aside=set_aside,
        )

    if paper_hold and not set_aside:
        # Scoring against another paper's key would be silently wrong: faculty decide.
        reason = REVIEW_PAPER_REORDERED if paper_check.verdict == "reordered" else REVIEW_PAPER_MISMATCH
        return decide(reason, paper_check.message)
    if nothing and not flagged and (voice or confidence >= threshold):
        if voice:
            return decide(
                REVIEW_NO_ANSWERS,
                f"No part of the recording could be mapped to a question of {label} - routed to faculty "
                "review; AI evaluation skipped.",
            )
        none = (
            "its only question has no transcribed answer" if len(numbers) == 1
            else f"none of its {len(numbers)} questions has a transcribed answer"
        )
        legible = f" (page legibility {_percent_range([p['confidence'] for p in pages])})" if pages else ""
        return decide(
            REVIEW_NO_ANSWERS,
            f"No answers found for {label}: {none} although the pages read clearly{legible} - check that the "
            "sheet was uploaded with the right rubric; routed to faculty review; AI evaluation skipped.",
        )
    if confidence < threshold:
        message = (
            f"OCR confidence {confidence:.2f} is below the {threshold:.2f} threshold - "
            "routed to faculty review; AI evaluation skipped."
        )
        if flagged:
            message += f" Low-confidence page(s): {', '.join(map(str, flagged))}."
        return decide(REVIEW_LOW_CONFIDENCE, message)
    if flagged:
        return decide(
            REVIEW_LOW_PAGE_CONFIDENCE,
            f"Page {', '.join(map(str, flagged))} below the {threshold:.2f} threshold "
            f"(overall {confidence:.2f}) - routed to faculty review; AI evaluation skipped.",
        )
    if not voice and answered * 2 < len(numbers):  # a voice row answers one question
        return decide(
            REVIEW_MOSTLY_BLANK,
            f"Mostly blank sheet - confirm before grading: only {answered}/{len(numbers)} rubric questions have "
            "a transcribed answer - routed to faculty review; AI evaluation skipped.",
        )
    return decide(None)


def _gate(job: _Job, ocr: OcrResult, page_total: int, *, paper_check: RubricMatch | None = None) -> bool:
    """Record confidences; True (and HUMAN_REVIEW_REQUIRED with a review_reason) when
    review_decision holds the sheet: another paper or version (the check's message becomes the
    sheet's error message), no answers on legible pages, the sheet or any page below the threshold,
    or a document sheet with an answer for fewer than half of the rubric questions. A text-layer
    comparison set aside because the answers mapped is logged as not applied."""
    db, sub = job.db, job.sub
    threshold = get_settings().ocr_confidence_threshold
    rubric = sub.rubric
    decision = review_decision(
        ocr, page_total, rubric.content, threshold, paper_check=paper_check, rubric_label=rubric_label(rubric),
        voice=(sub.input_kind or "document") == INPUT_VOICE,
        text_layer=job.check_source == CHECK_SOURCE_TEXT_LAYER,
    )
    per_page = ", ".join(f"p{p['page']} {p['confidence']:.2f}" for p in decision.pages)
    if decision.page_legibility:
        head = (
            f"Extracted {len(ocr.answers)} answer(s); no rubric question has an answer, so the sheet confidence "
            f"is the page legibility {decision.confidence:.2f}"
        )
    else:
        head = f"Extracted {len(ocr.answers)} answer(s); overall OCR confidence {decision.confidence:.2f}"
    _record(
        db, sub, "OCR & Parse", head + (f"; page confidence {per_page}" if per_page else "") + ".",
        ocr_confidence=decision.confidence, page_confidences=decision.pages, flagged_pages=decision.flagged,
    )
    _record(db, sub, "OCR & Parse", coverage_message(ocr, rubric.content or {}))
    if decision.paper_check_set_aside:
        _record(db, sub, "OCR & Parse", paper_check_set_aside_message(decision))
    if not decision.hold:
        return False
    if decision.reason in (REVIEW_PAPER_MISMATCH, REVIEW_PAPER_REORDERED):
        # Approving the sheet in the review editor grades it in an evaluation-only run, which never
        # re-checks; a re-run with another rubric checks again.
        _record(
            db, sub, "Human review", PAPER_HOLD_MESSAGE,
            status=SubmissionStatus.HUMAN_REVIEW_REQUIRED, current_step="Human review",
            error_message=decision.message, review_reason=decision.reason,
        )
        return True
    for page in decision.pages:
        if page["page"] in decision.flagged:
            append_log(
                sub, "Human review",
                f"Page {page['page']} average {page['confidence']:.2f} < {threshold:.2f} - held for faculty review.",
            )
    _record(
        db, sub, "Human review", decision.message or "",
        status=SubmissionStatus.HUMAN_REVIEW_REQUIRED, current_step="Human review",
        error_message=decision.message, review_reason=decision.reason,
    )
    return True


# --------------------------------------------------------------------------- #
# evaluation_only: stored transcript
# --------------------------------------------------------------------------- #
def transcript_artifact(ocr: OcrResult, rubric: Rubric, **extra: Any) -> dict[str, Any]:
    """ocr.json / ocr_reviewed.json: the OcrResult plus the rubric it was mapped against (so a
    later rubric version can tell new questions from unattempted ones)."""
    return {
        **ocr.model_dump(mode="json"),
        "rubric_id": rubric.id,
        "rubric_version": rubric.version,
        "rubric_questions": _rubric_numbers(rubric.content),
        **extra,
    }


def stored_transcript(submission_id: int) -> tuple[OcrResult | None, str | None, dict[str, Any]]:
    """(transcript, artifact name, raw artifact): the faculty-reviewed transcript first, else the
    raw OCR; (None, None, {}) when neither exists."""
    for name in (REVIEWED_OCR_FILE, OCR_FILE):
        data = read_artifact(submission_id, name)
        if data is None:
            continue
        try:
            return OcrResult.model_validate(data), name, data
        except ValidationError:
            logger.warning("Unreadable %s for submission %s", name, submission_id)
    return None, None, {}


def _stored_answers(job: _Job) -> list[OcrAnswer]:
    """The stored answers re-normalised against the submission's (possibly new) rubric."""
    db, sub = job.db, job.sub
    ocr, source, raw = stored_transcript(sub.id)
    if ocr is None:
        raise TranscriptMissingError(
            "No stored OCR transcript is available to re-use for this sheet - re-scan it to run OCR again."
        )
    rubric = sub.rubric
    numbers = set(_rubric_numbers(rubric.content))
    answers = [a for a in ocr.answers if a.question in numbers]
    removed = sorted({a.question for a in ocr.answers} - numbers)
    mapped_against = {n for n in raw.get("rubric_questions") or [] if isinstance(n, int)}
    known = mapped_against or ({a.question for a in ocr.answers} | set(ocr.dropped_questions))
    new = sorted(n for n in numbers if n not in known)
    what = "faculty-reviewed transcript" if source == REVIEWED_OCR_FILE else "stored OCR transcript"
    _record(
        db, sub, "OCR & Parse",
        f"{OCR_REUSED_MESSAGE} ({what}, {len(answers)} answer(s) for rubric {rubric.version}).",
    )
    for number in new:
        append_log(
            sub, "OCR & Parse",
            f"Q{number} is new in {rubric.version} - not in the stored OCR; re-scan needed to grade it.",
        )
    if removed:
        append_log(
            sub, "OCR & Parse",
            f"{_qlist(removed)} not in rubric {rubric.version} - stored answer(s) ignored.",
        )
    if new or removed:
        db.commit()
    return answers


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #
def _run_cost(db: Session, sub: StudentSubmission) -> dict[str, Any]:
    """Cost of producing the new result: every invocation since the previous result was
    superseded (or since upload), so faculty-review runs include their earlier OCR call and a
    re-evaluation counts only its grading call."""
    cutoff: datetime | None = None
    if sub.result is not None:
        cutoff = sub.result.created_at
    else:
        latest = results_store.latest_version(db, sub.id)
        if latest is not None:
            cutoff = latest.superseded_at
    return provenance.summarise_costs(provenance.invocations_for(db, sub.id, since=cutoff))


def _persist(job: _Job, report: dict[str, Any]) -> None:
    db, sub = job.db, job.sub
    settings = get_settings()
    rubric = sub.rubric
    cost = _run_cost(db, sub)
    if sub.result is not None:
        results_store.archive_current_result(db, sub, superseded_by_rubric_id=rubric.id)
    previous = results_store.latest_version(db, sub.id)
    version = results_store.next_version(db, sub)
    breakdown = {
        "ocr_inr": cost["ocr_inr"],
        "evaluation_inr": cost["evaluation_inr"],
        "other_inr": cost["other_inr"],
        "calls": cost["calls"],
        "cache_hits": cost["cache_hits"],
    }
    sub.result = results_store.build_evaluation_result(
        report, rubric=rubric, version=version, llm_cost_inr=cost["total_inr"], cost_breakdown=breakdown,
    )
    _write_artifact(job.job_dir, REPORT_FILE, report)
    sub.completed_at = utcnow()

    score = f"{_fmt(report['total_score'])}/{_fmt(report['total_marks'])}"
    if job.reason == "reevaluate" and previous is not None:
        append_log(
            sub, "Persistence",
            f"Re-evaluated with rubric {rubric.version} ({previous.rubric_version or '?'}: "
            f"{_fmt(previous.total_score)}/{_fmt(previous.total_marks)} -> {rubric.version}: {score}); "
            "OCR reused - no vision call.",
        )
    total = cost["total_inr"]
    cost_text = (
        f"LLM cost Rs {total:.2f} vs the Rs {settings.cost_target_inr:.2f} target"
        if total is not None else "LLM cost unknown (model not in the price table)"
    )
    calls = f"{cost['calls']} AI call{'s' if cost['calls'] != 1 else ''}"
    if cost["cache_hits"]:
        calls += f" + {cost['cache_hits']} OCR cache hit{'s' if cost['cache_hits'] != 1 else ''}"
    latency = provenance.latency_seconds(sub)
    latency_text = f"; {latency:.1f} s from queue to result" if latency is not None else ""
    _record(
        db, sub, "Persistence",
        f"Saved to the governed results store (SQLite mock of RDS) as result v{version}: {score} marks, "
        f"{float(report['overall_mastery']):.1f}% of the total; {cost_text} ({calls}){latency_text}.",
        status=SubmissionStatus.COMPLETED, current_step="Completed", error_message=None, last_error_code=None,
        review_reason=None,
    )


# --------------------------------------------------------------------------- #
# Dead-letter queue
# --------------------------------------------------------------------------- #
def _fail(job: _Job, step: str, exc: BaseException) -> None:
    submission_id = job.sub.id
    logger.exception("Submission %s failed during %s", submission_id, step)
    code = error_code(exc)
    transient = bool(getattr(exc, "transient", False))
    message = failure_message(exc)
    rid = _request_id(exc, job.call_log)
    if rid and rid not in message:
        message = f"{message} (request {rid})"
    if transient and code == "provider_unavailable":
        message = f"{message} {NO_FALLBACK_NOTE}"
    message = message if len(message) <= MAX_ERROR_CHARS else message[: MAX_ERROR_CHARS - 3] + "..."
    try:
        attempt_number = int(job.sub.attempts or job.run_attempt)
    except Exception:  # noqa: BLE001 - the session may need a rollback first
        attempt_number = job.run_attempt
    attempts = [
        *job.attempts,
        {
            "attempt": attempt_number,
            "step": step,
            "error_code": code,
            "transient": transient,
            "message": message,
            "request_id": rid,
            "backoff_seconds": None,
            "timestamp": utc_iso(),
        },
    ]
    _write_artifact(
        job.job_dir,
        DEAD_LETTER_FILE,
        {
            "submission_id": submission_id,
            "failed_step": step,
            "error_type": type(exc).__name__,
            "error_code": code,
            "error_message": message,
            "transient": transient,
            "request_id": rid,
            "mode": job.mode,
            "reason": job.reason,
            "attempts": attempts,
            "timestamp": utc_iso(),
        },
    )
    db = job.db
    try:
        db.rollback()
        sub = db.get(StudentSubmission, submission_id)
        if sub is None:
            return
        db.refresh(sub)
        changes: dict[str, Any] = {}
        if isinstance(exc, CustodyError):
            changes["custody_verified"] = False
        tries = f"after {len(attempts)} attempt{'s' if len(attempts) != 1 else ''}" if len(attempts) > 1 else ""
        _record(
            db, sub, "Dead-letter queue",
            f"{step} failed - routed to the dead-letter queue (simulated DLQ){' ' + tries if tries else ''} "
            f"[{code}]: {message} Use Retry to re-drive.",
            status=SubmissionStatus.FAILED, current_step="Failed", error_message=message, last_error_code=code,
            review_reason=None, **changes,
        )
    except Exception:  # noqa: BLE001
        logger.exception("Could not mark submission %s as FAILED", submission_id)


# --------------------------------------------------------------------------- #
# Synthetic demo re-grade (no AI)
# --------------------------------------------------------------------------- #
def synthetic_regrade(db: Session, sub: StudentSubmission, target: Rubric) -> EvaluationResult:
    """Re-grade a COMPLETED demo row against `target` with NO AI call: archived grades are kept
    for questions that still exist (marks clamped to the new max); new questions score 0.
    Archives the current result, moves the row to `target` and commits."""
    current = sub.result
    if current is None:
        raise ValueError("synthetic_regrade needs a completed submission")
    old = {}
    for item in current.question_evaluations or []:
        try:
            old[int(item["question"])] = item
        except (KeyError, TypeError, ValueError):
            continue

    answers: list[OcrAnswer] = []
    grades: list[QuestionGrade] = []
    for question in (target.content or {}).get("questions") or []:
        number = int(question["question"])
        max_marks = float(question["max_marks"])
        item = old.get(number)
        if item is None:
            grades.append(QuestionGrade(
                question=number, estimated_marks=0.0, evidence=f"{DEMO_NEW_QUESTION_GAP}.",
                strengths=[], gaps=[DEMO_NEW_QUESTION_GAP],
            ))
            continue
        text = str(item.get("student_answer") or "")
        if text.strip():
            answers.append(OcrAnswer(
                question=number, answer=text, confidence=float(item.get("confidence") or 0.0),
                pages=[p for p in item.get("source_pages") or [] if isinstance(p, int)],
                source="faculty" if item.get("corrected_by_faculty") else "ocr",
            ))
        grades.append(QuestionGrade(
            question=number,
            estimated_marks=max(0.0, min(float(item.get("estimated_marks") or 0.0), max_marks)),
            evidence=str(item.get("evidence") or "Demo grade carried over."),
            strengths=[str(s) for s in item.get("strengths") or []],
            gaps=[str(g) for g in item.get("gaps") or []],
        ))
    strengths_gaps = current.strengths_gaps if isinstance(current.strengths_gaps, dict) else {}
    evaluation = EvaluationOutput(
        evaluations=grades,
        overall_strengths=[str(s) for s in strengths_gaps.get("strengths") or []][:3],
        overall_gaps=[str(g) for g in strengths_gaps.get("gaps") or []][:3],
        summary=current.summary or "",
    )
    report = _validated_report(insights.build_evaluation_report(target.content, answers, evaluation))

    previous_rubric = sub.rubric
    archived = results_store.archive_current_result(db, sub, superseded_by_rubric_id=target.id)
    sub.rubric_id = target.id
    sub.rubric = target
    version = results_store.next_version(db, sub)
    result = results_store.build_evaluation_result(report, rubric=target, version=version)
    sub.result = result
    sub.completed_at = utcnow()
    before = (
        f"{previous_rubric.version}: {_fmt(archived.total_score)}/{_fmt(archived.total_marks)}"
        if archived is not None else previous_rubric.version
    )
    append_log(sub, "Queue", f"{DEMO_REGRADE_MESSAGE} - re-grading the stored demo answers against {target.version}.")
    _record(
        db, sub, "Persistence",
        f"Re-evaluated with rubric {target.version} ({before} -> {target.version}: "
        f"{_fmt(report['total_score'])}/{_fmt(report['total_marks'])}); OCR reused - no vision call. "
        f"{DEMO_REGRADE_MESSAGE}.",
        status=SubmissionStatus.COMPLETED, current_step="Completed", review_reason=None,
    )
    return result


# --------------------------------------------------------------------------- #
# Startup recovery
# --------------------------------------------------------------------------- #
def recover_interrupted_jobs(db: Session) -> int:
    """Jobs left PENDING/PROCESSING by a previous server run can never finish: fail them so an
    operator can re-drive them with Retry."""
    stuck = db.scalars(
        select(StudentSubmission).where(
            StudentSubmission.status.in_([SubmissionStatus.PENDING, SubmissionStatus.PROCESSING])
        )
    ).all()
    for sub in stuck:
        sub.status = SubmissionStatus.FAILED
        sub.current_step = "Failed"
        sub.error_message = INTERRUPTED_MESSAGE
        sub.last_error_code = "interrupted"
        sub.review_reason = None
        append_log(sub, "Dead-letter queue", INTERRUPTED_MESSAGE)
        sub.updated_at = utcnow()
    if stuck:
        db.commit()
        logger.warning("Marked %d interrupted submission(s) as FAILED", len(stuck))
    return len(stuck)


def recheck_held_sheets(db: Session) -> int:
    """Startup backfill, no AI call: sheets held by an older build (review_reason NULL, not demo
    rows) that still have their raw OCR (ocr.json) and no faculty-reviewed transcript are re-gated
    with review_decision - from the stored OCR, the stored page count, the rubric, and the stored
    paper check or the text-layer check of the upload still on disk. A sheet that still holds gets
    its confidences, review_reason and error message updated plus one "Human review" log line; one
    that would pass now is left untouched (faculty decide). Idempotent (review_reason is set).
    Returns the number of rows updated. Never raises."""
    try:
        ids = list(db.scalars(
            select(StudentSubmission.id).where(
                StudentSubmission.status == SubmissionStatus.HUMAN_REVIEW_REQUIRED,
                StudentSubmission.review_reason.is_(None),
                StudentSubmission.is_demo.is_not(True),
            ).order_by(StudentSubmission.id)
        ))
    except Exception:  # noqa: BLE001 - start-up must never fail on the backfill
        logger.exception("Could not list held sheets to re-check")
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return 0
    settings = get_settings()
    updated = 0
    for submission_id in ids:
        try:
            if _recheck_held_sheet(db, submission_id, settings):
                updated += 1
        except Exception:  # noqa: BLE001 - one bad row must not stop the others
            logger.exception("Could not re-check held submission %s - left unchanged", submission_id)
            try:
                db.rollback()
            except Exception:  # noqa: BLE001
                pass
    if updated:
        logger.info("Re-checked %d held sheet(s) with the updated review rules", updated)
    return updated


def _recheck_held_sheet(db: Session, submission_id: int, settings: Settings) -> bool:
    sub = db.get(StudentSubmission, submission_id)
    if sub is None or sub.rubric is None:
        return False
    if (settings.artifact_dir / str(sub.id) / REVIEWED_OCR_FILE).exists():
        return False  # faculty already worked on the transcript
    data = read_artifact(sub.id, OCR_FILE)
    if data is None:
        return False
    try:
        ocr = OcrResult.model_validate(data)
    except ValidationError:
        return False
    rubric = sub.rubric
    if data.get("rubric_id") not in (None, rubric.id):
        return False  # mapped against another rubric - nothing comparable to re-gate
    voice = (sub.input_kind or "document") == INPUT_VOICE
    page_total = 0 if voice else int(sub.page_count or 0) or max(
        (a.page for a in ocr.page_assessments if isinstance(a.page, int) and a.page >= 1), default=1
    )
    label = rubric_label(rubric)
    check: RubricMatch | None = None
    stored = data.get("paper_check")
    if isinstance(stored, dict):
        try:
            check = RubricMatch.model_validate(stored)
        except ValidationError:
            check = None
    # Where the stored check came from; without paper_check_source, only the marks reader's OCR has
    # printed stems or a code (the handwriting reader returns neither).
    source = data.get("paper_check_source") or (
        CHECK_SOURCE_MARKS if ocr.question_stems or ocr.paper_code else CHECK_SOURCE_TEXT_LAYER
    )
    # A rescan skips the check because faculty already saw one; an older build never checked a
    # sheet read as handwriting, so a rescan without any paper check in its log is checked now.
    run = read_artifact(sub.id, RUN_FILE) or {}
    seen_check = any(
        isinstance(entry, dict) and str(entry.get("message") or "").startswith(PAPER_CHECK_PREFIX)
        for entry in sub.processing_log or []
    )
    path = Path(sub.file_path) if sub.file_path else None
    if (
        check is None and not voice and not (run.get("reason") == "rescan" and seen_check)
        and (sub.mime_type or "") in TEXT_LAYER_MIME_TYPES and path is not None and path.is_file()
    ):
        try:
            check = document_paper_check(path.read_bytes(), rubric.content, rubric_label=label, settings=settings)
        except Exception:  # noqa: BLE001 - retried on the next start-up
            logger.warning(
                "Text-layer check failed for held submission %s - re-checked on the next start-up",
                sub.id, exc_info=True,
            )
            return False
        source = CHECK_SOURCE_TEXT_LAYER
    decision = review_decision(
        ocr, page_total, rubric.content, settings.ocr_confidence_threshold, paper_check=check,
        rubric_label=label, voice=voice, text_layer=source == CHECK_SOURCE_TEXT_LAYER,
    )
    if not decision.hold:
        return False
    _record(
        db, sub, "Human review", f"{RECHECK_PREFIX}{decision.message}",
        ocr_confidence=decision.confidence, page_confidences=decision.pages, flagged_pages=decision.flagged,
        review_reason=decision.reason, error_message=decision.message,
    )
    return True


def last_run_mode(submission_id: int) -> str:
    """Mode of the submission's last run (run.json / dead_letter.json); 'full' when unknown or
    when an evaluation-only run has no transcript left to re-use."""
    for name in (DEAD_LETTER_FILE, RUN_FILE):
        data = read_artifact(submission_id, name)
        if data and data.get("mode") in MODES:
            mode = data["mode"]
            if mode == MODE_EVALUATION_ONLY and stored_transcript(submission_id)[0] is None:
                return MODE_FULL
            return mode
    return MODE_FULL
