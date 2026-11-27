"""Tests for preprocessing (images, PDFs, real enhancement, deskew; no network)."""
from __future__ import annotations

import io
import os
import random
import sys
from pathlib import Path

import pymupdf
import pytest
from PIL import Image, ImageDraw

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import preprocessing  # noqa: E402
from preprocessing import (  # noqa: E402
    ENHANCEMENT_DISABLED_MESSAGE,
    MAX_LONG_EDGE_PX,
    MAX_PAGE_BYTES,
    SIMULATION_MESSAGE,
    PreprocessingError,
    enhance_page,
    estimate_skew,
    preprocess_document,
    render_review_pages,
)

INTRO = "Pre-processing each page: 300 DPI master"


class LogCollector(list):
    def __call__(self, message: str) -> None:
        self.append(message)


@pytest.fixture(autouse=True)
def _master_dpi_300(monkeypatch):
    """These tests pin the 300 DPI master geometry; the shipped default is 200 (printed papers)."""
    monkeypatch.setenv("PDF_MASTER_DPI", "300")


@pytest.fixture
def log() -> LogCollector:
    return LogCollector()


def _sheet(size=(1200, 1600), color=(250, 250, 245)) -> Image.Image:
    """A synthetic 'answer sheet' with some dark strokes."""
    image = Image.new("RGB", size, color)
    for y in range(100, size[1] - 100, 80):
        for x in range(80, size[0] - 80, 7):
            image.putpixel((x, y), (20, 20, 60))
    return image


def text_page(size=(1240, 1754), seed: int = 1) -> Image.Image:
    """A page of 'handwriting': lines of word-sized dark blocks on off-white paper."""
    rnd = random.Random(seed)
    image = Image.new("RGB", size, (250, 250, 248))
    draw = ImageDraw.Draw(image)
    y = 120
    while y < size[1] - 120:
        x = 100
        while x < size[0] - 160:
            width = rnd.randint(30, 110)
            draw.rectangle([x, y, x + width, y + 14], fill=(30, 30, 70))
            x += width + rnd.randint(14, 30)
        y += 46
    return image


def _write_image(path: Path, image: Image.Image, fmt: str, **params) -> Path:
    image.save(path, fmt, **params)
    return path


def _open_page(page) -> Image.Image:
    return Image.open(io.BytesIO(page.data))


def _make_pdf(path: Path, pages: int, size=(595, 842)) -> Path:
    document = pymupdf.open()
    for n in range(pages):
        page = document.new_page(width=size[0], height=size[1])
        page.insert_text((72, 100), f"Q{n + 1}. Tt x tt gives 1 tall : 1 dwarf", fontsize=14)
    document.save(path)
    document.close()
    return path


# --------------------------------------------------------------------------- #
# Images
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("fmt", "mime", "params"),
    [("PNG", "image/png", {}), ("JPEG", "image/jpeg", {"quality": 90}), ("WEBP", "image/webp", {"quality": 90})],
)
def test_image_formats_are_normalised_and_enhanced(tmp_path, log, fmt, mime, params):
    source = _write_image(tmp_path / f"sheet.{fmt.lower()}", _sheet(), fmt, **params)
    artifacts = tmp_path / "artifacts" / "42"

    pages = preprocess_document(source, mime, artifacts, log)

    assert log[0].startswith(INTRO) and "contrast x1.4" in log[0] and "unsharp mask r=2" in log[0]
    assert not any("Simulating" in line for line in log)  # real processing, measured values only
    assert len(pages) == 1
    page = pages[0]
    assert page.page_number == 1
    assert page.media_type == "image/png"
    assert page.path == artifacts / "page_1.png"
    assert page.path.read_bytes() == page.data
    assert (artifacts / "page_1_original.png").is_file()  # pre-enhancement copy for the viewer
    decoded = _open_page(page)
    assert decoded.format == "PNG"
    assert decoded.mode == "RGB"
    assert decoded.size == (1200, 1600)  # short edge already at MIN_SHORT_EDGE_PX: no upscale
    assert len(page.data) <= MAX_PAGE_BYTES
    line = next(line for line in log if line.startswith("Page 1/1"))
    assert "contrast x1.4" in line and "unsharp r=2" in line and "sent 1200x1600" in line


def test_enhancement_changes_pixels_but_original_is_kept(tmp_path, log):
    source = _write_image(tmp_path / "sheet.png", text_page(), "PNG")
    artifacts = tmp_path / "out"
    preprocess_document(source, "image/png", artifacts, log)
    with Image.open(artifacts / "page_1.png") as processed, Image.open(artifacts / "page_1_original.png") as original:
        assert processed.size == original.size
        assert processed.tobytes() != original.tobytes()
        # Auto-contrast stretches the off-white paper to pure white.
        assert processed.convert("L").getextrema()[1] == 255


