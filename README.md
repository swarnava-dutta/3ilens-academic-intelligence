# 3iLens Academic Intelligence - Proof of Concept

A runnable local demo of the 3iLens journey: a faculty member uploads a student's handwritten
answer sheet, AI reads the handwriting and maps it to question numbers, AI grades it against
the institute's rubric, a deterministic engine turns the grades into topic mastery and a
**Preparation ROI** study plan, and the results appear in three screens:

- **Faculty Workspace** (`/`): upload sheets and watch the processing queue update live.
- **Student Intelligence Report** (`/report/<id>`): score, mastery, strengths and gaps,
  the ROI table, question-by-question evidence and the audit trail.
- **Cohort Dashboard** (`/cohort`): batch KPIs, topic mastery, score distribution and
  cohort-level study priorities.

The AI calls are real: Anthropic Claude (`claude-sonnet-5-5` by default) through the official
SDK, with OpenAI `gpt-4o` as an optional OCR provider. The AWS infrastructure from the target
architecture is replaced by local stand-ins, so the whole thing runs on one laptop.

| Part | Technology |
| --- | --- |
| Frontend | Next.js 16 (App Router), React 19, Tailwind CSS 4, lucide-react, axios |
| Backend | Python 3.11+ with FastAPI, SQLAlchemy 2, Pydantic 2 |
| AI | `anthropic` SDK (OCR and grading), `openai` SDK (optional OCR) |
| Queue / storage / database | FastAPI BackgroundTasks, local `uploads/` and `artifacts/` folders, SQLite |

---

## Quick start (Windows)

