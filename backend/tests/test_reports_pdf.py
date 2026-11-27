"""Branded PDF reports (reports.py + GET /api/reports/{id}/pdf, GET /api/cohort/pdf): content,
footer / release state, watermarks, archived versions and the 409 / 404 guards."""
from __future__ import annotations

import pymupdf
import pytest

GENETICS_TOPICS = (
    "Mendelian Inheritance", "Incomplete Dominance & Codominance", "Molecular Basis of Inheritance",
    "Sex-linked Inheritance", "Chromosomal Disorders",
)
NUDGES = [
    {"priority": "high", "label": "Re-teach DNA replication", "text": "Walk through Meselson-Stahl with Q3.",
     "topic": "Molecular Basis of Inheritance", "question_refs": [3], "source": "ai"},
    {"priority": "medium", "label": "Drill sex-linked crosses", "text": "Five carrier-mother crosses (Q4).",
     "topic": "Sex-linked Inheritance", "question_refs": [4], "source": "ai"},
]


# Without TEXT_PRESERVE_LIGATURES, so MuPDF's shaped ligatures ("fi", "ffi") come back as letters.
TEXT_FLAGS = pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_MEDIABOX_CLIP


def pdf_text(data: bytes) -> str:
    """All page text, whitespace-normalised (table cells wrap lines)."""
    with pymupdf.open("pdf", data) as doc:
        return " ".join(" ".join(page.get_text(flags=TEXT_FLAGS).split()) for page in doc)


def norm(text: str) -> str:
    return " ".join(text.split())


def _plan_row(rank: int, topic: str) -> dict:
    return {
        "topic": topic, "subject": "Biology", "chapter": topic, "mastery": 30.0 + rank * 5, "exam_marks": 16.0,
        "gain_marks": 6.0 - rank * 0.5, "gain_low": 2.0, "gain_high": 9.0, "target_mastery": 85.0,
        "effort_hours": 4.0 + rank, "time_factor": 1.0, "roi": 2.0 - rank * 0.2, "quadrant": "priority_focus",
        "quadrant_reason": f"Weak topic {topic} with high return.", "action": "learn", "allocated_hours": 3.0,
        "rank": rank, "question_refs": [rank],
    }


@pytest.fixture
def rich_analytics(monkeypatch: pytest.MonkeyPatch):
    """Two teaching nudges and a study plan with five focus rows, whatever analytics returns."""
    import analytics

    real = analytics.result_extras

    def extras(db, **kwargs):
        out = real(db, **kwargs)
        out["teaching_nudges"] = [dict(n) for n in NUDGES]
        out["study_plan"] = {**out["study_plan"], "focus": [_plan_row(i, t) for i, t in enumerate(GENETICS_TOPICS, 1)]}
        return out

    monkeypatch.setattr(analytics, "result_extras", extras)


@pytest.fixture
def cohort_signals(monkeypatch: pytest.MonkeyPatch):
    """At least one common error and one class intervention, whatever analytics returns."""
    import analytics

    real = analytics.cohort_extras

    def extras(**kwargs):
        out = real(**kwargs)
        if not out.get("common_errors"):
            out["common_errors"] = [{"question": 3, "topic": "Molecular Basis of Inheritance",
                                     "error": "Named Griffith instead of Meselson and Stahl", "count": 2,
                                     "denominator": len(kwargs["pairs"]), "students": ["A", "B"]}]
        if not out.get("interventions"):
            out["interventions"] = [{"topic": "Molecular Basis of Inheritance", "action": "10-min re-teach",
                                     "students_count": 2, "rationale": "Shared gap"}]
        return out

    monkeypatch.setattr(analytics, "cohort_extras", extras)


def _completed_upload(upload, client) -> dict:
    sub = upload().json()
    result = client.get(f"/api/results/{sub['id']}")
    assert result.status_code == 200, result.text
    return result.json()


