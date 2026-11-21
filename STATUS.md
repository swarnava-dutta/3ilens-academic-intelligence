# 3iLens PoC — Status (done / pending)

_Last updated: 2026-11-21. Use this as the starting point for the next session._

Repo: https://github.com/swarnava-dutta/3ilens-academic-intelligence
Run: double-click `start.bat` (installs anything missing, starts API + web, opens the browser). Stop: `stop.bat`.
Note for this machine: port 8000 is often taken by another local app, so `start.bat` picks the next free port (usually API `:8001`, web `:3000`).

## Verification state right now

| Check | Result |
|---|---|
| Backend tests (`cd backend && .venv\Scripts\python -m pytest -q`) | **486 passed** |
| Frontend `npx tsc --noEmit` + `npm run lint` | **clean** |
| Frontend `npm run build` | not re-run after the V5 build (last clean build was before V5) |
| Live AI end-to-end of the **V5 features** | **not done**. The integration agent was stopped mid-way to save time |
| Live AI end-to-end of the **base pipeline** | done: 26 test pages, 23 COMPLETED / 3 HUMAN_REVIEW / 0 FAILED (see `test-pages/README.md`) |
| Adversarial review + fixes of the V5 build | **skipped** (stopped before the review stage) |

## Done

### Base PoC (original brief, `docs/POC_SPEC.md`)
- FastAPI + SQLite backend: upload → BackgroundTasks queue → pre-processing → Claude vision OCR (call 1) → Claude rubric grading (call 2) → deterministic insights and Preparation ROI → persistence. Failures go to `FAILED` with a dead-letter artifact.
- "blurry" filename mock → `HUMAN_REVIEW_REQUIRED` at 0.65 with no AI call. Real low OCR confidence also routes to review.
- Next.js 16 frontend: Faculty Workspace (upload, queue polling every 3 s, amber human-review rows), Student Intelligence Report, Cohort Dashboard.
- Models: `claude-sonnet-5-5` (Claude 3.5 Sonnet is retired). Optional OpenAI `gpt-4o` vision via `VISION_PROVIDER=openai`.
- `.env` is the only source of LLM settings: inherited Windows `ANTHROPIC_*`/`OPENAI_*` variables (e.g. a local proxy) are dropped, and base URLs are pinned.
- `start.bat` / `stop.bat`:
  - installs Python 3.13 (per user) and portable Node 24 when they're missing, and pip/npm packages when missing or changed;
  - picks free ports, uses a single-instance lock, and stops only its own processes.
- Samples (`samples/`) and 26 varied test pages (`test-pages/generated/{neat,messy,photo,edge}`), plus `test-pages/run_live_test.py` for live runs.
- Public GitHub repo, with `.env` committed but the keys blank (the local `.env` is marked skip-worktree).

### V5 requirements, wave 1 (plan: `docs/plans/v5_wave1_plan.json`)
Covers all 34 P0 functional requirements plus P1 FR-1.7, FR-4.9, FR-4.12 and FR-5.8 (38 FRs in total; FR-3.1 was already present).
- **Contract:** new DB columns and tables via an idempotent migration (the existing DB keeps working), schemas, `API_CONTRACT.md`, and `types.ts`/`api.ts`.
- **AI and ROI (WP1):**
  - teaching nudges, summary, topic interventions (teach/practice/check) and concept confusions;
  - urgency tags (on track / needs attention / at risk);
  - chapter-weightage matrix (`backend/data/weightage/neet.json`, illustrative), ROI quadrants, projected mark gain, days-to-exam (NEET 2027-05-02, labelled "assumed");
  - weekly study calendar;
  - rubric from pasted text / DOCX / PDF, prompt caching of rubric context, a consistency re-grade check;
  - cohort analysis (common errors, at-risk list, class interventions).
- **Pipeline (WP2):**
  - DOCX uploads; real pre-processing (300 DPI master, contrast 1.4, sharpen, deskew);
  - SHA-256 custody and an OCR cache (cache hit = no vision call, Rs 0);
  - per-page OCR gate at **0.70**;
  - cost/usage trace per call; retry / dead-letter re-drive; OCR review editor and rescan; re-evaluate without OCR;
  - rubric versions; page-image endpoints; ops cost endpoint.
- **Outputs (WP3):**
  - branded student and cohort PDFs (PyMuPDF) and a ZIP bundle;
  - release / revoke gate; **simulated** WhatsApp delivery with signed links;
  - students, history and filters APIs;
  - mixed NEET demo rubric and multi-batch / longitudinal demo data (sample).
- **Report UI (WP4):** the full SAIR layout:
  - provisional banner, run metadata, KPI tiles, executive summary, immediate reading with nudges, urgency;
  - subject roll-up, topic screening, worksheet, intervention chooser, action plan, ROI lab;
  - evidence trace to source pages, audit trail, print styles;
  - a `/students` page with cards, nudges and the focus matrix.
