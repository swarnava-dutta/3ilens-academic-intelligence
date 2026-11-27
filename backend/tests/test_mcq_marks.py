"""Marked-option reader for printed MCQ papers (mcq_marks) and its pipeline routing. Offline: the
Anthropic / OpenAI clients are fakes injected through ai._anthropic_client / ai._openai_client,
and the pipeline test fakes pre-processing and the reader itself."""
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
import marking  # noqa: E402
import mcq_marks  # noqa: E402
import pipeline  # noqa: E402
from ai import AIServiceError  # noqa: E402
from ai_schemas import ModelUsage, OcrAnswer, OcrResult, PreparedPage  # noqa: E402

TEST_KEY = "sk-ant-test-mcq-marks-0000"
OPENAI_KEY = "sk-proj-test-mcq-marks-0000"
REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


def _mcq(number: int, correct: str = "B", options: int = 4) -> dict[str, Any]:
    return {
        "question": number, "topic": "Ray Optics", "subject": "Physics", "max_marks": 4, "question_type": "mcq",
        "prompt": f"Printed question {number} text that must never reach the reader",
        "options": [f"option {i}" for i in range(1, options + 1)], "correct_option": correct,
        "expected_answer": f"Option {correct}", "grading_criteria": [f"4 marks: option {correct}"], "effort_hours": 2,
    }


def _descriptive(number: int) -> dict[str, Any]:
    return {"question": number, "topic": "Genetics", "subject": "Biology", "max_marks": 5,
            "expected_answer": "3:1", "grading_criteria": ["5 marks: ratio"], "effort_hours": 2}


RUBRIC = {"name": "NEET Mock (sample)", "questions": [_mcq(n) for n in range(1, 13)]}


@pytest.fixture(autouse=True)
def marks_env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("VISION_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-5-5")
    monkeypatch.setenv("MCQ_OCR_PAGES_PER_CALL", "2")
    monkeypatch.setenv("AI_CHUNK_CONCURRENCY", "3")
    monkeypatch.setenv("OCR_CONFIDENCE_THRESHOLD", "0.70")
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


def _reply(payload: Any, *, model: str = "claude-sonnet-5-5"):
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=json.dumps(payload))], stop_reason="end_turn", stop_details=None,
        model=model, usage=SimpleNamespace(input_tokens=1000, output_tokens=80, iterations=None), _request_id="req_m",
    )


def labels(kwargs: dict[str, Any]) -> list[str]:
    content = kwargs["messages"][0]["content"]
    return [c["text"] for c in content[:-1] if c["type"] == "text"]


def own_pages(kwargs: dict[str, Any]) -> list[int]:
    return [int(m.group(1)) for text in labels(kwargs) for m in [re.fullmatch(r"Page (\d+) of \d+:", text)] if m]


def context_pages(kwargs: dict[str, Any]) -> list[int]:
    return [int(m.group(1)) for text in labels(kwargs) for m in [re.match(r"Page (\d+) of \d+ \(context only", text)] if m]


def instruction_of(kwargs: dict[str, Any]) -> str:
    return kwargs["messages"][0]["content"][-1]["text"]


class MarksClaude:
    """Thread-safe fake Anthropic client: reply(kwargs) builds each response (or raises)."""

    def __init__(self, reply: Callable[[dict[str, Any]], Any]):
        self.reply = reply
        self.calls: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        with self._lock:
            self.calls.append(kwargs)
        return self.reply(kwargs)


def _use(monkeypatch, fake: MarksClaude) -> MarksClaude:
    monkeypatch.setattr(ai, "_anthropic_client", lambda settings: fake)
    return fake


def _marks(items: list[tuple[int, str, float, int]], pages: list[int], legibility: float = 0.9) -> dict[str, Any]:
    return {
        "questions": [{"question": q, "marked": m, "confidence": c, "page": p} for q, m, c, p in items],
        "page_assessments": [{"page": p, "legibility_confidence": legibility} for p in pages],
    }


