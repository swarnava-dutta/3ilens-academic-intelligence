# 3iLens local API (contract v2)

Frontend: Next.js App Router at `http://localhost:3000`. Backend: FastAPI (port 8000 by default; `start.bat` may use 8001). JSON keys use snake_case. Scores, mastery, urgency and costs are computed on the backend. All demo records carry `is_demo: true`; live uploads always use real AI providers and never fall back to sample grades.

**Source of truth for every JSON shape: `frontend/src/lib/types.ts`.** `backend/schemas.py` mirrors it field for field and `backend/tests/test_contract.py` checks both the names and every live payload against it. Contract v2 is additive: no v1 field was renamed or retyped. New response fields are always present (nullable fields are `null`, lists default to `[]`); rows written by older builds are filled with defaults when read.

Code layout: core routes in `main.py`; AI + analytics in `routers/analytics_routes.py`; pipeline + ops in `routers/pipeline_ops.py`; outputs in `routers/outputs.py`. Every route below is implemented. The UI still renders an empty state (never crashes) when a call fails or returns an unexpected shape.

## Conventions

- **Errors.** Bodies are `{detail: string, code?: string}` (`ApiErrorBody`). Coded errors use `errors.ApiError(status, detail, code)`; codes are snake_case. v1 detail texts are unchanged. Use `errorCode(err)` / `errorMessage(err)` from `lib/api.ts`.
- **Timestamps** are ISO-8601 UTC. Report run ids and calendars use India Standard Time (`Asia/Kolkata`, fixed +05:30).
- **Internal file paths are never sent to the UI.**
- **Labelled simulations.** WhatsApp delivery is SIMULATED everywhere (statuses `BLOCKED_TEMPLATE_PENDING` / `SIMULATED_NOT_SENT`; never "sent"). The chapter-weightage matrix, the mixed NEET demo rubric and every ROI projection are sample/illustrative (`IllustrativePill`). The OCR engine is Claude vision as a PoC stand-in for Google Vision (`Health.ocr_adapter`).
- **OCR cache wording** (FR-2.5, on by default): a cache hit is shown in the UI and the audit log as `OCR cache hit - no vision call (Rs 0.00)` (`provenance.OCR_CACHE_HIT_LABEL`).
- **Bulk re-evaluation** after a rubric edit must be confirmed in the UI first, showing the number of students and the estimated cost from `GET /api/rubrics/{id}/reevaluation-estimate`.
- **Typed DOCX answer sheets** go through the same PDF -> vision route as scans (no separate text path).
- **Urgency rule** (one rule everywhere, `analytics.classify_urgency`): score >= 70% `on_track`, 55-70% `needs_attention`, < 55% `at_risk`; one level worse (capped at `at_risk`) when 2 or more topics have mastery < 40%. Urgency is `null` unless the submission is COMPLETED.
- **Exam date.** A batch with no exam date uses `NEET_EXAM_DATE` (default `2027-05-02`) and reports `exam_date_assumed: true`; the UI labels it "assumed". `days_to_exam` counts IST days (null when past). Strategy: >= 90 `broad`, 30-89 `focused`, 7-29 `revision`, 0-6 `consolidation`.
- **Human-review gate** (FR-2.4): `OCR_CONFIDENCE_THRESHOLD` (default 0.70) applies to the whole sheet and to every page; any page below it holds the sheet for faculty review. A page's confidence is the model's legibility rating for that page, else the mean confidence of the answers mapped to it. A file name containing `blurry` still pauses before any pre-processing or AI call at confidence 0.65.

## Routes

### Core (`main.py`)

