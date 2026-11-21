"""Upload intake helpers shared by POST /api/upload (main.py) and the rescan endpoint
(routers/pipeline_ops.py): content sniffing, streaming storage with SHA-256, and decoding
checks. BRD FR-1.1 (PDF / images / typed DOCX), FR-1.4 (custody hash), FR-1.6, FR-1.8.

The file's bytes decide its type, never the extension. Voice notes are recognised and
rejected as Phase 2; other ZIP files (xlsx, plain archives) are rejected as unsupported.
"""
from __future__ import annotations

import hashlib
import logging
import re
import uuid
from pathlib import Path, PureWindowsPath

import pymupdf
from fastapi import HTTPException, UploadFile
from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

import docx_reader
import hashing
import pipeline
import preprocessing
from config import DOCX_MIME, Settings, get_settings
from database import StudentSubmission
from errors import ApiError

logger = logging.getLogger("3ilens.uploads")

CHUNK_SIZE = 1024 * 1024
MIME_EXTENSIONS = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    DOCX_MIME: ".docx",
}
PIL_FORMATS = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}
ACCEPTED_LABEL = "PDF, JPEG, PNG, WEBP or DOCX"
UNSUPPORTED_DETAIL = f"Unsupported file type. Upload a {ACCEPTED_LABEL} answer sheet."
VOICE_DETAIL = "Voice answers (MP3/WAV/M4A) are Phase 2 - not processed in this PoC."
ZIP_SIGNATURE = b"PK\x03\x04"
# ISO base-media brands used by audio-only files (M4A / AAC / Apple lossless / 3GPP audio).
AUDIO_FTYP_BRANDS = {b"M4A ", b"M4B ", b"M4P ", b"F4A ", b"F4B ", b"3gp4", b"3gp5", b"3g2a"}


def unprocessable(detail: str, code: str = "invalid_request") -> ApiError:
    return ApiError(422, detail, code)


# --------------------------------------------------------------------------- #
# Sniffing
# --------------------------------------------------------------------------- #
def is_voice_note(head: bytes) -> bool:
    """MP3 (ID3 tag or MPEG frame sync), WAV, M4A/AAC, Ogg/Opus (WhatsApp voice notes), AMR."""
    if head.startswith(b"ID3"):
        return True
    if len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0 and head[1] != 0xFF:
        # MPEG audio frame sync (11 set bits). JPEG (FF D8) and PNG never match: D8 & E0 = C0.
        layer = (head[1] >> 1) & 0x03
        return layer != 0
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return True
    if len(head) >= 12 and head[4:8] == b"ftyp" and head[8:12] in AUDIO_FTYP_BRANDS:
        return True
    return head.startswith((b"OggS", b"#!AMR", b"fLaC"))


def sniff_mime(head: bytes) -> str | None:
    """Content sniffing - the file's bytes decide the type, not its extension. A ZIP container is
    reported as DOCX here and confirmed (or rejected) by inspect_document on the full file."""
    if b"%PDF-" in head[:1024]:
        return "application/pdf"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(ZIP_SIGNATURE):
        return DOCX_MIME
    return None


# --------------------------------------------------------------------------- #
# Names & storage
# --------------------------------------------------------------------------- #
def display_filename(raw: str | None) -> str:
    name = PureWindowsPath((raw or "").replace("\x00", "")).name.strip()  # drops any C:\... or ../ prefix
    return name[:255] or "answer_sheet"


def sanitize_filename(name: str, mime_type: str) -> str:
    """Filesystem-safe name whose extension always matches the sniffed type."""
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._") or "answer_sheet"
    stem, dot, ext = safe.rpartition(".")
    if not dot or not stem or f".{ext.lower()}" not in {*MIME_EXTENSIONS.values(), ".jpeg"}:
        stem = safe
    return f"{stem[:100]}{MIME_EXTENSIONS[mime_type]}"


def store_upload(file: UploadFile, display_name: str, settings: Settings) -> tuple[Path, str, int, str]:
    """Sniff the type, then stream to ./uploads (hashing as it goes), stopping as soon as the
    size limit is crossed. Returns (path, mime_type, size, sha256)."""
    limit_mb = settings.max_upload_bytes // (1024 * 1024)
    head = file.file.read(8192)
    if not head:
        raise unprocessable("The uploaded file is empty.", "empty_file")
    if is_voice_note(head):
        raise ApiError(415, VOICE_DETAIL, "voice_phase2")
    mime_type = sniff_mime(head)
    if mime_type is None or mime_type not in settings.allowed_mime_types or mime_type not in MIME_EXTENSIONS:
        raise ApiError(415, UNSUPPORTED_DETAIL, "unsupported_signature")
    if file.size is not None and file.size > settings.max_upload_bytes:
        raise ApiError(413, f"File is larger than the {limit_mb} MB limit.", "too_large")

    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    dest = settings.upload_dir / f"{uuid.uuid4().hex}_{sanitize_filename(display_name, mime_type)}"
    size = 0
    digest = hashlib.sha256()
    try:
        with dest.open("wb") as out:
            chunk = head
            while chunk:
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise ApiError(413, f"File is larger than the {limit_mb} MB limit.", "too_large")
                digest.update(chunk)
                out.write(chunk)
                chunk = file.file.read(CHUNK_SIZE)
    except BaseException:
        discard(dest)
        raise
    return dest, mime_type, size, digest.hexdigest()


