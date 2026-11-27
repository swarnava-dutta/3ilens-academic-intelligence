"""Rubric source files kept per intake (rubric_sources.py): the question paper and the separate
answer-key file an inline rubric_json was drafted from, sent with the intake's first POST /api/upload,
listed by GET /api/rubrics/{id}/sources and previewed by GET /api/rubrics/{id}/sources/{kind}/preview."""
from __future__ import annotations

import io
import json

import pymupdf
import pytest
from PIL import Image

from tests.test_api import genetics_rubric
from tests.test_reset_data import load_script

KEY_TEXT = "Answer key - NEET 2016 Code A\n1. (2)\n2. (4)\n3. (1)\n51. (2 or 3)\n71. Bonus\n"


@pytest.fixture
def ai_ready(monkeypatch):
    import ai

    monkeypatch.setattr(ai, "ai_readiness", lambda: (True, []))


@pytest.fixture
def queued(monkeypatch):
    import pipeline

    calls: list[tuple[tuple, dict]] = []
    monkeypatch.setattr(pipeline, "process_submission", lambda *args, **kwargs: calls.append((args, kwargs)))
    return calls


def paper_pdf(pages: int = 3) -> bytes:
    doc = pymupdf.open()
    for index in range(pages):
        doc.new_page().insert_text((72, 72), f"NEET 2016 question paper - page {index + 1}")
    data = doc.tobytes()
    doc.close()
    return data


def section_b() -> dict:
    content = genetics_rubric()
    return {**content, "name": "Biology - Genetics Section B",
            "questions": [q for q in content["questions"] if q["question"] != 5]}


def upload_with_sources(client, png_bytes, *, paper: tuple | None = None, key: tuple | None = None,
                        student_name: str = "Aarav Sharma", **form: str):
    """POST /api/upload with rubric_json (the Genetics key) unless rubric_id is given, plus the files."""
    data = {"student_name": student_name, **form}
    if "rubric_id" not in data:
        data.setdefault("rubric_json", json.dumps(genetics_rubric()))
    files = {"file": ("aarav_sheet.png", png_bytes, "image/png")}
    if paper is not None:
        files["rubric_source_file"] = paper
    if key is not None:
        files["rubric_key_file"] = key
    return client.post("/api/upload", data=data, files=files)


def sources_dir(tmp_path, rubric_id: int):
    return tmp_path / "artifacts" / "rubrics" / str(rubric_id)


def log_of(client, submission_id: int) -> list[str]:
    return [e["message"] for e in client.get(f"/api/results/{submission_id}").json()["processing_log"]]


def rubric_count(db_session) -> int:
    from sqlalchemy import func, select

    from database import Rubric

    return db_session.scalar(select(func.count()).select_from(Rubric))


# --------------------------------------------------------------------------- #
# Stored with the intake's first upload
# --------------------------------------------------------------------------- #
def test_first_upload_keeps_the_question_paper_and_key(client, fake_ai, png_bytes, tmp_path):
    response = upload_with_sources(
        client, png_bytes,
        paper=("neet_2016.pdf", paper_pdf(3), "application/pdf"),
        key=("key.txt", KEY_TEXT.encode(), "text/plain"),
    )
    assert response.status_code == 202, response.text
    rubric_id = response.json()["rubric_id"]

    listing = client.get(f"/api/rubrics/{rubric_id}/sources")
    assert listing.status_code == 200
    assert listing.json() == [
        {"kind": "paper", "role": "question_paper", "filename": "neet_2016.pdf", "file_type": "pdf", "pages": 3},
        {"kind": "key", "role": "answer_key", "filename": "key.txt", "file_type": "text", "pages": 1},
    ]
    folder = sources_dir(tmp_path, rubric_id)
    assert sorted(p.name for p in folder.iterdir()) == ["key.txt", "paper.pdf", "sources.json"]
    assert (folder / "paper.pdf").read_bytes().startswith(b"%PDF-")
    assert (folder / "key.txt").read_text(encoding="utf-8") == KEY_TEXT
    stored = json.loads((folder / "sources.json").read_text(encoding="utf-8"))
    assert stored[0] == {"kind": "paper", "role": "question_paper", "filename": "neet_2016.pdf",
                         "mime_type": "application/pdf", "file_type": "pdf", "pages": 3}
    assert stored[1]["mime_type"] == "text/plain"
    assert (
        "Answer key drafted from question paper neet_2016.pdf (PDF, 3 pages) and answer key key.txt (text, 1 page) "
        "- kept with rubric 'Biology - Genetics' (custom-1) for preview."
    ) in log_of(client, response.json()["id"])
    assert "rubric_source" not in response.text and str(tmp_path) not in response.text  # no paths leak