| Method & path | Response | Notes |
|---|---|---|
| `GET /api/health` | `Health` | v1 fields + `ocr_adapter`, `ocr_cache_enabled`, `cost_target_inr`, `latency_target_seconds`, `batch_target_seconds`, `whatsapp_mode`, `max_upload_mb`, `accepted_upload_types` (`["pdf","jpeg","png","webp","docx"]`). `batch` is a full `Batch`. Never returns secrets. |
| `GET /api/rubrics` | `Rubric[]` | v1 fields + `status` (`AUTHOR_DRAFT` \| `FACULTY_APPROVED`), `rubric_hash` (SHA-256 of the content), `parent_id`, `change_note`, `created_at`. Questions may carry an optional `chapter`. |
| `GET /api/rubrics/{id}/reevaluation-estimate` | `ReevaluationEstimate` | COMPLETED submissions on the rubric that a bulk re-run would re-grade: `students`, `live_students`, `demo_students`, `evaluation_calls` (live only), `ocr_calls` (always 0 - OCR reused), `estimated_cost_inr` (average of recent grading calls, else a token-based estimate), `basis`. 404 `unknown_rubric`. |
| `POST /api/upload` | 202 `Submission` | Multipart: `file`, `student_name`, optional `rubric_id`, `rubric_json`, `roll_no`, `language_hints` (`"en,hi"`; en/hi/ta/kn/te; default en), `batch_id` (default first batch), `intake_batch_id` (`^[A-Za-z0-9-]{1,64}$`). Validates everything before saving; the SHA-256 is computed while streaming and stored with size, page count, language hints, `student_ref` (roll no upper-cased, else a name slug) and the intake id. PDF/JPEG/PNG/WEBP/DOCX (typed DOCX is converted to PDF pages and read by the same vision route); max 20 MB and 10 PDF pages. A repeat upload of identical bytes logs `Same file bytes as submission #N` and, with `OCR_CACHE=1` (default), reuses the cached OCR (`OCR cache hit - no vision call (Rs 0.00)`). |
| `GET /api/submissions?batch_id&rubric_id&urgency&intake_batch_id` | `Submission[]` | Newest first. `urgency` filters COMPLETED rows by the urgency rule. |
| `GET /api/results/{id}` | `Result` / 202 `ResultPending` / 404 | 200 body built by `result_view.build_result` (see Result). 202 body unchanged: `{status, detail, submission, processing_log}`. |
| `GET /api/cohort?batch_id&rubric_id&urgency&topic` | `Cohort` | `batch_id`/`rubric_id` filter all submissions; `urgency`/`topic` filter only the completed set (topic matches mastery < 60% in that topic or a stored top-5 priority). No-filter numbers equal v1. Unknown `batch_id` -> 404 `unknown_batch`. |
| `POST /api/demo/seed?set=genetics\|mixed\|all` | `DemoSeedResult` `{message, created}` | Idempotent, no AI call. `genetics` (default) = the v1 13-row cohort (12 completed + 1 review; urgency split 5/3/4). `mixed` = NEET mixed demo (14 rows: the 6 sample learners on the illustrative mixed NEET rubric in batch NEET-B / Mock-08, plus Mock-05/Mock-06 history rows for 4 Genetics students). `all` = both (27 rows on a fresh database). The Genetics demo has 2 RELEASED rows (Ananya Iyer, Aarav Sharma). |

Upload error codes (detail texts unchanged from v1): 422 `invalid_student_name`, `invalid_rubric`, `unknown_rubric`, `missing_file`, `empty_file`, `invalid_roll_no`, `invalid_language`, `unknown_batch`, `invalid_intake_batch`, `corrupt_pdf`, `password_pdf`, `no_pages`, `too_many_pages`, `corrupt_image`; 415 `unsupported_signature` (detail: "PDF, JPEG, PNG, WEBP or DOCX"), 415 `voice_phase2` (MP3/WAV/M4A: voice answers are Phase 2); 413 `too_large`; 422 `corrupt_docx`, `macro_docx`, `docx_too_large`.

### Pipeline operations (`routers/pipeline_ops.py`)

