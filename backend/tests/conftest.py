"""Shared fixtures. Every test runs against its own temp SQLite DB and temp upload/artifact
dirs (never backend/3ilens.db), with API keys blanked so no test can reach a real provider."""
from __future__ import annotations

import io
import sys
from pathlib import Path
from typing import Any, Callable

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# config.py loads the project .env (override=True) once, at first import. Import it now, before
# any fixture runs, so the per-test env overrides below always win over real keys in .env.
import config  # noqa: E402,F401


@pytest.fixture(autouse=True)
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("OCR_CACHE", "0")  # tests that exercise the cache opt in with monkeypatch
    monkeypatch.setenv("RETRY_BACKOFF_BASE_SECONDS", "0")
    monkeypatch.setenv("DOWNLOAD_LINK_SECRET", "test-secret")
    yield tmp_path
    import database

    database.dispose_engine()  # release the temp DB file (Windows file locks)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    """TestClient with lifespan (init_db + base seed). BackgroundTasks run before each call returns."""
    monkeypatch.setenv("OCR_CONFIDENCE_THRESHOLD", "0.80")
    monkeypatch.setenv("VISION_PROVIDER", "anthropic")
    from fastapi.testclient import TestClient

    import main

    with TestClient(main.app) as test_client:
        yield test_client


@pytest.fixture
def db_session(client):
    import database

    with database.SessionLocal() as session:
        yield session


# --------------------------------------------------------------------------- #
# Test files
# --------------------------------------------------------------------------- #
def _png(width: int = 64, height: int = 48) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, "PNG")
    return buffer.getvalue()


def _pdf(pages: int = 1) -> bytes:
    import pymupdf

    doc = pymupdf.open()
    for index in range(pages):
        page = doc.new_page()
        page.insert_text((72, 72), f"Answer sheet page {index + 1}")
    data = doc.tobytes()
    doc.close()
    return data


def _wav(seconds: float = 1.0) -> bytes:
    """A stdlib-wave mono 16 kHz 16-bit silence file."""
    import wave

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(b"\x00\x00" * int(16000 * seconds))
    return buffer.getvalue()


@pytest.fixture
def png_bytes() -> bytes:
    return _png()


@pytest.fixture
def wav_bytes() -> bytes:
    return _wav()


@pytest.fixture
def make_pdf() -> Callable[[int], bytes]:
    return _pdf


@pytest.fixture
def upload(client, png_bytes):
    """POST /api/upload helper: upload(filename=..., content=..., student_name=..., **form)."""

    def _upload(
        filename: str = "aarav_sheet.png",
        content: bytes | None = None,
        student_name: str | None = "Aarav Sharma",
        content_type: str = "application/octet-stream",
        **form: str,
    ):
        data = {k: v for k, v in form.items() if v is not None}
        if student_name is not None:
            data["student_name"] = student_name
        files = {"file": (filename, png_bytes if content is None else content, content_type)}
        return client.post("/api/upload", data=data, files=files)

    return _upload


# --------------------------------------------------------------------------- #
# AI / pre-processing fakes
# --------------------------------------------------------------------------- #
FAKE_MARKS = {1: 4.0, 2: 3.0, 3: 1.5, 4: 3.5, 5: 2.0}  # 14 / 20 on the Genetics rubric
FAKE_USAGE_MODEL = "claude-sonnet-5-5"  # priced in costing.PRICING_USD_PER_MTOK
FAKE_OCR_TOKENS = (1200, 300)  # (input, output) reported per fake OCR call
FAKE_EVALUATION_TOKENS = (2500, 800)  # (input, output) reported per fake grading call


def _report_usage(kwargs: dict[str, Any], **fields: Any) -> None:
    """Emit one fake ModelUsage through on_usage, like the real AI layer does per call."""
    on_usage = kwargs.get("on_usage")
    if on_usage is None:
        return
    from ai_schemas import ModelUsage

    on_usage(
        ModelUsage(
            provider="anthropic",
            model_requested=FAKE_USAGE_MODEL,
            model_served=FAKE_USAGE_MODEL,
            latency_ms=1500,
            **fields,
        )
    )


