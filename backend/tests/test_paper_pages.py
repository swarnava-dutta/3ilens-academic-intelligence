"""Full printed papers as a rubric source (FR-3.4): page rendering (paper_pages), the paged draft
(ai.parse_rubric_pages) and the /api/rubrics/parse routing. Offline: the Anthropic client is a
fake injected through ai._anthropic_client, or ai.parse_rubric / ai.parse_rubric_pages are faked."""
from __future__ import annotations

import io
import json
import random
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import anthropic
import httpx2
import pytest
from PIL import Image

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import ai  # noqa: E402
import paper_pages  # noqa: E402
from ai import AIServiceError  # noqa: E402
from ai_schemas import ModelUsage  # noqa: E402
from tests.conftest import PagedClaude, page_labels, use_claude  # noqa: E402
from tests.test_contract import check_interface  # noqa: E402

TEST_KEY = "sk-ant-test-paper-pages-0000"
REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


@pytest.fixture(autouse=True)
def paper_env(monkeypatch, no_network_clients):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-5-5")
    monkeypatch.setenv("RUBRIC_PAGES_PER_CALL", "2")
    monkeypatch.setenv("AI_CHUNK_CONCURRENCY", "3")


def _pages(n: int) -> list[paper_pages.PageImage]:
    return [paper_pages.PageImage(i, "image/jpeg", f"page-{i}".encode(), 1240, 1754) for i in range(1, n + 1)]


def mcq(number: int, correct: str | None, *, prompt: str = "", subject: str = "Physics") -> dict[str, Any]:
    letter = {"1": "A", "2": "B", "3": "C", "4": "D"}.get(str(correct), correct)
    return {
        "question": number, "topic": "Ray Optics", "subject": subject, "chapter": "Ray Optics and Optical Instruments",
        "max_marks": 4, "prompt": prompt or f"Question {number} text", "expected_answer":
        f"Option {letter}: x" if correct else "", "grading_criteria": [f"4 marks: option {letter}"] if correct else [],
        "effort_hours": 2, "ai_drafted_answer": False, "question_type": "mcq", "options": ["a", "b", "c", "d"],
        "correct_option": correct, "bloom_level": "K3",
    }


def _reply(payload: dict | None = None, *, stop_reason: str = "end_turn"):
    content = [SimpleNamespace(type="text", text=json.dumps(payload))] if payload is not None else []
    return SimpleNamespace(
        content=content, stop_reason=stop_reason,
        stop_details=SimpleNamespace(category="other") if stop_reason == "refusal" else None,
        model="claude-sonnet-5-5", usage=SimpleNamespace(input_tokens=3000, output_tokens=900, iterations=None),
        _request_id="req_pages",
    )


def chunk(questions: list[dict[str, Any]], *, name: str = "", answer_key: list[dict[str, Any]] | None = None):
    return _reply({"name": name, "subject": "Physics", "questions": questions, "answer_key": answer_key or []})


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #
def test_render_pdf_pages_gives_one_jpeg_per_page(make_pdf):
    pages = paper_pages.render_pdf_pages(make_pdf(3))
    assert [p.page_number for p in pages] == [1, 2, 3]
    for page in pages:
        assert page.media_type == "image/jpeg" and page.data.startswith(b"\xff\xd8")
        assert max(page.width, page.height) <= paper_pages.MAX_LONG_EDGE_PX
        assert len(page.data) <= paper_pages.MAX_PAGE_BYTES
    assert paper_pages.page_count(make_pdf(4)) == 4


def test_render_caps_the_long_edge():
    import pymupdf

    doc = pymupdf.open()
    doc.new_page(width=1200, height=1700)  # larger than A4: 150 DPI would exceed the cap
    data = doc.tobytes()
    doc.close()
    (page,) = paper_pages.render_pdf_pages(data)
    assert max(page.width, page.height) <= paper_pages.MAX_LONG_EDGE_PX


@pytest.mark.parametrize("data", [b"%PDF-1.7 not really a pdf", b"garbage"])
def test_render_rejects_a_corrupt_pdf(data):
    with pytest.raises(paper_pages.PaperPagesError) as excinfo:
        paper_pages.render_pdf_pages(data)
    assert excinfo.value.code == "corrupt_pdf"


