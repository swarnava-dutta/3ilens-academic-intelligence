# 3iLens local API (contract v3)

Frontend: Next.js App Router at `http://localhost:3000`. Backend: FastAPI (port 8000 by default; `start.bat` may use 8001). JSON keys use snake_case. Scores, mastery, urgency and costs are computed on the backend. All demo records carry `is_demo: true`; live uploads always use real AI providers and never fall back to sample grades.

**Source of truth for every JSON shape: `frontend/src/lib/types.ts`.** `backend/schemas.py` mirrors it field for field and `backend/tests/test_contract.py` checks both the names and every live payload against it. Contract v2 is additive: no v1 field was renamed or retyped. New response fields are always present (nullable fields are `null`, lists default to `[]`); rows written by older builds are filled with defaults when read.

Code layout: core routes in `main.py`; AI + analytics in `routers/analytics_routes.py`; pipeline + ops in `routers/pipeline_ops.py`; outputs in `routers/outputs.py`; contract v3 routes in `routers/ai_ops.py`, `voice_routes.py`, `lms.py`, `owner_routes.py` and `insights_routes.py`. Every route below is implemented. The UI still renders an empty state (never crashes) when a call fails or returns an unexpected shape.

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
- **AI errors.** Provider failures reach the API as 502 with the provider error code (e.g. consistency check, rubric parse): `timeout`, `connection`, `rate_limited`, `provider_unavailable` (transient), `refusal`, `empty_response` (these six send an OCR / grading / voice-mapping call to the GPT-4o fallback once; if it fails too, the Claude error stands and transient errors are retried with backoff), `truncated`, `invalid_json`, `auth`, `permission`, `model_not_found`, `bad_request`, `too_large`, `api_error`, `ai_error`; voice adds `empty_transcript`; the outage drill records `simulated_outage`. A missing key is 503 `ai_not_configured`.
- **`Submission.last_error_code`** (FAILED rows) is one of the AI codes above, `ai_not_configured`, a pre-processing code (`corrupt_pdf`, `password_pdf`, `no_pages`, `too_many_pages`, `corrupt_image`, `corrupt_docx`, `unsupported_signature`, `upload_missing`), `custody_mismatch` (the stored file no longer matches its SHA-256), `no_transcript`, `evaluation_inconsistent`, `schema_mismatch`, `interrupted` (the server stopped mid-run; marked FAILED on the next start so an operator can Retry) or `internal_error`.
- **Human-review gate** (FR-2.4): `OCR_CONFIDENCE_THRESHOLD` (default 0.70) applies to the whole sheet and to every page; any page below it holds the sheet for faculty review. A page's confidence is the model's legibility rating for that page, else the mean confidence of the answers mapped to it. A file name containing `blurry` still pauses before any pre-processing or AI call at confidence 0.65.

## Routes

### Core (`main.py`)