def test_student_pdf_from_a_live_upload_has_every_section(client, upload, fake_ai, rich_analytics):
    result = _completed_upload(upload, client)
    response = client.get(f"/api/reports/{result['submission']['id']}/pdf")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"] == 'attachment; filename="3iLens_Aarav-Sharma_Biology-Genetics_v1.pdf"'
    data = response.content
    assert data.startswith(b"%PDF-")
    with pymupdf.open("pdf", data) as doc:
        pages = doc.page_count
        assert pages >= 4
        for index, page in enumerate(doc, start=1):
            assert f"page {index}/{pages}" in page.get_text()  # stamped footer on every page
    text = pdf_text(data)

    assert "Student Academic Intelligence Report" in text
    assert "Aarav Sharma" in text and "Instit-42" in text
    assert "14/20" in text  # score / total
    for topic in GENETICS_TOPICS:
        assert norm(topic) in text, topic
    # 'In short' (the student summary) leads; the insights it already covers (weakest subject, next
    # step) are not repeated, as on the web.
    covered = {"subjects", "gain"} if len(result["student_summary"]) >= 3 else set()
    for insight in result["key_insights"]:
        assert (norm(insight["headline"]) in text) is (insight["id"] not in covered), insight["headline"]
    assert "In short" in text
    # Page 1 mirrors the web summary; the student's week, then faculty and processing material last.
    for heading in ("| Your score", "| Subjects", "| Where to focus", "| Questions", "| All chapters and topics",
                    "| Your study plan this week", "| Teaching actions (for faculty)",
                    "| Study plan lab (illustrative, for faculty)",
                    "| 7 / 30 / 60 / 90-day teaching roadmap (for faculty)", "Appendix A",
                    "| Processing, coverage and sign-off"):
        assert heading in text, heading
    assert (text.index("| Your study plan this week") < text.index("| Teaching actions (for faculty)")
            < text.index("| Study plan lab") < text.index("Appendix A") < text.index("Processing, coverage"))
    assert "POC" not in text and "rules engine" not in text
    for nudge in NUDGES:
        assert nudge["label"] in text
    # Next five topics: five ranked rows with projected marks and the illustrative label.
    assert "+marks projected" in text
    assert "Illustrative, unvalidated projection - coefficients not calibrated" in text
    for rank in range(1, 6):
        assert f"#{rank}" in text
    assert text.count(" marks (") >= 5  # '+5.5 marks (2-9)' per focus row
    # Run metadata, custody and the provisional state.
    assert result["report_meta"]["run_id"] in text
    assert result["custody"]["sha256"] in text
    assert "PROVISIONAL - teacher review pending" in text
    assert "DEMO DATA" not in text


def test_release_switches_the_footer_and_regenerates_the_cached_pdf(client, upload, fake_ai, isolated_env):
    result = _completed_upload(upload, client)
    sid = result["submission"]["id"]
    first = client.get(f"/api/reports/{sid}/pdf").content
    assert client.get(f"/api/reports/{sid}/pdf").content == first  # served from the artifact cache
    cached = list((isolated_env / "artifacts" / str(sid)).glob("report_r*_PROVISIONAL.pdf"))
    assert len(cached) == 1 and cached[0].read_bytes() == first

    released = client.post(f"/api/results/{sid}/release", json={"reviewer_name": "Dr Test", "note": "Checked"})
    assert released.status_code == 200, released.text
    after = client.get(f"/api/reports/{sid}/pdf").content
    assert after != first
    text = pdf_text(after)
    assert "RELEASED by Dr Test on" in text
    assert "PROVISIONAL - teacher review pending" not in text
    assert list((isolated_env / "artifacts" / str(sid)).glob("report_r*_RELEASED.pdf"))

    client.post(f"/api/results/{sid}/revoke", json={"reviewer_name": "Dr Test", "note": None})
    assert "PROVISIONAL - teacher review pending" in pdf_text(client.get(f"/api/reports/{sid}/pdf").content)


def test_demo_row_pdf_is_watermarked_demo_data(demo_data, client, rich_analytics):
    client.post("/api/demo/seed")
    subs = client.get("/api/submissions").json()
    demo = next(s for s in subs if s["status"] == "COMPLETED" and s["student_name"] == "Kabir Singh")
    response = client.get(f"/api/reports/{demo['id']}/pdf")
    assert response.status_code == 200
    assert response.content.startswith(b"%PDF-")
    text = pdf_text(response.content)
    assert "Kabir Singh" in text and "Instit-42" in text and "DEMO DATA" in text
    assert "synthetic demo record" in text
    assert "12/20" in text
    for topic in GENETICS_TOPICS:
        assert norm(topic) in text
    # Seeded confusions (Q2 / Q3 weak or Q1 partial tiers) flow into section 03.
    assert "Concept confusions observed" in text


def test_released_demo_rows_carry_the_sign_off(demo_data, client):
    client.post("/api/demo/seed")
    subs = client.get("/api/submissions").json()
    ananya = next(s for s in subs if s["student_name"] == "Ananya Iyer")
    text = pdf_text(client.get(f"/api/reports/{ananya['id']}/pdf").content)
    assert "RELEASED by Dr. A. Rao (demo)" in text


