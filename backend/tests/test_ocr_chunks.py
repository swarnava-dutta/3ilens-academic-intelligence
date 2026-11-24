"""Chunked OCR for long answer sheets (more than OCR_PAGES_PER_CALL pages), e.g. a printed MCQ
paper the student ticked. Offline: the SDK clients are fakes injected through
ai._anthropic_client / ai._openai_client."""
from __future__ import annotations

import json
import re
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

import anthropic
import httpx2
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import ai  # noqa: E402
from ai import AIServiceError  # noqa: E402
from ai_schemas import ModelUsage, PreparedPage  # noqa: E402

TEST_KEY = "sk-ant-test-ocr-chunks-0000"
OPENAI_KEY = "sk-proj-test-ocr-chunks-0000"
REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")

RUBRIC = {
    "name": "Printed mock paper",
    "subject": "Mixed",
    "questions": [
        {"question": 1, "topic": "Genetics", "subject": "Biology", "max_marks": 4, "prompt": "Explain a test cross.",
         "expected_answer": "Tt x tt", "grading_criteria": ["4 marks: cross"], "effort_hours": 2},
        {"question": 2, "topic": "Optics", "subject": "Physics", "max_marks": 4, "prompt": "Magnification?",
         "question_type": "mcq", "options": ["100", "125", "150", "250"], "correct_option": "B",
         "expected_answer": "Option B", "grading_criteria": ["4 marks: option B"], "effort_hours": 2},
        {"question": 3, "topic": "Optics", "subject": "Physics", "max_marks": 4, "prompt": "Focal length?",
         "question_type": "mcq", "options": ["1", "2", "3", "4"], "correct_option": "A",
         "expected_answer": "Option A", "grading_criteria": ["4 marks: option A"], "effort_hours": 2},
    ],
}


@pytest.fixture(autouse=True)
def ocr_env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("VISION_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-5-5")
    monkeypatch.setenv("OCR_PAGES_PER_CALL", "6")
    monkeypatch.setenv("AI_CHUNK_CONCURRENCY", "3")
    for name in ("LLM_FALLBACK", "LLM_FALLBACK_MODEL", "LLM_SIMULATE_PRIMARY_OUTAGE"):
        monkeypatch.delenv(name, raising=False)

    def forbidden(_settings):
        raise AssertionError("test tried to create a real SDK client")

    monkeypatch.setattr(ai, "_anthropic_client", forbidden)
    monkeypatch.setattr(ai, "_openai_client", forbidden)


def _pages(n: int) -> list[PreparedPage]:
    return [
        PreparedPage(page_number=i, media_type="image/png", data=f"page-{i}".encode(), path=Path(f"page_{i}.png"))
        for i in range(1, n + 1)
    ]


def _reply(payload: dict | None = None, *, stop_reason: str = "end_turn", model: str = "claude-sonnet-5-5"):
    content = [SimpleNamespace(type="text", text=json.dumps(payload))] if payload is not None else []
    return SimpleNamespace(
        content=content, stop_reason=stop_reason, stop_details=None, model=model,
        usage=SimpleNamespace(input_tokens=1000, output_tokens=100, iterations=None), _request_id="req_chunk",
    )


def page_labels(kwargs: dict[str, Any]) -> list[int]:
    """Page numbers of the images in one Claude request, from their "Page N of T:" labels."""
    content = kwargs["messages"][0]["content"]
    return [int(m.group(1)) for c in content if c["type"] == "text" for m in [re.match(r"Page (\d+) of \d+:", c["text"])] if m]


def instruction_of(kwargs: dict[str, Any]) -> str:
    return kwargs["messages"][0]["content"][-1]["text"]


class ChunkClaude:
    """Thread-safe fake: reply(kwargs) builds the response for each request (or raises)."""

    def __init__(self, reply: Callable[[dict[str, Any]], Any]):
        self.reply = reply
        self.calls: list[dict[str, Any]] = []
        self.threads: set[int] = set()
        self._lock = threading.Lock()
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        with self._lock:
            self.calls.append(kwargs)
            self.threads.add(threading.get_ident())
        return self.reply(kwargs)


