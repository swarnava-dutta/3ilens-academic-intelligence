"""Bloom K1-K5 detection (FR-3.9): ai.detect_bloom_levels and POST /api/rubrics/{id}/bloom-levels.
Offline: the Anthropic client is a fake; heuristic mode needs no key."""
from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import anthropic
import httpx2
import pytest

import ai
from tests.test_contract import check_interface

GENETICS_LEVELS = [("K3", 1), ("K2", 2), ("K2", 3), ("K3", 4), ("K1", 5)]


class FakeClaude:
    def __init__(self, reply: dict[str, Any] | None = None, error: Exception | None = None):
        self.reply, self.error, self.calls = reply, error, []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=json.dumps(self.reply))], stop_reason="end_turn",
            stop_details=None, model="claude-sonnet-5-5",
            usage=SimpleNamespace(input_tokens=600, output_tokens=200, iterations=None), _request_id="req_bloom",
        )


AI_REPLY = {"levels": [
    {"question": 1, "level": "K3", "rationale": "Asks to show a cross and derive ratios from it."},
    {"question": 2, "level": "K4", "rationale": "Distinguishing two inheritance patterns " + "word " * 40},
    {"question": 3, "level": "K9", "rationale": "Invalid level."},
    {"question": 5, "level": "remember", "rationale": "Recall of a definition and its cause."},
]}  # Q4 missing, Q3 invalid -> heuristic


def _genetics_id(client) -> int:
    rubrics = client.get("/api/rubrics").json()
    return next(r["id"] for r in rubrics if r["name"] == "Biology - Genetics")


def test_heuristic_mode_needs_no_key(client, forbid_ai):
    rubric_id = _genetics_id(client)
    response = client.post(f"/api/rubrics/{rubric_id}/bloom-levels", json={"mode": "heuristic"})
    assert response.status_code == 200, response.text
    body = response.json()
    check_interface(body, "BloomDetection")
    assert [(t["level"], t["question"]) for t in body["levels"]] == GENETICS_LEVELS
    assert all(t["source"] == "heuristic" and t["current_level"] is None for t in body["levels"])
    assert body["levels"][4]["rationale"] == "Verb 'state' -> K1 Remember (heuristic)"
    assert body["mode"] == "heuristic" and body["warnings"] == []


def test_ai_mode_errors(client):
    rubric_id = _genetics_id(client)
    response = client.post(f"/api/rubrics/{rubric_id}/bloom-levels", json={"mode": "ai"})
    assert response.status_code == 503 and response.json()["code"] == "ai_not_configured"
    response = client.post("/api/rubrics/99999/bloom-levels", json={"mode": "heuristic"})
    assert response.status_code == 404 and response.json()["code"] == "unknown_rubric"


def test_ai_mode_fills_invalid_levels_and_never_edits_the_rubric(client, db_session, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    fake = FakeClaude(AI_REPLY)
    monkeypatch.setattr(ai, "_anthropic_client", lambda _settings: fake)
    rubric_id = _genetics_id(client)
    before = client.get("/api/rubrics").json()

    body = client.post(f"/api/rubrics/{rubric_id}/bloom-levels", json={"mode": "ai"}).json()
    check_interface(body, "BloomDetection")
    tags = {t["question"]: t for t in body["levels"]}
    assert [(t["question"], t["level"], t["source"]) for t in body["levels"]] == [
        (1, "K3", "ai"), (2, "K4", "ai"), (3, "K2", "heuristic"), (4, "K3", "heuristic"), (5, "K1", "ai"),
    ]
    assert len(tags[2]["rationale"].split()) <= 26 and tags[2]["rationale"].endswith("...")  # capped at 25 words
    assert body["warnings"] == [
        "Q3: the AI returned an invalid level - heuristic K2 Understand used.",
        "Q4: the AI returned no level - heuristic K3 Apply used.",
    ]
    assert client.get("/api/rubrics").json() == before  # suggestions only

    (request,) = fake.calls
    assert request["output_config"]["effort"] == "low"
    assert request["output_config"]["format"]["schema"]["title"] == "BloomDetection"
    assert "what it ASKS" in request["system"]
    text = request["messages"][0]["content"][0]["text"]
    assert "Show the cross" in text and "Trisomy" not in text  # question text only, never the answer key

    from database import ModelInvocation

    (row,) = db_session.query(ModelInvocation).all()
    assert (row.purpose, row.status, row.submission_id) == ("bloom_detect", "ok", None)


def test_ai_failure_is_502_and_never_falls_back(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")  # a fallback is available, but bloom_detect never uses it
    monkeypatch.setattr(ai, "_anthropic_client",
                        lambda _s: FakeClaude(error=anthropic.APITimeoutError(
                            request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))))

    def no_openai(_settings):
        raise AssertionError("bloom_detect must not fall back")

    monkeypatch.setattr(ai, "_openai_client", no_openai)
    response = client.post(f"/api/rubrics/{_genetics_id(client)}/bloom-levels", json={"mode": "ai"})
    assert response.status_code == 502 and response.json()["code"] == "ai_failed"


def test_detect_bloom_levels_direct(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(ai, "_anthropic_client", lambda _s: FakeClaude({"levels": [
        {"question": 2, "level": "k5", "rationale": "Justify."}, {"question": 1, "level": "3", "rationale": "Apply."},
    ]}))
    out = ai.detect_bloom_levels([{"question": 2, "prompt": "Justify X."}, {"question": 1, "prompt": "Calculate Y."}])
    assert [(o["question"], o["level"], o["source"]) for o in out] == [(1, "K3", "ai"), (2, "K5", "ai")]
    assert ai.detect_bloom_levels([]) == []
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    with pytest.raises(ai.AIConfigurationError):
        ai.detect_bloom_levels([{"question": 1, "prompt": "x"}])