def test_encode_page_scales_down_to_the_byte_budget():
    rng = random.Random(7)
    noise = Image.frombytes("RGB", (900, 1200), bytes(rng.getrandbits(8) for _ in range(900 * 1200 * 3)))
    data, media_type, size = paper_pages.encode_page(noise, 60_000)
    assert media_type == "image/jpeg" and len(data) <= 60_000 and size[0] < 900
    assert Image.open(io.BytesIO(data)).size == size


# --------------------------------------------------------------------------- #
# ai.parse_rubric_pages
# --------------------------------------------------------------------------- #
def test_paged_draft_merges_chunks_by_question_number(monkeypatch):
    def reply(pages, _attempt):
        if pages == [1, 2]:
            # Q2 runs onto page 3: this reply has a truncated stem, the next chunk the whole question
            return chunk([mcq(1, "2"), mcq(2, None, prompt="A longer version")], name="FINAL NEET(UG)-2025 Physics")
        if pages == [3, 4]:
            return chunk([mcq(2, "3", prompt="A longer version of question two"), mcq(3, None), mcq(4, "1")])
        return chunk([mcq(6, "4")], answer_key=[{"question": 3, "option": "4"}, {"question": 4, "option": "2"}])

    fake = use_claude(monkeypatch, PagedClaude(reply))
    caller = threading.get_ident()
    usage_threads: list[int] = []
    usages: list[ModelUsage] = []

    def on_usage(usage: ModelUsage) -> None:
        usage_threads.append(threading.get_ident())
        usages.append(usage)

    result = ai.parse_rubric_pages(_pages(5), exam_hint="NEET", on_usage=on_usage)

    assert sorted(page_labels(c)[0] for c in fake.calls) == [1, 3, 5]
    systems = {c["system"] for c in fake.calls}
    assert len(systems) == 1 and next(iter(systems)).endswith(ai.RUBRIC_PAGES_ADDENDUM)
    first = next(c for c in fake.calls if page_labels(c) == [1, 2])
    instruction = first["messages"][0]["content"][-1]["text"]
    assert instruction.startswith("These are pages 1-2 of a 5-page paper, followed by page 3 as context only.")
    assert "never return a question that starts on page 3" in instruction and "Exam: NEET." in instruction
    labels = [c["text"] for c in first["messages"][0]["content"] if c["type"] == "text"][:-1]
    assert labels == ["Page 1 of 5:", "Page 2 of 5:", ai.RUBRIC_CONTEXT_LABEL.format(page=3, total=5)]
    assert len([c for c in first["messages"][0]["content"] if c["type"] == "image"]) == 3
    last = next(c for c in fake.calls if page_labels(c) == [5])
    assert "context only" not in last["messages"][0]["content"][-1]["text"]  # no page after the last one
    assert sorted(u.image_count for u in usages) == [1, 3, 3]  # the context page is counted
    assert first["output_config"]["effort"] == ai.RUBRIC_PAGES_EFFORT == "medium"
    assert first["output_config"]["format"]["schema"]["title"] == "RubricPages"
    assert len(usages) == 3 and set(usage_threads) == {caller}
    assert all(u.purpose == "rubric_parse" for u in usages)

    draft = result["draft"]
    assert draft["name"] == "FINAL NEET(UG)-2025 Physics"
    by_number = {q["question"]: q for q in draft["questions"]}
    assert sorted(by_number) == [1, 2, 3, 4, 6]
    assert by_number[1]["correct_option"] == "B"
    assert by_number[2]["correct_option"] == "C" and by_number[2]["prompt"] == "A longer version of question two"
    assert by_number[3]["correct_option"] == "D"  # filled from the answer-key table
    assert by_number[4]["correct_option"] == "A"  # the option under the question wins over the table
    warnings = result["warnings"]
    assert warnings[0] == "Read 5 pages in 3 AI calls; 5 questions; answer key found for 5 of 5 MCQs."
    assert "Question numbers missing from the sequence: Q5 - check those pages." in warnings
    assert "Answer key for Q3 taken from the answer-key table." in warnings
    assert (
        "The answer-key table disagrees with the option marked under Q4 (table B, under the question A) - the "
        "option under the question was kept; check before approving."
    ) in warnings
    assert not any(w.startswith("Fix before saving") for w in warnings)
    assert not any("more than once with different text" in w for w in warnings)