| Method & path | Response | Notes |
|---|---|---|
| `GET /api/health` | `Health` | v1 fields + `ocr_adapter`, `ocr_cache_enabled`, `cost_target_inr`, `latency_target_seconds`, `batch_target_seconds`, `whatsapp_mode`, `max_upload_mb`, `max_pdf_pages` (default 40), `accepted_upload_types` (`["pdf","jpeg","png","webp","docx"]`). `batch` is a full `Batch`. Never returns secrets. |
| `GET /api/rubrics` | `Rubric[]` | v1 fields + `status` (`AUTHOR_DRAFT` \| `FACULTY_APPROVED`), `rubric_hash` (SHA-256 of the content), `parent_id`, `change_note`, `created_at`. Questions may carry an optional `chapter`. |
| `GET /api/rubrics/{id}/reevaluation-estimate` | `ReevaluationEstimate` | COMPLETED submissions on the rubric that a bulk re-run would re-grade: `students`, `live_students`, `demo_students`, `evaluation_calls` (live only), `ocr_calls` (always 0 - OCR reused), `estimated_cost_inr` (average of recent grading calls, else a token-based estimate), `basis`. 404 `unknown_rubric`. |
| `POST /api/upload` | 202 `Submission` | Multipart: `file`, `student_name`, optional `rubric_id`, `rubric_json`, `roll_no`, `language_hints` (`"en,hi"`; en/hi/ta/kn/te; default en), `batch_id` (default first batch), `intake_batch_id` (`^[A-Za-z0-9-]{1,64}$`), `voice_question` (voice answers only; see Contract v3). Validates everything before saving; the SHA-256 is computed while streaming and stored with size, page count, language hints, `student_ref` (roll no upper-cased, else a name slug) and the intake id. PDF/JPEG/PNG/WEBP/DOCX (typed DOCX is converted to PDF pages and read by the same vision route); max 20 MB and `MAX_PDF_PAGES` PDF pages (default 40). A PDF / DOCX whose printed text looks like a printed MCQ paper or a question paper with its answer key gets one extra Ingestion log line (`Printed MCQ paper detected ...` / `This file looks like a question paper with its answer key ...`); processing never changes. A PDF answered on a printed MCQ paper (rubric of 10+ questions, at least 80% MCQs, and 3+ pages or `paper_detect` says `question_paper` / `answer_key_paper`) is read by the printed-MCQ reader (`mcq_marks.py`, `marks-v1`): for every printed question it reports the option the student ticked, circled or shaded, `MCQ_OCR_PAGES_PER_CALL` pages per call (default 2) with the next page as context, pages re-encoded at 1800 px; printed keys are ignored, options (1)-(4) score as A-D, and two chunks reading different options cap the confidence below the gate. Other sheets longer than `OCR_PAGES_PER_CALL` pages (default 10) are transcribed in page chunks, each later chunk with the previous page as context only, `AI_CHUNK_CONCURRENCY` calls at a time (one `ocr` invocation per chunk); if any chunk is served by the fallback the whole OCR is labelled `openai` and not cached. A repeat upload of identical bytes logs `Same file bytes as submission #N` and, with `OCR_CACHE=1` (default), reuses the cached OCR (`OCR cache hit - no vision call (Rs 0.00)`). |
| `GET /api/submissions?batch_id&rubric_id&urgency&intake_batch_id` | `Submission[]` | Newest first. `urgency` filters COMPLETED rows by the urgency rule. |
| `GET /api/results/{id}` | `Result` / 202 `ResultPending` / 404 | 200 body built by `result_view.build_result` (see Result). 202 body unchanged: `{status, detail, submission, processing_log}`. |
| `GET /api/cohort?batch_id&rubric_id&urgency&topic` | `Cohort` | `batch_id`/`rubric_id` filter all submissions; `urgency`/`topic` filter only the completed set (topic matches mastery < 60% in that topic or a stored top-5 priority). No-filter numbers equal v1. Unknown `batch_id` -> 404 `unknown_batch`. |
| `POST /api/intake/inspect` | `PaperInspection` | Multipart `file`. Local only (no AI call, nothing stored): `file_type`, `pages`, `text_layer`, `role` (`answer_key_paper` \| `question_paper` \| `answer_sheet` \| `unknown`), `numbered_questions`, `answer_markers`, `option_groups`, `subjects`, `title`, `max_pdf_pages`, `within_page_limit`, `message`. Errors: 413 `too_large`; 415 `unsupported_signature`, `unsupported_audio`, `voice_disabled`, `macro_docx`; 422 `missing_file`, `empty_file`, `corrupt_pdf`, `password_pdf`, `no_pages`, `corrupt_docx`, `docx_too_large`. Over the page limit (including a Word file past the 60-page layout cap, `pages: null`) is still 200 with `within_page_limit: false`. Images return `unknown` with `pages: 1`; audio returns `answer_sheet` with `pages: null`. (`routers/intake_routes.py`, `paper_detect.py`) |
| `POST /api/demo/seed?set=genetics\|mixed\|all\|insights` | `DemoSeedResult` `{message, created}` | Idempotent, no AI call. `genetics` (default) = the v1 13-row cohort (12 completed + 1 review; urgency split 5/3/4). `mixed` = NEET mixed demo (14 rows: the 6 sample learners on the illustrative mixed NEET rubric in batch NEET-B / Mock-08, plus Mock-05/Mock-06 history rows for 4 Genetics students). `all` = both (27 rows on a fresh database). The Genetics demo has 2 RELEASED rows (Ananya Iyer, Aarav Sharma). `insights` = the learning-analytics sample set (see Contract v3; not part of `all`). |

