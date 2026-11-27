"""POST /api/rubrics/parse with one drop zone: a question paper and its answer key in either order
(file / key_file) give the same draft, files_swapped says when they were swapped; the key-only check
needs no AI call."""
from __future__ import annotations

import pytest

import ai

KEY = "ANSWER KEY\nQue. 1 2 3 4 5 6 7 8 9 10 11 12\nAns. 2 1 1 3 4 4 2 3 4 3 2 1".encode()
PAPER = "\n".join(f"{n}. Which of the following statements about topic {n} is correct?\n(1) a\n(2) b\n(3) c\n(4) d"
                  for n in range(1, 13)).encode()


@pytest.fixture
def drafter(monkeypatch) -> list[str]:
    """A fake AI drafter: 12 unkeyed MCQs; records the text it was given."""
    seen: list[str] = []

    def parse_rubric(*, text=None, **_):
        seen.append(text or "")
        questions = [{"question": n, "topic": "Optics", "subject": "Physics", "max_marks": 4, "question_type": "mcq",
                      "prompt": f"Question {n}", "options": ["a", "b", "c", "d"], "expected_answer": "",
                      "grading_criteria": [], "effort_hours": 1} for n in range(1, 13)]
        return ai.finalise_rubric_draft({"name": "Paper", "subject": "Physics", "questions": questions})

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-parse-order")
    monkeypatch.setattr(ai, "parse_rubric", parse_rubric)
    return seen


def _parse(client, first: tuple[str, bytes], second: tuple[str, bytes] | None = None):
    files = {"file": (*first, "text/plain")}
    if second is not None:
        files["key_file"] = (*second, "text/plain")
    return client.post("/api/rubrics/parse", files=files)


def test_key_and_paper_in_either_order_give_the_same_draft(client, drafter):
    paper_first = _parse(client, ("paper.txt", PAPER), ("key.txt", KEY))
    key_first = _parse(client, ("key.txt", KEY), ("paper.txt", PAPER))
    assert paper_first.status_code == key_first.status_code == 200, key_first.text
    assert paper_first.json()["files_swapped"] is False and key_first.json()["files_swapped"] is True
    assert {**key_first.json(), "files_swapped": False} == paper_first.json()
    assert len(drafter) == 2 and all(text.startswith("1. Which of the following") for text in drafter)
    body = key_first.json()
    assert [q["correct_option"] for q in body["draft"]["questions"]][:4] == ["B", "A", "A", "C"]
    assert body["warnings"][0] == "Answer key file: set 12 keys."


def test_a_single_key_file_still_builds_without_ai(client, monkeypatch):
    monkeypatch.setattr(ai, "parse_rubric", lambda **_: (_ for _ in ()).throw(AssertionError("AI drafting called")))
    r = _parse(client, ("key.txt", KEY))
    assert r.status_code == 200, r.text
    assert r.json()["warnings"][0].startswith("Built from the answer key alone: 12 MCQs")
    assert r.json()["files_swapped"] is False


def test_two_keys_draft_from_the_first_and_apply_the_second(client, monkeypatch):
    monkeypatch.setattr(ai, "parse_rubric", lambda **_: (_ for _ in ()).throw(AssertionError("AI drafting called")))
    other = KEY.replace(b"Ans. 2 1", b"Ans. 4 1")
    r = _parse(client, ("key.txt", KEY), ("other.txt", other))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["draft"]["name"] == "key" and body["draft"]["questions"][0]["correct_option"] == "D"
    assert body["files_swapped"] is False
