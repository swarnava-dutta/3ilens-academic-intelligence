"""analytics.py: urgency rule, result extras (narrative, controls, study plan) on new and OLD rows,
cohort extras, and the analytics endpoints (plan / weightage / exams / batch patch)."""
from __future__ import annotations

import sys
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import analytics  # noqa: E402
from database import EvaluationResult, StudentSubmission, SubmissionStatus, ist_today  # noqa: E402
from tests.test_contract import check_interface  # noqa: E402

# V5 spec sample students: (score %, mastery over the 10 sample topics, expected urgency).
V5_TOPICS = [
    "Genetics", "Human Physiology", "Cell Biology", "Organic Chemistry", "Ecology",
    "Electrostatics", "Plant Physiology", "Mechanics", "Thermodynamics", "Chemical Bonding",
]
V5_STUDENTS = {
    "A01": (85.0, [62, 80, 76, 68, 88, 54, 72, 84, 66, 78], "on_track"),
    "A02": (66.4, [44, 66, 58, 46, 76, 39, 62, 70, 52, 61], "needs_attention"),
    "A03": (53.3, [29, 55, 38, 34, 66, 25, 46, 60, 40, 48], "at_risk"),
    "A04": (77.5, [64, 84, 83, 72, 78, 57, 79, 80, 74, 76], "on_track"),
    "B01": (62.6, [52, 68, 49, 43, 70, 48, 58, 74, 46, 56], "needs_attention"),
    "B02": (47.4, [31, 43, 32, 29, 55, 22, 39, 48, 34, 37], "at_risk"),
}


@pytest.fixture
def seeded(demo_data, client, db_session):
    assert client.post("/api/demo/seed").status_code == 200
    subs = db_session.query(StudentSubmission).order_by(StudentSubmission.id).all()
    completed = [s for s in subs if s.status == SubmissionStatus.COMPLETED]
    review = [s for s in subs if s.status == SubmissionStatus.HUMAN_REVIEW_REQUIRED]
    return SimpleNamespace(client=client, db=db_session, completed=completed, review=review)


# --------------------------------------------------------------------------- #
# Urgency rule
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("student", sorted(V5_STUDENTS))
def test_classify_urgency_reproduces_the_v5_sample_students(student):
    pct, mastery, expected = V5_STUDENTS[student]
    topics = [{"topic": name, "mastery": m} for name, m in zip(V5_TOPICS, mastery)]
    urgency, reasons = analytics.classify_urgency(pct, topics)
    assert urgency == expected
    assert reasons and f"{pct:g}%" in reasons[0]


def test_low_topics_move_one_level_worse_and_cap_at_at_risk():
    two_low = [{"topic": "A", "mastery": 30}, {"topic": "B", "mastery": 39.9}]
    assert analytics.classify_urgency(75, two_low)[0] == "needs_attention"
    assert analytics.classify_urgency(60, two_low)[0] == "at_risk"
    assert analytics.classify_urgency(40, two_low)[0] == "at_risk"
    urgency, reasons = analytics.classify_urgency(75, two_low[:1])
    assert urgency == "on_track" and "1 topic below 40%" in reasons[-1]


def test_seeded_genetics_demo_splits_5_3_4(seeded):
    cohort = seeded.client.get("/api/cohort").json()
    assert cohort["urgency_counts"] == {"on_track": 5, "needs_attention": 3, "at_risk": 4}
    counts = {"on_track": 0, "needs_attention": 0, "at_risk": 0}
    for sub in seeded.completed:
        counts[analytics.result_urgency(sub.result)[0]] += 1
    assert counts == cohort["urgency_counts"]


def test_days_to_exam_and_strategy_modes():
    assert [analytics.strategy_mode_for(d) for d in (None, 0, 6, 7, 29, 30, 89, 90, 400)] == [
        None, "consolidation", "consolidation", "revision", "revision", "focused", "focused", "broad", "broad",
    ]
    today = ist_today()
    batch = SimpleNamespace(exam_date=(today + timedelta(days=45)).isoformat())
    assert analytics.days_to_exam(batch, today=today) == 45
    assert analytics.days_to_exam(SimpleNamespace(exam_date=(today - timedelta(days=1)).isoformat())) is None
    assert analytics.exam_date_for(SimpleNamespace(exam_date=None)) == ("2027-05-02", True)


# --------------------------------------------------------------------------- #
# Result extras on a seeded demo row
# --------------------------------------------------------------------------- #
def _weakest(seeded) -> StudentSubmission:
    return min(seeded.completed, key=lambda s: s.result.total_score)