| Method & path | Response | Notes |
|---|---|---|
| `POST /api/submissions/{id}/retry` | 202 `Submission` | FAILED only (409 `invalid_state`); 409 `upload_missing`. Reuses the stored upload and the OCR cache. |
| `POST /api/submissions/{id}/reevaluate` | 202 `Submission` | Body `ReevaluateInput {rubric_id: number \| null}` (null = current rubric). COMPLETED only (409 `invalid_state`); 409 `no_transcript` (live row with no stored OCR); 422 `unknown_rubric`; 503 `ai_not_configured` for live rows. Archives the current result into `evaluation_versions` and moves a live row back to PENDING (grading-only run, OCR reused - no vision call); demo rows re-grade synthetically with no AI before the response returns. A question added in the new rubric version is logged as `Qn is new in vN - ... re-scan needed`. |
| `GET /api/submissions/{id}/ocr` | `OcrReviewData` | One `answers[]` row per rubric question (`answer: ""`, `confidence: null` when unanswered), per-page confidences, flagged pages, page images, review history. `has_transcript: false` (e.g. the blurry mock) means the faculty types the answers (`correct`) instead of `approve`. |
| `POST /api/submissions/{id}/review` | 202 `Submission` | Body `ReviewInput` (`approve` \| `correct`). HUMAN_REVIEW_REQUIRED only (409); 422 `no_transcript` / `invalid_question` / `invalid_reviewer`; 503 `ai_not_configured`. `correct` sends only the changed `{question, answer}` pairs (the others keep the OCR text; an empty answer marks the question not attempted). Corrected answers get source `faculty`; grading follows without a new OCR call. Faculty corrections never enter the OCR cache. |
| `POST /api/submissions/{id}/rescan` | 202 `Submission` | Multipart `file`, optional `reviewer`; HUMAN_REVIEW_REQUIRED or FAILED only (409). Same validation as upload; full re-run. |
| `GET /api/submissions/{id}/pages` | `PageRef[]` | Demo rows return `[]`. Sheets that never reached pre-processing are rendered from the stored upload on first request and have `original_url: null`. |
| `GET /api/submissions/{id}/pages/{n}?variant=processed\|original` | image bytes | 404 `page_not_found` when missing; never resolves outside the submission's artifact folder. `Cache-Control: no-store` (a rescan reuses the URLs). |
| `GET /api/submissions/{id}/invocations` | `ModelInvocation[]` | One row per provider call or OCR cache hit (tokens incl. cache read/write, latency, request id, cost). |
| `GET /api/ops/costs?group_by=purpose\|batch\|institution\|model` | `OpsCosts` | |
| `GET /api/intake-batches/{intake_batch_id}` | `IntakeBatchStatus` | Progress, elapsed, ETA vs `BATCH_TARGET_SECONDS`. 404 `unknown_intake_batch`. |
| `POST /api/rubrics/{id}/versions` | 201 `RubricVersionResult` | Body `RubricVersionInput {content, change_note, reprocess}`. Creates the next version (`v{n+1}`) and, when `reprocess`, queues a re-evaluation of every COMPLETED submission on the parent rubric (the UI confirms with the estimate first). `queued_submission_ids` covers demo rows (already re-graded when the response arrives) and live rows (graded in the background, at most `WORKER_CONCURRENCY` at once). |

### Analytics (`routers/analytics_routes.py`)

| Method & path | Response | Notes |
|---|---|---|
| `GET /api/results/{id}/plan?days_to_exam=0..400&study_hours=1..80` | `StudyPlan` | 409 `invalid_state` unless COMPLETED; 404 `not_found`. Illustrative ROI engine v2. |
| `GET /api/weightage?exam=NEET` | `WeightageMatrix` | 404 `exam_not_available`. `illustrative: true`. |
| `GET /api/exams` | `ExamOption[]` | NEET enabled; others disabled ("Matrix not loaded in this PoC"). |
| `PATCH /api/batches/{id}` | `Batch` | Body `BatchPatchInput {exam?, exam_date?}`; ISO date, not in the past (422 `invalid_date`); `exam_date: null` resets to the assumed default; 422 `exam_not_available`; 404 `unknown_batch`. |
| `POST /api/results/{id}/consistency-check` | `ConsistencyCheck` | FR-3.5 re-grade, tolerance +/-2 marks. Uses the faculty-reviewed transcript first, then the raw OCR, then the stored answers. 409; 404 `not_found`; 503 `ai_not_configured`; 502 with the AI error code. Live Claude call (purpose `consistency`). |
| `POST /api/rubrics/parse` | `RubricDraft` | Multipart `file?` (PDF/DOCX/JSON/text, by magic bytes) or `text?`, plus `subject?`, `exam?`. 415 `unsupported_signature`; 413 `too_large`; 422 `empty_rubric_source`, `invalid_rubric`, `corrupt_pdf`, `password_pdf`, `no_pages`, `too_many_pages` (over 40 pages), `corrupt_docx`, `macro_docx`, `docx_too_large`, `rubric_source_too_long`; 503 `ai_not_configured` (JSON sources need no key); 502 with the AI error code (e.g. `refusal`, `rate_limited`). AI-drafted questions are listed in `ai_drafted_questions`; `warnings` starts with `Fix before saving: ...` when the draft fails validation. |
| `POST /api/rubrics` | 201 `Rubric` | Body `RubricCreateInput {content, parent_id, change_note, approved}` (`approved` -> `FACULTY_APPROVED`). |

