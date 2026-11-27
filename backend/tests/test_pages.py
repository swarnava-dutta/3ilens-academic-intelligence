"""Page images (FR-2.3 viewer) with REAL pre-processing (only the AI calls are faked): listing,
processed vs original, lazy rendering for sheets that never reached pre-processing, path safety."""
from __future__ import annotations

import io

import pytest
from PIL import Image

from tests.conftest import FakeAI
from tests.test_preprocessing import text_page


@pytest.fixture
def real_preprocessing(monkeypatch) -> FakeAI:
    """Real preprocessing.preprocess_document; fake OCR and grading."""
    import ai

    fake = FakeAI()
    monkeypatch.setattr(ai, "run_ocr", fake.run_ocr)
    monkeypatch.setattr(ai, "run_evaluation", fake.run_evaluation)
    return fake


def png_of(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def test_pages_list_processed_and_original_images(upload, real_preprocessing, client, make_pdf):
    sub = upload(filename="two.pdf", content=make_pdf(2)).json()
    result = client.get(f"/api/results/{sub['id']}").json()
    assert result["submission"]["status"] == "COMPLETED"
    log = [e["message"] for e in result["processing_log"]]
    assert any("rendered at 300 DPI (2480x35" in m and "sent 1414x2000 to the vision model" in m for m in log)
    assert not any("Simulating" in m for m in log)

    pages = client.get(f"/api/submissions/{sub['id']}/pages").json()
    assert [p["page_number"] for p in pages] == [1, 2]
    first = pages[0]
    assert first["url"] == f"/api/submissions/{sub['id']}/pages/1?variant=processed"
    assert first["original_url"] == f"/api/submissions/{sub['id']}/pages/1?variant=original"
    assert first["media_type"] == "image/png" and (first["width"], first["height"]) == (1414, 2000)

    processed = client.get(first["url"])
    original = client.get(first["original_url"])
    assert processed.status_code == 200 and original.status_code == 200
    assert processed.headers["content-type"] == "image/png" and processed.headers["cache-control"] == "no-store"
    assert processed.content != original.content
    assert Image.open(io.BytesIO(processed.content)).size == (1414, 2000)
    assert "artifacts" not in client.get(f"/api/submissions/{sub['id']}/pages").text  # no internal paths


@pytest.mark.parametrize(
    "path",
    ["3", "0", "-1", "1.png", "page_1", "..", "..%2F..%2Fuploads", "%2E%2E%2Fdead_letter.json", "1%00", "99999"],
)
def test_page_paths_cannot_escape_the_artifact_folder(upload, real_preprocessing, client, make_pdf, path):
    sub = upload(filename="two.pdf", content=make_pdf(2)).json()
    response = client.get(f"/api/submissions/{sub['id']}/pages/{path}")
    # ".." is normalised by the client to /api/submissions/{id}, which only has PATCH (rename): 405.
    # Either way no file is ever served.
    assert response.status_code in (404, 405)
    assert not response.headers.get("content-type", "").startswith("image/")


def test_page_variant_is_validated(upload, real_preprocessing, client, make_pdf):
    sub = upload(filename="one.pdf", content=make_pdf(1)).json()
    assert client.get(f"/api/submissions/{sub['id']}/pages/1", params={"variant": "secret"}).status_code == 422
    other = upload(filename="other.pdf", content=make_pdf(1)).json()
    # Each submission only serves its own folder.
    assert client.get(f"/api/submissions/{other['id']}/pages/1").content != b""
    assert client.get("/api/submissions/987654/pages/1").status_code == 404
    assert client.get("/api/submissions/987654/pages").status_code == 404


def test_blurry_sheet_pages_are_rendered_lazily_without_ai(upload, forbid_ai, client, tmp_path):
    sub = upload(filename="blurry_scan.png", content=png_of(text_page(size=(900, 1200)))).json()
    job_dir = tmp_path / "artifacts" / str(sub["id"])
    assert not job_dir.exists() or not any(job_dir.iterdir())  # nothing until a viewer asks

    pages = client.get(f"/api/submissions/{sub['id']}/pages").json()
    assert len(pages) == 1 and pages[0]["original_url"] is None
    assert client.get(pages[0]["url"]).status_code == 200
    assert client.get(f"/api/submissions/{sub['id']}/pages/1", params={"variant": "original"}).status_code == 404
    assert forbid_ai == []


def test_demo_rows_have_no_pages(demo_data, client):
    client.post("/api/demo/seed")
    sub = client.get("/api/submissions").json()[0]
    assert client.get(f"/api/submissions/{sub['id']}/pages").json() == []


def test_skewed_photo_is_deskewed_end_to_end(upload, real_preprocessing, client):
    skewed = text_page(seed=11).rotate(4.0, resample=Image.Resampling.BICUBIC, expand=False, fillcolor=(255, 255, 255))
    sub = upload(filename="photo.png", content=png_of(skewed)).json()
    log = [e["message"] for e in client.get(f"/api/results/{sub['id']}").json()["processing_log"]]
    assert any("deskewed -4.0 deg" in m for m in log)


@pytest.fixture(autouse=True)
def _master_dpi_300(monkeypatch):
    """These tests pin the 300 DPI master geometry; the shipped default is 200 (printed papers)."""
    monkeypatch.setenv("PDF_MASTER_DPI", "300")
