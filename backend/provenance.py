"""Provenance: model invocations (tokens, latency, cost), chain of custody, extraction
coverage, cost/latency summaries, version history and cohort operations (BRD FR-1.4, FR-2.x,
acceptance 14.3: cost per student, every LLM call traced, latency per sheet).

Every read here is defensive: rows written by older builds (NULL columns, no artifacts) and
synthetic demo rows still produce schema-valid dicts.
"""
from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timedelta
from statistics import fmean
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

import costing
import results_store
import voice
from ai_schemas import ModelUsage
from config import get_settings, ocr_adapter_label
from database import (
    EvaluationResult,
    ModelInvocation,
    Rubric,
    StudentSubmission,
    SubmissionStatus,
)

logger = logging.getLogger("3ilens.provenance")

# Wording required by the client demo for a cached OCR result (UI + audit log).
OCR_CACHE_HIT_LABEL = "OCR cache hit - no vision call (Rs 0.00)"
CUSTODY_DETECTED_BY = "magic bytes (file signature), not the file extension"
LANGUAGE_CODES = ("en", "hi", "ta", "kn", "te")
# processing_log steps that mark the start of a run (upload, operator re-drive, re-evaluation...).
RUN_START_STEPS = ("Ingestion", "Queue")
# Log lines written up to this long after completed_at still belong to the run (final Persistence
# lines); later ones (faculty sign-off, release, delivery) are not pipeline stages.
STAGE_GRACE_SECONDS = 5.0
# The only pipeline step that writes log lines after completed_at is set (the final save lines).
POST_COMPLETION_STAGE_STEPS = ("Persistence",)
# Cost buckets: speech-to-text and transcript mapping are the voice answer's "extraction" (OCR).
OCR_BUCKET_PURPOSES = ("ocr", "transcription", "voice_mapping")
VOICE_ADAPTER = "OpenAI {model} speech-to-text (PoC stand-in for Whisper large-v3 / Sarvam Saarika)"


def record_invocation(
    db: Session,
    *,
    usage: ModelUsage,
    submission: StudentSubmission | None,
    commit: bool = False,
) -> ModelInvocation:
    """Persist one provider call (or OCR cache hit) with its USD/INR cost. Never stores text."""
    if usage.status == "cache_hit":
        cost_usd: float | None = 0.0
    else:
        cost_usd = costing.cost_usd(usage.model_served or usage.model_requested, usage)
        if cost_usd is None and usage.model_served and usage.model_served != usage.model_requested:
            cost_usd = costing.cost_usd(usage.model_requested, usage)
    institution_id = None
    batch_id = None
    if submission is not None:
        batch_id = submission.batch_id
        batch = submission.batch
        institution_id = batch.institution_id if batch is not None else None
    row = ModelInvocation(
        institution_id=institution_id,
        batch_id=batch_id,
        submission_id=submission.id if submission is not None else None,
        purpose=usage.purpose,
        provider=usage.provider,
        model_requested=usage.model_requested,
        model_served=usage.model_served,
        request_id=usage.request_id,
        input_tokens=int(usage.input_tokens or 0),
        output_tokens=int(usage.output_tokens or 0),
        cache_creation_input_tokens=int(usage.cache_creation_input_tokens or 0),
        cache_read_input_tokens=int(usage.cache_read_input_tokens or 0),
        image_count=int(usage.image_count or 0),
        latency_ms=int(usage.latency_ms or 0),
        status=usage.status,
        error_code=usage.error_code,
        fell_back=bool(usage.fell_back),
        cost_usd=cost_usd,
        cost_inr=costing.to_inr(cost_usd),
    )
    db.add(row)
    if commit:
        db.commit()
    else:
        db.flush()
    return row


# --------------------------------------------------------------------------- #
# Small shared helpers
# --------------------------------------------------------------------------- #
def invocations_for(db: Session, submission_id: int, *, since: datetime | None = None) -> list[ModelInvocation]:
    query = select(ModelInvocation).where(ModelInvocation.submission_id == submission_id)
    if since is not None:
        query = query.where(ModelInvocation.created_at >= since)
    return list(db.scalars(query.order_by(ModelInvocation.id)).all())


