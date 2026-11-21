"""Schema migration tests: databases created by the v1 build (no hashing, versions, costs...)
must keep working. init_db() adds every newer column idempotently and legacy rows serialise
through the API with defaults filled in at read time.

LEGACY_DDL was captured from a temp copy of backend/3ilens.db (sqlite_master) before the
contract-v2 migration. The real database is never opened for writing here.
"""
from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

import pytest

from tests.test_contract import check, check_interface

BACKEND_DIR = Path(__file__).resolve().parents[1]
REAL_DB = BACKEND_DIR / "3ilens.db"

LEGACY_DDL = [
    """CREATE TABLE institutions (
	id INTEGER NOT NULL,
	name VARCHAR(200) NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (name)
)""",
    """CREATE TABLE rubrics (
	id INTEGER NOT NULL,
	name VARCHAR(200) NOT NULL,
	version VARCHAR(50) NOT NULL,
	content JSON NOT NULL,
	total_marks FLOAT NOT NULL,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id)
)""",
    """CREATE TABLE batches (
	id INTEGER NOT NULL,
	name VARCHAR(100) NOT NULL,
	exam_type VARCHAR(100) NOT NULL,
	institution_id INTEGER NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(institution_id) REFERENCES institutions (id)
)""",
    """CREATE TABLE student_submissions (
	id INTEGER NOT NULL,
	student_name VARCHAR(120) NOT NULL,
	file_path VARCHAR(1024) NOT NULL,
	original_filename VARCHAR(255) NOT NULL,
	mime_type VARCHAR(100) NOT NULL,
	status VARCHAR(32) NOT NULL,
	ocr_confidence FLOAT,
	current_step VARCHAR(100) NOT NULL,
	error_message TEXT,
	processing_log JSON NOT NULL,
	is_demo BOOLEAN NOT NULL,
	batch_id INTEGER NOT NULL,
	rubric_id INTEGER NOT NULL,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(batch_id) REFERENCES batches (id),
	FOREIGN KEY(rubric_id) REFERENCES rubrics (id)
)""",
    "CREATE INDEX ix_student_submissions_status ON student_submissions (status)",
    "CREATE INDEX ix_student_submissions_is_demo ON student_submissions (is_demo)",
    "CREATE INDEX ix_student_submissions_created_at ON student_submissions (created_at)",
    """CREATE TABLE evaluation_results (
	id INTEGER NOT NULL,
	submission_id INTEGER NOT NULL,
	total_score FLOAT NOT NULL,
	total_marks FLOAT NOT NULL,
	overall_mastery FLOAT NOT NULL,
	topic_mastery JSON NOT NULL,
	roi_recommendations JSON NOT NULL,
	strengths_gaps JSON NOT NULL,
	question_evaluations JSON NOT NULL,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (submission_id),
	FOREIGN KEY(submission_id) REFERENCES student_submissions (id)
)""",
]
NEW_TABLES = {"ocr_cache", "model_invocations", "evaluation_versions", "ocr_reviews", "deliveries"}


def _columns(path: Path) -> dict[str, list[str]]:
    with sqlite3.connect(path) as conn:
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        return {t: [row[1] for row in conn.execute(f'PRAGMA table_info("{t}")')] for t in tables}


def _indexes(path: Path) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}