def _use(monkeypatch, fake: ChunkClaude) -> ChunkClaude:
    monkeypatch.setattr(ai, "_anthropic_client", lambda settings: fake)
    return fake


def _assess(pages: list[int], confidence: float = 0.9) -> list[dict[str, Any]]:
    return [{"page": p, "legibility_confidence": confidence} for p in pages]


# --------------------------------------------------------------------------- #
# Chunk maths
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("count", "size", "expected"),
    [(19, 6, [6, 6, 6, 1]), (12, 6, [6, 6]), (5, 6, [5]), (3, 0, [1, 1, 1]), (0, 6, []), (7, 2, [2, 2, 2, 1])],
)
def test_chunk_pages_are_consecutive(count, size, expected):
    chunks = ai.chunk_pages(list(range(1, count + 1)), size)
    assert [len(c) for c in chunks] == expected
    assert [p for c in chunks for p in c] == list(range(1, count + 1))


# --------------------------------------------------------------------------- #
# Up to OCR_PAGES_PER_CALL pages: one call, exactly as before
# --------------------------------------------------------------------------- #
def test_short_sheet_is_one_call_with_the_plain_instruction(monkeypatch):
    fake = _use(monkeypatch, ChunkClaude(lambda kw: _reply({
        "answers": [{"question": 1, "answer": "Tt x tt", "confidence": 0.9, "pages": [6]}],
        "page_assessments": _assess(list(range(1, 7))),
    })))
    result = ai.run_ocr(_pages(6), RUBRIC)
    assert len(fake.calls) == 1
    assert instruction_of(fake.calls[0]) == ai._ocr_instruction(RUBRIC, 6)
    assert "of a 6-page answer sheet" not in instruction_of(fake.calls[0])
    assert page_labels(fake.calls[0]) == [1, 2, 3, 4, 5, 6]
    assert result.answers[0].pages == [6]
    assert json.loads(result.raw_response)["answers"][0]["question"] == 1  # the raw reply, not a chunk wrapper


# --------------------------------------------------------------------------- #
# Longer sheets: chunks with absolute page numbers, merged
# --------------------------------------------------------------------------- #
def _chunk_reply(kwargs: dict[str, Any]) -> Any:
    pages = page_labels(kwargs)
    first = pages[0]
    if first == 1:
        answers = [
            {"question": 1, "answer": "Tt x tt gives", "confidence": 0.92, "pages": [6],
             "uncertain_words": [{"text": "gives", "confidence": 0.6}]},
            {"question": 2, "answer": "B", "confidence": 0.6, "pages": [3]},
        ]
    elif first == 7:
        answers = [
            # a ref to the context page (6) is dropped: pages lists only the chunk's own pages
            {"question": 1, "answer": "1 Tt : 1 tt", "confidence": 0.81, "pages": [6, 7],
             "uncertain_words": [{"text": "Tt", "confidence": 0.7}]},
            {"question": 2, "answer": "(2)", "confidence": 0.95, "pages": [8]},  # same option B, more confident
            {"question": 9, "answer": "not in rubric", "confidence": 0.9, "pages": [9]},
        ]
    else:
        answers = [{"question": 3, "answer": "(1)", "confidence": 0.88, "pages": [13]}]
    # an assessment of the context page is dropped too
    return _reply({"answers": answers, "page_assessments": _assess([first - 1] + pages if first > 1 else pages,
                                                                     0.8 + first / 100)})


def labels_of(kwargs: dict[str, Any]) -> list[str]:
    return [c["text"] for c in kwargs["messages"][0]["content"] if c["type"] == "text"][:-1]