def test_enhancement_can_be_disabled(tmp_path, log, monkeypatch):
    monkeypatch.setenv("PREPROCESS_ENHANCE", "0")
    source = _write_image(tmp_path / "sheet.png", _sheet(), "PNG")
    artifacts = tmp_path / "out"
    pages = preprocess_document(source, "image/png", artifacts, log)
    assert log[0].startswith(ENHANCEMENT_DISABLED_MESSAGE)
    assert not any("Simulating" in line for line in log)
    assert not (artifacts / "page_1_original.png").exists()
    assert any("no enhancement" in line for line in log)
    assert _open_page(pages[0]).size == (1200, 1600)


def test_contrast_factor_is_configurable(tmp_path, log, monkeypatch):
    monkeypatch.setenv("PREPROCESS_CONTRAST", "1.8")
    source = _write_image(tmp_path / "sheet.png", _sheet(), "PNG")
    preprocess_document(source, "image/png", tmp_path / "out", log)
    assert "contrast x1.8" in log[0]


def test_simulation_message_is_still_exported_for_compatibility():
    assert SIMULATION_MESSAGE == "Simulating Deskew and 300 DPI Contrast Enhancement."


def test_huge_image_is_downscaled(tmp_path, log):
    source = _write_image(tmp_path / "huge.jpg", _sheet((5000, 3000)), "JPEG", quality=85)
    pages = preprocess_document(source, "image/jpeg", tmp_path / "out", log)
    decoded = _open_page(pages[0])
    assert max(decoded.size) == MAX_LONG_EDGE_PX
    assert decoded.size == (2000, 1200)
    assert any("Downscaled from 5000x3000" in line for line in log)


def test_vision_max_edge_is_configurable(tmp_path, log, monkeypatch):
    monkeypatch.setenv("VISION_MAX_EDGE_PX", "1000")
    source = _write_image(tmp_path / "sheet.png", _sheet(), "PNG")
    pages = preprocess_document(source, "image/png", tmp_path / "out", log)
    assert _open_page(pages[0]).size == (750, 1000)


def test_exif_orientation_is_applied_and_small_photos_are_upscaled(tmp_path, log):
    image = _sheet((800, 600))
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees clockwise on display
    source = tmp_path / "phone.jpg"
    image.save(source, "JPEG", exif=exif)

    pages = preprocess_document(source, "image/jpeg", tmp_path / "out", log)
    # Upright 600x800, then LANCZOS-upscaled x2 (capped) to reach the 1200 px short edge.
    assert _open_page(pages[0]).size == (1200, 1600)
    assert any("EXIF orientation applied" in line for line in log)
    assert any("upscaled x2.00 (LANCZOS)" in line for line in log)


def test_upscale_is_capped_at_2x(tmp_path, log):
    source = _write_image(tmp_path / "tiny.png", _sheet((300, 400)), "PNG")
    pages = preprocess_document(source, "image/png", tmp_path / "out", log)
    assert _open_page(pages[0]).size == (600, 800)
    assert any("low-resolution image" in line for line in log)


def test_transparent_png_is_flattened_on_white(tmp_path, log):
    image = Image.new("RGBA", (900, 900), (0, 0, 0, 0))
    source = _write_image(tmp_path / "transparent.png", image, "PNG")
    pages = preprocess_document(source, "image/png", tmp_path / "out", log)
    decoded = _open_page(pages[0]).convert("RGB")
    assert decoded.getpixel((10, 10)) == (255, 255, 255)


def test_large_noisy_image_falls_back_to_jpeg_under_limit(tmp_path, log):
    noise = Image.frombytes("RGB", (2000, 2000), os.urandom(2000 * 2000 * 3))
    source = _write_image(tmp_path / "noise.png", noise, "PNG")
    assert source.stat().st_size > MAX_PAGE_BYTES  # the PNG route cannot fit

    pages = preprocess_document(source, "image/png", tmp_path / "out", log)
    page = pages[0]
    assert page.media_type == "image/jpeg"
    assert page.path.name == "page_1.jpg"
    assert len(page.data) <= MAX_PAGE_BYTES
    assert _open_page(page).format == "JPEG"


def test_mime_aliases_and_parameters_are_accepted(tmp_path, log):
    source = _write_image(tmp_path / "sheet.jpg", _sheet((600, 800)), "JPEG")
    pages = preprocess_document(source, "IMAGE/JPG; charset=binary", tmp_path / "out", log)
    assert len(pages) == 1


# --------------------------------------------------------------------------- #
# Deskew (FR-2.6)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("angle", [4.0, -4.0])
def test_deskew_estimates_a_4_degree_skew_within_half_a_degree(angle):
    skewed = text_page().rotate(angle, resample=Image.Resampling.BICUBIC, expand=False, fillcolor=(255, 255, 255))
    assert estimate_skew(skewed) == pytest.approx(angle, abs=0.5)