def test_later_uploads_of_the_intake_share_the_sources(client, fake_ai, png_bytes, tmp_path):
    first = upload_with_sources(client, png_bytes, paper=("paper.pdf", paper_pdf(2), "application/pdf"))
    rubric_id = first.json()["rubric_id"]
    # Files sent with rubric_id are ignored (not even checked): the snapshot keeps the first upload's.
    second = upload_with_sources(client, png_bytes, rubric_id=str(rubric_id), student_name="Diya Rao",
                                 paper=("other.pdf", b"%PDF-1.7 broken", "application/pdf"))
    assert second.status_code == 202, second.text
    assert second.json()["rubric_id"] == rubric_id
    assert [s["filename"] for s in client.get(f"/api/rubrics/{rubric_id}/sources").json()] == ["paper.pdf"]
    assert not any("Answer key drafted from" in m for m in log_of(client, second.json()["id"]))


def test_only_a_key_file(client, fake_ai, png_bytes):
    response = upload_with_sources(client, png_bytes, key=("key.png", png_bytes, "image/png"))
    assert response.status_code == 202, response.text
    assert client.get(f"/api/rubrics/{response.json()['rubric_id']}/sources").json() == [
        {"kind": "key", "role": "answer_key", "filename": "key.png", "file_type": "png", "pages": 1},
    ]


def test_a_rubric_without_sources(client, fake_ai, png_bytes, tmp_path):
    response = upload_with_sources(client, png_bytes)
    assert response.status_code == 202, response.text
    rubric_id = response.json()["rubric_id"]
    assert client.get(f"/api/rubrics/{rubric_id}/sources").json() == []
    assert not sources_dir(tmp_path, rubric_id).exists()
    missing = client.get(f"/api/rubrics/{rubric_id}/sources/paper/preview")
    assert missing.status_code == 404 and missing.json()["code"] == "no_source"
    assert missing.json()["detail"] == f"Rubric {rubric_id} has no question paper file to preview."


# --------------------------------------------------------------------------- #
# Checked like intake preview, before anything is saved
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "field, sent, status, code, prefix",
    [
        ("paper", ("paper.pdf", b"%PDF-1.7\n garbage", "application/pdf"), 422, "corrupt_pdf", "Question paper file: "),
        ("paper", ("paper.pdf", b"", "application/pdf"), 422, "empty_file", "Question paper file: "),
        ("key", ("key.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 64, "image/png"), 422, "corrupt_image",
         "Answer key file: "),
        ("key", ("key.wav", None, "audio/wav"), 415, "unsupported_signature", "Answer key file: "),
        ("key", ("key.bin", b"\x00\x01\x02binary", "application/octet-stream"), 415, "unsupported_signature",
         "Answer key file: "),
    ],
)
def test_a_bad_source_file_refuses_the_upload_before_saving(
    client, forbid_ai, png_bytes, wav_bytes, tmp_path, db_session, field, sent, status, code, prefix
):
    if sent[1] is None:
        sent = (sent[0], wav_bytes, sent[2])
    before = rubric_count(db_session)
    response = upload_with_sources(client, png_bytes, **{field: sent})
    assert response.status_code == status, response.text
    assert response.json()["code"] == code and response.json()["detail"].startswith(prefix)
    uploads_dir = tmp_path / "uploads"
    assert not uploads_dir.exists() or not any(uploads_dir.iterdir())
    assert not (tmp_path / "artifacts" / "rubrics").exists()
    assert rubric_count(db_session) == before and client.get("/api/submissions").json() == []


