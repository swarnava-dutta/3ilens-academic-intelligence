"""Pre-processing (spec Section 3 step 3; BRD FR-1.1, FR-1.5, FR-2.6).

Real image work, Pillow + PyMuPDF only:

* PDFs: every page is rendered lazily (one at a time, so memory stays flat for 10-page
  sheets) at ``settings.pdf_master_dpi`` (300 DPI: A4 = 2480x3508 px) as the master image.
* Photos/scans (PNG / JPEG / WEBP): EXIF orientation applied, converted to RGB (transparent
  areas become white paper), upscaled with LANCZOS when the short edge is below
  ``settings.min_short_edge_px`` (at most 2x).
* Typed Word answer sheets (.docx): converted to an in-memory A4 PDF with pymupdf.Story and
  then take exactly the same PDF path - there is no separate text route.
* Enhancement (``settings.preprocess_enhance``): deskew (projection-profile search on a
  600 px greyscale thumbnail, +/-15 deg), auto-contrast (1% cut-off) + contrast boost
  (``settings.preprocess_contrast``), unsharp mask (r=2, 150%, threshold 3).
* The copy sent to the vision model is capped at ``settings.vision_max_edge_px`` on its long
  edge and encoded as PNG, falling back to JPEG so every page stays under the 5 MB per-image
  API limit and the whole request under the request-size limit.

Artifacts (the local S3 mock, ``artifact_dir``): ``page_<n>.<ext>`` is the enhanced page the
model receives; ``page_<n>_original.<ext>`` is the same page before enhancement (model-sized),
for the side-by-side viewer.
"""
from __future__ import annotations

import html as html_lib
import io
import logging
import math
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pymupdf
from PIL import Image, ImageEnhance, ImageFilter, ImageOps, ImageStat, UnidentifiedImageError

import docx_reader
from ai_schemas import PreparedPage
from config import DOCX_MIME, Settings, get_settings

logger = logging.getLogger(__name__)

# v1 log line. Kept exported for compatibility (older fakes/tests import it); the real
# pipeline now logs the measured values instead and never says "Simulating".
SIMULATION_MESSAGE = "Simulating Deskew and 300 DPI Contrast Enhancement."
ENHANCEMENT_DISABLED_MESSAGE = "Enhancement disabled (PREPROCESS_ENHANCE=0)"
DOCX_CONVERTED_MESSAGE = "Converted typed DOCX to PDF ({pages} page{s}) - same vision path"

MAX_LONG_EDGE_PX = 2000  # default VISION_MAX_EDGE_PX; the effective cap is settings.vision_max_edge_px
# Master images are capped at ~A4 @ 300 DPI worth of pixels (+10%) so a huge photo or an
# oversized PDF page cannot blow up memory.
MAX_MASTER_PIXELS = int(2480 * 3508 * 1.1)
MAX_UPSCALE = 2.0
# Per-page cap on the encoded bytes. 3.5 MB raw is ~4.7 MB once base64-encoded, under
# the 5 MB per-image API limit.
MAX_PAGE_BYTES = int(3.5 * 1024 * 1024)
# Budget for all pages of one document together (keeps a 10-page PDF comfortably under
# the API request-size limit once base64-encoded).
MAX_DOCUMENT_BYTES = 18 * 1024 * 1024
JPEG_QUALITIES = (88, 80, 70, 60, 50)
LOW_RESOLUTION_WARNING_PX = 800

# Enhancement parameters (BRD FR-2.6).
DESKEW_THUMB_PX = 600
DESKEW_RANGE_DEG = 15
DESKEW_FINE_STEP_DEG = 0.25
DESKEW_MIN_ANGLE_DEG = 0.3
AUTOCONTRAST_CUTOFF = 1
UNSHARP_RADIUS = 2
UNSHARP_PERCENT = 150
UNSHARP_THRESHOLD = 3

# Typed DOCX -> PDF (pymupdf.Story).
DOCX_MARGIN_PT = 54  # 0.75 inch
DOCX_HARD_PAGE_CAP = 60  # stop laying out runaway documents (the default upload limit is 40 pages)
DOCX_CSS = (
    "body {font-family: sans-serif; font-size: 12pt; line-height: 1.35;}"
    "h2 {font-size: 16pt; margin-top: 10pt;} h3 {font-size: 13pt; margin-top: 8pt;}"
    "p {margin: 0 0 6pt 0;} img {max-width: 100%;}"
    "table {border-collapse: collapse; width: 100%; margin: 6pt 0;}"
    "td {border: 1px solid #777; padding: 4px; vertical-align: top;}"
)
DOCX_IMAGE_FORMATS = {"PNG", "JPEG", "GIF", "BMP", "TIFF"}

IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/webp"}
PDF_MIME_TYPE = "application/pdf"
_MIME_ALIASES = {"image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "image/x-png": "image/png"}
PAGE_FILE_RE = re.compile(r"^page_(\d+)(_original)?\.(png|jpg)$")


class PreprocessingError(RuntimeError):
    """Upload could not be decoded/rasterised (corrupt file, too many pages, ...).

    code is a snake_case reason (stored as submissions.last_error_code; upload maps it)."""

    def __init__(self, message: str, code: str = "preprocessing_failed") -> None:
        super().__init__(message)
        self.code = code


@dataclass
class _Source:
    """A decoded upload: the page count and a lazy iterator of (master RGB image, note)."""

    page_count: int
    pages: Iterator[tuple[Image.Image, str]]
    document: pymupdf.Document | None = None

    def close(self) -> None:
        if self.document is not None:
            self.document.close()
            self.document = None


# --------------------------------------------------------------------------- #
# Entry points
# --------------------------------------------------------------------------- #
def preprocess_document(
    file_path: Path,
    mime_type: str,
    artifact_dir: Path,
    log: Callable[[str], None],
) -> list[PreparedPage]:
    """Decode, enhance and encode every page; returns the pages for the vision model."""
    settings = get_settings()
    enhance = settings.preprocess_enhance
    log(_intro_message(settings))

    file_path = Path(file_path)
    artifact_dir = Path(artifact_dir)
    source = _open_source(file_path, mime_type, settings, log)
    page_budget = min(MAX_PAGE_BYTES, MAX_DOCUMENT_BYTES // max(source.page_count, 1))
    pages: list[PreparedPage] = []
    try:
        _prepare_artifact_dir(artifact_dir)
        for page_number, (master, note) in enumerate(source.pages, start=1):
            original = _fit_long_edge(master, settings.vision_max_edge_px)
            if enhance:
                enhanced, info = enhance_page(master, contrast=settings.preprocess_contrast)
                model_image = _fit_long_edge(enhanced, settings.vision_max_edge_px)
                if model_image is not enhanced:
                    enhanced.close()
                details = _enhancement_text(info)
            else:
                model_image, details = original, "no enhancement"
            if master is not original:
                master.close()

            data, media_type, extension, size = _encode_page(model_image, page_budget)
            path = artifact_dir / f"page_{page_number}.{extension}"
            _write(path, data)
            if enhance:
                odata, _, oextension, _ = _encode_page(original, page_budget)
                _write(artifact_dir / f"page_{page_number}_original.{oextension}", odata)
            for image in {id(original): original, id(model_image): model_image}.values():
                image.close()

            pages.append(PreparedPage(page_number=page_number, media_type=media_type, data=data, path=path))
            log(
                f"Page {page_number}/{source.page_count}: {note}; {details}; sent {size[0]}x{size[1]} "
                f"to the vision model ({extension.upper()}, {_human_bytes(len(data))})."
            )
    finally:
        source.close()

    if not pages:
        raise PreprocessingError("No pages could be extracted from the uploaded answer sheet.", "no_pages")
    return pages


def render_review_pages(file_path: Path, mime_type: str, artifact_dir: Path) -> list[Path]:
    """Model-sized page images WITHOUT enhancement, for the review viewer of sheets that never
    reached pre-processing (the 'blurry' mock, held sheets). Writes page_<n>.<ext>."""
    settings = get_settings()
    artifact_dir = Path(artifact_dir)
    source = _open_source(Path(file_path), mime_type, settings, lambda _message: None)
    page_budget = min(MAX_PAGE_BYTES, MAX_DOCUMENT_BYTES // max(source.page_count, 1))
    paths: list[Path] = []
    try:
        _prepare_artifact_dir(artifact_dir)
        for page_number, (master, _note) in enumerate(source.pages, start=1):
            image = _fit_long_edge(master, settings.vision_max_edge_px)
            data, _, extension, _ = _encode_page(image, page_budget)
            if image is not master:
                image.close()
            master.close()
            path = artifact_dir / f"page_{page_number}.{extension}"
            _write(path, data)
            paths.append(path)
    finally:
        source.close()
    return paths


def page_count(file_path: Path, mime_type: str) -> int:
    """Pages a stored upload will produce (PDF/DOCX pages; 1 for an image). Raises PreprocessingError."""
    source = _open_source(Path(file_path), mime_type, get_settings(), lambda _message: None)
    try:
        return source.page_count
    finally:
        source.close()


def _intro_message(settings: Settings) -> str:
    if not settings.preprocess_enhance:
        return (
            f"{ENHANCEMENT_DISABLED_MESSAGE}: pages are rendered at {settings.pdf_master_dpi} DPI, "
            f"EXIF-rotated and resized to <= {settings.vision_max_edge_px} px for the vision model only."
        )
    return (
        f"Pre-processing each page: {settings.pdf_master_dpi} DPI master, deskew (projection profile, "
        f"+/-{DESKEW_RANGE_DEG} deg), auto-contrast + contrast x{settings.preprocess_contrast:g}, unsharp mask "
        f"r={UNSHARP_RADIUS}; vision copy capped at {settings.vision_max_edge_px} px."
    )


# --------------------------------------------------------------------------- #
# Decoding
# --------------------------------------------------------------------------- #
def _normalise_mime(mime_type: str | None) -> str:
    mime = (mime_type or "").split(";", 1)[0].strip().lower()
    return _MIME_ALIASES.get(mime, mime)


def _open_source(file_path: Path, mime_type: str, settings: Settings, log: Callable[[str], None]) -> _Source:
    mime = _normalise_mime(mime_type)
    if mime not in (PDF_MIME_TYPE, DOCX_MIME) and mime not in IMAGE_MIME_TYPES:
        raise PreprocessingError(
            f"Unsupported file type '{mime_type or 'unknown'}'. "
            "Upload the answer sheet as a PDF, JPEG, PNG, WEBP or DOCX file.",
            "unsupported_signature",
        )
    if not file_path.is_file():
        raise PreprocessingError("The uploaded answer sheet could not be found on the server.", "upload_missing")
    if file_path.stat().st_size == 0:
        raise PreprocessingError("The uploaded answer sheet is empty (0 bytes).", "empty_file")

    if mime == PDF_MIME_TYPE:
        document = _open_pdf(file_path, None, "PDF")
        log(f"Opened PDF with {document.page_count} page(s); rendering each at {settings.pdf_master_dpi} DPI.")
        return _Source(document.page_count, _render_pdf_pages(document, settings.pdf_master_dpi), document)
    if mime == DOCX_MIME:
        pdf_bytes, pages, omitted = docx_to_pdf(file_path.read_bytes())
        log(DOCX_CONVERTED_MESSAGE.format(pages=pages, s="" if pages == 1 else "s") + ".")
        if omitted:
            log(
                f"{omitted} embedded image(s) could not be rendered (unsupported format such as EMF/WMF) "
                "and were omitted; the text was converted in full."
            )
        document = _open_pdf(None, pdf_bytes, "Word document")
        return _Source(document.page_count, _render_pdf_pages(document, settings.pdf_master_dpi), document)
    return _Source(1, iter([_load_image(file_path, settings, log)]))


def _load_image(file_path: Path, settings: Settings, log: Callable[[str], None]) -> tuple[Image.Image, str]:
    """Decode an uploaded photo/scan into an upright RGB master image."""
    try:
        with Image.open(file_path) as opened:
            opened.seek(0)  # first frame of animated WEBP / multi-frame files
            original_size = opened.size
            source_format = opened.format or "image"
            upright = ImageOps.exif_transpose(opened)
            rotated = upright.size != original_size
            rgb = _to_rgb(upright)
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError, SyntaxError) as exc:
        logger.warning("Could not decode image %s: %s", file_path.name, exc)
        raise PreprocessingError(
            "The uploaded image could not be read. It may be corrupt or not a real "
            "JPEG/PNG/WEBP file - please re-scan or re-export it and upload again.",
            "corrupt_image",
        ) from exc

    details = f"Decoded {source_format} image {original_size[0]}x{original_size[1]} px"
    if rotated:
        details += " (EXIF orientation applied)"
    log(details + ".")
    width, height = rgb.size
    note = f"{source_format} photo {width}x{height}"
    if max(width, height) < LOW_RESOLUTION_WARNING_PX:
        log(f"Warning: low-resolution image ({width}x{height} px); handwriting may be hard to read.")

    short_edge = min(width, height)
    if settings.min_short_edge_px and 0 < short_edge < settings.min_short_edge_px:
        factor = min(MAX_UPSCALE, settings.min_short_edge_px / short_edge)
        new_size = (max(1, round(width * factor)), max(1, round(height * factor)))
        upscaled = rgb.resize(new_size, Image.Resampling.LANCZOS)
        rgb.close()
        rgb = upscaled
        note += f" upscaled x{factor:.2f} (LANCZOS) to {new_size[0]}x{new_size[1]}"
    elif width * height > MAX_MASTER_PIXELS:
        scale = math.sqrt(MAX_MASTER_PIXELS / (width * height))
        new_size = (max(1, int(width * scale)), max(1, int(height * scale)))
        reduced = rgb.resize(new_size, Image.Resampling.LANCZOS)
        rgb.close()
        rgb = reduced
        log(f"Downscaled from {width}x{height} px to {new_size[0]}x{new_size[1]} px (~A4 at 300 DPI master).")
        note += f" downscaled to {new_size[0]}x{new_size[1]}"
    return rgb, note


def _open_pdf(file_path: Path | None, data: bytes | None, kind: str = "PDF") -> pymupdf.Document:
    """Open and validate a PDF up-front (the caller closes it). kind names it in messages."""
    try:
        if data is not None:
            document = pymupdf.open(stream=data, filetype="pdf")
        else:
            document = pymupdf.open(file_path, filetype="pdf")
    except Exception as exc:  # pymupdf raises FileDataError/EmptyFileError/RuntimeError variants
        logger.warning("Could not open PDF %s: %s", file_path.name if file_path else "<docx>", exc)
        raise PreprocessingError(
            "The uploaded PDF could not be opened. It may be corrupt - please re-export it and upload again.",
            "corrupt_pdf",
        ) from exc

    try:
        if document.needs_pass:
            raise PreprocessingError(
                "The uploaded PDF is password-protected. Remove the password and upload again.", "password_pdf"
            )
        count = document.page_count
        if count < 1:
            raise PreprocessingError(f"The uploaded {kind} has no pages.", "no_pages")
        max_pages = get_settings().max_pdf_pages
        if count > max_pages:
            raise PreprocessingError(
                f"The uploaded {kind} has {count} pages; the limit is {max_pages} pages per answer sheet.",
                "too_many_pages",
            )
    except BaseException:
        document.close()
        raise
    return document


def _render_pdf_pages(document: pymupdf.Document, dpi: int) -> Iterator[tuple[Image.Image, str]]:
    """Lazily render one page at a time (keeps memory flat for 10-page PDFs)."""
    for index in range(document.page_count):
        try:
            page = document.load_page(index)
            rect = page.rect
            zoom = dpi / 72.0
            area_px = max(rect.width, 1.0) * max(rect.height, 1.0) * zoom * zoom
            capped = area_px > MAX_MASTER_PIXELS
            if capped:
                zoom = math.sqrt(MAX_MASTER_PIXELS / (max(rect.width, 1.0) * max(rect.height, 1.0)))
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csRGB, alpha=False)
            image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
            del pixmap
        except Exception as exc:
            logger.warning("Could not render page %d: %s", index + 1, exc)
            raise PreprocessingError(
                f"Page {index + 1} of the uploaded PDF could not be rendered. The file may be corrupt.",
                "corrupt_pdf",
            ) from exc
        effective_dpi = round(zoom * 72)
        note = f"rendered at {effective_dpi} DPI ({image.width}x{image.height})"
        if capped:
            note += f" - large page, capped from {dpi} DPI"
        yield image, note


def _to_rgb(image: Image.Image) -> Image.Image:
    """Convert to RGB, flattening any transparency onto white paper."""
    has_alpha = image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)
    if has_alpha:
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return image.convert("RGB")  # Pillow scales 16-bit greyscale (I;16) correctly