class FakeAI:
    """Stands in for preprocessing.preprocess_document, ai.run_ocr, ai.run_evaluation and
    ai.structure_transcript. `calls` keeps exactly {preprocess, ocr, evaluation} (tests pin it);
    the voice-mapping fake is counted in its own attribute (structure_calls)."""

    def __init__(self) -> None:
        self.calls = {"preprocess": 0, "ocr": 0, "evaluation": 0}
        self.structure_calls = 0
        self.structure_kwargs: list[dict[str, Any]] = []
        self.answer_confidence = 0.93
        self.preprocess_error: BaseException | None = None
        self.ocr_error: BaseException | None = None
        self.evaluation_error: BaseException | None = None
        self.extra_grade_question: int | None = None
        self.ocr_kwargs: list[dict[str, Any]] = []  # keyword arguments of each run_ocr call
        self.evaluation_kwargs: list[dict[str, Any]] = []

    def preprocess(
        self, file_path: Path, mime_type: str, artifact_dir: Path, log: Callable[[str], None], **kwargs: Any
    ):
        from ai_schemas import PreparedPage

        self.calls["preprocess"] += 1
        if self.preprocess_error:
            raise self.preprocess_error
        assert Path(file_path).is_file(), "pipeline must pass the stored upload path"
        log("Simulating Deskew and 300 DPI Contrast Enhancement.")
        artifact_dir.mkdir(parents=True, exist_ok=True)
        page_path = artifact_dir / "page-1.png"
        data = _png()
        page_path.write_bytes(data)
        return [PreparedPage(page_number=1, media_type="image/png", data=data, path=page_path)]

    def run_ocr(self, pages: list[Any], rubric_content: dict, **kwargs: Any):
        from ai_schemas import OcrAnswer, OcrResult

        self.calls["ocr"] += 1
        self.ocr_kwargs.append(dict(kwargs))
        if self.ocr_error:
            _report_usage(kwargs, purpose="ocr", status="error", error_code=getattr(self.ocr_error, "code", None))
            raise self.ocr_error
        _report_usage(
            kwargs, purpose="ocr", request_id=f"req_fake_ocr_{self.calls['ocr']}",
            input_tokens=FAKE_OCR_TOKENS[0], output_tokens=FAKE_OCR_TOKENS[1], image_count=len(pages),
        )
        answers = [
            OcrAnswer(
                question=q["question"],
                answer=f"Student answer for {q['topic']}.",
                confidence=self.answer_confidence,
            )
            for q in rubric_content["questions"]
        ]
        return OcrResult(
            answers=answers,
            overall_confidence=self.answer_confidence,
            provider="anthropic",
            model="fake-vision-model",
            raw_response='{"answers": []}',
            language_hints=list(kwargs.get("language_hints") or []),
        )

    def run_evaluation(self, answers: list[Any], rubric_content: dict, **kwargs: Any):
        from ai_schemas import EvaluationOutput, QuestionGrade

        self.calls["evaluation"] += 1
        self.evaluation_kwargs.append(dict(kwargs))
        purpose = kwargs.get("purpose", "evaluation")
        if self.evaluation_error:
            _report_usage(
                kwargs, purpose=purpose, status="error", error_code=getattr(self.evaluation_error, "code", None)
            )
            raise self.evaluation_error
        _report_usage(
            kwargs, purpose=purpose, request_id=f"req_fake_eval_{self.calls['evaluation']}",
            input_tokens=FAKE_EVALUATION_TOKENS[0], output_tokens=FAKE_EVALUATION_TOKENS[1],
        )
        grades = [
            QuestionGrade(
                question=a.question,
                estimated_marks=FAKE_MARKS.get(a.question, 2.0),
                evidence=f"Quoted working for Q{a.question}.",
                strengths=[f"Correct key term in Q{a.question}"],
                gaps=[] if FAKE_MARKS.get(a.question, 2.0) >= 4 else [f"Incomplete explanation in Q{a.question}"],
            )
            for a in answers
        ]
        if self.extra_grade_question is not None:
            grades.append(
                QuestionGrade(question=self.extra_grade_question, estimated_marks=1, evidence="?", strengths=[], gaps=[])
            )
        return EvaluationOutput(
            evaluations=grades,
            overall_strengths=["Accurate Punnett squares", "Clear sex-linked inheritance cross"],
            overall_gaps=["Meselson-Stahl experiment details missing", "Codominance example incorrect"],
        )

    def structure_transcript(self, transcript: str, rubric_content: dict, **kwargs: Any):
        """question_hint -> one answer; else split on 'question N' / 'qN' markers (no markers:
        everything goes to the first rubric question). Emits voice_mapping usage only without a hint."""
        import re

        from ai_schemas import OcrAnswer, OcrResult

        self.structure_calls += 1
        self.structure_kwargs.append(dict(kwargs))
        numbers = [q["question"] for q in rubric_content["questions"]]
        hint = kwargs.get("question_hint")
        text = (transcript or "").strip()
        pieces: dict[int, str] = {}
        if hint is not None:
            if hint not in numbers:
                raise ValueError(f"Question {hint} is not in the rubric.")
            if text:
                pieces[hint] = text
        else:
            _report_usage(kwargs, purpose="voice_mapping", request_id=f"req_fake_map_{self.structure_calls}",
                          input_tokens=400, output_tokens=120)
            marks = list(re.finditer(r"(?:question|q)\s*(\d+)", text, flags=re.IGNORECASE))
            if not marks:
                if text:
                    pieces[numbers[0]] = text
            for index, match in enumerate(marks):
                number = int(match.group(1))
                end = marks[index + 1].start() if index + 1 < len(marks) else len(text)
                chunk = text[match.end():end].strip(" .:-\n")
                if number in numbers and chunk:
                    pieces[number] = chunk
        answers = [
            OcrAnswer(question=n, answer=a, confidence=0.85 if len(a) >= 20 else 0.5, source="voice")
            for n, a in sorted(pieces.items())
        ]
        mean = sum(a.confidence for a in answers) / len(answers) if answers else 0.0
        return OcrResult(
            answers=answers, overall_confidence=mean, provider="openai", model="gpt-transcribe",
            language_hints=list(kwargs.get("language_hints") or []),
        )


