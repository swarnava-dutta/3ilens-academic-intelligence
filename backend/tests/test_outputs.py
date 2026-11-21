"""Outputs: ZIP bundle, release gate, SIMULATED WhatsApp delivery and signed download links."""
from __future__ import annotations

import base64
import io
import zipfile

import pytest

from tests.test_contract import check, check_interface
from tests.test_reports_pdf import pdf_text

PHONE = "+91 98765 43210"


def _completed(upload, client) -> int:
    sub = upload().json()
    assert client.get(f"/api/results/{sub['id']}").status_code == 200
    return sub["id"]


# --------------------------------------------------------------------------- #
# Bundle
# --------------------------------------------------------------------------- #
def test_bundle_zip_has_every_completed_student_pdf_plus_the_cohort_pdf(client):
    client.post("/api/demo/seed")
    response = client.get("/api/reports/bundle.zip")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"].startswith('attachment; filename="3iLens_reports_')
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
        assert len(names) == 12 + 1 and len(set(names)) == len(names)
        assert "cohort.pdf" in names
        assert all(name.endswith(".pdf") for name in names)
        assert "3iLens_Kabir-Singh_Biology-Genetics_v1.pdf" in names
        for name in names:
            assert archive.read(name).startswith(b"%PDF-")
    assert not any("Aditya" in name for name in names)  # in review - excluded

    at_risk = client.get("/api/reports/bundle.zip", params={"urgency": "at_risk"})
    with zipfile.ZipFile(io.BytesIO(at_risk.content)) as archive:
        assert len(archive.namelist()) == 4 + 1


def test_bundle_respects_batch_and_rubric_filters(client):
    client.post("/api/demo/seed", params={"set": "all"})
    filters = client.get("/api/filters").json()
    neet_b = next(b for b in filters["batches"] if b["name"] == "NEET-B")
    mixed = next(t for t in filters["tests"] if t["name"] == "NEET Mixed - Mock 08")
    response = client.get("/api/reports/bundle.zip", params={"batch_id": neet_b["id"], "rubric_id": mixed["rubric_id"]})
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = sorted(archive.namelist())
    assert names == [
        "3iLens_Student-B01_NEET-Mixed-Mock-08_v1.pdf", "3iLens_Student-B02_NEET-Mixed-Mock-08_v1.pdf", "cohort.pdf",
    ]


# --------------------------------------------------------------------------- #
# Release gate
# --------------------------------------------------------------------------- #
def test_release_and_revoke_record_the_faculty_sign_off(client, upload, fake_ai):
    sid = _completed(upload, client)
    released = client.post(f"/api/results/{sid}/release", json={"reviewer_name": "  Dr  Meera Rao ", "note": "Checked"})
    assert released.status_code == 200, released.text
    body = released.json()
    check_interface(body, "ReleaseInfo")
    assert body["status"] == "RELEASED" and body["reviewed_by"] == "Dr Meera Rao" and body["note"] == "Checked"
    assert body["reviewed_at"]

    result = client.get(f"/api/results/{sid}").json()
    assert result["release"]["status"] == "RELEASED" and result["release"]["reviewed_by"] == "Dr Meera Rao"
    assert result["submission"]["release_status"] == "RELEASED"
    sign_off = [e for e in result["processing_log"] if e["step"] == "Faculty sign-off"]
    assert len(sign_off) == 1 and "Dr Meera Rao" in sign_off[0]["message"]

    revoked = client.post(f"/api/results/{sid}/revoke", json={"reviewer_name": "Dr Meera Rao", "note": "Re-check Q3"})
    assert revoked.status_code == 200
    assert revoked.json()["status"] == "PROVISIONAL" and revoked.json()["note"] == "Re-check Q3"
    result = client.get(f"/api/results/{sid}").json()
    assert result["release"]["status"] == "PROVISIONAL"
    assert [e["step"] for e in result["processing_log"]].count("Faculty sign-off") == 2

    again = client.post(f"/api/results/{sid}/revoke", json={"reviewer_name": "Dr Meera Rao"})
    assert again.status_code == 409 and again.json()["code"] == "not_released"