def summarise_costs(rows: list[ModelInvocation]) -> dict[str, Any]:
    """{total_inr, ocr_inr, evaluation_inr, other_inr, calls, cache_hits} for invocation rows.
    total_inr is None only when every priced call had an unknown model (no cost known at all)."""
    buckets = {"ocr": 0.0, "evaluation": 0.0, "other": 0.0}
    known = False
    calls = cache_hits = 0
    for row in rows:
        if row.status == "cache_hit":
            cache_hits += 1
        else:
            calls += 1
        if row.cost_inr is None:
            continue
        known = True
        if row.purpose in OCR_BUCKET_PURPOSES:
            key = "ocr"
        else:
            key = "evaluation" if row.purpose == "evaluation" else "other"
        buckets[key] += float(row.cost_inr)
    total = sum(buckets.values()) if known or not calls else None
    return {
        "total_inr": None if total is None else round(total, 4),
        "ocr_inr": round(buckets["ocr"], 4),
        "evaluation_inr": round(buckets["evaluation"], 4),
        "other_inr": round(buckets["other"], 4),
        "calls": calls,
        "cache_hits": cache_hits,
    }


def ocr_artifact(sub: StudentSubmission, name: str = "ocr.json") -> dict[str, Any] | None:
    """A JSON artifact of the submission (ocr.json / ocr_reviewed.json), or None."""
    path = get_settings().artifact_dir / str(sub.id) / name
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _int_list(values: Any) -> list[int]:
    out = []
    for value in values or []:
        try:
            out.append(int(value))
        except (TypeError, ValueError):
            continue
    return out


def _page_confidences(values: Any) -> list[dict[str, Any]]:
    out = []
    for item in values or []:
        if not isinstance(item, dict):
            continue
        try:
            out.append({"page": int(item["page"]), "confidence": round(float(item["confidence"]), 3)})
        except (KeyError, TypeError, ValueError):
            continue
    return out


# --------------------------------------------------------------------------- #
# Result extras
# --------------------------------------------------------------------------- #
def _custody(sub: StudentSubmission) -> dict[str, Any] | None:
    if sub.is_demo or not sub.file_hash:
        return None
    return {
        "sha256": sub.file_hash,
        "size_bytes": int(sub.file_size or 0),
        "page_count": sub.page_count,
        "mime_type": sub.mime_type,
        "detected_by": CUSTODY_DETECTED_BY,
        "verified": bool(sub.custody_verified),
        "verified_at": (sub.started_at or sub.completed_at) if sub.custody_verified else None,
    }


def _voice_adapter(db: Session | None, sub: StudentSubmission) -> str:
    """'OpenAI gpt-transcribe speech-to-text (PoC stand-in ...) + Claude transcript mapping'."""
    transcript = None if sub.is_demo else voice.read_transcript(sub.id)
    model = (transcript or {}).get("model") or get_settings().openai_transcribe_model
    label = VOICE_ADAPTER.format(model=model)
    mapped = False
    if db is not None and not sub.is_demo:
        mapped = db.scalar(
            select(ModelInvocation.id).where(
                ModelInvocation.submission_id == sub.id, ModelInvocation.purpose == "voice_mapping"
            ).limit(1)
        ) is not None
    return label + (" + Claude transcript mapping" if mapped else "")


def _extraction(sub: StudentSubmission, result: EvaluationResult, db: Session | None = None) -> dict[str, Any]:
    settings = get_settings()
    threshold = settings.ocr_confidence_threshold
    questions = [q for q in result.question_evaluations or [] if isinstance(q, dict)]
    answered = [q for q in questions if str(q.get("student_answer") or "").strip()]
    confidences = []
    for q in answered:
        try:
            confidences.append(float(q.get("confidence") or 0))
        except (TypeError, ValueError):
            continue
    ocr = None if sub.is_demo else ocr_artifact(sub)
    dropped = _int_list((ocr or {}).get("dropped_questions"))
    is_voice = voice.is_voice(sub)
    return {
        "mapped": len(answered),
        "total_questions": len(questions),
        "unattempted": _int_list(q.get("question") for q in questions if q not in answered),
        "dropped": sorted(set(dropped)),
        "mean_confidence": round(fmean(confidences), 3) if confidences else sub.ocr_confidence,
        "min_confidence": round(min(confidences), 3) if confidences else None,
        "below_threshold": sum(1 for c in confidences if c < threshold),
        "threshold": threshold,
        # A voice answer has no pages (FR-2.8).
        "flagged_pages": [] if is_voice else _int_list(sub.flagged_pages),
        "page_confidences": [] if is_voice else _page_confidences(sub.page_confidences),
        "ocr_adapter": _voice_adapter(db, sub) if is_voice else ocr_adapter_label(settings),
        "ocr_cache_hit": bool(sub.ocr_cache_hit),
        "language_hints": [h for h in (sub.language_hints or []) if h in LANGUAGE_CODES] or ["en"],
        "corrected_by_faculty": any(bool(q.get("corrected_by_faculty")) for q in questions),
    }


