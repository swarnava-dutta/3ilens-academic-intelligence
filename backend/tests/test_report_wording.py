"""Report wording at read / render time: one number format, real minus signs, no raw codes."""
from __future__ import annotations

from types import SimpleNamespace

import analytics
import reports
import result_view
from tests import neet_report_fixture as fx


def test_stored_persistence_line_gets_the_one_decimal_share():
    sub = SimpleNamespace(result=SimpleNamespace(total_score=402.0, total_marks=720.0))
    entry = {"step": "Persistence", "message": "Saved as result v1: 402/720 marks, 56% mastery; LLM cost Rs 27.23.",
             "timestamp": "2026-11-27T00:08:50.959Z"}
    out = result_view._reworded(sub, entry)
    assert out["message"] == "Saved as result v1: 402/720 marks, 55.8% of the total; LLM cost Rs 27.23."
    other = {"step": "Ingestion", "message": "56% mastery", "timestamp": "x"}
    assert result_view._reworded(sub, other) is other  # only the Persistence line


def test_pdf_appendix_words_and_minus_signs():
    assert reports._gap_words("Chose A; correct B or C (-1)") == "Marked A · Accepted B or C · −1"
    assert reports._gap_words("Auto-scored MCQ: Marked A, correct D (-1)") == "Auto-scored MCQ: Marked A, correct D (−1)"
    assert reports._minus("+4 / -1: MCQs +4 correct, -1 wrong; Q111-Q112") == "+4 / −1: MCQs +4 correct, −1 wrong; Q111-Q112"
    wrong = SimpleNamespace(result_kind="wrong", outcome="ZERO", estimated_marks=-1.0)
    blank = SimpleNamespace(result_kind="blank", outcome="BLANK", estimated_marks=0.0)
    assert (reports._outcome_label(wrong), reports._outcome_label(blank)) == ("Wrong −1", "Blank 0")


def test_a_file_name_is_never_the_student_name():
    def result(name: str, file: str):
        return SimpleNamespace(submission=SimpleNamespace(student_name=name, original_filename=file))

    assert reports.student_name(result("2016 Editable (1)", "2016_Editable (1).pdf")) is None
    assert reports.student_name(result("Aarav Sharma", "sheet.pdf")) == "Aarav Sharma"


def test_report1_projected_steps_add_up_to_the_projection():
    result, rubric, batch = fx.transient()
    extras = analytics.result_extras(None, sub=None, result=result, rubric=rubric, batch=batch, institution=None)
    plan = extras["study_plan"]
    view = SimpleNamespace(
        study_plan=SimpleNamespace(focus=[SimpleNamespace(**t) for t in plan["focus"]]),
        topic_mastery=[SimpleNamespace(**t) for t in extras["topic_mastery"]],
    )
    steps = reports.projected_steps(view)
    assert [(t, round(g, 6)) for t, g in steps] == [("Physics", 89.0), ("Chemistry", 81.0), ("Biology", 40.0)]
    end = 402 + sum(g for _t, g in steps)
    assert round(end / 720 * 100, 1) == plan["projected_score"]["expected"] == 85.0
    # Broad-mode plan actions follow the diagnosis; the calendar never sends a weak topic to 'maintenance'.
    actions = {t["topic"]: t["action"] for t in plan["topics"]}
    assert actions == {"Physics": "learn", "Chemistry": "learn", "Biology": "maintain"}