def _build_legacy_db(path: Path) -> dict[str, int]:
    """A v1-schema database with a completed, a human-review and a failed submission."""
    import insights
    import seed

    content = seed.load_genetics_rubric()
    answers, evaluation = seed.build_demo_inputs(content, [4, 3, 1.5, 3.5, 2], 0.93)
    report = insights.build_evaluation_report(content, answers, evaluation)
    now = "2026-11-20 10:00:00.000000"
    log = json.dumps([{"step": "Ingestion", "message": "Received legacy.png", "timestamp": "2026-11-20T10:00:00.000Z"}])
    with sqlite3.connect(path) as conn:
        for ddl in LEGACY_DDL:
            conn.execute(ddl)
        conn.execute("INSERT INTO institutions (id, name) VALUES (1, 'Instit-42')")
        conn.execute("INSERT INTO batches (id, name, exam_type, institution_id) VALUES (1, 'NEET-A', 'Mock-07', 1)")
        conn.execute(
            "INSERT INTO rubrics (id, name, version, content, total_marks, created_at) VALUES (1, ?, 'v1', ?, 20, ?)",
            ("Biology - Genetics", json.dumps(content), now),
        )
        rows = [
            (1, "Legacy Completed", "COMPLETED", 0.93, "Completed", None),
            (2, "Legacy Review", "HUMAN_REVIEW_REQUIRED", 0.65, "Human review",
             "OCR confidence 0.65 is below the 0.80 threshold - routed to faculty review; AI evaluation skipped."),
            (3, "Legacy Failed", "FAILED", None, "Failed", "Unexpected processing error - see the backend logs."),
        ]
        for sid, name, status, conf, step, error in rows:
            conn.execute(
                "INSERT INTO student_submissions (id, student_name, file_path, original_filename, mime_type, status, "
                "ocr_confidence, current_step, error_message, processing_log, is_demo, batch_id, rubric_id, "
                "created_at, updated_at) VALUES (?, ?, '', 'legacy.png', 'image/png', ?, ?, ?, ?, ?, 0, 1, 1, ?, ?)",
                (sid, name, status, conf, step, error, log, now, now),
            )
        conn.execute(
            "INSERT INTO evaluation_results (id, submission_id, total_score, total_marks, overall_mastery, "
            "topic_mastery, roi_recommendations, strengths_gaps, question_evaluations, created_at) "
            "VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                report["total_score"], report["total_marks"], report["overall_mastery"],
                json.dumps(report["topic_mastery"]), json.dumps(report["roi_recommendations"]),
                json.dumps(report["strengths_gaps"]), json.dumps(report["question_evaluations"]), now,
            ),
        )
    return {"completed": 1, "review": 2, "failed": 3}


@pytest.fixture
def legacy_db(isolated_env, monkeypatch) -> tuple[Path, dict[str, int]]:
    path = isolated_env / "legacy.db"
    ids = _build_legacy_db(path)
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path.as_posix()}")
    return path, ids


def test_init_db_adds_every_new_column_and_is_idempotent(legacy_db):
    import database

    path, _ = legacy_db
    before = _columns(path)
    assert "file_hash" not in before["student_submissions"]

    database.init_db()
    after = _columns(path)
    for table, column, _ddl in database.MIGRATION_COLUMNS:
        assert column in after[table], f"{table}.{column} missing after migration"
    assert NEW_TABLES <= set(after)
    for name, _table, _column in database.MIGRATION_INDEXES:
        assert name in _indexes(path)
    # Existing data is untouched.
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT count(*) FROM student_submissions").fetchone()[0] == 3
        assert conn.execute("SELECT file_hash, attempts FROM student_submissions WHERE id = 1").fetchone() == (None, None)

    database.dispose_engine()
    database.init_db()  # second run: no-op
    assert _columns(path) == after
    assert database._ensure_columns(database.get_engine()) == []