def _cost(db: Session, sub: StudentSubmission, result: EvaluationResult) -> dict[str, Any]:
    settings = get_settings()
    breakdown = result.cost_breakdown if isinstance(result.cost_breakdown, dict) else {}
    cost = result.llm_cost_inr
    calls = breakdown.get("calls")
    ocr_inr = breakdown.get("ocr_inr")
    evaluation_inr = breakdown.get("evaluation_inr")
    other_inr = breakdown.get("other_inr")
    if not sub.is_demo and (cost is None or not isinstance(calls, int)):
        # Rows persisted before cost tracking: summarise whatever was recorded for the sheet.
        summary = summarise_costs(invocations_for(db, sub.id))
        if cost is None and (summary["calls"] or summary["cache_hits"]):
            cost = summary["total_inr"]
            ocr_inr, evaluation_inr, other_inr = summary["ocr_inr"], summary["evaluation_inr"], summary["other_inr"]
        if not isinstance(calls, int):
            calls = summary["calls"]
    return {
        "llm_cost_inr": cost,
        "ocr_inr": ocr_inr,
        "evaluation_inr": evaluation_inr,
        "other_inr": other_inr,
        "target_inr": settings.cost_target_inr,
        "within_target": None if cost is None else cost <= settings.cost_target_inr,
        "calls": int(calls or 0),
        "ocr_cache_hit": bool(sub.ocr_cache_hit),
        "synthetic": bool(sub.is_demo),
        "usd_inr": settings.usd_inr,
    }


def run_start(sub: StudentSubmission) -> datetime | None:
    """When the latest run was queued: the newest Ingestion/Queue log entry at or before
    started_at (upload, operator re-drive, faculty review or re-evaluation), else created_at."""
    started = sub.started_at
    queued = sub.created_at
    if started is None:
        return queued
    for entry in sub.processing_log or []:
        if not isinstance(entry, dict) or entry.get("step") not in RUN_START_STEPS:
            continue
        ts = _parse_ts(entry.get("timestamp"))
        if ts is not None and ts <= started and (queued is None or ts > queued):
            queued = ts
    return queued


def latency_seconds(sub: StudentSubmission) -> float | None:
    start = run_start(sub)
    if sub.completed_at is None or start is None:
        return None
    return round(max(0.0, (sub.completed_at - start).total_seconds()), 1)


def _after(ts: datetime, moment: datetime | None) -> bool:
    """ts > moment; False when moment is None or the two cannot be compared (naive vs aware
    timestamps from legacy rows keep the entry)."""
    if moment is None:
        return False
    try:
        return ts > moment
    except TypeError:
        return False


def _stages(sub: StudentSubmission, start: datetime | None) -> list[dict[str, Any]]:
    """Seconds spent per pipeline step in the latest run. Only pipeline steps count: anything
    logged after completed_at (faculty sign-off, release, delivery, interventions) is ignored,
    except the run's own final Persistence lines written within a few seconds of completed_at."""
    end = sub.completed_at
    cutoff = end + timedelta(seconds=STAGE_GRACE_SECONDS) if end is not None else None
    entries = []
    for entry in sub.processing_log or []:
        if not isinstance(entry, dict):
            continue
        ts = _parse_ts(entry.get("timestamp"))
        if ts is None or (start is not None and ts < start):
            continue
        step = str(entry.get("step") or "Step")
        if _after(ts, end) and (step not in POST_COMPLETION_STAGE_STEPS or _after(ts, cutoff)):
            continue
        entries.append((step, ts))
    totals: dict[str, float] = {}
    for index, (step, ts) in enumerate(entries):
        nxt = entries[index + 1][1] if index + 1 < len(entries) else ts
        totals[step] = totals.get(step, 0.0) + max(0.0, (nxt - ts).total_seconds())
    return [{"step": step, "seconds": round(seconds, 1)} for step, seconds in totals.items()]


def _latency(sub: StudentSubmission) -> dict[str, Any]:
    settings = get_settings()
    seconds = latency_seconds(sub)
    return {
        "seconds": seconds,
        "target_seconds": settings.latency_target_seconds,
        "within_target": None if seconds is None else seconds <= settings.latency_target_seconds,
        "stages": _stages(sub, run_start(sub)),
    }