### Outputs (`routers/outputs.py`)

| Method & path | Response | Notes |
|---|---|---|
| `GET /api/reports/{submission_id}/pdf?version=k` | `application/pdf` attachment | 409 `invalid_state` unless COMPLETED; 404 `unknown_submission` / `unknown_version`. PROVISIONAL / SUPERSEDED / DEMO DATA watermarks. Cached under `artifacts/<id>/report_r<result>_<status>.pdf` and re-rendered when the content, release state or logo changes. |
| `GET /api/cohort/pdf?batch_id&rubric_id&urgency&topic` | `application/pdf` | The denominator line names who is excluded (in review, failed). |
| `GET /api/reports/bundle.zip?batch_id&rubric_id&urgency&topic` | `application/zip` | Every completed student PDF + `cohort.pdf`. |
| `POST /api/results/{id}/release` | `ReleaseInfo` | Body `ReleaseInput {reviewer_name, note}`; faculty sign-off. 422 `invalid_reviewer`; 404 `unknown_submission`. |
| `POST /api/results/{id}/revoke` | `ReleaseInfo` | Body `ReleaseInput`. 409 `not_released`. |
| `POST /api/deliveries` | `Delivery[]` | Body `DeliveryInput {submission_ids, channel: "whatsapp", recipient}`. SIMULATED: never sends; recipient stored masked (last 3 digits kept); 422 `invalid_recipient`; returns a signed, expiring `download_url` (null once expired). Template `3ilens_report_ready_v1`: `Namaste {{1}}, {{2}}'s 3iLens report for {{3}} is ready. Download (valid 24 h): {{4}}`. |
| `GET /api/deliveries?submission_id=` | `Delivery[]` | |
| `GET /api/download/{token}` | `application/pdf` | 403 `bad_signature`; 410 `link_expired`. |
| `GET /api/students?batch_id&rubric_id&urgency&topic` | `StudentCard[]` | |
| `GET /api/students/{student_ref}/history?demo=true\|false` | `HistoryEntry[]` | Demo and real records are never mixed. Without `demo`: the real records when any exist, else the demo ones. |
| `GET /api/filters` | `DashboardFilters` | Batches, tests (rubrics in use), urgencies, topics. |

## Shapes (summary - full field lists in `types.ts`)

- **Named unions**: `SubmissionStatus`, `Urgency`, `QuestionOutcome` (FULL/PARTIAL/ZERO/BLANK), `ReleaseStatus` (PROVISIONAL/RELEASED), `RubricStatus`, `NudgePriority`, `ContentSource` (ai/template/faculty), `StrategyMode`, `Quadrant`, `PlanAction`, `CalendarActivity`, `EffortFlagKind`, `RoadmapHorizon` ("7"/"30"/"60"/"90"), `DeliveryStatus`, `InvocationStatus`, `InvocationPurpose`, `LanguageHint`, `ReviewAction`, `RubricSource`, `DemoSet`.
- **Batch** `{id, name, exam_type, exam, exam_date, exam_date_assumed, days_to_exam, strategy_mode}`.
- **Submission** = v1 fields + `file_sha256, file_size, page_count, language_hints, student_ref, intake_batch_id, attempts, max_attempts, last_error_code, flagged_pages, ocr_cache_hit, urgency, percentage, started_at, completed_at, release_status, llm_cost_inr`.
- **Result** = v1 fields (`rubric` is now a `RubricRef {id, version, name, total_marks, status, rubric_hash}`) + `urgency, urgency_reasons, percentage, summary, executive_summary, teaching_nudges, confusions, outcome_counts, subject_rollup, scoring_controls, roi_basis, report_meta, release, custody (null for demo/legacy rows), extraction, cost, latency, history, versions, deliveries, study_plan`. Assembly order in `result_view.build_result`: base fields, `provenance.result_extras`, `report_meta.result_extras`, then `analytics.result_extras` (its `topic_mastery`, `roi_recommendations`, `question_evaluations` replace the stored lists).
- **TopicMastery** += `chapter, questions, n, full, partial, zero, blank, priority_rank`. **Priority** += `projected_gain_marks, target_mastery, gain_low, gain_high, trigger_questions, intervention, qualitative_rank, calibrated` (the BRD fields keep their v1 meaning: ROI = weightage x gain_potential / effort_hours, gain = 100 - mastery, top 5, mastered >= 90% excluded). **QuestionEvaluation** += `outcome, source_pages, uncertain_words, corrected_by_faculty` (old rows: outcome derived from marks; BLANK when no answer).
- **Cohort** = v1 fields + `filters, rubric_versions, mixed_rubrics, urgency_counts, ranking, at_risk, common_errors, interventions, confusion_clusters, excluded, operations, release_counts`.
- **Report dict** (`insights.build_evaluation_report`, persisted via `results_store`): v1 keys + `summary`, `teaching_nudges`, `confusions`; persistence reads them with `report.get(...)`.