Upload error codes (detail texts unchanged from v1): 422 `invalid_student_name`, `invalid_rubric`, `unknown_rubric`, `missing_file`, `empty_file`, `invalid_roll_no`, `invalid_language`, `unknown_batch`, `invalid_intake_batch`, `corrupt_pdf`, `password_pdf`, `no_pages`, `too_many_pages`, `corrupt_image`; 415 `unsupported_signature` (detail: "PDF, JPEG, PNG, WEBP or DOCX"); 413 `too_large`; 422 `corrupt_docx`, `docx_too_large`; 415 `macro_docx` (macro-enabled Word file). Voice answers: 415 `voice_disabled`, 415 `unsupported_audio`, 422 `corrupt_audio`, 422 `invalid_question` (the old `voice_phase2` code is retired).

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
| `POST /api/results/{id}/consistency-check` | `ConsistencyCheck` | FR-3.5 re-grade, tolerance +/-2 marks. Uses the faculty-reviewed transcript first, then the raw OCR, then the stored answers. The re-grade is scored like the original (`marking.score_question`): MCQs keep their deterministic marks, scheme questions use the re-grade's step awards. 409; 404 `not_found`; 503 `ai_not_configured`; 502 with the AI error code. Live Claude call (purpose `consistency`). |
| `POST /api/rubrics/parse` | `RubricDraft` | Multipart `file?` (PDF/DOCX/JSON/text, by magic bytes) or `text?`, plus `subject?`, `exam?`, `key_source?` (`auto` default \| `marks`: faculty confirm that the ticks on a PDF mark the answer key; the PDF is then read from page images, never its text layer; ignored for other sources). 422 `invalid_request` for another `key_source`. 415 `unsupported_signature`; 413 `too_large`; 422 `empty_rubric_source`, `invalid_rubric`, `corrupt_pdf`, `password_pdf`, `no_pages`, `too_many_pages` (over 40 pages), `corrupt_docx`, `macro_docx`, `docx_too_large`, `rubric_source_too_long`; 503 `ai_not_configured` (JSON sources need no key); 502 with the AI error code (e.g. `refusal`, `rate_limited`). AI-drafted questions are listed in `ai_drafted_questions`; `warnings` starts with `Fix before saving: ...` when the draft fails validation. A PDF of 3+ pages that is a printed question paper (with or without its key, per `paper_detect`), has no or a sparse text layer (fewer than half the pages with 100+ characters), has 30+ numbered questions, or comes with `key_source=marks` is rendered to page images and drafted `RUBRIC_PAGES_PER_CALL` pages per Claude call, each with the next page as context only (a typed marking scheme with a text layer keeps the single text call) (default 2, `AI_CHUNK_CONCURRENCY` at a time, prompt `rubric-pages-v1`, no fallback); the key comes from printed `Ans.` lines, an answer-key table or a ticked option, and the first warnings are `Read N pages in M AI calls; Q questions; answer key found for k of n MCQs.`, `Question numbers missing from the sequence: ...` and `Pages a-b could not be read (...) - their questions are missing; ...` when a chunk fails twice. Repeated per-question warnings are folded into one line; other warnings include `Two different answer keys were read for Q2 (A and C) - ...` and `Answer-key table entries for Q5 could not be matched to the options - set the key by hand.` A 19-page paper takes about 3-6 minutes. Rubrics hold up to 200 questions. |
| `POST /api/rubrics` | 201 `Rubric` | Body `RubricCreateInput {content, parent_id, change_note, approved}` (`approved` -> `FACULTY_APPROVED`). |

### Outputs (`routers/outputs.py`)

| Method & path | Response | Notes |
|---|---|---|
| `GET /api/reports/{submission_id}/pdf?version=k` | `application/pdf` attachment | 409 `invalid_state` unless COMPLETED; 404 `unknown_submission` / `unknown_version`. PROVISIONAL / SUPERSEDED / DEMO DATA watermarks. Cached under `artifacts/<id>/report_r<result>_<status>.pdf` and re-rendered when the content, release state or logo changes. |
| `GET /api/cohort/pdf?batch_id&rubric_id&urgency&topic` | `application/pdf` | Same filters as `GET /api/cohort`: `batch_id` / `rubric_id` scope every submission; `urgency` (`on_track` \| `needs_attention` \| `at_risk`, else 422) and `topic` (mastery < 60% in that topic or a stored top-5 priority) filter the completed set. 404 `unknown_batch`. The denominator line names who is excluded (in review, failed). |
| `GET /api/reports/bundle.zip?batch_id&rubric_id&urgency&topic` | `application/zip` | Every completed student PDF in scope (same filters as the cohort PDF) + `cohort.pdf`. Duplicate file names get a `_sub<id>` suffix. |
| `POST /api/results/{id}/release` | `ReleaseInfo` | Body `ReleaseInput {reviewer_name, note}`; faculty sign-off. 422 `invalid_reviewer`; 404 `unknown_submission`. |
| `POST /api/results/{id}/revoke` | `ReleaseInfo` | Body `ReleaseInput`. 409 `not_released`. |
| `POST /api/deliveries` | `Delivery[]` | Body `DeliveryInput {submission_ids, channel: "whatsapp", recipient}`. SIMULATED: never sends; recipient stored masked (last 3 digits kept); 422 `invalid_recipient`; returns a signed, expiring `download_url` (null once expired). Template `3ilens_report_ready_v1`: `Namaste {{1}}, {{2}}'s 3iLens report for {{3}} is ready. Download (valid 24 h): {{4}}`. |
| `GET /api/deliveries?submission_id=` | `Delivery[]` | |
| `GET /api/download/{token}` | `application/pdf` | 403 `bad_signature`; 410 `link_expired`. |
| `GET /api/students?batch_id&rubric_id&urgency&topic` | `StudentCard[]` | |
| `GET /api/students/{student_ref}/history?demo=true\|false` | `HistoryEntry[]` | Every completed assessment of the student, oldest first; the newest is marked `current`. Demo and real records are never mixed. Without `demo`: the real records when any exist, else the demo ones; `demo=true` / `demo=false` picks explicitly. |
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

## Contract v3 additions

Additive like v2: no existing field was renamed, retyped or removed. Every new response field is always present (`null` / `[]` / `false` defaults; old rows get read-time defaults). Every route below is implemented.