def test_long_sheet_is_read_in_chunks_with_absolute_page_numbers(monkeypatch):
    fake = _use(monkeypatch, ChunkClaude(_chunk_reply))
    usages: list[ModelUsage] = []
    caller = threading.get_ident()
    usage_threads: list[int] = []

    def on_usage(usage: ModelUsage) -> None:
        usage_threads.append(threading.get_ident())
        usages.append(usage)

    result = ai.run_ocr(_pages(13), RUBRIC, on_usage=on_usage)

    assert len(fake.calls) == 3
    by_first = {page_labels(call)[0]: call for call in fake.calls}
    assert sorted(by_first) == [1, 7, 13]
    assert page_labels(by_first[7]) == [7, 8, 9, 10, 11, 12]
    assert page_labels(by_first[13]) == [13]
    # every chunk after the first gets the previous page first, as context only
    assert labels_of(by_first[1])[0] == "Page 1 of 13:"
    assert labels_of(by_first[7])[:2] == [
        "Page 6 of 13 (context only - read in another request; do not transcribe it):", "Page 7 of 13:",
    ]
    assert labels_of(by_first[13])[0].startswith("Page 12 of 13 (context only")
    assert "pages 7 to 12 of a 13-page answer sheet" in instruction_of(by_first[7])
    assert "Page 6 comes first, as context only" in instruction_of(by_first[7])
    assert "every page from 7 to 12" in instruction_of(by_first[7])
    assert "context only" not in instruction_of(by_first[1])
    assert "pages 13 to 13 of a 13-page answer sheet" in instruction_of(by_first[13])
    # the usage callback runs on the calling thread only (the pipeline's DB session is not thread-safe)
    assert len(usages) == 3 and set(usage_threads) == {caller}
    assert all(u.purpose == "ocr" and u.status == "ok" for u in usages)
    assert sorted(u.image_count for u in usages) == [2, 6, 7]  # the context image is counted

    answers = {a.question: a for a in result.answers}
    assert answers[1].answer == "Tt x tt gives\n1 Tt : 1 tt"  # descriptive: joined in page order
    assert answers[1].pages == [6, 7]
    assert answers[1].confidence == pytest.approx(0.81)
    assert [w.text for w in answers[1].uncertain_words] == ["gives", "Tt"]
    assert answers[2].answer == "(2)" and answers[2].confidence == pytest.approx(0.95)  # same option: higher
    assert answers[2].pages == [8]
    assert answers[3].answer == "(1)" and answers[3].pages == [13]
    assert result.dropped_questions == [9]
    assert [p.page for p in result.page_assessments] == list(range(1, 14))
    assert result.page_assessments[6].legibility_confidence == pytest.approx(0.87)
    assert result.overall_confidence == pytest.approx(round((0.81 + 0.95 + 0.88) / 3, 4))
    assert result.provider == "anthropic" and result.model == "claude-sonnet-5-5"
    raw = json.loads(result.raw_response)
    assert [c["pages"] for c in raw["chunks"]] == [[1, 6], [7, 12], [13, 13]]
    assert json.loads(raw["chunks"][1]["response"])["answers"][0]["question"] == 1


def test_chunk_size_and_concurrency_follow_settings(monkeypatch):
    monkeypatch.setenv("OCR_PAGES_PER_CALL", "4")
    monkeypatch.setenv("AI_CHUNK_CONCURRENCY", "1")
    fake = _use(monkeypatch, ChunkClaude(lambda kw: _reply({"answers": [], "page_assessments": _assess(page_labels(kw))})))
    result = ai.run_ocr(_pages(9), RUBRIC)
    assert sorted(len(page_labels(c)) for c in fake.calls) == [1, 4, 4]
    assert len(fake.threads) == 1  # one worker thread
    assert result.answers == [] and result.overall_confidence == 0.0


def test_a_failed_chunk_fails_the_whole_sheet(monkeypatch):
    def reply(kwargs):
        if page_labels(kwargs)[0] == 7:
            return _reply({"answers": "not a list"})  # invalid JSON shape, not a fallback trigger
        return _reply({"answers": [], "page_assessments": _assess(page_labels(kwargs))})

    _use(monkeypatch, ChunkClaude(reply))
    usages: list[ModelUsage] = []
    with pytest.raises(AIServiceError) as excinfo:
        ai.run_ocr(_pages(12), RUBRIC, on_usage=usages.append)
    assert excinfo.value.code == "invalid_json"
    assert any(u.status == "error" and u.error_code == "invalid_json" for u in usages)


