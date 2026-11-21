"""The set=insights sample dataset (owned by W2-3): NEET MCQ Mock 09/10 sample papers, batch
NEET-C (sample), 12 students, interventions and a sample voice answer. Every row is is_demo and
every name carries "(sample)". W2-0 stub: creates nothing.
"""
from __future__ import annotations

from sqlalchemy.orm import Session


def seed_insights_demo(session: Session) -> int:
    """Seed the insights sample set; returns the number of submissions created. Stub: 0."""
    return 0