def _fit_long_edge(image: Image.Image, max_edge: int) -> Image.Image:
    """A copy whose long edge is <= max_edge (the same object when it already fits)."""
    width, height = image.size
    if max(width, height) <= max_edge:
        return image
    scale = max_edge / max(width, height)
    size = (max(1, min(max_edge, round(width * scale))), max(1, min(max_edge, round(height * scale))))
    return image.resize(size, Image.Resampling.LANCZOS)


# --------------------------------------------------------------------------- #
# Enhancement (FR-2.6)
# --------------------------------------------------------------------------- #
def _row_profile_variance(gray: Image.Image, angle: float) -> float:
    rotated = gray.rotate(angle, resample=Image.Resampling.BILINEAR, expand=False, fillcolor=255)
    row_means = rotated.resize((1, rotated.height), Image.Resampling.BOX)
    return float(ImageStat.Stat(row_means).var[0])


def estimate_skew(image: Image.Image) -> float:
    """Skew of the page content in degrees (counter-clockwise positive), found by maximising the
    variance of the row-mean projection profile over +/-15 deg on a 600 px greyscale thumbnail
    (1 deg coarse, then 0.25 deg fine). Text lines are sharpest when horizontal. 0.0 when the
    page has no usable structure (blank or noise)."""
    gray = image.convert("L")
    gray.thumbnail((DESKEW_THUMB_PX, DESKEW_THUMB_PX), Image.Resampling.BOX)
    baseline = _row_profile_variance(gray, 0.0)
    if baseline < 1.0 and ImageStat.Stat(gray).var[0] < 1.0:
        return 0.0  # blank page

    def best(angles: list[float]) -> tuple[float, float]:
        # Ties go to the angle closest to 0 (never rotate without evidence).
        return max(((_row_profile_variance(gray, a), -abs(a), a) for a in angles))[0::2]

    coarse_var, coarse = best([float(a) for a in range(-DESKEW_RANGE_DEG, DESKEW_RANGE_DEG + 1)])
    steps = int(round(1 / DESKEW_FINE_STEP_DEG))
    fine_var, fine = best([coarse + k * DESKEW_FINE_STEP_DEG for k in range(-steps, steps + 1)])
    gray.close()
    if fine_var <= baseline * 1.01:
        return 0.0  # no clear improvement over the page as scanned
    return round(-fine, 2)


