"""Page images of a printed question paper (PDF) for the paged rubric draft (FR-3.4).

A full printed paper - a scanned NEET paper with ticked options, or a typed paper whose
equations are embedded images and whose answer key sits under each question - is read by
the vision model a few pages at a time (ai.parse_rubric_pages). The text layer of such
files is unreliable (two-column layouts interleave, scanned papers carry noisy OCR text or
broken font maps, ticks and formula images are not text at all), so every page is sent as
an image.

Pages are rendered at RENDER_DPI with the long edge capped at MAX_LONG_EDGE_PX, in colour
(ticks are often red or blue), and encoded as JPEG within a
per-page byte budget well under the provider's 5 MB image limit. Nothing is written to disk.
"""
from __future__ import annotations

import io
from dataclasses import dataclass

import pymupdf
from PIL import Image

RENDER_DPI = 150
MAX_LONG_EDGE_PX = 1800
JPEG_QUALITIES = (80, 70, 60, 50)
MAX_PAGE_BYTES = 2 * 1024 * 1024
MIN_LONG_EDGE_PX = 600


class PaperPagesError(RuntimeError):
    """The PDF could not be rendered; code matches the API error codes (corrupt_pdf, ...)."""

    def __init__(self, message: str, code: str = "corrupt_pdf") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class PageImage:
    """One rendered page, in the shape the vision request builders read."""

    page_number: int   # 1-based
    media_type: str    # "image/jpeg"
    data: bytes
    width: int
    height: int


def page_count(data: bytes) -> int:
    """Number of pages in the PDF (PaperPagesError when it cannot be opened)."""
    with _open(data) as doc:
        return doc.page_count


def render_pdf_pages(
    data: bytes,
    *,
    dpi: int = RENDER_DPI,
    max_edge: int = MAX_LONG_EDGE_PX,
    max_page_bytes: int = MAX_PAGE_BYTES,
) -> list[PageImage]:
    """Every page of the PDF as an encoded image, in page order."""
    pages: list[PageImage] = []
    with _open(data) as doc:
        if doc.page_count < 1:
            raise PaperPagesError("The PDF has no pages.", "no_pages")
        for index in range(doc.page_count):
            page = doc[index]
            image = _render(page, dpi, max_edge)
            try:
                encoded, media_type, (width, height) = encode_page(image, max_page_bytes)
            finally:
                image.close()
            pages.append(PageImage(index + 1, media_type, encoded, width, height))
    return pages


def encode_page(image: Image.Image, max_bytes: int = MAX_PAGE_BYTES) -> tuple[bytes, str, tuple[int, int]]:
    """(bytes, media type, size): JPEG at the first quality that fits (a printed A4 page at
    150 DPI is ~250 KB at quality 80); a page that still does not fit is scaled down by 20%
    steps. PNG is not tried: it is ~2x larger for scans and ~10x slower to encode."""
    current = image
    try:
        while True:
            for quality in JPEG_QUALITIES:
                jpeg = _save(current, "JPEG", quality=quality)
                if len(jpeg) <= max_bytes:
                    return jpeg, "image/jpeg", current.size
            width, height = current.size
            if max(width, height) <= MIN_LONG_EDGE_PX:
                return jpeg, "image/jpeg", current.size
            smaller = current.resize((max(1, int(width * 0.8)), max(1, int(height * 0.8))), Image.Resampling.LANCZOS)
            if current is not image:
                current.close()
            current = smaller
    finally:
        if current is not image:
            current.close()


def _open(data: bytes) -> pymupdf.Document:
    # Opened from memory so a corrupt file never leaves a Windows file lock behind.
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001 - pymupdf raises several types for corrupt files
        raise PaperPagesError("The PDF could not be opened - it may be corrupt.", "corrupt_pdf") from exc
    if doc.needs_pass:
        doc.close()
        raise PaperPagesError("The PDF is password-protected. Upload an unlocked copy.", "password_pdf")
    return doc


def _render(page: pymupdf.Page, dpi: int, max_edge: int) -> Image.Image:
    long_edge_pt = max(page.rect.width, page.rect.height) or 1.0
    zoom = min(dpi / 72.0, max_edge / long_edge_pt)
    try:
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csRGB, alpha=False)
    except Exception as exc:  # noqa: BLE001
        raise PaperPagesError(
            f"Page {page.number + 1} of the PDF could not be rendered - the file may be damaged.", "corrupt_pdf"
        ) from exc
    return Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)


def _save(image: Image.Image, fmt: str, **params: object) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, fmt, **params)
    return buffer.getvalue()