# --------------------------------------------------------------------------- #
# Requests and chunks
# --------------------------------------------------------------------------- #
def test_chunks_get_the_next_page_as_context(monkeypatch):
    fake = _use(monkeypatch, MarksClaude(lambda kw: _reply(_marks([], own_pages(kw)))))
    ai_usages: list[ModelUsage] = []
    mcq_marks.read_marked_options(_pages(5), RUBRIC, on_usage=ai_usages.append)

    by_first = {own_pages(c)[0]: c for c in fake.calls}
    assert sorted(by_first) == [1, 3, 5]
    assert own_pages(by_first[1]) == [1, 2] and context_pages(by_first[1]) == [3]
    assert own_pages(by_first[3]) == [3, 4] and context_pages(by_first[3]) == [5]
    assert own_pages(by_first[5]) == [5] and context_pages(by_first[5]) == []
    # image order: own pages, then the next page as context only (never the previous page)
    assert labels(by_first[3])[0] == "Page 3 of 5:" and labels(by_first[3])[-1].startswith(
        "Page 5 of 5 (context only")
    instruction = instruction_of(by_first[3])
    assert instruction.startswith('These are pages 3-4 of a 5-page paper "NEET Mock (sample)"')
    assert "(with page 5 as context only)" in instruction
    assert "run from 1 to 12" in instruction
    assert "Printed question" not in instruction  # no rubric question list
    request = fake.calls[0]
    assert request["system"] == mcq_marks.MARKS_SYSTEM_PROMPT
    assert request["output_config"]["effort"] == "medium"
    assert request["output_config"]["format"]["schema"]["title"] == "MarkedOptions"
    assert sorted(u.image_count for u in ai_usages) == [1, 3, 3]
    assert all(u.purpose == "ocr" for u in ai_usages)


def test_single_page_sheet_is_one_call_without_context(monkeypatch):
    fake = _use(monkeypatch, MarksClaude(lambda kw: _reply(_marks([(1, "2", 0.95, 1)], [1]))))
    result = mcq_marks.read_marked_options(_pages(1), RUBRIC)
    assert len(fake.calls) == 1 and context_pages(fake.calls[0]) == []
    assert [(a.question, a.answer, a.pages) for a in result.answers] == [(1, "2", [1])]


def test_marks_become_answers_scored_as_options(monkeypatch):
    def reply(kw):
        if own_pages(kw)[0] == 1:
            return _reply(_marks([(1, "2", 0.95, 1), (2, "(3)", 0.9, 1), (3, "", 0.97, 2), (4, "B", 0.9, 2)], [1, 2]))
        return _reply(_marks([(5, "2, 3", 0.8, 3), (6, "none", 0.9, 3)], [3]))

    _use(monkeypatch, MarksClaude(reply))
    result = mcq_marks.read_marked_options(_pages(3), RUBRIC, language_hints=["en", "xx"])

    assert [(a.question, a.answer) for a in result.answers] == [(1, "2"), (2, "(3)"), (4, "B"), (5, "2, 3")]
    assert all(a.uncertain_words == [] for a in result.answers)
    assert result.answers[0].pages == [1] and result.answers[2].pages == [2]
    assert result.overall_confidence == round((0.95 + 0.9 + 0.9 + 0.8) / 4, 4)
    assert result.language_hints == ["en"]
    assert [(p.page, p.legibility_confidence) for p in result.page_assessments] == [(1, 0.9), (2, 0.9), (3, 0.9)]
    raw = json.loads(result.raw_response)
    assert raw["reader"] == "marks-v4" and [c["pages"] for c in raw["chunks"]] == [[1, 2], [3, 3]]

    policy = marking.policy_for({"marking_policy": {"negative_marks": 1}})
    scored = {a.question: marking.score_mcq(_mcq(a.question), a.answer, policy) for a in result.answers}
    assert scored[1]["selected_option"] == "B" and scored[1]["marks"] == 4.0  # (2) -> B, correct
    assert scored[2]["selected_option"] == "C" and scored[2]["marks"] == -1.0
    assert scored[5]["selected_option"] == marking.MULTI


