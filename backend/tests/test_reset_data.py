"""scripts/reset_data.py: dry run lists the rows that would go; --yes backs up (database copy +
uploads/ and artifacts/ moved) and then empties every rubric-dependent table, on a temp database."""
from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "reset_data.py"
CLEARED = (
    "rubrics", "student_submissions", "evaluation_results", "evaluation_versions", "ocr_reviews", "ocr_cache",
    "deliveries", "intervention_records",
)
KEPT = ("institutions", "api_keys")


def load_script():
    spec = importlib.util.spec_from_file_location("reset_data", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def counts(path: Path) -> dict[str, int]:
    conn = sqlite3.connect(path)
    try:
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        return {t: conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}
    finally:
        conn.close()


@pytest.fixture
def populated(demo_data, isolated_env):
    """A database with every kind of row: the demo sets (rubrics, sheets, results, interventions)
    plus an OCR review, a delivery, an archived version, an OCR cache entry, an LMS key and model
    invocations with and without a sheet. Returns (db path, root with uploads/ and artifacts/)."""
    import database
    import seed
    from database import (
        ApiKey, Delivery, EvaluationVersion, ModelInvocation, OcrCache, OcrReview, StudentSubmission,
    )

    database.init_db()
    with database.SessionLocal() as session:
        seed.seed_demo_set(session, "all")
        seed.seed_demo_set(session, "insights")
        sub = session.query(StudentSubmission).order_by(StudentSubmission.id).first()
        session.add_all([
            OcrReview(submission_id=sub.id, reviewer="Dr. Rao", action="approve"),
            Delivery(submission_id=sub.id, channel="whatsapp", template_name="t", status="SIMULATED_NOT_SENT"),
            EvaluationVersion(submission_id=sub.id, total_score=1, total_marks=20, payload={}),
            OcrCache(cache_key="k" * 64, file_hash="f" * 64, ocr_result={}),
            ApiKey(name="LMS", prefix="abcd1234", key_hash="h" * 64),
            ModelInvocation(submission_id=sub.id, purpose="ocr", provider="anthropic", model_requested="m"),
            ModelInvocation(submission_id=None, purpose="rubric_parse", provider="anthropic", model_requested="m"),
        ])
        session.commit()

    root = isolated_env / "root"
    for name in ("uploads", "artifacts"):
        (root / name).mkdir(parents=True)
        (root / name / ".gitkeep").write_bytes(b"")
    (root / "uploads" / "abc_sheet.png").write_bytes(b"png")
    (root / "artifacts" / "1").mkdir()
    (root / "artifacts" / "1" / "page-1.png").write_bytes(b"page")
    db_path = Path(database.get_engine().url.database)
    return db_path, root


def test_dry_run_lists_counts_and_changes_nothing(populated, capsys):
    db_path, root = populated
    before = counts(db_path)
    assert all(before[t] > 0 for t in CLEARED + KEPT)

    assert load_script().main(["--db", str(db_path), "--root", str(root)]) == 0
    out = capsys.readouterr().out
    for table in CLEARED:
        line = next(line for line in out.splitlines() if line.strip().startswith(table + " "))
        assert line.split()[1] == str(before[table]), line
    invocations = next(line for line in out.splitlines() if line.strip().startswith("model_invocations"))
    assert invocations.split()[1:4] == [str(before["model_invocations"] - 1), "of", str(before["model_invocations"])]
    assert "only rows tied to a sheet" in invocations
    kept = out.split("Kept:")[1]
    assert all(t in kept for t in KEPT)
    assert "uploads: 1 item(s)" in out and "artifacts: 1 item(s)" in out
    assert "Dry run - nothing changed" in out
    # Demo batches go and the base batch loses its demo lead, so no sample name stays on screen.
    assert out.split("Batch changes:\n")[1].splitlines()[:3] == [
        "  delete batch NEET-B / Mock-08", "  delete batch NEET-C (sample) / Mock-09/10",
        "  clear faculty lead 'Dr. A. Rao (demo)' of batch NEET-A / Mock-07",
    ]

    assert counts(db_path) == before
    assert not (root / "backups").exists()
    assert (root / "uploads" / "abc_sheet.png").is_file()


def test_yes_backs_up_then_empties_the_rubric_dependent_tables(populated, capsys):
    import database

    db_path, root = populated
    before = counts(db_path)
    # The backend keeps its pooled connections (and a reader may hold a snapshot) while the script runs.
    reader = sqlite3.connect(db_path)
    reader.execute("BEGIN")
    reader.execute("SELECT COUNT(*) FROM rubrics").fetchone()
    try:
        assert load_script().main(["--db", str(db_path), "--root", str(root), "--yes"]) == 0
    finally:
        reader.rollback()
        reader.close()
    out = capsys.readouterr().out
    assert "Backup verified: opens, quick_check ok, same row counts" in out and "Reset complete." in out

    (backup_dir,) = list((root / "backups").iterdir())
    assert counts(backup_dir / db_path.name) == before  # full copy, taken before the delete
    assert (backup_dir / "uploads" / "abc_sheet.png").read_bytes() == b"png"
    assert (backup_dir / "artifacts" / "1" / "page-1.png").read_bytes() == b"page"
    assert sorted(p.name for p in (root / "uploads").iterdir()) == [".gitkeep"]
    assert sorted(p.name for p in (root / "artifacts").iterdir()) == [".gitkeep"]

    after = counts(db_path)
    assert all(after[t] == 0 for t in CLEARED), {t: after[t] for t in CLEARED}
    assert all(after[t] == before[t] for t in KEPT)
    assert after["model_invocations"] == 1  # the rubric-drafting call belongs to no sheet

    # The running backend keeps working on the emptied database.
    with database.SessionLocal() as session:
        assert session.query(database.Rubric).count() == 0
        assert [(b.name, b.faculty_lead) for b in session.query(database.Batch)] == [("NEET-A", None)]


def test_reset_rolls_back_and_puts_files_back_when_a_step_fails(populated, monkeypatch, capsys):
    db_path, root = populated
    before = counts(db_path)
    script = load_script()

    def broken_plan(_conn):
        raise script.ResetError("simulated failure")

    real_plan = script.plan_tables
    calls = {"n": 0}

    def plan_once(conn):  # the dry-run plan works, the plan inside the delete transaction fails
        calls["n"] += 1
        return real_plan(conn) if calls["n"] == 1 else broken_plan(conn)

    monkeypatch.setattr(script, "plan_tables", plan_once)
    assert script.main(["--db", str(db_path), "--root", str(root), "--yes"]) == 1
    assert "Reset failed, nothing deleted: simulated failure" in capsys.readouterr().err
    assert counts(db_path) == before
    assert (root / "uploads" / "abc_sheet.png").read_bytes() == b"png"
    assert (root / "artifacts" / "1" / "page-1.png").read_bytes() == b"page"


def test_dry_run_fallback_connection_neither_writes_nor_checkpoints(tmp_path, monkeypatch):
    """When the read-only open fails (a WAL database whose -shm is missing), the dry run falls back
    to a normal connection: it must refuse writes and must not checkpoint the WAL into the database
    file when it closes as the last connection."""
    db = tmp_path / "wal.db"
    writer = sqlite3.connect(db)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("PRAGMA wal_autocheckpoint=0")
    writer.execute("CREATE TABLE t (x)")
    writer.execute("INSERT INTO t VALUES (1)")
    writer.commit()
    writer.setconfig(sqlite3.SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, True)
    writer.close()
    wal = db.with_name(db.name + "-wal")
    assert wal.stat().st_size > 0  # the rows live only in the WAL
    before = db.read_bytes()

    script = load_script()
    real_connect = sqlite3.connect

    def connect(target, *args, uri=False, **kwargs):
        if uri:
            raise sqlite3.OperationalError("unable to open database file")
        return real_connect(target, *args, **kwargs)

    monkeypatch.setattr(script.sqlite3, "connect", connect)
    conn = script._connect(db, read_only=True)
    try:
        assert conn.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            conn.execute("DELETE FROM t")
    finally:
        conn.close()
    assert db.read_bytes() == before
    assert wal.stat().st_size > 0


def test_missing_database_is_reported(tmp_path, capsys):
    assert load_script().main(["--db", str(tmp_path / "nope.db"), "--root", str(tmp_path)]) == 1
    assert "not found" in capsys.readouterr().err