def enhance_page(image: Image.Image, *, contrast: float | None = None) -> tuple[Image.Image, dict[str, Any]]:
    """Deskew + auto-contrast + contrast boost + unsharp mask. Returns (new image, measured values)."""
    contrast = get_settings().preprocess_contrast if contrast is None else contrast
    skew = estimate_skew(image)
    info: dict[str, Any] = {"skew_deg": skew, "deskewed": False, "rotation_deg": 0.0, "contrast": contrast,
                            "unsharp_radius": UNSHARP_RADIUS}
    working = image
    if abs(skew) >= DESKEW_MIN_ANGLE_DEG:
        working = image.rotate(-skew, resample=Image.Resampling.BICUBIC, expand=False, fillcolor=(255, 255, 255))
        info.update(deskewed=True, rotation_deg=round(-skew, 2))
    # preserve_tone: stretch luminance only, so coloured paper/ink never gets a colour cast.
    contrasted = ImageOps.autocontrast(working, cutoff=AUTOCONTRAST_CUTOFF, preserve_tone=True)
    if working is not image:
        working.close()
    boosted = ImageEnhance.Contrast(contrasted).enhance(contrast)
    contrasted.close()
    sharpened = boosted.filter(
        ImageFilter.UnsharpMask(radius=UNSHARP_RADIUS, percent=UNSHARP_PERCENT, threshold=UNSHARP_THRESHOLD)
    )
    boosted.close()
    return sharpened, info


