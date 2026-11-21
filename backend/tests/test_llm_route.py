"""LLM route provenance, chain status and the fallback drill (FR-3.10). Offline: fake SDK clients."""
from __future__ import annotations

import json
from types import SimpleNamespace

import anthropic
import httpx2
import pytest

import ai
import llm_route
from tests.test_contract import check_interface

REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


def _row(id_: int, purpose: str, provider: str, status: str = "ok", *, model: str | None = None,
         served: str | None = None, error_code: str | None = None, fell_back: bool = False) -> SimpleNamespace:
    model = model or ("claude-sonnet-5-5" if provider == "anthropic" else "gpt-4o")
    return SimpleNamespace(id=id_, purpose=purpose, provider=provider, model_requested=model, model_served=served,
                           status=status, error_code=error_code, fell_back=fell_back)


# --------------------------------------------------------------------------- #
# derive_routes
# --------------------------------------------------------------------------- #
def test_primary_ok():
    (route,) = llm_route.derive_routes([_row(1, "evaluation", "anthropic", served="claude-sonnet-5-5")])
    assert route == {
        "stage": "evaluation", "primary_provider": "anthropic", "primary_model": "claude-sonnet-5-5",
        "served_provider": "anthropic", "served_model": "claude-sonnet-5-5", "fell_back": False,
        "cross_vendor": False, "reason": None, "attempts": 1,
    }


def test_cross_vendor_fallback():
    (route,) = llm_route.derive_routes([
        _row(1, "ocr", "anthropic", "error", error_code="timeout"),
        _row(2, "ocr", "openai", served="gpt-4o-2024-08-06", fell_back=True),
    ])
    assert (route["served_provider"], route["served_model"]) == ("openai", "gpt-4o-2024-08-06")
    assert route["cross_vendor"] and route["fell_back"] and route["reason"] == "timeout" and route["attempts"] == 2


def test_claude_server_side_fallback_is_not_cross_vendor():
    (route,) = llm_route.derive_routes([_row(1, "evaluation", "anthropic", served="claude-sonnet-5", fell_back=True)])
    assert route["fell_back"] is True and route["cross_vendor"] is False and route["served_model"] == "claude-sonnet-5"


def test_ocr_cache_hit():
    (route,) = llm_route.derive_routes([_row(1, "ocr", "cache", "cache_hit", model="claude-sonnet-5-5")])
    assert route["served_provider"] == "cache" and route["reason"] == "ocr_cache_hit"
    assert route["primary_provider"] == "anthropic" and not route["cross_vendor"] and not route["fell_back"]


def test_all_failed_and_stage_order():
    routes = llm_route.derive_routes([
        _row(5, "evaluation", "anthropic", "error", error_code="provider_unavailable"),
        _row(6, "evaluation", "openai", "refusal", error_code="refusal", fell_back=True),
        _row(1, "ocr", "anthropic", served="claude-sonnet-5-5"),
        _row(0, "transcription", "openai", model="gpt-transcribe"),
    ])
    assert [r["stage"] for r in routes] == ["transcription", "ocr", "evaluation"]
    failed = routes[2]
    assert failed["served_provider"] is None and failed["served_model"] is None
    assert failed["reason"] == "refusal" and failed["attempts"] == 2 and failed["fell_back"] is False


# --------------------------------------------------------------------------- #
# Result hook, chain status
# --------------------------------------------------------------------------- #
def test_result_has_llm_routes_after_a_live_upload(upload, fake_ai, client):
    sub = upload(student_name="Route Check").json()
    result = client.get(f"/api/results/{sub['id']}").json()
    check_interface(result, "Result")
    routes = {r["stage"]: r for r in result["llm_routes"]}
    assert set(routes) == {"ocr", "evaluation"}
    for route in routes.values():
        check_interface(route, "LlmRoute")
        assert route["served_provider"] == "anthropic" and route["cross_vendor"] is False


def test_chain_status_matches_the_contract(client):
    body = client.get("/api/ops/llm-chain").json()
    check_interface(body, "LlmChainStatus")
    assert len(body["providers"]) == 4
    by_model = {p["model"]: p for p in body["providers"]}
    assert by_model["gemini-flash"]["configured"] is False and by_model["gemini-flash"]["stages"] == []
    fallback = by_model["gpt-4o"]
    assert fallback["role"] == "fallback" and fallback["configured"] is False  # no OpenAI key in tests
    assert "2027-01-14" in fallback["deprecation"] and "not residency-approved" in fallback["residency_note"].lower()
    assert "consistency" in by_model["claude-sonnet-5-5"]["stages"]
    assert body["trigger_codes"] == list(ai.FALLBACK_TRIGGER_CODES) and body["recent_fallbacks"] == []