def test_legacy_rows_serialise_through_the_api(legacy_db, monkeypatch):
    from fastapi.testclient import TestClient

    import main

    _path, ids = legacy_db
    monkeypatch.setenv("OCR_CONFIDENCE_THRESHOLD", "0.80")
    with TestClient(main.app) as client:  # lifespan runs init_db (migration) + seed_base backfills
        submissions = client.get("/api/submissions").json()
        check(submissions, "Submission[]", "submissions")
        by_id = {s["id"]: s for s in submissions}
        legacy = by_id[ids["completed"]]
        assert legacy["file_sha256"] is None and legacy["language_hints"] == ["en"]
        assert legacy["student_ref"] == "legacy-completed" and legacy["attempts"] == 0
        assert legacy["urgency"] == "on_track" and legacy["release_status"] == "PROVISIONAL"

        result = client.get(f"/api/results/{ids['completed']}")
        assert result.status_code == 200, result.text
        body = result.json()
        check_interface(body, "Result")
        assert body["custody"] is None and body["versions"] == [] and body["summary"] is None
        assert body["rubric"]["status"] == "AUTHOR_DRAFT" and len(body["rubric"]["rubric_hash"]) == 64
        assert [q["outcome"] for q in body["question_evaluations"]] == ["FULL", "PARTIAL", "PARTIAL", "PARTIAL",
                                                                        "PARTIAL"]

        for key in ("review", "failed"):
            pending = client.get(f"/api/results/{ids[key]}")
            assert pending.status_code == 202
            check_interface(pending.json(), "ResultPending")

        cohort = client.get("/api/cohort").json()
        check_interface(cohort, "Cohort")
        assert cohort["completed"] == 1 and cohort["human_review"] == 1 and cohort["failed"] == 1
        health = client.get("/api/health").json()
        check_interface(health, "Health")
        assert health["batch"]["exam"] == "NEET" and health["batch"]["exam_date_assumed"] is True
        rubrics = client.get("/api/rubrics").json()
        check(rubrics, "Rubric[]", "rubrics")

    # A restart (second lifespan) is a no-op for the schema.
    import database

    cols = _columns(_path)
    with TestClient(main.app) as client:
        assert client.get("/api/submissions").status_code == 200
    database.dispose_engine()
    assert _columns(_path) == cols


def test_results_store_archives_and_replaces_a_legacy_result(legacy_db):
    import database
    import results_store
    from database import EvaluationVersion, StudentSubmission

    _path, ids = legacy_db
    database.init_db()
    with database.SessionLocal() as db:
        sub = db.get(StudentSubmission, ids["completed"])
        old_score = sub.result.total_score
        archived = results_store.archive_current_result(db, sub, superseded_by_rubric_id=None)
        assert archived is not None and archived.version == 1 and archived.total_score == old_score
        assert archived.payload["summary"] is None and archived.payload["teaching_nudges"] == []
        assert sub.result is None
        report = {**archived.payload}
        replacement = results_store.build_evaluation_result(report, rubric=sub.rubric, version=2)
        replacement.submission_id = sub.id
        db.add(replacement)
        db.commit()
        assert db.query(EvaluationVersion).count() == 1
        assert results_store.archive_current_result(db, db.get(StudentSubmission, ids["review"]),
                                                    superseded_by_rubric_id=None) is None


def _snapshot_real_db(dest: Path) -> bool:
    """Consistent read-only snapshot of backend/3ilens.db via the SQLite backup API."""
    if not REAL_DB.is_file():
        return False
    try:
        source = sqlite3.connect(f"file:{REAL_DB.as_posix()}?mode=ro", uri=True)
    except sqlite3.Error:
        return False
    try:
        with sqlite3.connect(dest) as target:
            source.backup(target)
    except sqlite3.Error:
        return False
    finally:
        source.close()
    return True


def test_a_copy_of_the_real_database_migrates_and_serves(isolated_env, monkeypatch):
    import database

    copy = isolated_env / "real_copy.db"
    if not _snapshot_real_db(copy):
        pytest.skip("backend/3ilens.db not available")
    shutil.copyfile(copy, isolated_env / "real_copy_untouched.db")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{copy.as_posix()}")
    from fastapi.testclient import TestClient

    import main

    with TestClient(main.app) as client:
        submissions = client.get("/api/submissions")
        assert submissions.status_code == 200
        check(submissions.json(), "Submission[]", "submissions")
        cohort = client.get("/api/cohort")
        assert cohort.status_code == 200
        check_interface(cohort.json(), "Cohort")
        for sub in submissions.json()[:5]:
            response = client.get(f"/api/results/{sub['id']}")
            assert response.status_code in (200, 202)
            check_interface(response.json(), "Result" if response.status_code == 200 else "ResultPending")
    database.dispose_engine()
    columns = _columns(copy)
    for table, column, _ddl in database.MIGRATION_COLUMNS:
        assert column in columns[table]
