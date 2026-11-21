"""Typed Word answer sheets (BRD FR-1.1: same PDF -> vision route, no text path), corrupt or
macro-enabled packages, other ZIPs, and voice answers (FR-2.8: accepted unless VOICE_ANSWERS=0;
AMR / FLAC rejected as unsupported audio)."""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest
from PIL import Image

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
DOCX_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
DOCM_MAIN = "application/vnd.ms-word.document.macroEnabled.main+xml"
VOICE_DISABLED_DETAIL = "Voice answers are switched off on this server (VOICE_ANSWERS=0)."
UNSUPPORTED_AUDIO_DETAIL = "Unsupported audio format. Upload an MP3, WAV, M4A or OGG voice answer."


def _png(size=(120, 80), color="navy") -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, "PNG")
    return buffer.getvalue()


def _paragraph(text: str, style: str | None = None) -> str:
    ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f"<w:p>{ppr}<w:r><w:t xml:space=\"preserve\">{text}</w:t></w:r></w:p>"


def _image_paragraph(rid: str) -> str:
    return (
        f'<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="635000"/><a:graphic><a:graphicData>'
        f'<pic:pic><pic:blipFill><a:blip r:embed="{rid}"/></pic:blipFill></pic:pic>'
        f"</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
    )


def make_docx(
    paragraphs: list[str] | None = None,
    *,
    table: list[list[str]] | None = None,
    images: dict[str, bytes] | None = None,
    main_type: str = DOCX_MAIN,
    extra_entries: dict[str, bytes] | None = None,
    with_document: bool = True,
) -> bytes:
    paragraphs = paragraphs if paragraphs is not None else [
        "Q1. Tt x tt gives 1 tall : 1 dwarf.", "Q2. Snapdragon shows incomplete dominance.",
    ]
    images = images or {}
    body = [_paragraph("Answer sheet - Aarav Sharma", "Heading1"), *(_paragraph(p) for p in paragraphs)]
    if table:
        rows = "".join(
            "<w:tr>" + "".join(f"<w:tc>{_paragraph(cell)}</w:tc>" for cell in row) + "</w:tr>" for row in table
        )
        body.append(f"<w:tbl>{rows}</w:tbl>")
    rels = []
    for index, name in enumerate(images, start=1):
        body.append(_image_paragraph(f"rIdImg{index}"))
        rels.append(
            f'<Relationship Id="rIdImg{index}" '
            f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/{name}"/>'
        )
    document = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{W}" xmlns:r="{R}" xmlns:a="{A}" xmlns:pic="{PIC}" xmlns:wp="{WP}">'
        f"<w:body>{''.join(body)}</w:body></w:document>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="png" ContentType="image/png"/>'
        f'<Override PartName="/word/document.xml" ContentType="{main_type}"/></Types>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr(
            "_rels/.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
            'officeDocument" Target="word/document.xml"/></Relationships>',
        )
        if with_document:
            archive.writestr("word/document.xml", document)
        archive.writestr(
            "word/_rels/document.xml.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + "".join(rels) + "</Relationships>",
        )
        for name, blob in images.items():
            archive.writestr(f"word/media/{name}", blob)
        for name, blob in (extra_entries or {}).items():
            archive.writestr(name, blob)
    return buffer.getvalue()


def uploaded_files(tmp_path: Path) -> list[Path]:
    folder = tmp_path / "uploads"
    return [p for p in folder.iterdir() if p.is_file()] if folder.exists() else []


# --------------------------------------------------------------------------- #
# docx_reader
# --------------------------------------------------------------------------- #
def test_docx_reader_text_html_and_images():
    import docx_reader

    data = make_docx(table=[["Q", "Answer"], ["3", "Semi-conservative"]], images={"image1.png": _png()})
    docx_reader.validate_docx(data)
    text = docx_reader.docx_text(data)
    assert text.splitlines()[:3] == [
        "Answer sheet - Aarav Sharma", "Q1. Tt x tt gives 1 tall : 1 dwarf.", "Q2. Snapdragon shows incomplete dominance.",
    ]
    assert "Q | Answer" in text and "3 | Semi-conservative" in text
    html, images = docx_reader.docx_to_html(data)
    assert "<h2>Answer sheet - Aarav Sharma</h2>" in html and "<table>" in html
    assert '<img src="image1.png"/>' in html and set(images) == {"image1.png"}
    assert docx_reader.describe(data) == {"paragraphs": 4, "tables": 1, "images": 1}