# --------------------------------------------------------------------------- #
# Drill
# --------------------------------------------------------------------------- #
DRILL_REPLY = json.dumps({
    "evaluations": [{"question": 5, "estimated_marks": 3, "evidence": "Trisomy 21, two symptoms.",
                     "strengths": ["Names trisomy 21"], "gaps": ["No non-disjunction"],
                     "criteria_awards": [], "demonstrated_level": "K1"}],
    "overall_strengths": ["Cause stated"], "overall_gaps": ["Mechanism missing"],
})


class _FakeGPT:
    def __init__(self):
        self.calls = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=DRILL_REPLY, refusal=None), finish_reason="stop")],
            model="gpt-4o-2024-08-06", usage=SimpleNamespace(prompt_tokens=800, completion_tokens=100),
            _request_id="req_gpt",
        )


class _FailingClaude:
    def __init__(self):
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        raise anthropic.APITimeoutError(request=REQUEST)


@pytest.fixture
def drill_env(monkeypatch):
    for name in ("LLM_FALLBACK", "LLM_FALLBACK_MODEL", "LLM_SIMULATE_PRIMARY_OUTAGE"):
        monkeypatch.delenv(name, raising=False)


def test_drill_with_a_simulated_outage(client, monkeypatch, drill_env):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    gpt = _FakeGPT()

    def no_claude(_settings):
        raise AssertionError("the Anthropic client must not be constructed")

    monkeypatch.setattr(ai, "_anthropic_client", no_claude)
    monkeypatch.setattr(ai, "_openai_client", lambda _settings: gpt)
    response = client.post("/api/ops/llm-chain/drill", json={"simulate_outage": True})
    assert response.status_code == 200, response.text
    body = response.json()
    check_interface(body, "LlmDrillResult")
    assert body["ok"] is True and body["sample_marks"] == 3 and body["sample_max_marks"] == 4
    route = body["route"]
    assert route["stage"] == "llm_drill" and route["cross_vendor"] is True and route["reason"] == "simulated_outage"
    assert route["served_model"] == "gpt-4o-2024-08-06"
    assert [(c["provider"], c["status"], c["submission_id"]) for c in body["calls"]] == [
        ("anthropic", "error", None), ("openai", "ok", None),
    ]
    assert body["message"].startswith("Claude skipped (simulated outage) - graded by gpt-4o-2024-08-06 in ")
    # The drill answer, not the answer key, is what gets graded.
    assert "47 chromosomes. Symptoms are short stature" in gpt.calls[0]["messages"][1]["content"]
    # Both calls now show up in the chain's recent fallbacks.
    chain = client.get("/api/ops/llm-chain").json()
    assert [(r["provider"], r["error_code"]) for r in chain["recent_fallbacks"]] == [
        ("openai", None), ("anthropic", "simulated_outage"),
    ]


def test_drill_real_claude_failure_falls_back(client, monkeypatch, drill_env):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(ai, "_anthropic_client", lambda _settings: _FailingClaude())
    monkeypatch.setattr(ai, "_openai_client", lambda _settings: _FakeGPT())
    body = client.post("/api/ops/llm-chain/drill", json={"simulate_outage": False}).json()
    assert body["ok"] and body["route"]["reason"] == "timeout" and body["message"].startswith("Claude failed (timeout)")


def test_drill_error_codes(client, monkeypatch, drill_env):
    # No OpenAI key: a simulated outage has nowhere to go.
    response = client.post("/api/ops/llm-chain/drill", json={"simulate_outage": True})
    assert response.status_code == 409 and response.json()["code"] == "fallback_unavailable"
    # No Anthropic key and no simulated outage.
    response = client.post("/api/ops/llm-chain/drill", json={"simulate_outage": False})
    assert response.status_code == 503 and response.json()["code"] == "ai_not_configured"
    # Every route failed.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(ai, "_anthropic_client", lambda _settings: _FailingClaude())
    response = client.post("/api/ops/llm-chain/drill", json={})
    assert response.status_code == 502 and response.json()["code"] == "ai_failed"
    assert "timed out" in response.json()["detail"]
