"""POST /api/intake/preview (routers/preview_routes.py): page thumbnails of answer sheets and rubric
sources, rendered locally (no AI call, nothing stored)."""
from __future__ import annotations

import io
import zipfile

import pymupdf
import pytest
from PIL import Image

from tests.test_docx import DOCM_MAIN, make_docx
from tests.test_paper_detect import _encrypted_pdf


def _post(client, content: bytes, filename: str = "sheet.pdf", **form: str):
    return client.post(
        "/api/intake/preview", data=form, files={"file": (filename, content, "application/octet-stream")}
    )


def _image(response) -> Image.Image:
    return Image.open(io.BytesIO(response.content))


def _plain_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("notes.txt", "not a Word document")
    return buffer.getvalue()


def _two_page_pdf() -> bytes:
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "Page one")
    landscape = doc.new_page(width=842, height=595)  # A4 landscape: a different shape per page
    landscape.insert_text((72, 72), "Page two")
    data = doc.tobytes()
    doc.close()
    return data


def test_pdf_pages_one_and_two(client, forbid_ai, tmp_path):
    data = _two_page_pdf()
    first = _post(client, data)
    assert first.status_code == 200, first.text
    assert first.headers["content-type"] == "image/png"
    assert first.headers["x-page-count"] == "2" and first.headers["x-file-type"] == "pdf"
    image = _image(first)
    assert image.format == "PNG" and image.width == 480 and image.height > image.width  # portrait A4

    second = _post(client, data, page="2", width="600")
    assert second.status_code == 200 and second.headers["x-page-count"] == "2"
    image = _image(second)
    assert image.width == 600 and image.height < image.width  # landscape page 2
    uploads_dir = tmp_path / "uploads"
    assert not uploads_dir.exists() or not any(uploads_dir.iterdir())  # nothing stored


def test_width_is_clamped_and_tall_pages_are_capped(client):
    doc = pymupdf.open()
    doc.new_page(width=200, height=2000)  # a long strip, 10x taller than wide
    data = doc.tobytes()
    doc.close()
    small = _image(_post(client, _two_page_pdf(), width="10"))
    large = _image(_post(client, _two_page_pdf(), width="99999"))
    assert small.width == 120 and large.width == 1200
    strip = _image(_post(client, data, width="300"))
    assert strip.height <= 900 and strip.width < 300


def test_docx_page(client, forbid_ai):
    response = _post(client, make_docx(), "answers.docx", width="400")
    assert response.status_code == 200, response.text
    assert response.headers["x-file-type"] == "docx" and int(response.headers["x-page-count"]) >= 1
    assert response.headers["content-type"] == "image/png" and _image(response).width == 400


def test_png_photo_is_upright_jpeg_and_never_upscaled(client):
    buffer = io.BytesIO()
    Image.new("RGB", (1600, 1200), "white").save(buffer, "PNG")
    response = _post(client, buffer.getvalue(), "scan.png", width="320")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["x-file-type"] == "png" and response.headers["x-page-count"] == "1"
    assert _image(response).size == (320, 240)

    small = _post(client, _png(64, 48), "tiny.png")
    assert _image(small).size == (64, 48)


def test_jpeg_exif_orientation_is_applied(client):
    buffer = io.BytesIO()
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees clockwise to display
    Image.new("RGB", (800, 600), "white").save(buffer, "JPEG", exif=exif)
    response = _post(client, buffer.getvalue(), "photo.jpg", width="300")
    assert response.status_code == 200 and response.headers["x-file-type"] == "jpeg"
    image = _image(response)
    assert image.width == 300 and image.height == 400  # 600x800 upright


def test_transparent_png_is_flattened_onto_white(client):
    buffer = io.BytesIO()
    Image.new("RGBA", (200, 100), (0, 0, 0, 0)).save(buffer, "PNG")
    image = _image(_post(client, buffer.getvalue(), "clear.png", width="200"))
    assert image.getpixel((100, 50))[0] > 240


def test_text_answer_key(client):
    lines = [f"{n}. ({n % 4 + 1})" for n in range(1, 101)]
    response = _post(client, "\n".join(lines).encode("utf-8"), "key.txt")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-file-type"] == "text" and response.headers["x-page-count"] == "1"
    image = _image(response)
    assert image.width == 480 and image.height >= round(480 * 297 / 210)
    assert image.convert("L").getextrema()[0] < 100  # some dark text was drawn

    json_rubric = _post(client, b'\xef\xbb\xbf{"name": "Genetics", "questions": []}', "rubric.json", width="240")
    assert json_rubric.status_code == 200 and _image(json_rubric).width == 240


def test_audio_has_no_preview(client, wav_bytes):
    response = _post(client, wav_bytes, "answer.wav")
    assert response.status_code == 415 and response.json()["code"] == "no_preview"
    amr = _post(client, b"#!AMR\n" + b"\0" * 64, "answer.amr")
    assert amr.status_code == 415 and amr.json()["code"] == "no_preview"


@pytest.mark.parametrize(
    ("content", "form", "code"),
    [
        (b"%PDF", {"page": "3"}, "invalid_page"),
        (b"%PDF", {"page": "0"}, "invalid_page"),
        (b"%PDF", {"page": "two"}, "invalid_page"),
        (b"%PDF", {"width": "wide"}, "invalid_request"),
        (b"png", {"page": "2"}, "invalid_page"),
        (b"txt", {"page": "2"}, "invalid_page"),
    ],
)
def test_bad_page_or_width(client, content, form, code):
    data = {b"%PDF": _two_page_pdf(), b"png": _png(), b"txt": b"1. (2)\n2. (4)\n"}[content]
    response = _post(client, data, **form)
    assert response.status_code == 422, response.text
    assert response.json()["code"] == code


