"""Preparation ROI engine v2 (analytics.build_study_plan): strategy modes, quadrants,
allocation, weekly calendar, roadmap and explanations. Pure and deterministic - no AI."""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import analytics  # noqa: E402
from database import Batch, EvaluationResult, Rubric, StudentSubmission, SubmissionStatus  # noqa: E402

DAYS = (120, 45, 14, 5)
EXPECTED_MODES = {120: "broad", 45: "focused", 14: "revision", 5: "consolidation"}

# The 10 V5 sample topics (subject, illustrative exam marks) and student A02's mastery profile.
V5_TOPICS = [
    ("Genetics", "Biology"), ("Human Physiology", "Biology"), ("Cell Biology", "Biology"),
    ("Organic Chemistry", "Chemistry"), ("Ecology", "Biology"), ("Electrostatics", "Physics"),
    ("Plant Physiology", "Biology"), ("Mechanics", "Physics"), ("Thermodynamics", "Physics"),
    ("Chemical Bonding", "Chemistry"),
]
V5_MASTERY = {
    "A01": [62, 80, 76, 68, 88, 54, 72, 84, 66, 78],
    "A02": [44, 66, 58, 46, 76, 39, 62, 70, 52, 61],
    "B02": [31, 43, 32, 29, 55, 22, 39, 48, 34, 37],
}


def _ten_topic_profile(student: str = "A02") -> tuple[EvaluationResult, Rubric, Batch]:
    """A transient (never saved) 10-topic mixed NEET result built from the V5 sample students."""
    topics, questions, rubric_questions = [], [], []
    for number, ((name, subject), mastery) in enumerate(zip(V5_TOPICS, V5_MASTERY[student]), start=1):
        score = round(4.0 * mastery / 100 * 2) / 2
        topics.append({"topic": name, "subject": subject, "score": score, "max_marks": 4.0, "mastery": float(mastery),
                       "weightage": 0.1, "effort_hours": 3.0, "chapter": name})
        questions.append({"question": number, "topic": name, "estimated_marks": score, "max_marks": 4.0,
                          "student_answer": f"answer {number}", "confidence": 0.93, "strengths": [],
                          "gaps": [] if score >= 4 else [f"Gap in {name}"], "evidence": "e"})
        rubric_questions.append({"question": number, "topic": name, "subject": subject, "chapter": name,
                                 "max_marks": 4, "expected_answer": "x", "grading_criteria": ["4 marks: x"],
                                 "effort_hours": 3})
    total = sum(t["score"] for t in topics)
    result = EvaluationResult(
        total_score=total, total_marks=40.0, overall_mastery=round(total / 40 * 100, 1), topic_mastery=topics,
        question_evaluations=questions, roi_recommendations=[], strengths_gaps={"strengths": [], "gaps": []},
        confusions=[], teaching_nudges=[],
    )
    rubric = Rubric(name="NEET mixed (sample)", version="v1", total_marks=40.0,
                    content={"name": "NEET mixed (sample)", "subject": "Mixed", "questions": rubric_questions})
    batch = Batch(name="NEET Alpha", exam_type="NEET", exam="NEET", exam_date=None)
    return result, rubric, batch


@pytest.fixture
def seeded(client, db_session):
    """The seeded Genetics demo cohort: (db, [completed submissions])."""
    assert client.post("/api/demo/seed").status_code == 200
    subs = [
        s for s in db_session.query(StudentSubmission).all()
        if s.status == SubmissionStatus.COMPLETED and s.result is not None
    ]
    assert len(subs) == 12
    return db_session, subs


def _plan_for(sub: StudentSubmission, **kwargs):
    return analytics.build_study_plan(result=sub.result, rubric=sub.rubric, batch=sub.batch, **kwargs)


def _signature(plan: dict) -> tuple:
    return tuple(t["topic"] for t in plan["focus"]), tuple(t["action"] for t in plan["focus"])


# --------------------------------------------------------------------------- #
# Acceptance 14.1: the recommendation changes with days to exam (120 / 45 / 14 / 5)
# --------------------------------------------------------------------------- #
def test_modes_and_recommendations_change_with_days_on_the_seeded_genetics_profiles(seeded):
    _db, subs = seeded
    with_gaps = 0
    for sub in subs:
        plans = {d: _plan_for(sub, days_to_exam=d) for d in DAYS}
        assert {d: p["strategy_mode"] for d, p in plans.items()} == EXPECTED_MODES
        for d, plan in plans.items():
            assert plan["days_to_exam"] == d
            assert plan["strategy_title"].startswith(f"{d} days left")
        if all(t["mastery"] >= analytics.TARGET_MASTERY for t in sub.result.topic_mastery):
            # Nothing below the 85% target: no focus topics, mixed practice only.
            assert all(p["focus"] == [] for p in plans.values())
            assert "no topic below 85%" in plans[45]["allocation_note"]
            continue
        with_gaps += 1
        signatures = [_signature(plans[d]) for d in DAYS]
        # Revision (fix_errors) and consolidation (maintain) always change the recommendation.
        assert len(set(signatures)) >= 3, f"{sub.student_name}: {signatures}"
        if analytics.result_urgency(sub.result)[0] != "on_track":
            # Students who need work: every horizon gives a different focus list or action set.
            assert len(set(signatures)) == len(DAYS), f"{sub.student_name}: {signatures}"
    assert with_gaps >= 10