def test_release_validation_and_state_guards(client, upload, fake_ai):
    sid = _completed(upload, client)
    blank = client.post(f"/api/results/{sid}/release", json={"reviewer_name": "   "})
    assert blank.status_code == 422 and blank.json()["code"] == "invalid_reviewer"
    assert client.post(f"/api/results/{sid}/release", json={}).status_code == 422
    assert client.post(f"/api/results/{sid}/release", json={"reviewer_name": "x" * 121}).status_code == 422
    assert client.post(f"/api/results/{sid}/release", json={"reviewer_name": "Dr X", "note": "n" * 1001}).status_code == 422

    review = upload(filename="rohan_blurry.jpg").json()
    blocked = client.post(f"/api/results/{review['id']}/release", json={"reviewer_name": "Dr X"})
    assert blocked.status_code == 409 and blocked.json()["code"] == "invalid_state"
    missing = client.post("/api/results/424242/release", json={"reviewer_name": "Dr X"})
    assert missing.status_code == 404


# --------------------------------------------------------------------------- #
# Simulated WhatsApp delivery
# --------------------------------------------------------------------------- #
def test_delivery_is_never_sent_masks_the_recipient_and_issues_a_working_link(client, upload, fake_ai, db_session):
    sid = _completed(upload, client)
    response = client.post("/api/deliveries", json={"submission_ids": [sid], "channel": "whatsapp", "recipient": PHONE})
    assert response.status_code == 200, response.text
    deliveries = response.json()
    check(deliveries, "Delivery[]", "deliveries")
    assert len(deliveries) == 1
    delivery = deliveries[0]
    assert delivery["status"] == "BLOCKED_TEMPLATE_PENDING"  # WHATSAPP_MODE defaults to blocked
    assert "SENT" != delivery["status"] and "sent" not in delivery["status"].lower().replace("not_sent", "")
    assert delivery["template_name"] == "3ilens_report_ready_v1"
    assert "message NOT sent" in delivery["detail"] and "pending approval" in delivery["detail"]
    assert delivery["recipient_masked"] == "+*********210"
    assert "98765" not in delivery["recipient_masked"]
    assert delivery["download_url"].startswith("/api/download/") and delivery["link_expires_at"]

    # Only the masked recipient is stored.
    from database import Delivery

    row = db_session.get(Delivery, delivery["id"])
    assert row.recipient_masked == "+*********210"
    assert all("98765" not in str(getattr(row, col.name)) for col in Delivery.__table__.columns)

    # The signed link serves the same PDF whose sha256 the audit log recorded.
    pdf = client.get(delivery["download_url"])
    assert pdf.status_code == 200 and pdf.headers["content-type"] == "application/pdf"
    assert pdf.content.startswith(b"%PDF-")
    assert pdf.headers["content-disposition"].startswith("attachment;")
    from hashing import sha256_bytes

    log = [e for e in client.get(f"/api/results/{sid}").json()["processing_log"] if e["step"] == "Delivery"]
    assert len(log) == 1
    assert sha256_bytes(pdf.content) in log[0]["message"]
    assert "NOT sent" in log[0]["message"] and "98765" not in log[0]["message"]
    assert "Aarav Sharma" in pdf_text(pdf.content)

    listed = client.get("/api/deliveries", params={"submission_id": sid}).json()
    check(listed, "Delivery[]", "listed")
    assert [d["id"] for d in listed] == [delivery["id"]] and listed[0]["download_url"] == delivery["download_url"]
    result = client.get(f"/api/results/{sid}").json()
    check_interface(result, "Result")
    assert result["deliveries"][0]["id"] == delivery["id"]
    assert [d["id"] for d in client.get("/api/deliveries").json()] == [delivery["id"]]


def test_simulate_mode_and_bulk_delivery_without_recipient(client, monkeypatch):
    monkeypatch.setenv("WHATSAPP_MODE", "simulate")
    client.post("/api/demo/seed")
    completed = [s["id"] for s in client.get("/api/submissions").json() if s["status"] == "COMPLETED"][:3]
    response = client.post("/api/deliveries", json={"submission_ids": completed + completed[:1], "channel": "whatsapp"})
    assert response.status_code == 200, response.text
    deliveries = response.json()
    assert [d["submission_id"] for d in deliveries] == completed  # duplicates collapsed, order kept
    assert all(d["status"] == "SIMULATED_NOT_SENT" and d["recipient_masked"] is None for d in deliveries)
    assert all("NOT sent" in d["detail"] for d in deliveries)