def test_result_for_a_demo_row_carries_the_narrative_and_the_plan(seeded):
    sub = _weakest(seeded)
    body = seeded.client.get(f"/api/results/{sub.id}").json()
    check_interface(body, "Result")

    score = f"{sub.result.total_score:g}/{sub.result.total_marks:g}"
    summary = body["executive_summary"]
    assert len(summary) == 3
    assert summary[0].startswith("5 of 5 rubric questions transcribed and mapped; mean OCR confidence ")
    assert summary[1].startswith(f"Draft result {score} (")
    assert "Strongest topic:" in summary[1] and "weakest topic:" in summary[1]
    assert summary[2].startswith("Highest-value actions: P1 ")
    assert summary[2].endswith("All prescriptions are provisional pending teacher review.")
    assert score in " ".join(summary)

    assert 2 <= len(body["teaching_nudges"]) <= 3
    counts = body["outcome_counts"]
    assert counts["total_questions"] == 5
    assert counts["full"] + counts["partial"] + counts["zero"] + counts["blank"] == 5
    (rollup,) = body["subject_rollup"]
    assert rollup["subject"] == "Biology" and rollup["questions"] == 5
    assert rollup["score"] == body["total_score"] and rollup["max_marks"] == body["total_marks"]

    controls = body["scoring_controls"]
    assert controls["parity"] is True and controls["llm_total_used"] is False
    assert controls["item_sum"] == controls["reported_total"] == body["total_score"]
    assert controls["marking_rule"] == analytics.MARKING_RULE
    assert body["roi_basis"]["forecast_status"] == "UNAVAILABLE" and body["roi_basis"]["calibrated"] is False

    plan = body["study_plan"]
    assert len(plan["focus"]) == 5 and len(plan["weekly_calendar"]) == 7 and len(plan["roadmap"]) == 4
    assert all(t["quadrant"] for t in plan["topics"])
    assert plan["weekly_calendar"][-1]["blocks"][0]["activity"] == "checkpoint"

    priorities = body["roi_recommendations"]
    assert priorities, "a weak student has ROI priorities"
    for p in priorities:
        assert p["calibrated"] is False and p["projected_gain_marks"] is not None
        assert p["gain_low"] <= p["projected_gain_marks"] <= p["gain_high"]
        assert p["trigger_questions"] and p["intervention"]["check_criterion"].startswith("≥4/5")
        assert p["qualitative_rank"] in range(1, len(priorities) + 1)
        assert "Illustrative matrix:" in p["rationale"]
    ranks = [t["priority_rank"] for t in body["topic_mastery"] if t["priority_rank"] is not None]
    assert sorted(ranks) == list(range(1, len(priorities) + 1))


def test_plan_endpoint_changes_mode_and_actions_with_days(seeded):
    sub = _weakest(seeded)
    far = seeded.client.get(f"/api/results/{sub.id}/plan", params={"days_to_exam": 120}).json()
    near = seeded.client.get(f"/api/results/{sub.id}/plan", params={"days_to_exam": 5, "study_hours": 10}).json()
    check_interface(far, "StudyPlan")
    check_interface(near, "StudyPlan")
    assert (far["strategy_mode"], near["strategy_mode"]) == ("broad", "consolidation")
    assert [t["action"] for t in far["focus"]] != [t["action"] for t in near["focus"]]
    assert near["study_hours"] == 10 and near["days_to_exam"] == 5


def test_plan_endpoint_validation_and_state(seeded):
    client = seeded.client
    sub = seeded.completed[0]
    assert client.get(f"/api/results/{sub.id}/plan", params={"days_to_exam": 401}).status_code == 422
    assert client.get(f"/api/results/{sub.id}/plan", params={"study_hours": 0}).status_code == 422
    review = seeded.review[0]
    response = client.get(f"/api/results/{review.id}/plan")
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"
    missing = client.get("/api/results/99999/plan")
    assert missing.status_code == 404 and missing.json()["code"] == "not_found"


# --------------------------------------------------------------------------- #
# Old rows (stored before contract v2) still get every extra
# --------------------------------------------------------------------------- #
LEGACY_QE_KEYS = ("question", "topic", "estimated_marks", "max_marks", "evidence", "strengths", "gaps",
                  "student_answer", "confidence")
LEGACY_TOPIC_KEYS = ("topic", "subject", "score", "max_marks", "mastery", "weightage", "effort_hours")
LEGACY_PRIORITY_KEYS = ("topic", "subject", "roi", "weightage", "gain_potential", "effort_hours", "rationale", "mastery")