def test_enhance_page_straightens_a_skewed_page():
    skewed = text_page(seed=7).rotate(4.0, resample=Image.Resampling.BICUBIC, expand=False, fillcolor=(255, 255, 255))
    straightened, info = enhance_page(skewed, contrast=1.4)
    assert info["deskewed"] is True and info["rotation_deg"] == pytest.approx(-4.0, abs=0.5)
    assert straightened.size == skewed.size  # expand=False keeps the page size
    assert abs(estimate_skew(straightened)) <= 0.5


def test_straight_and_blank_pages_are_not_rotated():
    _, info = enhance_page(text_page(seed=3), contrast=1.4)
    assert info["deskewed"] is False and abs(info["skew_deg"]) < 0.3
    assert estimate_skew(Image.new("RGB", (800, 1000), "white")) == 0.0


def test_skewed_upload_logs_the_measured_rotation(tmp_path, log):
    skewed = text_page(seed=5).rotate(-3.5, resample=Image.Resampling.BICUBIC, expand=False, fillcolor=(255, 255, 255))
    source = _write_image(tmp_path / "skewed.png", skewed, "PNG")
    preprocess_document(source, "image/png", tmp_path / "out", log)
    line = next(line for line in log if line.startswith("Page 1/1"))
    assert "deskewed +3.5 deg" in line


# --------------------------------------------------------------------------- #
# PDFs
# --------------------------------------------------------------------------- #
def test_multi_page_pdf_is_rendered_at_300_dpi_in_order(tmp_path, log):
    source = _make_pdf(tmp_path / "sheet.pdf", pages=3)
    artifacts = tmp_path / "artifacts" / "7"

    pages = preprocess_document(source, "application/pdf", artifacts, log)

    assert log[0].startswith(INTRO)
    assert [p.page_number for p in pages] == [1, 2, 3]
    for page in pages:
        assert page.path.exists() and page.path.parent == artifacts
        assert page.path.name.startswith(f"page_{page.page_number}.")
        assert (artifacts / f"page_{page.page_number}_original.png").is_file()
        decoded = _open_page(page)
        assert decoded.mode == "RGB"
        # A4 (595x842 pt) at 300 DPI = 2480x3508 px master -> 1414x2000 for the model.
        assert max(decoded.size) == MAX_LONG_EDGE_PX
        assert abs(decoded.size[0] - 1414) <= 2
        assert len(page.data) <= MAX_PAGE_BYTES
    assert any("3 page(s)" in line for line in log)
    assert any("rendered at 300 DPI (2480x35" in line for line in log)
    assert any("sent 1414x2000 to the vision model" in line for line in log)


def test_small_pdf_page_renders_at_300_dpi(tmp_path, log):
    source = _make_pdf(tmp_path / "small.pdf", pages=1, size=(288, 216))  # 4 x 3 inches
    pages = preprocess_document(source, "application/pdf", tmp_path / "out", log)
    width, height = _open_page(pages[0]).size
    assert abs(width - 1200) <= 1 and abs(height - 900) <= 1


def test_pdf_master_dpi_is_configurable(tmp_path, log, monkeypatch):
    monkeypatch.setenv("PDF_MASTER_DPI", "200")
    source = _make_pdf(tmp_path / "small.pdf", pages=1, size=(288, 216))
    pages = preprocess_document(source, "application/pdf", tmp_path / "out", log)
    width, height = _open_page(pages[0]).size
    assert abs(width - 800) <= 1 and abs(height - 600) <= 1


def test_pdf_with_too_many_pages_is_rejected(tmp_path, log):
    source = _make_pdf(tmp_path / "long.pdf", pages=41)  # default limit: 40 (a full printed paper fits)
    with pytest.raises(PreprocessingError, match="41 pages; the limit is 40") as excinfo:
        preprocess_document(source, "application/pdf", tmp_path / "out", log)
    assert excinfo.value.code == "too_many_pages"
    assert not (tmp_path / "out").exists()  # rejected before any page is rendered


def test_pdf_at_the_page_limit_is_accepted(tmp_path, log, monkeypatch):
    monkeypatch.setenv("MAX_PDF_PAGES", "10")  # configurable; a lower limit keeps the test fast
    source = _make_pdf(tmp_path / "ten.pdf", pages=10, size=(300, 400))
    pages = preprocess_document(source, "application/pdf", tmp_path / "out", log)
    assert [p.page_number for p in pages] == list(range(1, 11))
    with pytest.raises(PreprocessingError, match="11 pages; the limit is 10"):
        preprocess_document(_make_pdf(tmp_path / "eleven.pdf", pages=11), "application/pdf", tmp_path / "o2", log)


