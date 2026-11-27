"""Claude -> OpenAI fallback chain (FR-3.10). Offline: both SDK clients are fakes injected through
ai._anthropic_client / ai._openai_client, and every key is a test value."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace
import anthropic
import httpx2
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import ai  # noqa: E402
import seed  # noqa: E402
from ai import AIConfigurationError, AIServiceError  # noqa: E402
from ai_schemas import EvaluationOutput, ModelUsage, OcrAnswer, PreparedPage  # noqa: E402

GENETICS = seed.load_genetics_rubric()
REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")

EVALUATION_REPLY = {
    "evaluations": [
        {"question": n, "estimated_marks": 2, "evidence": "Student wrote ...", "strengths": ["s"], "gaps": ["g"],
         "criteria_awards": [], "demonstrated_level": "K2"}
        for n in range(1, 6)
    ],
    "overall_strengths": ["Accurate monohybrid crosses", "Correct notation"],
    "overall_gaps": ["Revise codominance", "Learn Meselson-Stahl"],
    "summary": "  Scored 10/20.\n   Weakest: Molecular Basis.  ",
    "teaching_nudges": [
        {"priority": "high", "label": f"Nudge {i}", "text": f"Q{i}: do this.", "topic": "", "question_refs": [i]}
        for i in range(1, 6)
    ],
    "topic_interventions": [],
    "confusions": [],
}
OCR_REPLY = {"answers": [{"question": 1, "answer": "Tt x tt", "confidence": 0.9, "pages": [1]}],
             "page_assessments": [{"page": 1, "legibility_confidence": 0.9}]}


# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #
def _status_error(cls, status: int, message: str = "boom"):
    response = httpx2.Response(status, request=REQUEST, json={"type": "error", "error": {"message": message}})
    return cls(message, response=response, body={"error": {"message": message}})


def _claude_reply(text: str | None, *, stop_reason: str = "end_turn"):
    content = [SimpleNamespace(type="text", text=text)] if text is not None else []
    return SimpleNamespace(
        content=content, stop_reason=stop_reason,
        stop_details=SimpleNamespace(category="bio") if stop_reason == "refusal" else None,
        model="claude-sonnet-5-5", usage=SimpleNamespace(input_tokens=100, output_tokens=50, iterations=None),
        _request_id="req_claude",
    )


class FakeClaude:
    def __init__(self, reply=None, error: Exception | None = None):
        self.reply, self.error, self.calls = reply, error, []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.reply


class FakeGPT:
    def __init__(self, content: str | None = None, error: Exception | None = None):
        self.content, self.error, self.calls = content, error, []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=self.content, refusal=None), finish_reason="stop")],
            model="gpt-4o-2024-08-06",
            usage=SimpleNamespace(prompt_tokens=900, completion_tokens=120, prompt_tokens_details=None),
            _request_id="req_gpt",
        )


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("VISION_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-5-5")
    for name in ("LLM_FALLBACK", "LLM_FALLBACK_MODEL", "LLM_SIMULATE_PRIMARY_OUTAGE", "ANTHROPIC_BASE_URL",
                 "OPENAI_BASE_URL"):
        monkeypatch.delenv(name, raising=False)


class Clients:
    def __init__(self, monkeypatch, claude: FakeClaude | None, gpt: FakeGPT | None):
        self.claude, self.gpt = claude, gpt
        self.built = {"anthropic": 0, "openai": 0}

        def anthropic_factory(_settings):
            if claude is None:
                raise AssertionError("the Anthropic client must not be constructed")
            self.built["anthropic"] += 1
            return claude

        def openai_factory(_settings):
            if gpt is None:
                raise AssertionError("the OpenAI client must not be constructed")
            self.built["openai"] += 1
            return gpt

        monkeypatch.setattr(ai, "_anthropic_client", anthropic_factory)
        monkeypatch.setattr(ai, "_openai_client", openai_factory)


def _answers() -> list[OcrAnswer]:
    return [OcrAnswer(question=1, answer="Tt x tt gives 1:1", confidence=0.9)]


def _pages() -> list[PreparedPage]:
    return [PreparedPage(page_number=1, media_type="image/png", data=b"png", path=Path("p1.png"))]


def _route(usages: list[ModelUsage]) -> list[tuple]:
    return [(u.provider, u.status, u.error_code, u.fell_back, u.model_requested) for u in usages]


# --------------------------------------------------------------------------- #
# Evaluation
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("error", "code"),
    [
        (anthropic.APITimeoutError(request=REQUEST), "timeout"),
        (_status_error(anthropic.InternalServerError, 500), "provider_unavailable"),
        (_status_error(anthropic.RateLimitError, 429), "rate_limited"),
    ],
)
def test_claude_failure_falls_back_to_gpt4o(monkeypatch, error, code):
    clients = Clients(monkeypatch, FakeClaude(error=error), FakeGPT(json.dumps(EVALUATION_REPLY)))
    usages: list[ModelUsage] = []
    evaluation = ai.run_evaluation(_answers(), GENETICS, on_usage=usages.append)

    assert isinstance(evaluation, EvaluationOutput) and len(evaluation.evaluations) == 5
    # Post-processed like a Claude reply: summary whitespace collapsed, nudges capped at 3.
    assert evaluation.summary == "Scored 10/20. Weakest: Molecular Basis."
    assert len(evaluation.teaching_nudges) == 3
    assert _route(usages) == [
        ("anthropic", "error", code, False, "claude-sonnet-5-5"),
        ("openai", "ok", None, True, "gpt-4o"),
    ]
    assert usages[1].model_served == "gpt-4o-2024-08-06" and usages[1].purpose == "evaluation"
    (request,) = clients.gpt.calls
    assert request["model"] == "gpt-4o" and request["response_format"] == {"type": "json_object"}
    assert request["max_completion_tokens"] == ai.OPENAI_MAX_COMPLETION_TOKENS
    system, user = request["messages"]
    assert system == {"role": "system", "content": ai.EVALUATION_SYSTEM_PROMPT}
    assert "<rubric>" in user["content"] and "<student_answers>" in user["content"]
    assert user["content"].endswith(ai.EVALUATION_JSON_KEYS_NOTE)
    assert "JSON" in user["content"]  # json_object mode requires the word JSON


def test_refusal_falls_back(monkeypatch):
    Clients(monkeypatch, FakeClaude(_claude_reply(None, stop_reason="refusal")), FakeGPT(json.dumps(EVALUATION_REPLY)))
    usages: list[ModelUsage] = []
    ai.run_evaluation(_answers(), GENETICS, on_usage=usages.append)
    assert [(u.provider, u.status, u.error_code) for u in usages] == [
        ("anthropic", "refusal", "refusal"), ("openai", "ok", None),
    ]


def test_auth_error_never_falls_back(monkeypatch):
    clients = Clients(monkeypatch, FakeClaude(error=_status_error(anthropic.AuthenticationError, 401)), None)
    with pytest.raises(AIServiceError) as excinfo:
        ai.run_evaluation(_answers(), GENETICS)
    assert excinfo.value.code == "auth" and clients.built["openai"] == 0


def test_missing_anthropic_key_never_falls_back(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    Clients(monkeypatch, None, None)
    with pytest.raises(AIConfigurationError):
        ai.run_evaluation(_answers(), GENETICS)


@pytest.mark.parametrize(("name", "value"), [("LLM_FALLBACK", "0"), ("OPENAI_API_KEY", "")])
def test_no_fallback_configured_raises_the_original_error(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    clients = Clients(monkeypatch, FakeClaude(error=anthropic.APITimeoutError(request=REQUEST)), None)
    assert ai.fallback_available() is False
    with pytest.raises(AIServiceError) as excinfo:
        ai.run_evaluation(_answers(), GENETICS)
    assert excinfo.value.code == "timeout" and excinfo.value.transient is True
    assert clients.built["openai"] == 0


def test_fallback_failure_raises_the_original_claude_error(monkeypatch):
    Clients(
        monkeypatch,
        FakeClaude(error=_status_error(anthropic.InternalServerError, 503)),
        FakeGPT("not json at all"),
    )
    usages: list[ModelUsage] = []
    with pytest.raises(AIServiceError) as excinfo:
        ai.run_evaluation(_answers(), GENETICS, on_usage=usages.append)
    assert excinfo.value.code == "provider_unavailable" and excinfo.value.transient is True
    assert "temporarily unavailable" in str(excinfo.value)
    assert isinstance(excinfo.value.__cause__, AIServiceError) and excinfo.value.__cause__.code == "invalid_json"
    assert _route(usages) == [
        ("anthropic", "error", "provider_unavailable", False, "claude-sonnet-5-5"),
        ("openai", "error", "invalid_json", True, "gpt-4o"),
    ]


def test_consistency_never_falls_back(monkeypatch):
    clients = Clients(monkeypatch, FakeClaude(error=anthropic.APITimeoutError(request=REQUEST)), None)
    with pytest.raises(AIServiceError, match="timed out"):
        ai.run_evaluation(_answers(), GENETICS, purpose="consistency")
    assert clients.built["openai"] == 0
    # The outage drill is ignored for a consistency re-grade: Claude is still called.
    with pytest.raises(AIServiceError):
        ai.run_evaluation(_answers(), GENETICS, purpose="consistency", simulate_outage=True)
    assert clients.built["anthropic"] == 2


def test_simulated_outage_skips_claude_entirely(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")  # the drill does not need a Claude key
    clients = Clients(monkeypatch, None, FakeGPT(json.dumps(EVALUATION_REPLY)))
    usages: list[ModelUsage] = []
    evaluation = ai.run_evaluation(_answers(), GENETICS, on_usage=usages.append, purpose="llm_drill",
                                   simulate_outage=True)
    assert len(evaluation.evaluations) == 5 and clients.built == {"anthropic": 0, "openai": 1}
    assert _route(usages) == [
        ("anthropic", "error", "simulated_outage", False, "claude-sonnet-5-5"),
        ("openai", "ok", None, True, "gpt-4o"),
    ]
    assert usages[0].latency_ms == 0 and {u.purpose for u in usages} == {"llm_drill"}


def test_simulated_outage_from_the_env_switch(monkeypatch):
    monkeypatch.setenv("LLM_SIMULATE_PRIMARY_OUTAGE", "1")
    monkeypatch.setenv("LLM_FALLBACK_MODEL", "gpt-4.1")
    clients = Clients(monkeypatch, None, FakeGPT(json.dumps(EVALUATION_REPLY)))
    usages: list[ModelUsage] = []
    ai.run_evaluation(_answers(), GENETICS, on_usage=usages.append)
    assert clients.gpt.calls[0]["model"] == "gpt-4.1" and usages[1].model_requested == "gpt-4.1"
    # An explicit simulate_outage=False overrides the env switch.
    clients.claude = None
    with pytest.raises(AssertionError, match="Anthropic client must not be constructed"):
        ai.run_evaluation(_answers(), GENETICS, simulate_outage=False)


def test_simulated_outage_without_a_fallback(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "")
    Clients(monkeypatch, None, None)
    usages: list[ModelUsage] = []
    with pytest.raises(AIServiceError) as excinfo:
        ai.run_evaluation(_answers(), GENETICS, on_usage=usages.append, simulate_outage=True)
    assert excinfo.value.code == "simulated_outage" and excinfo.value.transient is True
    assert "No fallback model is available" in str(excinfo.value)
    assert [(u.provider, u.error_code) for u in usages] == [("anthropic", "simulated_outage")]


# --------------------------------------------------------------------------- #
# OCR
# --------------------------------------------------------------------------- #
def test_ocr_falls_back_to_the_fallback_model(monkeypatch):
    clients = Clients(monkeypatch, FakeClaude(error=anthropic.APITimeoutError(request=REQUEST)),
                      FakeGPT(json.dumps(OCR_REPLY)))
    usages: list[ModelUsage] = []
    result = ai.run_ocr(_pages(), GENETICS, on_usage=usages.append)
    assert result.provider == "openai" and result.model == "gpt-4o-2024-08-06"
    assert [a.question for a in result.answers] == [1]
    request = clients.gpt.calls[0]
    assert request["model"] == "gpt-4o"  # settings.llm_fallback_model, not OPENAI_VISION_MODEL
    assert request["messages"][0]["content"] == ai.OCR_SYSTEM_PROMPT
    assert _route(usages) == [
        ("anthropic", "error", "timeout", False, "claude-sonnet-5-5"),
        ("openai", "ok", None, True, "gpt-4o"),
    ]
    assert usages[1].image_count == 1 and usages[1].purpose == "ocr"


def test_ocr_simulated_outage(monkeypatch):
    monkeypatch.setenv("LLM_SIMULATE_PRIMARY_OUTAGE", "true")
    clients = Clients(monkeypatch, None, FakeGPT(json.dumps(OCR_REPLY)))
    result = ai.run_ocr(_pages(), GENETICS)
    assert result.provider == "openai" and clients.built["anthropic"] == 0


def test_openai_vision_provider_has_no_reverse_fallback(monkeypatch):
    monkeypatch.setenv("VISION_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_VISION_MODEL", "gpt-4o-mini")
    clients = Clients(monkeypatch, None, FakeGPT(json.dumps(OCR_REPLY)))
    usages: list[ModelUsage] = []
    result = ai.run_ocr(_pages(), GENETICS, on_usage=usages.append)
    assert result.provider == "openai" and clients.gpt.calls[0]["model"] == "gpt-4o-mini"
    assert [(u.provider, u.fell_back) for u in usages] == [("openai", False)]


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("gpt-4o", "2027-01-14"),
        ("gpt-4o-2024-08-06", "2027-01-14"),
        ("gpt-4o-mini", "2027-01-14"),
        ("gpt-4o-transcribe", "2027-02-26"),
        ("gpt-4o-mini-transcribe", "2027-02-26"),
        ("whisper-1", "2027-02-26"),
        ("gpt-transcribe", None),
        ("gpt-4.1", None),
        ("claude-sonnet-5-5", None),
        ("", None),
    ],
)
def test_deprecation_dates_are_prefix_matched(model, expected):
    assert ai.deprecation_for(model) == expected


def test_fallback_trigger_codes_and_exclusions():
    assert "simulated_outage" in ai.FALLBACK_TRIGGER_CODES and "auth" not in ai.FALLBACK_TRIGGER_CODES
    assert set(ai.NO_FALLBACK_PURPOSES) == {"consistency", "rubric_parse", "bloom_detect"}


# --------------------------------------------------------------------------- #
# Voice transcript mapping
# --------------------------------------------------------------------------- #
def test_voice_mapping_falls_back(monkeypatch):
    reply = {"answers": [{"question": 1, "answer": "Tt x tt is a test cross", "confidence": 0.9}]}
    clients = Clients(monkeypatch, FakeClaude(error=_status_error(anthropic.InternalServerError, 529)),
                      FakeGPT(json.dumps(reply)))
    usages: list[ModelUsage] = []
    result = ai.structure_transcript("Question 1 Tt x tt is a test cross", GENETICS, on_usage=usages.append)
    assert result.provider == "openai" and result.model == "gpt-4o-2024-08-06"
    assert [(a.question, a.source) for a in result.answers] == [(1, "voice")]
    request = clients.gpt.calls[0]
    assert request["model"] == "gpt-4o" and request["response_format"] == {"type": "json_object"}
    assert "<transcript>" in request["messages"][1]["content"]
    assert [(u.purpose, u.provider, u.status, u.fell_back) for u in usages] == [
        ("voice_mapping", "anthropic", "error", False), ("voice_mapping", "openai", "ok", True),
    ]