def test_docx_reader_escapes_markup():
    import docx_reader

    html, _ = docx_reader.docx_to_html(make_docx(["a &lt;b&gt; c"]))  # the run's text is "a <b> c"
    assert "<b>" not in html and "&lt;b&gt;" in html


@pytest.mark.parametrize(
    ("data", "code"),
    [
        (b"PK\x03\x04" + b"\x00" * 64, "corrupt_docx"),
        (make_docx(main_type=DOCM_MAIN, extra_entries={"word/vbaProject.bin": b"\x00" * 32}), "macro_docx"),
        (make_docx(with_document=False), "corrupt_docx"),
    ],
)
def test_validate_docx_rejects_bad_packages(data, code):
    import docx_reader

    with pytest.raises(docx_reader.DocxError) as excinfo:
        docx_reader.validate_docx(data)
    assert excinfo.value.code == code


def test_validate_docx_caps_entries_and_size():
    import docx_reader

    data = make_docx(extra_entries={f"customXml/item{n}.xml": b"<a/>" for n in range(20)})
    with pytest.raises(docx_reader.DocxError) as excinfo:
        docx_reader.validate_docx(data, max_entries=10)
    assert excinfo.value.code == "docx_too_large"
    with pytest.raises(docx_reader.DocxError) as excinfo:
        docx_reader.validate_docx(data, max_uncompressed=100)
    assert excinfo.value.code == "docx_too_large"


# --------------------------------------------------------------------------- #
# Conversion (same PDF -> vision route)
# --------------------------------------------------------------------------- #
def test_docx_is_converted_to_pdf_pages_and_preprocessed(tmp_path):
    import preprocessing
    from config import DOCX_MIME

    source = tmp_path / "typed.docx"
    source.write_bytes(make_docx(images={"image1.png": _png()}))
    log: list[str] = []
    pages = preprocessing.preprocess_document(source, DOCX_MIME, tmp_path / "out", log.append)
    assert len(pages) == 1
    assert "Converted typed DOCX to PDF (1 page) - same vision path." in log
    assert any("rendered at 300 DPI" in line for line in log)
    assert (tmp_path / "out" / "page_1.png").is_file() and (tmp_path / "out" / "page_1_original.png").is_file()


def test_unrenderable_images_are_omitted_but_text_is_kept(tmp_path):
    import preprocessing

    data = make_docx(images={"image1.png": _png(), "image2.emf": b"\x01\x00\x00\x00 not an image"})
    pdf, pages, omitted = preprocessing.docx_to_pdf(data)
    assert pdf.startswith(b"%PDF") and pages == 1 and omitted == 1


def test_long_docx_is_paged_on_a4():
    import preprocessing

    _pdf, pages, _ = preprocessing.docx_to_pdf(make_docx([f"Line {n} of a long typed answer." for n in range(120)]))
    assert 2 <= pages <= 6


# --------------------------------------------------------------------------- #
# Upload
# --------------------------------------------------------------------------- #
def test_docx_upload_is_accepted_paged_and_processed(upload, fake_ai, client, tmp_path):
    response = upload(filename="aarav_typed.docx", content=make_docx())
    assert response.status_code == 202, response.text
    sub = response.json()
    assert sub["page_count"] == 1 and sub["original_filename"] == "aarav_typed.docx"
    stored = uploaded_files(tmp_path)
    assert len(stored) == 1 and stored[0].suffix == ".docx"
    body = client.get(f"/api/results/{sub['id']}").json()
    assert body["submission"]["status"] == "COMPLETED"
    assert "typed Word document, 1 A4 page after conversion" in body["processing_log"][0]["message"]
    assert fake_ai.calls["ocr"] == 1  # typed sheets take the vision route too


def test_docx_extension_does_not_matter(upload, fake_ai):
    response = upload(filename="renamed.pdf", content=make_docx())
    assert response.status_code == 202 and response.json()["original_filename"] == "renamed.pdf"