def test_password_protected_pdf_is_rejected(tmp_path, log):
    path = tmp_path / "locked.pdf"
    document = pymupdf.open()
    document.new_page()
    document.save(path, encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="user")
    document.close()
    with pytest.raises(PreprocessingError, match="password") as excinfo:
        preprocess_document(path, "application/pdf", tmp_path / "out", log)
    assert excinfo.value.code == "password_pdf"


def test_rerun_replaces_stale_page_images(tmp_path, log):
    artifacts = tmp_path / "out"
    preprocess_document(_make_pdf(tmp_path / "three.pdf", pages=3, size=(300, 400)), "application/pdf", artifacts, log)
    preprocess_document(_make_pdf(tmp_path / "one.pdf", pages=1, size=(300, 400)), "application/pdf", artifacts, log)
    assert sorted(p.name for p in artifacts.iterdir()) == ["page_1.png", "page_1_original.png"]


# --------------------------------------------------------------------------- #
# Review pages (sheets that never reached pre-processing)
# --------------------------------------------------------------------------- #
def test_render_review_pages_writes_unenhanced_model_sized_pages(tmp_path):
    source = _make_pdf(tmp_path / "sheet.pdf", pages=2)
    artifacts = tmp_path / "out"
    paths = render_review_pages(source, "application/pdf", artifacts)
    assert [p.name for p in paths] == ["page_1.png", "page_2.png"]
    assert not any("_original" in p.name for p in artifacts.iterdir())
    with Image.open(paths[0]) as image:
        assert max(image.size) == MAX_LONG_EDGE_PX


def test_page_count_helper(tmp_path):
    assert preprocessing.page_count(_make_pdf(tmp_path / "s.pdf", pages=4, size=(300, 400)), "application/pdf") == 4
    assert preprocessing.page_count(_write_image(tmp_path / "p.png", _sheet(), "PNG"), "image/png") == 1


# --------------------------------------------------------------------------- #
# Corrupt / unsupported input
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("name", "mime", "payload", "code"),
    [
        ("corrupt.png", "image/png", b"\x89PNG\r\n\x1a\n" + b"not really a png" * 20, "corrupt_image"),
        ("corrupt.jpg", "image/jpeg", os.urandom(4096), "corrupt_image"),
        ("corrupt.webp", "image/webp", b"RIFF\x00\x00\x00\x00WEBPjunk", "corrupt_image"),
        ("corrupt.pdf", "application/pdf", b"%PDF-1.7\n" + os.urandom(2048), "corrupt_pdf"),
        ("text.pdf", "application/pdf", b"hello, this is not a pdf at all", "corrupt_pdf"),
    ],
)
def test_corrupt_files_raise_friendly_error(tmp_path, log, name, mime, payload, code):
    source = tmp_path / name
    source.write_bytes(payload)
    with pytest.raises(PreprocessingError) as excinfo:
        preprocess_document(source, mime, tmp_path / "out", log)
    message = str(excinfo.value)
    assert "corrupt" in message.lower()
    assert "Traceback" not in message
    assert excinfo.value.code == code
    assert log[0].startswith(INTRO)


def test_truncated_image_raises(tmp_path, log):
    full = tmp_path / "full.png"
    _write_image(full, _sheet((800, 800)), "PNG")
    truncated = tmp_path / "truncated.png"
    truncated.write_bytes(full.read_bytes()[: full.stat().st_size // 2])
    with pytest.raises(PreprocessingError):
        preprocess_document(truncated, "image/png", tmp_path / "out", log)


def test_unsupported_mime_type_is_rejected(tmp_path, log):
    source = tmp_path / "notes.txt"
    source.write_text("Q1 answer")
    with pytest.raises(PreprocessingError, match="Unsupported file type"):
        preprocess_document(source, "text/plain", tmp_path / "out", log)


def test_missing_and_empty_files_are_rejected(tmp_path, log):
    with pytest.raises(PreprocessingError, match="could not be found"):
        preprocess_document(tmp_path / "missing.png", "image/png", tmp_path / "out", log)
    empty = tmp_path / "empty.png"
    empty.write_bytes(b"")
    with pytest.raises(PreprocessingError, match="empty"):
        preprocess_document(empty, "image/png", tmp_path / "out", log)


def test_multi_page_documents_share_a_byte_budget(tmp_path, log, monkeypatch):
    # Shrink the document budget so each of 3 pages must fit in ~1/3 of it.
    monkeypatch.setattr(preprocessing, "MAX_DOCUMENT_BYTES", 900_000)
    source = _make_pdf(tmp_path / "budget.pdf", pages=3)
    pages = preprocess_document(source, "application/pdf", tmp_path / "out", log)
    assert all(len(page.data) <= 300_000 for page in pages)
