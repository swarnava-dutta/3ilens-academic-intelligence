"""Rubric source files kept with an intake's answer key (API_CONTRACT.md "Rubric sources").

Not a library: every intake drafts its own answer key from its own question paper. The files that
key was drafted from - the question paper / rubric file (kind "paper") and an optional separate
answer-key file (kind "key") - come with the intake's first POST /api/upload (the one that sends
rubric_json) and are kept only so the report can show a small preview of them:

- GET /api/rubrics/{id}/sources                           -> [{kind, role, filename, file_type, pages}]
- GET /api/rubrics/{id}/sources/{kind}/preview?page&width -> a page image
(both in routers/pipeline_ops.py; the image comes from the intake-preview renderer, routers/preview_routes)

role says what the file is, for its label: the "paper" file is a question_paper (default), a
rubric_file (a rubric as JSON / text) or a marked_copy (a teacher's copy whose ticks are the key) -
upload's optional form field rubric_source_role; the "key" file is always an answer_key.

Storage: artifact_dir/rubrics/<rubric id>/paper.<ext> and key.<ext> plus sources.json, a list of
{kind, role, filename, mime_type, file_type, pages} (entries written before roles existed have no
role: labelled by kind), and previews/ - the page images already rendered, keyed by kind, page and
width, so a report opened again does not render the file again. A new version of a rubric (POST
/api/rubrics/{id}/versions - the intake's edited key) gets the same files (inherit), so the preview
survives an edit. An inline key sent to /rerun or /reevaluate gets none: the report drafts it from a
newly uploaded question paper, which is not stored, so the old files would preview the wrong paper. scripts/reset_data.py moves the whole of artifacts/ - this folder included - into
its backup. Files are checked like POST /api/intake/preview (PDF, Word, JPEG / PNG / WEBP, text in
UTF-8 or UTF-16; the upload size limit; corrupt / password-protected files refused). Every refusal
names the file ("Question paper file: ..." / "Answer key file: ...") and every 415 reads
UNSUPPORTED_DETAIL.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import UploadFile

import uploads
from config import get_settings
from errors import ApiError
from routers import preview_routes

logger = logging.getLogger("3ilens.rubric_sources")

KINDS = ("paper", "key")
LABELS = {"paper": "Question paper file", "key": "Answer key file"}  # error prefixes (the frontend reads them)
DEFAULT_NAMES = {"paper": "question_paper", "key": "answer_key"}
ROLES = ("question_paper", "rubric_file", "marked_copy", "answer_key")
PAPER_ROLES = ("question_paper", "rubric_file", "marked_copy", "answer_key")  # upload's rubric_source_role
DEFAULT_ROLES = {"paper": "question_paper", "key": "answer_key"}
ROLE_NAMES = {"question_paper": "question paper", "rubric_file": "rubric file", "marked_copy": "marked copy",
              "answer_key": "answer key"}
FOLDER = "rubrics"
SOURCES_FILE = "sources.json"
PREVIEW_FOLDER = "previews"
PREVIEW_CACHE_MAX = 200  # rendered page images kept per rubric; past it pages are rendered, not cached
EXTENSIONS = {"pdf": ".pdf", "docx": ".docx", "jpeg": ".jpg", "png": ".png", "webp": ".webp", "text": ".txt"}
TYPE_NAMES = {"pdf": "PDF", "docx": "Word", "text": "text"}  # else "<TYPE> image"
UNSUPPORTED_DETAIL = (
    "Unsupported file type: use a PDF, Word (.docx, without macros), image (JPEG, PNG, WEBP) or text file."
)
ENTRY_KEYS = ("kind", "role", "filename", "mime_type", "file_type", "pages")


@dataclass(frozen=True)
class StagedSource:
    """A checked file, held in memory until its rubric row exists."""

    kind: str
    filename: str
    data: bytes
    mime_type: str
    file_type: str
    pages: int
    role: str = ""


def role_for(kind: str, role: str | None = None) -> str:
    """The stored role of a source file: the "key" file is an answer_key; the "paper" file takes
    upload's rubric_source_role when it is one of PAPER_ROLES (any case; spaces or hyphens for the
    underscore), else question_paper. An unknown role is ignored - it only picks a label and never
    refuses an upload."""
    if kind != "paper":
        return DEFAULT_ROLES.get(kind, "answer_key")
    wanted = "_".join(str(role or "").strip().casefold().replace("-", " ").replace("_", " ").split())
    return wanted if wanted in PAPER_ROLES else DEFAULT_ROLES["paper"]


def stage(kind: str, file: UploadFile | None, role: str | None = None) -> StagedSource | None:
    """Read and check one source file (the checks of POST /api/intake/preview: size, type by content,
    a page that can be drawn). None when no file was attached. Errors keep the preview's codes (413
    too_large, 422 empty_file / corrupt_pdf / password_pdf / no_pages / corrupt_image / corrupt_docx /
    docx_too_large / too_many_pages, 415 unsupported_signature / macro_docx; an audio file is 415
    unsupported_signature) with the detail prefixed by the file's label ("Question paper file: ...");
    every 415 reads "<label>: UNSUPPORTED_DETAIL". `role`: upload's rubric_source_role (role_for)."""
    if file is None or not file.filename:
        return None
    label = LABELS[kind]
    try:
        data = preview_routes.read_upload(file)
        rendered = preview_routes.render(data, 1, preview_routes.MIN_WIDTH)
    except ApiError as exc:
        if exc.status_code == 415:
            code = "unsupported_signature" if exc.code == "no_preview" else exc.code
            raise ApiError(415, f"{label}: {UNSUPPORTED_DETAIL}", code) from exc
        raise ApiError(exc.status_code, f"{label}: {exc.detail}", exc.code) from exc
    return StagedSource(
        kind=kind,
        filename=uploads.display_filename(file.filename) if file.filename.strip() else DEFAULT_NAMES[kind],
        data=data,
        mime_type=rendered.mime_type,
        file_type=rendered.file_type,
        pages=rendered.pages,
        role=role_for(kind, role),
    )


