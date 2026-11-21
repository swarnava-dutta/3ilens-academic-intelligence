"""SHA-256 helpers: chain of custody, OCR-cache keys, rubric fingerprints and student refs."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

CHUNK = 1024 * 1024
STUDENT_REF_MAX = 160


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str | Path, chunk: int = CHUNK) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def sha256_json(obj: Any) -> str:
    """Stable hash of a JSON-able value (sorted keys, compact separators, UTF-8)."""
    return hashlib.sha256(canonical_json(obj).encode("utf-8")).hexdigest()


def rubric_hash(content: dict[str, Any]) -> str:
    """Fingerprint of the full rubric content (any edit changes it)."""
    return sha256_json(content)


def rubric_questions_hash(content: dict[str, Any]) -> str:
    """Fingerprint of what OCR sees (question number, topic, prompt) - part of the OCR cache key,
    so editing marks or criteria reuses cached OCR while a changed question list does not."""
    questions = content.get("questions") if isinstance(content, dict) else None
    view = [
        {"question": q.get("question"), "topic": q.get("topic"), "prompt": q.get("prompt")}
        for q in (questions or [])
        if isinstance(q, dict)
    ]
    return sha256_json(view)


def student_ref_for(name: str, roll_no: str | None = None) -> str:
    """Stable student key: the roll number (upper-cased) when given, else a slug of the name
    ("Aarav  Sharma" -> "aarav-sharma"). Links a student's assessments over time."""
    if roll_no is not None and roll_no.strip():
        return roll_no.strip().upper()[:STUDENT_REF_MAX]
    slug = re.sub(r"[\W_]+", "-", (name or "").casefold()).strip("-")
    return (slug or "student")[:STUDENT_REF_MAX]


def short_hash(value: str | None, length: int = 8) -> str:
    """'3f9a1c2b...' style prefix for logs and the UI."""
    return f"{value[:length]}..." if value else "-"