def _strip_to_legacy(result: EvaluationResult) -> None:
    result.question_evaluations = [{k: q[k] for k in LEGACY_QE_KEYS} for q in result.question_evaluations]
    result.topic_mastery = [{k: t[k] for k in LEGACY_TOPIC_KEYS} for t in result.topic_mastery]
    result.roi_recommendations = [{k: p[k] for k in LEGACY_PRIORITY_KEYS} for p in result.roi_recommendations]
    result.summary = None
    result.teaching_nudges = None
    result.confusions = None
    result.rubric_hash = None


def test_result_extras_work_on_a_row_without_the_new_keys(seeded):
    sub = _weakest(seeded)
    _strip_to_legacy(sub.result)
    seeded.db.commit()

    extras = analytics.result_extras(
        seeded.db, sub=sub, result=sub.result, rubric=sub.rubric, batch=sub.batch, institution=sub.batch.institution
    )
    assert set(extras) == {
        "urgency", "urgency_reasons", "percentage", "summary", "executive_summary", "teaching_nudges", "confusions",
        "outcome_counts", "subject_rollup", "scoring_controls", "roi_basis", "study_plan", "topic_mastery",
        "roi_recommendations", "question_evaluations",
        # student report redesign
        "student_summary", "key_insights", "score_band", "focus_topics", "strengths_gaps",
    }
    assert extras["summary"] is None and extras["confusions"] == []
    assert [i["id"] for i in extras["key_insights"]] == ["attempts", "subjects", "gain"]
    assert extras["score_band"]["key"] == extras["urgency"] and extras["student_summary"]
    assert len(extras["executive_summary"]) == 3
    assert 2 <= len(extras["teaching_nudges"]) <= 3
    assert all(n["source"] == "template" for n in extras["teaching_nudges"])
    for q in extras["question_evaluations"]:
        assert q["outcome"] in ("FULL", "PARTIAL", "ZERO", "BLANK")
        assert q["source_pages"] == [] and q["uncertain_words"] == [] and q["corrected_by_faculty"] is False
    for t in extras["topic_mastery"]:
        assert t["n"] == len(t["questions"]) == t["full"] + t["partial"] + t["zero"] + t["blank"]
    for p in extras["roi_recommendations"]:
        assert p["trigger_questions"] and p["intervention"]["source"] == "template"

    body = seeded.client.get(f"/api/results/{sub.id}").json()
    check_interface(body, "Result")
    assert body["summary"] is None and len(body["study_plan"]["focus"]) == 5


def test_executive_summary_says_only_topic_only_for_one_topic():
    result = SimpleNamespace(total_score=0, total_marks=12)
    topics = [{"topic": "Genetics", "mastery": 0.0, "score": 0, "max_marks": 8},
              {"topic": "Ecology", "mastery": 0.0, "score": 0, "max_marks": 4}]
    line = analytics._executive_summary(result, [], topics, [], 0.0)[1]
    assert line == "Draft result 0/12 (0.0%). All 2 topics at 0.0%; most marks lost in Genetics (0/8)."
    one = analytics._executive_summary(result, [], topics[:1], [], 0.0)[1]
    assert one == "Draft result 0/12 (0.0%). Only topic assessed: Genetics (0/8)."


def test_stored_ai_narrative_is_passed_through(seeded):
    sub = _weakest(seeded)
    sub.result.summary = "  Weak on   DNA replication. "
    sub.result.teaching_nudges = [
        {"priority": "high", "label": "Contrast DNA models", "text": "Q3: draw the 15N bands.",
         "topic": "Molecular Basis of Inheritance", "question_refs": [3], "source": "ai"},
        {"priority": "urgent", "label": "Second nudge", "text": "Q2 recap."},
    ]
    sub.result.confusions = [{"concept_a": "Griffith", "concept_b": "Meselson-Stahl", "question": 3}]
    seeded.db.commit()
    body = seeded.client.get(f"/api/results/{sub.id}").json()
    assert body["summary"] == "Weak on DNA replication."
    assert [n["label"] for n in body["teaching_nudges"]] == ["Contrast DNA models", "Second nudge"]
    assert body["teaching_nudges"][1]["priority"] == "medium" and body["teaching_nudges"][1]["source"] == "ai"
    assert body["confusions"] == [
        {"concept_a": "Griffith", "concept_b": "Meselson-Stahl", "question": 3, "evidence": ""}
    ]