def test_a_password_protected_paper_is_refused(client, forbid_ai, png_bytes):
    from tests.test_paper_detect import _encrypted_pdf

    response = upload_with_sources(client, png_bytes, paper=("locked.pdf", _encrypted_pdf(), "application/pdf"))
    assert response.status_code == 422 and response.json()["code"] == "password_pdf"


def test_a_failed_upload_leaves_no_source_folder(client, fake_ai, png_bytes, tmp_path, db_session, monkeypatch):
    """The sources are written once the snapshot row exists; an error before the commit removes them."""
    import uploads

    def broken(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(uploads, "paper_notice", broken)
    before = rubric_count(db_session)
    response = upload_with_sources(client, png_bytes, paper=("paper.pdf", paper_pdf(1), "application/pdf"))
    assert response.status_code == 500
    folder = tmp_path / "artifacts" / "rubrics"
    assert not folder.exists() or not any(folder.iterdir())
    assert rubric_count(db_session) == before


# --------------------------------------------------------------------------- #
# Preview
# --------------------------------------------------------------------------- #
def test_preview_pages_of_the_kept_files(client, fake_ai, png_bytes):
    rubric_id = upload_with_sources(
        client, png_bytes, paper=("paper.pdf", paper_pdf(3), "application/pdf"),
        key=("key.txt", KEY_TEXT.encode(), "text/plain"),
    ).json()["rubric_id"]

    page = client.get(f"/api/rubrics/{rubric_id}/sources/paper/preview", params={"page": 2, "width": 300})
    assert page.status_code == 200, page.text
    assert page.headers["content-type"] == "image/png"
    assert page.headers["x-page-count"] == "3" and page.headers["x-file-type"] == "pdf"
    assert page.headers["cache-control"] == "no-store"
    image = Image.open(io.BytesIO(page.content))
    assert image.width == 300 and image.height > image.width

    default = client.get(f"/api/rubrics/{rubric_id}/sources/key/preview")
    assert default.status_code == 200 and default.headers["x-file-type"] == "text"
    assert Image.open(io.BytesIO(default.content)).width == 480

    too_far = client.get(f"/api/rubrics/{rubric_id}/sources/paper/preview", params={"page": 4})
    assert too_far.status_code == 422 and too_far.json()["code"] == "invalid_page"
    bad_width = client.get(f"/api/rubrics/{rubric_id}/sources/paper/preview", params={"width": "wide"})
    assert bad_width.status_code == 422 and bad_width.json()["code"] == "invalid_request"
    other = client.get(f"/api/rubrics/{rubric_id}/sources/marking/preview")
    assert other.status_code == 404 and other.json()["code"] == "no_source"


def test_unknown_rubric(client):
    for path in ("/api/rubrics/98765/sources", "/api/rubrics/98765/sources/paper/preview"):
        response = client.get(path)
        assert response.status_code == 404 and response.json()["code"] == "unknown_rubric"


def test_preview_headers_are_readable_cross_origin(client, fake_ai, png_bytes):
    rubric_id = upload_with_sources(client, png_bytes, paper=("paper.pdf", paper_pdf(1), "application/pdf")) \
        .json()["rubric_id"]
    response = client.get(f"/api/rubrics/{rubric_id}/sources/paper/preview",
                          headers={"Origin": "http://localhost:3000"})
    exposed = {h.strip().lower() for h in response.headers["access-control-expose-headers"].split(",")}
    assert {"x-page-count", "x-file-type"} <= exposed


def test_a_missing_file_is_not_listed(client, fake_ai, png_bytes, tmp_path):
    rubric_id = upload_with_sources(
        client, png_bytes, paper=("paper.pdf", paper_pdf(1), "application/pdf"),
        key=("key.txt", KEY_TEXT.encode(), "text/plain"),
    ).json()["rubric_id"]
    (sources_dir(tmp_path, rubric_id) / "paper.pdf").unlink()
    assert [s["kind"] for s in client.get(f"/api/rubrics/{rubric_id}/sources").json()] == ["key"]
    assert client.get(f"/api/rubrics/{rubric_id}/sources/paper/preview").json()["code"] == "no_source"
    (sources_dir(tmp_path, rubric_id) / "sources.json").write_text("not json", encoding="utf-8")
    assert client.get(f"/api/rubrics/{rubric_id}/sources").json() == []


# --------------------------------------------------------------------------- #
# Which snapshots keep the preview
# --------------------------------------------------------------------------- #
def test_a_key_drafted_for_a_regrade_gets_no_sources(client, fake_ai, png_bytes, ai_ready):
    """An inline key on /reevaluate comes from a newly uploaded question paper (report page), which
    is not stored: the earlier snapshot's files would preview the wrong paper, so none are copied."""
    sub = upload_with_sources(client, png_bytes, paper=("paper.pdf", paper_pdf(2), "application/pdf")).json()
    response = client.post(f"/api/submissions/{sub['id']}/reevaluate", json={"rubric": section_b()})
    assert response.status_code == 202, response.text
    drafted = response.json()["rubric_id"]
    assert drafted != sub["rubric_id"]
    assert client.get(f"/api/rubrics/{drafted}/sources").json() == []
    assert client.get(f"/api/rubrics/{drafted}/sources/paper/preview").json()["code"] == "no_source"
    # The original snapshot keeps its files.
    assert client.get(f"/api/rubrics/{sub['rubric_id']}/sources").json() == [
        {"kind": "paper", "role": "question_paper", "filename": "paper.pdf", "file_type": "pdf", "pages": 2},
    ]


def test_a_key_drafted_for_a_rerun_gets_no_sources(client, fake_ai, png_bytes, ai_ready, queued):
    sub = upload_with_sources(client, png_bytes, key=("key.txt", KEY_TEXT.encode(), "text/plain")).json()
    from database import SessionLocal, StudentSubmission

    with SessionLocal() as session:
        session.get(StudentSubmission, sub["id"]).status = "HUMAN_REVIEW_REQUIRED"
        session.commit()
    response = client.post(f"/api/submissions/{sub['id']}/rerun", json={"rubric": section_b()})
    assert response.status_code == 202, response.text
    assert client.get(f"/api/rubrics/{response.json()['rubric_id']}/sources").json() == []
    assert [s["kind"] for s in client.get(f"/api/rubrics/{sub['rubric_id']}/sources").json()] == ["key"]


def test_a_new_rubric_version_keeps_the_sources(client, fake_ai, png_bytes):
    rubric_id = upload_with_sources(client, png_bytes, paper=("paper.pdf", paper_pdf(1), "application/pdf")) \
        .json()["rubric_id"]
    created = client.post(f"/api/rubrics/{rubric_id}/versions", json={"content": section_b(), "reprocess": False})
    assert created.status_code == 201, created.text
    child = created.json()["rubric"]["id"]
    assert [s["filename"] for s in client.get(f"/api/rubrics/{child}/sources").json()] == ["paper.pdf"]


def test_a_refused_regrade_copies_nothing(client, fake_ai, png_bytes, tmp_path, db_session):
    """AI not configured: 503, no snapshot row and no copied sources."""
    sub = upload_with_sources(client, png_bytes, paper=("paper.pdf", paper_pdf(1), "application/pdf")).json()
    before = rubric_count(db_session)
    response = client.post(f"/api/submissions/{sub['id']}/reevaluate", json={"rubric": section_b()})
    assert response.status_code == 503
    assert rubric_count(db_session) == before
    assert [p.name for p in (tmp_path / "artifacts" / "rubrics").iterdir()] == [str(sub["rubric_id"])]


# --------------------------------------------------------------------------- #
# Reset
# --------------------------------------------------------------------------- #
def test_reset_moves_the_rubric_sources_with_the_artifacts(tmp_path):
    reset_data = load_script()
    root = tmp_path / "root"
    kept = root / "artifacts" / "rubrics" / "1"
    kept.mkdir(parents=True)
    (kept / "paper.pdf").write_bytes(paper_pdf(1))
    (root / "artifacts" / ".gitkeep").write_text("", encoding="utf-8")
    moved = reset_data.files_to_move(root)
    assert root / "artifacts" / "rubrics" in moved["artifacts"]
    assert root / "artifacts" / ".gitkeep" not in moved["artifacts"]


# --------------------------------------------------------------------------- #
# Roles, UTF-16 keys, one 415 wording, preview cache (review fixes)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("sent", "role", "logged"),
    [
        (None, "question_paper", "question paper rubric.txt"),
        ("rubric_file", "rubric_file", "rubric file rubric.txt"),
        ("Marked copy", "marked_copy", "marked copy rubric.txt"),
        ("marked-copy", "marked_copy", "marked copy rubric.txt"),
        ("banana", "question_paper", "question paper rubric.txt"),  # unknown: ignored, never refused
        ("answer_key", "answer_key", "answer key rubric.txt"),  # a key-only file sent as the only source
    ],
)
def test_the_paper_file_keeps_its_role(client, fake_ai, png_bytes, tmp_path, sent, role, logged):
    form = {"rubric_source_role": sent} if sent is not None else {}
    response = upload_with_sources(client, png_bytes, paper=("rubric.txt", b'{"name": "Genetics"}', "text/plain"),
                                   key=("key.txt", KEY_TEXT.encode(), "text/plain"), **form)
    assert response.status_code == 202, response.text
    rubric_id = response.json()["rubric_id"]
    listing = client.get(f"/api/rubrics/{rubric_id}/sources").json()
    assert [(s["kind"], s["role"]) for s in listing] == [("paper", role), ("key", "answer_key")]
    stored = json.loads((sources_dir(tmp_path, rubric_id) / "sources.json").read_text(encoding="utf-8"))
    assert [s["role"] for s in stored] == [role, "answer_key"]
    assert any(f"Answer key drafted from {logged} (text, 1 page) and answer key key.txt" in m
               for m in log_of(client, response.json()["id"]))