def test_pdf_requires_a_completed_result(client, upload, fake_ai):
    import ai

    review = upload(filename="rohan_blurry.jpg").json()
    response = client.get(f"/api/reports/{review['id']}/pdf")
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"

    fake_ai.ocr_error = ai.AIConfigurationError("ANTHROPIC_API_KEY is not configured.")
    failed = upload(filename="aarav.png").json()
    assert client.get(f"/api/results/{failed['id']}").json()["status"] == "FAILED"
    response = client.get(f"/api/reports/{failed['id']}/pdf")
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"

    missing = client.get("/api/reports/424242/pdf")
    assert missing.status_code == 404 and missing.json()["code"] == "unknown_submission"


def test_archived_version_renders_with_the_superseded_watermark(demo_data, client, db_session):
    import results_store
    import rubric_store
    from database import StudentSubmission
    from schemas import RubricContentIn
    from sqlalchemy import select

    client.post("/api/demo/seed")
    sub = db_session.scalar(select(StudentSubmission).where(StudentSubmission.student_name == "Diya Reddy"))
    old_rubric = sub.rubric
    new_rubric = rubric_store.create_rubric(
        db_session, RubricContentIn.model_validate(old_rubric.content), parent=old_rubric, change_note="test v2"
    )
    report = results_store.result_payload(sub.result)
    results_store.archive_current_result(db_session, sub, superseded_by_rubric_id=new_rubric.id)
    sub.result = results_store.build_evaluation_result(report, rubric=new_rubric, version=2)
    db_session.commit()
    assert new_rubric.version == "v2"

    old = client.get(f"/api/reports/{sub.id}/pdf", params={"version": 1})
    assert old.status_code == 200, old.text
    assert "superseded-v1" in old.headers["content-disposition"]
    text = pdf_text(old.content)
    assert "SUPERSEDED by rubric v2" in text and "Diya Reddy" in text

    current = client.get(f"/api/reports/{sub.id}/pdf", params={"version": 2})
    assert current.status_code == 200
    assert "SUPERSEDED" not in pdf_text(current.content)
    unknown = client.get(f"/api/reports/{sub.id}/pdf", params={"version": 7})
    assert unknown.status_code == 404 and unknown.json()["code"] == "unknown_version"


def test_cohort_pdf_has_ranking_topics_denominator_errors_and_interventions(demo_data, 
    client, upload, fake_ai, cohort_signals
):
    client.post("/api/demo/seed")
    assert upload(student_name="Live Student").status_code == 202
    response = client.get("/api/cohort/pdf")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"].startswith('attachment; filename="3iLens_cohort_')
    assert response.content.startswith(b"%PDF-")
    text = pdf_text(response.content)
    cohort = client.get("/api/cohort").json()

    assert "Cohort Academic Intelligence Report" in text and "Instit-42" in text
    assert "13 completed of 14; 1 in review, 0 failed - excluded: Aditya Kulkarni" in text
    assert len(cohort["ranking"]) == 13
    for row in cohort["ranking"]:
        assert row["student_name"] in text
    for topic in cohort["topic_mastery"]:
        assert norm(topic["topic"]) in text
    assert cohort["common_errors"] and cohort["interventions"]
    assert norm(cohort["common_errors"][0]["error"]) in text
    first = cohort["common_errors"][0]
    assert f"{first['count']}/{first['denominator']}" in text
    assert norm(cohort["interventions"][0]["action"]) in text
    assert "DEMO DATA" in text


def test_cohort_pdf_respects_filters(demo_data, client):
    client.post("/api/demo/seed")
    batch_id = client.get("/api/health").json()["batch"]["id"]
    rubric_id = client.get("/api/rubrics").json()[0]["id"]
    response = client.get("/api/cohort/pdf", params={"batch_id": batch_id, "rubric_id": rubric_id,
                                                     "urgency": "at_risk"})
    assert response.status_code == 200
    text = pdf_text(response.content)
    at_risk = client.get("/api/cohort", params={"urgency": "at_risk"}).json()
    for row in at_risk["ranking"]:
        assert row["student_name"] in text
    assert "Ananya Iyer" not in text  # on track - filtered out
    missing = client.get("/api/cohort/pdf", params={"batch_id": 999})
    assert missing.status_code == 404


