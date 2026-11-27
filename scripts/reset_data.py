"""Reset the PoC data: every rubric and everything graded with one.

Run from the repo root with the backend venv python:

    backend\\.venv\\Scripts\\python.exe scripts\\reset_data.py          # dry run: what would go
    backend\\.venv\\Scripts\\python.exe scripts\\reset_data.py --yes    # back up, then delete

Dry run (default): prints the rows per table that would be deleted, the tables that are kept and
the files that would be moved out of uploads/ and artifacts/. Nothing is written.

--yes:
  1. backs up to backups/<UTC timestamp>/: a copy of the database made with the SQLite backup API
     (consistent while the backend is running - WAL included) and the contents of uploads/ and
     artifacts/ MOVED into that folder (the .gitkeep files stay);
  2. checks that the backup database opens, passes PRAGMA quick_check and has the same row count
     in every table as the live database;
  3. deletes, in one transaction: every rubric, every sheet (student_submissions) and every row
     that depends on a rubric or a sheet (results, result versions, OCR reviews, deliveries,
     intervention records, model invocations tied to a sheet) plus the whole OCR cache, then every
     batch no kept row uses except the base one seed_base creates (NEET-A / Mock-07), and clears
     the "(demo)" / "(sample)" faculty leads. Institutions, LMS API keys and model invocations that
     belong to no sheet (rubric drafting costs) are kept. The dry run names those batches and leads.
The database stays write-locked from the backup to the commit, so the running backend cannot add
a row in between (its writes wait, up to its 30 s busy timeout). If any step fails, the deletion
is rolled back and moved files are put back.

Options: --db PATH (default backend/3ilens.db), --root DIR (folder holding uploads/, artifacts/
and backups/; default the repo root). Exit code 0 = done (or dry run), 1 = failed, nothing deleted.
"""
from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = REPO_ROOT / "backend" / "3ilens.db"

# Emptied completely; every table that references one of these (directly or through another
# cleared table) is cleared too - see plan_tables().
ROOT_TABLES = ("rubrics", "student_submissions", "ocr_cache")
# Kept (configuration; demo batches aside). A foreign key from one of these to a cleared table aborts the run.
KEEP_TABLES = ("institutions", "batches", "api_keys")
FILE_DIRS = ("uploads", "artifacts")
KEEP_FILES = {".gitkeep"}
BUSY_TIMEOUT_SECONDS = 30
# seed.seed_base's batch (seed.BATCH_NAME / BATCH_EXAM_TYPE) stays; demo batches (NEET-B, NEET-C (sample)) go.
BASE_BATCH = "name = 'NEET-A' AND exam_type = 'Mock-07'"
DEMO_LEAD = "faculty_lead LIKE '%(demo)%' OR faculty_lead LIKE '%(sample)%'"


class ResetError(RuntimeError):
    pass


