"""LMS export (BRD FR-5.10): hashed API keys, the X-API-Key dependency, released-only results,
filters, CSV (BOM + formula-injection guard), institution scoping and the OpenAPI security scheme."""
from __future__ import annotations

import csv
import io

import pytest

from tests.test_contract import check_interface

RESULTS = "/api/lms/v1/results"


@pytest.fixture
def genetics(demo_data, client):
    assert client.post("/api/demo/seed").json()["created"] == 13


def new_key(client, name: str = "Moodle sync", institution_id: int | None = None) -> dict:
    response = client.post("/api/lms/keys", json={"name": name, "institution_id": institution_id})
    assert response.status_code == 201, response.text
    return response.json()


def auth(secret: str) -> dict:
    return {"X-API-Key": secret}


def csv_rows(text: str) -> list[list[str]]:
    return list(csv.reader(io.StringIO(text.removeprefix("﻿"))))


# --------------------------------------------------------------------------- #
# Keys and auth
# --------------------------------------------------------------------------- #
def test_key_lifecycle_and_hashed_storage(client, db_session):
    from database import ApiKey

    created = new_key(client)
    check_interface(created, "ApiKeyCreated")
    secret, key = created["secret"], created["key"]
    assert secret.startswith("3il_") and len(secret) >= 36
    assert key["prefix"] == secret[:8] and key["active"] is True and key["use_count"] == 0
    assert "secret" not in key and "key_hash" not in key

    row = db_session.get(ApiKey, key["id"])
    stored = " ".join(str(getattr(row, c.name)) for c in ApiKey.__table__.columns)
    assert secret not in stored and secret[8:] not in stored  # only the SHA-256 is kept
    import hashlib

    assert row.key_hash == hashlib.sha256(secret.encode()).hexdigest()

    assert client.get("/api/lms/v1/batches", headers=auth(secret)).status_code == 200
    listed = client.get("/api/lms/keys").json()
    check_interface(listed[0], "ApiKey")
    assert listed[0]["use_count"] == 1 and listed[0]["last_used_at"] and "secret" not in listed[0]

    revoked = client.post(f"/api/lms/keys/{key['id']}/revoke")
    assert revoked.status_code == 200 and revoked.json()["active"] is False
    again = client.post(f"/api/lms/keys/{key['id']}/revoke").json()
    assert again["revoked_at"] == revoked.json()["revoked_at"]  # idempotent
    after = client.get("/api/lms/v1/batches", headers=auth(secret))
    assert after.status_code == 403 and after.json()["code"] == "invalid_api_key"
    missing = client.post("/api/lms/keys/999/revoke")
    assert missing.status_code == 404 and missing.json()["code"] == "unknown_key"
    unknown = client.post("/api/lms/keys", json={"name": "x", "institution_id": 999})
    assert unknown.status_code == 422 and unknown.json()["code"] == "unknown_institution"
    assert client.post("/api/lms/keys", json={"name": "  "}).status_code == 422


def test_auth_errors(client, monkeypatch):
    no_key = client.get(RESULTS)
    assert no_key.status_code == 401 and no_key.json()["code"] == "missing_api_key"
    wrong = client.get(RESULTS, headers=auth("3il_not-a-real-key"))
    assert wrong.status_code == 403 and wrong.json()["code"] == "invalid_api_key"
    monkeypatch.setenv("LMS_API", "0")
    off = client.get(RESULTS, headers=auth("anything"))
    assert off.status_code == 503 and off.json()["code"] == "lms_disabled"
    assert client.get("/api/lms/info").json()["enabled"] is False


def test_env_key_is_accepted_and_never_returned(client, genetics, monkeypatch):
    monkeypatch.setenv("LMS_API_KEY", "static-env-key-123")
    response = client.get(RESULTS, headers=auth("static-env-key-123"))
    assert response.status_code == 200 and response.headers["x-total-count"] == "2"
    info = client.get("/api/lms/info").json()
    check_interface(info, "LmsInfo")
    assert info["env_key_configured"] is True and "static-env-key-123" not in str(info)
    assert info["header_name"] == "X-API-Key" and info["released_only_default"] is True
    assert info["docs_path"] == "/docs#/LMS%20export%20(read-only)"
    assert {e["path"] for e in info["endpoints"]} >= {RESULTS, "/api/lms/v1/results.csv", "/api/lms/v1/topic-mastery.csv"}