def test_merge_prefers_a_mark_and_caps_conflicting_readings(monkeypatch):
    def reply(kw):
        if own_pages(kw)[0] == 1:  # Q3 and Q4 start at the foot of page 2 and continue on page 3
            return _reply(_marks([(3, "", 0.9, 2), (4, "2", 0.95, 2), (5, "1", 0.9, 2)], [1, 2]))
        return _reply(_marks([(3, "1", 0.85, 3), (4, "3", 0.9, 3), (5, "(1)", 0.97, 3)], [3, 4]))

    _use(monkeypatch, MarksClaude(reply))
    result = mcq_marks.read_marked_options(_pages(4), RUBRIC)
    by_q = {a.question: a for a in result.answers}
    assert by_q[3].answer == "1" and by_q[3].confidence == 0.85  # a mark beats an empty reading
    assert by_q[4].answer == "2" and by_q[4].confidence == 0.69  # different options: capped below 0.70
    assert by_q[5].answer == "(1)" and by_q[5].confidence == 0.97  # same option: the higher confidence


def test_conflict_sends_the_sheet_below_the_threshold(monkeypatch):
    monkeypatch.setenv("OCR_CONFIDENCE_THRESHOLD", "0.8")

    def reply(kw):
        first = own_pages(kw)[0]
        return _reply(_marks([(7, "2" if first == 1 else "4", 0.99, first)], own_pages(kw)))

    _use(monkeypatch, MarksClaude(reply))
    (answer,) = mcq_marks.read_marked_options(_pages(4), RUBRIC).answers
    assert answer.confidence == 0.79


def _stemmed(items: list[tuple[int, str, str, int]], pages: list[int], code: Any = "") -> dict[str, Any]:
    """A reply with stems: items are (question, stem, marked, page)."""
    return {
        "paper_code": code,
        "questions": [{"question": q, "stem": s, "marked": m, "confidence": 0.95, "page": p} for q, s, m, p in items],
        "page_assessments": [{"page": p, "legibility_confidence": 0.9} for p in pages],
    }


def test_stems_and_the_paper_code_are_returned(monkeypatch):
    long_stem = " ".join(f"word{i}" for i in range(40))

    def reply(kw):
        first = own_pages(kw)[0]
        if first == 1:  # Q4 starts at the foot of page 2 and is read again with page 3
            return _reply(_stemmed([(1, "  A body of mass 2 kg\n moves on a rough  surface", "2", 1),
                                    (2, "The magnetic susceptibility is negative for", "", 1),  # blank: stem kept
                                    (4, "A siren emitting", "", 2), (99, "Not a rubric question", "1", 2)],
                                   [1, 2], code=None))
        if first == 3:
            return _reply(_stemmed([(4, "A siren emitting sound of frequency 800 Hz", "3", 3), (5, 12, "1", 3),
                                    (6, long_stem, "", 4)], [3, 4], code="  Test Booklet Code:   P "))
        return _reply(_stemmed([(7, "", "2", 5)], [5], code="Code Q"))

    _use(monkeypatch, MarksClaude(reply))
    result = mcq_marks.read_marked_options(_pages(5), RUBRIC)

    assert result.question_stems == {
        1: "A body of mass 2 kg moves on a rough surface",
        2: "The magnetic susceptibility is negative for",
        4: "A siren emitting sound of frequency 800 Hz",  # the longer reading wins
        6: " ".join(f"word{i}" for i in range(mcq_marks.MAX_STEM_WORDS)),
        99: "Not a rubric question",
    }
    assert result.paper_code == "Test Booklet Code: P"  # the first request that saw one
    assert result.dropped_questions == [99] and [a.question for a in result.answers] == [1, 4, 5, 7]
    assert OcrResult.model_validate(result.model_dump(mode="json")).question_stems[4].startswith("A siren")


def test_no_paper_code_reads_as_none(monkeypatch):
    _use(monkeypatch, MarksClaude(lambda kw: _reply(_stemmed([(1, "", "2", 1)], own_pages(kw), code="none"))))
    result = mcq_marks.read_marked_options(_pages(1), RUBRIC)
    assert result.paper_code is None and result.question_stems == {}