@pytest.mark.parametrize("student", sorted(V5_MASTERY))
def test_modes_and_recommendations_change_with_days_on_a_ten_topic_profile(student):
    result, rubric, batch = _ten_topic_profile(student)
    plans = {d: analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=d) for d in DAYS}
    assert {d: p["strategy_mode"] for d, p in plans.items()} == EXPECTED_MODES
    assert len({_signature(p) for p in plans.values()}) == len(DAYS)
    actions = {d: {t["action"] for t in p["focus"]} for d, p in plans.items()}
    assert actions[45] == {"drill"} and actions[14] == {"fix_errors"} and actions[5] == {"maintain"}
    assert actions[120] <= {"learn", "drill"}
    # Mode rules (not just the multiplier) change the membership.
    assert all(t["mastery"] >= 50 or analytics.RESCUE_SIZE >= len(plans[5]["focus"]) for t in plans[5]["focus"])
    assert {t["topic"] for t in plans[120]["focus"]} != {t["topic"] for t in plans[45]["focus"]} or (
        actions[120] != actions[45]
    )


def test_broad_mode_reserves_a_slot_per_assessed_subject_with_a_gap():
    result, rubric, batch = _ten_topic_profile("A02")
    plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=120)
    assert {t["subject"] for t in plan["focus"]} == {"Biology", "Chemistry", "Physics"}
    assert any(t["action"] == "learn" for t in plan["focus"])  # Electrostatics 39% < 40%: foundational


def test_revision_mode_moves_large_or_foundational_topics_out():
    result, rubric, batch = _ten_topic_profile("A02")
    plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=14, study_hours=18)
    focus = {t["topic"] for t in plan["focus"]}
    for t in plan["focus"]:
        assert t["effort_hours"] <= 6 and t["mastery"] >= 40
    reasons = {d["topic"]: d["reason"] for d in plan["deprioritised"]}
    assert "Electrostatics" in reasons and "Electrostatics" not in focus  # 39% mastery
    assert reasons["Electrostatics"].startswith("No large new topics this close to the exam")


def test_revision_and_consolidation_never_leave_a_struggling_student_empty_handed():
    result, rubric, batch = _ten_topic_profile("B02")
    for days in (14, 5):
        plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=days)
        assert len(plan["focus"]) >= analytics.RESCUE_SIZE
        assert sum(t["allocated_hours"] for t in plan["focus"]) > 0
        assert "Fewer than 3 topics pass the cut-off" in plan["strategy_text"]


def test_unknown_exam_date_uses_the_focused_rule_with_factor_one(seeded):
    _db, subs = seeded
    sub = subs[0]
    sub.batch.exam_date = (date.today() - timedelta(days=3)).isoformat()  # past -> unknown
    plan = _plan_for(sub)
    assert plan["days_to_exam"] is None and plan["strategy_mode"] == "focused"
    assert all(t["time_factor"] == 1.0 for t in plan["topics"])
    assert plan["strategy_title"].startswith("Exam date unknown")
    assert all(stage["applicable"] for stage in plan["roadmap"])


def test_assumed_exam_date_is_reported(seeded):
    _db, subs = seeded
    plan = _plan_for(subs[0])
    assert plan["exam"] == "NEET" and plan["exam_date"] == "2027-05-02"
    assert "(assumed date)" in plan["strategy_text"]


# --------------------------------------------------------------------------- #
# Engine arithmetic, quadrants, ranges, flags, projection
# --------------------------------------------------------------------------- #
def test_quadrants_are_assigned_to_every_topic_by_the_relative_rule():
    result, rubric, batch = _ten_topic_profile("A02")
    plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=45)
    top = max(t["roi"] for t in plan["topics"])
    assert len(plan["topics"]) == 10
    for t in plan["topics"]:
        weak, high = t["mastery"] < 70, t["roi"] >= 0.5 * top
        expected = ("priority_focus" if weak else "maintain") if high else ("deprioritise" if weak else "no_action")
        assert t["quadrant"] == expected, t
        assert "Mastery" in t["quadrant_reason"] and "exam marks" in t["quadrant_reason"]
        assert "days to exam" in t["quadrant_reason"]