def folder(rubric_id: int) -> Path:
    return get_settings().artifact_dir / FOLDER / str(int(rubric_id))


def _stored_name(kind: str, file_type: str) -> str:
    return f"{kind}{EXTENSIONS.get(file_type, '.bin')}"


def _entry(source: StagedSource) -> dict[str, Any]:
    return {
        "kind": source.kind, "role": source.role or role_for(source.kind), "filename": source.filename,
        "mime_type": source.mime_type, "file_type": source.file_type, "pages": source.pages,
    }


def remove(rubric_id: int) -> None:
    """Delete the rubric's source folder (best effort)."""
    target = folder(rubric_id)
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)


def store(rubric_id: int, sources: list[StagedSource]) -> bool:
    """Write the files and sources.json, replacing whatever the folder held (a rubric id reused after
    a rolled-back insert). Best effort: a disk error is logged, the folder removed and False returned
    - the preview is a convenience, never a reason to refuse an upload."""
    if not sources:
        return False
    target = folder(rubric_id)
    try:
        remove(rubric_id)
        target.mkdir(parents=True, exist_ok=True)
        for source in sources:
            (target / _stored_name(source.kind, source.file_type)).write_bytes(source.data)
        (target / SOURCES_FILE).write_text(json.dumps([_entry(s) for s in sources], indent=2), encoding="utf-8")
    except OSError:
        logger.exception("Could not store the rubric source files of rubric %s", rubric_id)
        remove(rubric_id)
        return False
    return True