# --------------------------------------------------------------------------- #
# Cohort extras
# --------------------------------------------------------------------------- #
def test_cohort_extras_on_the_seeded_demo(seeded):
    cohort = seeded.client.get("/api/cohort").json()
    check_interface(cohort, "Cohort")
    ranking = cohort["ranking"]
    assert len(ranking) == 12 and [r["rank"] for r in ranking] == list(range(1, 13))
    assert [r["pct"] for r in ranking] == sorted((r["pct"] for r in ranking), reverse=True)
    assert len(cohort["at_risk"]) == 4
    for row in cohort["at_risk"]:
        assert row["reasons"] and row["top_gap"]
    errors = cohort["common_errors"]
    assert 1 <= len(errors) <= 8
    for error in errors:
        assert error["count"] >= 2 and error["denominator"] == 12 and len(error["students"]) == error["count"]
    assert [e["count"] for e in errors] == sorted((e["count"] for e in errors), reverse=True)
    interventions = cohort["interventions"]
    assert interventions and interventions[0]["action"].startswith("10-min re-teach + 5 unseen questions for ")
    assert all(i["students_count"] >= 1 and i["rationale"] for i in interventions)


def _pair(sub_id: int, name: str, gaps: dict[int, list[str]], confusions=None, pct: float = 50.0):
    sub = StudentSubmission(id=sub_id, student_name=name, student_ref=name.lower())
    questions = [
        {"question": n, "topic": f"Topic {n}", "estimated_marks": 1, "max_marks": 4, "student_answer": "x",
         "confidence": 0.9, "gaps": g, "strengths": []}
        for n, g in gaps.items()
    ]
    result = EvaluationResult(
        total_score=pct / 10, total_marks=10.0, overall_mastery=pct, question_evaluations=questions,
        topic_mastery=[{"topic": f"Topic {n}", "subject": "Biology", "mastery": 25.0} for n in gaps],
        roi_recommendations=[], confusions=confusions or [],
    )
    return sub, result


def test_common_errors_group_normalised_text_and_confusions_are_order_insensitive():
    pairs = [
        _pair(1, "Asha", {1: ["Named Griffith instead of Meselson-Stahl"], 2: ["Only once"]},
              [{"concept_a": "Incomplete dominance", "concept_b": "Codominance", "question": 2}]),
        _pair(2, "Bala", {1: ["  named griffith   INSTEAD of Meselson-Stahl "]},
              [{"concept_a": "codominance", "concept_b": "incomplete  dominance", "question": 2}]),
        _pair(3, "Chitra", {1: ["Named Griffith instead of Meselson-Stahl"], 3: ["Only once"]}),
    ]
    extras = analytics.cohort_extras(pairs=pairs, rubrics={}, batch=None)
    (error,) = extras["common_errors"]  # "Only once" appears on different questions -> not grouped
    assert error["question"] == 1 and error["count"] == 3 and error["denominator"] == 3
    assert error["students"] == ["Asha", "Bala", "Chitra"]
    (cluster,) = extras["confusion_clusters"]
    assert cluster["count"] == 2 and cluster["students"] == ["Asha", "Bala"]
    assert extras["urgency_counts"] == {"on_track": 0, "needs_attention": 0, "at_risk": 3}
    assert any(i["topic"] == "Incomplete dominance vs Codominance" for i in extras["interventions"])


# --------------------------------------------------------------------------- #
# Weightage, exams, batch patch
# --------------------------------------------------------------------------- #
def test_weightage_and_exams_endpoints(client):
    matrix = client.get("/api/weightage").json()
    check_interface(matrix, "WeightageMatrix")
    assert matrix["exam"] == "NEET" and matrix["illustrative"] is True and matrix["confidence"] == 0.3
    assert matrix["version"] == "neet-matrix-illustrative-2026.11" and matrix["total_marks"] == 720
    names = {c["chapter"]: c for c in matrix["chapters"]}
    payload_topics = {"Genetics": 24, "Human Physiology": 26, "Cell Biology": 18, "Organic Chemistry": 23,
                      "Ecology": 13, "Electrostatics": 21, "Plant Physiology": 17, "Mechanics": 25,
                      "Thermodynamics": 12, "Chemical Bonding": 17}
    for name, marks in payload_topics.items():
        assert names[name]["avg_marks"] == marks
    genetics_parts = ["Mendelian Inheritance", "Incomplete Dominance & Codominance", "Molecular Basis of Inheritance",
                      "Sex-linked Inheritance", "Chromosomal Disorders"]
    assert sum(names[n]["avg_marks"] for n in genetics_parts) == 24
    assert len({names[n]["avg_marks"] for n in genetics_parts}) >= 4  # the seeded topics no longer tie
    missing = client.get("/api/weightage", params={"exam": "JEE Main"})
    assert missing.status_code == 404 and missing.json()["code"] == "exam_not_available"

    exams = client.get("/api/exams").json()
    for exam in exams:
        check_interface(exam, "ExamOption")
    assert [e["exam"] for e in exams if e["enabled"]] == ["NEET"]
    assert {e["exam"] for e in exams} == {"NEET", "JEE Main", "JEE Advanced", "CAT", "UPSC"}
    assert all(e["note"] == "Matrix not loaded in this PoC" for e in exams if not e["enabled"])