def test_entries_kept_before_roles_are_labelled_by_kind_and_versions_keep_the_role(client, fake_ai, png_bytes,
                                                                                  tmp_path):
    rubric_id = upload_with_sources(client, png_bytes, paper=("marked.pdf", paper_pdf(1), "application/pdf"),
                                    key=("key.txt", KEY_TEXT.encode(), "text/plain"),
                                    rubric_source_role="marked_copy").json()["rubric_id"]
    created = client.post(f"/api/rubrics/{rubric_id}/versions", json={"content": section_b(), "reprocess": False})
    child = created.json()["rubric"]["id"]
    assert [s["role"] for s in client.get(f"/api/rubrics/{child}/sources").json()] == ["marked_copy", "answer_key"]

    sources_json = sources_dir(tmp_path, rubric_id) / "sources.json"
    old = [{k: v for k, v in e.items() if k != "role"} for e in json.loads(sources_json.read_text(encoding="utf-8"))]
    sources_json.write_text(json.dumps(old), encoding="utf-8")
    assert [s["role"] for s in client.get(f"/api/rubrics/{rubric_id}/sources").json()] == [
        "question_paper", "answer_key"]


@pytest.mark.parametrize("codec", ["utf-16", "utf-16-be"])
def test_a_utf16_key_file_is_kept_with_the_question_paper(client, fake_ai, png_bytes, codec):
    """A UTF-16 text key (FF FE / FE FF byte-order mark) was refused as audio (415), and the frontend's
    retry then dropped the question paper too."""
    data = ("\ufeff" + KEY_TEXT).encode(codec) if codec == "utf-16-be" else KEY_TEXT.encode(codec)
    assert data[:2] in (b"\xff\xfe", b"\xfe\xff")
    response = upload_with_sources(client, png_bytes, paper=("paper.pdf", paper_pdf(2), "application/pdf"),
                                   key=("key.txt", data, "text/plain"))
    assert response.status_code == 202, response.text
    rubric_id = response.json()["rubric_id"]
    listing = client.get(f"/api/rubrics/{rubric_id}/sources").json()
    assert [(s["kind"], s["file_type"]) for s in listing] == [("paper", "pdf"), ("key", "text")]
    preview = client.get(f"/api/rubrics/{rubric_id}/sources/key/preview")
    assert preview.status_code == 200 and preview.headers["x-file-type"] == "text"