def test_a_chunk_served_by_the_fallback_labels_the_result(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", OPENAI_KEY)

    def reply(kwargs):
        if page_labels(kwargs)[0] == 7:
            raise anthropic.APITimeoutError(request=REQUEST)
        return _reply({"answers": [{"question": 1, "answer": "Tt x tt", "confidence": 0.9, "pages": [2]}],
                       "page_assessments": _assess(page_labels(kwargs))})

    _use(monkeypatch, ChunkClaude(reply))
    gpt_calls: list[dict[str, Any]] = []
    lock = threading.Lock()

    def gpt_create(**kwargs):
        with lock:
            gpt_calls.append(kwargs)
        message = SimpleNamespace(content=json.dumps({
            "answers": [{"question": 2, "answer": "2", "confidence": 0.9, "pages": [8]}],
            "page_assessments": _assess(list(range(7, 13))),
        }), refusal=None)
        return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason="stop")],
                               model="gpt-4o-2024-08-06", usage=SimpleNamespace(prompt_tokens=900, completion_tokens=50),
                               _request_id="req_gpt")

    gpt = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=gpt_create)))
    monkeypatch.setattr(ai, "_openai_client", lambda settings: gpt)
    usages: list[ModelUsage] = []
    result = ai.run_ocr(_pages(12), RUBRIC, on_usage=usages.append)

    assert len(gpt_calls) == 1
    gpt_labels = [c["text"] for c in gpt_calls[0]["messages"][1]["content"] if c["type"] == "text"]
    assert gpt_labels[0].startswith("Page 6 of 12 (context only") and gpt_labels[1] == "Page 7 of 12:"
    assert "pages 7 to 12 of a 12-page" in gpt_labels[-1]
    assert len([c for c in gpt_calls[0]["messages"][1]["content"] if c["type"] == "image_url"]) == 7
    assert result.provider == "openai" and result.model == "gpt-4o-2024-08-06"
    assert {a.question for a in result.answers} == {1, 2}
    assert any(u.provider == "openai" and u.fell_back and u.image_count == 7 for u in usages)
    assert any(u.provider == "anthropic" and u.error_code == "timeout" for u in usages)


def test_mcq_read_as_different_options_in_two_chunks_is_kept_for_review(monkeypatch):
    def reply(kwargs):
        first = page_labels(kwargs)[0]
        answer = {"question": 2, "answer": "B" if first == 1 else "(3)", "confidence": 0.9 if first == 1 else 0.8,
                  "pages": [6] if first == 1 else [7]}
        return _reply({"answers": [answer], "page_assessments": _assess(page_labels(kwargs))})

    _use(monkeypatch, ChunkClaude(reply))
    result = ai.run_ocr(_pages(12), RUBRIC)
    (answer,) = result.answers
    threshold = ai.get_settings().ocr_confidence_threshold
    assert answer.answer == "B\n(3)" and answer.pages == [6, 7]
    assert answer.confidence == pytest.approx(threshold - 0.01)  # capped under the review gate
    import marking
    import pipeline

    # the same treatment as a duplicate inside one reply: read as more than one option marked ...
    assert marking.normalise_option(answer.answer, 4) == marking.MULTI
    # ... but the pages of both readings fall under the threshold, so the pipeline gate holds the
    # sheet for faculty review instead of scoring a chunking conflict as a multi-marked answer
    pages = {p["page"]: p["confidence"] for p in pipeline.page_confidences(result, 12)}
    assert pages[6] < threshold and pages[7] < threshold
    assert all(pages[n] >= threshold for n in pages if n not in (6, 7))


