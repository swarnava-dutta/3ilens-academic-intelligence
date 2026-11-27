"""Intake preview (see API_CONTRACT.md):

- POST /api/intake/preview   multipart `file` (+ optional form fields `page`, default 1, and `width`,
                             default 480, clamped 120-1200) -> a thumbnail image of that page

A small picture of a file the user is about to upload: a student's answer sheet, or a rubric source
(question paper, answer-key file, marking scheme, pasted-text key). Rendered locally - no AI call,
nothing stored. Same size, type and decoding checks and error codes as POST /api/intake/inspect.
The renderer (render, read_upload, page_number_of, width_of, image_response) is shared with the
previews of the rubric sources kept with an intake's answer key (rubric_sources.py, GET
/api/rubrics/{id}/sources/{kind}/preview in routers/pipeline_ops.py), and render() is also how
POST /api/upload checks those files before saving them.

Response 200:
- body: image/png for a PDF page, a Word page (laid out on A4 as the pipeline does,
  preprocessing.docx_to_pdf) or text - UTF-8, or UTF-16 as Notepad / Excel save "Unicode text" (its
  first 60 lines, each cut at 400 characters, wrapped on a white page); image/jpeg for a
  photo / scan (JPEG, PNG, WEBP; EXIF orientation applied, flattened onto white, never upscaled).
  The image is `width` px wide; a page more than 3x as tall as it is wide is rendered narrower so
  its height stays within 3 x width.
- headers: X-Page-Count (PDF pages, Word A4 pages, 1 for an image or text), X-File-Type
  (pdf | docx | jpeg | png | webp | text). A PDF over MAX_PDF_PAGES still previews (inspect reports
  it with within_page_limit=false). Cross-origin JS can read these headers only once main.py's
  CORSMiddleware lists them in expose_headers.

Errors ({"detail", "code"}): 422 missing_file, 413 too_large, 422 empty_file, 415
unsupported_signature (not PDF / Word / image / UTF-8 or UTF-16 text, or a ZIP that is not a Word document),
415 no_preview (an audio voice answer - there is no page to show), 422 corrupt_pdf / password_pdf /
no_pages / corrupt_image / corrupt_docx / docx_too_large / too_many_pages (Word past the 60-page
layout cap), 415 macro_docx, 422 invalid_page (`page` not a whole number, below 1 or above
X-Page-Count), 422 invalid_request (`width` not a whole number).

Usage (browser):
    const form = new FormData();
    form.append("file", file);                       // a File from <input type="file">
    form.append("page", "1");
    form.append("width", "480");
    const res = await fetch(`${API_BASE_URL}/api/intake/preview`, { method: "POST", body: form });
    if (!res.ok) { const { code } = await res.json(); ... }   // e.g. "no_preview" for audio
    const src = URL.createObjectURL(await res.blob());           // <img src={src}>; revoke when done
    const pages = Number(res.headers.get("X-Page-Count") ?? 1);
"""
from __future__ import annotations

import io
import re
import textwrap
from typing import Annotated, NamedTuple

import pymupdf
from fastapi import APIRouter, File, Form, Response, UploadFile
from PIL import Image, ImageDraw, ImageFont, ImageOps

import docx_reader
import preprocessing
import uploads
from config import DOCX_MIME, MIME_LABELS, get_settings
from errors import ApiError

router = APIRouter(tags=["Intake"])

DEFAULT_WIDTH = 480
MIN_WIDTH, MAX_WIDTH = 120, 1200
MAX_ASPECT = 3.0            # height cap as a multiple of the width (long receipts / strips)
A4_ASPECT = 297 / 210       # a text preview is at least one A4 page tall
TEXT_LINES = 60             # lines of a text file shown (each wrapped to the page width)
TEXT_LINE_CHARS = 400       # characters kept of each line before wrapping
TEXT_SCAN_CHARS = 200_000   # characters of a text file scanned for its first TEXT_LINES lines
WRAP_SAMPLE = "Q12. The answer is (2) because the gene shows incomplete dominance."
JPEG_QUALITY = 82
TEXT_MIME = "text/plain"
UNSUPPORTED_DETAIL = "Unsupported file type: preview a PDF, Word (.docx), image (JPEG, PNG, WEBP) or text file."
NO_PREVIEW_DETAIL = "Voice answers have no page to preview."
DOCX_CODES = {"corrupt_docx", "docx_too_large", "no_pages", "too_many_pages"}  # else corrupt_docx (uploads)
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
IMAGE_RESPONSES = {200: {"content": {"image/png": {}, "image/jpeg": {}}, "description": "Thumbnail of the page"}}


@router.post("/api/intake/preview", response_class=Response, responses=IMAGE_RESPONSES)
def preview_intake_file(
    file: Annotated[UploadFile | None, File()] = None,
    page: Annotated[str | None, Form()] = None,
    width: Annotated[str | None, Form()] = None,
) -> Response:
    if file is None or not file.filename:
        raise ApiError(422, "Attach the file to preview.", "missing_file")
    page_number = page_number_of(page)
    size = width_of(width)
    return image_response(render(read_upload(file), page_number, size))