def test_engine_rows_follow_the_formula_and_the_matrix():
    result, rubric, batch = _ten_topic_profile("A02")
    plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=45)
    genetics = next(t for t in plan["topics"] if t["topic"] == "Genetics")
    assert genetics["exam_marks"] == 24 and genetics["chapter"] == "Genetics"
    assert genetics["effort_hours"] == 6  # 44% mastery -> the matrix from_mid band
    assert genetics["gain_marks"] == pytest.approx(24 * (85 - 44) / 100, abs=0.01)
    assert genetics["time_factor"] == pytest.approx(1 + 0.12 * 24 / 26, abs=0.001)
    assert genetics["roi"] == pytest.approx(genetics["gain_marks"] * genetics["time_factor"] / 6, abs=0.01)
    for t in plan["topics"]:
        assert 0 <= t["gain_low"] <= t["gain_marks"] <= t["gain_high"]
        assert t["mastery"] <= t["target_mastery"] <= max(85, t["mastery"])


def test_allocation_fits_the_budget_and_each_topic_effort():
    result, rubric, batch = _ten_topic_profile("A02")
    for hours in (6, 18, 40):
        plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=45, study_hours=hours)
        allocated = [t["allocated_hours"] for t in plan["focus"]]
        assert sum(allocated) <= hours
        for t in plan["focus"]:
            assert 0 <= t["allocated_hours"] <= t["effort_hours"]
        assert plan["allocation_note"].startswith(f"Next {hours:g} h: ")
        assert [t["rank"] for t in plan["focus"]] == list(range(1, len(plan["focus"]) + 1))
        assert len(plan["focus"]) == 5


def test_short_runway_pro_rates_the_weekly_hours():
    result, rubric, batch = _ten_topic_profile("A02")
    plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=3, study_hours=21)
    assert sum(t["allocated_hours"] for t in plan["focus"]) <= 9  # 21 h/week x 3/7
    assert "pro-rated" in plan["allocation_note"]


def test_effort_flags_over_investing_on_a_small_secure_chapter():
    result, rubric, batch = _ten_topic_profile("A01")
    plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=45)
    flags = {f["topic"]: f for f in plan["effort_flags"]}
    assert flags["Ecology"]["kind"] == "over_investing"  # 88% on a 13-mark chapter
    assert "20-minute weekly refresher" in flags["Ecology"]["message"]
    assert f"#1 {plan['focus'][0]['topic']}" in flags["Ecology"]["message"]


def test_projected_score_is_illustrative_and_ordered():
    result, rubric, batch = _ten_topic_profile("A02")
    plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=45)
    projection = plan["projected_score"]
    assert projection["label"] == "Illustrative - not a calibrated forecast"
    assert projection["current"] == analytics.percentage(result)
    assert projection["low"] <= projection["expected"] <= projection["high"] <= 100
    assert projection["expected"] > projection["current"]
    assert plan["calibrated"] is False and plan["matrix_version"] == "neet-matrix-illustrative-2026.11"


def test_explanation_shows_the_arithmetic_with_mastery_marks_and_days():
    result, rubric, batch = _ten_topic_profile("A02")
    plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=45)
    explanation = plan["explanation"]
    first = plan["focus"][0]
    assert explanation["topic"] == first["topic"]
    arithmetic = explanation["arithmetic"]
    assert arithmetic.startswith(f"{first['exam_marks']:g} marks x (85 - {first['mastery']:g})/100 x ")
    assert f"= {first['roi']:.2f}" in arithmetic
    for phrase in ("mastery", "exam marks", "45 days to exam"):
        assert phrase in arithmetic
    assert explanation["inputs"]["roi"] == first["roi"]
    assert "days to exam" in explanation["formula"]
    # Every other rationale also cites mastery, exam marks / weightage and days to exam.
    a01 = analytics.build_study_plan(result=_ten_topic_profile("A01")[0], rubric=rubric, batch=batch, days_to_exam=45)
    texts = [d["reason"] for d in plan["deprioritised"] + a01["deprioritised"]]
    texts += [t["quadrant_reason"] for t in plan["topics"]]
    texts += [f["message"] for f in plan["effort_flags"] + a01["effort_flags"]]
    assert a01["effort_flags"]
    for text in texts:
        assert "astery" in text and ("exam marks" in text or "-mark chapter" in text) and "45 days" in text, text


def test_revision_boosts_topics_with_confusions():
    result, rubric, batch = _ten_topic_profile("A02")
    base = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=14)
    result.confusions = [{"concept_a": "a", "concept_b": "b", "question": 3, "evidence": ""}]  # Q3 = Cell Biology
    boosted = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=14)
    before = next(t for t in base["topics"] if t["topic"] == "Cell Biology")
    after = next(t for t in boosted["topics"] if t["topic"] == "Cell Biology")
    assert after["time_factor"] == pytest.approx(before["time_factor"] * 1.25, abs=0.002)


