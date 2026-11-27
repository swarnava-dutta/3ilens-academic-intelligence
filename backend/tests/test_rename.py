"""Faculty sets the student's name (PATCH /api/submissions/{id}): same rule as upload, logged,
student_ref kept."""
from __future__ import annotations


def test_rename_sets_the_name_logs_it_and_keeps_the_ref(upload, fake_ai, client):
    sub = upload(student_name="2016 Editable (1)").json()
    response = client.patch(f"/api/submissions/{sub['id']}", json={"student_name": "  Aarav   Sharma "})
    assert response.status_code == 200
    body = response.json()
    assert body["student_name"] == "Aarav Sharma"
    assert body["student_ref"] == sub["student_ref"] == "2016-editable-1"

    result = client.get(f"/api/results/{sub['id']}").json()
    assert result["submission"]["student_name"] == "Aarav Sharma"
    log = [e["message"] for e in result["processing_log"]]
    assert log[-1] == "Student renamed from 2016 Editable (1) to Aarav Sharma by faculty."

    again = client.patch(f"/api/submissions/{sub['id']}", json={"student_name": "Aarav Sharma"})
    assert again.status_code == 200  # unchanged: no second log line
    assert len(client.get(f"/api/results/{sub['id']}").json()["processing_log"]) == len(log)


def test_rename_rejects_a_blank_or_long_name(upload, fake_ai, client):
    sub = upload().json()
    for name in ("   ", "x" * 121):
        response = client.patch(f"/api/submissions/{sub['id']}", json={"student_name": name})
        assert response.status_code == 422
        assert response.json()["code"] == "invalid_student_name"
    assert client.patch(f"/api/submissions/{sub['id']}", json={}).status_code == 422
    assert client.get(f"/api/results/{sub['id']}").json()["submission"]["student_name"] == "Aarav Sharma"


def test_rename_unknown_submission_is_404(client):
    response = client.patch("/api/submissions/987654", json={"student_name": "Aarav Sharma"})
    assert response.status_code == 404
    assert response.json()["code"] == "not_found"


def test_rename_waits_while_the_sheet_is_processing(upload, fake_ai, client, db_session):
    from database import StudentSubmission, SubmissionStatus

    sub = upload().json()
    row = db_session.get(StudentSubmission, sub["id"])
    row.status = SubmissionStatus.PROCESSING
    db_session.commit()
    response = client.patch(f"/api/submissions/{sub['id']}", json={"student_name": "Diya Nair"})
    assert response.status_code == 409
    assert response.json()["code"] == "invalid_state"