# --------------------------------------------------------------------------- #
# Shared with GET /api/rubrics/{id}/sources/{kind}/preview (rubric_sources.py)
# --------------------------------------------------------------------------- #
class Rendered(NamedTuple):
    body: bytes
    media_type: str      # image/png | image/jpeg
    pages: int           # X-Page-Count
    file_type: str       # X-File-Type: pdf | docx | jpeg | png | webp | text
    mime_type: str       # the file's sniffed type; text/plain for UTF-8 / UTF-16 text


def page_number_of(raw: str | None) -> int:
    """The `page` field / query value: default 1; 422 invalid_page when not a whole number >= 1."""
    number = _whole_number(raw, 1, "page", "invalid_page")
    if number < 1:
        raise ApiError(422, "page must be 1 or more.", "invalid_page")
    return number


def width_of(raw: str | None) -> int:
    """The `width` field / query value: default 480, clamped 120-1200; 422 invalid_request otherwise."""
    return max(MIN_WIDTH, min(MAX_WIDTH, _whole_number(raw, DEFAULT_WIDTH, "width", "invalid_request")))


def read_upload(file: UploadFile) -> bytes:
    """The whole file, refused past the upload limit (413 too_large) or empty (422 empty_file)."""
    settings = get_settings()
    limit = settings.max_upload_bytes
    if file.size is not None and file.size > limit:
        raise ApiError(413, f"File is larger than the {settings.max_upload_mb} MB limit.", "too_large")
    data = file.file.read(limit + 1)
    if len(data) > limit:
        raise ApiError(413, f"File is larger than the {settings.max_upload_mb} MB limit.", "too_large")
    if not data:
        raise ApiError(422, "The uploaded file is empty.", "empty_file")
    return data


def render(data: bytes, page: int, width: int) -> Rendered:
    """Page `page` of a PDF / Word / image / text file as an image `width` px wide, with the
    file's page count and type. Errors as POST /api/intake/preview (415 no_preview for audio)."""
    settings = get_settings()
    head = data[:8192]
    if uploads.sniff_audio(head) is not None:
        raise ApiError(415, NO_PREVIEW_DETAIL, "no_preview")
    mime_type = uploads.sniff_mime(head)
    if mime_type is not None and mime_type not in settings.allowed_mime_types:
        raise ApiError(415, UNSUPPORTED_DETAIL, "unsupported_signature")
    if mime_type is None:
        body, pages = _text_preview(data, page, width)
    elif mime_type == "application/pdf":
        body, pages = _pdf_preview(data, page, width)
    elif mime_type == DOCX_MIME:
        body, pages = _pdf_preview(_docx_pdf(data), page, width)
    else:
        body, pages = _image_preview(data, mime_type, page, width)
    return Rendered(
        body=body,
        media_type="image/jpeg" if mime_type in uploads.PIL_FORMATS else "image/png",
        pages=pages,
        file_type=MIME_LABELS.get(mime_type, mime_type) if mime_type else "text",
        mime_type=mime_type or TEXT_MIME,
    )


def image_response(rendered: Rendered) -> Response:
    return Response(
        content=rendered.body,
        media_type=rendered.media_type,
        headers={
            "X-Page-Count": str(rendered.pages),
            "X-File-Type": rendered.file_type,
            "Cache-Control": "no-store",
        },
    )


def _whole_number(raw: str | None, default: int, name: str, code: str) -> int:
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError as exc:
        raise ApiError(422, f"{name} must be a whole number.", code) from exc


def _check_page(page: int, pages: int) -> None:
    if page > pages:
        raise ApiError(
            422, f"Page {page} does not exist - the file has {pages} page{'s' if pages != 1 else ''}.", "invalid_page"
        )


# --------------------------------------------------------------------------- #
# Renderers
# --------------------------------------------------------------------------- #
def _pdf_preview(data: bytes, page: int, width: int) -> tuple[bytes, int]:
    """(PNG of the page, page count). Errors as paper_detect._pdf_texts (POST /api/intake/inspect)."""
    try:
        document = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001 - pymupdf raises several types for corrupt files
        raise ApiError(422, "The PDF could not be opened - it may be corrupt.", "corrupt_pdf") from exc
    try:
        if document.needs_pass:
            raise ApiError(422, "Password-protected PDFs are not supported.", "password_pdf")
        pages = document.page_count
        if pages < 1:
            raise ApiError(422, "The PDF has no pages.", "no_pages")
        _check_page(page, pages)
        try:
            pdf_page = document.load_page(page - 1)
            rect = pdf_page.rect
            zoom = min(width / max(rect.width, 1.0), width * MAX_ASPECT / max(rect.height, 1.0))
            pixmap = pdf_page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csRGB, alpha=False)
            return pixmap.tobytes("png"), pages
        except Exception as exc:  # noqa: BLE001 - a page pymupdf cannot draw
            raise ApiError(
                422, f"Page {page} of the PDF could not be rendered - the file may be corrupt.", "corrupt_pdf"
            ) from exc
    finally:
        document.close()


