"""Voice answers (BRD FR-1.8 / FR-2.8): audio intake, speech-to-text (OpenAI gpt-transcribe as a
labelled PoC stand-in, faked here), transcript mapping, the audio / transcript endpoints, errors,
retries and rescans. No test reaches a real provider."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.conftest import _png, _wav
from tests.test_contract import check_interface

AMR = b"#!AMR\n" + b"\x00" * 64


def uploads_left(tmp_path: Path) -> list[Path]:
    folder = tmp_path / "uploads"
    return [p for p in folder.iterdir() if p.is_file()] if folder.exists() else []


def voice_upload(upload, content: bytes | None = None, filename: str = "answer.wav", **form):
    return upload(filename=filename, content=_wav() if content is None else content, **form)


def result_of(client, submission_id: int) -> dict:
    return client.get(f"/api/results/{submission_id}").json()


def invocations(client, submission_id: int) -> list[dict]:
    return client.get(f"/api/submissions/{submission_id}/invocations").json()


# --------------------------------------------------------------------------- #
# End to end
# --------------------------------------------------------------------------- #
def test_wav_answer_for_one_question_end_to_end(upload, fake_ai, fake_transcriber, client, tmp_path):
    queued = voice_upload(upload, voice_question="1", language_hints="en,hi")
    assert queued.status_code == 202, queued.text
    sub = queued.json()
    check_interface(sub, "Submission")
    assert sub["input_kind"] == "voice" and sub["page_count"] is None and sub["voice_question"] == 1
    assert sub["audio_seconds"] == 1.0

    result = result_of(client, sub["id"])
    check_interface(result, "Result")
    submission = result["submission"]
    assert submission["status"] == "COMPLETED" and submission["detected_languages"] == ["en"]
    assert submission["page_count"] is None

    steps = [e["step"] for e in result["processing_log"]]
    first = {step: steps.index(step) for step in ("Transcription", "OCR & Parse", "Rubric Evaluation")}
    assert first["Transcription"] < first["OCR & Parse"] < first["Rubric Evaluation"]
    assert "Pre-processing" not in steps
    log = [e["message"] for e in result["processing_log"]]
    assert any(m.startswith("Received answer.wav (voice answer, WAV audio, 0:01, ") and "Answers Q1" in m for m in log)
    assert any("PoC stand-in for Whisper large-v3 / Sarvam Saarika" in m for m in log)
    assert any(m.startswith("Mapped the transcript to Q1 (1 answer(s)); detected language(s) en") for m in log)
    assert not any(fake_transcriber.text in m for m in log)  # the transcript is never logged

    # One recording per question: the hint path, no mapping call, no vision call.
    assert fake_ai.structure_calls == 1 and fake_ai.structure_kwargs[0]["question_hint"] == 1
    assert fake_ai.calls == {"preprocess": 0, "ocr": 0, "evaluation": 1}
    assert fake_ai.evaluation_kwargs[0]["answer_medium"] == "speech"
    assert fake_transcriber.kwargs[0]["language_hints"] == ["en", "hi"]
    assert "Mendelian Inheritance" in fake_transcriber.kwargs[0]["keywords"]
    purposes = [(i["purpose"], i["status"]) for i in invocations(client, sub["id"])]
    assert purposes == [("transcription", "ok"), ("evaluation", "ok")]

    assert result["voice"] == {
        "audio_url": f"/api/submissions/{sub['id']}/audio", "audio_seconds": 1.0, "detected_languages": ["en"],
        "transcription_model": "gpt-transcribe", "voice_question": 1,
        "transcript_chars": len(fake_transcriber.text), "synthetic": False,
    }
    extraction = result["extraction"]
    assert "speech-to-text" in extraction["ocr_adapter"] and "Claude transcript mapping" not in extraction["ocr_adapter"]
    assert extraction["flagged_pages"] == [] and extraction["page_confidences"] == []
    assert result["custody"]["verified"] is True and result["custody"]["mime_type"] == "audio/wav"
    q1 = next(q for q in result["question_evaluations"] if q["question"] == 1)
    assert q1["student_answer"] == fake_transcriber.text
    # Transcription has no price (cost unknown), so only the grading call is costed.
    assert result["cost"]["calls"] == 2 and result["cost"]["evaluation_inr"] > 0
    stored = json.loads((tmp_path / "artifacts" / str(sub["id"]) / "transcript.json").read_text(encoding="utf-8"))
    assert stored["text"] == fake_transcriber.text and stored["model"] == "gpt-transcribe"
    assert stored["request_id"] == "req_fake_tx_1" and stored["created_at"]


def test_whole_recording_is_mapped_by_the_ai(upload, fake_ai, fake_transcriber, client):
    fake_transcriber.text = (
        "Question 1. Tall is dominant so the F1 generation is all tall. "
        "Question 2. A test cross with the recessive parent reveals the genotype."
    )
    fake_transcriber.languages = ["hi", "en"]
    sub = voice_upload(upload, content=b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 64, filename="paper.mp3").json()
    assert sub["voice_question"] is None and sub["audio_seconds"] is None
    result = result_of(client, sub["id"])
    assert result["submission"]["status"] == "COMPLETED", result
    assert fake_ai.structure_calls == 1 and fake_ai.structure_kwargs[0].get("question_hint") is None
    answered = {q["question"]: q["student_answer"] for q in result["question_evaluations"] if q["student_answer"]}
    assert set(answered) == {1, 2} and answered[2].startswith("A test cross")
    purposes = [i["purpose"] for i in invocations(client, sub["id"])]
    assert purposes == ["transcription", "voice_mapping", "evaluation"]
    assert result["submission"]["detected_languages"] == ["hi", "en"]
    assert result["submission"]["audio_seconds"] == 12.5  # from the transcription when not a WAV
    assert result["extraction"]["ocr_adapter"].endswith(" + Claude transcript mapping")
    log = [e["message"] for e in result["processing_log"]]
    assert any(m.startswith("Mapped the transcript to Q1, Q2 (2 answer(s)); detected language(s) hi, en") for m in log)
    assert result["voice"]["voice_question"] is None


# --------------------------------------------------------------------------- #
# Audio and transcript endpoints
# --------------------------------------------------------------------------- #
def test_audio_and_transcript_endpoints(upload, fake_ai, fake_transcriber, client):
    audio = _wav(0.5)
    sub = voice_upload(upload, content=audio, voice_question="2").json()
    response = client.get(f"/api/submissions/{sub['id']}/audio")
    assert response.status_code == 200 and response.content == audio
    assert response.headers["content-type"] == "audio/wav"
    assert response.headers["content-disposition"] == "inline"

    transcript = client.get(f"/api/submissions/{sub['id']}/transcript")
    assert transcript.status_code == 200
    body = transcript.json()
    check_interface(body, "VoiceTranscript")
    assert body["text"] == fake_transcriber.text and body["detected_languages"] == ["en"]
    assert body["model"] == "gpt-transcribe" and body["audio_seconds"] == 0.5 and body["synthetic"] is False

    document = upload().json()
    for path, code in (("audio", "no_audio"), ("transcript", "no_transcript")):
        missing = client.get(f"/api/submissions/{document['id']}/{path}")
        assert missing.status_code == 404 and missing.json()["code"] == code
    assert client.get("/api/submissions/987654/audio").status_code == 404


def test_audio_outside_the_upload_folder_is_never_served(upload, fake_ai, fake_transcriber, client, db_session,
                                                         tmp_path):
    from database import StudentSubmission

    sub = voice_upload(upload, voice_question="1").json()
    outside = tmp_path / "secret.wav"
    outside.write_bytes(_wav())
    row = db_session.get(StudentSubmission, sub["id"])
    row.file_path = str(outside)
    db_session.commit()
    response = client.get(f"/api/submissions/{sub['id']}/audio")
    assert response.status_code == 404 and response.json()["code"] == "no_audio"


def test_sample_voice_rows_get_a_synthetic_transcript(client, db_session):
    from database import StudentSubmission

    client.post("/api/demo/seed")
    sub = db_session.query(StudentSubmission).filter(StudentSubmission.status == "COMPLETED").first()
    sub.input_kind, sub.voice_question = "voice", 1
    db_session.commit()
    body = client.get(f"/api/submissions/{sub.id}/transcript").json()
    check_interface(body, "VoiceTranscript")
    assert body["synthetic"] is True and body["model"] is None and body["text"]
    assert client.get(f"/api/submissions/{sub.id}/audio").json()["code"] == "no_audio"


# --------------------------------------------------------------------------- #
# Errors at intake (nothing stays in uploads/)
# --------------------------------------------------------------------------- #
def test_intake_errors(upload, forbid_ai, client, monkeypatch, tmp_path):
    monkeypatch.setenv("VOICE_ANSWERS", "0")
    off = voice_upload(upload)
    assert off.status_code == 415 and off.json()["code"] == "voice_disabled"
    monkeypatch.setenv("VOICE_ANSWERS", "1")

    amr = voice_upload(upload, content=AMR, filename="note.amr")
    assert amr.status_code == 415 and amr.json()["code"] == "unsupported_audio"

    corrupt = voice_upload(upload, content=b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x07" * 64)
    assert corrupt.status_code == 422
    assert corrupt.json() == {"detail": "The WAV file could not be read - it may be corrupt.", "code": "corrupt_audio"}

    for bad in ("99", "abc", "0"):
        response = voice_upload(upload, voice_question=bad)
        assert response.status_code == 422
        assert response.json() == {
            "detail": "voice_question must be one of the rubric's question numbers.", "code": "invalid_question",
        }
    assert uploads_left(tmp_path) == []
    assert client.get("/api/submissions").json() == []


def test_voice_question_is_checked_against_a_custom_rubric_and_ignored_for_documents(
    upload, fake_ai, fake_transcriber, client
):
    from tests.test_contract_v3 import MCQ_RUBRIC

    rubric = json.dumps(MCQ_RUBRIC)
    assert voice_upload(upload, voice_question="4", rubric_json=rubric).json()["code"] == "invalid_question"
    assert voice_upload(upload, voice_question="3", rubric_json=rubric).status_code == 202
    document = upload(voice_question="99")
    assert document.status_code == 202 and document.json()["voice_question"] is None
    assert document.json()["input_kind"] == "document"


def test_without_an_openai_key_the_real_transcriber_fails_cleanly(upload, fake_ai, no_network_clients, client):
    sub = voice_upload(upload, voice_question="1").json()  # the real voice.transcribe (no fixture)
    result = result_of(client, sub["id"])
    assert result["status"] == "FAILED"
    message = result["submission"]["error_message"]
    assert message.startswith("OPENAI_API_KEY is not configured (required for voice answers)")
    assert result["submission"]["last_error_code"] == "ai_not_configured"
    assert no_network_clients == [] and fake_ai.calls["evaluation"] == 0
    log = [(e["step"], e["message"]) for e in result["processing_log"]]
    assert log[-1][0] == "Dead-letter queue" and log[-1][1].startswith("Transcription failed")


def test_real_transcriber_maps_the_openai_response(isolated_env, monkeypatch, tmp_path):
    """voice.transcribe against a stand-in OpenAI client: request params, usage and languages."""
    import types

    import ai
    import voice

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
    sent: dict = {}

    def create(**params):
        sent.update(params)
        return types.SimpleNamespace(
            text=" Pehle F1 mein sab tall hote hain. ", _request_id="req_tx_1",
            languages=[types.SimpleNamespace(code="hi"), types.SimpleNamespace(code="en")],
            usage=types.SimpleNamespace(type="tokens", input_tokens=120, output_tokens=30),
        )

    client = types.SimpleNamespace(audio=types.SimpleNamespace(transcriptions=types.SimpleNamespace(create=create)))
    monkeypatch.setattr(ai, "_openai_client", lambda settings: client)
    audio = tmp_path / "a.m4a"
    audio.write_bytes(b"\x00\x00\x00\x20ftypM4A ")
    usages = []
    out = voice.transcribe(audio, "audio/mp4", language_hints=["hi", "en", "xx"],
                           keywords=["Genetics", "Genetics", " Punnett "], on_usage=usages.append)
    assert out.text == "Pehle F1 mein sab tall hote hain." and out.languages == ["hi", "en"]
    assert out.request_id == "req_tx_1" and out.model == "gpt-transcribe"
    assert sent["model"] == "gpt-transcribe" and sent["response_format"] == "json"
    assert sent["file"][0] == "answer.m4a" and sent["file"][2] == "audio/mp4"
    assert sent["languages"] == ["hi", "en"] and sent["keywords"] == ["Genetics", "Punnett"]
    assert [(u.purpose, u.status, u.input_tokens, u.output_tokens) for u in usages] == [("transcription", "ok", 120, 30)]

    monkeypatch.setenv("OPENAI_TRANSCRIBE_MODEL", "whisper-1")
    sent.clear()
    voice.transcribe(audio, "audio/mp4", language_hints=["ta"], keywords=["Genetics"])
    assert sent["language"] == "ta" and "languages" not in sent and "keywords" not in sent

    monkeypatch.setattr(client.audio.transcriptions, "create",
                        lambda **params: types.SimpleNamespace(text="  ", languages=None, usage=None))
    with pytest.raises(ai.AIServiceError) as exc:
        voice.transcribe(audio, "audio/mp4", language_hints=["en"], keywords=[])
    assert exc.value.code == "empty_transcript" and exc.value.transient is False


# --------------------------------------------------------------------------- #
# Retries, DLQ, review and rescan
# --------------------------------------------------------------------------- #
def test_transient_transcription_error_is_retried_then_completes(upload, fake_ai, fake_transcriber, client,
                                                                 monkeypatch):
    import ai
    import voice

    state = {"calls": 0}

    def flaky(path, mime_type, **kwargs):
        state["calls"] += 1
        if state["calls"] == 1:
            from ai_schemas import ModelUsage

            kwargs["on_usage"](ModelUsage(purpose="transcription", provider="openai", model_requested="gpt-transcribe",
                                          status="error", error_code="rate_limited"))
            raise ai.AIServiceError("OpenAI rate limit reached during transcription.", transient=True,
                                    code="rate_limited")
        return fake_transcriber(path, mime_type, **kwargs)

    monkeypatch.setattr(voice, "transcribe", flaky)
    sub = voice_upload(upload, voice_question="1").json()
    result = result_of(client, sub["id"])
    assert result["submission"]["status"] == "COMPLETED" and result["submission"]["attempts"] == 2
    assert state["calls"] == 2
    log = [e["message"] for e in result["processing_log"]]
    assert any("Attempt 2/3 after 0 s backoff (rate_limited" in m for m in log)
    statuses = [(i["purpose"], i["status"]) for i in invocations(client, sub["id"])]
    assert statuses == [("transcription", "error"), ("transcription", "ok"), ("evaluation", "ok")]


def test_failed_voice_answer_can_be_retried(upload, fake_ai, fake_transcriber, client):
    import ai

    fake_transcriber.error = ai.AIServiceError("The transcription returned no speech.", code="empty_transcript")
    sub = voice_upload(upload, voice_question="1").json()
    failed = result_of(client, sub["id"])
    assert failed["status"] == "FAILED" and failed["submission"]["last_error_code"] == "empty_transcript"

    fake_transcriber.error = None
    assert client.post(f"/api/submissions/{sub['id']}/retry").status_code == 202
    result = result_of(client, sub["id"])
    assert result["submission"]["status"] == "COMPLETED" and fake_transcriber.calls == 2


def test_short_voice_answer_is_held_then_reviewed_as_speech(upload, fake_ai, fake_transcriber, client, monkeypatch):
    import ai

    monkeypatch.setattr(ai, "ai_readiness", lambda: (True, []))
    fake_transcriber.text = "Tall."  # < 20 characters: confidence 0.5, below the gate
    sub = voice_upload(upload, voice_question="1").json()
    held = result_of(client, sub["id"])
    assert held["status"] == "HUMAN_REVIEW_REQUIRED"
    ocr = client.get(f"/api/submissions/{sub['id']}/ocr").json()
    assert ocr["has_transcript"] is True and ocr["pages"] == []
    assert next(a for a in ocr["answers"] if a["question"] == 1)["answer"] == "Tall."

    reviewed = client.post(f"/api/submissions/{sub['id']}/review",
                           json={"reviewer": "Dr. Rao", "action": "correct",
                                 "answers": [{"question": 1, "answer": "Tall is dominant over dwarf."}]})
    assert reviewed.status_code == 202, reviewed.text
    result = result_of(client, sub["id"])
    assert result["submission"]["status"] == "COMPLETED"
    assert fake_ai.evaluation_kwargs[-1]["answer_medium"] == "speech" and fake_transcriber.calls == 1


def test_rescan_keeps_the_kind_of_answer(upload, fake_ai, fake_transcriber, client, tmp_path):
    import ai

    fake_transcriber.error = ai.AIServiceError("Refused.", code="refusal")
    voice_sub = voice_upload(upload, voice_question="1").json()
    assert result_of(client, voice_sub["id"])["status"] == "FAILED"
    fake_transcriber.error = None
    url = f"/api/submissions/{voice_sub['id']}/rescan"
    mismatch = client.post(url, files={"file": ("sheet.png", _png(), "image/png")})
    assert mismatch.status_code == 422
    assert mismatch.json() == {
        "detail": "Upload the same kind of answer (voice or document) to replace this one.",
        "code": "input_kind_mismatch",
    }
    again = client.post(url, files={"file": ("retake.wav", _wav(2.0), "audio/wav")}, data={"reviewer": "Dr. Rao"})
    assert again.status_code == 202, again.text
    assert again.json()["audio_seconds"] == 2.0
    result = result_of(client, voice_sub["id"])
    assert result["submission"]["status"] == "COMPLETED" and result["submission"]["original_filename"] == "retake.wav"

    fake_ai.answer_confidence = 0.55  # a document held for review
    document = upload().json()
    assert result_of(client, document["id"])["status"] == "HUMAN_REVIEW_REQUIRED"
    wrong = client.post(f"/api/submissions/{document['id']}/rescan", files={"file": ("a.wav", _wav(), "audio/wav")})
    assert wrong.status_code == 422 and wrong.json()["code"] == "input_kind_mismatch"
    assert len(uploads_left(tmp_path)) == 2  # the retake and the document; rejected files removed


def test_interrupted_voice_jobs_are_recovered(upload, fake_ai, fake_transcriber, client, db_session):
    import pipeline
    from database import StudentSubmission

    sub = voice_upload(upload, voice_question="1").json()
    row = db_session.get(StudentSubmission, sub["id"])
    row.status = "PROCESSING"
    db_session.commit()
    assert pipeline.recover_interrupted_jobs(db_session) == 1
    assert client.post(f"/api/submissions/{sub['id']}/retry").status_code == 202
    assert result_of(client, sub["id"])["submission"]["status"] == "COMPLETED"


def test_script_languages_cover_code_switched_transcripts():
    import voice

    assert voice.script_languages("DNA replication semi-conservative होता है") == ["hi", "en"]
    assert voice.script_languages("ok") == [] and voice.script_languages("") == []
    assert voice.script_languages("இது ஒரு பதில்") == ["ta"]