def test_renderers_cope_with_empty_narrative_lists(demo_data, client):
    """Old rows / stubbed analytics: no nudges, no plan focus, no roadmap - still a valid PDF."""
    import reports
    import result_view
    from database import SessionLocal, StudentSubmission
    from sqlalchemy import select

    client.post("/api/demo/seed")
    with SessionLocal() as db:
        sub = db.scalar(select(StudentSubmission).where(StudentSubmission.student_name == "Rohan Joshi"))
        out = result_view.build_result(db, sub)
    bare = out.model_copy(update={
        "teaching_nudges": [], "executive_summary": [], "confusions": [], "history": [],
        "roi_recommendations": [],
        "study_plan": out.study_plan.model_copy(update={"focus": [], "roadmap": [], "weekly_calendar": [],
                                                        "explanation": None}),
    })
    text = pdf_text(reports.render_student_pdf(bare))
    assert "No teaching nudges were generated" in text and "Rohan Joshi" in text
    assert "No priority topics" in text and "Roadmap not available" in text


def test_report_logo_path_is_drawn_and_a_bad_logo_falls_back(demo_data, client, monkeypatch, isolated_env, png_bytes):
    client.post("/api/demo/seed")
    sid = next(s["id"] for s in client.get("/api/submissions").json() if s["status"] == "COMPLETED")
    logo = isolated_env / "logo.png"
    logo.write_bytes(png_bytes)
    monkeypatch.setenv("REPORT_LOGO_PATH", str(logo))
    with pymupdf.open("pdf", client.get(f"/api/reports/{sid}/pdf").content) as doc:
        assert all(page.get_images() for page in doc)
    monkeypatch.setenv("REPORT_LOGO_PATH", str(isolated_env / "missing.png"))
    response = client.get(f"/api/reports/{sid}/pdf")
    assert response.status_code == 200
    with pymupdf.open("pdf", response.content) as doc:
        assert not doc[0].get_images() and "3iLens" in doc[0].get_text()


CHART_TITLES = ("Score trend", "Topic mastery vs target", "Marks by question",
                "Where to focus - mastery vs", "Projected gain (illustrative)")


def _demo_result(client, name: str = "Rohan Joshi"):
    import result_view
    from database import SessionLocal, StudentSubmission
    from sqlalchemy import select

    client.post("/api/demo/seed")
    with SessionLocal() as db:
        sub = db.scalar(select(StudentSubmission).where(StudentSubmission.student_name == name))
        return result_view.build_result(db, sub)


def test_student_pdf_draws_the_charts_inside_the_page(demo_data, client):
    from datetime import timedelta

    import reports

    out = _demo_result(client)
    current = next(h for h in out.history if h.current)
    older = current.model_copy(update={"submission_id": 0, "date": current.date - timedelta(days=14), "pct": 40.0,
                                       "current": False})
    data = reports.render_student_pdf(out.model_copy(update={"history": [older, current]}))
    text = pdf_text(data)
    for title in CHART_TITLES:
        assert title in text, title
    assert "points over 2 tests" in text and "this report" in text
    q = out.question_evaluations[0]
    assert f"Q{q.question} {q.topic}" in text and f"{q.estimated_marks:g} / {q.max_marks:g}" in text
    cyan = tuple(int(reports.CYAN[i:i + 2], 16) / 255 for i in (1, 3, 5))
    with pymupdf.open("pdf", data) as doc:
        assert 4 <= doc.page_count <= 12
        marks = [d["rect"] for page in doc for d in page.get_drawings()
                 if d.get("fill") and all(abs(a - b) < 0.01 for a, b in zip(d["fill"], cyan))]
    assert len(marks) >= len(out.topic_mastery) + len(out.question_evaluations)
    for rect in marks:  # below the header band, above the footer, inside the margins
        assert reports.CONTENT.x0 - 10 <= rect.x0 and rect.x1 <= reports.CONTENT.x1 + 10, rect
        assert reports.CONTENT.y0 <= rect.y0 and rect.y1 <= reports.CONTENT.y1, rect


def test_student_pdf_without_history_or_plan_still_builds(demo_data, client):
    import reports

    out = _demo_result(client)
    bare = out.model_copy(update={
        "history": [], "study_plan": out.study_plan.model_copy(update={"topics": [], "focus": []}),
    })
    data = reports.render_student_pdf(bare)
    text = pdf_text(data)
    assert "Score trend" not in text  # one test only: no empty trend card
    assert "No topic plan is available" in text and "No projected gain" in text
    assert "Topic mastery vs target" in text and "Marks by question" in text
    with pymupdf.open("pdf", data) as doc:
        assert 4 <= doc.page_count <= 12