@pytest.mark.parametrize(
    ("content", "status", "code"),
    [
        (b"PK\x03\x04" + b"\x13" * 200, 422, "corrupt_docx"),
        (make_docx(with_document=False), 422, "corrupt_docx"),
        (make_docx(main_type=DOCM_MAIN, extra_entries={"word/vbaProject.bin": b"\x00" * 32}), 415, "macro_docx"),
        (make_docx([f"Paragraph {n} " + "word " * 60 for n in range(150)]), 422, "too_many_pages"),
        (make_docx(paragraphs=[], extra_entries={"word/media/huge.bin": b"\0" * (51 * 1024 * 1024)}), 422,
         "docx_too_large"),
    ],
)
def test_bad_word_documents_are_rejected(upload, forbid_ai, tmp_path, content, status, code):
    response = upload(filename="sheet.docx", content=content)
    assert response.status_code == status, response.text
    assert response.json()["code"] == code
    assert uploaded_files(tmp_path) == []
    assert forbid_ai == []


def test_other_zip_files_are_unsupported(upload, forbid_ai, tmp_path):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("notes.txt", "not a word document")
    response = upload(filename="answers.zip", content=buffer.getvalue())
    assert response.status_code == 415 and response.json()["code"] == "unsupported_signature"
    assert "DOCX" in response.json()["detail"]
    xlsx = make_docx(main_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml")
    response = upload(filename="marks.xlsx", content=xlsx)
    assert response.status_code == 415 and response.json()["code"] == "unsupported_signature"
    assert uploaded_files(tmp_path) == []


def _wav() -> bytes:
    import wave

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(8000)
        handle.writeframes(b"\x00\x00" * 8000)
    return buffer.getvalue()


VOICE_FILES = [
    ("answer.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 64, "audio/mpeg"),
    ("answer_raw.mp3", b"\xff\xfb\x90\x64" + b"\x00" * 64, "audio/mpeg"),
    ("answer.wav", _wav(), "audio/wav"),
    ("answer.m4a", b"\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00" + b"\x00" * 64, "audio/mp4"),
    ("answer.ogg", b"OggS\x00\x02" + b"\x00" * 64, "audio/ogg"),
]


@pytest.mark.parametrize(("name", "content", "mime"), VOICE_FILES)
def test_voice_answers_are_accepted(upload, fake_ai, fake_transcriber, client, name, content, mime):
    response = upload(filename=name, content=content, voice_question="1")
    assert response.status_code == 202, response.text
    sub = response.json()
    assert sub["input_kind"] == "voice" and sub["page_count"] is None and sub["voice_question"] == 1
    result = client.get(f"/api/results/{sub['id']}")
    assert result.status_code == 200, result.text
    assert result.json()["submission"]["status"] == "COMPLETED"
    assert fake_transcriber.kwargs[0]["mime_type"] == mime and fake_ai.calls["ocr"] == 0


@pytest.mark.parametrize(("name", "content", "mime"), VOICE_FILES)
def test_voice_answers_can_be_switched_off(upload, forbid_ai, tmp_path, monkeypatch, name, content, mime):
    monkeypatch.setenv("VOICE_ANSWERS", "0")
    response = upload(filename=name, content=content)
    assert response.status_code == 415
    assert response.json() == {"detail": VOICE_DISABLED_DETAIL, "code": "voice_disabled"}
    assert uploaded_files(tmp_path) == []


@pytest.mark.parametrize(
    ("name", "content"),
    [("answer.amr", b"#!AMR\n" + b"\x00" * 64), ("answer.flac", b"fLaC\x00\x00\x00\x22" + b"\x00" * 64)],
)
def test_amr_and_flac_are_unsupported_audio(upload, forbid_ai, tmp_path, name, content):
    response = upload(filename=name, content=content)
    assert response.status_code == 415
    assert response.json() == {"detail": UNSUPPORTED_AUDIO_DETAIL, "code": "unsupported_audio"}
    assert uploaded_files(tmp_path) == []


def test_jpeg_and_png_are_not_mistaken_for_audio():
    import uploads

    assert not uploads.is_voice_note(b"\xff\xd8\xff\xe0" + b"\x00" * 16)
    assert not uploads.is_voice_note(b"\x89PNG\r\n\x1a\n")
    assert uploads.sniff_mime(b"\xff\xd8\xff\xe0") == "image/jpeg"
    assert uploads.sniff_audio(b"\xff\xd8\xff\xe0" + b"\x00" * 16) is None
    assert uploads.sniff_audio(b"RIFF\x24\x00\x00\x00WEBPVP8 ") is None
    assert uploads.sniff_audio(b"RIFF\x24\x00\x00\x00WAVEfmt ") == "audio/wav"