def test_a_failed_chunk_is_reported_and_the_rest_kept(monkeypatch):
    def reply(pages, _attempt):
        if pages == [3, 4]:
            return _reply(stop_reason="refusal")
        if pages == [1, 2]:
            return chunk([mcq(1, None), mcq(2, None)])
        return chunk([mcq(9, "1")])

    use_claude(monkeypatch, PagedClaude(reply))
    result = ai.parse_rubric_pages(_pages(5))
    warnings = result["warnings"]
    # MCQs without a key cannot be saved yet: the contract puts "Fix before saving" first
    assert warnings[0].startswith("Fix before saving: ")
    assert warnings[1] == "Read 5 pages in 3 AI calls; 3 questions; answer key found for 1 of 3 MCQs."
    assert (
        "Pages 3-4 could not be read (declined) - their questions are missing; add them by hand or draft again."
    ) in warnings
    assert "Question numbers missing from the sequence: Q3-Q8 - check those pages." in warnings
    assert "No answer key for Q1-Q2 (2 MCQs) - set correct_option before approving." in warnings
    assert not any(w.startswith("Q1 is an MCQ") for w in warnings)
    assert sum(w.startswith("Fix before saving") for w in warnings) == 1


def test_a_transient_error_is_retried_once(monkeypatch):
    def reply(pages, attempt):
        if attempt == 1:
            raise anthropic.APITimeoutError(request=REQUEST)
        return chunk([mcq(1, "1"), mcq(2, "2")])

    fake = use_claude(monkeypatch, PagedClaude(reply))
    usages: list[ModelUsage] = []
    result = ai.parse_rubric_pages(_pages(2), on_usage=usages.append)
    assert len(fake.calls) == 2
    assert [u.status for u in usages] == ["error", "ok"] and usages[0].error_code == "timeout"
    assert result["warnings"][0] == "Read 2 pages in 2 AI calls; 2 questions; answer key found for 2 of 2 MCQs."


def test_a_truncated_chunk_is_read_page_by_page(monkeypatch):
    def reply(pages, _attempt):
        if len(pages) == 2:
            return _reply({"name": ""}, stop_reason="max_tokens")
        return chunk([mcq(pages[0], "3")])

    fake = use_claude(monkeypatch, PagedClaude(reply))
    result = ai.parse_rubric_pages(_pages(2))
    assert sorted(tuple(page_labels(c)) for c in fake.calls) == [(1,), (1, 2), (2,)]
    single = next(c for c in fake.calls if page_labels(c) == [1])
    assert ai.RUBRIC_CONTEXT_LABEL.format(page=2, total=2) in [
        c["text"] for c in single["messages"][0]["content"] if c["type"] == "text"
    ]  # page 1 re-read alone still sees page 2 as context
    assert [q["question"] for q in result["draft"]["questions"]] == [1, 2]
    assert result["warnings"][0] == "Read 2 pages in 3 AI calls; 2 questions; answer key found for 2 of 2 MCQs."


def test_every_chunk_failing_raises_the_first_error(monkeypatch):
    use_claude(monkeypatch, PagedClaude(lambda pages, _attempt: _reply(stop_reason="refusal")))
    usages: list[ModelUsage] = []
    with pytest.raises(AIServiceError) as excinfo:
        ai.parse_rubric_pages(_pages(4), on_usage=usages.append)
    assert excinfo.value.code == "refusal"
    assert len(usages) == 2 and all(u.status == "refusal" for u in usages)