class FakeTranscriber:
    """Stands in for voice.transcribe (FR-2.8). Emits one transcription ModelUsage per call."""

    def __init__(self) -> None:
        self.text = "Question 1. The F1 generation shows a 3:1 ratio because tall is dominant."
        self.languages = ["en"]
        self.seconds: float | None = 12.5
        self.error: BaseException | None = None
        self.calls = 0
        self.kwargs: list[dict[str, Any]] = []

    def __call__(self, path: Path, mime_type: str, **kwargs: Any):
        from ai_schemas import ModelUsage, Transcript

        self.calls += 1
        self.kwargs.append({"path": path, "mime_type": mime_type, **kwargs})
        on_usage = kwargs.get("on_usage")
        if on_usage is not None:
            on_usage(ModelUsage(
                purpose="transcription", provider="openai", model_requested="gpt-transcribe",
                model_served="gpt-transcribe", request_id=f"req_fake_tx_{self.calls}", latency_ms=900,
                status="error" if self.error else "ok", error_code=getattr(self.error, "code", None),
            ))
        if self.error:
            raise self.error
        return Transcript(text=self.text, model="gpt-transcribe", languages=list(self.languages),
                          seconds=self.seconds, request_id=f"req_fake_tx_{self.calls}")


@pytest.fixture
def fake_ai(monkeypatch: pytest.MonkeyPatch) -> FakeAI:
    import ai
    import preprocessing

    fake = FakeAI()
    monkeypatch.setattr(preprocessing, "preprocess_document", fake.preprocess)
    monkeypatch.setattr(ai, "run_ocr", fake.run_ocr)
    monkeypatch.setattr(ai, "run_evaluation", fake.run_evaluation)
    monkeypatch.setattr(ai, "structure_transcript", fake.structure_transcript)
    return fake


@pytest.fixture
def fake_transcriber(monkeypatch: pytest.MonkeyPatch) -> FakeTranscriber:
    import voice

    fake = FakeTranscriber()
    monkeypatch.setattr(voice, "transcribe", fake)
    return fake


@pytest.fixture
def forbid_ai(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Any pre-processing / AI / SDK-client call is recorded and fails loudly."""
    import ai
    import preprocessing

    calls: list[str] = []

    def forbidden(name: str):
        def _raise(*_args: Any, **_kwargs: Any):
            calls.append(name)
            raise AssertionError(f"{name} must not be called")

        return _raise

    monkeypatch.setattr(preprocessing, "preprocess_document", forbidden("preprocess_document"))
    monkeypatch.setattr(ai, "run_ocr", forbidden("run_ocr"))
    monkeypatch.setattr(ai, "run_evaluation", forbidden("run_evaluation"))
    monkeypatch.setattr(ai, "_anthropic_client", forbidden("anthropic client"), raising=False)
    monkeypatch.setattr(ai, "_openai_client", forbidden("openai client"), raising=False)
    monkeypatch.setattr(ai, "structure_transcript", forbidden("structure_transcript"), raising=False)
    monkeypatch.setattr(ai, "detect_bloom_levels", forbidden("detect_bloom_levels"), raising=False)
    import voice

    monkeypatch.setattr(voice, "transcribe", forbidden("voice.transcribe"), raising=False)
    return calls


@pytest.fixture
def no_network_clients(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Lets the real ai.run_* run but makes SDK client construction fail loudly."""
    import ai

    calls: list[str] = []

    def forbidden(*_args: Any, **_kwargs: Any):
        calls.append("client")
        raise AssertionError("no SDK client may be created in tests")

    monkeypatch.setattr(ai, "_anthropic_client", forbidden, raising=False)
    monkeypatch.setattr(ai, "_openai_client", forbidden, raising=False)
    return calls