def _docx_pdf(data: bytes) -> bytes:
    """The Word document laid out on A4 (as the pipeline reads it). Errors as POST /api/intake/inspect,
    except that a document past the layout cap cannot be shown (422 too_many_pages)."""
    kind = docx_reader.package_kind(data)
    if kind == "zip":
        raise ApiError(415, UNSUPPORTED_DETAIL, "unsupported_signature")
    if kind == "corrupt":
        raise ApiError(422, "The Word document could not be opened - it may be corrupt.", "corrupt_docx")
    try:
        pdf, _pages, _omitted = preprocessing.docx_to_pdf(data)
    except preprocessing.PreprocessingError as exc:
        if exc.code == "macro_docx":
            raise ApiError(415, str(exc), "macro_docx") from exc
        code = exc.code if exc.code in DOCX_CODES else "corrupt_docx"
        raise ApiError(422, str(exc), code) from exc
    return pdf


def _image_preview(data: bytes, mime_type: str, page: int, width: int) -> tuple[bytes, int]:
    """(JPEG of the upright photo / scan, at most `width` px wide and never upscaled, 1)."""
    _check_page(page, 1)
    try:
        with Image.open(io.BytesIO(data), formats=[uploads.PIL_FORMATS[mime_type]]) as opened:
            opened.draft("RGB", (width, width))  # JPEG: decode at a reduced scale, still >= width
            opened.load()
            image = preprocessing._to_rgb(ImageOps.exif_transpose(opened))
    except Exception as exc:  # noqa: BLE001 - PIL raises several types for corrupt / truncated images
        raise ApiError(422, "The image could not be read - it may be corrupt or truncated.", "corrupt_image") from exc
    image.thumbnail((width, round(width * MAX_ASPECT)), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return buffer.getvalue(), 1


def decode_text(data: bytes) -> str:
    """A text file's text: UTF-16 (with a byte-order mark, or every other byte zero -
    uploads.utf16_text), else UTF-8 (a UTF-8 BOM dropped). 415 unsupported_signature for anything
    else (binary bytes, another encoding)."""
    wide = uploads.utf16_text(data)
    if wide is not None:
        return wide
    if b"\x00" in data[:4096]:
        raise ApiError(415, UNSUPPORTED_DETAIL, "unsupported_signature")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ApiError(415, UNSUPPORTED_DETAIL, "unsupported_signature") from exc


def text_lines(text: str) -> list[str]:
    """The first TEXT_LINES lines of a text, each cut at TEXT_LINE_CHARS characters (tabs expanded,
    control characters blanked) - what a text preview wraps. Only the first TEXT_SCAN_CHARS
    characters are scanned, so a huge file or one long unbroken line costs no more than a short one
    (textwrap on a long unbroken token is quadratic)."""
    return [
        _CONTROL.sub(" ", raw[:TEXT_LINE_CHARS].expandtabs(4))[:TEXT_LINE_CHARS]
        for raw in text[:TEXT_SCAN_CHARS].splitlines()[:TEXT_LINES]
    ]


def _text_preview(data: bytes, page: int, width: int) -> tuple[bytes, int]:
    """(PNG, 1): the first TEXT_LINES wrapped lines of a text file (e.g. a typed answer key or a JSON
    rubric; UTF-8 or UTF-16) on a white page at least A4-shaped, in Pillow's default font. Each line
    is cut at TEXT_LINE_CHARS characters before it is wrapped (text_lines)."""
    text = decode_text(data)
    _check_page(page, 1)
    font_size = max(8, round(width / 45))
    font = ImageFont.load_default(size=font_size)
    margin = round(width * 0.06)
    average = font.getlength(WRAP_SAMPLE) / len(WRAP_SAMPLE)  # proportional font: wrap by a typical glyph
    columns = max(10, int((width - 2 * margin) / max(average, 1.0)))
    lines: list[str] = []
    for raw in text_lines(text):
        lines.extend(textwrap.wrap(raw, columns) or [""])
        if len(lines) >= TEXT_LINES:
            break
    lines = lines[:TEXT_LINES]
    line_height = round(font_size * 1.4)
    height = max(round(width * A4_ASPECT), 2 * margin + line_height * len(lines))
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    for index, line in enumerate(lines):
        draw.text((margin, margin + index * line_height), line, fill=(17, 24, 39), font=font)
    buffer = io.BytesIO()
    image.save(buffer, "PNG", optimize=True)
    return buffer.getvalue(), 1