def test_delivery_validation(client, upload, fake_ai):
    sid = _completed(upload, client)
    review = upload(filename="rohan_blurry.jpg").json()

    not_ready = client.post("/api/deliveries", json={"submission_ids": [sid, review["id"]], "channel": "whatsapp"})
    assert not_ready.status_code == 409 and not_ready.json()["code"] == "invalid_state"
    unknown = client.post("/api/deliveries", json={"submission_ids": [424242], "channel": "whatsapp"})
    assert unknown.status_code == 404 and unknown.json()["code"] == "unknown_submission"
    assert client.post("/api/deliveries", json={"submission_ids": [sid], "channel": "sms"}).status_code == 422
    assert client.post("/api/deliveries", json={"submission_ids": [], "channel": "whatsapp"}).status_code == 422
    too_many = client.post("/api/deliveries", json={"submission_ids": list(range(1, 202)), "channel": "whatsapp"})
    assert too_many.status_code == 422
    bad_phone = client.post("/api/deliveries", json={"submission_ids": [sid], "channel": "whatsapp",
                                                     "recipient": "call me maybe"})
    assert bad_phone.status_code == 422 and bad_phone.json()["code"] == "invalid_recipient"
    short = client.post("/api/deliveries", json={"submission_ids": [sid], "channel": "whatsapp", "recipient": "12345"})
    assert short.status_code == 422 and short.json()["code"] == "invalid_recipient"
    assert client.get("/api/deliveries", params={"submission_id": sid}).json() == []  # nothing recorded


# --------------------------------------------------------------------------- #
# Signed download links
# --------------------------------------------------------------------------- #
def _token(url: str) -> str:
    return url.rsplit("/", 1)[1]


def test_download_link_expires(client, upload, fake_ai, monkeypatch):
    import report_meta

    sid = _completed(upload, client)
    url = client.post("/api/deliveries", json={"submission_ids": [sid], "channel": "whatsapp"}).json()[0]["download_url"]
    assert client.get(url).status_code == 200

    real_now = report_meta.now_epoch
    monkeypatch.setattr(report_meta, "now_epoch", lambda: real_now() + 24 * 3600 + 60)  # TTL is 24 h
    expired = client.get(url)
    assert expired.status_code == 410 and expired.json()["code"] == "link_expired"
    assert client.get("/api/deliveries", params={"submission_id": sid}).json()[0]["download_url"] is None


@pytest.mark.parametrize("tamper", ["other_submission", "longer_expiry", "flipped_signature", "garbage", "other_secret"])
def test_tampered_download_links_are_rejected(client, upload, fake_ai, monkeypatch, tamper):
    import report_meta

    sid = _completed(upload, client)
    url = client.post("/api/deliveries", json={"submission_ids": [sid], "channel": "whatsapp"}).json()[0]["download_url"]
    token = _token(url)
    raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode()
    sub_id, expires, signature = raw.split(":")
    if tamper == "other_submission":
        forged = f"{int(sub_id) + 1}:{expires}:{signature}"
    elif tamper == "longer_expiry":
        forged = f"{sub_id}:{int(expires) + 86400}:{signature}"
    elif tamper == "flipped_signature":
        forged = f"{sub_id}:{expires}:{signature[:-1]}{'0' if signature[-1] != '0' else '1'}"
    elif tamper == "other_secret":
        monkeypatch.setenv("DOWNLOAD_LINK_SECRET", "another-secret")
        forged = raw
    else:
        forged = ""
    bad = base64.urlsafe_b64encode(forged.encode()).decode().rstrip("=") if forged else "garbage!!token"
    response = client.get(f"/api/download/{bad}")
    assert response.status_code == 403, response.text
    assert response.json()["code"] == "bad_signature"
    assert tamper == "other_secret" or report_meta.verify_download_token(token) == sid  # original still valid


def test_signed_token_round_trip(isolated_env):
    import report_meta

    token, expires = report_meta.new_download_token(42)
    assert report_meta.verify_download_token(token) == 42
    assert "=" not in token and "/" not in token and "+" not in token
    with pytest.raises(report_meta.DownloadTokenError) as bad:
        report_meta.verify_download_token(token[:-2] + ("AA" if token[-2:] != "AA" else "BB"))
    assert bad.value.code == "bad_signature"
    old = report_meta.sign_download_token(42, report_meta.now_epoch() - 1)
    with pytest.raises(report_meta.DownloadTokenError) as expired:
        report_meta.verify_download_token(old)
    assert expired.value.code == "link_expired"
    assert report_meta.mask_recipient("9876543210") == "*******210"
    assert report_meta.mask_recipient(None) is None and report_meta.mask_recipient("  ") is None
    with pytest.raises(ValueError):
        report_meta.mask_recipient("+91 abc 43210")