@pytest.mark.parametrize(
    ("content", "status", "code"),
    [
        (b"", 422, "empty_file"),
        (b"\x00\x01binary\x00blob", 415, "unsupported_signature"),
        (b"Answer key - caf\xe9 (Latin-1, not UTF-8)", 415, "unsupported_signature"),
        (_plain_zip(), 415, "unsupported_signature"),
        (b"%PDF-1.7\n this is not a valid pdf body", 422, "corrupt_pdf"),
        (_encrypted_pdf(), 422, "password_pdf"),
        (b"\x89PNG\r\n\x1a\n" + b"\0" * 64, 422, "corrupt_image"),
        (b"PK\x03\x04" + b"\x13" * 200, 422, "corrupt_docx"),
        (make_docx(main_type=DOCM_MAIN, extra_entries={"word/vbaProject.bin": b"\x00" * 32}), 415, "macro_docx"),
    ],
)
def test_corrupt_and_unsupported_files(client, content, status, code):
    response = _post(client, content)
    assert response.status_code == status, response.text
    assert response.json()["code"] == code


def test_truncated_jpeg_is_corrupt(client):
    buffer = io.BytesIO()
    Image.effect_noise((400, 300), 64).convert("RGB").save(buffer, "JPEG")
    response = _post(client, buffer.getvalue()[: len(buffer.getvalue()) // 2], "cut.jpg")
    assert response.status_code == 422 and response.json()["code"] == "corrupt_image"


def test_size_limit_and_missing_file(client, png_bytes):
    response = _post(client, png_bytes + b"\0" * (20 * 1024 * 1024), "huge.png")
    assert response.status_code == 413 and response.json()["code"] == "too_large"
    missing = client.post("/api/intake/preview", data={})
    assert missing.status_code == 422 and missing.json()["code"] == "missing_file"


def _png(width: int = 64, height: int = 48) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, "PNG")
    return buffer.getvalue()


# --------------------------------------------------------------------------- #
# UTF-16 text and long lines (review fixes)
# --------------------------------------------------------------------------- #
UTF16_KEY = "Answer key - NEET 2016 Code A\r\n1. (2)\r\n2. (4)\r\n51. (2 or 3)\r\n71. Bonus\r\n"


@pytest.mark.parametrize("encoding", ["utf-16", "utf-16-le-bom", "utf-16-be-bom", "utf-16-le", "utf-16-be"])
def test_a_utf16_text_key_previews_as_text(client, encoding):
    """Notepad / Excel "Unicode text" starts with FF FE - also an MPEG-1 Layer I frame header, so the
    key used to be taken for an MP3 (415 no_preview)."""
    import uploads

    if encoding.endswith("-bom"):
        codec = encoding.removesuffix("-bom")
        data = "\ufeff".encode(codec) + UTF16_KEY.encode(codec)
    else:
        data = UTF16_KEY.encode(encoding)
    assert uploads.sniff_audio(data[:8192]) is None
    assert uploads.utf16_text(data) == UTF16_KEY
    response = _post(client, data, "key.txt")
    assert response.status_code == 200, response.text
    assert response.headers["x-file-type"] == "text" and response.headers["content-type"] == "image/png"
    assert _image(response).convert("L").getextrema()[0] < 100


def test_real_audio_after_a_utf16_lookalike_header_is_still_audio():
    import random

    import uploads

    rng = random.Random(7)
    noise = bytes(rng.getrandbits(8) for _ in range(4096))
    assert uploads.sniff_audio(b"\xff\xfe" + noise) == "audio/mpeg"          # Layer I frame + audio data
    assert uploads.sniff_audio(b"\xff\xfe\x90\x00" + bytes(512)) == "audio/mpeg"
    assert uploads.sniff_audio(b"\xff\xfb\x90\x64" + noise) == "audio/mpeg"  # an ordinary MP3 frame
    assert uploads.sniff_audio(b"ID3\x04\x00" + noise) == "audio/mpeg"
    assert uploads.utf16_text(noise) is None and uploads.utf16_text(b"plain ASCII text") is None


def test_text_lines_are_capped_before_wrapping():
    from routers import preview_routes

    lines = preview_routes.text_lines("x" * 2_000_000)
    assert lines == ["x" * preview_routes.TEXT_LINE_CHARS]
    many = preview_routes.text_lines("\n".join(f"{n}. (2)\t" + "y" * 1000 for n in range(5000)))
    assert len(many) == preview_routes.TEXT_LINES
    assert all(len(line) <= preview_routes.TEXT_LINE_CHARS for line in many)
    assert many[0].startswith("0. (2)  y")  # tab expanded to the next 4-column stop


def test_one_huge_unbroken_line_previews_quickly(client):
    """textwrap on one long token is quadratic: a 5 MB line used to take minutes at 120 px."""
    import time

    started = time.perf_counter()
    response = _post(client, b"A" * (5 * 1024 * 1024), "key.txt", width="120")
    assert response.status_code == 200, response.text
    assert time.perf_counter() - started < 10