def test_a_blank_reading_in_one_chunk_never_spoils_an_option_read_in_another(monkeypatch):
    def reply(kwargs):
        first = page_labels(kwargs)[0]
        answers = [
            {"question": 2, "answer": "C" if first == 1 else "not attempted", "confidence": 0.9,
             "pages": [6] if first == 1 else [7]},
            {"question": 3, "answer": "-" if first == 1 else "(2)", "confidence": 0.9,
             "pages": [5] if first == 1 else [8]},
        ]
        return _reply({"answers": answers, "page_assessments": _assess(page_labels(kwargs))})

    _use(monkeypatch, ChunkClaude(reply))
    result = ai.run_ocr(_pages(12), RUBRIC)
    by_number = {a.question: a for a in result.answers}
    assert by_number[2].answer == "C" and by_number[2].pages == [6]
    assert by_number[3].answer == "(2)" and by_number[3].pages == [8]
    assert all(p["confidence"] >= 0.9 for p in __import__("pipeline").page_confidences(result, 12))


def test_an_answer_read_only_from_the_context_page_is_dropped(monkeypatch):
    def reply(kwargs):
        first = page_labels(kwargs)[0]
        if first == 1:
            answers = [{"question": 2, "answer": "B", "confidence": 0.9, "pages": [6]}]
        else:  # the second chunk re-reads Q2 from its context page 6, and Q1 with no page refs
            answers = [{"question": 2, "answer": "D", "confidence": 0.95, "pages": [6]},
                       {"question": 1, "answer": "(4)", "confidence": 0.9, "pages": []}]
        return _reply({"answers": answers, "page_assessments": _assess(page_labels(kwargs))})

    _use(monkeypatch, ChunkClaude(reply))
    result = ai.run_ocr(_pages(12), RUBRIC)
    by_number = {a.question: a for a in result.answers}
    assert by_number[2].answer == "B" and by_number[2].pages == [6]  # no conflict, no duplicate
    assert by_number[1].answer == "(4)"  # answers without page refs are kept


def _extraction(answer_pages: list[list[int]], assessed: list[int] | None = None):
    from ai_schemas import OcrExtraction

    return OcrExtraction.model_validate({
        "answers": [{"question": n, "answer": "x", "confidence": 0.9, "pages": pages}
                    for n, pages in enumerate(answer_pages, start=1)],
        "page_assessments": _assess(assessed or []),
    })


IMAGES_7_TO_12 = [6, 7, 8, 9, 10, 11, 12]  # context page 6, then the chunk's own pages


@pytest.mark.parametrize(
    ("answer_pages", "assessed", "translated", "cleaned"),
    [
        ([[7]], None, [[7]], [[7]]),                          # fits both readings: absolute (the asked-for one)
        ([[5]], None, [[10]], [[10]]),                        # only relative explains it: image 5 = page 10
        ([[5], [7]], None, [[10], [12]], [[10], [12]]),       # relative explains both refs, absolute only one
        ([[6, 8]], None, [[6, 8]], [[8]]),                    # absolute; the context page is never listed
        ([[2], [9]], None, [[2], [9]], [[], [9]]),            # tie: absolute for the whole reply, 2 not shifted
        ([[1]], list(range(1, 8)), [[6]], [[]]),              # relative: image 1 is the context page - dropped
        ([[3]], list(range(7, 13)), [[3]], [[]]),             # assessments are absolute, so is the reply
        ([[14]], None, [[14]], [[]]),                         # fits neither: dropped
    ],
)
def test_page_refs_are_read_as_absolute_or_relative_once_per_reply(answer_pages, assessed, translated, cleaned):
    result = ai._absolute_page_refs(_extraction(answer_pages, assessed), 7, 12, IMAGES_7_TO_12)
    assert [a.pages for a in result.answers] == translated
    rubric = {"questions": [{"question": n, "topic": "t"} for n in range(1, 4)]}
    answers, _dropped = ai._normalise_ocr_answers(result.answers, rubric, 12, page_range=(7, 12))
    assert [a.pages for a in answers] == cleaned
    assessments = ai._normalise_page_assessments(result.page_assessments, 12, page_range=(7, 12))
    assert all(7 <= item.page <= 12 for item in assessments)


