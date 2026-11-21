"""Contract v3 acceptance: new read-time defaults, MCQ +4/-1 scoring end to end, rubric
validation, unchanged seed hashes, the insights demo set, faculty_lead, and the guarded hooks."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.conftest import _wav
from tests.test_contract import check_interface

RUBRICS = Path(__file__).resolve().parents[1] / "rubrics"
GENETICS_LEVELS = {1: "K3", 2: "K2", 3: "K2", 4: "K3", 5: "K1"}

MCQ_RUBRIC = {
    "name": "NEET MCQ check (sample)",
    "subject": "Biology",
    "marking_policy": {"negative_marks": 1, "scheme_name": "NEET +4/-1 (sample)"},
    "questions": [
        {"question": n, "topic": topic, "subject": "Biology", "max_marks": 4, "effort_hours": 2,
         "question_type": "mcq", "options": ["Nucleus", "Mitochondria", "Ribosome", "Golgi body"],
         "correct_option": "b", "prompt": f"Q{n}. Which organelle is the site of aerobic respiration?"}
        for n, topic in ((1, "Cell Organelles"), (2, "Cell Organelles"), (3, "Cell Cycle"))
    ],
}
MCQ_LETTERS = {1: "B", 2: "C"}  # Q3 left blank


def _completed_demo_ids(client) -> list[int]:
    return [s["id"] for s in client.get("/api/submissions").json() if s["status"] == "COMPLETED"]


# (a) seeded Genetics rows carry the v3 read-time defaults ----------------------------------
def test_genetics_demo_rows_have_v3_defaults(client):
    assert client.post("/api/demo/seed").json()["created"] == 13
    ids = _completed_demo_ids(client)
    assert ids
    for sub_id in ids[:3]:
        result = client.get(f"/api/results/{sub_id}").json()
        check_interface(result, "Result")
        assert result["llm_routes"] == [] and result["interventions"] == [] and result["voice"] is None
        patterns = result["patterns"]
        assert patterns["negative_marking"] is None and patterns["fatigue"] is None
        # Recall (Q2/3/5) vs transfer (Q1/4) on the Genetics paper gives a transfer profile.
        assert patterns["transfer"]["concepts"][0]["concept"] == "Genetics"
        assert {q["question"]: q["bloom_level"] for q in result["question_evaluations"]} == GENETICS_LEVELS
        for q in result["question_evaluations"]:
            assert q["bloom_source"] == "heuristic" and q["question_type"] == "descriptive"
            assert q["penalty"] == 0 and q["selected_option"] is None and q["marking_breakdown"] == []
        assert result["scoring_controls"]["marking_rule"].startswith("Partial credit in 0.5-mark steps")
        assert result["submission"]["input_kind"] == "document"


# (b) a live (faked) upload is a document with no detected languages -----------------------
def test_live_upload_is_a_document(upload, fake_ai, client):
    queued = upload(student_name="Contract V3")
    assert queued.status_code == 202, queued.text
    assert queued.json()["input_kind"] == "document" and queued.json()["detected_languages"] == []
    assert queued.json()["audio_seconds"] is None and queued.json()["voice_question"] is None
    result = client.get(f"/api/results/{queued.json()['id']}").json()
    check_interface(result, "Result")
    assert fake_ai.calls == {"preprocess": 1, "ocr": 1, "evaluation": 1} and fake_ai.structure_calls == 0
    q1 = result["question_evaluations"][0]
    assert q1["bloom_level"] == "K3" and q1["concept"] and q1["demonstrated_level"] is None


# (c) health ---------------------------------------------------------------------------------
def test_health_reports_voice_fallback_and_lms(client, monkeypatch):
    monkeypatch.delenv("LLM_FALLBACK", raising=False)
    monkeypatch.delenv("LLM_FALLBACK_MODEL", raising=False)
    monkeypatch.delenv("VOICE_ANSWERS", raising=False)
    body = client.get("/api/health").json()
    check_interface(body, "Health")
    assert body["voice_enabled"] is True and body["voice_ready"] is False  # no OpenAI key in tests
    assert body["accepted_voice_types"] == ["mp3", "wav", "m4a", "ogg"]
    assert body["accepted_upload_types"] == ["pdf", "jpeg", "png", "webp", "docx"]
    assert body["llm_fallback"] == "gpt-4o" and body["transcription_model"] == "gpt-transcribe"
    assert body["lms_api_enabled"] is True
    monkeypatch.setenv("LLM_FALLBACK", "0")
    monkeypatch.setenv("VOICE_ANSWERS", "off")
    body = client.get("/api/health").json()
    assert body["llm_fallback"] == "off" and body["voice_enabled"] is False


# (d) MCQ +4 / -1 / 0 --------------------------------------------------------------------------
def test_insights_scores_mcqs_plus_four_minus_one():
    import insights
    from ai_schemas import EvaluationOutput, OcrAnswer, QuestionGrade
    from schemas import RubricContentIn

    content = RubricContentIn.model_validate(MCQ_RUBRIC).model_dump(exclude_none=True)
    answers = [OcrAnswer(question=n, answer=letter, confidence=0.95) for n, letter in MCQ_LETTERS.items()]
    # The grader's marks are ignored for MCQs (deterministic option scoring).
    evaluation = EvaluationOutput(
        evaluations=[QuestionGrade(question=n, estimated_marks=4, evidence="x", strengths=[], gaps=[]) for n in (1, 2)],
        overall_strengths=[], overall_gaps=[],
    )
    report = insights.build_evaluation_report(content, answers, evaluation)
    by_q = {q["question"]: q for q in report["question_evaluations"]}
    assert [by_q[n]["estimated_marks"] for n in (1, 2, 3)] == [4.0, -1.0, 0.0]
    assert [by_q[n]["outcome"] for n in (1, 2, 3)] == ["FULL", "ZERO", "BLANK"]
    assert [by_q[n]["penalty"] for n in (1, 2, 3)] == [0.0, 1.0, 0.0]
    assert by_q[2]["selected_option"] == "C" and by_q[2]["correct_option"] == "B"
    assert by_q[2]["gaps"] == ["Chose C; correct B (-1)"] and by_q[3]["gaps"] == ["Not attempted"]
    assert by_q[1]["evidence"] == "Auto-scored MCQ: Correct option B (+4)"
    assert report["total_score"] == 3.0 and report["total_marks"] == 12.0
    cell = next(t for t in report["topic_mastery"] if t["topic"] == "Cell Organelles")
    assert cell["score"] == 3.0 and cell["mastery"] == 37.5


def test_negative_totals_clamp_mastery_to_zero():
    import insights
    from ai_schemas import EvaluationOutput, OcrAnswer
    from schemas import RubricContentIn

    content = RubricContentIn.model_validate(MCQ_RUBRIC).model_dump(exclude_none=True)
    answers = [OcrAnswer(question=n, answer="A", confidence=0.9) for n in (1, 2, 3)]
    report = insights.build_evaluation_report(content, answers, EvaluationOutput(evaluations=[], overall_strengths=[],
                                                                                 overall_gaps=[]))
    assert report["total_score"] == -3.0 and report["overall_mastery"] == 0.0
    assert all(t["mastery"] == 0.0 for t in report["topic_mastery"])


def test_mcq_rubric_upload_end_to_end(upload, fake_ai, client, monkeypatch):
    import ai
    from ai_schemas import OcrAnswer, OcrResult

    def letters_ocr(pages, rubric_content, **kwargs):
        fake_ai.calls["ocr"] += 1
        answers = [OcrAnswer(question=n, answer=f"({letter.lower()})", confidence=0.95)
                   for n, letter in MCQ_LETTERS.items()]
        return OcrResult(answers=answers, overall_confidence=0.95, provider="anthropic", model="fake-vision-model")

    monkeypatch.setattr(ai, "run_ocr", letters_ocr)
    queued = upload(student_name="MCQ Student", rubric_json=json.dumps(MCQ_RUBRIC))
    assert queued.status_code == 202, queued.text
    response = client.get(f"/api/results/{queued.json()['id']}")
    assert response.status_code == 200, response.text
    result = response.json()
    check_interface(result, "Result")
    rule = result["scoring_controls"]["marking_rule"]
    assert "+4" in rule and "-1" in rule and rule.startswith("NEET +4/-1 (sample)")
    by_q = {q["question"]: q for q in result["question_evaluations"]}
    assert [by_q[n]["penalty"] for n in (1, 2, 3)] == [0, 1, 0]
    assert [by_q[n]["estimated_marks"] for n in (1, 2, 3)] == [4, -1, 0]
    assert all(q["question_type"] == "mcq" for q in by_q.values())
    assert result["total_score"] == 3 and result["scoring_controls"]["parity"] is True
    rubric = client.get(f"/api/rubrics").json()
    stored = next(r for r in rubric if r["id"] == result["rubric"]["id"])["content"]
    assert stored["questions"][0]["correct_option"] == "B" and stored["questions"][0]["expected_answer"] == "Option B"


# (e) rubric validation ------------------------------------------------------------------------
def _with_question(**changes):
    rubric = json.loads((RUBRICS / "biology_genetics_v1.json").read_text(encoding="utf-8"))
    rubric["questions"][0].update(changes)
    return rubric


@pytest.mark.parametrize(
    ("rubric", "message"),
    [
        ({**MCQ_RUBRIC, "questions": [{**MCQ_RUBRIC["questions"][0], "correct_option": None}]}, "correct_option is required"),
        ({**MCQ_RUBRIC, "questions": [{**MCQ_RUBRIC["questions"][0], "correct_option": "E"}]}, "correct_option"),
        (_with_question(marking_scheme=[{"criterion": "Cross", "marks": 1}, {"criterion": "Ratio", "marks": 1}]),
         "Q1 marking_scheme marks (2) must add up to max_marks (4)"),
        (_with_question(bloom_level="K9"), "bloom_level must be K1-K5"),
        (_with_question(options=["a", "b"]), "only allowed when question_type is 'mcq'"),
        (_with_question(mark_step=0.3), "mark_step"),
    ],
)
def test_invalid_v3_rubrics_are_422(upload, forbid_ai, rubric, message):
    response = upload(rubric_json=json.dumps(rubric))
    assert response.status_code == 422, response.text
    assert response.json()["code"] == "invalid_rubric"
    assert message in response.json()["detail"]


def test_valid_v3_rubric_fields_round_trip():
    from schemas import RubricContentIn

    rubric = _with_question(
        bloom_level="apply", concept="Mendelian genetics", partial_credit="steps", mark_step=1,
        marking_scheme=[{"criterion": "Cross", "marks": 2, "required": True}, {"criterion": "Ratio", "marks": 2}],
    )
    q1 = RubricContentIn.model_validate(rubric).model_dump(exclude_none=True)["questions"][0]
    assert q1["bloom_level"] == "K3" and q1["mark_step"] == 1 and q1["marking_scheme"][0]["required"] is True
    mcq = RubricContentIn.model_validate(
        {**MCQ_RUBRIC, "questions": [{k: v for k, v in MCQ_RUBRIC["questions"][0].items() if k != "options"}]}
    ).model_dump(exclude_none=True)["questions"][0]
    assert mcq["grading_criteria"] == [
        "4 marks for option B; a wrong option follows the negative-marking rule; 0 if blank"
    ]


# (f) seeded rubric content and hashes are byte-identical to the JSON files --------------------
def test_seeded_rubric_hashes_are_unchanged(client):
    import hashing

    assert client.post("/api/demo/seed", params={"set": "all"}).json()["created"] == 27
    rubrics = {r["name"]: r for r in client.get("/api/rubrics").json()}
    for filename in ("biology_genetics_v1.json", "neet_mixed_mock08_v1.json"):
        content = json.loads((RUBRICS / filename).read_text(encoding="utf-8"))
        stored = rubrics[content["name"]]
        assert stored["content"] == content
        assert stored["rubric_hash"] == hashing.rubric_hash(content)


def test_rubric_questions_hash_only_changes_for_typed_questions():
    import hashing

    content = json.loads((RUBRICS / "biology_genetics_v1.json").read_text(encoding="utf-8"))
    view = [{"question": q["question"], "topic": q["topic"], "prompt": q.get("prompt")} for q in content["questions"]]
    assert hashing.rubric_questions_hash(content) == hashing.sha256_json(view)
    typed = {**content, "questions": [{**content["questions"][0], "question_type": "mcq"}, *content["questions"][1:]]}
    assert hashing.rubric_questions_hash(typed) != hashing.rubric_questions_hash(content)


def test_marking_policy_change_marks_every_shared_question_changed():
    import rubric_store

    old = {"questions": [{"question": 1, "topic": "a"}, {"question": 2, "topic": "b"}]}
    new = {**old, "marking_policy": {"negative_marks": 1}}
    assert rubric_store.compatibility(old, new)["changed"] == [1, 2]
    assert rubric_store.compatibility(old, {**old, "questions": [{"question": 1, "topic": "a", "bloom_level": "K3"},
                                                                 {"question": 2, "topic": "b"}]})["changed"] == [1]


# (g) demo sets ---------------------------------------------------------------------------------
def test_insights_demo_set_is_accepted_and_all_is_unchanged(client):
    assert client.post("/api/demo/seed", params={"set": "all"}).json()["created"] == 27
    response = client.post("/api/demo/seed", params={"set": "insights"})
    assert response.status_code == 200, response.text
    check_interface(response.json(), "DemoSeedResult")
    assert response.json()["created"] >= 0
    assert client.post("/api/demo/seed", params={"set": "bogus"}).status_code == 422


# (h) faculty lead --------------------------------------------------------------------------------
def test_batch_faculty_lead_round_trips_and_clears(client):
    batch_id = client.get("/api/health").json()["batch"]["id"]
    response = client.patch(f"/api/batches/{batch_id}", json={"faculty_lead": "  Dr.   Meera  Rao "})
    assert response.status_code == 200, response.text
    assert response.json()["faculty_lead"] == "Dr. Meera Rao"
    assert client.get("/api/health").json()["batch"]["faculty_lead"] == "Dr. Meera Rao"
    # other fields leave it alone
    assert client.patch(f"/api/batches/{batch_id}", json={"exam_date": None}).json()["faculty_lead"] == "Dr. Meera Rao"
    assert client.patch(f"/api/batches/{batch_id}", json={"faculty_lead": "x" * 121}).status_code == 422
    cleared = client.patch(f"/api/batches/{batch_id}", json={"faculty_lead": None}).json()
    assert cleared["faculty_lead"] is None
    check_interface(cleared, "Batch")


# (i) guarded hooks ---------------------------------------------------------------------------------
def test_a_failing_extension_hook_never_breaks_the_report_or_cohort(client, monkeypatch):
    import llm_route
    import patterns

    client.post("/api/demo/seed")
    sub_id = _completed_demo_ids(client)[0]

    def boom(*_args, **_kwargs):
        raise RuntimeError("extension hook bug")

    monkeypatch.setattr(patterns, "result_extras", boom)
    monkeypatch.setattr(patterns, "cohort_extras", boom)
    monkeypatch.setattr(llm_route, "result_extras", lambda *a, **k: {"llm_routes": [{"stage": "not-a-stage"}]})
    response = client.get(f"/api/results/{sub_id}")
    assert response.status_code == 200, response.text
    assert response.json()["patterns"] == patterns.empty_student_patterns()
    assert response.json()["llm_routes"] == []  # malformed payload -> default
    cohort = client.get("/api/cohort")
    assert cohort.status_code == 200 and cohort.json()["patterns"] == patterns.empty_cohort_patterns()


# voice read side + interfaces -----------------------------------------------------------------------
def test_voice_rows_expose_voice_info(client, db_session):
    from database import StudentSubmission

    client.post("/api/demo/seed")
    sub_id = _completed_demo_ids(client)[0]
    sub = db_session.get(StudentSubmission, sub_id)
    sub.input_kind, sub.audio_seconds, sub.voice_question, sub.detected_languages = "voice", 42.5, 1, ["en", "hi"]
    db_session.commit()
    result = client.get(f"/api/results/{sub_id}").json()
    check_interface(result, "Result")
    assert result["submission"]["input_kind"] == "voice"
    # Sample rows count the synthetic transcript (the stored answer text of the voice question).
    sample = client.get(f"/api/submissions/{sub_id}/transcript").json()["text"]
    assert sample
    assert result["voice"] == {
        "audio_url": None, "audio_seconds": 42.5, "detected_languages": ["en", "hi"], "transcription_model": None,
        "voice_question": 1, "transcript_chars": len(sample), "synthetic": True,
    }


def test_structure_transcript_question_hint_path(monkeypatch):
    import ai

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    content = json.loads((RUBRICS / "biology_genetics_v1.json").read_text(encoding="utf-8"))
    out = ai.structure_transcript("  Tall is dominant so the F1 shows 3:1.  ", content, question_hint=1,
                                  language_hints=["hi", "xx", "en"])
    assert [(a.question, a.answer, a.confidence, a.source) for a in out.answers] == [
        (1, "Tall is dominant so the F1 shows 3:1.", 0.85, "voice")
    ]
    assert out.provider == "openai" and out.model == "gpt-transcribe" and out.language_hints == ["hi", "en"]
    assert ai.structure_transcript("short", content, question_hint=2).answers[0].confidence == 0.5
    empty = ai.structure_transcript("   ", content, question_hint=2)
    assert empty.answers == [] and empty.overall_confidence == 0.0
    with pytest.raises(ValueError):
        ai.structure_transcript("text", content, question_hint=99)
    with pytest.raises(ai.AIConfigurationError):  # whole-paper mapping is a Claude call
        ai.structure_transcript("Question 1 ...", content)
    assert ai.fallback_available() is False and "simulated_outage" in ai.FALLBACK_TRIGGER_CODES


def test_voice_stubs_and_fakes(tmp_path, fake_ai, fake_transcriber):
    import ai
    import voice

    wav = tmp_path / "a.wav"
    wav.write_bytes(_wav(2.0))
    assert voice.wav_seconds(wav) == 2.0
    (tmp_path / "b.wav").write_bytes(b"not a wav")
    assert voice.wav_seconds(tmp_path / "b.wav") is None
    transcript = voice.transcribe(wav, "audio/wav", language_hints=["en"], keywords=["Punnett"])
    assert transcript.text.startswith("Question 1.") and fake_transcriber.calls == 1
    content = json.loads((RUBRICS / "biology_genetics_v1.json").read_text(encoding="utf-8"))
    mapped = ai.structure_transcript("Question 1 tall is dominant. Q3 semi-conservative replication.", content)
    assert [a.question for a in mapped.answers] == [1, 3] and fake_ai.structure_calls == 1


def test_real_voice_transcribe_needs_an_openai_key(tmp_path):
    import ai
    import voice

    with pytest.raises(ai.AIConfigurationError):
        voice.transcribe(tmp_path / "a.wav", "audio/wav", language_hints=["en"], keywords=[])


def test_llm_chain_status_stub_lists_the_providers():
    import llm_route
    from schemas import LlmChainStatus

    status = LlmChainStatus.model_validate(llm_route.chain_status(None))
    roles = [(p.provider, p.role) for p in status.providers]
    assert ("anthropic", "primary") in roles and ("openai", "fallback") in roles
    fallback = next(p for p in status.providers if p.role == "fallback" and p.provider == "openai")
    assert "not residency-approved" in fallback.residency_note.lower() and "2027-01-14" in (fallback.deprecation or "")


def test_outcomes_effectiveness_stub_is_schema_valid():
    import outcomes
    from schemas import InterventionEffectiveness

    eff = InterventionEffectiveness.model_validate(outcomes.effectiveness(None, institution_id=1))
    assert eff.records == 0 and eff.institution_id == 1 and "not assumed to cause" in eff.caveat
