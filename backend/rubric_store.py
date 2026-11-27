"""Rubric persistence and versioning (FR-3.4, FR-5.7). Every rubric write goes through
create_rubric so rubric_hash, total_marks and the version label are always consistent."""
from __future__ import annotations

import re
from typing import Any

from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

import hashing
from database import Rubric, RubricStatus
from errors import ApiError
from schemas import RubricContentIn

RUBRIC_REQUIRED_DETAIL = (
    "Add the question paper or the answer key - every upload needs its own answer key (rubric)."
)


def format_validation_errors(exc: ValidationError, limit: int = 5) -> str:
    """'questions[0].max_marks: Input should be greater than 0; ...' (at most `limit` errors)."""
    parts = []
    for err in exc.errors()[:limit]:
        loc = ""
        for piece in err["loc"]:
            loc += f"[{piece}]" if isinstance(piece, int) else (f".{piece}" if loc else str(piece))
        msg = str(err["msg"]).removeprefix("Value error, ")
        parts.append(f"{loc}: {msg}" if loc else msg)
    extra = exc.error_count() - limit
    return "; ".join(parts) + (f" (+{extra} more)" if extra > 0 else "")


def validate_content(data: Any, field: str = "rubric_json") -> RubricContentIn:
    """An inline rubric (already JSON-decoded) -> RubricContentIn, or 422 invalid_rubric. Shared
    by POST /api/upload (rubric_json) and POST /api/submissions/{id}/rerun (rubric)."""
    if not isinstance(data, dict):
        raise ApiError(422, f"{field} must be a JSON object with name, subject and questions.", "invalid_rubric")
    try:
        return RubricContentIn.model_validate(data)
    except ValidationError as exc:
        raise ApiError(422, f"Invalid {field} - {format_validation_errors(exc)}", "invalid_rubric") from exc

_VERSION_RE = re.compile(r"^v(\d+)$", re.IGNORECASE)
# Fields whose change marks a question as "changed" between two rubric versions.
_COMPARED_FIELDS = (
    "topic", "subject", "chapter", "max_marks", "prompt", "expected_answer", "grading_criteria", "effort_hours",
    # contract v3 fields (bloom_source is provenance only and is not compared)
    "question_type", "options", "correct_option", "negative_marks", "bloom_level", "concept", "marking_scheme",
    "partial_credit", "mark_step", "accepted_options", "bonus",
)


def create_rubric(
    db: Session,
    content: RubricContentIn,
    *,
    parent: Rubric | None = None,
    change_note: str | None = None,
    status: str = RubricStatus.AUTHOR_DRAFT,
    version: str | None = None,
) -> Rubric:
    """Insert (and flush) a rubric. Version: explicit value; else for a child of `parent`,
    'v{n+1}' where n is the highest vN among rubrics named like the parent; else 'custom-{k}'."""
    data = content.model_dump(exclude_none=True)
    if version is None:
        if parent is not None:
            versions = db.scalars(select(Rubric.version).where(Rubric.name == parent.name)).all()
            numbers = [int(m.group(1)) for v in versions if (m := _VERSION_RE.match(v or ""))]
            version = f"v{max([*numbers, 1]) + 1}"
        else:
            existing = db.scalar(
                select(func.count()).select_from(Rubric).where(Rubric.version.like("custom-%"))
            ) or 0
            version = f"custom-{existing + 1}"
    rubric = Rubric(
        name=content.name,
        version=version,
        content=data,
        total_marks=content.total_marks,
        rubric_hash=hashing.rubric_hash(data),
        status=str(status),
        parent_id=parent.id if parent is not None else None,
        change_note=(change_note or "").strip() or None,
    )
    db.add(rubric)
    db.flush()
    return rubric


def _questions(content: dict[str, Any] | None) -> dict[int, dict[str, Any]]:
    out: dict[int, dict[str, Any]] = {}
    for q in (content or {}).get("questions") or []:
        if not isinstance(q, dict):
            continue
        try:
            out[int(q.get("question"))] = q
        except (TypeError, ValueError):
            continue
    return out


def compatibility(old_content: dict[str, Any] | None, new_content: dict[str, Any] | None) -> dict[str, Any]:
    """{reusable, added, removed, changed}. reusable means the question-number sets are
    identical, so stored OCR answers map 1:1 onto the new version."""
    old, new = _questions(old_content), _questions(new_content)
    added = sorted(set(new) - set(old))
    removed = sorted(set(old) - set(new))
    # A changed rubric-wide marking policy re-scores every question present in both versions.
    policy_changed = (old_content or {}).get("marking_policy") != (new_content or {}).get("marking_policy")
    changed = sorted(
        n for n in set(old) & set(new)
        if policy_changed or any(old[n].get(field) != new[n].get(field) for field in _COMPARED_FIELDS)
    )
    return {"reusable": not added and not removed, "added": added, "removed": removed, "changed": changed}


def ensure_rubric_fields(rubric: Rubric) -> bool:
    """Backfill rubric_hash/status on rows written by older builds. Returns True if changed."""
    changed = False
    content_hash = hashing.rubric_hash(rubric.content or {})
    if rubric.rubric_hash != content_hash:
        rubric.rubric_hash = content_hash
        changed = True
    if not rubric.status:
        rubric.status = RubricStatus.AUTHOR_DRAFT
        changed = True
    return changed
