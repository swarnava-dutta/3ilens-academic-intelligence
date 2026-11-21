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
    for line in result["strengths_gaps"]["strengths"][:2] + result["strengths_gaps"]["gaps"][:2]:
        assert norm(line) in text, line
    for heading in ("01 | Executive summary", "02 | Topic screening (not proven mastery)", "03 | Strengths and gaps",
                    "04 | Teaching nudges", "05 | Next five topics", "06 | Teacher action plan",
                    "07 | 7 / 30 / 60 / 90-day roadmap", "08 | Coverage, limitations and sign-off", "Appendix A"):
        assert heading in text, heading
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


def test_demo_row_pdf_is_watermarked_demo_data(client, rich_analytics):
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


def test_released_demo_rows_carry_the_sign_off(client):
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


def test_archived_version_renders_with_the_superseded_watermark(client, db_session):
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


def test_cohort_pdf_has_ranking_topics_denominator_errors_and_interventions(
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


def test_cohort_pdf_respects_filters(client):
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


def test_renderers_cope_with_empty_narrative_lists(client):
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


def test_report_logo_path_is_drawn_and_a_bad_logo_falls_back(client, monkeypatch, isolated_env, png_bytes):
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
                "Where to focus - mastery vs exam weightage", "Projected gain (illustrative)")


def _demo_result(client, name: str = "Rohan Joshi"):
    import result_view
    from database import SessionLocal, StudentSubmission
    from sqlalchemy import select

    client.post("/api/demo/seed")
    with SessionLocal() as db:
        sub = db.scalar(select(StudentSubmission).where(StudentSubmission.student_name == name))
        return result_view.build_result(db, sub)


def test_student_pdf_draws_the_charts_inside_the_page(client):
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


def test_student_pdf_without_history_or_plan_still_builds(client):
    import reports

    out = _demo_result(client)
    bare = out.model_copy(update={
        "history": [], "study_plan": out.study_plan.model_copy(update={"topics": [], "focus": []}),
    })
    data = reports.render_student_pdf(bare)
    text = pdf_text(data)
    assert "Only this test is on record for the student, so there is no trend yet." in text
    assert "No topic plan is available" in text and "No projected gain" in text
    assert "Topic mastery vs target" in text and "Marks by question" in text
    with pymupdf.open("pdf", data) as doc:
        assert 4 <= doc.page_count <= 12
