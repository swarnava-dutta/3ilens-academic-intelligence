"""Cohort page figures (GET /api/cohort?per_student=true): one row per student, test sittings,
item analysis, attempts, chapters and the change since the previous class sitting, all checked
for consistency with each other and with the owner dashboard on the full demo seed."""
from __future__ import annotations

from collections import Counter
from decimal import ROUND_HALF_UP, Decimal

import pytest

import sittings
from tests.test_contract import check_interface

URL = "/api/cohort"


@pytest.fixture
def seeded(demo_data, client):
    assert client.post("/api/demo/seed", params={"set": "all"}).status_code == 200
    assert client.post("/api/demo/seed", params={"set": "insights"}).status_code == 200


def _batch_id(client, name: str) -> int:
    return next(b["id"] for b in client.get("/api/filters").json()["batches"] if b["name"].startswith(name))


def _test_id(client, name: str) -> int:
    return next(t["rubric_id"] for t in client.get("/api/filters").json()["tests"] if name in t["name"])


def _page(client, **params) -> dict:
    response = client.get(URL, params={"per_student": "true", **params})
    assert response.status_code == 200, response.text
    return response.json()


def _half_up_mean(values) -> float:
    """Exact mean of 1-dp values, half-up to 1 dp (the API's rule: no float noise)."""
    exact = [Decimal(repr(v)) for v in values]
    return float((sum(exact) / len(exact)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def _consistent(body: dict) -> int:
    """N is the same everywhere it is shown."""
    n = body["scope"]["students"]
    assert sum(body["urgency_counts"].values()) == n
    assert len(body["students_view"]) == n == len(body["ranking"])
    assert sum(b["count"] for b in body["score_distribution"]) == n
    assert len({r["student_ref"] for r in body["students_view"]}) == n  # never a student twice
    assert len(body["at_risk"]) == body["urgency_counts"]["at_risk"]
    assert sum(body["release_counts"].values()) == n
    return n


def test_default_payload_is_unchanged(seeded, client):
    """Without per_student the v1 payload carries none of the page fields."""
    body = client.get(URL).json()
    assert "scope" not in body and "students_view" not in body and "data_version" not in body


def test_all_batches_count_each_student_once_and_match_the_owner(seeded, client):
    body = _page(client)
    check_interface(body, "Cohort")
    assert body["scope"]["mode"] == "all"
    n = _consistent(body)
    subs = [s for s in client.get("/api/submissions").json() if s["status"] == "COMPLETED"]
    assert n == len({s.get("student_ref") or s["student_name"] for s in subs}) < len(subs)
    owner = client.get("/api/owner/dashboard").json()
    assert body["urgency_counts"] == owner["urgency_counts"]


def test_mock10_sitting_figures(seeded, client):
    neet_c = _batch_id(client, "NEET-C")
    mock10 = _test_id(client, "Mock 10")
    body = _page(client, batch_id=neet_c, test_id=mock10)
    check_interface(body, "Cohort")
    n = _consistent(body)
    scope, head, attempt = body["scope"], body["headline"], body["attempt"]
    assert scope["mode"] == "sitting" and scope["test_id"] == mock10 and n == 12 and scope["is_class"]
    assert scope["short_name"] == "Mock 10"
    assert sum(v["sheets"] for v in scope["key_versions"]) == scope["sheets"]

    # Class average over the rounded percentages; marks agree with it.
    pcts = [r["pct"] for r in body["students_view"]]
    assert head["average_pct"] == _half_up_mean(pcts)
    assert abs(head["average_marks"] / head["total_marks"] * 100 - head["average_pct"]) <= 0.1

    # Attempts are pooled; negative marks agree across tile, rows and the behaviour patterns.
    assert attempt["attempted"] + attempt["blanks"] == attempt["mcq_answers"] == 24 * n
    assert attempt["attempted"] == attempt["right"] + attempt["wrong"]
    assert attempt["attempt_rate"] == round(attempt["attempted"] / attempt["mcq_answers"] * 100, 1)
    assert attempt["accuracy_attempted"] == round(attempt["right"] / attempt["attempted"] * 100, 1)
    # The blank share is its own figure: 59 / 288 = 20.5%, never 100 - 79.5 re-rounded.
    assert attempt["blank_rate"] == round(attempt["blanks"] / attempt["mcq_answers"] * 100, 1)
    assert attempt["same_length"] and attempt["bonus_answers"] == 0
    neg = attempt["negative_marks_total"]
    assert neg == pytest.approx(sum(r["negative_marks"] for r in body["students_view"]))
    assert neg == pytest.approx(sum(t["negative_marks"] for t in attempt["by_topic"]))
    if body["patterns"]["negative_marking"]:
        assert neg == pytest.approx(body["patterns"]["negative_marking"]["marks_lost_total"])

    # Item analysis: every answer is right, wrong or blank; the option counts add up.
    items = body["item_analysis"]
    assert items and len(items) == 24
    for item in items:
        assert item["correct"] + item["partial"] + item["wrong"] + item["blank"] == item["n"] == n
        options = {o["option"]: o["count"] for o in item["options"]}
        assert options.get(item["key"], 0) == item["correct"]
        assert sum(c for o, c in options.items() if o != item["key"]) == item["wrong"]
        if "possible_key_error" in item["flags"]:
            assert item["n"] >= 8 and item["top_wrong_count"] >= 3 and item["top_wrong_count"] > item["correct"]
            assert item["discrimination"] is not None and item["discrimination"] <= 0

    # Chapters: counts never exceed N; the re-teach card, chapter rows and summary agree.
    for chapter in body["chapters"]:
        assert chapter["below_60"] == len(chapter["below_60_students"]) <= chapter["students"] <= n
        if chapter["reteach_rank"] is not None:
            # A third of the class (2+) below 60% on 2+ questions (this paper is not a short one).
            assert not chapter["thin"] and not chapter["subject_level"] and not chapter["hint"]
            assert chapter["below_60"] >= 2 and chapter["below_60"] * 3 >= chapter["students"]
        else:
            assert chapter["thin"] or chapter["below_60"] * 3 < chapter["students"] or chapter["below_60"] < 2
    ranked = sorted((c for c in body["chapters"] if c["reteach_rank"]), key=lambda c: c["reteach_rank"])
    for a, b in zip(ranked, ranked[1:]):
        assert (a["below_60"], a["neet_weight"] or 0) >= (b["below_60"], b["neet_weight"] or 0)
    # Class interventions follow the re-teach order, each with the chapter's own denominator.
    for row, chapter in zip(body["interventions"], ranked[:3]):
        assert row["topic"] == chapter["topic"] and row["students_count"] == chapter["below_60"]
        assert f"{chapter['below_60']} of {chapter['students']} students" in row["rationale"]
    # Study-plan priorities never name a thin or whole-subject chapter.
    usable = {c["topic"] for c in body["chapters"] if not c["subject_level"] and not c["thin"]}
    assert {p["topic"] for p in body["top_priorities"]} <= usable
    first = next(c for c in body["chapters"] if c["reteach_rank"] == 1)
    kinds = {s["kind"]: s["text"] for s in body["summary"]}
    if "chapter" in kinds:
        assert f"{first['topic']} needs a re-teach: {first['below_60']} of {first['students']}" in kinds["chapter"]
    for row in body["interventions"]:
        assert row["students_count"] <= n


def test_previous_sitting_delta_and_pairs(seeded, client):
    neet_c = _batch_id(client, "NEET-C")
    body = _page(client, batch_id=neet_c, test_id=_test_id(client, "Mock 10"))
    previous, head, paired = body["previous"], body["headline"], body["paired_change"]
    assert previous["short_name"] == "Mock 09"  # the one-student oral check in between is skipped
    assert previous["students"] >= sittings.MIN_CLASS_STUDENTS
    delta = round(head["average_pct"] - previous["average_pct"], 1)
    assert body["summary"][0]["kind"] == "average"
    assert f"{abs(delta):.1f} pts on Mock 09 ({previous['average_pct']:.1f}%)" in body["summary"][0]["text"]

    # sittings.progress, as on the owner page: up 5+ / down 5+ / steady, and the mean change is the
    # difference of the two shown means.
    assert paired["improved"] + paired["declined"] + paired["steady"] == paired["paired"] == len(paired["rows"])
    for row in paired["rows"]:
        assert row["change"] == round(row["now"] - row["prev"], 1)
    assert paired["mean_before"] == _half_up_mean([r["prev"] for r in paired["rows"]])
    assert paired["mean_after"] == _half_up_mean([r["now"] for r in paired["rows"]])
    assert paired["mean_change"] == round(paired["mean_after"] - paired["mean_before"], 1)
    assert paired["improved"] == sum(1 for r in paired["rows"] if r["change"] >= 5)
    assert paired["declined"] == sum(1 for r in paired["rows"] if r["change"] <= -5)
    assert head["delta_pts"] == float(Decimal(repr(head["average_pct"])) - Decimal(repr(previous["average_pct"])))
    assert previous["comparable"] and previous["note"] is None  # same subjects, everyone sat both
    by_ref = {r["student_ref"]: r for r in body["students_view"]}
    for row in paired["rows"]:
        assert by_ref[row["student_ref"]]["prev_pct"] == row["prev"]
    new = sum(r["newly_at_risk"] for r in body["students_view"])
    assert all(r["prev_urgency"] != "at_risk" for r in body["students_view"] if r["newly_at_risk"])
    assert new <= body["urgency_counts"]["at_risk"]


def test_one_student_sittings_are_never_default_or_previous(seeded, client):
    listed = client.get("/api/cohort/sittings").json()
    assert listed and all(s["is_class"] == (s["students"] >= 3) for s in listed)
    assert [s["date"] for s in listed] == sorted((s["date"] for s in listed), reverse=True)
    oral = next(s for s in listed if "Oral" in s["test_name"])
    assert oral["students"] == 1 and not oral["is_class"]
    latest = next(s for s in listed if s["is_class"])
    assert latest["students"] >= 3
    for sitting in listed:
        if not sitting["is_class"]:
            continue
        body = _page(client, batch_id=sitting["batch_id"], test_id=sitting["test_id"])
        _consistent(body)
        assert body["scope"]["students"] == sitting["students"]
        assert body["headline"]["average_pct"] == sitting["average_pct"]
        assert body["urgency_counts"] == sitting["urgency_counts"]
        if body["previous"]:
            assert body["previous"]["students"] >= 3 and body["previous"]["test_id"] != oral["test_id"]
    one = _page(client, batch_id=oral["batch_id"], test_id=oral["test_id"])
    assert one["scope"]["students"] == 1 and one["previous"] is None and one["item_analysis"] is None


def test_a_test_family_includes_every_key_version(seeded, client, db_session):
    from database import Rubric, StudentSubmission

    neet_c = _batch_id(client, "NEET-C")
    v1_id = _test_id(client, "Mock 10")
    v1 = db_session.get(Rubric, v1_id)
    v2 = Rubric(name=v1.name, version="v2", content=v1.content, total_marks=v1.total_marks, parent_id=v1.id)
    db_session.add(v2)
    db_session.flush()
    moved = db_session.query(StudentSubmission).filter_by(rubric_id=v1.id).order_by(StudentSubmission.id).limit(3).all()
    for sub in moved:
        sub.rubric_id = v2.id
    db_session.commit()

    for asked in (v1.id, v2.id):  # any version id resolves to the family
        body = _page(client, batch_id=neet_c, test_id=asked)
        scope = body["scope"]
        assert scope["test_id"] == v1.id and scope["latest_rubric_id"] == v2.id and scope["students"] == 12
        versions = {v["version"]: v for v in scope["key_versions"]}
        assert versions["v2"]["sheets"] == 3 and versions["v2"]["latest"] and versions["v1"]["sheets"] == 9
        assert sum(v["sheets"] for v in scope["key_versions"]) == scope["sheets"]
    # The exact-rubric filter still means one version only.
    legacy = client.get(URL, params={"batch_id": neet_c, "rubric_id": v2.id}).json()
    assert legacy["completed"] == 3
    assert client.get(URL, params={"test_id": 99999, "per_student": "true"}).status_code == 404


def test_logging_class_interventions_is_counted(seeded, client):
    neet_c = _batch_id(client, "NEET-C")
    body = _page(client, batch_id=neet_c, test_id=_test_id(client, "Mock 10"))
    before = body["interventions_logged"]
    chapter = next(c for c in body["chapters"] if c["reteach_rank"] == 1)
    for student in chapter["below_60_students"]:
        response = client.post("/api/interventions", json={
            "submission_id": student["submission_id"], "topic": chapter["topic"], "kind": "class_intervention",
            "action": "10-min re-teach + 5 unseen questions", "source": "faculty", "applied_by": "Ms. K. Menon",
            "applied_at": None, "hours": None, "compliance": None, "note": None,
        })
        assert response.status_code == 201, response.text
    after = _page(client, batch_id=neet_c, test_id=_test_id(client, "Mock 10"))
    assert after["interventions_logged"] == before + chapter["below_60"]
    assert after["data_version"] != body["data_version"]
    listed = client.get("/api/interventions", params={"batch_id": neet_c}).json()
    assert len(listed) == after["interventions_logged"]


def test_written_test_has_no_mcq_figures_and_honest_errors(seeded, client):
    neet_a = _batch_id(client, "NEET-A")
    body = _page(client, batch_id=neet_a, test_id=_test_id(client, "Biology - Genetics"))
    n = _consistent(body)
    assert body["attempt"] is None
    for error in body["common_errors"]:
        assert error["error"].casefold() != "not attempted" and error["denominator"] <= n
    items = {i["question"]: i for i in body["item_analysis"] or []}
    for error in body["common_errors"]:
        assert error["denominator"] == items[error["question"]]["n"]
    # Every chapter is one question here (a short paper): chapters with 3+ students below 60% (and a
    # third of the class) are still ranked for a re-teach, flagged as a hint.
    ranked = [c for c in body["chapters"] if c["reteach_rank"] is not None]
    assert ranked and all(c["thin"] and c["hint"] and c["questions"] == 1 for c in ranked)
    assert all(c["below_60"] >= 3 and c["below_60"] * 3 >= c["students"] for c in ranked)
    first = next(c for c in ranked if c["reteach_rank"] == 1)
    assert first["below_60"] == max(c["below_60"] for c in body["chapters"])
    assert "on its one question" in next(s["text"] for s in body["summary"] if s["kind"] == "chapter")
    thin = {c["topic"] for c in body["chapters"] if c["students"] < 3}
    assert not thin & {p["topic"] for p in body["top_priorities"]}
    # The NEET weight comes from the chapter matrix (avg marks / 720), not this paper's mark share.
    weights = {c["topic"]: c["neet_weight"] for c in body["chapters"]}
    assert weights["Molecular Basis of Inheritance"] == round(8 / 720, 4)
    assert weights["Mendelian Inheritance"] == round(6 / 720, 4)
    assert len(set(weights.values())) > 1
    # The previous class sitting (a mixed mock) covers other subjects: the class averages are not
    # compared, and the students who sat both are "not comparable", never up or down.
    previous = body["previous"]
    assert previous["comparable"] is False and previous["note"] == "different subjects"
    assert body["headline"]["delta_pts"] is None
    assert f"not compared with {previous['short_name']} (different subjects)" in body["summary"][0]["text"]
    paired = body["paired_change"]
    assert paired["paired"] == 0 and paired["not_comparable"] == len(paired["rows"]) == 4
    assert paired["mean_change"] is None and not any(r["comparable"] for r in paired["rows"])
    assert all(r["change_pts"] is None and not r["newly_at_risk"] for r in body["students_view"])
    assert {r["prev_pct"] is not None for r in body["students_view"]} == {True, False}
    assert all(c["change"] is None for c in body["chapters"])
    trend = [s for s in body["sittings"] if s["batch_id"] == neet_a and s["is_class"]]
    assert [(s["short_name"], s["comparable_previous"]) for s in trend] == [
        ("Biology - Genetics", False), ("Mock 08", None),
    ]


def test_data_version_is_stable(seeded, client):
    params = {"batch_id": _batch_id(client, "NEET-C"), "test_id": _test_id(client, "Mock 10")}
    assert _page(client, **params)["data_version"] == _page(client, **params)["data_version"]


def test_short_test_names():
    assert sittings.short_test_name("NEET MCQ Practice - Mock 09 (sample)") == "Mock 09"
    assert sittings.short_test_name("Biology - Genetics") == "Biology - Genetics"
    assert sittings.short_test_name("NEET Mixed - Mock 08") == "Mock 08"


def test_progress_rules_shared_by_owner_cohort_and_students():
    """One rule for every page: half-up 1 dp, the change on the shown values, 5 points = up / down,
    each sheet paired with the one sat just before it (never an oral answer)."""
    from datetime import datetime, timedelta
    from types import SimpleNamespace

    assert (sittings.r1(71.25), sittings.r1(3.25), sittings.r1(6.65)) == (71.3, 3.3, 6.7)
    assert sittings.change_pts(55.2, 60.0) == 4.8 and sittings.change_pts(60.0, 55.2) == -4.8
    assert [sittings.movement(c) for c in (5.0, 4.9, 0.0, -4.9, -5.0)] == ["up", "steady", "steady", "steady", "down"]

    start = datetime(2026, 11, 1)

    def sheet(sid: int, name: str, pct: float, day: int, kind: str = "document"):
        result = SimpleNamespace(total_score=pct, total_marks=100.0, created_at=start)
        return SimpleNamespace(id=sid, student_ref=None, student_name=name, result=result, status="COMPLETED",
                               is_demo=False, input_kind=kind, rubric_id=1, created_at=start + timedelta(days=day))

    before = [sheet(1, "A", 29.2, 0), sheet(2, "B", 82.3, 0), sheet(3, "C", 91.7, 0), sheet(4, "D", 55.2, 0),
              sheet(5, "E", 40.0, 0), sheet(6, "D", 20.0, 2, kind="voice")]
    after = [sheet(11, "A", 37.5, 5), sheet(12, "B", 90.0, 5), sheet(13, "C", 97.5, 5), sheet(14, "D", 60.0, 5),
             sheet(15, "F", 70.0, 5)]
    pairs = sittings.pairs(after, before + after)
    # E and F sat one test only; D's later oral answer is never the sheet before.
    assert [(b.id, a.id) for b, a in pairs] == [(1, 11), (2, 12), (3, 13), (4, 14)]
    one_test = SimpleNamespace(root=lambda _rubric_id: 1)  # a retake of the same test is comparable
    # Means 64.6 -> 71.25 (half-up 71.3); the change is the difference of the two shown means.
    assert sittings.progress(pairs, one_test) == {
        "students": 4, "mean_before": 64.6, "mean_after": 71.3, "mean_change": 6.7,
        "improved": 3, "declined": 0, "steady": 1, "not_comparable": 0,
    }
    assert sittings.progress([], one_test)["mean_change"] is None


def test_comparable_papers_rule_on_the_seed(seeded, client, db_session):
    """sittings.comparable: the same test (a retake), or full papers (10+ questions) over the same
    subjects; a 5-question Biology test and a 12-question mixed mock are not comparable."""
    from database import StudentSubmission

    families = sittings.Families(db_session)
    subs = [s for s in db_session.query(StudentSubmission).all() if sittings.is_completed(s)]

    def first(name: str):
        return next(s for s in subs if s.rubric.name.startswith(name) and s.input_kind != "voice")

    genetics, mock08, mock09, mock10 = first("Biology - Genetics"), first("NEET Mixed"), first("NEET MCQ Practice - Mock 09"), first("NEET MCQ Practice - Mock 10")
    assert sittings.comparable(mock09, mock10, families)  # two full NEET papers, same subjects
    assert sittings.not_comparable_reason(mock08, genetics, families) == "different subjects"
    other = next(s for s in subs if s.rubric_id == genetics.rubric_id and s.id != genetics.id)
    assert sittings.comparable(genetics, other, families)  # the same 5-question test
    retakes = [s for s in subs if s.rubric_id == mock08.rubric_id and s.student_name == "Ananya Iyer"]
    assert len(retakes) == 2 and sittings.comparable(*retakes, families)


def test_progress_shows_in_every_view(seeded, client):
    """A test sat by every batch, and the all-tests views, pair students like the students page;
    a retake of the same test is progress (NEET-A sat Mock 08 twice)."""
    mock08 = _test_id(client, "NEET Mixed - Mock 08")
    all_batches = _page(client, test_id=mock08)["paired_change"]
    assert (all_batches["paired"], all_batches["improved"], all_batches["not_comparable"]) == (4, 4, 0)
    assert {r["prev_test"] for r in all_batches["rows"]} == {"Mock 08"}
    roster = client.get("/api/students/roster", params={"rubric_id": mock08}).json()["summary"]
    assert (roster["improving"], roster["with_trend"]) == (4, 4)
    everyone = _page(client)
    assert everyone["scope"]["mode"] == "all"
    paired = everyone["paired_change"]
    summary = client.get("/api/students/roster").json()["summary"]
    assert (paired["improved"], paired["steady"], paired["declined"], paired["not_comparable"]) == (
        summary["improving"], summary["steady"], summary["slipping"], summary["different_test"],
    )


def test_counter_helpers_on_the_seed(seeded, db_session):
    """sittings.latest_per_student keeps one sheet per student, the newest by when it was sat."""
    from database import StudentSubmission

    subs = db_session.query(StudentSubmission).all()
    latest = sittings.latest_per_student(subs)
    keys = Counter(sittings.student_key(s) for s in latest)
    assert keys and max(keys.values()) == 1
    for sub in subs:
        if not sittings.is_completed(sub):
            continue
        mine = next(s for s in latest if sittings.student_key(s) == sittings.student_key(sub))
        assert (mine.created_at, mine.id) >= (sub.created_at, sub.id) and sittings.order(mine) >= sittings.order(sub)


def test_bonus_questions_are_left_out_like_the_owner_page(seeded, client):
    """A key's bonus question is full marks to everyone: no attempt, no right answer, no item."""
    body = _page(client)
    owner = client.get("/api/owner/dashboard").json()
    attempt = body["attempt"]
    assert attempt["blank_rate"] == round(attempt["blanks"] / attempt["mcq_answers"] * 100, 1)
    overall = (owner.get("exam_behaviour") or {}).get("overall") or {}
    if overall.get("students") == attempt["students"]:  # the same student set: the same counts
        assert (attempt["mcq_answers"], attempt["attempted"], attempt["right"], attempt["blanks"]) == (
            overall["mcqs"], overall["attempted"], overall["correct"], overall["blank"]
        )


def test_page_bins_and_sheet_counts(seeded, client):
    body = _page(client)
    scope = body["scope"]
    assert [b["label"] for b in body["score_distribution"]] == ["<20%", "20–39%", "40–59%", "60–79%", "80%+"]
    for row in body["students_view"]:  # each student is binned by the shown 1-dp percentage
        assert row["pct"] == round(row["pct"], 1)
    assert scope["sheets_in_scope"] >= scope["sheets"] >= scope["students"]
    assert 0 <= scope["demo_sheets"] <= scope["sheets_in_scope"]
    # The v1 payload keeps its labels.
    assert [b["label"] for b in client.get(URL).json()["score_distribution"]][0] == "0-20%"


def test_exact_rounding_helpers():
    assert sittings.mean1([62.6, 62.7]) == 62.7  # 62.65 half-up, not float noise
    assert sittings.median1([63.5, 64.6]) == 64.1
    assert sittings.median1([1.0, 2.0, 9.0]) == 2.0
    assert sittings.mean1([]) is None


def _pdf_text(data: bytes) -> str:
    import pymupdf

    with pymupdf.open(stream=data, filetype="pdf") as doc:
        return " ".join(" ".join(page.get_text().split()) for page in doc)


def test_cohort_pdf_shows_the_page_figures(seeded, client):
    """The cohort page's PDF prints the page's own numbers: class average and median, the change
    since the previous test, at risk n of N, the batch name only, competition ranks."""
    neet_c = _batch_id(client, "NEET-C")
    params = {"batch_id": neet_c, "test_id": _test_id(client, "Mock 10"), "per_student": "true"}
    body = _page(client, batch_id=neet_c, test_id=params["test_id"])
    response = client.get("/api/cohort/pdf", params=params)
    assert response.status_code == 200
    text = _pdf_text(response.content)
    head, prev = body["headline"], body["previous"]
    assert f"{head['average_pct']:.1f}%" in text and f"median {head['median_pct']:.1f}%" in text
    assert f"vs {prev['short_name']}" in text
    assert f"{body['urgency_counts']['at_risk']} of {body['scope']['students']}" in text
    assert "Cost per student" not in text and "Average mastery" not in text
    batch = client.get("/api/filters").json()["batches"]
    exam_types = {b.get("exam_type") for b in batch if b["id"] == neet_c} - {None, ""}
    assert not any(f"· {t}" in text for t in exam_types)
    # All batches: mixed totals never print one average score.
    every = _pdf_text(client.get("/api/cohort/pdf", params={"per_student": "true"}).content)
    assert "Average score" not in every and "All batches" in every