def _enhancement_text(info: dict[str, Any]) -> str:
    if info["deskewed"]:
        deskew = f"deskewed {info['rotation_deg']:+.1f} deg"
    else:
        deskew = f"no deskew needed (skew {info['skew_deg']:.1f} deg)"
    return f"{deskew}, contrast x{info['contrast']:g}, unsharp r={info['unsharp_radius']}"


# --------------------------------------------------------------------------- #
# Typed DOCX -> PDF (FR-1.1)
# --------------------------------------------------------------------------- #
def docx_to_pdf(data: bytes) -> tuple[bytes, int, int]:
    """Validate a .docx and lay it out as an A4 PDF in memory (pymupdf.Story).

    Returns (pdf bytes, page count, omitted image count). Images Pillow cannot identify as
    PNG/JPEG/GIF/BMP/TIFF (e.g. EMF/WMF) are omitted; if embedding still fails the document is
    rendered text-only and every image counts as omitted."""
    try:
        docx_reader.validate_docx(data)
        html, images = docx_reader.docx_to_html(data)
    except docx_reader.DocxError as exc:
        raise PreprocessingError(str(exc), exc.code) from exc
    if not html.strip():
        raise PreprocessingError("The Word document is empty - there is no answer text to read.", "no_pages")

    usable = {name: blob for name, blob in images.items() if _renderable_image(blob)}
    omitted = len(images) - len(usable)
    html = _without_images(html, set(images) - set(usable))
    try:
        pdf, pages = _story_pdf(html, usable)
    except PreprocessingError:
        raise
    except Exception as exc:  # noqa: BLE001 - image embedding failed: fall back to text only
        if not usable:
            logger.warning("DOCX layout failed: %s", exc)
            raise PreprocessingError("The Word document could not be converted to pages.", "corrupt_docx") from exc
        logger.warning("DOCX layout with images failed (%s); retrying text-only", exc)
        pdf, pages = _story_pdf(_without_images(html, set(images)), {})
        omitted = len(images)
    return pdf, pages, omitted