def test_missing_key_or_pages_fail_before_any_call(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    with pytest.raises(ai.AIConfigurationError):
        ai.parse_rubric_pages(_pages(3))
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    with pytest.raises(ValueError):
        ai.parse_rubric_pages([])


def test_a_full_180_question_paper_validates_with_a_short_warning_list(monkeypatch):
    subjects = {range(1, 46): "Physics", range(46, 91): "Chemistry", range(91, 181): "Biology"}

    def subject_of(n: int) -> str:
        return next(s for r, s in subjects.items() if n in r)

    def reply(pages, _attempt):
        numbers = [n for p in pages for n in range((p - 1) * 10 + 1, p * 10 + 1)]
        return chunk([{**mcq(n, str(n % 4 + 1), subject=subject_of(n)), "effort_hours": 0} for n in numbers],
                     name="NEET 2016" if pages[0] == 1 else "")

    use_claude(monkeypatch, PagedClaude(reply))
    result = ai.parse_rubric_pages(_pages(18))
    draft, warnings = result["draft"], result["warnings"]
    assert len(draft["questions"]) == 180 and draft["subject"] == "Mixed"
    assert warnings[0] == "Read 18 pages in 9 AI calls; 180 questions; answer key found for 180 of 180 MCQs."
    assert not any(w.startswith("Fix before saving") for w in warnings)
    assert len(warnings) <= 8, warnings
    assert warnings[-1] == "Total: 180 question(s), 720 marks."


def test_aggregation_keeps_single_warnings_as_written():
    lines = [
        "Q3 is an MCQ without an answer key - set correct_option.",
        "Q4: effort_hours defaulted to 2 h.",
        "Q5: effort_hours defaulted to 2 h.",
        "Q7: effort_hours defaulted to 2 h.",
        "Expected answers or criteria for Q1, Q2, Q3 were drafted by AI - review them before approving the rubric.",
        "Total: 7 question(s), 28 marks.",
    ]
    assert ai._aggregate_question_warnings(lines, [1, 2, 3]) == [
        "Q3 is an MCQ without an answer key - set correct_option.",
        "effort_hours defaulted to 2 h for Q4-Q5, Q7.",
        "Expected answers or criteria for Q1-Q3 were drafted by AI - review them before approving the rubric.",
        "Total: 7 question(s), 28 marks.",
    ]


# --------------------------------------------------------------------------- #
# POST /api/rubrics/parse routing
# --------------------------------------------------------------------------- #
DRAFT = ai.finalise_rubric_draft({"name": "Paper", "subject": "Physics", "questions": [mcq(1, "B")]})["draft"]


@pytest.fixture
def fake_parsers(monkeypatch):
    calls: dict[str, list[dict[str, Any]]] = {"pages": [], "single": []}

    def pages_parser(pages, **kwargs):
        calls["pages"].append({"pages": pages, **kwargs})
        return {"draft": DRAFT, "warnings": ["Read 3 pages in 2 AI calls; 1 question; answer key found for 1 of 1 MCQ."],
                "ai_drafted_questions": []}

    def single_parser(**kwargs):
        calls["single"].append(kwargs)
        return {"draft": DRAFT, "warnings": [], "ai_drafted_questions": []}

    monkeypatch.setattr(ai, "parse_rubric_pages", pages_parser)
    monkeypatch.setattr(ai, "parse_rubric", single_parser)
    return calls


def _parse(client, data: bytes, **form: str):
    return client.post("/api/rubrics/parse", data=form, files={"file": ("paper.pdf", data, "application/pdf")})


def test_a_pdf_of_three_or_more_pages_is_drafted_from_page_images(client, make_pdf, fake_parsers, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    response = _parse(client, make_pdf(3), subject="Physics", exam="NEET")
    assert response.status_code == 200, response.text
    body = response.json()
    check_interface(body, "RubricDraft")
    assert body["source"] == "pdf" and body["warnings"][0].startswith("Read 3 pages")
    assert fake_parsers["single"] == []
    (call,) = fake_parsers["pages"]
    assert [p.page_number for p in call["pages"]] == [1, 2, 3]
    assert all(p.media_type == "image/jpeg" for p in call["pages"])
    assert call["subject_hint"] == "Physics" and call["exam_hint"] == "NEET"


def test_a_short_pdf_keeps_the_single_call_path(client, make_pdf, fake_parsers, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    response = _parse(client, make_pdf(2))
    assert response.status_code == 200, response.text
    assert fake_parsers["pages"] == []
    (call,) = fake_parsers["single"]
    assert call["pdf_bytes"] is not None and call["text"] is None  # little text: sent as a scanned document


def test_paged_draft_needs_the_anthropic_key(client, make_pdf, fake_parsers, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    response = _parse(client, make_pdf(4))
    assert response.status_code == 503 and response.json()["code"] == "ai_not_configured"
    assert fake_parsers["pages"] == []


def test_paged_draft_maps_ai_errors(client, make_pdf, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)

    def failing(pages, **kwargs):
        kwargs["on_usage"](ModelUsage(purpose="rubric_parse", provider="anthropic", model_requested="claude-sonnet-5-5",
                                      status="refusal", error_code="refusal"))
        raise AIServiceError("Claude declined the rubric drafting request.", code="refusal")

    monkeypatch.setattr(ai, "parse_rubric_pages", failing)
    response = _parse(client, make_pdf(3))
    assert response.status_code == 502 and response.json()["code"] == "refusal"


# --------------------------------------------------------------------------- #
# key_source=marks: faculty confirm that the ticks on the paper mark the answer key
# --------------------------------------------------------------------------- #
def _text_pdf(pages: int) -> bytes:
    import pymupdf

    doc = pymupdf.open()
    for n in range(1, pages + 1):
        page = doc.new_page()
        page.insert_text((72, 72), f"{n}. Which lens forms a virtual image? (1) convex (2) concave (3) both (4) none " * 3)
    data = doc.tobytes()
    doc.close()
    return data


def test_marked_key_note_reaches_every_chunk_only_when_asked(monkeypatch):
    fake = use_claude(monkeypatch, PagedClaude(lambda pages, _attempt: chunk([mcq(pages[0], "2")])))
    ai.parse_rubric_pages(_pages(4), key_from_marks=True)
    instructions = [c["messages"][0]["content"][-1]["text"] for c in fake.calls]
    assert len(instructions) == 2 and all(ai.MARKED_KEY_NOTE in text for text in instructions)

    fake = use_claude(monkeypatch, PagedClaude(lambda pages, _attempt: chunk([mcq(pages[0], "2")])))
    ai.parse_rubric_pages(_pages(4))
    assert all(ai.MARKED_KEY_NOTE not in c["messages"][0]["content"][-1]["text"] for c in fake.calls)


def test_key_source_marks_is_passed_to_the_paged_draft(client, make_pdf, fake_parsers, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    assert _parse(client, make_pdf(3), key_source="marks").status_code == 200
    assert _parse(client, make_pdf(3)).status_code == 200
    assert [c["key_from_marks"] for c in fake_parsers["pages"]] == [True, False]


def test_key_source_marks_sends_a_short_text_pdf_as_page_images(client, fake_parsers, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    data = _text_pdf(2)
    assert _parse(client, data).status_code == 200
    assert _parse(client, data, key_source="MARKS").status_code == 200
    plain, marked = fake_parsers["single"]
    assert plain["text"] and plain["pdf_bytes"] is None and plain["key_from_marks"] is False
    assert marked["text"] is None and marked["pdf_bytes"] == data and marked["key_from_marks"] is True


def test_unknown_key_source_is_rejected(client, make_pdf, fake_parsers, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    response = _parse(client, make_pdf(3), key_source="guess")
    assert response.status_code == 422 and response.json()["code"] == "invalid_request"
    assert fake_parsers["pages"] == []


# --------------------------------------------------------------------------- #
# Review fixes: duplicate numbers, option positions, paged-path routing
# --------------------------------------------------------------------------- #
def test_a_question_number_returned_with_different_text_is_flagged(monkeypatch):
    siren = "A siren emitting a sound of frequency 800 Hz moves away from an observer towards a cliff"

    def reply(pages, _attempt):
        if pages == [1, 2]:
            return chunk([mcq(12, "2", prompt=siren), mcq(13, "1", prompt="Two identical charged spheres"),
                          mcq(47, "3", prompt="Which of the following is a diamagnetic material?")])
        return chunk([
            mcq(12, None, prompt=siren + " at 15 m/s. (1) 765 Hz (2) 800 Hz (3) 838 Hz (4) 885 Hz"),  # same, longer
            mcq(13, None, prompt="(3) 75% (4) 80%"),  # only the tail that ran onto the next page: unrelated text
            mcq(47, None, prompt="The pKa of acetic acid is 4.76; the pH of a 0.1 M buffer is"),
        ])

    use_claude(monkeypatch, PagedClaude(reply))
    warnings = ai.parse_rubric_pages(_pages(4))["warnings"]
    assert "Q13, Q47 appear more than once with different text - one was kept; check the numbering on those pages." \
        in warnings
    assert ai._same_question_text(siren, siren.upper() + " ...")
    assert ai._same_question_text("d2y/dx2 = (rho g / S) x", "d^2y/dx^2 = (rho g/S) x")
    assert ai._same_question_text("", "anything")
    assert not ai._same_question_text("Which lens forms a virtual image?", "Name the hormone released by the pancreas")


def test_one_flagged_number_reads_in_the_singular(monkeypatch):
    def reply(pages, _attempt):
        text = "Find the current in the circuit" if pages == [1, 2] else "Identify the product of ozonolysis"
        return chunk([mcq(5, "1", prompt=text)])

    use_claude(monkeypatch, PagedClaude(reply))
    warnings = ai.parse_rubric_pages(_pages(3))["warnings"]
    assert "Q5 appears more than once with different text - one was kept; check the numbering on those pages." \
        in warnings


def test_blank_options_keep_their_letters():
    draft = ai.finalise_rubric_draft({"name": "Paper", "questions": [
        {**mcq(1, "D"), "options": ["2 m/s", "", "4 m/s", ""]},
        {**mcq(2, "4"), "options": ["a", "b", "c", "   "]},
        {**mcq(3, "B"), "options": ["x", "y", "", ""]},
    ]})
    assert not any(w.startswith("Fix before saving") for w in draft["warnings"])
    q1, q2, q3 = draft["draft"]["questions"]
    assert q1["options"] == ["2 m/s", "(option B - not transcribed)", "4 m/s", "(option D - not transcribed)"]
    assert q1["correct_option"] == "D"
    assert q2["options"][3] == "(option D - not transcribed)" and q2["correct_option"] == "D"
    assert q3["options"] == ["x", "y"] and q3["correct_option"] == "B"  # trailing blanks after the key dropped


def _lines_pdf(pages: list[list[str]]) -> bytes:
    import pymupdf

    doc = pymupdf.open()
    for lines in pages:
        page = doc.new_page()
        page.insert_textbox(pymupdf.Rect(36, 36, 560, 800), "\n".join(lines), fontsize=9)
    data = doc.tobytes()
    doc.close()
    return data


def _scheme_pdf() -> bytes:
    """A typed descriptive marking scheme: numbered questions, no options, no answer markers."""
    pages = []
    for page in range(3):
        lines = []
        for n in range(page * 3 + 1, page * 3 + 4):
            lines += [f"{n}. Explain the process of photosynthesis in C4 plants and the role of the Calvin cycle.",
                      "Marking scheme: 2 marks for the light reactions, 2 marks for carbon fixation,",
                      "1 mark for naming the bundle-sheath cells. Accept a labelled diagram for full marks.", ""]
        pages.append(lines)
    return _lines_pdf(pages)


def _mcq_key_pdf() -> bytes:
    """A typed MCQ paper with "Ans. (n)" under each question."""
    pages = []
    for page in range(3):
        lines = []
        for n in range(page * 5 + 1, page * 5 + 6):
            lines += [f"{n}. A microscope has an objective of focal length 2 cm. The magnification is:",
                      "(1) 100", "(2) 125", "(3) 150", "(4) 250", "Ans. (2)", ""]
        pages.append(lines)
    return _lines_pdf(pages)


def test_a_typed_descriptive_scheme_keeps_the_single_text_call(client, fake_parsers, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    assert _parse(client, _scheme_pdf()).status_code == 200
    assert fake_parsers["pages"] == []
    (call,) = fake_parsers["single"]
    assert "photosynthesis" in call["text"] and call["pdf_bytes"] is None


def test_a_typed_mcq_paper_with_its_key_is_read_as_page_images(client, fake_parsers, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    assert _parse(client, _mcq_key_pdf()).status_code == 200
    assert fake_parsers["single"] == [] and len(fake_parsers["pages"]) == 1


def test_key_source_marks_reads_any_long_pdf_as_page_images(client, fake_parsers, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    assert _parse(client, _scheme_pdf(), key_source="marks").status_code == 200
    assert fake_parsers["single"] == [] and fake_parsers["pages"][0]["key_from_marks"] is True


def test_detection_failure_falls_back_to_page_images(client, fake_parsers, monkeypatch):
    import paper_detect

    def broken(*_args, **_kwargs):
        raise RuntimeError("detector bug")

    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    monkeypatch.setattr(paper_detect, "classify", broken)
    assert _parse(client, _scheme_pdf()).status_code == 200
    assert fake_parsers["single"] == [] and len(fake_parsers["pages"]) == 1



def test_a_pdf_with_text_on_only_its_cover_is_read_as_page_images(client, fake_parsers, monkeypatch):
    # a scan whose cover page carries a long typed text layer and whose other pages carry none
    cover = ["Instructions to candidates. " * 12] * 4
    data = _lines_pdf([cover, [""], [""], [""]])
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    assert _parse(client, data).status_code == 200
    assert fake_parsers["single"] == [] and len(fake_parsers["pages"]) == 1


def _lettered_mcq_pdf(questions: int, per_page: int = 12) -> bytes:
    """A long MCQ paper with options as "a)" lines and no answer key."""
    pages, lines = [], []
    for n in range(1, questions + 1):
        lines += [f"{n}. Which of the following statements about enzymes is correct?",
                  "a) one", "b) two", "c) three", "d) four", ""]
        if n % per_page == 0:
            pages.append(lines)
            lines = []
    if lines:
        pages.append(lines)
    return _lines_pdf(pages)


def test_a_long_mcq_paper_with_lettered_options_is_read_as_page_images(client, fake_parsers, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    assert _parse(client, _lettered_mcq_pdf(36)).status_code == 200
    assert fake_parsers["single"] == [] and len(fake_parsers["pages"]) == 1


def test_many_numbered_questions_in_an_unplaced_layout_are_paged(monkeypatch):
    from routers import analytics_routes
    from schemas import PaperInspection

    import paper_detect

    def unknown(*_args, **_kwargs):
        return PaperInspection(file_type="pdf", pages=4, text_layer=True, role="unknown", numbered_questions=30)

    monkeypatch.setattr(paper_detect, "classify", unknown)
    texts = ["x" * 300] * 4
    assert analytics_routes._paged_paper("text", texts, 4, False) is True
    monkeypatch.setattr(
        paper_detect, "classify",
        lambda *_a, **_k: PaperInspection(file_type="pdf", pages=4, text_layer=True, role="unknown",
                                          numbered_questions=29),
    )
    assert analytics_routes._paged_paper("text", texts, 4, False) is False


# --------------------------------------------------------------------------- #
# Two readings of one question merged field by field
# --------------------------------------------------------------------------- #
def test_a_key_only_continuation_fragment_keeps_the_full_question():
    full = mcq(5, None, prompt="A long question stem that started on page 2 and asks for the current")
    full["options"] = ["1 A", "2 A", "3 A", "4 A"]
    fragment = mcq(5, "4", prompt="")
    fragment["options"] = ["", ""]  # only the tail of the option list ran onto the next page
    clashes: dict[int, tuple[str, str]] = {}
    merged = ai._merge_entries(full, fragment, clashes)
    assert merged["prompt"] == full["prompt"] and merged["options"] == ["1 A", "2 A", "3 A", "4 A"]
    assert merged["correct_option"] == "4" and merged["expected_answer"].startswith("Option D")
    assert clashes == {}
    draft = ai.finalise_rubric_draft({"name": "P", "questions": [merged]})["draft"]
    (question,) = draft["questions"]
    assert question["correct_option"] == "D" and question["options"] == ["1 A", "2 A", "3 A", "4 A"]


def test_a_printed_marking_scheme_beats_an_ai_drafted_one():
    printed = {"question": 7, "topic": "Genetics", "subject": "Biology", "max_marks": 5, "prompt": "Explain",
               "expected_answer": "Printed model answer", "grading_criteria": ["2 marks: a", "3 marks: b"],
               "ai_drafted_answer": False, "question_type": "descriptive", "options": []}
    drafted = dict(printed, prompt="Explain a monohybrid cross with a Punnett square, showing the F2 ratio",
                   expected_answer="AI-written answer", grading_criteria=["5 marks: everything"],
                   ai_drafted_answer=True)
    merged = ai._merge_entries(printed, drafted)
    assert merged["prompt"] == drafted["prompt"]  # the fuller question text
    assert merged["expected_answer"] == "Printed model answer"
    assert merged["grading_criteria"] == ["2 marks: a", "3 marks: b"] and merged["ai_drafted_answer"] is False


def test_two_different_keys_for_one_question_are_reported(monkeypatch):
    def reply(pages, _attempt):
        if pages == [1, 2]:
            return chunk([mcq(1, "2"), mcq(2, "1")])
        return chunk([mcq(2, "3", prompt="Question 2 text")])

    use_claude(monkeypatch, PagedClaude(reply))
    result = ai.parse_rubric_pages(_pages(3))
    by_number = {q["question"]: q for q in result["draft"]["questions"]}
    assert by_number[2]["correct_option"] == "A"  # the first reading (page order) is kept
    assert (
        "Two different answer keys were read for Q2 (A and C) - the first was kept; check before approving."
    ) in result["warnings"]


def test_a_key_beyond_every_returned_option_adds_no_phantom_option():
    assert ai._positional_options(["2 m/s", "4 m/s"], "D") == ["2 m/s", "4 m/s"]
    assert ai._positional_options(["2 m/s", "", "4 m/s", ""], "D") == [
        "2 m/s", "(option B - not transcribed)", "4 m/s", "(option D - not transcribed)",
    ]
    result = ai.finalise_rubric_draft({"name": "P", "questions": [dict(mcq(1, "D"), options=["2 m/s", "4 m/s"])]})
    (question,) = result["draft"]["questions"]
    assert not question.get("correct_option")
    assert any("Q1" in w and ("answer key" in w or "correct_option" in w) for w in result["warnings"])


def test_an_answer_key_table_entry_that_does_not_fit_the_options_is_reported(monkeypatch):
    def reply(pages, _attempt):
        if pages == [1, 2]:
            return chunk([dict(mcq(5, None), options=["a", "b"])])
        return chunk([], answer_key=[{"question": 5, "option": "4"}])

    use_claude(monkeypatch, PagedClaude(reply))
    result = ai.parse_rubric_pages(_pages(3))
    assert (
        "Answer-key table entries for Q5 could not be matched to the options - set the key by hand."
    ) in result["warnings"]


# --------------------------------------------------------------------------- #
# Paper code on the paged draft; key_file on the paged path
# --------------------------------------------------------------------------- #
def test_the_printed_paper_code_lands_on_the_draft(monkeypatch):
    def reply(pages, _attempt):
        payload = {"name": "", "subject": "Physics", "questions": [mcq(pages[0], "2")], "answer_key": []}
        if pages == [3, 4]:
            payload["paper_code"] = "CODE - 45"
        elif pages == [5]:
            payload["paper_code"] = "Code 46"
        return _reply(payload)  # the first chunk's reply has no paper_code at all

    fake = use_claude(monkeypatch, PagedClaude(reply))
    result = ai.parse_rubric_pages(_pages(5))
    assert result["draft"]["paper_code"] == "Code 45"  # the first code in page order, normalised
    from schemas import RubricContentIn

    assert RubricContentIn.model_validate(result["draft"]).paper_code == "Code 45"
    schema = fake.calls[0]["output_config"]["format"]["schema"]
    assert "paper_code" in schema["properties"] and "paper_code" in schema["required"]
    assert "- paper_code: the paper code, set or version printed on these pages" in ai.RUBRIC_PAGES_ADDENDUM
    assert ai.RUBRIC_PAGES_PROMPT_VERSION == "rubric-pages-v3"


def test_no_printed_code_leaves_the_draft_without_one(monkeypatch):
    use_claude(monkeypatch, PagedClaude(lambda pages, _attempt: _reply(
        {"name": "", "subject": "Physics", "paper_code": "", "questions": [mcq(pages[0], "1")], "answer_key": []}
    )))
    assert "paper_code" not in ai.parse_rubric_pages(_pages(2))["draft"]


@pytest.mark.parametrize(
    "raw, label",
    [
        ("CODE - 45", "Code 45"), ("45", "Code 45"), ("code a", "Code A"), ("Set 2", "Set 2"), ("set b", "Set B"),
        ("A / P / W", "Code A/P/W"), ("Test Booklet Code: P", "Code P"), ("", None), ("none", None), (None, None),
        ([], None), (True, None),
    ],
)
def test_paper_code_label(raw, label):
    assert ai.paper_code_label(raw) == label


def test_key_file_is_applied_to_a_paged_draft(client, make_pdf, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    unkeyed = ai.finalise_rubric_draft({"name": "Paper", "subject": "Physics", "questions": [mcq(1, None), mcq(2, None)]})
    monkeypatch.setattr(ai, "parse_rubric_pages", lambda pages, **kwargs: {
        "draft": unkeyed["draft"], "warnings": unkeyed["warnings"], "ai_drafted_questions": [],
    })
    response = client.post(
        "/api/rubrics/parse",
        files={"file": ("paper.pdf", make_pdf(3), "application/pdf"), "key_file": ("key.txt", b"1. (3)\n2. (4)", "text/plain")},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    check_interface(body, "RubricDraft")
    assert body["warnings"][0] == "Answer key file: set 2 keys."
    assert [q["correct_option"] for q in body["draft"]["questions"]] == ["C", "D"]
    assert [q["expected_answer"] for q in body["draft"]["questions"]] == ["Option C: c", "Option D: d"]