def test_unmapped_topics_use_subject_weight_and_rubric_share():
    result, rubric, batch = _ten_topic_profile("A02")
    result.topic_mastery = [
        {**t, "topic": f"Custom {t['topic']}", "chapter": None, "weightage": None} for t in result.topic_mastery
    ]
    result.question_evaluations = [{**q, "topic": f"Custom {q['topic']}"} for q in result.question_evaluations]
    plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=45)
    physics = [t for t in plan["topics"] if t["subject"] == "Physics"]
    # Physics 0.25 x 720 marks, shared equally by the 3 Physics topics (4 of 12 rubric marks each).
    assert all(t["exam_marks"] == pytest.approx(0.25 * 720 / 3, abs=0.01) for t in physics)
    assert all(t["chapter"] is None for t in physics)


def test_plan_is_deterministic():
    result, rubric, batch = _ten_topic_profile("A02")
    first = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=30)
    second = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=30)
    assert first == second


# --------------------------------------------------------------------------- #
# Weekly calendar and roadmap
# --------------------------------------------------------------------------- #
def _check_calendar(plan: dict, rows: dict[str, dict]) -> None:
    calendar = plan["weekly_calendar"]
    heavy = {name for name, t in rows.items() if t["mastery"] < 40}
    previous_heavy: set[str] = set()
    for index, day in enumerate(calendar, start=1):
        assert day["day"] == index
        topics = {b["topic"] for b in day["blocks"]}
        if index == len(calendar) and len(calendar) >= 2:
            assert day["blocks"] == [day["blocks"][0]] and day["blocks"][0]["activity"] == "checkpoint"
            assert day["blocks"][0]["minutes"] == 45
            continue
        assert len(topics) <= 2, day
        assert len(topics & heavy) <= 1, day
        assert not (topics & heavy & previous_heavy), "a heavy topic on consecutive days"
        assert all(30 <= b["minutes"] <= 60 for b in day["blocks"])
        assert sum(b["minutes"] for b in day["blocks"]) <= analytics.MAX_DAY_MINUTES
        previous_heavy = topics & heavy & {t["topic"] for t in plan["focus"]}
    dates = [date.fromisoformat(day["date"]) for day in calendar]
    assert all((b - a).days == 1 for a, b in zip(dates, dates[1:]))


@pytest.mark.parametrize("days", DAYS)
def test_calendar_rules_on_the_ten_topic_profile(days):
    for student in V5_MASTERY:
        result, rubric, batch = _ten_topic_profile(student)
        plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=days)
        _check_calendar(plan, {t["topic"]: t for t in plan["topics"]})
        assert len(plan["weekly_calendar"]) == min(7, days)
        assert plan["weekly_calendar"][-1]["blocks"][0]["activity"] == "checkpoint"


def test_calendar_rules_on_the_seeded_profiles(seeded):
    _db, subs = seeded
    for sub in subs:
        plan = _plan_for(sub)
        assert len(plan["weekly_calendar"]) == 7
        _check_calendar(plan, {t["topic"]: t for t in plan["topics"]})
        assert plan["weekly_calendar"][0]["date"] == analytics.ist_today().isoformat()


def test_calendar_with_one_day_left_has_no_checkpoint_day():
    result, rubric, batch = _ten_topic_profile("A02")
    plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=1)
    assert len(plan["weekly_calendar"]) == 1
    assert all(b["activity"] != "checkpoint" for b in plan["weekly_calendar"][0]["blocks"])


@pytest.mark.parametrize(
    ("days", "applicable"),
    [(None, ["7", "30", "60", "90"]), (120, ["7", "30", "60", "90"]), (61, ["7", "30", "60", "90"]),
     (60, ["7", "30", "60"]), (31, ["7", "30", "60"]), (20, ["7", "30"]), (8, ["7", "30"]), (7, ["7"]), (2, ["7"])],
)
def test_roadmap_stages_and_applicability(days, applicable):
    result, rubric, batch = _ten_topic_profile("A02")
    if days is None:
        batch.exam_date = "2020-01-01"  # past -> unknown days
    plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=days)
    roadmap = plan["roadmap"]
    assert [s["horizon"] for s in roadmap] == ["7", "30", "60", "90"]
    assert [s["days_label"] for s in roadmap] == ["Days 1-7", "Days 8-30", "Days 31-60", "Days 61-90"]
    assert [s["title"] for s in roadmap] == [
        "Initial diagnostic correction", "Four-week consolidation", "Transfer across formats", "Syllabus consolidation",
    ]
    assert [s["horizon"] for s in roadmap if s["applicable"]] == applicable
    first = plan["focus"][0]["topic"]
    assert f"P1 {first}" in roadmap[0]["tasks"][0]
    assert all(s["checkpoint"] and s["condition"] for s in roadmap)
