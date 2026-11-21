"""3iLens Academic Intelligence - FastAPI orchestrator (contract: /API_CONTRACT.md).

Local stand-ins for the AWS pipeline: BackgroundTasks (SQS + ECS worker), ./uploads and
./artifacts (S3), SQLite (RDS). Run from backend/:
    .venv/Scripts/python.exe -m uvicorn main:app --reload --port 8000

Package routers (routers/*.py) add the pipeline-ops, analytics and outputs endpoints.
"""
from __future__ import annotations

import json
import logging
import re
from contextlib import asynccontextmanager
from statistics import fmean
from typing import Annotated, Any, Literal

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from starlette.types import ASGIApp, Message, Receive, Scope, Send

import ai
import cohort
import costing
import pipeline
import result_view
import rubric_store
import seed
import uploads
from ai_schemas import ModelUsage
from config import accepted_upload_types, accepted_voice_types, get_settings, llm_fallback_label, ocr_adapter_label
from database import (
    INPUT_DOCUMENT,
    INPUT_VOICE,
    Batch,
    Institution,
    ModelInvocation,
    Rubric,
    SessionLocal,
    StudentSubmission,
    SubmissionStatus,
    get_db,
    init_db,
)
from errors import ApiError, install_error_handlers
from hashing import student_ref_for
from routers import ai_ops, analytics_routes, insights_routes, lms, outputs, owner_routes, pipeline_ops, voice_routes
from schemas import (
    LANGUAGE_HINTS,
    CohortOut,
    DemoSeedOut,
    HealthOut,
    ReevaluationEstimate,
    ResultOut,
    ResultPendingOut,
    RubricContentIn,
    RubricOut,
    SubmissionOut,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("3ilens.api")

DbSession = Annotated[Session, Depends(get_db)]
UrgencyQuery = Literal["on_track", "needs_attention", "at_risk"]
DemoSetQuery = Literal["genetics", "mixed", "all", "insights"]

MAX_STUDENT_NAME = 120
MAX_ROLL_NO = 40
CHUNK_SIZE = uploads.CHUNK_SIZE
INTAKE_BATCH_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
# Upload intake lives in uploads.py (shared with POST /api/submissions/{id}/rescan).
MIME_EXTENSIONS = uploads.MIME_EXTENSIONS
PIL_FORMATS = uploads.PIL_FORMATS
DISTRIBUTION_LABELS = cohort.DISTRIBUTION_LABELS
# Fallback per-student grading estimate when no evaluation call has been recorded yet:
# a 5-question rubric with effort=high grading is roughly this many tokens.
ESTIMATE_INPUT_TOKENS = 6000
ESTIMATE_OUTPUT_TOKENS = 6000


# --------------------------------------------------------------------------- #
# App setup
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    settings.artifact_dir.mkdir(parents=True, exist_ok=True)
    init_db()  # create_all + idempotent column migration for older databases
    with SessionLocal() as db:
        seed.seed_base(db)
        pipeline.recover_interrupted_jobs(db)
    ready, missing = _ai_readiness()
    if not ready:
        logger.warning("AI providers not ready - missing configuration: %s", ", ".join(missing) or "unknown")
    yield


class CatchAllErrorsMiddleware:
    """Turns unhandled errors into a JSON 500 *inside* CORS, so the browser can read it."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, tracking_send)
        except Exception:
            logger.exception("Unhandled error on %s %s", scope.get("method"), scope.get("path"))
            if started:
                raise
            response = JSONResponse({"detail": "Internal server error - see the backend logs."}, status_code=500)
            await response(scope, receive, send)


app = FastAPI(
    title="3iLens Academic Intelligence API",
    version="0.2.0",
    description="Local PoC orchestrator: upload -> OCR -> rubric evaluation -> insights & Preparation ROI.",
    lifespan=lifespan,
)
install_error_handlers(app)
app.add_middleware(CatchAllErrorsMiddleware)
app.add_middleware(  # added last = outermost, so even error responses carry CORS headers
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    # Local PoC: also accept the Next dev server on any local port (start.bat falls back to
    # 3001+ when 3000 is taken). Only loopback origins match.
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d{1,5})?",
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _ai_readiness() -> tuple[bool, list[str]]:
    try:
        ready, missing = ai.ai_readiness()
        return bool(ready), [str(m) for m in missing]
    except NotImplementedError:
        return False, ["AI layer not implemented yet"]
    except Exception:  # noqa: BLE001
        logger.exception("ai.ai_readiness() failed")
        return False, ["AI readiness check failed - see the backend logs"]


def _context(db: Session) -> tuple[Institution, Batch]:
    institution = db.scalar(select(Institution).order_by(Institution.id))
    batch = db.scalar(select(Batch).order_by(Batch.id))
    if institution is None or batch is None:
        institution, batch, _ = seed.seed_base(db)
    return institution, batch


# Kept for callers/tests that used the v1 private helpers.
_institution_out = result_view.institution_out
_batch_out = result_view.batch_out
_submission_out = result_view.submission_out
_processing_log = result_view.processing_log
_pending_detail = result_view.pending_detail


_unprocessable = uploads.unprocessable
sniff_mime = uploads.sniff_mime
sanitize_filename = uploads.sanitize_filename
_display_filename = uploads.display_filename
_store_upload = uploads.store_upload
_discard = uploads.discard
_inspect_document = uploads.inspect_document
_human_size = uploads.human_size


def _format_validation_errors(exc: ValidationError, limit: int = 5) -> str:
    parts = []
    for err in exc.errors()[:limit]:
        loc = ""
        for piece in err["loc"]:
            loc += f"[{piece}]" if isinstance(piece, int) else (f".{piece}" if loc else str(piece))
        msg = str(err["msg"]).removeprefix("Value error, ")
        parts.append(f"{loc}: {msg}" if loc else msg)
    extra = exc.error_count() - limit
    return "; ".join(parts) + (f" (+{extra} more)" if extra > 0 else "")


def _validate_student_name(raw: str | None) -> str:
    name = " ".join((raw or "").split())
    if not name:
        raise _unprocessable("Student name is required.", "invalid_student_name")
    if len(name) > MAX_STUDENT_NAME:
        raise _unprocessable(f"Student name must be at most {MAX_STUDENT_NAME} characters.", "invalid_student_name")
    return name


def _validate_roll_no(raw: str | None) -> str | None:
    roll = " ".join((raw or "").split())
    if not roll:
        return None
    if len(roll) > MAX_ROLL_NO or not re.fullmatch(r"[A-Za-z0-9/_.\- ]+", roll):
        raise _unprocessable(
            f"Roll number must be at most {MAX_ROLL_NO} letters, digits, spaces or - _ . /", "invalid_roll_no"
        )
    return roll


def _validate_language_hints(raw: str | None) -> list[str]:
    """'en,hi' -> ['en', 'hi'] (default ['en']); unknown codes -> 422 invalid_language."""
    codes = [c.strip().lower() for c in (raw or "").replace(";", ",").split(",") if c.strip()]
    if not codes:
        return ["en"]
    unknown = [c for c in codes if c not in LANGUAGE_HINTS]
    if unknown:
        raise _unprocessable(
            f"Unsupported answer language(s): {', '.join(unknown)}. Use {', '.join(LANGUAGE_HINTS)}.",
            "invalid_language",
        )
    return list(dict.fromkeys(codes))


def _validate_intake_batch_id(raw: str | None) -> str | None:
    value = (raw or "").strip()
    if not value:
        return None
    if not INTAKE_BATCH_RE.fullmatch(value):
        raise _unprocessable(
            "intake_batch_id must be 1-64 letters, digits or hyphens.", "invalid_intake_batch"
        )
    return value


def _resolve_batch(db: Session, batch_id: str | None) -> Batch | None:
    if batch_id is None or not batch_id.strip():
        return None
    try:
        bid = int(batch_id.strip())
    except ValueError as exc:
        raise _unprocessable("batch_id must be an integer.", "unknown_batch") from exc
    batch = db.get(Batch, bid)
    if batch is None:
        raise _unprocessable(f"Batch {bid} does not exist.", "unknown_batch")
    return batch


def _resolve_rubric(
    db: Session, rubric_id: str | None, rubric_json: str | None
) -> tuple[Rubric | None, RubricContentIn | None]:
    """Returns (existing rubric, None) or (None, validated custom content)."""
    if rubric_json and rubric_json.strip():
        try:
            data = json.loads(rubric_json)
        except json.JSONDecodeError as exc:
            raise _unprocessable(
                f"rubric_json is not valid JSON ({exc.msg} at line {exc.lineno}, column {exc.colno}).",
                "invalid_rubric",
            ) from exc
        if not isinstance(data, dict):
            raise _unprocessable("rubric_json must be a JSON object with name, subject and questions.", "invalid_rubric")
        try:
            return None, RubricContentIn.model_validate(data)
        except ValidationError as exc:
            raise _unprocessable(f"Invalid rubric_json - {_format_validation_errors(exc)}", "invalid_rubric") from exc

    if rubric_id and rubric_id.strip():
        try:
            rid = int(rubric_id.strip())
        except ValueError as exc:
            raise _unprocessable("rubric_id must be an integer.", "invalid_rubric") from exc
        rubric = db.get(Rubric, rid)
        if rubric is None:
            raise _unprocessable(f"Rubric {rid} does not exist.", "unknown_rubric")
        return rubric, None

    rubric = seed.get_default_rubric(db)
    if rubric is None:
        _, _, rubric = seed.seed_base(db)
    return rubric, None


def _validate_voice_question(
    raw: str | None, rubric: Rubric | None, custom_rubric: RubricContentIn | None
) -> int | None:
    """FR-2.8 one recording per question: voice_question must be one of the rubric's question
    numbers; empty means a whole-paper recording (the transcript is mapped by the AI)."""
    value = (raw or "").strip()
    if not value:
        return None
    if custom_rubric is not None:
        numbers = {q.question for q in custom_rubric.questions}
    else:
        numbers = set()
        for q in ((rubric.content if rubric is not None else None) or {}).get("questions") or []:
            try:
                numbers.add(int(q["question"]))
            except (KeyError, TypeError, ValueError):
                continue
    try:
        number = int(value)
    except ValueError:
        number = None
    if number is None or number not in numbers:
        raise _unprocessable("voice_question must be one of the rubric's question numbers.", "invalid_question")
    return number


def _create_custom_rubric(db: Session, content: RubricContentIn) -> Rubric:
    return rubric_store.create_rubric(db, content)


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.get("/api/health", response_model=HealthOut)
def health(db: DbSession) -> HealthOut:
    ready, missing = _ai_readiness()
    institution, batch = _context(db)
    settings = get_settings()
    return HealthOut(
        status="ok",
        ai_ready=ready,
        vision_provider=settings.vision_provider,
        missing_configuration=missing,
        ocr_confidence_threshold=settings.ocr_confidence_threshold,
        institution=result_view.institution_out(institution),
        batch=result_view.batch_out(batch),
        ocr_adapter=ocr_adapter_label(settings),
        ocr_cache_enabled=settings.ocr_cache_enabled,
        cost_target_inr=settings.cost_target_inr,
        latency_target_seconds=settings.latency_target_seconds,
        batch_target_seconds=settings.batch_target_seconds,
        whatsapp_mode=settings.whatsapp_mode,
        max_upload_mb=settings.max_upload_mb,
        accepted_upload_types=accepted_upload_types(settings),
        voice_enabled=settings.voice_answers_enabled,
        voice_ready=settings.voice_answers_enabled and bool(settings.openai_api_key),
        transcription_model=settings.openai_transcribe_model,
        accepted_voice_types=accepted_voice_types(settings),
        llm_fallback=llm_fallback_label(settings),
        lms_api_enabled=settings.lms_api_enabled,
    )


@app.get("/api/rubrics", response_model=list[RubricOut])
def list_rubrics(db: DbSession) -> list[RubricOut]:
    rubrics = db.scalars(select(Rubric).order_by(Rubric.id)).all()
    return [result_view.rubric_out(r) for r in rubrics]


@app.get("/api/rubrics/{rubric_id}/reevaluation-estimate", response_model=ReevaluationEstimate)
def reevaluation_estimate(rubric_id: int, db: DbSession) -> ReevaluationEstimate:
    """Confirmation data for a bulk re-run after a rubric edit: how many COMPLETED students on
    this rubric would be re-graded and roughly what it costs (OCR is reused: 0 vision calls)."""
    rubric = db.get(Rubric, rubric_id)
    if rubric is None:
        raise ApiError(404, f"Rubric {rubric_id} not found.", "unknown_rubric")
    subs = db.scalars(
        select(StudentSubmission)
        .where(StudentSubmission.rubric_id == rubric_id, StudentSubmission.status == SubmissionStatus.COMPLETED)
        .order_by(StudentSubmission.id)
    ).all()
    live = [s for s in subs if not s.is_demo]
    settings = get_settings()
    recent = db.scalars(
        select(ModelInvocation.cost_inr)
        .where(ModelInvocation.purpose == "evaluation", ModelInvocation.status == "ok",
               ModelInvocation.cost_inr.is_not(None))
        .order_by(ModelInvocation.id.desc())
        .limit(20)
    ).all()
    if recent:
        per_student = round(fmean(float(c) for c in recent), 2)
        basis = (
            f"Average of the last {len(recent)} recorded grading call(s) ({settings.anthropic_model}); "
            "OCR reused - no vision calls; demo rows are re-graded synthetically (Rs 0.00)."
        )
    else:
        usage = ModelUsage(
            purpose="evaluation", provider="anthropic", model_requested=settings.anthropic_model,
            input_tokens=ESTIMATE_INPUT_TOKENS, output_tokens=ESTIMATE_OUTPUT_TOKENS,
        )
        per_student = round(costing.to_inr(costing.cost_usd(settings.anthropic_model, usage)) or 0.0, 2)
        basis = (
            f"Rough estimate: ~{ESTIMATE_INPUT_TOKENS:,} input + ~{ESTIMATE_OUTPUT_TOKENS:,} output tokens per "
            f"student on {settings.anthropic_model} at USD_INR {settings.usd_inr:g}; OCR reused - no vision "
            "calls; demo rows are re-graded synthetically (Rs 0.00)."
        )
    return ReevaluationEstimate(
        rubric_id=rubric_id,
        submission_ids=[s.id for s in subs],
        students=len(subs),
        live_students=len(live),
        demo_students=len(subs) - len(live),
        evaluation_calls=len(live),
        ocr_calls=0,
        estimated_cost_inr=round(per_student * len(live), 2),
        estimated_cost_per_student_inr=per_student if live else 0.0,
        basis=basis,
    )


@app.post("/api/upload", status_code=202, response_model=SubmissionOut)
def upload_answer_sheet(
    background_tasks: BackgroundTasks,
    db: DbSession,
    file: Annotated[UploadFile | None, File()] = None,
    student_name: Annotated[str | None, Form()] = None,
    rubric_id: Annotated[str | None, Form()] = None,
    rubric_json: Annotated[str | None, Form()] = None,
    roll_no: Annotated[str | None, Form()] = None,
    language_hints: Annotated[str | None, Form()] = None,
    batch_id: Annotated[str | None, Form()] = None,
    intake_batch_id: Annotated[str | None, Form()] = None,
    voice_question: Annotated[str | None, Form()] = None,
) -> SubmissionOut:
    """A scanned / typed answer sheet or a voice answer (FR-2.8: MP3 / WAV / M4A / OGG, sniffed
    from the bytes). voice_question = the rubric question one recording answers; omit it for a
    whole-paper recording. It is ignored for documents."""
    settings = get_settings()
    name = _validate_student_name(student_name)
    rubric, custom_rubric = _resolve_rubric(db, rubric_id, rubric_json)  # validated before saving the upload
    roll = _validate_roll_no(roll_no)
    languages = _validate_language_hints(language_hints)
    chosen_batch = _resolve_batch(db, batch_id)
    intake_id = _validate_intake_batch_id(intake_batch_id)
    if file is None or not file.filename:
        raise _unprocessable(
            f"Attach an answer sheet ({uploads.ACCEPTED_LABEL}) or a voice answer (MP3, WAV, M4A or OGG).",
            "missing_file",
        )

    original_filename = _display_filename(file.filename)
    path, mime_type, size, sha256 = _store_upload(file, original_filename, settings)
    is_voice = uploads.is_audio_mime(mime_type)
    try:
        description, page_count = _inspect_document(path, mime_type, settings)
        question = _validate_voice_question(voice_question, rubric, custom_rubric) if is_voice else None
        if custom_rubric is not None:
            rubric = _create_custom_rubric(db, custom_rubric)
        assert rubric is not None
        batch = chosen_batch or _context(db)[1]
        sub = StudentSubmission(
            student_name=name,
            file_path=str(path.resolve()),
            original_filename=original_filename,
            mime_type=mime_type,
            status=SubmissionStatus.PENDING,
            current_step="Queued",
            processing_log=[],
            is_demo=False,
            batch_id=batch.id,
            rubric_id=rubric.id,
            file_hash=sha256,
            file_size=size,
            page_count=page_count,
            language_hints=languages,
            student_ref=student_ref_for(name, roll),
            intake_batch_id=intake_id,
            attempts=0,
            input_kind=INPUT_VOICE if is_voice else INPUT_DOCUMENT,
            audio_seconds=uploads.audio_seconds(path, mime_type) if is_voice else None,
            voice_question=question,
            detected_languages=[],
        )
        if is_voice:
            answers = (
                f"Answers Q{question} (one recording per question)." if question is not None
                else "Whole recording - the transcript will be mapped to the rubric questions."
            )
            received = (
                f"Received {original_filename} (voice answer, {description}) and stored it in the local S3 "
                f"mock (uploads/). SHA-256 {sha256[:12]}... recorded for chain of custody. {answers}"
            )
        else:
            received = (
                f"Received {original_filename} ({description}, {_human_size(size)}) and stored it in the "
                f"local S3 mock (uploads/). SHA-256 {sha256[:12]}... recorded for chain of custody."
            )
        pipeline.append_log(sub, "Ingestion", received)
        uploads.duplicate_notice(db, sub)
        pipeline.append_log(
            sub, "Queue",
            f"Job queued via FastAPI BackgroundTasks (local SQS mock) with rubric '{rubric.name}' ({rubric.version}).",
        )
        db.add(sub)
        db.commit()
    except BaseException:
        db.rollback()
        _discard(path)
        raise

    background_tasks.add_task(pipeline.process_submission, sub.id)
    logger.info("Queued submission %s (%s, %s)", sub.id, mime_type, _human_size(size))
    return result_view.submission_out(sub)


@app.get("/api/submissions", response_model=list[SubmissionOut])
def list_submissions(
    db: DbSession,
    batch_id: int | None = None,
    rubric_id: int | None = None,
    urgency: UrgencyQuery | None = None,
    intake_batch_id: str | None = None,
) -> list[SubmissionOut]:
    query = (
        select(StudentSubmission)
        .options(selectinload(StudentSubmission.result), selectinload(StudentSubmission.rubric))
        .order_by(StudentSubmission.created_at.desc(), StudentSubmission.id.desc())
    )
    if batch_id is not None:
        query = query.where(StudentSubmission.batch_id == batch_id)
    if rubric_id is not None:
        query = query.where(StudentSubmission.rubric_id == rubric_id)
    if intake_batch_id:
        query = query.where(StudentSubmission.intake_batch_id == intake_batch_id.strip())
    out = [result_view.submission_out(s) for s in db.scalars(query).all()]
    if urgency is not None:
        out = [s for s in out if s.urgency == urgency]
    return out


@app.get(
    "/api/results/{submission_id}",
    response_model=ResultOut,
    responses={202: {"model": ResultPendingOut, "description": "Not completed (pending, processing, review, failed)"},
               404: {"description": "Submission not found"}},
)
def get_result(submission_id: int, db: DbSession) -> Any:
    sub = db.get(
        StudentSubmission,
        submission_id,
        options=[selectinload(StudentSubmission.result), selectinload(StudentSubmission.rubric)],
    )
    if sub is None:
        raise HTTPException(status_code=404, detail=f"Submission {submission_id} not found.")

    if sub.status != SubmissionStatus.COMPLETED or sub.result is None:
        pending = result_view.pending_out(sub)
        return JSONResponse(status_code=202, content=pending.model_dump(mode="json"))
    return result_view.build_result(db, sub)


@app.get("/api/cohort", response_model=CohortOut)
def get_cohort(
    db: DbSession,
    batch_id: int | None = None,
    rubric_id: int | None = None,
    urgency: UrgencyQuery | None = None,
    topic: str | None = None,
) -> CohortOut:
    return cohort.build_cohort(db, batch_id=batch_id, rubric_id=rubric_id, urgency=urgency, topic=topic)


@app.post("/api/demo/seed", response_model=DemoSeedOut)
def seed_demo(
    db: DbSession,
    demo_set: Annotated[DemoSetQuery, Query(alias="set")] = "genetics",
) -> DemoSeedOut:
    try:
        created = seed.seed_demo_set(db, demo_set)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("Demo cohort seeding failed")
        raise HTTPException(status_code=500, detail="Demo cohort seeding failed - see the backend logs.") from exc
    message = (
        f"Added {created} synthetic demo submissions (is_demo=true; no AI calls)."
        if created
        else "Demo cohort is already loaded - nothing to add."
    )
    return DemoSeedOut(message=message, created=created)


# Package routers last, so the core routes above keep their v1 registration order.
app.include_router(pipeline_ops.router)
app.include_router(analytics_routes.router)
app.include_router(outputs.router)
# Wave 2 (contract v3).
app.include_router(ai_ops.router)
app.include_router(voice_routes.router)
app.include_router(lms.router)
app.include_router(owner_routes.router)
app.include_router(insights_routes.router)
