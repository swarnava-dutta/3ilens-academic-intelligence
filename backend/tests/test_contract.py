"""End-to-end contract test: drives the real HTTP API (AI calls monkeypatched, no network) and
checks every JSON payload field-by-field against the TypeScript interfaces the frontend
actually compiles against (frontend/src/lib/types.ts), which mirror API_CONTRACT.md.

types.ts is parsed here (a tiny parser for the subset it uses: interfaces, string-literal
unions, `T[]`, `T | null`, optional `?` fields and inline `{...}` objects), so a field added,
renamed or retyped on either side fails this test instead of breaking the demo UI.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

TYPES_TS = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "types.ts"


# --------------------------------------------------------------------------- #
# Minimal TypeScript type parser
# --------------------------------------------------------------------------- #
def _strip_comments(source: str) -> str:
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.DOTALL)
    return re.sub(r"//[^\n]*", "", source)


def _split_top(text: str, sep: str) -> list[str]:
    parts, depth, current = [], 0, []
    for ch in text:
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
        if ch == sep and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return [p.strip() for p in parts if p.strip()]


def _parse_fields(body: str) -> dict[str, tuple[bool, str]]:
    fields: dict[str, tuple[bool, str]] = {}
    for member in _split_top(body.replace("\n", " "), ";"):
        name, _, type_expr = member.partition(":")
        name = name.strip()
        optional = name.endswith("?")
        fields[name.rstrip("?")] = (optional, type_expr.strip())
    return fields


def load_ts_types() -> tuple[dict[str, dict[str, tuple[bool, str]]], dict[str, set[str]]]:
    source = _strip_comments(TYPES_TS.read_text(encoding="utf-8"))
    unions: dict[str, set[str]] = {}
    for match in re.finditer(r"export type (\w+)\s*=\s*([^;]+);", source):
        unions[match.group(1)] = set(re.findall(r'"([^"]+)"', match.group(2)))
    interfaces: dict[str, dict[str, tuple[bool, str]]] = {}
    for match in re.finditer(r"export interface (\w+)\s*\{", source):
        start = depth = match.end() - 1
        depth = 0
        for index in range(start, len(source)):
            if source[index] == "{":
                depth += 1
            elif source[index] == "}":
                depth -= 1
                if depth == 0:
                    interfaces[match.group(1)] = _parse_fields(source[start + 1 : index])
                    break
    return interfaces, unions


INTERFACES, UNIONS = load_ts_types()


def check(value: Any, type_expr: str, path: str) -> None:
    """Assert that a decoded JSON value matches a TypeScript type expression."""
    alternatives = _split_top(type_expr, "|")
    if len(alternatives) > 1:
        errors = []
        for alt in alternatives:
            try:
                check(value, alt, path)
                return
            except AssertionError as exc:
                errors.append(str(exc))
        raise AssertionError(f"{path}: {value!r} matches none of `{type_expr}` ({'; '.join(errors)})")

    t = alternatives[0]
    if t.endswith("[]"):
        assert isinstance(value, list), f"{path}: expected array `{t}`, got {type(value).__name__}"
        for index, item in enumerate(value):
            check(item, t[:-2].strip(), f"{path}[{index}]")
        return
    if t.startswith("{"):
        check_object(value, _parse_fields(t[1:-1]), path)
        return
    if t == "null":
        assert value is None, f"{path}: expected null, got {value!r}"
    elif t == "number":
        assert isinstance(value, (int, float)) and not isinstance(value, bool), f"{path}: expected number, got {value!r}"
    elif t == "string":
        assert isinstance(value, str), f"{path}: expected string, got {value!r}"
    elif t == "boolean":
        assert isinstance(value, bool), f"{path}: expected boolean, got {value!r}"
    elif t in UNIONS:
        assert value in UNIONS[t], f"{path}: {value!r} is not one of {sorted(UNIONS[t])}"
    elif t in INTERFACES:
        check_object(value, INTERFACES[t], path)
    else:
        raise AssertionError(f"{path}: unsupported TypeScript type `{t}` in types.ts parser")


def check_object(value: Any, fields: dict[str, tuple[bool, str]], path: str) -> None:
    assert isinstance(value, dict), f"{path}: expected object, got {type(value).__name__}"
    required = {name for name, (optional, _) in fields.items() if not optional}
    missing = required - set(value)
    extra = set(value) - set(fields)
    assert not missing, f"{path}: missing fields {sorted(missing)} (declared in types.ts)"
    assert not extra, f"{path}: fields {sorted(extra)} are sent by the API but not declared in types.ts"
    for name, (optional, type_expr) in fields.items():
        if name in value and not (optional and value[name] is None):
            check(value[name], type_expr, f"{path}.{name}")


def check_interface(value: Any, name: str) -> None:
    assert name in INTERFACES, f"interface {name} not found in types.ts"
    check_object(value, INTERFACES[name], name)


# --------------------------------------------------------------------------- #
# Parser self-checks (so a parser bug can't make the contract tests vacuous)
# --------------------------------------------------------------------------- #
def test_types_ts_parser_sees_the_contract_interfaces():
    for name in ("Health", "Rubric", "Submission", "Result", "ResultPending", "Cohort", "Priority"):
        assert name in INTERFACES, name
    for name in (
        "RubricRef", "StudyPlan", "PlanTopic", "Extraction", "CostSummary", "ReportMeta", "StudentCard",
        "DashboardFilters", "OcrReviewData", "ModelInvocation", "OpsCosts", "IntakeBatchStatus", "RubricDraft",
        "RubricVersionResult", "ReevaluationEstimate", "ConsistencyCheck", "WeightageMatrix", "Delivery",
        "ApiErrorBody", "ReviewInput", "DeliveryInput",
    ):
        assert name in INTERFACES, name
    for name in (  # contract v3
        "VoiceInfo", "VoiceTranscript", "LlmRoute", "LlmProvider", "LlmChainStatus", "LlmDrillResult", "BloomTag",
        "BloomDetection", "MarkingStep", "MarkingPolicy", "MarkingAward", "StudentPatterns", "CohortPatterns",
        "NegativeMarkingProfile", "FatigueProfile", "TransferProfile", "InterventionRecord", "InterventionInput",
        "InterventionEffectiveness", "WhatIfInput", "WhatIfResult", "WhatIfOptions", "OwnerDashboard", "ApiKey",
        "ApiKeyCreated", "LmsInfo", "LmsResultRow", "LmsBatch", "LmsStudent",
    ):
        assert name in INTERFACES, name
    for name in (
        "QuestionType", "BloomLevel", "BloomSource", "PartialCreditMode", "InputKind", "RiskLevel", "TransferClass",
        "InterventionKind", "OutcomeStatus", "BloomDetectMode", "LlmRole",
    ):
        assert name in UNIONS, name
    assert UNIONS["BloomLevel"] == {"K1", "K2", "K3", "K4", "K5"}
    assert {"transcription", "voice_mapping", "bloom_detect", "llm_drill"} <= UNIONS["InvocationPurpose"]
    assert "insights" in UNIONS["DemoSet"]
    assert INTERFACES["RubricQuestion"]["marking_scheme"][0] is True  # optional (old rubrics lack it)
    assert UNIONS["SubmissionStatus"] == {"PENDING", "PROCESSING", "COMPLETED", "FAILED", "HUMAN_REVIEW_REQUIRED"}
    assert UNIONS["Urgency"] == {"on_track", "needs_attention", "at_risk"}
    assert UNIONS["RoadmapHorizon"] == {"7", "30", "60", "90"}
    assert UNIONS["DeliveryStatus"] == {"BLOCKED_TEMPLATE_PENDING", "SIMULATED_NOT_SENT"}
    assert INTERFACES["ApiErrorBody"]["code"][0] is True  # optional
    assert INTERFACES["Result"]["strengths_gaps"][1].startswith("{")
    assert INTERFACES["RubricQuestion"]["prompt"][0] is True  # optional
    with pytest.raises(AssertionError):
        check_interface({"id": 1}, "Institution")
    with pytest.raises(AssertionError):
        check({"topic": "x", "mastery": "high"}, "{ topic: string; mastery: number }", "t")


def _type_names(type_expr: str) -> list[str]:
    """Every named type referenced by a type expression (recursing into inline objects)."""
    names: list[str] = []
    for alt in _split_top(type_expr, "|"):
        t = alt
        while t.endswith("[]"):
            t = t[:-2].strip()
        if t.startswith("{"):
            for _optional, inner in _parse_fields(t[1:-1]).values():
                names.extend(_type_names(inner))
        else:
            names.append(t)
    return names


def test_types_ts_uses_only_supported_constructs():
    """Every field type must be something check() understands, so no payload check is vacuous."""
    known = {"string", "number", "boolean", "null"} | set(UNIONS) | set(INTERFACES)
    problems = []
    for interface, fields in INTERFACES.items():
        for field, (_optional, type_expr) in fields.items():
            if not type_expr:
                problems.append(f"{interface}.{field}: empty type")
            for name in _type_names(type_expr):
                if name not in known:
                    problems.append(f"{interface}.{field}: `{name}`")
    assert not problems, f"unsupported TypeScript types in types.ts: {problems}"
    for name, members in UNIONS.items():
        assert members, f"type {name} must be a union of string literals"


# TS interface -> schemas.py model where the names differ (Out suffix avoids clashes with ORM classes).
SCHEMA_ALIASES = {"RubricQuestion": "RubricQuestionIn", "RubricContent": "RubricContentIn"}


def test_schemas_py_mirrors_types_ts_field_for_field():
    """backend/schemas.py and types.ts must declare the same fields for every shared shape."""
    import schemas
    from pydantic import BaseModel

    mismatches = []
    missing = []
    for name, fields in INTERFACES.items():
        candidates = [SCHEMA_ALIASES.get(name), name, f"{name}Out", f"{name}In"]
        model = next(
            (getattr(schemas, c) for c in candidates
             if c and isinstance(getattr(schemas, c, None), type) and issubclass(getattr(schemas, c), BaseModel)),
            None,
        )
        if model is None:
            missing.append(name)
            continue
        ts_fields, py_fields = set(fields), set(model.model_fields)
        if ts_fields != py_fields:
            mismatches.append(
                f"{name} vs {model.__name__}: only in types.ts {sorted(ts_fields - py_fields)}, "
                f"only in schemas.py {sorted(py_fields - ts_fields)}"
            )
    assert not missing, f"types.ts interfaces without a schemas.py model: {missing}"
    assert not mismatches, "\n".join(mismatches)


# --------------------------------------------------------------------------- #
# Full journey through the HTTP API
# --------------------------------------------------------------------------- #
def test_completed_journey_matches_types_ts_field_by_field(upload, fake_ai, client):
    """Upload -> (faked) OCR + evaluation -> real insights engine -> persisted Result."""
    check_interface(client.get("/api/health").json(), "Health")
    rubrics = client.get("/api/rubrics").json()
    check(rubrics, "Rubric[]", "rubrics")

    queued = upload(student_name="Contract Student")
    assert queued.status_code == 202, queued.text
    check_interface(queued.json(), "Submission")
    assert queued.json()["status"] == "PENDING"

    response = client.get(f"/api/results/{queued.json()['id']}")
    assert response.status_code == 200, response.text
    result = response.json()
    check_interface(result, "Result")
    assert fake_ai.calls == {"preprocess": 1, "ocr": 1, "evaluation": 1}

    # Semantics the UI relies on (API_CONTRACT.md).
    assert result["submission"]["status"] == "COMPLETED"
    assert result["total_score"] == sum(q["estimated_marks"] for q in result["question_evaluations"])
    assert result["total_marks"] == 20 and result["rubric"]["total_marks"] == 20
    assert 0 <= result["overall_mastery"] <= 100
    assert [q["question"] for q in result["question_evaluations"]] == [1, 2, 3, 4, 5]
    rois = [p["roi"] for p in result["roi_recommendations"]]
    assert rois == sorted(rois, reverse=True) and len(rois) <= 5
    assert all(p["mastery"] < 90 for p in result["roi_recommendations"])
    for p in result["roi_recommendations"]:
        assert p["gain_potential"] == pytest.approx(100 - p["mastery"], abs=0.1)
        assert p["roi"] == pytest.approx(p["weightage"] * p["gain_potential"] / p["effort_hours"], abs=0.01)
    assert sum(t["weightage"] for t in result["topic_mastery"]) == pytest.approx(0.5)  # Biology weight
    assert {e["step"] for e in result["processing_log"]} >= {
        "Ingestion", "Queue", "Pre-processing", "OCR & Parse", "Rubric Evaluation", "Insights & ROI", "Persistence",
    }

    submissions = client.get("/api/submissions").json()
    check(submissions, "Submission[]", "submissions")
    assert submissions[0]["total_score"] == result["total_score"]

    cohort = client.get("/api/cohort").json()
    check_interface(cohort, "Cohort")
    assert cohort["completed"] == 1 and cohort["real_count"] == 1 and cohort["is_demo"] is False


def test_human_review_and_failed_bodies_match_types_ts(upload, fake_ai, client):
    review = upload(filename="rohan_blurry.jpg").json()
    response = client.get(f"/api/results/{review['id']}")
    assert response.status_code == 202
    body = response.json()
    check_interface(body, "ResultPending")
    assert body["status"] == "HUMAN_REVIEW_REQUIRED" and body["submission"]["ocr_confidence"] == 0.65
    assert body["processing_log"][-1]["step"] == "Human review"

    import ai

    fake_ai.ocr_error = ai.AIConfigurationError("ANTHROPIC_API_KEY is not configured.")
    failed = upload(filename="aarav.png").json()
    response = client.get(f"/api/results/{failed['id']}")
    assert response.status_code == 202
    body = response.json()
    check_interface(body, "ResultPending")
    assert body["status"] == "FAILED"
    assert "ANTHROPIC_API_KEY is not configured" in body["detail"]
    assert body["processing_log"][-1]["step"] == "Dead-letter queue"


def test_demo_cohort_payloads_match_types_ts(demo_data, client):
    seeded = client.post("/api/demo/seed").json()
    check_interface(seeded, "DemoSeedResult")
    assert seeded["created"] == 13
    check_interface(client.get("/api/health").json(), "Health")
    check(client.get("/api/rubrics").json(), "Rubric[]", "rubrics")
    check(client.get("/api/submissions").json(), "Submission[]", "submissions")
    completed = [s for s in client.get("/api/submissions").json() if s["status"] == "COMPLETED"]
    assert len(completed) == 12
    for sub in completed[:3]:
        response = client.get(f"/api/results/{sub['id']}")
        assert response.status_code == 200
        check_interface(response.json(), "Result")
    cohort = client.get("/api/cohort").json()
    check_interface(cohort, "Cohort")
    assert cohort["is_demo"] is True and cohort["demo_count"] == 13
    filtered = client.get("/api/cohort", params={"urgency": "at_risk"}).json()
    check_interface(filtered, "Cohort")
    assert filtered["urgency_counts"]["at_risk"] == 4
    rubric_id = client.get("/api/rubrics").json()[0]["id"]
    check_interface(client.get(f"/api/rubrics/{rubric_id}/reevaluation-estimate").json(), "ReevaluationEstimate")


def test_error_bodies_match_api_error_body(upload, forbid_ai, client):
    coded = upload(student_name="")
    assert coded.status_code == 422
    check_interface(coded.json(), "ApiErrorBody")
    plain = client.get("/api/results/424242")
    assert plain.status_code == 404
    check_interface(plain.json(), "ApiErrorBody")
