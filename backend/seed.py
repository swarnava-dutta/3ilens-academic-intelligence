"""Seed data (spec Phase 5).

seed_base()        - institution "Instit-42", batch "NEET-A" / "Mock-07" and the
                     "Biology - Genetics" rubric. Runs on every server start (idempotent).
seed_demo_cohort() - OPTIONAL synthetic cohort for the Cohort Dashboard. No AI call is made:
                     synthetic OCR answers + grades are pushed through the same deterministic
                     insights engine as live uploads. Every row has is_demo=True. Idempotent.
                     Two high scorers carry a demo faculty sign-off (RELEASED).
seed_demo_extended() - set=mixed: NEET mixed sample rubric (illustrative), batch NEET-B, the 6 V5
                     sample learners and earlier mocks for 4 Genetics students (longitudinal history).
seed_demo_set()    - POST /api/demo/seed?set=genetics|mixed|all|insights dispatcher (insights: seed_insights.py).

CLI:  python seed.py          -> base seed only
      python seed.py --demo   -> base seed + synthetic Genetics demo cohort
      python seed.py --all    -> base seed + Genetics cohort + NEET mixed demo
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

import insights
from ai_schemas import Confusion, EvaluationOutput, OcrAnswer, QuestionGrade, TeachingNudgeAI
from config import get_settings
from database import (
    Batch,
    Institution,
    ReleaseStatus,
    Rubric,
    RubricStatus,
    SessionLocal,
    StudentSubmission,
    SubmissionStatus,
    init_db,
    utc_iso,
    utcnow,
)
from hashing import rubric_hash, student_ref_for
from results_store import build_evaluation_result
from rubric_store import create_rubric, ensure_rubric_fields
from schemas import ReportPayload, RubricContentIn

BACKEND_DIR = Path(__file__).resolve().parent
GENETICS_RUBRIC_FILE = BACKEND_DIR / "rubrics" / "biology_genetics_v1.json"
MIXED_RUBRIC_FILE = BACKEND_DIR / "rubrics" / "neet_mixed_mock08_v1.json"

INSTITUTION_NAME = "Instit-42"
BATCH_NAME = "NEET-A"
BATCH_EXAM_TYPE = "Mock-07"
GENETICS_RUBRIC_NAME = "Biology - Genetics"
GENETICS_RUBRIC_VERSION = "v1"
# set=mixed (sample / illustrative content - see seed_demo_extended)
MIXED_RUBRIC_NAME = "NEET Mixed - Mock 08"
MIXED_RUBRIC_VERSION = "v1"
SECOND_BATCH_NAME = "NEET-B"
SECOND_BATCH_EXAM_TYPE = "Mock-08"


def load_genetics_rubric() -> dict[str, Any]:
    return json.loads(GENETICS_RUBRIC_FILE.read_text(encoding="utf-8"))


def rubric_total_marks(content: dict[str, Any]) -> float:
    return float(sum(float(q["max_marks"]) for q in content.get("questions", [])))


def seed_base(session: Session) -> tuple[Institution, Batch, Rubric]:
    """Idempotently create the institution, batch and default Genetics rubric."""
    institution = session.scalar(select(Institution).where(Institution.name == INSTITUTION_NAME))
    if institution is None:
        institution = Institution(name=INSTITUTION_NAME)
        session.add(institution)
        session.flush()

    batch = session.scalar(
        select(Batch).where(
            Batch.name == BATCH_NAME,
            Batch.exam_type == BATCH_EXAM_TYPE,
            Batch.institution_id == institution.id,
        )
    )
    if batch is None:
        batch = Batch(name=BATCH_NAME, exam_type=BATCH_EXAM_TYPE, institution_id=institution.id)
        session.add(batch)
        session.flush()
    # Older databases: fill the target exam. exam_date stays NULL = the assumed NEET_EXAM_DATE
    # default (shown as "assumed" in the UI until faculty set a real date).
    for row in session.scalars(select(Batch).where(Batch.exam.is_(None))).all():
        row.exam = get_settings().default_exam

    content = load_genetics_rubric()
    total = rubric_total_marks(content)
    rubric = session.scalar(
        select(Rubric).where(Rubric.name == GENETICS_RUBRIC_NAME, Rubric.version == GENETICS_RUBRIC_VERSION)
    )
    if rubric is None:
        rubric = Rubric(
            name=GENETICS_RUBRIC_NAME, version=GENETICS_RUBRIC_VERSION, content=content, total_marks=total,
            rubric_hash=rubric_hash(content),
        )
        session.add(rubric)
    elif rubric.content != content or rubric.total_marks != total:
        rubric.content, rubric.total_marks = content, total  # keep in sync with the JSON file
    session.flush()
    # Older databases: backfill rubric_hash / status (NULL) on every rubric.
    for row in session.scalars(
        select(Rubric).where((Rubric.rubric_hash.is_(None)) | (Rubric.status.is_(None)) | (Rubric.id == rubric.id))
    ).all():
        ensure_rubric_fields(row)

    session.commit()
    return institution, batch, rubric


def get_default_rubric(session: Session) -> Rubric | None:
    rubric = session.scalar(
        select(Rubric).where(Rubric.name == GENETICS_RUBRIC_NAME, Rubric.version == GENETICS_RUBRIC_VERSION)
    )
    return rubric or session.scalar(select(Rubric).order_by(Rubric.id))


# --------------------------------------------------------------------------- #
# Synthetic demo cohort
# --------------------------------------------------------------------------- #
# Per question: three answer tiers (full / partial / weak), each with a plausible
# transcription, grader evidence, strengths and gaps; plus a minor gap used when a
# "full" answer still dropped half a mark.
ANSWER_BANK: dict[int, dict[str, Any]] = {
    1: {
        "full": {
            "answer": "Tt (tall) x tt (dwarf). Gametes: T, t and t. Offspring Tt, Tt, tt, tt. "
            "Genotypic ratio 1 Tt : 1 tt, phenotypic ratio 1 tall : 1 dwarf. This is a test cross - "
            "crossing with the recessive parent shows whether the tall plant is homozygous or heterozygous.",
            "evidence": "Shows Tt x tt with gametes, gives both 1:1 ratios and names the test cross with its purpose.",
            "strengths": ["Correct parental genotypes and gametes", "Genotypic and phenotypic ratios both correct",
                          "Identifies the test cross and why it is used"],
            "gaps": [],
        },
        "partial": {
            "answer": "Tt x tt gives Tt and tt. Ratio is 1:1 so half are tall and half dwarf. This is a back cross.",
            "evidence": "Correct cross and 1:1 outcome, but genotypic and phenotypic ratios are not separated and "
            "it is called a back cross.",
            "strengths": ["Correct cross Tt x tt", "1:1 tall : dwarf outcome"],
            "gaps": ["Genotypic ratio not stated separately from the phenotypic ratio",
                     "Calls it a back cross instead of a test cross"],
            "confusion": ("Test cross", "Back cross",
                          "Calls the Tt x tt cross a back cross; a test cross is specifically with the recessive parent."),
        },
        "weak": {
            "answer": "Tall x dwarf gives all tall plants in F1 and 3:1 in F2 because tall is dominant.",
            "evidence": "Treats the cross as TT x tt and quotes the F2 3:1 ratio - the heterozygous parent was missed.",
            "strengths": ["Knows tall is dominant over dwarf"],
            "gaps": ["Used TT instead of Tt for the heterozygous parent", "Gave 3:1 instead of the 1:1 test-cross ratio",
                     "Test cross not identified"],
        },
        "minor_gap": "Purpose of the test cross could be stated more explicitly",
    },
    2: {
        "full": {
            "answer": "Incomplete dominance: neither allele is completely dominant so the heterozygote is "
            "intermediate, e.g. snapdragon red (RR) x white (rr) gives pink (Rr), F2 1:2:1. Codominance: both "
            "alleles are expressed together, e.g. ABO blood group - IA IB gives blood group AB.",
            "evidence": "Contrasts an intermediate heterozygote with joint expression and gives snapdragon and "
            "AB blood group examples.",
            "strengths": ["Clear contrast between intermediate and joint expression",
                          "Correct example for both (snapdragon, AB blood group)"],
            "gaps": [],
        },
        "partial": {
            "answer": "In incomplete dominance the hybrid is a mix of both parents, like pink flowers in "
            "snapdragon. In codominance both genes are dominant, example sickle cell anaemia.",
            "evidence": "Incomplete dominance with the snapdragon example is correct; the codominance definition "
            "is vague and the example is not the standard one.",
            "strengths": ["Snapdragon pink-flower example for incomplete dominance"],
            "gaps": ["Codominance definition is imprecise", "Use the ABO blood group (IA IB) as the codominance example"],
        },
        "weak": {
            "answer": "Incomplete dominance and codominance are the same thing - both alleles are dominant, "
            "for example blood groups.",
            "evidence": "Treats the two concepts as identical and gives one example for both.",
            "strengths": ["Recalls blood groups as a genetics example"],
            "gaps": ["Cannot distinguish incomplete dominance from codominance",
                     "No intermediate-phenotype example (snapdragon / Mirabilis)"],
            "confusion": ("Incomplete dominance", "Codominance",
                          "States that incomplete dominance and codominance are the same thing."),
        },
        "minor_gap": "F2 1:2:1 ratio for incomplete dominance not mentioned",
    },
    3: {
        "full": {
            "answer": "Each new DNA molecule has one old (parental) strand and one newly made strand. Meselson "
            "and Stahl grew E. coli in 15N, moved it to 14N and used CsCl density-gradient centrifugation: "
            "hybrid 15N/14N DNA after one generation, equal hybrid and light DNA after two. DNA polymerase "
            "works 5'->3'; leading strand continuous, lagging strand as Okazaki fragments joined by ligase.",
            "evidence": "Defines semi-conservative replication, describes the 15N/14N CsCl experiment and its "
            "results, and adds leading/lagging strand detail.",
            "strengths": ["Correct definition of semi-conservative replication",
                          "Meselson-Stahl experiment described with 15N/14N and CsCl",
                          "Leading and lagging strand synthesis explained"],
            "gaps": [],
        },
        "partial": {
            "answer": "DNA replication is semi-conservative - one old strand and one new strand in each daughter "
            "molecule. It was proved by Meselson and Stahl using heavy nitrogen.",
            "evidence": "Defines semi-conservative replication and names Meselson and Stahl, but gives no "
            "density-gradient result or strand mechanics.",
            "strengths": ["Defines semi-conservative replication", "Names Meselson and Stahl"],
            "gaps": ["No description of the CsCl density-gradient results",
                     "Leading/lagging strands and Okazaki fragments missing"],
        },
        "weak": {
            "answer": "DNA makes a copy of itself by unwinding the helix. This was proved by Griffith's experiment.",
            "evidence": "Mentions unwinding only and credits Griffith instead of Meselson and Stahl.",
            "strengths": ["Knows the double helix unwinds during replication"],
            "gaps": ["Semi-conservative mechanism not explained", "Named Griffith instead of Meselson and Stahl",
                     "No 15N/14N experiment details"],
            "confusion": ("Griffith transformation experiment", "Meselson-Stahl experiment",
                          "Credits Griffith's transformation experiment with proving semi-conservative replication."),
        },
        "minor_gap": "Okazaki fragments not linked to DNA ligase",
    },
    4: {
        "full": {
            "answer": "Man XcY, woman XXc (carrier, because her colour-blind father gave her Xc). Gametes Xc, Y and "
            "X, Xc. Daughters XXc (carrier) and XcXc (colour-blind) - 50% of daughters colour-blind. Sons XY "
            "(normal) and XcY (colour-blind) - 50% of sons colour-blind.",
            "evidence": "Deduces the carrier mother from her father, completes the Punnett square and gives "
            "50% for sons and daughters separately.",
            "strengths": ["Deduces the mother is a carrier", "Complete Punnett square",
                          "Correct proportions for sons and daughters"],
            "gaps": [],
        },
        "partial": {
            "answer": "XcY x XXc. Children: XXc, XcXc, XY, XcY. So 50% of the children are colour-blind.",
            "evidence": "Correct genotypes and cross, but the proportions are not split by sons and daughters.",
            "strengths": ["Correct genotypes and Punnett square"],
            "gaps": ["Proportions not given separately for sons and daughters",
                     "Reason for the mother being a carrier not stated"],
        },
        "weak": {
            "answer": "Colour blindness is on the Y chromosome, so all sons will be colour-blind and daughters normal.",
            "evidence": "Places the gene on the Y chromosome; carrier mother and proportions are wrong.",
            "strengths": ["Recognises colour blindness is sex-linked"],
            "gaps": ["Gene placed on the Y instead of the X chromosome", "Mother's carrier status missed",
                     "Proportions of affected sons and daughters incorrect"],
        },
        "minor_gap": "Carrier daughters not explicitly labelled",
    },
    5: {
        "full": {
            "answer": "Down's syndrome is a chromosomal disorder (aneuploidy) caused by trisomy of chromosome 21 - "
            "47 chromosomes. It usually arises from non-disjunction of chromosome 21 during meiosis. Symptoms: "
            "short stature, small round head, furrowed tongue, partially open mouth, broad palm with a "
            "characteristic crease, mental retardation.",
            "evidence": "Classifies it as aneuploidy, gives trisomy 21 via non-disjunction and lists several symptoms.",
            "strengths": ["Correct cause: trisomy 21 via meiotic non-disjunction", "Several accurate symptoms"],
            "gaps": [],
        },
        "partial": {
            "answer": "Down's syndrome is due to an extra chromosome 21 (trisomy 21). Patients are short and have "
            "mental retardation.",
            "evidence": "Identifies trisomy 21 and two symptoms; non-disjunction is not mentioned.",
            "strengths": ["Identifies trisomy 21", "Two valid symptoms"],
            "gaps": ["Non-disjunction during meiosis not mentioned",
                     "Not explicitly classified as a chromosomal disorder / aneuploidy"],
        },
        "weak": {
            "answer": "Down's syndrome is a genetic disease caused by a mutation in a gene. The patient has a weak heart.",
            "evidence": "Attributes it to a gene mutation; gives only one symptom.",
            "strengths": ["Mentions congenital heart problems"],
            "gaps": ["Cause is trisomy 21, not a single-gene mutation", "Non-disjunction not explained",
                     "Only one symptom given"],
        },
        "minor_gap": "Could add a third symptom for completeness",
    },
}

# (student name, marks for Q1..Q5 out of 4 each, base OCR confidence) - strong to weak.
DEMO_STUDENTS: list[tuple[str, list[float], float]] = [
    ("Ananya Iyer", [4, 4, 3.5, 4, 4], 0.96),
    ("Aarav Sharma", [4, 3.5, 3, 4, 3.5], 0.94),
    ("Diya Reddy", [4, 3, 3, 3.5, 4], 0.93),
    ("Vihaan Gupta", [3.5, 3, 2, 3, 4], 0.91),
    ("Ishaan Nair", [4, 2.5, 2, 3, 3], 0.95),
    ("Saanvi Patel", [3, 3, 1.5, 2.5, 3.5], 0.89),
    ("Kabir Singh", [3.5, 2, 1.5, 2, 3], 0.92),
    ("Meera Krishnan", [3, 2, 1, 2.5, 2.5], 0.90),
    ("Arjun Mehta", [2.5, 1.5, 1, 2, 2.5], 0.88),
    ("Riya Das", [2, 1.5, 0.5, 1.5, 2], 0.87),
    ("Rohan Joshi", [1.5, 1, 0.5, 1, 2], 0.86),
    ("Priya Banerjee", [1, 0.5, 0, 1, 1.5], 0.89),
]
# A demo sheet that the Phase 4 safety check routed to faculty review (amber in the UI).
DEMO_REVIEW_STUDENT = "Aditya Kulkarni"
DEMO_NOTE = "Synthetic demo record - generated locally without any AI call."
# Two high scorers already carry a (demo) faculty sign-off, so the release gate is visible.
DEMO_RELEASED = ("Ananya Iyer", "Aarav Sharma")
DEMO_REVIEWER = "Dr. A. Rao (demo)"


def _release_demo(sub: StudentSubmission, reviewed_at: datetime) -> None:
    assert sub.result is not None
    sub.result.release_status = ReleaseStatus.RELEASED
    sub.result.reviewed_by = DEMO_REVIEWER
    sub.result.reviewed_at = reviewed_at
    sub.result.review_note = "Demo sign-off: marks checked against the rubric."
    sub.processing_log = [
        *(sub.processing_log or []),
        {
            "step": "Faculty sign-off",
            "message": f"Released by {DEMO_REVIEWER} - faculty sign-off recorded (synthetic demo).",
            "timestamp": utc_iso(reviewed_at),
        },
    ]


def _slug(name: str) -> str:
    return "_".join(name.lower().split())


def _tier(marks: float, max_marks: float) -> str:
    ratio = marks / max_marks if max_marks else 0
    if ratio >= 0.85:
        return "full"
    return "partial" if ratio >= 0.45 else "weak"


def _demo_log(created, steps: list[tuple[str, str]]) -> list[dict[str, str]]:
    return [
        {"step": step, "message": message, "timestamp": utc_iso(created + timedelta(seconds=6 * i))}
        for i, (step, message) in enumerate(steps)
    ]


def build_demo_inputs(
    content: dict[str, Any], marks: list[float], base_confidence: float
) -> tuple[list[OcrAnswer], EvaluationOutput]:
    """Synthetic OCR answers + grades for one student (what AI calls 1 and 2 would return)."""
    answers: list[OcrAnswer] = []
    grades: list[QuestionGrade] = []
    confusions: list[Confusion] = []
    scored: list[tuple[float, str, QuestionGrade]] = []
    for index, question in enumerate(content["questions"]):
        number = int(question["question"])
        max_marks = float(question["max_marks"])
        awarded = min(max(float(marks[index % len(marks)]), 0.0), max_marks)
        bank = ANSWER_BANK.get(number, ANSWER_BANK[(index % 5) + 1])
        tier = bank[_tier(awarded, max_marks)]
        gaps = list(tier["gaps"])
        if not gaps and awarded < max_marks:
            gaps = [bank["minor_gap"]]
        if tier.get("confusion"):
            concept_a, concept_b, evidence = tier["confusion"]
            confusions.append(Confusion(concept_a=concept_a, concept_b=concept_b, question=number, evidence=evidence))
        confidence = round(min(0.99, max(0.5, base_confidence + ((number * 7) % 5 - 2) * 0.01)), 2)
        answers.append(
            OcrAnswer(question=number, answer=tier["answer"], confidence=confidence, pages=[1 + index // 3])
        )
        grade = QuestionGrade(
            question=number,
            estimated_marks=awarded,
            evidence=tier["evidence"],
            strengths=list(tier["strengths"]),
            gaps=gaps,
        )
        grades.append(grade)
        scored.append((awarded / max_marks, question["topic"], grade))

    best = sorted(scored, key=lambda s: -s[0])[:2]
    worst = sorted(scored, key=lambda s: s[0])[:2]
    overall_strengths = [
        f"{topic}: {grade.strengths[0]}" for _, topic, grade in best if grade.strengths
    ] or ["Attempted every question on the sheet"]
    overall_gaps = [f"{topic}: {grade.gaps[0]}" for ratio, topic, grade in worst if grade.gaps and ratio < 1]
    if not overall_gaps:
        overall_gaps = ["Keep practising timed full-length papers to retain full marks"]
    evaluation = EvaluationOutput(
        evaluations=grades, overall_strengths=overall_strengths, overall_gaps=overall_gaps, confusions=confusions
    )
    return answers, evaluation


def seed_demo_cohort(session: Session) -> int:
    """Insert the synthetic demo cohort (is_demo=True). Returns how many rows were created."""
    _, batch, rubric = seed_base(session)
    # Scoped to the Genetics rubric: set=mixed adds earlier assessments for some of these names.
    existing = set(
        session.scalars(
            select(StudentSubmission.student_name).where(
                StudentSubmission.is_demo.is_(True), StudentSubmission.rubric_id == rubric.id
            )
        ).all()
    )
    now = utcnow()
    created = 0
    total = len(DEMO_STUDENTS)
    for position, (name, marks, base_conf) in enumerate(DEMO_STUDENTS):
        if name in existing:
            continue
        answers, evaluation = build_demo_inputs(rubric.content, marks, base_conf)
        report = insights.build_evaluation_report(rubric.content, answers, evaluation)
        ReportPayload.model_validate(report)  # same contract check as the live pipeline
        ocr_confidence = round(sum(a.confidence for a in answers) / len(answers), 2)
        created_at = now - timedelta(hours=3, minutes=41 * (total - position))
        score, out_of = float(report["total_score"]), float(report["total_marks"])
        submission = StudentSubmission(
            student_name=name,
            file_path="",
            original_filename=f"{_slug(name)}_genetics_mock07.pdf",
            mime_type="application/pdf",
            status=SubmissionStatus.COMPLETED,
            ocr_confidence=ocr_confidence,
            current_step="Completed",
            error_message=None,
            processing_log=_demo_log(
                created_at,
                [
                    ("Ingestion", DEMO_NOTE),
                    ("Pre-processing", "Simulating Deskew and 300 DPI Contrast Enhancement."),
                    ("OCR & Parse", f"Synthetic transcription of {len(answers)} answers; "
                                    f"overall OCR confidence {ocr_confidence:.2f}."),
                    ("Rubric Evaluation", f"Synthetic grades for {len(evaluation.evaluations)} questions."),
                    ("Insights & ROI", "Topic mastery and Preparation ROI computed by the deterministic engine."),
                    ("Persistence", f"Saved to the governed results store: {score:g}/{out_of:g} marks."),
                ],
            ),
            is_demo=True,
            batch_id=batch.id,
            rubric_id=rubric.id,
            created_at=created_at,
            updated_at=created_at + timedelta(seconds=36),
            student_ref=student_ref_for(name),
            language_hints=["en"],
            started_at=created_at + timedelta(seconds=6),
            completed_at=created_at + timedelta(seconds=36),
        )
        submission.result = build_evaluation_result(
            report, rubric=rubric, created_at=created_at + timedelta(seconds=36)
        )
        if name in DEMO_RELEASED:
            _release_demo(submission, created_at + timedelta(minutes=50))
        session.add(submission)
        created += 1

    if DEMO_REVIEW_STUDENT not in existing:
        created_at = now - timedelta(hours=2, minutes=12)
        threshold = get_settings().ocr_confidence_threshold
        message = (
            f"OCR confidence 0.65 is below the {threshold:.2f} threshold - "
            "routed to faculty review; AI evaluation skipped."
        )
        session.add(
            StudentSubmission(
                student_name=DEMO_REVIEW_STUDENT,
                file_path="",
                original_filename=f"{_slug(DEMO_REVIEW_STUDENT)}_blurry_scan.jpg",
                mime_type="image/jpeg",
                status=SubmissionStatus.HUMAN_REVIEW_REQUIRED,
                ocr_confidence=0.65,
                current_step="Human review",
                error_message=message,
                processing_log=_demo_log(
                    created_at, [("Ingestion", DEMO_NOTE), ("Human review", message)]
                ),
                is_demo=True,
                batch_id=batch.id,
                rubric_id=rubric.id,
                created_at=created_at,
                updated_at=created_at + timedelta(seconds=6),
                student_ref=student_ref_for(DEMO_REVIEW_STUDENT),
                language_hints=["en"],
                flagged_pages=[1],
                page_confidences=[{"page": 1, "confidence": 0.65}],
            )
        )
        created += 1

    session.commit()
    return created


# --------------------------------------------------------------------------- #
# set=mixed: NEET mixed-subject demo (sample / illustrative content, no AI call)
# --------------------------------------------------------------------------- #
# The 10 sample topics of the V5 payload, in payload order (mastery arrays follow this order).
MIXED_TOPICS = (
    "Genetics", "Human Physiology", "Cell Biology", "Organic Chemistry", "Ecology",
    "Electrostatics", "Plant Physiology", "Mechanics", "Thermodynamics", "Chemical Bonding",
)
SYNTHETIC_TRANSCRIPTION = "Synthetic demo transcription"
MIXED_NOTE = (
    "Synthetic demo record (NEET mixed sample rubric - illustrative content) - generated locally without any AI call."
)


# (V5 learner id, batch, mastery % per MIXED_TOPICS, payload urgency, strengths, gaps, nudges)
MIXED_LEARNERS: tuple[tuple[str, str, list[int], str, list[str], list[str], list[str]], ...] = (
    ("A01", BATCH_NAME, [62, 80, 76, 68, 88, 54, 72, 84, 66, 78], "on_track",
     ["Ecology fundamentals", "Human physiology"], ["Genetics exceptions", "Organic reaction chains"],
     ["Target application questions in Genetics", "Maintain Ecology with a short refresher",
      "Check misconception patterns in Organic Chemistry"]),
    ("A02", BATCH_NAME, [44, 66, 58, 46, 76, 39, 62, 70, 52, 61], "needs_attention",
     ["Plant physiology", "Ecology recall"], ["Genetics reasoning", "Electrostatics application"],
     ["Review missed inheritance questions", "Run targeted physics problem set",
      "Use spaced recall for high-weightage weak units"]),
    ("A03", BATCH_NAME, [29, 55, 38, 34, 66, 25, 46, 60, 40, 48], "at_risk",
     ["Ecology fact recall", "Cell structure basics"], ["Molecular genetics", "Organic Chemistry concepts"],
     ["Short faculty check-in on high-weightage gaps", "Rebuild inheritance fundamentals",
      "Schedule a monitored practice review"]),
    ("A04", BATCH_NAME, [64, 84, 83, 72, 78, 57, 79, 80, 74, 76], "on_track",
     ["Human physiology", "Mechanics"], ["Thermodynamics numericals", "Genetics edge cases"],
     ["Review thermodynamics errors", "Maintain physics strengths", "Follow up on inheritance traps"]),
    ("B01", SECOND_BATCH_NAME, [52, 68, 49, 43, 70, 48, 58, 74, 46, 56], "needs_attention",
     ["Ecology facts", "Organic structure naming"], ["Electrostatics", "Cell cycle reasoning"],
     ["Review electric field problems", "Compare mitosis and meiosis steps", "Repeat short timed drills"]),
    ("B02", SECOND_BATCH_NAME, [31, 43, 32, 29, 55, 22, 39, 48, 34, 37], "at_risk",
     ["Basic biology recognition", "Simple algebra"], ["Genetics", "Cell Biology", "Organic Chemistry"],
     ["Hold diagnostic faculty discussion", "Start with one high-yield conceptual gap",
      "Reassess OCR and concept mapping for unclear answers"]),
)
# Keyword -> sample topic, to attach the payload nudges to a rubric topic.
NUDGE_TOPIC_HINTS = (
    ("inheritance", "Genetics"), ("genetic", "Genetics"), ("ecology", "Ecology"), ("organic", "Organic Chemistry"),
    ("thermodynamic", "Thermodynamics"), ("electric", "Electrostatics"), ("mitosis", "Cell Biology"),
)
# Weak-topic confusions (deterministic) for the mixed demo: topic -> (concept A, concept B, evidence).
MIXED_CONFUSIONS = {
    "Genetics": ("Codominance", "Incomplete dominance", "Treats the AB blood group as a blend of A and B."),
    "Cell Biology": ("Mitosis", "Meiosis", "Places crossing over in mitotic prophase."),
    "Electrostatics": ("Electric field", "Electric potential", "Adds field vectors as if they were scalar potentials."),
    "Organic Chemistry": ("SN1", "SN2", "Writes a one-step backside attack for tert-butyl bromide."),
}
MIXED_CONFUSION_BELOW = 50.0
# Longitudinal history: earlier mixed mocks for four Genetics demo students (same student_ref).
HISTORY_STUDENTS = ("Ananya Iyer", "Aarav Sharma", "Kabir Singh", "Riya Das")
HISTORY_MOCKS = (("Mock-05", 30, 14.0), ("Mock-06", 16, 7.0))  # (label, days ago, points below the current level)


def _half_up(value: float) -> float:
    return math.floor(value * 2 + 0.5) / 2


def load_mixed_rubric() -> dict[str, Any]:
    return json.loads(MIXED_RUBRIC_FILE.read_text(encoding="utf-8"))


def seed_mixed_rubric(session: Session) -> Rubric:
    """The 'NEET Mixed - Mock 08' v1 rubric (FACULTY_APPROVED, sample content). Idempotent."""
    rubric = session.scalar(
        select(Rubric).where(Rubric.name == MIXED_RUBRIC_NAME, Rubric.version == MIXED_RUBRIC_VERSION)
    )
    if rubric is None:
        rubric = create_rubric(
            session,
            RubricContentIn.model_validate(load_mixed_rubric()),
            status=RubricStatus.FACULTY_APPROVED,
            version=MIXED_RUBRIC_VERSION,
            change_note="Synthetic NEET mixed demo rubric - sample / illustrative content, not a real paper.",
        )
    return rubric


def seed_second_batch(session: Session, institution: Institution) -> Batch:
    """Batch 'NEET-B' / 'Mock-08' (exam NEET; exam_date NULL = the assumed default date). Idempotent."""
    batch = session.scalar(
        select(Batch).where(
            Batch.name == SECOND_BATCH_NAME,
            Batch.exam_type == SECOND_BATCH_EXAM_TYPE,
            Batch.institution_id == institution.id,
        )
    )
    if batch is None:
        batch = Batch(
            name=SECOND_BATCH_NAME, exam_type=SECOND_BATCH_EXAM_TYPE, institution_id=institution.id,
            exam=get_settings().default_exam,
        )
        session.add(batch)
        session.flush()
    return batch


def _mixed_nudges(nudges: list[str], content: dict[str, Any]) -> list[TeachingNudgeAI]:
    by_topic: dict[str, list[int]] = {}
    for q in content["questions"]:
        by_topic.setdefault(q["topic"], []).append(int(q["question"]))
    out = []
    for priority, text in zip(("high", "medium", "low"), nudges):
        lowered = text.lower()
        topic = next((name for name in MIXED_TOPICS if name.lower() in lowered), None)
        topic = topic or next((name for hint, name in NUDGE_TOPIC_HINTS if hint in lowered), None)
        out.append(TeachingNudgeAI(
            priority=priority,
            label=" ".join(text.split()[:6]),
            text=f"{text} (sample nudge from the V5 demo learner profile).",
            topic=topic,
            question_refs=by_topic.get(topic, []) if topic else [],
        ))
    return out


def build_mixed_inputs(
    content: dict[str, Any],
    mastery: dict[str, float],
    *,
    strengths: list[str],
    gaps: list[str],
    nudges: list[str] | None = None,
    base_confidence: float = 0.9,
) -> tuple[list[OcrAnswer], EvaluationOutput]:
    """Synthetic answers + grades from a per-topic mastery profile: each question earns mastery% of
    its max marks, rounded half-up to 0.5. Answers and evidence are plainly labelled synthetic."""
    answers: list[OcrAnswer] = []
    grades: list[QuestionGrade] = []
    confusions: list[Confusion] = []
    seen_topics: set[str] = set()
    for index, q in enumerate(content["questions"]):
        number, topic = int(q["question"]), q["topic"]
        max_marks = float(q["max_marks"])
        level = max(0.0, min(100.0, float(mastery.get(topic, 50.0))))
        marks = min(max_marks, max(0.0, _half_up(level / 100 * max_marks)))
        criteria = [insights.strip_marks_prefix(c) for c in q.get("grading_criteria") or []]
        covered = criteria[: int(marks)]
        partly = criteria[int(marks)] if marks % 1 and int(marks) < len(criteria) else None
        missed = criteria[int(marks) + (1 if partly else 0):]
        if marks <= 0:
            answer = ""
        else:
            answer = f"{SYNTHETIC_TRANSCRIPTION} (no real answer sheet): " + "; ".join(covered or [partly or ""])
            if partly and covered:
                answer += f"; partly: {partly}"
        evidence = (
            f"Synthetic demo grading: {marks:g}/{max_marks:g} - covers {len(covered)} of {len(criteria)} rubric points"
            + (", one only partly" if partly else "") + "."
        )
        grade_gaps = ([f"Incomplete: {partly}"] if partly else []) + [f"Missing: {m}" for m in missed[:2]]
        grades.append(QuestionGrade(
            question=number, estimated_marks=marks, evidence=evidence,
            strengths=[f"States: {c}" for c in covered[:2]], gaps=grade_gaps,
        ))
        confidence = round(min(0.99, max(0.75, base_confidence + ((number * 5) % 7 - 3) * 0.01)), 2)
        answers.append(OcrAnswer(question=number, answer=answer, confidence=confidence, pages=[1 + index // 4]))
        if topic in MIXED_CONFUSIONS and level < MIXED_CONFUSION_BELOW and topic not in seen_topics:
            seen_topics.add(topic)
            concept_a, concept_b, why = MIXED_CONFUSIONS[topic]
            confusions.append(Confusion(concept_a=concept_a, concept_b=concept_b, question=number, evidence=why))
    evaluation = EvaluationOutput(
        evaluations=grades,
        overall_strengths=list(strengths),
        overall_gaps=list(gaps),
        summary="",
        teaching_nudges=_mixed_nudges(nudges or [], content),
        confusions=confusions,
    )
    return answers, evaluation


def _mixed_submission(
    *,
    name: str,
    filename: str,
    batch: Batch,
    rubric: Rubric,
    answers: list[OcrAnswer],
    evaluation: EvaluationOutput,
    created_at: datetime,
) -> StudentSubmission:
    report = insights.build_evaluation_report(rubric.content, answers, evaluation)
    for nudge in report.get("teaching_nudges") or []:
        nudge["source"] = "template"  # sample nudges from the V5 payload, not model output
    ReportPayload.model_validate(report)
    confidences = [a.confidence for a in answers if a.answer]
    ocr_confidence = round(sum(confidences) / len(confidences), 2) if confidences else 0.0
    score, out_of = float(report["total_score"]), float(report["total_marks"])
    submission = StudentSubmission(
        student_name=name,
        file_path="",
        original_filename=filename,
        mime_type="application/pdf",
        status=SubmissionStatus.COMPLETED,
        ocr_confidence=ocr_confidence,
        current_step="Completed",
        error_message=None,
        processing_log=_demo_log(
            created_at,
            [
                ("Ingestion", MIXED_NOTE),
                ("Pre-processing", "Simulating Deskew and 300 DPI Contrast Enhancement."),
                ("OCR & Parse", f"{SYNTHETIC_TRANSCRIPTION} of {len(answers)} answers; "
                                f"overall OCR confidence {ocr_confidence:.2f}."),
                ("Rubric Evaluation", f"Synthetic grades for {len(evaluation.evaluations)} questions "
                                      "derived from the sample mastery profile."),
                ("Insights & ROI", "Topic mastery and Preparation ROI computed by the deterministic engine."),
                ("Persistence", f"Saved to the governed results store: {score:g}/{out_of:g} marks."),
            ],
        ),
        is_demo=True,
        batch_id=batch.id,
        rubric_id=rubric.id,
        created_at=created_at,
        updated_at=created_at + timedelta(seconds=36),
        student_ref=student_ref_for(name),
        language_hints=["en"],
        started_at=created_at + timedelta(seconds=6),
        completed_at=created_at + timedelta(seconds=36),
    )
    submission.result = build_evaluation_result(report, rubric=rubric, created_at=created_at + timedelta(seconds=36))
    return submission


def _history_profile(genetics_marks: list[float], drop: float, salt: int) -> dict[str, float]:
    """Deterministic earlier-mock mastery from a student's Genetics profile: the current Genetics
    level, `drop` points lower, with a fixed per-topic spread."""
    level = sum(genetics_marks) / (4.0 * len(genetics_marks)) * 100
    profile = {}
    for index, topic in enumerate(MIXED_TOPICS):
        spread = ((index * 37 + salt * 11) % 15) - 7
        profile[topic] = max(5.0, min(100.0, level - drop + spread))
    return profile


def seed_demo_extended(session: Session) -> int:
    """set=mixed: the NEET mixed-subject demo. Idempotent, no AI call, every row is_demo:

    - rubric 'NEET Mixed - Mock 08' v1 (12 x 4 marks over the 10 V5 sample topics, FACULTY_APPROVED);
    - batch 'NEET-B' / 'Mock-08';
    - the 6 V5 sample learners (A01-A04 in NEET-A, B01-B02 in NEET-B) about 2 days ago, marks from
      their mastery arrays (the payload urgency labels are reproduced);
    - longitudinal history: Mock-05 / Mock-06 mixed assessments 30 and 16 days ago for four Genetics
      demo students (same student_ref, so their history shows 3 dated assessments).
    Returns how many submissions were created."""
    institution, base_batch, _ = seed_base(session)
    rubric = seed_mixed_rubric(session)
    second = seed_second_batch(session, institution)
    batches = {BATCH_NAME: base_batch, SECOND_BATCH_NAME: second}
    existing = set(
        session.scalars(
            select(StudentSubmission.original_filename).where(StudentSubmission.is_demo.is_(True))
        ).all()
    )
    content = rubric.content
    now = utcnow()
    created = 0

    for position, (learner, batch_name, levels, _urgency, strengths, gaps, nudges) in enumerate(MIXED_LEARNERS):
        name = f"Student {learner}"
        filename = f"student_{learner.lower()}_neet_mixed_mock08.pdf"
        if filename in existing:
            continue
        answers, evaluation = build_mixed_inputs(
            content, dict(zip(MIXED_TOPICS, map(float, levels))), strengths=strengths, gaps=gaps, nudges=nudges,
            base_confidence=0.9 - 0.01 * position,
        )
        session.add(_mixed_submission(
            name=name, filename=filename, batch=batches[batch_name], rubric=rubric, answers=answers,
            evaluation=evaluation, created_at=now - timedelta(days=2, minutes=37 * (len(MIXED_LEARNERS) - position)),
        ))
        created += 1

    genetics_marks = {name: marks for name, marks, _ in DEMO_STUDENTS}
    for salt, student in enumerate(HISTORY_STUDENTS):
        for label, days_ago, drop in HISTORY_MOCKS:
            filename = f"{_slug(student)}_neet_mixed_{label.lower().replace('-', '')}.pdf"
            if filename in existing:
                continue
            profile = _history_profile(genetics_marks[student], drop, salt)
            ranked = sorted(profile.items(), key=lambda item: -item[1])
            answers, evaluation = build_mixed_inputs(
                content, profile,
                strengths=[f"{topic}: steady recall" for topic, _ in ranked[:2]],
                gaps=[f"{topic}: needs consolidation" for topic, _ in ranked[-2:]],
                base_confidence=0.9,
            )
            session.add(_mixed_submission(
                name=student, filename=filename, batch=base_batch, rubric=rubric, answers=answers,
                evaluation=evaluation, created_at=now - timedelta(days=days_ago, minutes=23 * salt),
            ))
            created += 1

    session.commit()
    return created


DEMO_SETS = ("genetics", "mixed", "all", "insights")


def seed_demo_set(session: Session, set_name: str = "genetics") -> int:
    """genetics -> seed_demo_cohort (13 rows); mixed -> seed_demo_extended; all -> both (27);
    insights -> seed_insights.seed_insights_demo (wave 2 sample set; not part of "all")."""
    if set_name not in DEMO_SETS:
        raise ValueError(f"Unknown demo set '{set_name}' (expected one of {', '.join(DEMO_SETS)}).")
    if set_name == "insights":
        import seed_insights  # local import: seed_insights imports this module

        return seed_insights.seed_insights_demo(session)
    created = 0
    if set_name in ("genetics", "all"):
        created += seed_demo_cohort(session)
    if set_name in ("mixed", "all"):
        created += seed_demo_extended(session)
    return created


def main(argv: list[str]) -> int:
    init_db()
    with SessionLocal() as session:
        institution, batch, rubric = seed_base(session)
        print(
            f"Base seed OK: institution '{institution.name}', batch '{batch.name} {batch.exam_type}', "
            f"rubric '{rubric.name}' {rubric.version} ({rubric.total_marks:g} marks)."
        )
        if "--demo" in argv or "--all" in argv:
            created = seed_demo_set(session, "all" if "--all" in argv else "genetics")
            print(f"Demo cohort: created {created} synthetic submission(s) (is_demo=true)."
                  if created else "Demo cohort already present - nothing to add.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