# --------------------------------------------------------------------------- #
# Planning
# --------------------------------------------------------------------------- #
def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def list_tables(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    return [r[0] for r in rows]


def row_counts(conn: sqlite3.Connection, tables: list[str] | None = None) -> dict[str, int]:
    return {t: conn.execute(f"SELECT COUNT(*) FROM {_q(t)}").fetchone()[0] for t in (tables or list_tables(conn))}


def _foreign_keys(conn: sqlite3.Connection, table: str) -> list[tuple[str, str, bool]]:
    """[(column, referenced table, column is NOT NULL)]."""
    notnull = {row[1]: bool(row[3]) for row in conn.execute(f"PRAGMA table_info({_q(table)})")}
    return [(row[3], row[2], notnull.get(row[3], False)) for row in conn.execute(f"PRAGMA foreign_key_list({_q(table)})")]


def plan_tables(conn: sqlite3.Connection) -> list[tuple[str, str | None]]:
    """[(table, where)] in a safe delete order (referencing tables first). where None = every row;
    else a condition selecting the rows that reference a cleared table through a nullable key
    (e.g. model invocations of a sheet; rubric-drafting calls have no sheet and are kept)."""
    tables = list_tables(conn)
    fks = {t: _foreign_keys(conn, t) for t in tables}
    full = {t for t in ROOT_TABLES if t in tables}
    partial: dict[str, set[str]] = {}
    changed = True
    while changed:  # fixpoint: a fully cleared table clears every table that must reference it
        changed = False
        for table in tables:
            if table in full:
                continue
            refs = [(col, notnull) for col, ref, notnull in fks[table] if ref in full]
            if not refs:
                continue
            if table in KEEP_TABLES:
                raise ResetError(f"Kept table {table} references a table that would be emptied - aborting.")
            if any(notnull for _, notnull in refs):
                full.add(table)
                partial.pop(table, None)
                changed = True
            else:
                cols = {col for col, _ in refs}
                if partial.get(table) != cols:
                    partial[table] = cols
                    changed = True

    pending = set(full) | set(partial)
    order: list[str] = []
    while pending:
        ready = sorted(
            t for t in pending
            if not any(other != t and any(ref == t for _, ref, _ in fks[other]) for other in pending)
        )
        if not ready:
            raise ResetError(f"Circular foreign keys among {', '.join(sorted(pending))} - aborting.")
        order.extend(ready)
        pending -= set(ready)

    plan: list[tuple[str, str | None]] = []
    for table in order:
        if table in partial:
            where = " OR ".join(f"{_q(col)} IS NOT NULL" for col in sorted(partial[table]))
            plan.append((table, where))
        else:
            plan.append((table, None))
    if "batches" in tables:  # last: the rows that reference a batch are deleted first
        where = [f"NOT ({BASE_BATCH})"] + [
            f"id NOT IN (SELECT {_q(col)} FROM {_q(t)} WHERE {_q(col)} IS NOT NULL)"
            for t in tables if t not in full for col, ref, _ in fks[t] if ref == "batches"
        ]
        plan.append(("batches", " AND ".join(where)))
    return plan


def batch_changes(conn: sqlite3.Connection, plan: list[tuple[str, str | None]]) -> list[str]:
    """The batches the plan deletes and the demo faculty leads cleared on the batches that stay."""
    where = dict(plan).get("batches")
    if where is None:
        return []
    going = conn.execute(f"SELECT name, exam_type FROM batches WHERE {where} ORDER BY id").fetchall()
    leads = conn.execute(
        f"SELECT name, exam_type, faculty_lead FROM batches WHERE ({DEMO_LEAD}) AND NOT ({where}) ORDER BY id"
    ).fetchall()
    return [f"  delete batch {n} / {e}" for n, e in going] + [
        f"  clear faculty lead '{lead}' of batch {n} / {e}" for n, e, lead in leads
    ]


def planned_counts(conn: sqlite3.Connection, plan: list[tuple[str, str | None]]) -> dict[str, int]:
    out = {}
    for table, where in plan:
        sql = f"SELECT COUNT(*) FROM {_q(table)}" + (f" WHERE {where}" if where else "")
        out[table] = conn.execute(sql).fetchone()[0]
    return out


def files_to_move(root: Path) -> dict[str, list[Path]]:
    out: dict[str, list[Path]] = {}
    for name in FILE_DIRS:
        folder = root / name
        out[name] = sorted(p for p in folder.iterdir() if p.name not in KEEP_FILES) if folder.is_dir() else []
    return out


def _size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def _human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #
def print_plan(
    db: Path, root: Path, plan: list[tuple[str, str | None]], deleting: dict[str, int],
    totals: dict[str, int], files: dict[str, list[Path]],
) -> None:
    print(f"Database: {db}")
    print("Rows to delete:")
    width = max([len(t) for t in totals] + [10])
    for table, where in plan:
        why = "no kept row uses them; the base batch stays" if table == "batches" else "only rows tied to a sheet"
        note = f" of {totals[table]} ({why})" if where else ""
        print(f"  {table:<{width}}  {deleting[table]:>7}{note}")
    print(f"  {'total':<{width}}  {sum(deleting.values()):>7}")
    kept = [t for t in totals if t not in deleting]
    if kept:
        print("Kept:")
        for table in kept:
            print(f"  {table:<{width}}  {totals[table]:>7}")
    for name, items in files.items():
        size = sum(_size(p) for p in items)
        print(f"Files to move out of {root / name}: {len(items)} item(s), {_human(size)}")


# --------------------------------------------------------------------------- #
# Reset
# --------------------------------------------------------------------------- #
def _connect(db: Path, *, read_only: bool) -> sqlite3.Connection:
    if read_only:
        conn = None
        try:
            conn = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=BUSY_TIMEOUT_SECONDS)
            conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()
        except sqlite3.OperationalError:
            if conn is not None:
                conn.close()
            # A WAL database with no -shm file (backend stopped) cannot be opened read-only. A
            # normal connection is used instead, kept from writing: query_only refuses writes and
            # NO_CKPT_ON_CLOSE stops the WAL checkpoint SQLite runs when the last connection closes.
            conn = sqlite3.connect(str(db), timeout=BUSY_TIMEOUT_SECONDS)
            conn.setconfig(sqlite3.SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, True)
            conn.execute("PRAGMA query_only=1")
    else:
        conn = sqlite3.connect(str(db), timeout=BUSY_TIMEOUT_SECONDS, isolation_level=None)
        conn.execute("PRAGMA foreign_keys=ON")  # a missed dependent table fails the delete instead of orphaning rows
    return conn