def test_batch_patch_sets_and_resets_the_exam_date(client):
    batch = client.get("/api/health").json()["batch"]
    assert batch["exam_date_assumed"] is True
    date_45 = (ist_today() + timedelta(days=45)).isoformat()
    response = client.patch(f"/api/batches/{batch['id']}", json={"exam_date": date_45})
    assert response.status_code == 200, response.text
    body = response.json()
    check_interface(body, "Batch")
    assert body["exam_date"] == date_45 and body["exam_date_assumed"] is False
    assert body["days_to_exam"] == 45 and body["strategy_mode"] == "focused"
    assert client.get("/api/health").json()["batch"]["exam_date"] == date_45

    reset = client.patch(f"/api/batches/{batch['id']}", json={"exam_date": None}).json()
    assert reset["exam_date"] == "2027-05-02" and reset["exam_date_assumed"] is True
    # Omitting exam_date leaves it unchanged.
    assert client.patch(f"/api/batches/{batch['id']}", json={"exam": "neet"}).json()["exam"] == "NEET"

    for bad in ("2027-13-01", "next May", "2027-5-2", (ist_today() - timedelta(days=1)).isoformat()):
        response = client.patch(f"/api/batches/{batch['id']}", json={"exam_date": bad})
        assert response.status_code == 422 and response.json()["code"] == "invalid_date", bad
    response = client.patch(f"/api/batches/{batch['id']}", json={"exam": "JEE Main"})
    assert response.status_code == 422 and response.json()["code"] == "exam_not_available"
    response = client.patch("/api/batches/999", json={"exam_date": None})
    assert response.status_code == 404 and response.json()["code"] == "unknown_batch"


# --------------------------------------------------------------------------- #
# Student report redesign: report 1 (402/720, 180 MCQs) reproduced by tests/neet_report_fixture.py
# --------------------------------------------------------------------------- #
@pytest.fixture
def report1():
    from tests import neet_report_fixture as fx

    result, rubric, batch = fx.transient()
    extras = analytics.result_extras(None, sub=None, result=result, rubric=rubric, batch=batch, institution=None)
    return SimpleNamespace(result=result, rubric=rubric, batch=batch, extras=extras)


def _subject(extras, name):
    return next(s for s in extras["subject_rollup"] if s["subject"] == name)


def test_report1_score_identity_and_counts(report1):
    x = report1.extras
    qs = x["question_evaluations"]
    s = sum(q["estimated_marks"] for q in qs)
    p = sum(q["penalty"] for q in qs if q["result_kind"] != "bonus")
    assert (s, sum(q["max_marks"] for q in qs)) == (402, 720)
    assert x["scoring_controls"]["parity"] is True and x["percentage"] == 55.8
    counts = x["outcome_counts"]
    assert (counts["right"], counts["wrong"], counts["bonus"], counts["attempted"]) == (105, 26, 2, 131)
    assert counts["right"] + counts["wrong"] + counts["blank"] + counts["bonus"] == 180
    assert counts["full"] == 107 and counts["mapped"] == 133  # 'full' = 105 right + 2 bonus (faculty view)
    assert p == 26 and s + p == 428
    assert 4 * counts["right"] + 4 * counts["bonus"] - p == 402
    blank_marks = sum(q["max_marks"] for q in qs if q["result_kind"] == "blank")
    assert blank_marks == 188