- **Workspace UI (WP5):**
  - batch / folder / DOCX intake with per-file status and retry, language hints, rubric from text with versioning;
  - re-evaluation confirmation with a cost estimate;
  - cohort extensions (ranking, at-risk, common errors, interventions, exam date, operations, filters);
  - `/journey` page.

## Pending

### 1. Finish wave 1 integration (do this first)
- [ ] `cd frontend && npm run build`, and fix anything that breaks.
- [ ] Live end-to-end with real keys (small cost), e.g. upload `test-pages/generated/neat/answer_sheet_neat_02_*.png` and `messy/answer_sheet_messy_01_*.jpg`, then check:
  - nudges, summary, urgency, quadrants, projected gain, days-to-exam, page refs, the cost trace and the SHA-256 hash are populated;
  - re-uploading the same file logs "OCR cache hit - no vision call (Rs 0.00)";
  - a `.docx` upload works;
  - `cache_read_input_tokens > 0` on the second student (prompt caching);
  - the student PDF and cohort PDF look right;
  - re-evaluate after a rubric edit and retry of a FAILED sheet both work;
  - `POST /api/demo/seed?set=all` works.
- [ ] Headless screenshots of `/`, a live report, `/students`, `/cohort`, `/journey`, and mobile 390 px. Fix layout issues.
- [ ] Optional: the 3-lens review (requirements, backend, frontend) and fixes that were skipped.

### 2. Known small issues reported by the wave-1 builders
- [ ] `README.md` still says the OCR threshold is 0.80 in 2 places (it is now 0.70).
- [ ] `API_CONTRACT.md` is missing:
  - the new error codes (rubric parse, review, reevaluate, ...);
  - the optional query params `?demo=` on history and `urgency`/`topic` on the cohort PDF and bundle.
- [ ] `Result.summary` is null when Claude wrote none (all demo rows). The UI and PDFs should fall back to `executive_summary` / `analytics.summary_line`.
- [ ] Study plan: some focus rows have target mastery equal to current mastery but a positive gain (e.g. Organic Chemistry 37.5% → 37.5%, +10.9).
- [ ] `Submission.attempts` can exceed `max_attempts` after a manual retry. Show "attempt N" instead.
- [ ] Re-evaluate: the report should show "re-grading" (results 202) while the re-grade runs.
- [ ] Older report versions are only available as PDFs (there is no archived-result JSON endpoint), so there is no "Superseded" banner on the web.
- [ ] Provenance stage durations include post-completion log entries (sign-off, delivery).
- [ ] Demo learner percentages come from the mastery arrays, not the spec's score/max (urgency labels do match).
- [ ] Cache-write price convention in `costing.py` not re-checked ($2.50/MTok assumed for claude-sonnet-5-5).

### 3. Wave 2: the 11 deferred FRs (on hold, plan ready at `docs/plans/v5_wave2_plan.json`)
FR-2.8 voice-to-text (OpenAI `gpt-transcribe`), FR-3.8 per-question marking schemes, FR-3.9 Bloom K1–K5, FR-3.10 GPT-4o fallback chain, FR-4.8 negative-marking risk (MCQ +4/-1), FR-4.10 fatigue, FR-4.11 memorisation vs transfer, FR-4.13 intervention outcomes, FR-4.14 what-if, FR-5.9 owner dashboard, FR-5.10 LMS export API.
The plan has a contract step plus 5 parallel packages; trim it to PoC level before building. The default decisions it needs are in its `open_questions`.

### 4. Quality findings from the live test pages (`test-pages/README.md`)
- [ ] OCR sometimes "corrects" bad handwriting toward the textbook answer (32P→15N, back cross→test cross). Tighten the OCR prompt.
- [ ] Diagrams (pedigrees, Punnett details) get flattened or dropped. Add diagram transcription guidance.
- [ ] Sheet confidence ignores blank answers; one clean answer plus four blanks still passes. Wave 1 added a per-page gate; re-test.
- [ ] Prompt-injection text is kept inside the answer (the grade was not inflated). Consider flagging it in the review UI.
- [ ] Small run-to-run grading drift (up to ±0.5 marks).

### 5. Out of scope for the PoC (infrastructure / legal)
AWS (S3 multipart, ECS, SQS, RDS), multi-tenant RLS and auth, India-only data residency, the 99% uptime SLO, real WhatsApp Business API, Google Vision OCR (Claude vision is the stand-in), and the pilot quality instruments (expert top-5 overlap, ±15% faculty agreement).

### 6. Open decisions for the client
- Real NEET exam date (currently assumed 2027-05-02).
- OCR threshold 0.70 (from the BRD); confirm on real sheets.
- Pricing / FX used for cost tracking (USD_INR=85).
- Whether the V5 requirements HTML and `docs/POC_SPEC.md` may stay in a **public** repo.
- Wave 2 choices: OpenAI routes on by default, fallback model (gpt-4o retires 2027-01-14), voice pricing, thresholds.

### 7. Untested
- `start.bat` doing a real Python install (only the dry run was tested, since Python already exists here); Windows 10.