# --------------------------------------------------------------------------- #
# Data
# --------------------------------------------------------------------------- #
def test_results_are_released_only_by_default(client, genetics):
    secret = new_key(client)["secret"]
    released = client.get(RESULTS, headers=auth(secret))
    assert released.status_code == 200 and released.headers["x-total-count"] == "2"
    rows = released.json()
    assert len(rows) == 2 and {r["release_status"] for r in rows} == {"RELEASED"}
    check_interface(rows[0], "LmsResultRow")
    row = rows[0]
    assert row["is_demo"] is True and row["input_kind"] == "document" and row["batch_name"] == "NEET-A"
    assert row["test_name"] == "Biology - Genetics" and row["test_version"] == "v1"
    assert 0 <= row["percentage"] <= 100 and row["urgency"] in ("on_track", "needs_attention", "at_risk")
    assert row["topics"] and len(row["focus_topics"]) <= 3
    assert row["nudges"] and all(": " in n for n in row["nudges"])

    everything = client.get(RESULTS, headers=auth(secret), params={"include_provisional": "true"})
    assert everything.headers["x-total-count"] == "12" and len(everything.json()) == 12
    stamps = [(r["evaluated_at"], r["submission_id"]) for r in everything.json()]
    assert stamps == sorted(stamps)  # oldest evaluation first
    page = client.get(RESULTS, headers=auth(secret), params={"include_provisional": "true", "limit": 5, "offset": 10})
    assert len(page.json()) == 2 and page.headers["x-total-count"] == "12"
    no_demo = client.get(RESULTS, headers=auth(secret), params={"include_provisional": "true", "include_demo": "false"})
    assert no_demo.json() == [] and no_demo.headers["x-total-count"] == "0"
    assert client.get(RESULTS, headers=auth(secret), params={"rubric_id": 999}).json() == []


def test_since_filter(client, genetics):
    secret = new_key(client)["secret"]
    rows = client.get(RESULTS, headers=auth(secret), params={"include_provisional": "true"}).json()
    middle = rows[6]["evaluated_at"]
    later = client.get(RESULTS, headers=auth(secret), params={"include_provisional": "true", "since": middle}).json()
    assert later and all(r["evaluated_at"] >= middle for r in later) and len(later) < 12
    assert client.get(RESULTS, headers=auth(secret), params={"since": "2001-01-01"}).headers["x-total-count"] == "2"
    assert client.get(RESULTS, headers=auth(secret), params={"since": "2999-01-01T00:00:00+05:30"}).json() == []
    bad = client.get(RESULTS, headers=auth(secret), params={"since": "last tuesday"})
    assert bad.status_code == 422 and bad.json()["code"] == "invalid_since"


def test_batches_and_students(client, genetics):
    secret = new_key(client)["secret"]
    batches = client.get("/api/lms/v1/batches", headers=auth(secret)).json()
    check_interface(batches[0], "LmsBatch")
    assert batches[0]["name"] == "NEET-A" and batches[0]["institution_name"] == "Instit-42"
    assert batches[0]["students"] == 13 and batches[0]["exam"] == "NEET"
    students = client.get("/api/lms/v1/students", headers=auth(secret),
                          params={"batch_id": batches[0]["batch_id"]}).json()
    assert len(students) == 13
    check_interface(students[0], "LmsStudent")
    graded = [s for s in students if s["assessments"]]
    assert len(graded) == 12 and all(s["latest_percentage"] is not None and s["latest_urgency"] for s in graded)
    pending = [s for s in students if not s["assessments"]]
    assert pending[0]["latest_submission_id"] is None and pending[0]["latest_urgency"] is None