1. Put your Anthropic API key in `.env` in this folder (see [Configuration](#configuration)).
   If `.env` does not exist, `start.bat` creates it from `.env.example` for you.
2. **Double-click `start.bat`.**
3. Your browser opens at <http://localhost:3000> once the app is ready.

`start.bat` installs everything the app needs, then starts it. You do not need to install
Python or Node.js first, and you do not need admin rights. Requirements: Windows 10 or 11
(64-bit) and an internet connection on the first run.

| What | When it is installed | Where |
| --- | --- | --- |
| Python 3.13.17 | No Python 3.11+ is found (the Microsoft Store `python` shortcut does not count). Uses `winget` if available, otherwise the official python.org installer (SHA-256 and signature checked). Installed for the current user only. | `%LOCALAPPDATA%\Programs\Python\Python313` |
| Backend packages | `backend\.venv` is missing or broken, `backend\requirements.txt` changed since the last install, or a required package (or one it needs, extras included) is missing, at a version the file does not allow, or has files missing (damaged packages are reinstalled at the same version) | `backend\.venv` |
| Node.js 24.22.3 LTS (portable) | The `node` and `npm` that come first on `PATH` are not Node.js 20.9+ with a standard npm (the app runs on those, so a newer Node.js further down `PATH` does not count). The official nodejs.org zip is downloaded, checked against its SHA-256 and unpacked. Nothing is installed system-wide. Later runs reuse it. | `.tools\node` (only used by `start.bat`) |
| Frontend packages | `node_modules` is missing, `package.json` / `package-lock.json` changed since the last install, or `npm ls` reports a missing package | `frontend\node_modules` |

It also creates `.env` from `.env.example` if needed and seeds the database. The first run
takes a few minutes. Later runs check all of the above in a few seconds and start the
servers. The checks are done by `scripts\ensure-deps.ps1`. If a step fails (offline, a
download fails or does not match its checksum, an install fails), the launcher stops and
says what to do by hand.

`start.bat` opens two windows, **3iLens API :8000** (FastAPI) and **3iLens Web :3000**
(Next.js). Keep them open while you demo.

**To stop:** close those two windows, or double-click **`stop.bat`**. `stop.bat` stops only
3iLens processes. If another program is using port 8000 or 3000, it is left running.

Good to know:

- If port 8000 or 3000 is taken by another program, `start.bat` uses the next free port
  (8001, 3001, ...) and points the frontend at it automatically. The summary at the end of
  the launcher window shows the URLs in use.
- Running `start.bat` while 3iLens is already running reuses the running servers, even if a
  lower port has become free in the meantime.
- Only one `start.bat` runs per folder at a time. Starting it again while the first one is
  still installing or starting says so and stops (it holds `.start.lock` until the servers
  are up).
- The folder path must not contain `&` or `^` (npm cannot handle them); `start.bat` says so
  right away. Spaces and parentheses are fine.
- An empty `ANTHROPIC_API_KEY` is only a warning. The app starts, live uploads are marked
  `FAILED` with a clear message, and the blurry-sheet demo and the demo cohort still work.

### Prerequisites

`start.bat` installs Python and Node.js when they are missing (see above). You need them
yourself only for the manual setup, or on macOS/Linux.

| Tool | Version | Check |
| --- | --- | --- |
| Python | 3.11 or newer (3.13 tested) | `py -3 --version` or `python --version` |
| Node.js | 20.9 or newer (22 and 24 tested), with npm | `node --version` |
| An Anthropic API key | for live OCR and grading | <https://console.anthropic.com/> |

### Test switches for `start.bat`

Set these in a `cmd` window before running `start.bat`, for example
`set "THREEILENS_FORCE_NODE_INSTALL=1"`, then `start.bat`.

| Variable | Effect |
| --- | --- |
| `THREEILENS_NO_BROWSER=1` | Do not open the browser. |
| `THREEILENS_NO_PAUSE=1` | Never wait for a key press, also not after an error. |
| `THREEILENS_FORCE_NODE_INSTALL=1` | Ignore the system Node.js and use the portable copy in `.tools\node`, downloading it first if needed. Only changes this folder. |
| `THREEILENS_FORCE_PYTHON_MISSING=1` together with `THREEILENS_DRY_RUN_PYTHON_INSTALL=1` | Act as if no Python were installed, print the exact install commands (winget command, download URL, SHA-256, installer command line), then stop without installing or starting anything. `THREEILENS_FORCE_PYTHON_MISSING=1` on its own really installs Python for the current user. |

---

## Architecture

The target design is a 16-step AWS pipeline. The PoC keeps each step's role and swaps the
cloud service for a local stand-in:

```
  Faculty browser (Next.js :3000)
        |  POST /api/upload  (file + student name + optional rubric JSON)
        v
 +--------------------------------------------------------------------------------------+
 |  FastAPI orchestrator :8000  (backend/main.py)                                       |
 |                                                                                      |
 |  AWS concept                          Local stand-in in this PoC                     |
 |  -----------------------------------  ---------------------------------------------  |
 |   1 Web portal / CloudFront          Next.js dev server (frontend/)                  |
 |   2 API Gateway                      FastAPI routes + CORS                           |
 |   3 Tenant & batch context           Seeded Instit-42 / NEET-A Mock-07 (seed.py)     |
 |   4 Upload validation                Type sniffing, 20 MB / 10-page limits, rubric   |
 |                                      JSON validated before the file is stored        |
 |   5 S3 raw-upload bucket             ./uploads/                                      |
 |   6 SQS job queue                    FastAPI BackgroundTasks                         |
 |   7 ECS / Lambda worker              pipeline.process_submission()                   |
 |   8 Pre-processing (deskew, DPI)     preprocessing.py: orientation fix, RGB, resize, |
 |                                      PDF pages rendered at 200 DPI                   |
 |   9 OCR (Google Vision)              AI call 1: Claude vision (or GPT-4o)            |
 |  10 Answer structuring               same call, JSON mapped to question numbers      |
 |  11 Confidence gate / human review   OCR confidence < 0.80 -> HUMAN_REVIEW_REQUIRED  |
 |  12 Rubric evaluation engine         AI call 2: Claude grades against the rubric     |
 |  13 Insights & Preparation ROI       insights.py (deterministic Python, no AI)       |
 |  14 RDS governed results store       SQLite: backend/3ilens.db                       |
 |  15 S3 artifact bucket / audit       ./artifacts/<id>/ (page images, ocr.json,       |
 |                                      evaluation.json, report.json) + processing_log  |
 |  16 Dead-letter queue                status FAILED + artifacts/<id>/dead_letter.json |
 +--------------------------------------------------------------------------------------+
        ^
        |  GET /api/submissions (polled every 3 s), /api/results/<id>, /api/cohort
  Faculty Workspace  ->  Student Intelligence Report  ->  Cohort Dashboard
```

Submission statuses move `PENDING -> PROCESSING -> COMPLETED`. Two other endings exist:
`HUMAN_REVIEW_REQUIRED` (low OCR confidence; evaluation is skipped and the UI shows it in
amber) and `FAILED` (any error; the reason is shown in the UI and written to the
dead-letter file).

Safety rules built into the pipeline:

- A file name containing `blurry` is treated as a low-quality scan. It is set to confidence
  0.65 and stopped before any AI call, which demonstrates the BRD's human-review safety
  constraint without needing an API key.
- Marks come from the AI but are clamped to each question's maximum and rounded to 0.5.
  Totals, mastery and ROI are always computed in Python, never taken from the model.
- Answer-sheet text is treated as data to transcribe or grade, never as instructions.
- API keys are never logged or returned by the API.

---

## Manual setup and running

Use this if you prefer terminals over `start.bat`, or on macOS/Linux. Run all commands from
the project root.

### Windows (PowerShell, two terminals)

First time only:

```powershell
cd backend
python -m venv .venv                       # or: py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe seed.py
cd ..\frontend
npm install
cd ..
```

Terminal 1, backend:

```powershell
cd backend
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

Terminal 2, frontend:

```powershell
cd frontend
npm run dev
```

Open <http://localhost:3000>. The API docs are at <http://localhost:8000/docs>.

If the backend runs on a different port, tell the frontend before starting it:
`$env:NEXT_PUBLIC_API_BASE_URL = "http://127.0.0.1:8001"; npm run dev`

### macOS / Linux

First time only:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
backend/.venv/bin/python backend/seed.py
(cd frontend && npm install)
```

Both servers from one terminal (Ctrl+C stops both):

```bash
trap 'kill 0' EXIT
(cd backend && .venv/bin/python -m uvicorn main:app --reload --port 8000) &
(cd frontend && npm run dev) &
wait
```

Or use two terminals: `cd backend && .venv/bin/python -m uvicorn main:app --reload --port 8000`
in one, and `cd frontend && npm run dev` in the other.

---

## Configuration

The backend reads settings from **`.env` in the project root** (copy `.env.example`). Restart
the backend after editing it: `--reload` watches only Python files.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | *(empty)* | **Required for live grading.** Used for rubric evaluation, and for OCR when `VISION_PROVIDER=anthropic`. |
| `OPENAI_API_KEY` | *(empty)* | Needed only when `VISION_PROVIDER=openai`. |
| `VISION_PROVIDER` | `anthropic` | Which model reads the handwriting: `anthropic` (Claude) or `openai` (GPT-4o). Grading always uses Claude. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Claude model for OCR and grading. |
| `OPENAI_VISION_MODEL` | `gpt-4o` | OpenAI model for OCR when `VISION_PROVIDER=openai`. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | API endpoint, pinned in `.env`. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API endpoint, pinned in `.env`. |
| `OCR_CONFIDENCE_THRESHOLD` | `0.80` | Average OCR confidence below this goes to `HUMAN_REVIEW_REQUIRED`. The UI labels assume 80%. |
| `CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Browser origins allowed to call the API. Any `localhost`/`127.0.0.1` port is also accepted. |
| `DATABASE_URL`, `UPLOAD_DIR`, `ARTIFACT_DIR` | `backend/3ilens.db`, `uploads/`, `artifacts/` | Optional overrides, mainly for tests. |
| `NEXT_PUBLIC_API_BASE_URL` (frontend env) | `http://localhost:8000` | Where the browser finds the API. `start.bat` sets it for you. |

**Model note:** the original spec named Claude 3.5 Sonnet (`claude-3-5-sonnet-20241022`).
That model was retired on 2025-10-28, so the PoC uses the current Sonnet,
`claude-sonnet-5-5`. Change `ANTHROPIC_MODEL` to use another Claude model. Claude requests use
structured JSON output and opt into Anthropic's server-side refusal fallback
(`fallbacks="default"`).

The `ANTHROPIC_*` and `OPENAI_*` values come only from `.env`. Variables with those
prefixes that are inherited from your shell or Windows user environment are ignored. This
stops a proxy or key set up for another tool from leaking into the demo.

---

## Seeding and demo data

- **Base seed** (runs automatically at every backend start, and in `start.bat`): institution
  `Instit-42`, batch `NEET-A` / `Mock-07`, and the **Biology - Genetics** rubric
  (5 questions x 4 marks = 20). It is safe to run repeatedly:
  `backend\.venv\Scripts\python.exe backend\seed.py`
- **Demo cohort** (optional): 12 synthetic graded students plus one human-review case, so the
  Cohort Dashboard has data. It makes no AI calls and every row is labelled `Demo`.
  Any of these loads it, and repeated runs add nothing:
  - the **Load demo cohort** button (empty processing queue, or empty Cohort Dashboard)
  - `backend\.venv\Scripts\python.exe backend\seed.py --demo`
  - `POST http://localhost:8000/api/demo/seed`
- **Reset everything:** stop the servers, then delete `backend\3ilens.db` and the contents of
  `uploads\` and `artifacts\`. The next start recreates the base seed.

---

## Client demo script

The sample files are in `samples/` (see `samples/README.md`).

1. **Start.** Double-click `start.bat`. On the Faculty Workspace, the header pill should say
   **AI ready**. If it says *AI keys missing*, add the key to `.env` and restart.
2. **Happy path.** Upload `samples/answer_sheet_aarav_sharma.png` with student name *Aarav
   Sharma* and the default rubric. Watch the queue row move through Pre-processing, OCR,
   Rubric evaluation and Insights to **Completed** (usually 1-2 minutes with live AI). Click
   **View report**: score and mastery gauges, strengths and gaps, the Preparation ROI
   table, the transcribed answer and evidence for every question, and the audit trail.
3. **Safety constraint.** Upload `samples/answer_sheet_rohan_blurry.jpg`. Within a few seconds it
   turns amber, **Human review required** (OCR confidence 65%, below 80%), and AI grading is
   skipped. Open **Details** to see the review panel. This step works without API keys.
4. **More sheets (optional).** `answer_sheet_priya_nair.pdf` shows a 2-page PDF and a mixed
   ROI plan. `answer_sheet_kavya_iyer.jpg` shows a phone photo with Q3 not attempted, which
   scores zero.
5. **Custom rubric.** In the upload card, choose `samples/rubric_physics_kinematics.json`
   under *Custom rubric JSON* (the **Template** link downloads the current rubric as a
   starting point). The upload is validated and stored as a new rubric version
   (`custom-1`). A broken JSON file is rejected with a readable message. Note that grading
   a Biology sheet against the Physics rubric scores low; this step only shows the rubric
   option.
6. **Cohort Dashboard.** Open *Cohort Dashboard*. If it is empty, click **Load demo cohort**.
   It shows KPIs, pipeline health, topic mastery weakest first, the score distribution and
   cohort study priorities. A banner always states how many records are synthetic demo data.

---

## API summary

Full JSON shapes, status codes and validation rules are in **[API_CONTRACT.md](API_CONTRACT.md)**.
Interactive docs: <http://localhost:8000/docs>.

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | Status, AI readiness (names of missing settings only, never values), institution and batch |
| `GET /api/rubrics` | Available rubrics with their full content |
| `POST /api/upload` | Multipart `file`, `student_name`, optional `rubric_id` or `rubric_json`. Returns 202 and queues the job |
| `GET /api/submissions` | All submissions, newest first (polled every 3 s by the workspace) |
| `GET /api/results/{id}` | 200 with the full report when completed. 202 with `{status, detail, submission, processing_log}` while pending, processing, in review or failed. 404 if unknown |
| `GET /api/cohort` | Cohort aggregates (completed submissions only; demo and live counts shown separately) |
| `POST /api/demo/seed` | Loads the optional synthetic demo cohort (idempotent, no AI) |

Upload rules: PDF, JPEG, PNG or WEBP, detected from the file content rather than the
extension (otherwise 415); at most 20 MB (413); PDFs at most 10 pages; corrupt files and
invalid rubric JSON return 422.

---

## How Preparation ROI works

From the BRD, for every topic on the rubric:

```
mastery         = marks scored / marks available for the topic         (0-100 %)
gain potential  = 100 - mastery
topic weightage = subject weight x topic marks / assessed marks in that subject
ROI             = (weightage x gain potential) / effort_hours
```

- NEET subject weights: **Physics 25%, Chemistry 25%, Biology 50%**.
- `effort_hours` (the estimated study time to close the topic) comes from the rubric.
- Topics at 90% mastery or above count as mastered and are left out. The rest are sorted
  by ROI, highest first, and the top 5 become the study priorities, each with a short
  rationale.

Worked example (Biology - Genetics rubric): *Molecular Basis of Inheritance* is worth 4 of
the 20 Biology marks, so its weightage is 0.50 x 4/20 = **0.10**. A student who scores 2/4 has
50% mastery and 50 points of gain potential. With 4 effort hours, ROI = 0.10 x 50 / 4 =
**1.25**.

The Cohort Dashboard applies the same formula to the cohort's average mastery per topic.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| A port is already in use | `start.bat` moves to the next free port and prints the URLs. Manually: `netstat -ano \| findstr :8000` shows the owner's PID. Start uvicorn with another `--port` and set `NEXT_PUBLIC_API_BASE_URL` for the frontend. |
| Upload ends in **FAILED**: "ANTHROPIC_API_KEY is not configured" | Add the key to `.env` in the project root, then restart the backend (close the *3iLens API* window and run `start.bat` again). |
| FAILED with "rejected the API key", "model ... not available", "rate limit" or "temporarily unavailable" | The message comes from the provider. Check the key and `ANTHROPIC_MODEL` in `.env`, or retry later. Details are in `artifacts/<id>/dead_letter.json` and the API window. |
| Red **API offline** banner in the app | The backend is not running, or the frontend points to the wrong port. Check the *3iLens API* window; `start.bat` sets the port automatically. |
| Browser console shows CORS errors | Open the app at `http://localhost:<port>` or `http://127.0.0.1:<port>`. For other hosts, add the origin to `CORS_ORIGINS` in `.env` and restart the backend. |
| A job stays in PROCESSING for a long time | Live grading normally takes 30-120 s. Each AI request times out after 240 s and is retried twice before the job is marked FAILED. |
| A job shows "Interrupted by server restart" | The backend restarted during processing (for example after editing a `.py` file with `--reload`). Upload the sheet again. |
| `start.bat` could not install Python or Node.js | Usually no internet access, or a proxy/firewall blocks python.org or nodejs.org. The launcher prints the URL it tried. A download that stalls (no data for 60 s) is retried twice and then reported, instead of hanging. Install Python 3.11+ (tick *Add python.exe to PATH*) and Node.js 20.9+ by hand, then run it again. |
| "start.bat is already running for this folder" | Another launcher window for this folder is still installing or starting. Wait for it, or close it and run `start.bat` again. |
| "The folder path contains & or ^" | Move or rename the 3iLens folder, for example to `C:\3ilens`. |
| `start.bat` downloads a portable Node.js although Node.js is installed | The `node.exe` (or the `npm`) that comes first on `PATH` is older than 20.9, for example a leftover install or an old version-manager link. Remove it from `PATH` to use the installed Node.js instead; the portable copy in `.tools\node` works too. |
| "failed its SHA-256 check" | The download was damaged or changed on the way, so it was deleted and not used. Run `start.bat` again. If it keeps happening, install that tool by hand. |
| Lots of old test uploads | See *Reset everything* above. |

---

## Running the tests

Backend tests run offline: AI calls are faked, and each test uses a temporary database and
folders, never `backend/3ilens.db` or real keys.

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest -q
```

`tests/test_contract.py` drives the full upload-to-report journey through the HTTP API and
checks every JSON field against the TypeScript types in `frontend/src/lib/types.ts`, so the
backend and frontend cannot drift apart silently.

Frontend checks:

```powershell
cd frontend
npx tsc --noEmit
npm run lint
npm run build
```

---

## Project layout

```
.env.example            settings template (copy to .env)
API_CONTRACT.md         HTTP contract shared by backend and frontend
start.bat / stop.bat    one-click start and stop (Windows)
scripts/
  ensure-deps.ps1       installs/checks Python, Node.js and the packages for start.bat
  check-requirements.py checks backend\.venv against requirements.txt (used by ensure-deps.ps1)
  server-processes.ps1  process helper used by start.bat / stop.bat (ports, server windows, stop)
.tools/                 portable Node.js downloaded by start.bat when needed (git-ignored)
backend/
  main.py               FastAPI app and routes
  pipeline.py           worker: pre-processing -> OCR -> evaluation -> insights -> persistence
  preprocessing.py      image/PDF normalisation for the vision model
  ai.py                 Anthropic/OpenAI calls (OCR and grading) and error mapping
  insights.py           deterministic mastery and Preparation ROI engine
  database.py           SQLAlchemy models (SQLite)
  schemas.py            API response models and rubric validation
  seed.py               base seed and optional demo cohort
  rubrics/              seeded Biology - Genetics rubric
  tests/                pytest suite (offline)
frontend/src/
  app/                  routes: / , /report/[id], /cohort
  components/           workspace, report and cohort UI
  lib/                  API client, shared types, formatters
samples/                demo answer sheets and a custom rubric
docs/POC_SPEC.md        original PoC specification
uploads/, artifacts/    local stand-ins for S3 (created at runtime)
```