@pytest.mark.parametrize(
    ("field", "name", "body", "code"),
    [
        ("paper", "paper.docm", "docm", "macro_docx"),
        ("paper", "paper.zip", "zip", "unsupported_signature"),
        ("key", "key.wav", "wav", "unsupported_signature"),
        ("key", "key.bin", "binary", "unsupported_signature"),
        ("key", "key.txt", "latin1", "unsupported_signature"),
    ],
)
def test_every_unsupported_source_file_reads_the_same(client, forbid_ai, png_bytes, wav_bytes, field, name, body,
                                                      code):
    import rubric_sources
    from tests.test_docx import DOCM_MAIN, make_docx
    from tests.test_preview import _plain_zip

    content = {
        "docm": lambda: make_docx(main_type=DOCM_MAIN, extra_entries={"word/vbaProject.bin": b"\x00" * 32}),
        "zip": _plain_zip,
        "wav": lambda: wav_bytes,
        "binary": lambda: b"\x00\x01\x02binary",
        "latin1": lambda: b"caf\xe9 (Latin-1, not UTF-8)",
    }[body]()
    response = upload_with_sources(client, png_bytes, **{field: (name, content, "application/octet-stream")})
    assert response.status_code == 415, response.text
    label = rubric_sources.LABELS[field]
    assert response.json() == {"detail": f"{label}: {rubric_sources.UNSUPPORTED_DETAIL}", "code": code}


