"""Run test answer sheets through the REAL 3iLens pipeline (live AI calls, uses .env keys).

    backend\\.venv\\Scripts\\python.exe test-pages\\run_live_test.py            # every sheet in test-pages/
    backend\\.venv\\Scripts\\python.exe test-pages\\run_live_test.py <file>...  # specific sheets

Uses a throwaway database and storage under .run/live_test/, so the app's real database
(backend/3ilens.db) and uploads/ stay untouched. Needs no running server.
Each sheet costs two Claude calls (OCR + grading), except "blurry" files, which stop before any AI call.
"""
from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUN = ROOT / ".run" / "live_test" / (os.environ.get("LIVE_TEST_NAME") or "default")  # set LIVE_TEST_NAME for parallel runs
if RUN.exists():
    shutil.rmtree(RUN)
(RUN / "uploads").mkdir(parents=True)
os.environ["DATABASE_URL"] = f"sqlite:///{(RUN / 'live.db').as_posix()}"
os.environ["UPLOAD_DIR"] = str(RUN / "uploads")
os.environ["ARTIFACT_DIR"] = str(RUN / "artifacts")
sys.path.insert(0, str(ROOT / "backend"))

import ai  # noqa: E402
import pipeline  # noqa: E402
from config import get_settings  # noqa: E402
from database import EvaluationResult, SessionLocal, StudentSubmission, init_db  # noqa: E402
from seed import ensure_genetics_rubric, seed_base  # noqa: E402

MIME = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg", ".webp": "image/webp"}


def sheets_from_args() -> list[Path]:
    if len(sys.argv) > 1:
        out: list[Path] = []
        for a in sys.argv[1:]:
            p = Path(a).resolve()
            out.extend(sorted(x for x in p.rglob("*") if x.suffix.lower() in MIME) if p.is_dir() else [p])
        return out
    here = Path(__file__).resolve().parent
    return sorted(p for p in here.rglob("*") if p.suffix.lower() in MIME)


def main() -> int:
    settings = get_settings()
    ready, missing = ai.ai_readiness()
    print(f"Model: {settings.anthropic_model} | vision: {settings.vision_provider} | "
          f"endpoint: {settings.anthropic_base_url} | AI ready: {ready} {missing or ''}")
    init_db()
    with SessionLocal() as db:
        _, batch, _ = seed_base(db)
        rubric = ensure_genetics_rubric(db)  # no saved rubrics: every sheet answers this sample key
        db.commit()
        batch_id, rubric_id = batch.id, rubric.id

    failures = 0
    for sheet in sheets_from_args():
        mime = MIME.get(sheet.suffix.lower())
        if not sheet.is_file() or not mime:
            print(f"\n!! skipping {sheet} (missing or unsupported type)")
            continue
        stored = RUN / "uploads" / sheet.name
        shutil.copyfile(sheet, stored)
        with SessionLocal() as db:
            sub = StudentSubmission(
                student_name=sheet.stem.replace("answer_sheet_", "").replace("_", " ").title(),
                file_path=str(stored), original_filename=sheet.name, mime_type=mime,
                batch_id=batch_id, rubric_id=rubric_id,
            )
            db.add(sub)
            db.commit()
            sub_id = sub.id

        print(f"\n=== {sheet.relative_to(ROOT)} ===")
        started = time.perf_counter()
        pipeline.process_submission(sub_id)
        elapsed = time.perf_counter() - started

        with SessionLocal() as db:
            sub = db.get(StudentSubmission, sub_id)
            result = db.query(EvaluationResult).filter_by(submission_id=sub_id).one_or_none()
            conf = f"{sub.ocr_confidence:.2f}" if sub.ocr_confidence is not None else "-"
            print(f"status: {sub.status} | OCR confidence: {conf} | {elapsed:.1f}s")
            if sub.error_message:
                print(f"message: {sub.error_message}")
            if result is None:
                if sub.status == "FAILED":
                    failures += 1
                continue
            print(f"score: {result.total_score} / {result.total_marks} | mastery: {result.overall_mastery}%")
            for q in result.question_evaluations:
                answer = " ".join(q["student_answer"].split())[:90]
                print(f"  Q{q['question']} {q['estimated_marks']}/{q['max_marks']} "
                      f"(ocr {q['confidence']:.2f}) {q['topic']}: \"{answer}\"")
            print("  strengths:", "; ".join(result.strengths_gaps.get("strengths", [])))
            print("  gaps:     ", "; ".join(result.strengths_gaps.get("gaps", [])))
            for i, p in enumerate(result.roi_recommendations[:3], 1):
                print(f"  ROI #{i}: {p['topic']} roi={p['roi']} mastery={p['mastery']}% effort={p['effort_hours']}h")

    print(f"\nArtifacts (OCR JSON, evaluation JSON, page images): {RUN / 'artifacts'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