def test_a_reply_counted_from_one_is_mapped_through_the_context_page(monkeypatch):
    def reply(kwargs):
        if page_labels(kwargs)[0] == 7:  # images: context 6, then 7..12 -> the reply counts 1..7
            return _reply({"answers": [{"question": 1, "answer": "Tt", "confidence": 0.9, "pages": [2]}],
                           "page_assessments": _assess(list(range(1, 8)), 0.7)})
        return _reply({"answers": [], "page_assessments": _assess(page_labels(kwargs))})

    _use(monkeypatch, ChunkClaude(reply))
    result = ai.run_ocr(_pages(12), RUBRIC)
    assert result.answers[0].pages == [7]
    assessed = {item.page: item.legibility_confidence for item in result.page_assessments}
    assert sorted(assessed) == list(range(1, 13)) and assessed[6] == pytest.approx(0.9)  # page 6 from chunk 1
    assert assessed[7] == pytest.approx(0.7)


# --------------------------------------------------------------------------- #
# Prompt (ocr-v4)
# --------------------------------------------------------------------------- #
def test_ocr_prompt_reads_marks_on_a_printed_paper():
    system = ai.OCR_SYSTEM_PROMPT
    assert ai.OCR_PROMPT_VERSION == "ocr-v4"
    assert "printed question paper itself" in system
    assert 'printed "Ans." lines and printed solutions' in system
    assert "a printed key is never the student's answer" in system
    # only printed keys are ignored: a handwritten "Ans." is the student's own answer
    assert 'a handwritten "Ans.", "Ans: (b)" or "3" next to a question is the student\'s own answer' in system
    assert 'give the number the student marked (for example "3")' in system
    assert "letter or number" in ai.OCR_MCQ_SUFFIX


def test_long_rubric_shortens_question_text_in_the_ocr_list():
    long_prompt = "A siren emitting a sound of frequency 800 Hz moves away from an observer towards a cliff " * 4
    questions = [
        {"question": n, "topic": "Waves", "subject": "Physics", "max_marks": 4, "prompt": long_prompt,
         "question_type": "mcq", "options": ["765 Hz", "800 Hz", "838 Hz", "885 Hz"], "correct_option": "C",
         "expected_answer": "Option C", "grading_criteria": ["4 marks: option C"], "effort_hours": 1}
        for n in range(1, 62)
    ]
    long_lines = [line for line in ai._ocr_instruction({"name": "NEET", "questions": questions}, 19).splitlines()
                  if line.startswith(("1 - ", "61 - "))]
    assert len(long_lines) == 2
    for line in long_lines:
        text = line.split(": ", 1)[1].removesuffix(ai.OCR_MCQ_SUFFIX)
        assert len(text) == ai.OCR_SHORT_PROMPT_CHARS and text.endswith("...")
    short = ai._ocr_instruction({"name": "NEET", "questions": questions[:60]}, 19)
    assert " ".join(long_prompt.split()) in short  # 60 questions or fewer keep the full text
    # voice mapping keeps the full text whatever the length
    assert " ".join(long_prompt.split()) in "\n".join(ai._question_lines({"questions": questions}))


def test_a_reply_counting_only_its_own_pages_from_1_is_not_shifted_by_the_context_image():
    # chunk 7-12 with context page 6: the reply numbers its own six pages 1-6 (assessments 1..6)
    result = ai._absolute_page_refs(_extraction([[1], [2, 3], [6]], [1, 2, 3, 4, 5, 6]), 7, 12, IMAGES_7_TO_12)
    assert [a.pages for a in result.answers] == [[7], [8, 9], [12]]
    assert [item.page for item in result.page_assessments] == [7, 8, 9, 10, 11, 12]


def test_a_reply_counting_every_image_from_1_still_maps_the_context_image_first():
    # image 1 is the context page 6; the reply reaches image 7, so it counted all seven images
    result = ai._absolute_page_refs(_extraction([[2], [7]], [2, 3, 4, 5, 6, 7]), 7, 12, IMAGES_7_TO_12)
    assert [a.pages for a in result.answers] == [[7], [12]]
    assert [item.page for item in result.page_assessments] == [7, 8, 9, 10, 11, 12]
