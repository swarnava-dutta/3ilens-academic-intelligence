"""An answer key with no question text (a "Que. / Ans." grid) drafts an all-MCQ rubric straight from
the key - no AI call - with multi-answer and bonus cells written as accepted_options / bonus."""
from __future__ import annotations

import ai


def test_a_key_only_text_becomes_an_mcq_rubric_without_ai(client, monkeypatch):
    monkeypatch.setattr(ai, "parse_rubric", lambda **_: (_ for _ in ()).throw(AssertionError("AI drafting called")))
    text = "ANSWER KEY\nQue. 1 2 3 4 5 6 7 8 9 10 11 12\nAns. 2 1 1 3 4 4 2 or 3 4 3 2 Bonus 1"
    r = client.post("/api/rubrics/parse", data={"text": text})
    assert r.status_code == 200, r.text
    body = r.json()
    qs = {q["question"]: q for q in body["draft"]["questions"]}
    assert len(qs) == 12 and all(q["question_type"] == "mcq" for q in qs.values())
    assert qs[1]["correct_option"] == "B" and qs[4]["correct_option"] == "C"
    assert qs[7]["accepted_options"] == ["B", "C"] and qs[11]["bonus"] is True
    assert body["draft"]["marking_policy"]["negative_marks"] == 1
    assert body["warnings"][0].startswith("Built from the answer key alone: 12 MCQs")


def test_a_question_paper_still_goes_to_the_ai_drafter(client, monkeypatch):
    called = {}

    def fake(**kwargs):
        called["yes"] = True
        raise ai.AIServiceError("stop here", code="ai_error")

    monkeypatch.setattr(ai, "parse_rubric", fake)
    paper = "\n".join(f"{n}. Which of the following statements about topic {n} is correct?\n(1) a\n(2) b\n(3) c\n(4) d"
                      for n in range(1, 13))
    r = client.post("/api/rubrics/parse", data={"text": paper})
    assert called.get("yes") or r.json().get("code") == "ai_not_configured"  # the AI path, not the key-only one


def test_a_key_grid_with_many_rows_is_still_key_only(client, monkeypatch):
    """Each "Que. 1 2 3 ..." row read as a question stem used to send this to paid AI drafting."""
    monkeypatch.setattr(ai, "parse_rubric", lambda **_: (_ for _ in ()).throw(AssertionError("AI drafting called")))
    rows = [f"Que. {' '.join(str(n) for n in range(s, s + 10))}\nAns. {' '.join('1234'[n % 4] for n in range(s, s + 10))}"
            for s in range(1, 181, 10)]
    r = client.post("/api/rubrics/parse", data={"text": "\n".join(rows)})
    assert r.status_code == 200, r.text
    qs = r.json()["draft"]["questions"]
    assert len(qs) == 180 and qs[0]["subject"] == "Physics" and qs[179]["subject"] == "Biology"


def test_a_photo_of_a_key_becomes_an_mcq_rubric(client, monkeypatch, png_bytes):
    import answer_keys

    monkeypatch.setattr(ai, "parse_rubric", lambda **_: (_ for _ in ()).throw(AssertionError("AI drafting called")))
    seen = {}

    def read(data, text, *, on_usage=None):
        seen["image"] = data == png_bytes
        return answer_keys._extraction({n: "ABCD"[n % 4] for n in range(1, 181)}, source="image", method="ai",
                                       paper_code="Code A/P/W", warnings=[])

    monkeypatch.setattr(answer_keys, "extract", read)
    r = client.post("/api/rubrics/parse", files={"file": ("key.png", png_bytes, "image/png")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert seen["image"] and body["source"] == "image" and len(body["draft"]["questions"]) == 180
    assert body["draft"]["questions"][0]["correct_option"] == "B" and body["draft"]["paper_code"] == "Code A/P/W"


def test_the_answer_key_route_sends_multi_answer_and_bonus_entries(client):
    text = "ANSWER KEY\nQue. 1 2 3 4 5 6 7 8 9 10 11 12\nAns. 2 1 1 3 4 4 2 or 3 4 3 2 Bonus 1"
    r = client.post("/api/rubrics/answer-key", data={"text": text})
    assert r.status_code == 200, r.text
    by_q = {e["question"]: e for e in r.json()["entries"]}
    assert len(by_q) == 12 and by_q[1]["option"] == "B"
    assert by_q[7]["accepted_options"] == ["B", "C"] and by_q[7]["option"] is None
    assert by_q[11]["bonus"] is True
    assert not any("by hand" in w for w in r.json()["warnings"])