**Labelled defaults and simulations.** OpenAI routes (GPT-4o fallback, voice transcription) are ON by default and always labelled **"Not residency-approved - PoC only"**; `LLM_FALLBACK=0` / `VOICE_ANSWERS=0` switch them off. `LLM_FALLBACK_MODEL` defaults to `gpt-4o` (announced shutdown **2027-01-14**). Voice transcription cost is shown as **unknown** (no invented price). Pattern thresholds are defaults, labelled **"default - confirm with academic lead"** (`patterns.THRESHOLD_LABEL`). The `insights` sample set, the calibration factor and what-if numbers are sample / illustrative. The owner view has no login. LMS export returns **released results only** unless `include_provisional=true`.

### Scoring (`marking.py`, `bloom.py`, `insights.py`)

- **MCQ** (`question_type: "mcq"`, FR-4.8): scored by option letter only; MCQs are never sent to the grading call (an all-MCQ paper makes no grading call) and the answer key is never sent to OCR. Correct `+max_marks`; wrong or more than one option `-negative_marks` (question value, else `marking_policy.negative_marks`, clamped 0..max); blank `0`; unreadable (`UNKNOWN`) `0` with "check the sheet". `estimated_marks` is net and may be negative; `penalty` carries the deduction. The outcome of a wrong MCQ is `ZERO`. Totals are net sums (may be negative); `overall_mastery` and topic mastery are clamped to 0-100.
- **Descriptive** (FR-3.8): with no policy and no scheme the original rule is unchanged (clamp, round half-up to 0.5). `marking_policy.partial_credit` / per-question `partial_credit`: `steps` (round to `mark_step` 0.25 / 0.5 / 1 / 2), `proportional` (2 dp), `all_or_nothing`. With a `marking_scheme` and per-step `criteria_awards` from the grader, each step is clamped and rounded, then summed; a `required` step below 50% of its marks scores the question 0. A scheme without awards uses the overall marks (noted in `marking_note`).
- `scoring_controls.marking_rule` = the original text for rubrics without MCQs or a policy, else a composed sentence, e.g. `NEET +4/-1 (sample): MCQs +4 correct, -1 wrong, 0 blank; descriptive partial credit in 0.5-mark steps; totals summed server-side`.
- **Bloom K1-K5** (FR-3.9): rubric `bloom_level` (source `bloom_source`, default `faculty`) else a verb heuristic over the prompt (source `heuristic`; highest-level verb wins; default K2). The Genetics demo resolves to Q1 K3, Q2 K2, Q3 K2, Q4 K3, Q5 K1. `demonstrated_level` comes from the grader (null for MCQs and blanks). The grading prompt (`eval-v3`) carries each question's level, scheme steps and partial-credit rule.
- **Consistency check** (`POST /api/results/{id}/consistency-check`) scores the re-grade through the same engine: MCQs keep their deterministic marks from the transcript (no false delta), scheme questions are re-scored from the re-grade's step awards.
- **Teacher action plan**: when the grader gave no intervention for a topic, the template names the first missed rubric criterion; for a topic whose lost marks are all MCQs it names the missed MCQs and the -1 rule instead of the scoring criteria. Templates are rebuilt at read time.
- Legacy and seeded rows gain the new question keys at read time (`marking.annotate_questions`); they are never re-scored.

### Rubric authoring additions (`RubricQuestion`, `RubricContent`)

`question_type?`, `options?` (2-6 strings, MCQ only), `correct_option?` (normalised to one letter; required for MCQs; must be within the options), `negative_marks?` (MCQ only, 0..max), `bloom_level?` (`"apply"` -> `K3`; anything else 422), `bloom_source?`, `concept?` (<= 200), `marking_scheme?` (`MarkingStep[]`, 1-20 steps, descriptive only, marks must add up to `max_marks`: `Q<n> marking_scheme marks (x) must add up to max_marks (y)`), `partial_credit?`, `mark_step?`; `RubricContent.marking_policy?` (`MarkingPolicy {partial_credit, mark_step, negative_marks, scheme_name?}`). An MCQ without `expected_answer` / `grading_criteria` gets `Option X` / one generated criterion; a scheme without criteria gets one per step. All new fields default to absent, so every existing rubric's stored content and `rubric_hash` are byte-identical. Invalid values -> 422 `invalid_rubric` (upload, create, version). AI rubric drafts (`rubric-v2`) carry `question_type`, `options`, `correct_option` and an AI-proposed `bloom_level` (`bloom_source: "ai"`); drafts with MCQs get the NEET +4/-1 policy labelled "default - confirm with academic lead".

### Changed core shapes