def test_report1_subject_rollup(report1):
    x = report1.extras
    physics, chemistry, biology = (_subject(x, n) for n in ("Physics", "Chemistry", "Biology"))
    assert (physics["right"], physics["wrong"], physics["blank_scorable"], physics["bonus"]) == (18, 8, 19, 0)
    assert (physics["score"], physics["max_marks"], physics["pct"]) == (64, 180, 35.6)
    assert physics["attempted"] == 26 and physics["attempt_rate"] == pytest.approx(26 / 45, abs=1e-4)
    assert physics["accuracy_attempted"] == pytest.approx(18 / 26, abs=1e-4)
    assert physics["penalty"] == 8 and physics["marks_dropped"] == 116 and physics["gain_to_target"] == 89
    assert physics["band"] == "at_risk" and physics["diagnosis"] == "skipping"
    assert (chemistry["right"], chemistry["wrong"], chemistry["blank_scorable"], chemistry["bonus"]) == (19, 8, 17, 1)
    assert (chemistry["score"], chemistry["pct"], chemistry["bonus_marks"]) == (72, 40.0, 4)
    assert chemistry["attempt_rate"] == pytest.approx(27 / 44, abs=1e-4)
    assert chemistry["accuracy_attempted"] == pytest.approx(19 / 27, abs=1e-4) and chemistry["marks_dropped"] == 108
    assert (biology["right"], biology["wrong"], biology["blank_scorable"], biology["bonus"]) == (68, 10, 11, 1)
    assert (biology["score"], biology["max_marks"], biology["pct"]) == (266, 360, 73.9)
    assert biology["attempt_rate"] == pytest.approx(78 / 89, abs=1e-4)
    assert biology["accuracy_attempted"] == pytest.approx(68 / 78, abs=1e-4)
    assert biology["band"] == "on_track" and biology["diagnosis"] == "solid" and biology["gain_to_target"] == 40
    assert sum(s["marks_dropped"] for s in x["subject_rollup"]) == 720 - 402


def test_report1_score_band_is_the_urgency_band_with_the_bullet_geometry(report1):
    band = report1.extras["score_band"]
    assert band["key"] == report1.extras["urgency"] == "needs_attention" and band["label"] == "Needs attention"
    assert band["pct"] == 55.8
    assert [(t["key"], t["from_marks"], t["to_marks"]) for t in band["thresholds"]] == [
        ("at_risk", 0, 396), ("needs_attention", 396, 504), ("on_track", 504, 720)]
    assert (band["target_marks"], band["target_pct"], band["target_source"]) == (504, 70, "on_track_line")
    assert band["marks_to_target"] == 102 and band["right_answers_to_target"] == 26
    assert band["batch_median_marks"] is None  # no peers


def test_report1_key_insights(report1):
    i1, i2, i3 = report1.extras["key_insights"]
    assert (i1["id"], i2["id"], i3["id"]) == ("attempts", "subjects", "gain")
    assert i1["headline"] == "Skipping, not wrong answers, is holding your score back" and i1["tone"] == "warn"
    # A blank is worth a realistic guess, not its full marks: half the blanks narrowed to two options
    # is 23.5 x (0.5 x 4 - 0.5 x 1) = 35.25; 188 is only the ceiling. Break-even with +4/-1 is 1/5.
    assert i1["detail"] == (
        "47 questions left blank. With +4/−1 marking, answer whenever you can rule out one option "
        "(break-even is 20% sure): narrowing half the blanks to two options is worth about +35 marks, "
        "188 at most. You were right on 80.2% of what you answered (105 of 131); wrong answers cost only "
        "26 marks.")
    assert i1["highlight"] == "+35"
    figures = {f["key"]: f for f in i1["figures"]}
    assert (figures["blank"]["value"], figures["blank_marks"]["value"], figures["penalty"]["value"]) == (47, 188, 26)
    assert figures["likely_gain"]["value"] == 35 and figures["break_even"]["value"] == 20
    assert figures["score_without_wrong"]["value"] == 428 and figures["accuracy"]["value"] == 80.2
    assert figures["blank_marks"]["formula"] == "47 blank × 4 marks = 188 (only if every blank were right)"
    assert i1["evidence"]["filter"] == "blank" and len(i1["evidence"]["refs"]) == 47
    assert i1["evidence"]["anchor"] == "questions"

    assert i2["headline"] == "Physics is your weakest subject, mostly from skipping"
    assert i2["detail"] == ("Physics 64/180 (35.6%): you answered 26 of 45 and got 18 right (69.2%). "
                            "Strongest: Biology 266/360 (73.9%).")
    assert i2["evidence"]["kind"] == "subject" and i2["evidence"]["anchor"] == "subject-physics"

    # One target: the score card's On track line (70%, 504). Physics and Chemistry to 70% reach it.
    assert i3["headline"] == "Path to On track: Physics and Chemistry to 70%"
    assert i3["detail"] == ("Physics to 70% (126/180) adds +62 and Chemistry to 70% (126/180) adds +54: "
                            "402 + 116 = 518/720 (71.9%), past the On track line (504). Biology is already "
                            "at or above 70%.")
    gains = {f["key"]: f["value"] for f in i3["figures"]}
    assert gains == {"gain_physics": 62, "gain_chemistry": 54, "projected": 518, "target_line": 504}
    assert i3["evidence"]["anchor"] == "focus-physics" and i3["highlight"] == "518/720"
    for insight in (i1, i2, i3):
        assert len(insight["headline"]) <= 90