def version_rows(
    db: Session, sub: StudentSubmission, result: EvaluationResult | None, rubric: Rubric, *, always: bool = False
) -> list[dict[str, Any]]:
    """Archived versions + the current result (if any), oldest first. Unless `always`, [] while the
    result has never been re-run (no history to show)."""
    archived = results_store.versions(db, sub.id)
    if not archived and not always:
        return []
    rubrics: dict[int, Rubric | None] = {rubric.id: rubric}

    def rubric_for(rubric_id: int | None) -> Rubric | None:
        if rubric_id is None:
            return None
        if rubric_id not in rubrics:
            rubrics[rubric_id] = db.get(Rubric, rubric_id)
        return rubrics[rubric_id]

    out: list[dict[str, Any]] = []
    for version in archived:
        rubric_id = version.rubric_id or sub.rubric_id
        owner = rubric_for(rubric_id)
        out.append({
            "version": int(version.version or 1),
            "rubric_id": rubric_id,
            "rubric_version": version.rubric_version or (owner.version if owner else "?"),
            "rubric_hash": version.rubric_hash or (owner.rubric_hash if owner else None),
            "total_score": version.total_score,
            "total_marks": version.total_marks,
            "created_at": version.created_at,
            "superseded_at": version.superseded_at,
            "current": False,
        })
    if result is None:
        return out
    current_rubric_id = result.rubric_id or sub.rubric_id
    owner = rubric_for(current_rubric_id) or rubric
    current_version = result.version or (max((v["version"] for v in out), default=0) + 1)
    out.append({
        "version": int(current_version),
        "rubric_id": current_rubric_id,
        "rubric_version": owner.version,
        "rubric_hash": result.rubric_hash or owner.rubric_hash,
        "total_score": result.total_score,
        "total_marks": result.total_marks,
        "created_at": result.created_at,
        "superseded_at": None,
        "current": True,
    })
    return sorted(out, key=lambda v: (v["version"], v["current"]))


def result_extras(
    db: Session, *, sub: StudentSubmission, result: EvaluationResult, rubric: Rubric
) -> dict[str, Any]:
    """Keys: custody, extraction, cost, latency, versions."""
    return {
        "custody": _custody(sub),
        "extraction": _extraction(sub, result, db),
        "cost": _cost(db, sub, result),
        "latency": _latency(sub),
        "versions": version_rows(db, sub, result, rubric),
    }


# --------------------------------------------------------------------------- #
# Cohort operations
# --------------------------------------------------------------------------- #
def _p95(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(0.95 * len(ordered)) - 1)]


def cohort_operations(db: Session, *, subs: list[StudentSubmission]) -> dict[str, Any]:
    """An Operations dict for the cohort: provider calls and spend, cost per completed live
    student, OCR cache hits, latency of live completed sheets vs target, DLQ size, mean OCR
    confidence of completed sheets."""
    settings = get_settings()
    ids = [s.id for s in subs]
    rows: list[ModelInvocation] = []
    if ids:
        rows = list(db.scalars(select(ModelInvocation).where(ModelInvocation.submission_id.in_(ids))).all())
    summary = summarise_costs(rows)
    total = summary["total_inr"] or 0.0
    completed = [s for s in subs if s.status == SubmissionStatus.COMPLETED]
    completed_live = [s for s in completed if not s.is_demo]
    # Cost per student counts only sheets with traced calls: rows graded before cost tracking
    # existed have no invocations and would otherwise dilute the average.
    traced_ids = {r.submission_id for r in rows}
    traced_live = [s for s in completed_live if s.id in traced_ids]
    latencies = [v for v in (latency_seconds(s) for s in completed_live) if v is not None]
    confidences = [float(s.ocr_confidence) for s in completed if s.ocr_confidence is not None]
    return {
        "calls": summary["calls"],
        "total_cost_inr": round(total, 2),
        # None (unknown) when nothing was traced - e.g. sheets graded before cost tracking existed.
        "avg_cost_per_student_inr": (
            round(total / len(traced_live), 2) if traced_live and summary["total_inr"] is not None
            else None
        ),
        "ocr_cache_hits": summary["cache_hits"],
        "avg_latency_seconds": round(fmean(latencies), 1) if latencies else None,
        "p95_latency_seconds": _p95(latencies),
        "over_latency_target": sum(1 for v in latencies if v > settings.latency_target_seconds),
        "dlq_count": sum(1 for s in subs if s.status == SubmissionStatus.FAILED),
        "mean_ocr_confidence": round(fmean(confidences), 3) if confidences else None,
        "target_inr": settings.cost_target_inr,
        "target_latency_seconds": settings.latency_target_seconds,
    }