# --------------------------------------------------------------------------- #
# Report redesign: page 1 is the student summary, ops data only on the last page
# --------------------------------------------------------------------------- #
PAGE_ONE_BANNED = ("OCR", "Rs ", "latency", "claude", "request", "AUTHOR_DRAFT", "BRD", "sha256", "ROI", "vcustom")


def _report1_pages(client, upload, db_session) -> tuple[dict, list[str]]:
    """The report-1 fixture (402/720, 180 MCQs) installed on a live upload: (result JSON, page texts)."""
    from database import StudentSubmission
    from tests import neet_report_fixture as fx

    sid = upload().json()["id"]
    fx.install(db_session, db_session.get(StudentSubmission, sid))
    result = client.get(f"/api/results/{sid}").json()
    response = client.get(f"/api/reports/{sid}/pdf")
    assert response.status_code == 200, response.text
    with pymupdf.open("pdf", response.content) as doc:
        pages = [" ".join(page.get_text(flags=TEXT_FLAGS).split()) for page in doc]
    return result, pages


def test_report1_pdf_page_one_is_the_summary_without_ops_data(client, upload, fake_ai, db_session):
    import re

    result, pages = _report1_pages(client, upload, db_session)
    first, last, text = pages[0], pages[-1], " ".join(pages)
    shown = [i for i in result["key_insights"] if i["id"] == "attempts"]
    assert [norm(i["headline"]) in first for i in shown] == [True]
    for line in result["student_summary"]:  # 'In short' on page 1
        assert norm(line) in first, line
    assert "Path to On track" not in first  # covered by 'In short', not repeated
    assert "402 / 720" in first and "55.8%" in first and "Needs attention" in first
    assert "102 marks to On track \u2014 about 26 more right answers (+4 each)." in first
    # Subject table: right / wrong / blank / bonus, answered %, right-when-answered %, marks (1-decimal %).
    for cell in ("26 of 45 (57.8%)", "69.2% (18/26)", "64/180 (35.6%)", "27 of 44 (61.4%)", "70.4% (19/27)",
                 "72/180 (40.0%)", "78 of 89 (87.6%)", "87.2% (68/78)", "266/360 (73.9%)", "402/720 (55.8%)",
                 "131 of 178 (73.6%)", "80.2% (105/131)"):
        assert cell in first, cell
    # Focus rows: marks to the score card's target (70%); Biology is already there, so it is 'keep warm'.
    for subject, gain in (("Physics", "+62"), ("Chemistry", "+54")):
        assert subject in first and gain in first
    assert "keep warm with a short weekly mixed set: Biology (73.9%)" in first
    assert "Chapter breakdown is not available for this paper yet." in first
    for banned in (*PAGE_ONE_BANNED, result["report_meta"]["run_id"]):
        assert banned not in first, banned
    # One format: 1-decimal percentages from the unrounded ratio, never the rounded '56%' / '74%'.
    for right in ("55.8%", "35.6%", "40.0%", "73.9%", "85.0%"):
        assert right in text, right
    for wrong in ("56%", "74%"):
        assert not re.search(rf"(?<![\d.]){re.escape(wrong)}", text), wrong
    assert "105 right \u00d7 4 \u2212 26 = 394, + 8 bonus = 402" in text
    assert "Q1-Q23: 60.0% (6/10)" in text and "Q24-Q45: 75.0% (12/16)" in text
    assert "Marks by thinking level" not in text  # every tag the heuristic K2: the Bloom card is hidden
    assert "Accuracy through the paper" not in text
    # The run metadata (run id, OCR adapter, rubric hash) sits in the closing section only.
    start = next(i for i, page in enumerate(pages) if "Processing, coverage and sign-off" in page)
    closing = " ".join(pages[start:])
    assert result["report_meta"]["run_id"] in closing and "OCR" in closing and "Faculty certification" in last
    assert all(result["report_meta"]["run_id"] not in page for page in pages[:start])


def test_report1_pdf_draws_the_bullet_and_the_question_grid(client, upload, fake_ai, db_session):
    import reports

    _result, pages = _report1_pages(client, upload, db_session)
    text = " ".join(pages)
    assert "Target 504 (70%)" in pages[0]
    assert "All 180 \u00b7 Right 105 \u00b7 Wrong 26 \u00b7 Blank 47 \u00b7 Bonus 2" in text
    assert "Chart data: score 402 of 720" in pages[0]
    assert reports.MEASURE == "#1e40af" and reports.AMBER_MARK == "#d97706"