def _move_back(moved: list[tuple[Path, Path]]) -> list[str]:
    problems = []
    for src, dst in reversed(moved):
        try:
            shutil.move(str(dst), str(src))
        except OSError as exc:
            problems.append(f"{dst} -> {src}: {exc}")
    return problems


def reset(db: Path, root: Path, *, now: datetime | None = None) -> Path:
    """Back up and delete. Returns the backup folder. Raises ResetError (nothing deleted)."""
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = root / "backups" / stamp
    if backup_dir.exists():
        raise ResetError(f"Backup folder {backup_dir} already exists - try again in a second.")
    backup_dir.mkdir(parents=True)
    backup_db = backup_dir / db.name

    conn = _connect(db, read_only=False)
    moved: list[tuple[Path, Path]] = []
    try:
        # Write lock from the backup to the commit: the backend cannot add a row in between.
        conn.execute("BEGIN IMMEDIATE")
        # The copy is read through a second connection: SQLite refuses (SQLITE_LOCKED) a backup from
        # a connection that holds the write transaction. Readers are not blocked by the write lock,
        # and nobody else can commit while it is held, so this is exactly what `conn` sees.
        source = sqlite3.connect(str(db), timeout=BUSY_TIMEOUT_SECONDS)
        target = sqlite3.connect(str(backup_db))
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()
        print(f"Database backed up to {backup_db}")

        live = row_counts(conn)
        check = sqlite3.connect(str(backup_db))
        try:
            status = check.execute("PRAGMA quick_check").fetchone()[0]
            copied = row_counts(check)
        finally:
            check.close()
        if status != "ok":
            raise ResetError(f"Backup database failed PRAGMA quick_check: {status}")
        if copied != live:
            diff = sorted(t for t in set(live) | set(copied) if live.get(t) != copied.get(t))
            raise ResetError(f"Backup row counts differ from the live database in: {', '.join(diff)}")
        print(f"Backup verified: opens, quick_check ok, same row counts in all {len(live)} tables.")

        for name, items in files_to_move(root).items():
            dest = backup_dir / name
            dest.mkdir(exist_ok=True)
            for item in items:
                target_path = dest / item.name
                try:
                    shutil.move(str(item), str(target_path))
                except OSError as exc:
                    raise ResetError(
                        f"Could not move {item} into the backup ({exc}) - a running job may hold it open. "
                        "Wait for the queue to finish (or stop the backend) and run the reset again."
                    ) from exc
                moved.append((item, target_path))
            print(f"Moved {len(items)} item(s) from {root / name} to {dest}")

        plan = plan_tables(conn)
        deleted = {}
        for table, where in plan:
            cur = conn.execute(f"DELETE FROM {_q(table)}" + (f" WHERE {where}" if where else ""))
            deleted[table] = cur.rowcount
        leads = conn.execute(f"UPDATE batches SET faculty_lead = NULL WHERE {DEMO_LEAD}").rowcount
        conn.execute("COMMIT")
    except BaseException as exc:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        problems = _move_back(moved)
        conn.close()
        if problems:
            print("Could not move these back - they are still in the backup folder:\n  " + "\n  ".join(problems))
        if isinstance(exc, ResetError):
            raise
        if isinstance(exc, sqlite3.Error):
            raise ResetError(f"Database error, nothing deleted: {exc}") from exc
        raise
    conn.close()

    print("Deleted:")
    width = max([len(t) for t in deleted] + [10])
    for table, count in deleted.items():
        print(f"  {table:<{width}}  {count:>7}")
    print(f"  {'total':<{width}}  {sum(deleted.values()):>7}")
    print(f"Demo faculty leads cleared: {leads}")
    print(f"Backup kept in {backup_dir}")
    return backup_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--yes", action="store_true", help="back up, then delete (default: dry run)")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"SQLite database (default {DEFAULT_DB})")
    parser.add_argument(
        "--root", type=Path, default=REPO_ROOT,
        help=f"folder holding uploads/, artifacts/ and backups/ (default {REPO_ROOT})",
    )
    args = parser.parse_args(argv)
    db, root = args.db, args.root
    if not db.is_file():
        print(f"Database {db} not found.", file=sys.stderr)
        return 1

    try:
        conn = _connect(db, read_only=True)
        try:
            plan = plan_tables(conn)
            totals = row_counts(conn)
            deleting = planned_counts(conn, plan)
            changes = batch_changes(conn, plan)
        finally:
            conn.close()
        files = files_to_move(root)
        print_plan(db, root, plan, deleting, totals, files)
        if changes:
            print("Batch changes:\n" + "\n".join(changes))
        if not args.yes:
            print("Dry run - nothing changed. Run again with --yes to back up and delete.")
            return 0
        print()
        reset(db, root)
    except (ResetError, sqlite3.Error) as exc:
        print(f"Reset failed, nothing deleted: {exc}", file=sys.stderr)
        return 1
    print("Reset complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