## Database (SQLite, `database.py`)

`init_db()` = `create_all()` + `_ensure_columns()`: an idempotent SQLite migration (PRAGMA table_info -> `ALTER TABLE ADD COLUMN`, then `CREATE INDEX IF NOT EXISTS`). All added columns are nullable; NULL means the documented default. A second start is a no-op.

- `batches` + `exam`, `exam_date` (NULL = assumed default).
- `rubrics` + `rubric_hash`, `status`, `parent_id`, `change_note` (backfilled on startup by `seed.seed_base`).
- `student_submissions` + `file_hash` (idx), `file_size`, `page_count`, `language_hints`, `student_ref` (idx), `intake_batch_id` (idx), `attempts`, `last_error_code`, `flagged_pages`, `page_confidences`, `ocr_cache_hit`, `custody_verified`, `started_at`, `completed_at`.
- `evaluation_results` + `summary`, `teaching_nudges`, `confusions`, `rubric_id`, `rubric_hash`, `version`, `release_status`, `reviewed_by`, `reviewed_at`, `review_note`, `llm_cost_inr`, `cost_breakdown`. `submission_id` stays UNIQUE; history goes to `evaluation_versions`.
- New tables: `ocr_cache`, `model_invocations`, `evaluation_versions`, `ocr_reviews`, `deliveries`.

## Shared backend modules (function seams)

- `config`: `Settings` (below), `DOCX_MIME`, `ocr_adapter_label(settings)`, `accepted_upload_types(settings)`.
- `errors`: `ApiError(status_code, detail, code)`, `install_error_handlers(app)`.
- `hashing`: `sha256_bytes`, `sha256_file`, `sha256_json`, `rubric_hash`, `rubric_questions_hash`, `student_ref_for(name, roll_no=None)`, `short_hash`.
- `ai`: `run_ocr(pages, rubric_content, *, language_hints=None, on_usage=None)`, `run_evaluation(answers, rubric_content, *, on_usage=None, purpose="evaluation")`, `parse_rubric(*, text=None, pdf_bytes=None, subject_hint=None, exam_hint=None, on_usage=None)`, `AIServiceError(message, *, transient=False, code="ai_error")`, `OCR_PROMPT_VERSION`, `EVALUATION_PROMPT_VERSION`. `on_usage` receives one `ai_schemas.ModelUsage` per provider call (never prompt/response text).
- `rubric_store`: `create_rubric(db, content, *, parent=None, change_note=None, status="AUTHOR_DRAFT", version=None)`, `compatibility(old_content, new_content)`.
- `results_store`: `build_evaluation_result(report, *, rubric, version=1, llm_cost_inr=None, cost_breakdown=None, created_at=None)`, `archive_current_result(db, sub, *, superseded_by_rubric_id)`.
- `costing`: `PRICING_USD_PER_MTOK`, `cost_usd(model, usage)`, `to_inr(usd)`.
- `docx_reader`: `DocxError(.code)`, `validate_docx(data, *, max_uncompressed, max_entries)`, `docx_text(data)`, `docx_to_html(data)`.
- `provenance`: `record_invocation(db, *, usage, submission, commit=False)`, `result_extras(db, *, sub, result, rubric)`, `cohort_operations(db, *, subs)`.
- `analytics`: `percentage(result)`, `classify_urgency(pct, topic_mastery)`, `days_to_exam(batch, today=None)`, `strategy_mode_for(days)`, `result_extras(db, *, sub, result, rubric, batch, institution)`, `build_study_plan(*, result, rubric, batch, days_to_exam=None, study_hours=None)`, `nudges_for(result)`, `focus_items(*, result, rubric, batch, limit=3)`, `cohort_extras(*, pairs, rubrics, batch)`.
- `report_meta`: `result_extras(db, *, sub, result, rubric, batch, institution)`.
- `result_view`: `batch_out`, `submission_out`, `pending_out`, `rubric_ref`, `rubric_out`, `build_result(db, sub)`.
- `cohort`: `build_cohort(db, *, batch_id=None, rubric_id=None, urgency=None, topic=None)`.
- `seed`: `seed_demo_set(db, set_name)`, `seed_demo_extended(db)`.