def test_report1_focus_topics_match_the_gain_insight(report1):
    focus = report1.extras["focus_topics"]
    assert focus["level"] == "subject" and focus["chapters_available"] is False
    assert focus["reason"] == "Chapter breakdown is not available for this paper yet."
    # Gains to the score card's target (70%); Biology (73.9%) is already there: keep warm, not focus.
    assert focus["target_pct"] == 70
    rows = focus["rows"]
    assert [(r["topic"], r["gain"]) for r in rows] == [("Physics", 62), ("Chemistry", 54)]
    assert focus["keep_warm"] == [{"topic": "Biology", "subject": "Biology", "mastery": 73.9}]
    for r in rows:
        assert r["gain"] <= r["max_marks"] - r["score"] == r["marks_dropped"]
        assert len(r["question_refs"]) == r["wrong"] + r["blank"]
        assert sorted(r["question_refs"]) == sorted(r["wrong_refs"] + r["blank_refs"])
        assert r["what_to_study"].count("Q") <= 6 and r["low_evidence"] is False
    physics, chemistry = rows
    assert (physics["right"], physics["wrong"], physics["blank"], physics["mastery"]) == (18, 8, 19, 35.6)
    # The action follows the diagnosis on the subject card: both are mostly skipped -> learn.
    assert physics["action"] == chemistry["action"] == "learn"
    kinds = {q["question"]: q["result_kind"] for q in report1.extras["question_evaluations"]}
    refs = physics["question_refs"]  # a topic to learn cites its blanks first, then the wrong answers
    assert all(kinds[n] == "blank" for n in refs[:19]) and all(kinds[n] == "wrong" for n in refs[19:])
    assert physics["what_to_study"].startswith("Learn the Physics basics behind the 19 you skipped (Q")
    assert "then redo the 8 you got wrong (Q" in physics["what_to_study"]
    plan_actions = {t["topic"]: t["action"] for t in report1.extras["study_plan"]["topics"]}
    mapping = {"learn": "learn", "drill": "drill", "fix_errors": "drill", "maintain": "review"}
    assert all(mapping[plan_actions[r["topic"]]] == r["action"] for r in rows)
    assert plan_actions["Biology"] == "maintain"  # solid, 'No action' quadrant: never 'Drill' / 'Fix errors'


def test_report1_study_plan_numbers(report1):
    plan = report1.extras["study_plan"]
    rows = {t["topic"]: t for t in plan["topics"]}
    assert (rows["Physics"]["gain_marks"], rows["Chemistry"]["gain_marks"], rows["Biology"]["gain_marks"]) == (
        89.0, 81.0, 40.0)
    for name, left in (("Physics", 116), ("Chemistry", 108), ("Biology", 94)):
        assert 0 <= rows[name]["gain_low"] <= rows[name]["gain_marks"] <= rows[name]["gain_high"] <= left
    assert plan["projected_score"]["expected"] == 85.0
    assert plan["projected_score"]["high"] < 100.0  # capped gains, not a clamped 100
    calendar_minutes = sum(b["minutes"] for d in plan["weekly_calendar"] for b in d["blocks"])
    assert plan["planned_minutes_total"] == calendar_minutes
    assert sum(t["minutes"] for t in plan["topics"]) + analytics.CHECKPOINT_MINUTES == calendar_minutes
    assert f"plans {calendar_minutes} min (" in plan["allocation_note"]
    # Biology is 'no_action' while Physics / Chemistry are priority_focus: one refresher block, never the most time.
    assert rows["Biology"]["quadrant"] == "no_action" and rows["Biology"]["minutes"] <= 30
    assert rows["Biology"]["minutes"] <= min(rows["Physics"]["minutes"], rows["Chemistry"]["minutes"])
    assert report1.extras["roi_basis"]["effort_source_kind"] == "placeholder"
    assert plan["days_to_exam"] == 156  # unclamped
    explanation = plan["explanation"]["arithmetic"]
    assert explanation.startswith("180 marks × (85 − 35.56)/100 × 1 ÷ 1 h = 89 ")
    # A weak topic's later review block is spaced recall, never 'maintenance'.
    for day in plan["weekly_calendar"]:
        for block in day["blocks"]:
            if block["topic"] in ("Physics", "Chemistry"):
                assert "Maintenance" not in block["note"] and block["note"].count("Q") <= 3


