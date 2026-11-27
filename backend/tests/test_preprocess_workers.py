"""Pre-processing pages on PREPROCESS_WORKERS threads, and the tick reader's re-encode on the same
number: the same bytes, the same artifacts and the same log as one page at a time."""
from __future__ import annotations

import sys
import threading
from pathlib import Path

import pymupdf
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import config  # noqa: E402
import mcq_marks  # noqa: E402
import preprocessing  # noqa: E402
from ai_schemas import PreparedPage  # noqa: E402


def _paper(path: Path, pages: int = 7) -> Path:
    """A printed-paper-like PDF: numbered questions, options and a tick drawn on each page."""
    doc = pymupdf.open()
    for n in range(pages):
        page = doc.new_page()
        for line in range(12):
            page.insert_text((60, 70 + 52 * line), f"{n * 12 + line + 1}. A body of mass {line + 2} kg moves on a "
                                                   "rough horizontal surface with a speed of", fontsize=10)
            page.insert_text((80, 86 + 52 * line), "(1) 2 m/s   (2) 4 m/s   (3) 6 m/s   (4) 8 m/s", fontsize=10)
        page.draw_polyline([(150 + 8 * n, 92), (156 + 8 * n, 100), (170 + 8 * n, 80)], color=(0.1, 0.2, 0.8), width=2)
    doc.save(path)
    doc.close()
    return path


def _run(source: Path, out: Path, monkeypatch, workers: int):
    monkeypatch.setenv("PREPROCESS_WORKERS", str(workers))
    log: list[tuple[str, int]] = []
    pages = preprocessing.preprocess_document(source, "application/pdf", out,
                                              lambda m: log.append((m, threading.get_ident())))
    files = {p.name: p.read_bytes() for p in sorted(out.iterdir())}
    return pages, files, log


def test_pages_on_threads_are_byte_identical_and_logged_in_order(tmp_path, monkeypatch):
    source = _paper(tmp_path / "paper.pdf")
    one, one_files, one_log = _run(source, tmp_path / "w1", monkeypatch, 1)
    four, four_files, four_log = _run(source, tmp_path / "w4", monkeypatch, 4)

    assert [p.page_number for p in four] == list(range(1, 8))
    assert [(p.media_type, p.data) for p in four] == [(p.media_type, p.data) for p in one]
    assert four_files == one_files and len(four_files) == 14  # page_n + page_n_original
    assert [m for m, _t in four_log] == [m for m, _t in one_log]
    assert {t for _m, t in four_log} == {threading.get_ident()}  # log() only on the calling thread
    assert [m.split(":")[0] for m, _t in four_log if m.startswith("Page ")] == [f"Page {n}/7" for n in range(1, 8)]

    ticks_one = mcq_marks._model_pages(one, 1)
    ticks_four = mcq_marks._model_pages(one, 4)
    assert [(t.page_number, t.media_type, t.data) for t in ticks_four] == [
        (t.page_number, t.media_type, t.data) for t in ticks_one]


def test_at_most_twice_the_workers_rendered_pages_wait(tmp_path, monkeypatch):
    source = _paper(tmp_path / "paper.pdf", pages=9)
    original = preprocessing._render_pdf_pages
    log: list[str] = []
    ahead: list[int] = []

    def rendering(document, dpi):
        for index, item in enumerate(original(document, dpi)):
            ahead.append(index - (len(log) - 1))  # pages rendered before this one, minus pages done
            yield item

    monkeypatch.setattr(preprocessing, "_render_pdf_pages", rendering)
    monkeypatch.setenv("PREPROCESS_WORKERS", "2")
    pages = preprocessing.preprocess_document(source, "application/pdf", tmp_path / "out", log.append)
    assert len(pages) == 9 and max(ahead) <= 2 * 2


def test_a_failing_page_fails_the_document_after_the_pages_before_it(tmp_path, monkeypatch):
    source = _paper(tmp_path / "paper.pdf", pages=6)
    write = preprocessing._write

    def failing(path, data):
        if path.name.startswith("page_3."):
            raise preprocessing.PreprocessingError("Could not save page 3.")
        write(path, data)

    monkeypatch.setattr(preprocessing, "_write", failing)
    monkeypatch.setenv("PREPROCESS_WORKERS", "3")
    log: list[str] = []
    with pytest.raises(preprocessing.PreprocessingError, match="page 3"):
        preprocessing.preprocess_document(source, "application/pdf", tmp_path / "out", log.append)
    assert [m.split(":")[0] for m in log if m.startswith("Page ")] == ["Page 1/6", "Page 2/6"]
    written = sorted(p.name for p in (tmp_path / "out").iterdir())
    assert "page_3.png" not in written and "page_1.png" in written


def test_one_worker_and_one_page_run_inline(tmp_path, monkeypatch):
    def no_pool(*_args, **_kwargs):
        raise AssertionError("no thread pool for a single page / one worker")

    monkeypatch.setattr(preprocessing, "_prepare_parallel", no_pool)
    monkeypatch.setenv("PREPROCESS_WORKERS", "8")
    one_page = _paper(tmp_path / "one.pdf", pages=1)
    assert len(preprocessing.preprocess_document(one_page, "application/pdf", tmp_path / "a", lambda m: None)) == 1
    monkeypatch.setenv("PREPROCESS_WORKERS", "1")
    assert len(preprocessing.preprocess_document(_paper(tmp_path / "three.pdf", pages=3), "application/pdf",
                                                 tmp_path / "b", lambda m: None)) == 3


def test_the_reader_reencode_keeps_order_and_undecodable_pages(monkeypatch):
    from PIL import Image
    import io

    def png(width: int) -> bytes:
        buffer = io.BytesIO()
        Image.new("RGB", (width, width * 2), (200, 200 - width % 50, 255)).save(buffer, "PNG")
        return buffer.getvalue()

    pages = [PreparedPage(page_number=n, media_type="image/png", data=png(900 + 150 * n), path=None) for n in range(1, 6)]
    pages.insert(2, PreparedPage(page_number=99, media_type="image/png", data=b"not an image", path=None))
    out = mcq_marks._model_pages(pages, 4)
    assert [p.page_number for p in out] == [1, 2, 99, 3, 4, 5]
    assert out[2].data == b"not an image"
    assert all(p.media_type == "image/jpeg" for i, p in enumerate(out) if i != 2)
    assert [p.data for p in out] == [p.data for p in mcq_marks._model_pages(pages, 1)]


@pytest.mark.parametrize(("value", "workers"), [(None, 4), ("1", 1), ("0", 1), ("6", 6), ("99", 8), ("x", 4)])
def test_preprocess_workers_setting(monkeypatch, value, workers):
    if value is None:
        monkeypatch.delenv("PREPROCESS_WORKERS", raising=False)
    else:
        monkeypatch.setenv("PREPROCESS_WORKERS", value)
    assert config.get_settings().preprocess_workers == workers


def test_typed_text_path_setting(monkeypatch):
    monkeypatch.delenv("TYPED_TEXT_PATH", raising=False)
    assert config.get_settings().typed_text_path is True
    monkeypatch.setenv("TYPED_TEXT_PATH", "0")
    assert config.get_settings().typed_text_path is False