## Settings (`.env` in the project root; restart the backend after changes)

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | - | Claude key (required for live uploads). Never logged or returned. |
| `OPENAI_API_KEY` | - | Only when `VISION_PROVIDER=openai`. |
| `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` | official endpoints | Pinned in `.env`. |
| `VISION_PROVIDER` | `anthropic` | OCR provider (`anthropic` \| `openai`). |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model for OCR (anthropic) and grading. |
| `OPENAI_VISION_MODEL` | `gpt-4o` | OCR model when `VISION_PROVIDER=openai`. |
| `OCR_CONFIDENCE_THRESHOLD` | `0.70` | Below this (sheet or any page) -> `HUMAN_REVIEW_REQUIRED` (BRD FR-2.4). |
| `OCR_CACHE` | `1` | Reuse OCR for identical file bytes (SHA-256): "OCR cache hit - no vision call (Rs 0.00)". |
| `PDF_MASTER_DPI` | `300` | PDF render resolution. |
| `VISION_MAX_EDGE_PX` | `2000` | Longest edge sent to the vision model (clamped 800-2576). |
| `PREPROCESS_ENHANCE` | `1` | Deskew + contrast + sharpen. |
| `PREPROCESS_CONTRAST` | `1.4` | Contrast factor (BRD suggests 1.8; 1.4 keeps faint pencil). |
| `MIN_SHORT_EDGE_PX` | `1200` | Small photos are upscaled to at least this (max 2x). |
| `MAX_JOB_ATTEMPTS` | `3` | Attempts for transient AI errors before the DLQ. |
| `RETRY_BACKOFF_BASE_SECONDS` | `2.0` | Exponential backoff base. |
| `WORKER_CONCURRENCY` | `4` | Parallel pipeline jobs. |
| `USD_INR` | `85` | Exchange rate for cost tracking. |
| `COST_TARGET_INR` | `5` | Per-student cost target. |
| `LATENCY_TARGET_SECONDS` | `300` | Per-sheet latency target. |
| `BATCH_TARGET_SECONDS` | `1800` | Per-intake-batch target. |
| `LLM_PRICING_JSON` | - | Override USD/MTok prices, e.g. `'{"claude-sonnet-5-5": {"input": 2, "output": 10, "cache_write_5m": 2.5, "cache_read": 0.1}}'`. Defaults: Sonnet 5.5 $2 / $10 / $2.50 (5-min cache write = 1.25x input) / $0.10 cache read. |
| `DEFAULT_EXAM` | `NEET` | Target exam for batches without one. |
| `NEET_EXAM_DATE` | `2027-05-02` | ASSUMED exam date for batches without one (labelled "assumed"). |
| `STUDY_HOURS_PER_WEEK` | `18` | Default study budget for the plan. |
| `WHATSAPP_MODE` | `blocked` | `blocked` \| `simulate` - delivery is always simulated, never sent. |
| `DOWNLOAD_LINK_SECRET` | random per start | HMAC secret for signed report links. |
| `DOWNLOAD_LINK_TTL_HOURS` | `24` | Signed link lifetime. |
| `REPORT_LOGO_PATH` | - | Optional logo for the PDF header. |
| `CORS_ORIGINS` | localhost:3000 | Extra allowed origins (loopback ports are always allowed). |
| `DATABASE_URL` / `UPLOAD_DIR` / `ARTIFACT_DIR` | `backend/3ilens.db`, `uploads/`, `artifacts/` | Local stand-ins for RDS and S3. |