def _renderable_image(blob: bytes) -> bool:
    try:
        with Image.open(io.BytesIO(blob)) as image:
            image_format = image.format
            image.verify()
    except Exception:  # noqa: BLE001
        return False
    return image_format in DOCX_IMAGE_FORMATS


def _without_images(html: str, names: set[str]) -> str:
    for name in names:
        html = html.replace(f'<img src="{html_lib.escape(name, quote=True)}"/>', "<em>[image omitted]</em>")
    return html


def _story_pdf(html: str, images: dict[str, bytes]) -> tuple[bytes, int]:
    archive = pymupdf.Archive()
    for name, blob in images.items():
        archive.add(blob, name)
    story = pymupdf.Story(html=html, user_css=DOCX_CSS, archive=archive)
    buffer = io.BytesIO()
    writer = pymupdf.DocumentWriter(buffer)
    mediabox = pymupdf.paper_rect("a4")
    where = mediabox + (DOCX_MARGIN_PT, DOCX_MARGIN_PT, -DOCX_MARGIN_PT, -DOCX_MARGIN_PT)
    pages = 0
    more = True
    while more:
        device = writer.begin_page(mediabox)
        more, _filled = story.place(where)
        story.draw(device)
        writer.end_page()
        pages += 1
        if pages >= DOCX_HARD_PAGE_CAP and more:
            writer.close()
            raise PreprocessingError(
                f"The Word document has more than {DOCX_HARD_PAGE_CAP} pages; the limit is "
                f"{min(get_settings().max_pdf_pages, DOCX_HARD_PAGE_CAP)} pages per answer sheet.",
                "too_many_pages",
            )
    writer.close()
    return buffer.getvalue(), pages


# --------------------------------------------------------------------------- #
# Encoding & artifacts
# --------------------------------------------------------------------------- #
def _prepare_artifact_dir(artifact_dir: Path) -> None:
    """Create the folder and remove page images from an earlier run (retry / rescan)."""
    try:
        artifact_dir.mkdir(parents=True, exist_ok=True)
        for stale in artifact_dir.iterdir():
            if PAGE_FILE_RE.match(stale.name):
                stale.unlink(missing_ok=True)
    except OSError as exc:
        logger.exception("Could not prepare artifact directory %s", artifact_dir)
        raise PreprocessingError("Could not create the artifact folder for the normalised pages.") from exc


def _write(path: Path, data: bytes) -> None:
    try:
        path.write_bytes(data)
    except OSError as exc:
        logger.exception("Could not write page artifact %s", path)
        raise PreprocessingError("Could not save the normalised page images to the artifact store.") from exc


def _encode_page(image: Image.Image, budget: int) -> tuple[bytes, str, str, tuple[int, int]]:
    """Encode as PNG when it fits the byte budget, otherwise as progressively smaller JPEGs.

    Returns (data, media_type, extension, (width, height)).
    """
    png = _save(image, "PNG", compress_level=6)
    if len(png) <= budget:
        return png, "image/png", "png", image.size

    current = image
    while True:
        for quality in JPEG_QUALITIES:
            jpeg = _save(current, "JPEG", quality=quality, optimize=True)
            if len(jpeg) <= budget:
                return jpeg, "image/jpeg", "jpg", current.size
        # Still too large even at the lowest quality: shrink the page and try again.
        width, height = current.size
        if max(width, height) <= 400:
            return jpeg, "image/jpeg", "jpg", current.size
        current = current.resize((max(1, int(width * 0.8)), max(1, int(height * 0.8))), Image.Resampling.LANCZOS)


def _save(image: Image.Image, fmt: str, **params: object) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, fmt, **params)
    return buffer.getvalue()


def _human_bytes(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    return f"{max(1, round(size / 1024))} KB"