def test_the_request_asks_for_stems_and_the_paper_code(monkeypatch):
    fake = _use(monkeypatch, MarksClaude(lambda kw: _reply(_marks([], own_pages(kw)))))
    mcq_marks.read_marked_options(_pages(1), RUBRIC)
    schema = fake.calls[0]["output_config"]["format"]["schema"]
    assert set(schema["required"]) >= {"paper_code", "questions", "page_assessments"}
    (item,) = [d for d in schema["$defs"].values() if d.get("title") == "MarkedQuestion"]
    assert "stem" in item["properties"] and "stem" in item["required"]
    assert '"stem": ' in instruction_of(fake.calls[0]) and '"paper_code": ' in instruction_of(fake.calls[0])
    assert "- stem: the first words" in mcq_marks.MARKS_SYSTEM_PROMPT
    assert "- paper_code: the paper code" in mcq_marks.MARKS_SYSTEM_PROMPT
    assert mcq_marks.MARKS_PROMPT_VERSION == "marks-v4"
    assert "paper_code, questions[{question, stem, marked" in mcq_marks.MARKS_JSON_KEYS_NOTE


def test_descriptive_and_unknown_numbers_are_not_answers(monkeypatch):
    rubric = {"name": "Mostly MCQ", "questions": [_mcq(n) for n in range(1, 11)] + [_descriptive(11)]}
    _use(monkeypatch, MarksClaude(lambda kw: _reply(_marks(
        [(1, "3", 0.9, 1), (11, "Tt x tt", 0.9, 1), (99, "2", 0.9, 1), ("Q2", "4", 0.9, 1), ("x", "1", 0.9, 1)], [1]
    ))))
    result = mcq_marks.read_marked_options(_pages(1), rubric)
    assert [(a.question, a.answer) for a in result.answers] == [(1, "3"), (2, "4")]
    assert result.dropped_questions == [99]


def test_relative_page_numbers_are_mapped_once_per_reply(monkeypatch):
    def reply(kw):
        own = own_pages(kw)
        if own[0] == 7:  # images: own 7, own 8, context 9 -> the reply counts them 1..3
            return _reply({"questions": [{"question": 8, "marked": "1", "confidence": 0.9, "page": 1},
                                         {"question": 9, "marked": "2", "confidence": 0.9, "page": 2}],
                           "page_assessments": [{"page": 1, "legibility_confidence": 0.8},
                                                {"page": 2, "legibility_confidence": 0.7}]})
        return _reply(_marks([], own))

    _use(monkeypatch, MarksClaude(reply))
    result = mcq_marks.read_marked_options(_pages(10), RUBRIC)
    by_q = {a.question: a for a in result.answers}
    assert by_q[8].pages == [7] and by_q[9].pages == [8]
    assessed = {p.page: p.legibility_confidence for p in result.page_assessments}
    assert assessed[7] == 0.8 and assessed[8] == 0.7


def test_ambiguous_page_numbers_keep_the_labelled_reading(monkeypatch):
    def reply(kw):
        own = own_pages(kw)
        if own[0] == 3:  # images 3, 4, 5 (context): ref 3 fits both readings -> the labelled page wins
            return _reply(_marks([(8, "1", 0.9, 3)], []))
        return _reply(_marks([], own))

    _use(monkeypatch, MarksClaude(reply))
    by_q = {a.question: a for a in mcq_marks.read_marked_options(_pages(6), RUBRIC).answers}
    assert by_q[8].pages == [3]  # read as image 3 it would be context page 5, which is never kept


def test_context_page_references_are_not_own_pages(monkeypatch):
    def reply(kw):
        own = own_pages(kw)
        if own[0] == 3:  # absolute numbering; a stray reference to context page 5 is not kept
            return _reply({"questions": [{"question": 8, "marked": "1", "confidence": 0.9, "page": 5},
                                         {"question": 9, "marked": "2", "confidence": 0.9, "page": 4}],
                           "page_assessments": [{"page": 5, "legibility_confidence": 0.1},
                                                {"page": 4, "legibility_confidence": 0.9}]})
        return _reply(_marks([], own))

    _use(monkeypatch, MarksClaude(reply))
    result = mcq_marks.read_marked_options(_pages(6), RUBRIC)
    by_q = {a.question: a for a in result.answers}
    assert by_q[8].pages == [] and by_q[9].pages == [4]
    assert 0.1 not in {p.legibility_confidence for p in result.page_assessments}


def test_usage_is_reported_on_the_calling_thread(monkeypatch):
    _use(monkeypatch, MarksClaude(lambda kw: _reply(_marks([], own_pages(kw)))))
    caller = threading.get_ident()
    threads: list[int] = []

    def on_usage(usage: ModelUsage) -> None:
        threads.append(threading.get_ident())

    mcq_marks.read_marked_options(_pages(9), RUBRIC, on_usage=on_usage)
    assert len(threads) == 5 and set(threads) == {caller}