def test_report1_question_vocabulary_and_multi_answer_keys(report1):
    qs = {q["question"]: q for q in report1.extras["question_evaluations"]}
    assert (qs[51]["accepted_options"], qs[51]["selected_option"], qs[51]["result_kind"]) == (["B", "C"], "A", "wrong")
    assert qs[51]["correct_option"] == "B" and qs[51]["estimated_marks"] == -1
    assert (qs[53]["accepted_options"], qs[53]["result_kind"], qs[53]["estimated_marks"]) == (["A", "D"], "right", 4)
    assert (qs[111]["accepted_options"], qs[111]["result_kind"]) == (["A", "B"], "right")
    assert qs[112]["result_kind"] == "blank" and qs[112]["estimated_marks"] == 0
    assert qs[71]["result_kind"] == qs[98]["result_kind"] == "bonus" and qs[71]["estimated_marks"] == 4


def test_report1_student_summary_strengths_and_nudges(report1):
    x = report1.extras
    assert x["student_summary"] == [
        "You scored 402/720 (55.8%) — Needs attention. 102 marks to On track (504/720).",
        "Strongest: Biology 266/360 (73.9%). Weakest: Physics 64/180 (35.6%), mostly from skipping.",
        "Next step: learn Physics (+62 marks at 70%), then learn Chemistry (+54) — enough for On track.",
    ]
    assert not any("OCR" in line for line in x["student_summary"])
    assert x["strengths_gaps"]["strengths"][0] == "Biology: right on 68 of 78 answered"
    assert not any(line.startswith("Q") for key in ("strengths", "gaps") for line in x["strengths_gaps"][key])
    kinds = {q["question"]: q["result_kind"] for q in x["question_evaluations"]}
    for nudge in x["teaching_nudges"]:
        assert len(nudge["question_refs"]) <= 5
        cited = [kinds[n] for n in nudge["question_refs"]]
        assert cited == sorted(cited, key=lambda k: k != "wrong")  # wrong answers cited before blanks
        assert cited != ["blank"]  # a single blank is never the only evidence
    assert "Draft result 402/720 (55.8%)." in x["executive_summary"][1]
    assert "(105 right, 26 wrong, 2 bonus)" in x["executive_summary"][0]
    assert analytics.summary_line(report1.result, report1.rubric).startswith("Scored 402/720 (55.8%, needs attention)")


def test_report1_through_the_api_and_old_payload_defaults(client, upload, fake_ai, db_session):
    from schemas import QuestionEvaluationOut, ResultOut
    from tests import neet_report_fixture as fx

    sid = upload().json()["id"]
    fx.install(db_session, db_session.get(StudentSubmission, sid))
    body = client.get(f"/api/results/{sid}").json()
    ResultOut.model_validate(body)
    assert [i["id"] for i in body["key_insights"]] == ["attempts", "subjects", "gain"]
    assert body["score_band"]["marks_to_target"] == 102 and len(body["focus_topics"]["rows"]) == 2
    assert body["patterns"]["negative_marking"]["reconciliation"] == {"net_answered": 394, "bonus_marks": 8,
                                                                      "total": 402}
    # An older payload without the redesign keys still validates, with empty defaults.
    old = {k: v for k, v in body.items() if k not in ("key_insights", "score_band", "focus_topics", "student_summary")}
    restored = ResultOut.model_validate(old)
    assert restored.key_insights == [] and restored.score_band is None and restored.student_summary == []
    assert restored.focus_topics.rows == [] and restored.focus_topics.level == "subject"
    # A stored MCQ row from before result_kind / accepted_options gets both at validation time.
    legacy = {k: v for k, v in body["question_evaluations"][50].items() if k not in ("result_kind", "accepted_options")}
    q = QuestionEvaluationOut.model_validate(legacy)
    assert q.question == 51 and q.result_kind == "wrong" and q.accepted_options == ["B"]


def test_batch_median_needs_five_peers(seeded):
    sub = seeded.completed[0]
    peers = [s for s in seeded.completed if s.id != sub.id and s.rubric_id == sub.rubric_id
             and s.batch_id == sub.batch_id and bool(s.is_demo) == bool(sub.is_demo)]
    median = analytics.batch_median_marks(seeded.db, sub)
    if len(peers) >= analytics.BATCH_MEDIAN_MIN_PEERS:
        from statistics import median as med

        assert median == round(med(float(p.result.total_score) for p in peers), 2)
    else:
        assert median is None
    assert analytics.batch_median_marks(None, sub) is None