def test_rendered_previews_are_cached_next_to_the_sources(client, fake_ai, png_bytes, tmp_path, monkeypatch):
    from routers import preview_routes

    rubric_id = upload_with_sources(
        client, png_bytes, paper=("paper.pdf", paper_pdf(3), "application/pdf"),
        key=("key.png", png_bytes, "image/png"),
    ).json()["rubric_id"]
    url = f"/api/rubrics/{rubric_id}/sources"
    first = client.get(f"{url}/paper/preview", params={"page": 2, "width": 300})
    key = client.get(f"{url}/key/preview", params={"width": 200})
    assert first.status_code == 200 and key.status_code == 200
    previews = sources_dir(tmp_path, rubric_id) / "previews"
    assert sorted(p.name for p in previews.iterdir()) == ["key-p1-w200.jpg", "paper-p2-w300.png"]

    renders: list[tuple[int, int]] = []
    real_render = preview_routes.render

    def counting(data, page, width):
        renders.append((page, width))
        return real_render(data, page, width)

    monkeypatch.setattr(preview_routes, "render", counting)
    again = client.get(f"{url}/paper/preview", params={"page": 2, "width": 300})
    assert again.status_code == 200 and again.content == first.content and renders == []
    assert (again.headers["x-page-count"], again.headers["x-file-type"], again.headers["content-type"]) == (
        "3", "pdf", "image/png")
    key_again = client.get(f"{url}/key/preview", params={"width": 200})
    assert key_again.headers["content-type"] == "image/jpeg" and key_again.headers["x-file-type"] == "png"
    assert client.get(f"{url}/paper/preview", params={"page": 3, "width": 300}).status_code == 200
    assert renders == [(3, 300)]  # a page not seen before is rendered (and cached)
    assert client.get(f"{url}/paper/preview", params={"page": 9}).json()["code"] == "invalid_page"
    assert not any("p9" in p.name for p in previews.iterdir())
    # the cache never shows up as a source, and a new version renders its own
    assert [s["kind"] for s in client.get(url).json()] == ["paper", "key"]
    child = client.post(f"/api/rubrics/{rubric_id}/versions", json={"content": section_b(), "reprocess": False}) \
        .json()["rubric"]["id"]
    assert not (sources_dir(tmp_path, child) / "previews").exists()


def test_a_cache_that_cannot_be_written_still_serves_the_page(client, fake_ai, png_bytes, monkeypatch):
    import rubric_sources

    rubric_id = upload_with_sources(client, png_bytes, paper=("paper.pdf", paper_pdf(1), "application/pdf")) \
        .json()["rubric_id"]

    def broken(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(rubric_sources.os, "replace", broken)
    response = client.get(f"/api/rubrics/{rubric_id}/sources/paper/preview")
    assert response.status_code == 200 and response.headers["content-type"] == "image/png"