def test_a_claude_timeout_is_retried_never_read_by_another_vendor(monkeypatch):
    """No cross-vendor fallback for ticks (a gpt-4o reading moved ticks and filled blanks): a Claude
    timeout surfaces as a transient error for the pipeline's retry, and no other model is called."""
    monkeypatch.setenv("OPENAI_API_KEY", OPENAI_KEY)

    def reply(kw):
        if own_pages(kw)[0] == 3:
            raise anthropic.APITimeoutError(request=REQUEST)
        return _reply(_marks([(1, "2", 0.9, own_pages(kw)[0])], own_pages(kw)))

    _use(monkeypatch, MarksClaude(reply))
    gpt_calls: list[dict[str, Any]] = []
    monkeypatch.setattr(ai, "_openai_client", lambda settings: SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: gpt_calls.append(kw)))))
    with pytest.raises(ai.AIServiceError) as caught:
        mcq_marks.read_marked_options(_pages(5), RUBRIC)
    assert caught.value.transient and gpt_calls == []

def test_a_failed_chunk_fails_the_read(monkeypatch):
    def reply(kw):
        if own_pages(kw)[0] == 3:
            return _reply({"questions": "not a list"})
        return _reply(_marks([], own_pages(kw)))

    _use(monkeypatch, MarksClaude(reply))
    usages: list[ModelUsage] = []
    with pytest.raises(AIServiceError) as excinfo:
        mcq_marks.read_marked_options(_pages(6), RUBRIC, on_usage=usages.append)
    assert excinfo.value.code == "invalid_json"
    assert any(u.status == "error" and u.error_code == "invalid_json" for u in usages)


