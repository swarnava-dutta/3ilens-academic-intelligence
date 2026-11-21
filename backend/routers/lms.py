"""[W2-2] Read-only LMS export with hashed API keys (FR-5.10; contract v3, API_CONTRACT.md).

- Key management (local admin, no API key): GET /api/lms/info, GET/POST /api/lms/keys,
  POST /api/lms/keys/{id}/revoke. PoC only: there is no login, so these are open to anyone who
  can reach the API. Production needs the admin / owner role from the identity provider.
- Export (header X-API-Key): GET /api/lms/v1/batches, /students, /results, /results.csv,
  /topic-mastery.csv. Released (faculty signed-off) results only unless include_provisional=true.
  Errors: 401 missing_api_key, 403 invalid_api_key, 503 lms_disabled, 422 invalid_since.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, Security
from fastapi.responses import Response as RawResponse
from fastapi.security import APIKeyHeader
from sqlalchemy import select
from sqlalchemy.orm import Session

import lms
from config import get_settings
from database import ApiKey, Institution, get_db
from errors import ApiError
from schemas import (
    ApiKeyCreated,
    ApiKeyInput,
    ApiKeyOut,
    LmsBatch,
    LmsInfo,
    LmsResultRow,
    LmsStudent,
)

router = APIRouter()
DbSession = Annotated[Session, Depends(get_db)]
ADMIN_TAG = "LMS keys (local admin)"
EXPORT_TAGS: list[str] = [lms.EXPORT_TAG]
RELEASED_NOTE = (
    "Only RELEASED results (faculty sign-off) are returned unless include_provisional=true. "
    "Demo / sample rows carry is_demo=true; pass include_demo=false to leave them out."
)

api_key_header = APIKeyHeader(
    name=lms.HEADER_NAME, auto_error=False, description="3iLens LMS export key (create one on the Integrations page)",
)


def require_lms_key(db: DbSession, provided: Annotated[str | None, Security(api_key_header)]) -> lms.Scope:
    """503 when LMS_API=0, 401 without a key, 403 for a wrong or revoked key."""
    if not get_settings().lms_api_enabled:
        raise ApiError(503, "The LMS export API is switched off on this server (LMS_API=0).", "lms_disabled")
    secret = (provided or "").strip()
    if not secret:
        raise ApiError(
            401, f"Send an LMS API key in the {lms.HEADER_NAME} header (create one on the Integrations page).",
            "missing_api_key",
        )
    found = lms.verify(db, secret)
    if found is None:
        raise ApiError(403, "The API key is not valid or has been revoked.", "invalid_api_key")
    if found == "env":
        return lms.Scope(institution_id=None, key_prefix="env")
    return lms.Scope(institution_id=found.institution_id, key_prefix=found.prefix)


LmsScope = Annotated[lms.Scope, Depends(require_lms_key)]


class ExportQuery:
    """The shared filters of /results, /results.csv and /topic-mastery.csv."""

    def __init__(
        self,
        batch_id: Annotated[int | None, Query(description="Only this batch")] = None,
        rubric_id: Annotated[int | None, Query(description="Only this test (rubric id)")] = None,
        since: Annotated[str | None, Query(
            description="Results evaluated at or after this ISO 8601 date or datetime (e.g. 2026-11-01 or "
                        "2026-11-01T09:30:00Z)")] = None,
        include_provisional: Annotated[bool, Query(
            description="Also return PROVISIONAL results (not yet signed off by faculty)")] = False,
        include_demo: Annotated[bool, Query(description="Include demo / sample rows (is_demo=true)")] = True,
        limit: Annotated[int | None, Query(ge=1, le=50000, description="Page size (capped by LMS_MAX_ROWS)")] = None,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> None:
        self.batch_id = batch_id
        self.rubric_id = rubric_id
        self.since = lms.parse_since(since)
        self.include_provisional = include_provisional
        self.include_demo = include_demo
        self.limit = limit
        self.offset = offset

    def rows(self, db: Session, scope: lms.Scope, default_limit: int | None) -> tuple[list[dict], int]:
        return lms.result_rows(
            db, scope_institution_id=scope.institution_id, batch_id=self.batch_id, rubric_id=self.rubric_id,
            since=self.since, include_provisional=self.include_provisional, include_demo=self.include_demo,
            limit=self.limit if self.limit is not None else default_limit, offset=self.offset,
        )


Filters = Annotated[ExportQuery, Depends()]


def _csv_response(body: str, filename: str, total: int) -> RawResponse:
    return RawResponse(
        content=body.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"', "X-Total-Count": str(total)},
    )


# --------------------------------------------------------------------------- #
# Key management (local admin)
# --------------------------------------------------------------------------- #
@router.get("/api/lms/info", response_model=LmsInfo, tags=[ADMIN_TAG])
def lms_info(db: DbSession) -> LmsInfo:
    """Whether the export is on, the header to send, active keys and the endpoint list."""
    return LmsInfo.model_validate(lms.info(db))


@router.get("/api/lms/keys", response_model=list[ApiKeyOut], tags=[ADMIN_TAG])
def list_keys(db: DbSession) -> list[ApiKeyOut]:
    """Every key, newest first (prefix only - secrets are never stored)."""
    rows = db.scalars(select(ApiKey).order_by(ApiKey.id.desc())).all()
    return [ApiKeyOut.model_validate(lms.key_out(r)) for r in rows]


@router.post("/api/lms/keys", status_code=201, response_model=ApiKeyCreated, tags=[ADMIN_TAG])
def create_key(body: ApiKeyInput, db: DbSession) -> ApiKeyCreated:
    """Create a key. The secret is in this response only; store it in the LMS now."""
    if body.institution_id is not None and db.get(Institution, body.institution_id) is None:
        raise ApiError(422, f"Institution {body.institution_id} does not exist.", "unknown_institution")
    row, secret = lms.create_key(db, body.name, body.institution_id)
    return ApiKeyCreated(key=ApiKeyOut.model_validate(lms.key_out(row)), secret=secret)


@router.post("/api/lms/keys/{key_id}/revoke", response_model=ApiKeyOut, tags=[ADMIN_TAG])
def revoke_key(key_id: int, db: DbSession) -> ApiKeyOut:
    """Revoke a key (idempotent). Calls with it get 403 invalid_api_key from now on."""
    row = db.get(ApiKey, key_id)
    if row is None:
        raise ApiError(404, f"API key {key_id} not found.", "unknown_key")
    return ApiKeyOut.model_validate(lms.key_out(lms.revoke_key(db, row)))


# --------------------------------------------------------------------------- #
# Export (X-API-Key)
# --------------------------------------------------------------------------- #
@router.get("/api/lms/v1/batches", response_model=list[LmsBatch], tags=EXPORT_TAGS, summary="Batches")
def export_batches(scope: LmsScope, db: DbSession) -> list[LmsBatch]:
    """Batches the key can see (its institution, or all for an all-institutions key)."""
    return [LmsBatch.model_validate(b) for b in lms.batches(db, scope.institution_id)]


@router.get("/api/lms/v1/students", response_model=list[LmsStudent], tags=EXPORT_TAGS, summary="Student roster")
def export_students(
    scope: LmsScope, db: DbSession, batch_id: Annotated[int | None, Query(description="Only this batch")] = None,
) -> list[LmsStudent]:
    """One row per student (student_ref = roll number when given, else a name slug) with the
    latest graded result's percentage and urgency."""
    return [LmsStudent.model_validate(s) for s in lms.students(db, scope.institution_id, batch_id)]


