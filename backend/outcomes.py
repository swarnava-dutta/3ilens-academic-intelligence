"""Intervention log and outcome tracking (FR-4.13). Owned by W2-3; W2-0 wrote schema-valid stubs.

Effectiveness is observational (treated vs untreated topics of the same students); the
calibration factor it suggests is applied only in the owner's what-if when asked, never to the
BRD ROI.
"""
from __future__ import annotations

from typing import Any

from database import utcnow

CAVEAT = (
    "Observational: treated vs untreated topics of the same students. Interventions are not assumed to cause "
    "the score changes."
)
MIN_CALIBRATION_N = 5


def result_extras(db: Any, *, sub: Any, result: Any) -> dict[str, Any]:
    """{"interventions": InterventionRecord[]} for the student of this result. Stub until W2-3."""
    return {"interventions": []}


def effectiveness(db: Any, *, institution_id: int | None = None, batch_id: int | None = None) -> dict[str, Any]:
    """An InterventionEffectiveness. Stub: zero counts until W2-3."""
    return {
        "institution_id": institution_id,
        "batch_id": batch_id,
        "records": 0,
        "measured": 0,
        "pending": 0,
        "mean_change_treated": None,
        "mean_change_control": None,
        "uplift": None,
        "by_kind": [],
        "by_topic": [],
        "by_institution": [],
        "is_demo": False,
        "caveat": CAVEAT,
        "generated_at": utcnow(),
    }