# --------------------------------------------------------------------------- #
# CSV
# --------------------------------------------------------------------------- #
def test_results_csv_has_a_bom_header_and_injection_guard(client, genetics, db_session):
    from database import StudentSubmission

    row = db_session.query(StudentSubmission).filter(StudentSubmission.student_name == "Aarav Sharma").one()
    row.student_name = '=HYPERLINK("http://evil.example","x")'
    db_session.commit()
    secret = new_key(client)["secret"]
    response = client.get("/api/lms/v1/results.csv", headers=auth(secret))
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"] == 'attachment; filename="3ilens_results.csv"'
    assert response.headers["x-total-count"] == "2"
    text = response.content.decode("utf-8")
    assert text.startswith("﻿submission_id,student_ref,student_name,institution,batch,test,test_version,")
    rows = csv_rows(text)
    assert rows[0][-1] == "focus_topics" and len(rows) == 3
    names = [r[2] for r in rows[1:]]
    assert "'=HYPERLINK(\"http://evil.example\",\"x\")" in names


def test_topic_mastery_csv_is_long_format(client, genetics):
    secret = new_key(client)["secret"]
    results = client.get(RESULTS, headers=auth(secret), params={"include_provisional": "true"}).json()
    response = client.get("/api/lms/v1/topic-mastery.csv", headers=auth(secret), params={"include_provisional": "true"})
    assert response.headers["content-disposition"] == 'attachment; filename="3ilens_topic_mastery.csv"'
    rows = csv_rows(response.content.decode("utf-8"))
    assert rows[0] == ["submission_id", "student_ref", "student_name", "batch", "test", "evaluated_at", "topic",
                       "subject", "mastery"]
    assert len(rows) - 1 == sum(len(r["topics"]) for r in results)
    first = results[0]
    mine = [r for r in rows[1:] if r[0] == str(first["submission_id"])]
    assert sorted(r[6] for r in mine) == sorted(t["topic"] for t in first["topics"])


def test_formula_guard_unit():
    import lms

    assert [lms.safe_cell(v) for v in ("=1+1", "+91 98", "-3", "@x", "\tx", "\rx", "ok", 5, -1.5)] == [
        "'=1+1", "'+91 98", "'-3", "'@x", "'\tx", "'\rx", "ok", 5, -1.5,
    ]


# --------------------------------------------------------------------------- #
# Scoping and docs
# --------------------------------------------------------------------------- #
def test_a_scoped_key_only_sees_its_institution(client, genetics, db_session):
    from database import Batch, Institution, StudentSubmission

    other = Institution(name="Other Institute (test)")
    db_session.add(other)
    db_session.flush()
    batch = Batch(name="OTHER-1", exam_type="Mock-01", institution_id=other.id)
    db_session.add(batch)
    db_session.flush()
    moved = db_session.query(StudentSubmission).filter(StudentSubmission.student_name == "Ananya Iyer").one()
    moved.batch_id = batch.id
    db_session.commit()

    base_id = client.get("/api/health").json()["institution"]["id"]
    scoped = new_key(client, "Instit-42 ERP", institution_id=base_id)["secret"]
    rows = client.get(RESULTS, headers=auth(scoped)).json()
    assert [r["student_name"] for r in rows] == ["Aarav Sharma"]
    assert [b["name"] for b in client.get("/api/lms/v1/batches", headers=auth(scoped)).json()] == ["NEET-A"]

    other_key = new_key(client, "Other ERP", institution_id=other.id)["secret"]
    assert [r["student_name"] for r in client.get(RESULTS, headers=auth(other_key)).json()] == ["Ananya Iyer"]
    everyone = new_key(client, "All")["secret"]
    assert len(client.get(RESULTS, headers=auth(everyone)).json()) == 2


def test_openapi_has_the_api_key_scheme_and_export_tag(client):
    spec = client.get("/openapi.json").json()
    schemes = spec["components"]["securitySchemes"]
    assert any(s["type"] == "apiKey" and s["in"] == "header" and s["name"] == "X-API-Key" for s in schemes.values())
    operation = spec["paths"]["/api/lms/v1/results"]["get"]
    assert "LMS export (read-only)" in operation["tags"] and operation["security"]
    assert "RELEASED" in operation["description"]
    assert "LMS export (read-only)" in spec["paths"]["/api/lms/v1/results.csv"]["get"]["tags"]
    assert "security" not in spec["paths"]["/api/lms/keys"]["get"]