- **Health** += `voice_enabled`, `voice_ready` (enabled AND an OpenAI key), `transcription_model` (`gpt-transcribe`), `accepted_voice_types` (`["mp3","wav","m4a","ogg"]`; `accepted_upload_types` stays documents only), `llm_fallback` (model name or `"off"`), `lms_api_enabled`, `intervention_default_hours` (`INTERVENTION_DEFAULT_HOURS`, default 3).
- **Batch** += `faculty_lead` (free text). `PATCH /api/batches/{id}` accepts `faculty_lead` (whitespace normalised, max 120 -> 422; `null` or blank clears it).
- **Submission** += `input_kind` (`document` \| `voice`; NULL reads `document`), `audio_seconds`, `voice_question`, `detected_languages` (NULL reads `[]`; the transcription model's languages plus every script found in the transcript, so a Hindi-English answer reports `hi` and `en`).
- **QuestionEvaluation** += `question_type`, `bloom_level`, `bloom_source`, `demonstrated_level`, `concept`, `penalty`, `selected_option` (letter / `MULTI` / `UNKNOWN` / null), `correct_option`, `marking_breakdown` (`MarkingAward[]`), `marking_note` (also flags a `[note to examiner: ...]` written on the sheet: shown to faculty, ignored for grading).
- **Result** += `llm_routes: LlmRoute[]` (one per stage from the stored model invocations: primary vs served model, `fell_back`, `cross_vendor`, `reason` such as `simulated_outage` or `ocr_cache_hit`), `patterns: StudentPatterns`, `interventions: InterventionRecord[]`, `voice: VoiceInfo | null` (`transcript_chars` counts the synthetic transcript for sample rows). **Cohort** += `patterns: CohortPatterns`.
- These come from **guarded hooks** run after `analytics.result_extras`, in order `llm_route`, `patterns`, `outcomes`, `voice`; `cohort.build_cohort` guards `patterns.cohort_extras`. A hook that raises or returns a malformed payload is logged and replaced by its default (`[]`, empty patterns with null profiles, `null`), so a hook bug never breaks the report, cohort, PDF or LMS export.
- **Pattern units**: every `accuracy` field (fatigue `early_accuracy` / `late_accuracy`, `CohortTopicRisk.mean_accuracy`, `BloomBucket.accuracy`, `QuestionAccuracy.accuracy`) is a fraction 0-1; `ConceptTransfer.recall_accuracy` / `transfer_accuracy` / `gap_pts` and `FatigueProfile.drop_pts` / `adjusted_drop_pts` are percentage points. `StudentRiskRow.value` is marks lost (negative marking), points dropped (fatigue) or a concept count (transfer).
- `InvocationPurpose` += `transcription`, `voice_mapping`, `bloom_detect`, `llm_drill`. `DemoSet` += `insights`.
- Student PDFs label voice answers `Speech-to-text` in the run metadata (`RENDER_VERSION` `sair-pdf-v2` re-renders cached PDFs).

New shapes (field lists in `types.ts`): `VoiceInfo`, `VoiceTranscript`, `LlmRoute`, `LlmProvider`, `LlmChainStatus`, `LlmDrillInput`, `LlmDrillResult`, `BloomTag`, `BloomDetectInput`, `BloomDetection`, `MarkingStep`, `MarkingPolicy`, `MarkingAward`, `TopicRisk`, `NegativeMarkingProfile`, `QuestionAccuracy`, `FatigueProfile`, `ConceptTransfer`, `TransferProfile`, `BloomBucket`, `StudentPatterns`, `StudentRiskRow`, `CohortTopicRisk`, `CohortNegativeMarking`, `CohortFatigue`, `ConceptSummary`, `CohortTransfer`, `CohortPatterns`, `InterventionOutcome`, `InterventionRecord` (schemas `InterventionRecordOut`), `InterventionInput`, `EffectRow`, `InstitutionEffect`, `InterventionEffectiveness`, `InterventionSummary`, `WhatIfScenarioInput`, `WhatIfInput`, `WhatIfImpact`, `WhatIfStudentRow`, `WhatIfScenarioResult`, `WhatIfResult`, `WhatIfTopicOption`, `WhatIfOptions`, `OwnerTotals`, `BatchSummary`, `FacultySummary`, `TrendPoint`, `OwnerDashboard`, `ApiKey` (schemas `ApiKeyOut`), `ApiKeyInput`, `ApiKeyCreated`, `LmsEndpoint`, `LmsInfo`, `LmsTopic`, `LmsResultRow`, `LmsBatch`, `LmsStudent`. New unions: `QuestionType`, `BloomLevel`, `BloomSource`, `PartialCreditMode`, `InputKind`, `RiskLevel`, `TransferClass`, `InterventionKind`, `OutcomeStatus`, `BloomDetectMode`, `LlmRole`.

### Routes

| Method & path | Response | Notes / error codes |
|---|---|---|
| `GET /api/health` | `Health` | New fields above. |
| `PATCH /api/batches/{id}` | `Batch` | `faculty_lead`. |
| `POST /api/demo/seed?set=insights` | `DemoSeedResult` | 25 rows, no AI call, all `is_demo`: batch NEET-C (sample), NEET MCQ Mock 09 (12) and Mock 10 (12) sample papers, one sample voice answer (no audio stored), 24 interventions (22 measured, 2 pending) and 6 released results. Idempotent (a second call creates 0). `set=all` stays genetics + mixed (27). |
| `GET /api/ops/llm-chain` | `LlmChainStatus` | Providers (Claude primary; OpenAI fallback + transcription "not residency-approved"; Gemini "not configured"), deprecation notes (prefix-matched model ids), trigger codes, the last 20 fallback calls. |
| `POST /api/ops/llm-chain/drill` | `LlmDrillResult` | Body `LlmDrillInput {simulate_outage}`; grades one sample Genetics Q5 answer with REAL provider calls (about Rs 1-2). 503 `ai_not_configured` (no Anthropic key and no simulated outage); 409 `fallback_unavailable` (outage simulated but `LLM_FALLBACK=0` or no OpenAI key); 502 `ai_failed`. |
| `POST /api/rubrics/{rubric_id}/bloom-levels` | `BloomDetection` | Body `BloomDetectInput {mode: "ai" \| "heuristic"}`; never modifies the rubric. `heuristic` needs no key; `ai` makes one Claude call (purpose `bloom_detect`, never sent to the fallback) and fills any missing or invalid level from the heuristic with a warning. Items carry `source` (`ai` \| `heuristic`) and `warning`. 404 `unknown_rubric`; 503 `ai_not_configured` (mode ai); 502 `ai_failed`. |
| `POST /api/upload` | 202 `Submission` | Audio (MP3/WAV/M4A/OGG, sniffed from the bytes) is a voice answer. Optional form field `voice_question` (one recording answers that rubric question: the transcript is the answer, no mapping call; omit it for a whole-paper recording, which Claude maps onto the rubric questions, GPT-4o fallback). Ignored for documents. 415 `voice_disabled` (`VOICE_ANSWERS=0`), 415 `unsupported_audio` (AMR, FLAC), 422 `corrupt_audio` (unreadable WAV), 422 `invalid_question` (not in the rubric). Nothing is kept in `uploads/` after a rejection. |
| `GET /api/submissions/{id}/audio` | audio bytes (inline, `Cache-Control: no-store`) | 404 `not_found` (unknown submission); 404 `no_audio` (a document, a sample row, or a file outside the uploads folder). |
| `GET /api/submissions/{id}/transcript` | `VoiceTranscript` | Sample rows get a synthetic transcript built from the stored answer text (`synthetic: true`). 404 `not_found`; 404 `no_transcript`. The transcript is stored as `transcript.json` and never written to the log. |
| `POST /api/submissions/{id}/rescan` | 202 `Submission` | + 422 `input_kind_mismatch` (audio for a document row or vice versa). |
| `GET /api/owner/dashboard?institution_id` | `OwnerDashboard` | 404 `unknown_institution`. "Owner view - no login in this PoC". Per batch: the latest test's average and `trend_delta_pct` against the previous test sat by at least 3 students (different papers, indicative only). Trend: one point per sitting (the same paper more than 3 days apart is a separate sitting). Faculty are merged from batch leads, release reviewers, OCR reviewers and intervention authors (case and spacing ignored). |
| `GET /api/lms/info` | `LmsInfo` | Local admin, no key needed. |
| `GET /api/lms/keys` | `ApiKey[]` | Never returns secrets. |
| `POST /api/lms/keys` | 201 `ApiKeyCreated` | Body `ApiKeyInput {name, institution_id}`. The secret (`3il_...`) is returned once; only its SHA-256 is stored. A key with an institution sees only that institution. 422 `unknown_institution`. |
| `POST /api/lms/keys/{id}/revoke` | `ApiKey` | Idempotent. 404 `unknown_key`. |
| `GET /api/lms/v1/batches` | `LmsBatch[]` | Header `X-API-Key` on every `/api/lms/v1/*` call (a key created here or `LMS_API_KEY`). |
| `GET /api/lms/v1/students?batch_id` | `LmsStudent[]` | |
| `GET /api/lms/v1/results?batch_id&rubric_id&since&include_provisional=false&include_demo=true&limit&offset=0` | `LmsResultRow[]` + header `X-Total-Count` | Released results only by default. `since` = ISO 8601 date or datetime (evaluated at or after). JSON pages default to 500 rows; `limit` is capped by `LMS_MAX_ROWS`. |
| `GET /api/lms/v1/results.csv` (same params) | `text/csv; charset=utf-8` (UTF-8 BOM), `Content-Disposition: attachment` | Without `limit`, every matching row up to `LMS_MAX_ROWS`. Cells starting with `=` `+` `-` `@` get a leading apostrophe (no spreadsheet formulas). |
| `GET /api/lms/v1/topic-mastery.csv` (same params) | `text/csv` (long format: one row per result and topic) | LMS errors: 401 `missing_api_key`, 403 `invalid_api_key` (wrong or revoked), 503 `lms_disabled`, 422 `invalid_since`. OpenAPI tags: `LMS export (read-only)` (with the Authorize button in `/docs`) and `LMS keys (local admin)`. CORS exposes `X-Total-Count` and `Content-Disposition`. |
| `POST /api/interventions` | 201 `InterventionRecord` | Body `InterventionInput` (topic 1-200, action 1-1000, applied_by 1-120, hours 0-100, compliance 0-1, note <= 1000, `applied_at` null = now). Captures the baseline mastery and the predicted gain at record time. 404 `unknown_submission`; 409 `invalid_state` (not COMPLETED); 422 `unknown_topic`; 422 `invalid_applied_at` (more than 1 day in the future). |
| `GET /api/interventions?batch_id&student_ref&submission_id&institution_id` | `InterventionRecord[]` | Newest applied first. Outcome from the student's next test covering the topic: `improved`, `flat`, `declined`, `not_assessed` or `pending`. |
| `DELETE /api/interventions/{id}` | 204 | 404 `unknown_intervention`. |
| `GET /api/interventions/effectiveness?batch_id&institution_id` | `InterventionEffectiveness` | Observational (treated vs the same students' untreated topics), not causal; never changes the BRD ROI. A calibration factor per institution once 5 or more outcomes are measured. |
| `POST /api/whatif` | `WhatIfResult` | Body `WhatIfInput` (1-5 scenarios, `extra_hours` 0.5-40, `use_calibration`). Each student's latest completed result is the baseline. 404 `unknown_batch`; 422 `no_results`; 422 `unknown_topic`. Illustrative linear effort-response model on the NEET matrix (720-mark scale). |
| `GET /api/whatif/options?batch_id&institution_id` | `WhatIfOptions` | 404 `unknown_batch`. |

### Database additions

- `batches` + `faculty_lead`; `student_submissions` + `input_kind` (NULL = `document`), `audio_seconds`, `voice_question`, `detected_languages` (NULL = `[]`). Added by `_ensure_columns` (the live DB keeps working; tested on a v2-shaped copy of `backend/3ilens.db`).
- New tables: `intervention_records` (ORM `InterventionRecord`: the baseline `submission_id`, student, topic, kind, action, source, applied_by/at, hours, compliance, baseline mastery and predicted gain captured at record time, note, is_demo) and `api_keys` (ORM `ApiKey`: name, 8-char prefix, `key_hash` = SHA-256 hex UNIQUE, institution scope, last use, use count, revoked_at).
- The OCR cache only stores transcripts served by the configured vision provider; an OCR served by the fallback model is never cached under the primary model's key.

### Module seams

- `marking`: `policy_for`, `question_policy`, `question_type`, `normalise_option(raw, n_options=None)`, `score_mcq`, `score_descriptive(question, *, estimated_marks, criteria_awards, policy)`, `score_question`, `round_to_step`, `rule_for_question`, `marking_rule_text`, `annotate_questions`.
- `bloom`: `LEVELS`, `LABELS`, `GUIDANCE`, `parse_level`, `heuristic_level`, `resolve_levels`, `concept_key`, `is_transfer`.
- `ai`: `run_evaluation(..., answer_medium="handwriting", simulate_outage=None)` (`speech` adds a spoken-answer note; `simulate_outage` skips Claude for the drill); `structure_transcript(transcript, rubric_content, *, language_hints=None, question_hint=None, on_usage=None) -> OcrResult` (with `question_hint`: one answer, confidence 0.85, or 0.5 under 20 characters, no provider call; without it: one Claude `voice_mapping` call with GPT-4o fallback, `AIConfigurationError` without a key); `detect_bloom_levels(questions, *, on_usage=None)`; `FALLBACK_TRIGGER_CODES`; `NO_FALLBACK_PURPOSES` (`consistency`, `rubric_parse`, `bloom_detect`); `fallback_available(settings=None)`; `deprecation_for(model)`.
- `llm_route`: `STAGES`, `derive_routes(rows)`, `result_extras(db, *, sub, result, rubric)`, `chain_status(db)`.
- `voice`: `transcribe(path, mime_type, *, language_hints, keywords, on_usage=None) -> Transcript`, `script_languages(text)`, `wav_seconds(path)`, `result_extras(db, *, sub)`, `transcript_out(db, sub)`.
- `patterns`: threshold constants, `empty_student_patterns()`, `empty_cohort_patterns()`, `result_extras(db, *, sub, result, rubric)`, `cohort_extras(db, *, pairs, rubrics)`, `concept_group(question_eval, rubric_question)`.
- `outcomes`: `record`, `records_out`, `delete`, `result_extras(db, *, sub, result)`, `effectiveness(db, *, institution_id=None, batch_id=None)`. `whatif`: `run(db, body)`, `options(db, *, batch_id=None, institution_id=None)`. `owner`: `dashboard(db, institution_id=None)`. `lms`: key hashing, `result_rows`, CSV writers. `seed_insights`: `seed_insights_demo(session)`.
- Routers: `routers/ai_ops.py` (LLM chain, drill, Bloom detection), `voice_routes.py`, `lms.py`, `owner_routes.py`, `insights_routes.py`.
- `config`: `AUDIO_MIME_TYPES`, `AUDIO_LABELS`, `accepted_voice_types(settings)`, `llm_fallback_label(settings)`, `RESIDENCY_NOTE`. `result_view`: `guarded(name, hook, default)`, `extension_result_extras`, `cohort_patterns`.
- Tests: `FakeAI.structure_transcript` (counted in `structure_calls`, not `calls`), fixture `fake_transcriber`, `wav_bytes` / `_wav(seconds)`; `forbid_ai` also forbids `ai.structure_transcript`, `ai.detect_bloom_levels` and `voice.transcribe`. Contract v3 acceptance lives in `tests/test_contract_v3.py`.

### Later additions (still additive)

| Method & path | Response | Notes / error codes |
|---|---|---|
| `GET /api/institutions` | `Institution[]` `{id, name}` | Id order. Lighter than the owner dashboard for pickers. |
| `GET /api/results/{id}/versions` | `ResultVersion[]` `{version, created_at, rubric_id, rubric_version, total_score, total_marks, current}` | Archived versions (`evaluation_versions`) plus the current result, oldest first; just the current one when never re-run; archived only while a re-grade is in flight. 404 `unknown_submission`. |
| `GET /api/results/{id}/versions/{version}` | `Result` | The current version returns the live result (`superseded: false`). An archived version is rebuilt from its stored payload with `superseded: true` and `superseded_by` = the next version number (null if unknown). 404 `unknown_submission` / `unknown_version`. |

- **Result** += `superseded: boolean` (false on live results), `superseded_by: number | null`.
- **Mostly blank sheet**: a document sheet whose OCR has a non-blank answer for fewer than half of the rubric questions goes to `HUMAN_REVIEW_REQUIRED` with detail `Mostly blank sheet - confirm before grading: only n/N rubric questions have a transcribed answer ...`, even when every page passes the 0.70 gate. Voice rows are not checked (a recording often answers one question).
- **Transcript cache**: voice answers reuse the OCR cache table keyed by the audio SHA-256 + institution + transcription model + language hints + rubric keywords. A hit makes no transcription call, logs `Transcript cache hit - no transcription call (Rs 0.00)`, records a `transcription` invocation with status `cache_hit` and sets `ocr_cache_hit`.
- **Cohort exam-behaviour lists** (`patterns.*.students`): when the scope holds more than one test for a student, each student is listed once, for their most recent flagged test, and `patterns.notes` gets `n students sat more than one test: each is listed once, for their latest test - filter by test to see the others`. Filtering by `rubric_id` lists every flagged student of that test.

## Settings (`.env` in the project root; restart the backend after changes)

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | - | Claude key (required for live uploads). Never logged or returned. |
| `OPENAI_API_KEY` | - | Voice transcription, the GPT-4o fallback, and OCR when `VISION_PROVIDER=openai`. Never logged or returned. |
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
| `MAX_PDF_PAGES` | `40` | Max PDF pages per answer sheet (clamped 1-100). |
| `OCR_PAGES_PER_CALL` | `10` | Longer sheets are read in page chunks of this size (clamped 1-20); each chunk after the first also gets the previous page as context only. |
| `MCQ_OCR_PAGES_PER_CALL` | `2` | Pages per call for the printed-MCQ reader (`mcq_marks.py`, prompt `marks-v1`), each call with the next page as context only. |
| `RUBRIC_PAGES_PER_CALL` | `2` | Pages per call when a 3+ page question-paper PDF is drafted into a rubric (clamped 1-10). |
| `AI_CHUNK_CONCURRENCY` | `3` | Parallel page-chunk calls per sheet or paper (clamped 1-8). |
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
| `VOICE_ANSWERS` | `1` | Voice answers (FR-2.8) via OpenAI transcription - not residency-approved, PoC only. `0` disables (upload then returns 415 `voice_disabled`). |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-transcribe` | Transcription model (stand-in for Whisper large-v3 / Sarvam Saarika). The only non-deprecated transcription model in openai 3.57; cost shown as "unknown". |
| `LLM_FALLBACK` | `1` | Claude -> OpenAI fallback for OCR / grading / voice mapping (FR-3.10). Not residency-approved, PoC only. `0` disables. |
| `LLM_FALLBACK_MODEL` | `gpt-4o` | Fallback model. gpt-4o has an announced shutdown of 2027-01-14 - change it before then. |
| `LLM_SIMULATE_PRIMARY_OUTAGE` | `0` | Demo switch: every Claude call for OCR / grading / voice mapping is skipped and logged as `simulated_outage`, so the fallback runs. |
| `LMS_API` | `1` | Read-only LMS export (FR-5.10). `0` -> 503 `lms_disabled`. |
| `LMS_API_KEY` | - | Optional static export key, accepted alongside keys created in the UI. Never logged or returned. |
| `LMS_MAX_ROWS` | `5000` | Max rows per LMS export call (clamped 100-50000). |
| `INTERVENTION_DEFAULT_HOURS` | `3` | Default hours for a logged intervention (clamped 0.5-40). |
| `CORS_ORIGINS` | localhost:3000 | Extra allowed origins (loopback ports are always allowed). |
| `DATABASE_URL` / `UPLOAD_DIR` / `ARTIFACT_DIR` | `backend/3ilens.db`, `uploads/`, `artifacts/` | Local stand-ins for RDS and S3. |
