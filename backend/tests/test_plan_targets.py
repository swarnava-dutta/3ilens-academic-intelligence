"""Study plan rows keep target mastery, gain and hours consistent.

Before the fix a focus topic that got 0 hours in a small window showed "37.5% -> 37.5%, +10.9
marks": the target was this window's partial step while gain_marks / effort_hours refer to 85%.
Now target_mastery is the level the gain and the base hours refer to, and the projected score
credits only the allocated share of each gap."""
from __future__ import annotations

import pytest

import analytics
from tests.test_study_plan import _ten_topic_profile


@pytest.mark.parametrize("student", ["A01", "A02", "B02"])
@pytest.mark.parametrize("days", [None, 3, 14, 45, 120])
@pytest.mark.parametrize("hours", [1, 6, 18])
def test_target_gain_and_hours_agree_on_every_row(student, days, hours):
    result, rubric, batch = _ten_topic_profile(student)
    plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=days, study_hours=hours)
    for t in plan["topics"]:
        assert t["target_mastery"] == pytest.approx(max(t["mastery"], analytics.TARGET_MASTERY), abs=0.05), t
        assert t["gain_marks"] == pytest.approx(t["exam_marks"] * (t["target_mastery"] - t["mastery"]) / 100, abs=0.02)
        if t["gain_marks"] > 0:
            assert t["target_mastery"] > t["mastery"] and t["effort_hours"] > 0, t
        assert 0 <= t["allocated_hours"] <= t["effort_hours"]


def test_a_focus_row_without_hours_this_window_no_longer_shows_a_flat_target():
    # 1 h/week over 5 focus topics: only the first topics get hours, the rest get 0 h.
    result, rubric, batch = _ten_topic_profile("A02")
    plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=45, study_hours=1)
    unfunded = [t for t in plan["focus"] if t["allocated_hours"] == 0]
    assert unfunded, "fixture should leave at least one focus topic without hours"
    for t in unfunded:
        assert t["gain_marks"] > 0 and t["target_mastery"] == analytics.TARGET_MASTERY > t["mastery"]


def test_projection_credits_only_the_allocated_share_of_each_gap():
    result, rubric, batch = _ten_topic_profile("A02")
    plan = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=45, study_hours=6)
    weight = sum(4.0 for _ in plan["topics"])  # every V5 topic is worth 4 marks in the fixture
    delta = sum(
        4.0 * min(1.0, t["allocated_hours"] / t["effort_hours"]) * (t["target_mastery"] - t["mastery"])
        for t in plan["focus"]
    ) / weight
    projection = plan["projected_score"]
    assert projection["expected"] == pytest.approx(min(100.0, projection["current"] + delta), abs=0.1)
    # A bigger budget funds more of the same gaps, so the projection never drops.
    bigger = analytics.build_study_plan(result=result, rubric=rubric, batch=batch, days_to_exam=45, study_hours=40)
    assert bigger["projected_score"]["expected"] >= projection["expected"]