@router.get(
    "/api/lms/v1/results", response_model=list[LmsResultRow], tags=EXPORT_TAGS, summary="Results (JSON)",
    description="One row per graded test with score, percentage, urgency, topic mastery, the top-3 focus topics "
                f"and teaching nudges. {RELEASED_NOTE} The X-Total-Count header gives the total before paging "
                "(default page size 500).",
)
def export_results(scope: LmsScope, db: DbSession, filters: Filters, response: Response) -> list[LmsResultRow]:
    rows, total = filters.rows(db, scope, default_limit=500)
    response.headers["X-Total-Count"] = str(total)
    return [LmsResultRow.model_validate(r) for r in rows]


@router.get(
    "/api/lms/v1/results.csv", tags=EXPORT_TAGS, summary="Results (CSV)", response_class=RawResponse,
    responses={200: {"content": {"text/csv": {}}}},
    description=f"The results as a UTF-8 CSV with a BOM (opens in Excel), one row per test. {RELEASED_NOTE} "
                "Without limit, every matching row up to LMS_MAX_ROWS.",
)
def export_results_csv(scope: LmsScope, db: DbSession, filters: Filters) -> RawResponse:
    rows, total = filters.rows(db, scope, default_limit=None)
    return _csv_response(lms.results_csv(rows), "3ilens_results.csv", total)


@router.get(
    "/api/lms/v1/topic-mastery.csv", tags=EXPORT_TAGS, summary="Topic mastery (CSV, long format)",
    response_class=RawResponse, responses={200: {"content": {"text/csv": {}}}},
    description=f"One row per student x topic with the mastery percentage. {RELEASED_NOTE} X-Total-Count "
                "counts results (tests), not topic rows.",
)
def export_topic_mastery_csv(scope: LmsScope, db: DbSession, filters: Filters) -> RawResponse:
    rows, total = filters.rows(db, scope, default_limit=None)
    return _csv_response(lms.topic_mastery_csv(rows), "3ilens_topic_mastery.csv", total)