def test_the_anthropic_key_is_required(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    with pytest.raises(ai.AIConfigurationError):
        mcq_marks.read_marked_options(_pages(3), RUBRIC)


# --------------------------------------------------------------------------- #
# Pipeline routing and cache key
# --------------------------------------------------------------------------- #
def _sub(mime: str = "application/pdf", path: str = "missing.pdf") -> SimpleNamespace:
    return SimpleNamespace(id=1, mime_type=mime, file_path=path)


@pytest.mark.parametrize(
    ("rubric", "mime", "pages", "expected"),
    [
        (RUBRIC, "application/pdf", 3, "marks"),
        (RUBRIC, "application/pdf", 19, "marks"),
        ({"name": "Mixed", "questions": [_mcq(n) for n in range(1, 8)] + [_descriptive(n) for n in range(8, 11)]},
         "application/pdf", 5, "ocr"),
        # MCQ-heavy but with written questions: the tick reader would skip Q11-Q12 (mock09 lost 8 marks)
        ({"name": "Mostly MCQ", "questions": [_mcq(n) for n in range(1, 11)] + [_descriptive(11), _descriptive(12)]},
         "application/pdf", 19, "ocr"),
        ({"name": "Mostly MCQ", "questions": [_mcq(n) for n in range(1, 11)] + [_descriptive(11), _descriptive(12)]},
         "image/png", 1, "ocr"),
        ({"name": "Short MCQ", "questions": [_mcq(n) for n in range(1, 6)]}, "application/pdf", 5, "ocr"),
        (RUBRIC, "image/png", 1, "marks"),  # a photo of a printed MCQ paper
        (RUBRIC, "image/jpeg", 1, "marks"),
        (RUBRIC, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 4, "ocr"),
    ],
)
def test_reader_routing_rule(rubric, mime, pages, expected):
    assert pipeline.ocr_reader(_sub(mime), rubric, pages) == expected


def test_a_short_printed_paper_is_routed_by_detection(monkeypatch, tmp_path):
    import paper_detect

    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.7 stub")
    roles = iter(["question_paper", "answer_key_paper", "answer_sheet"])
    monkeypatch.setattr(paper_detect, "inspect_bytes", lambda data, settings: SimpleNamespace(role=next(roles)))
    assert pipeline.ocr_reader(_sub(path=str(pdf)), RUBRIC, 1) == "marks"
    assert pipeline.ocr_reader(_sub(path=str(pdf)), RUBRIC, 2) == "marks"
    assert pipeline.ocr_reader(_sub(path=str(pdf)), RUBRIC, 2) == "ocr"


def test_detection_failure_falls_back_to_the_page_rule(monkeypatch, tmp_path):
    import paper_detect

    def boom(data, settings):
        raise RuntimeError("detector broke")

    monkeypatch.setattr(paper_detect, "inspect_bytes", boom)
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.7 stub")
    assert pipeline.ocr_reader(_sub(path=str(pdf)), RUBRIC, 2) == "ocr"
    assert pipeline.ocr_reader(_sub(path=str(tmp_path / "gone.pdf")), RUBRIC, 1) == "ocr"  # unreadable file
    assert pipeline.ocr_reader(_sub(path=str(pdf)), RUBRIC, 3) == "marks"


def test_the_two_readers_never_share_a_cache_key():
    sub = SimpleNamespace(file_hash="ab" * 32, batch=SimpleNamespace(institution_id=1))
    rubric = SimpleNamespace(content=RUBRIC)
    ocr = pipeline.ocr_cache_key(sub, rubric, "anthropic", "claude-sonnet-5-5", ["en"])
    assert ocr == pipeline.ocr_cache_key(sub, rubric, "anthropic", "claude-sonnet-5-5", ["en"], "ocr")
    marks = pipeline.ocr_cache_key(sub, rubric, "anthropic", "claude-sonnet-5-5", ["en"], "marks")
    assert marks != ocr
    assert marks == pipeline.ocr_cache_key(sub, rubric, "anthropic", "claude-sonnet-5-5", ["en"], "marks")


def test_the_marks_cache_key_follows_the_reader_prompt_version(monkeypatch):
    sub = SimpleNamespace(file_hash="ab" * 32, batch=SimpleNamespace(institution_id=1))
    rubric = SimpleNamespace(content=RUBRIC)
    current = pipeline.ocr_cache_key(sub, rubric, "anthropic", "claude-sonnet-5-5", ["en"], "marks")
    monkeypatch.setattr(mcq_marks, "MARKS_PROMPT_VERSION", "marks-v1")  # readings without stems
    assert pipeline.ocr_cache_key(sub, rubric, "anthropic", "claude-sonnet-5-5", ["en"], "marks") != current


# --------------------------------------------------------------------------- #
# Pipeline end to end (pre-processing and the reader faked)
# --------------------------------------------------------------------------- #
def test_a_printed_mcq_paper_is_read_by_the_marks_reader_and_scored(client, upload, fake_ai, make_pdf, monkeypatch):
    import preprocessing

    def preprocess(file_path, mime_type, artifact_dir, log, **kwargs):
        artifact_dir.mkdir(parents=True, exist_ok=True)
        out = []
        for n in (1, 2, 3):
            path = artifact_dir / f"page_{n}.png"
            path.write_bytes(b"png")
            out.append(PreparedPage(page_number=n, media_type="image/png", data=b"png", path=path))
        return out

    calls: list[dict[str, Any]] = []

    def fake_reader(pages, rubric_content, **kwargs):
        calls.append({"pages": [p.page_number for p in pages], **kwargs})
        kwargs["on_usage"](ModelUsage(purpose="ocr", provider="anthropic", model_requested="claude-sonnet-5-5",
                                      model_served="claude-sonnet-5-5", input_tokens=3000, output_tokens=200,
                                      image_count=4))
        answers = [OcrAnswer(question=n, answer=mark, confidence=0.95, pages=[1 + (n - 1) // 4])
                   for n, mark in [(1, "2"), (2, "(2)"), (3, "1"), (4, "2, 3"), (5, "B"), (6, "2"), (7, "2"),
                                   (8, "2"), (9, "2"), (10, "2")]]
        return OcrResult(answers=answers, overall_confidence=0.95, provider="anthropic", model="claude-sonnet-5-5",
                         raw_response='{"reader": "marks-v2", "chunks": []}',
                         page_assessments=[], language_hints=list(kwargs.get("language_hints") or []))

    monkeypatch.setattr(preprocessing, "preprocess_document", preprocess)
    monkeypatch.setattr(mcq_marks, "read_marked_options", fake_reader)
    rubric = {"name": "Printed NEET mock", "questions": [_mcq(n) for n in range(1, 13)],
              "marking_policy": {"partial_credit": "steps", "mark_step": 0.5, "negative_marks": 1}}
    response = upload(filename="neet_paper.pdf", content=make_pdf(3), rubric_json=json.dumps(rubric))
    assert response.status_code == 202, response.text
    result = client.get(f"/api/results/{response.json()['id']}")
    assert result.status_code == 200, result.text
    body = result.json()

    assert fake_ai.calls["ocr"] == 0  # the handwriting OCR was not used
    assert len(calls) == 1 and calls[0]["pages"] == [1, 2, 3]
    log = [entry["message"] for entry in body["processing_log"]]
    assert any(m.startswith("Printed MCQ paper: reading the marked option of every printed question on 3 page(s)")
               and "2 page(s) per call" in m and "(2 calls;" in m for m in log)
    # 8 correct (B) x 4, Q3 "1" = A wrong -1, Q4 two options -1; Q11-Q12 blank
    assert body["total_score"] == 30


def _key_only(number: int, subject: str) -> dict[str, Any]:
    """A question of a key built from the answer-key file alone: no question text, no chapter."""
    return {"question": number, "topic": subject, "subject": subject, "max_marks": 4, "question_type": "mcq",
            "options": [ai.UNTRANSCRIBED_OPTION.format(letter=letter) for letter in "ABCD"], "correct_option": "B",
            "expected_answer": "", "grading_criteria": ["4 marks: correct option"], "effort_hours": 1}


KEY_ONLY = {
    "name": "AIPMT 2016 key",
    "questions": [_key_only(n, "Physics" if n <= 4 else "Chemistry" if n <= 8 else "Biology") for n in range(1, 13)],
    "marking_policy": {"partial_credit": "all_or_nothing", "negative_marks": 1},
}


def test_a_key_only_paper_is_reported_by_the_chapters_read_from_the_paper(client, upload, fake_ai, make_pdf,
                                                                          monkeypatch):
    import database
    import insights
    import preprocessing
    from ai_schemas import EvaluationOutput

    def preprocess(file_path, mime_type, artifact_dir, log, **kwargs):
        artifact_dir.mkdir(parents=True, exist_ok=True)
        return [PreparedPage(page_number=n, media_type="image/png", data=b"png", path=artifact_dir / f"page_{n}.png")
                for n in (1, 2, 3)]

    def reply(kw):  # (question, marked, chapter): a name off the list, or of another subject, is dropped
        items = ([(1, "2", "Laws of Motion"), (2, "1", "Laws of Motion"), (3, "2", "Ray Optics"), (4, "", ""),
                  (5, "2", "hydrocarbons"), (6, "2", "Evolution")] if own_pages(kw)[0] == 1 else
                 [(7, "3", "Chemical Bonding and Molecular Structure"), (8, "2", ""), (9, "2", "Evolution"),
                  (10, "1", "Evolution"), (11, "2", "Ecosystem"), (12, "", "Human Reproduction")])
        payload = _marks([(q, m, 0.95, own_pages(kw)[0]) for q, m, _c in items], own_pages(kw))
        for entry, (_q, _m, chapter) in zip(payload["questions"], items):
            entry.update(stem="", chapter=chapter)
        return _reply(payload)

    monkeypatch.setattr(preprocessing, "preprocess_document", preprocess)
    fake = _use(monkeypatch, MarksClaude(reply))
    response = upload(filename="aipmt_2016.pdf", content=make_pdf(3), rubric_json=json.dumps(KEY_ONLY))
    assert response.status_code == 202, response.text
    body = client.get(f"/api/results/{response.json()['id']}").json()

    assert "\nPhysics: Units and Measurement; Motion in a Straight Line; " in instruction_of(fake.calls[0])
    bonding = "Chemical Bonding and Molecular Structure"
    assert [(t["topic"], t["subject"], t["chapter"], t["questions"]) for t in body["topic_mastery"]] == [
        ("Laws of Motion", "Physics", "Laws of Motion", [1, 2]), ("Physics", "Physics", None, [3, 4]),
        ("Hydrocarbons", "Chemistry", "Hydrocarbons", [5]), ("Chemistry", "Chemistry", None, [6, 8]),
        (bonding, "Chemistry", bonding, [7]), ("Evolution", "Biology", "Evolution", [9, 10]),
        ("Ecosystem", "Biology", "Ecosystem", [11]), ("Human Reproduction", "Biology", "Human Reproduction", [12]),
    ]
    # Marks are those of the key itself: +4 / -1 / 0 per question, 25 in all.
    answers = [OcrAnswer(question=q["question"], answer=q["student_answer"], confidence=0.95)
               for q in body["question_evaluations"] if q["student_answer"]]
    plain = insights.build_evaluation_report(KEY_ONLY, answers, EvaluationOutput(evaluations=[], overall_strengths=[],
                                                                                 overall_gaps=[]))
    assert body["total_score"] == plain["total_score"] == 25
    assert [q["estimated_marks"] for q in body["question_evaluations"]] == [
        q["estimated_marks"] for q in plain["question_evaluations"]]
    with database.SessionLocal() as session:  # the stored rubric keeps the key's own topics
        rubric = session.get(database.Rubric, body["rubric"]["id"])
        assert [(q["topic"], q.get("chapter")) for q in rubric.content["questions"]] == [
            (q["subject"], None) for q in KEY_ONLY["questions"]]


def test_an_ncert_chapter_is_kept_for_its_own_subject_only(monkeypatch):
    import analytics

    items = [(1, "Current Electricity"), (2, "Chemical Kinetics"), (5, "chemical kinetics"),
             (6, "Current Electricity"), (9, "Molecular Basis of Inheritance"), (10, "Chemical Kinetics")]

    def reply(kw):
        payload = _marks([(q, "2", 0.95, 1) for q, _c in items], own_pages(kw))
        for entry, (_q, chapter) in zip(payload["questions"], items):
            entry.update(stem="", chapter=chapter)
        return _reply(payload)

    _use(monkeypatch, MarksClaude(reply))
    result = mcq_marks.read_marked_options(_pages(1), KEY_ONLY)  # Q1-4 Physics, Q5-8 Chemistry, Q9-12 Biology
    assert result.question_chapters == {1: "Current Electricity", 5: "Chemical Kinetics",
                                        9: "Molecular Basis of Inheritance"}
    syllabus = mcq_marks._neet_chapters()
    assert {s: len(n) for s, n in syllabus.items()} == {"Physics": 28, "Chemistry": 20, "Biology": 32}
    keys = [analytics._key(name) for names in syllabus.values() for name in names]
    assert len(keys) == len(set(keys))  # topics are keyed by name: no chapter is in two subjects


def test_a_key_with_question_text_is_not_regrouped(monkeypatch):
    def reply(kw):
        payload = _stemmed([(1, "A body of mass 2 kg moves on a rough surface", "2", 1)], own_pages(kw))
        payload["questions"][0]["chapter"] = "Mechanics"  # volunteered, never asked for
        return _reply(payload)

    fake = _use(monkeypatch, MarksClaude(reply))
    result = mcq_marks.read_marked_options(_pages(1), RUBRIC)
    assert "chapter" not in instruction_of(fake.calls[0]) and result.question_chapters == {}
    assert pipeline.chapter_rubric(RUBRIC, {1: "Mechanics"}) is RUBRIC
    chaptered = {**KEY_ONLY, "questions": [{**KEY_ONLY["questions"][0], "chapter": "Kinematics"}]}
    assert pipeline.chapter_rubric(chaptered, {1: "Mechanics"}) is chaptered


def test_pages_are_reencoded_to_the_reader_size():
    import io
    from pathlib import Path as _Path

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (1414, 2000), "white").save(buffer, "PNG")
    big = PreparedPage(page_number=1, media_type="image/png", data=buffer.getvalue(), path=_Path("page_1.png"))
    broken = PreparedPage(page_number=2, media_type="image/png", data=b"not an image", path=_Path("page_2.png"))
    small, kept = mcq_marks._model_pages([big, broken])
    assert small.media_type == "image/jpeg" and small.page_number == 1 and small.path == big.path
    assert max(Image.open(io.BytesIO(small.data)).size) <= 1800
    assert kept is broken  # undecodable page is sent as prepared