def discard(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("Could not delete rejected upload %s", path.name)


# --------------------------------------------------------------------------- #
# Decoding checks
# --------------------------------------------------------------------------- #
def inspect_document(path: Path, mime_type: str, settings: Settings) -> tuple[str, int]:
    """Confirms the file can be decoded and enforces the page limit. Returns (description, pages)."""
    if mime_type == "application/pdf":
        try:
            # Opened from memory so a corrupt file never leaves a Windows file lock behind.
            with pymupdf.open(stream=path.read_bytes(), filetype="pdf") as doc:
                if doc.needs_pass:
                    raise unprocessable("Password-protected PDFs are not supported.", "password_pdf")
                pages = doc.page_count
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise unprocessable("The PDF could not be opened - it may be corrupt.", "corrupt_pdf") from exc
        if pages < 1:
            raise unprocessable("The PDF has no pages.", "no_pages")
        if pages > settings.max_pdf_pages:
            raise unprocessable(
                f"The PDF has {pages} pages; the limit is {settings.max_pdf_pages} pages.", "too_many_pages"
            )
        return f"PDF, {pages} page{'s' if pages != 1 else ''}", pages
    if mime_type == DOCX_MIME:
        return _inspect_docx(path, settings)
    try:
        with Image.open(path, formats=[PIL_FORMATS[mime_type]]) as image:
            width, height = image.size
            image.verify()
        # verify() only checks the structure; a cut-off JPEG passes it and would fail later in the
        # worker. Decode the pixels once so a truncated file is rejected here with a 422.
        with Image.open(path, formats=[PIL_FORMATS[mime_type]]) as image:
            image.load()
    except Exception as exc:  # noqa: BLE001
        raise unprocessable("The image could not be read - it may be corrupt or truncated.", "corrupt_image") from exc
    return f"{PIL_FORMATS[mime_type]} image, {width}x{height}px", 1


def _inspect_docx(path: Path, settings: Settings) -> tuple[str, int]:
    data = path.read_bytes()
    kind = docx_reader.package_kind(data)
    if kind == "zip":
        raise ApiError(415, UNSUPPORTED_DETAIL, "unsupported_signature")
    if kind == "corrupt":
        raise unprocessable("The Word document could not be opened - it may be corrupt.", "corrupt_docx")
    try:
        _pdf, pages, omitted = preprocessing.docx_to_pdf(data)
    except preprocessing.PreprocessingError as exc:
        if exc.code == "macro_docx":
            raise ApiError(415, str(exc), "macro_docx") from exc
        if exc.code in ("corrupt_docx", "docx_too_large", "no_pages", "too_many_pages"):
            raise unprocessable(str(exc), exc.code) from exc
        raise unprocessable("The Word document could not be converted to pages.", "corrupt_docx") from exc
    if pages > settings.max_pdf_pages:
        raise unprocessable(
            f"The Word document is {pages} pages long once laid out on A4; the limit is "
            f"{settings.max_pdf_pages} pages.",
            "too_many_pages",
        )
    description = f"typed Word document, {pages} A4 page{'s' if pages != 1 else ''} after conversion"
    if omitted:
        description += f"; {omitted} unsupported image(s) omitted"
    return description, pages


def human_size(size: int) -> str:
    return f"{size / (1024 * 1024):.1f} MB" if size >= 1024 * 1024 else f"{max(1, round(size / 1024))} KB"


def duplicate_notice(db: Session, sub: StudentSubmission) -> None:
    """FR-1.4 / FR-2.5: the same bytes were uploaded before -> say so in the log (never rejected)."""
    if not sub.file_hash:
        return
    query = select(StudentSubmission.id).where(StudentSubmission.file_hash == sub.file_hash)
    if sub.id is not None:
        query = query.where(StudentSubmission.id != sub.id)
    other = db.scalar(query.order_by(StudentSubmission.id.desc()).limit(1))
    if other is None:
        return
    reuse = (
        "OCR cache will be reused" if get_settings().ocr_cache_enabled
        else "OCR cache is off (OCR_CACHE=0) - the sheet will be read again"
    )
    pipeline.append_log(
        sub, "Ingestion",
        f"Same file bytes as submission #{other} (SHA-256 {hashing.short_hash(sub.file_hash)}) - {reuse}.",
    )