def list_sources(rubric_id: int) -> list[dict[str, Any]]:
    """The stored entries whose file is still there, paper first; [] when none (or unreadable). An
    entry without a (known) role gets its kind's default (question_paper / answer_key)."""
    target = folder(rubric_id)
    try:
        raw = json.loads((target / SOURCES_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    found: dict[str, dict[str, Any]] = {}
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict) or item.get("kind") not in KINDS or item["kind"] in found:
            continue
        role = item.get("role")
        if role not in ROLES:
            role = DEFAULT_ROLES[item["kind"]]  # written before roles existed: labelled by kind
        try:
            entry = {
                "kind": item["kind"], "role": role, "filename": str(item["filename"]),
                "mime_type": str(item["mime_type"]), "file_type": str(item["file_type"]),
                "pages": max(1, int(item["pages"])),
            }
        except (KeyError, TypeError, ValueError):
            continue
        if (target / _stored_name(entry["kind"], entry["file_type"])).is_file():
            found[entry["kind"]] = entry
    return [found[kind] for kind in KINDS if kind in found]


def source_file(rubric_id: int, kind: str) -> tuple[Path, dict[str, Any]] | None:
    """(stored file, entry) of one kind; None when the rubric has no such source."""
    for entry in list_sources(rubric_id):
        if entry["kind"] == kind:
            return folder(rubric_id) / _stored_name(kind, entry["file_type"]), entry
    return None


# --------------------------------------------------------------------------- #
# Preview (rendered page images cached in previews/)
# --------------------------------------------------------------------------- #
def _preview_path(rubric_id: int, kind: str, page: int, width: int, mime_type: str) -> Path:
    extension = ".jpg" if mime_type in uploads.PIL_FORMATS else ".png"
    return folder(rubric_id) / PREVIEW_FOLDER / f"{kind}-p{int(page)}-w{int(width)}{extension}"


def render_preview(rubric_id: int, kind: str, page: int, width: int) -> preview_routes.Rendered | None:
    """Page `page` of the rubric's `kind` source as an image `width` px wide (preview_routes.render):
    served from previews/ when it was rendered before, saved there otherwise (best effort, at most
    PREVIEW_CACHE_MAX images per rubric). None when the rubric has no such file (or it cannot be
    read). Render errors as POST /api/intake/preview (422 invalid_page past the last page)."""
    found = source_file(rubric_id, kind)
    if found is None:
        return None
    path, entry = found
    cached = _preview_path(rubric_id, kind, page, width, entry["mime_type"])
    try:
        body = cached.read_bytes()
    except OSError:
        body = b""
    if body:
        return preview_routes.Rendered(
            body=body,
            media_type="image/jpeg" if cached.suffix == ".jpg" else "image/png",
            pages=entry["pages"],
            file_type=entry["file_type"],
            mime_type=entry["mime_type"],
        )
    try:
        data = path.read_bytes()
    except OSError:
        return None
    rendered = preview_routes.render(data, page, width)
    _save_preview(cached, rendered.body)
    return rendered


def _save_preview(target: Path, body: bytes) -> None:
    """Write a rendered page into previews/ (a temp file renamed into place, so a reader never sees
    half an image). Best effort: on a disk error the page is simply rendered again next time."""
    temp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if sum(1 for _ in target.parent.iterdir()) >= PREVIEW_CACHE_MAX:
            return
        temp.write_bytes(body)
        os.replace(temp, target)
    except OSError:
        logger.warning("Could not cache the preview %s", target.name, exc_info=True)
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass


def inherit(from_rubric_id: int | None, to_rubric_id: int) -> bool:
    """Give a rubric made from another one (an edited key, a new version) the other's source files -
    hard links where the file system allows, else copies. Best effort, never raises: True when
    something was copied. previews/ is not copied: the new rubric renders (and caches) its own."""
    if from_rubric_id is None or int(from_rubric_id) == int(to_rubric_id):
        return False
    entries = list_sources(from_rubric_id)
    if not entries:
        return False
    source_dir, target = folder(from_rubric_id), folder(to_rubric_id)
    try:
        remove(to_rubric_id)
        target.mkdir(parents=True, exist_ok=True)
        for entry in entries:
            name = _stored_name(entry["kind"], entry["file_type"])
            try:
                os.link(source_dir / name, target / name)
            except OSError:
                shutil.copyfile(source_dir / name, target / name)
        (target / SOURCES_FILE).write_text(
            json.dumps([{k: e[k] for k in ENTRY_KEYS} for e in entries], indent=2), encoding="utf-8"
        )
    except OSError:
        logger.exception("Could not copy the rubric source files of rubric %s to %s", from_rubric_id, to_rubric_id)
        remove(to_rubric_id)
        return False
    return True


def describe(sources: list[StagedSource]) -> str:
    """'question paper neet_2016.pdf (PDF, 19 pages) and answer key key.txt (text, 1 page)' for the log
    (the paper named by its role: question paper, rubric file or marked copy)."""
    parts = []
    for source in sources:
        what = ROLE_NAMES.get(source.role or role_for(source.kind), "source file")
        kind = TYPE_NAMES.get(source.file_type, f"{source.file_type.upper()} image")
        parts.append(f"{what} {source.filename} ({kind}, {source.pages} page{'s' if source.pages != 1 else ''})")
    return " and ".join(parts)
