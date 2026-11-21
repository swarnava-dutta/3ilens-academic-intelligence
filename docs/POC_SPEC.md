# 3iLens Academic Intelligence - Proof of Concept (PoC) Specification
**Author:** Lead Principal Engineer

> Implementation notes:
> - `claude-3-5-sonnet-20241022` was retired on 2025-10-28. The PoC uses the current Sonnet (`claude-sonnet-5-5`), configurable via `ANTHROPIC_MODEL`.
> - Vision/OCR provider is configurable via `VISION_PROVIDER` (`anthropic` default, or `openai` with `OPENAI_VISION_MODEL=gpt-4o`).
> - The HTTP contract actually implemented is in `/API_CONTRACT.md`.

## 1. Project Overview & Objective
The goal is a functional Proof of Concept (PoC) for the "3iLens Academic Intelligence" platform. The client needs a runnable demo to visualize the journey from document upload (handwritten answer sheets) to AI evaluation, cohort insights, and Preparation ROI generation.

The conceptual architecture dictates a 16-step AWS pipeline. For this PoC, the heavy cloud infrastructure (SQS, ECS, S3, RDS) is abstracted into local equivalents (Background Tasks, Local File System, SQLite) so it can run smoothly on a local machine for a client demonstration. The PoC integrates Anthropic/OpenAI APIs to perform actual OCR, answer structuring, and rubric evaluation.

## 2. Tech Stack & Architecture
*   **Frontend:** Next.js 14+ (App Router), React, Tailwind CSS, Lucide React (for iconography matching the flat, academic UI vibe).
*   **Backend:** Python 3.11+ with FastAPI. (This acts as our API Orchestrator and Pipeline Worker).
*   **Database:** SQLite (via SQLAlchemy or SQLModel) representing the "Governed Results Store" (RDS).
*   **Storage:** Local `./uploads` and `./artifacts` directories (mocking Amazon S3).
*   **AI Integration:**
    *   **Vision/OCR:** OpenAI `gpt-4o` or Anthropic `claude-3-5-sonnet-20241022` (to simulate Google Vision OCR + Answer Structuring).
    *   **Evaluation:** Anthropic `claude-3-5-sonnet-20241022` (to simulate the Rubric Evaluation engine).

## 3. The Functional Pipeline (To Be Implemented)
The core flow is below: a FastAPI backend handles these steps sequentially when triggered by the Next.js frontend.

1.  **Ingestion (API Route):** Receive a PDF/Image of a student's answer sheet and a Rubric JSON. Save to local storage.
2.  **Mock Job Queue:** Use FastAPI `BackgroundTasks` to decouple the upload from processing.
3.  **Mock Pre-processing:** A simple Python function that logs "Simulating Deskew and 300 DPI Contrast Enhancement."
4.  **OCR & Parse (AI Call 1):** Send the image to the Vision LLM.
    *   *Prompt Directive:* "Extract handwritten text from this image and map it to question numbers. Output JSON in format: `[{question: 1, answer: '...', confidence: 0.9}]`."
5.  **Rubric Evaluation (AI Call 2):** Send the parsed JSON and the Rubric to Claude 3.5 Sonnet.
    *   *Prompt Directive:* "Grade the following student answers against this rubric. Output JSON with `estimated_marks`, `evidence`, `strengths`, and `gaps`."
6.  **Insights & ROI Engine (Deterministic Python):** Calculate ROI based on the BRD formula: `ROI = (weightage * gain potential) / effort_hours`. Generate top 5 study priorities.
7.  **Persistence:** Save the final JSON object (Scores, ROI, Insights) to the SQLite database.
8.  **Frontend Render:** The Next.js app polls or fetches this data to display the "Student Intelligence Report" and "Cohort Dashboard".

## 4. Data Models (SQLite Schemas)
Implement these models in the FastAPI backend:
*   **Tenant/Institution:** `id`, `name` (Mock data: "Instit-42").
*   **Batch:** `id`, `name`, `exam_type` (Mock data: "NEET-A", "Mock-07").
*   **Rubric:** `id`, `version`, `content` (JSON), `total_marks`.
*   **StudentSubmission:** `id`, `student_name`, `file_path`, `status` (PENDING, PROCESSING, COMPLETED, FAILED), `ocr_confidence`.
*   **EvaluationResult:** `submission_id`, `total_score`, `topic_mastery` (JSON), `roi_recommendations` (JSON), `strengths_gaps` (JSON).

## 5. Implementation Plan

### Phase 1: Project Scaffolding
1. Initialize a monorepo structure with two folders: `/frontend` and `/backend`.
2. In `/frontend`: Run `npx create-next-app@latest . --typescript --tailwind --eslint`. Install `lucide-react`, `axios`, `clsx`, `tailwind-merge`.
3. In `/backend`: Create a Python virtual environment. Install `fastapi`, `uvicorn`, `sqlalchemy`, `anthropic`, `openai`, `python-multipart`.
4. Create a `.env` file at the root. Include placeholders for `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` (the keys are filled in manually).

### Phase 2: Backend Development (FastAPI)
1. Setup `database.py` with SQLite and create the tables defined in Section 4.
2. Create `main.py` with the following endpoints:
   * `POST /api/upload`: Accepts a file and a student name. Saves file to `./uploads`, creates a `StudentSubmission` record (status: PENDING), and triggers a Background Task for the processing pipeline.
   * `GET /api/submissions`: Returns all submissions and their statuses.
   * `GET /api/results/{submission_id}`: Returns the `EvaluationResult` for the frontend report.
3. **Build the Processing Pipeline Worker (`pipeline.py`):**
   * Write the function `process_submission(submission_id: int)` that executes steps 3 through 7 from Section 3.
   * **Crucial:** Implement the AI calls cleanly. Use `pydantic` schemas for structured outputs from the LLMs (e.g., using OpenAI's `response_format={ "type": "json_object" }` or Anthropic's tool use/JSON mode).
   * Write the Deterministic ROI Python function. Example weightages for NEET: Physics (25%), Chemistry (25%), Biology (50%).

### Phase 3: Frontend Development (Next.js)
1. **Layout & Theme:** Use a navy, cyan, and lime color palette (`bg-slate-50`, text `slate-800`, accents of `#05a7c5` and `#a0d84e`) to mimic the 3iLens brand.
2. **Faculty Workspace Page (`/`):**
   * A clean dashboard showing "Active Batch: NEET-A Mock-07".
   * A Drag-and-Drop/File Input upload zone for Answer Sheets.
   * A "Processing Queue" table that fetches from `GET /api/submissions` and auto-refreshes every 3 seconds to show status changes (PENDING -> COMPLETED).
3. **Student Intelligence Report Page (`/report/[id]`):**
   * Read from `GET /api/results/{id}`.
   * Build a beautiful, grid-based UI showing:
     * **Top Stats:** Total Score, Overall Mastery %.
     * **Insights:** 2-3 Strengths, 2-3 Gaps (rendered as styled cards).
     * **Preparation ROI Engine:** A table showing the Top 5 recommended topics to study next, displaying the calculated ROI, effort hours, and rationale.

### Phase 4: Exception Handling (The "Human Review" Mock)
1. In the Backend Pipeline, add a mock check: If the uploaded file name contains the word "blurry", artificially set the `ocr_confidence` to `0.65`.
2. The pipeline should halt, change the status to `HUMAN_REVIEW_REQUIRED`, and skip the LLM evaluation.
3. Ensure the Frontend UI prominently displays this status in a warning color (amber/orange) on the dashboard, demonstrating the BRD's safety constraint.

### Phase 5: Seeding & Demo Readiness
1. Write a `seed.py` script in the backend that populates a mock Rubric in the database for a "Biology - Genetics" test.
2. Provide a `README.md` at the root with exact commands to start both the Next.js dev server and the FastAPI uvicorn server concurrently.

## 6. Implementation Guidelines
* **Do not use placeholder functions for the AI.** Write the actual API calls to Anthropic/OpenAI using their respective official Python SDKs.
* Ensure CORS is configured properly in FastAPI so the Next.js frontend running on port 3000 can talk to FastAPI on port 8000.
* Prioritize clean, modern UI for the Next.js components. The client demo relies heavily on visual appeal. Use Tailwind grids, cards with subtle shadows, and pill-shaped status badges.
* Implement robust error handling in the Python pipeline. If the LLM fails to return valid JSON, catch the exception, mark the submission as `FAILED` (simulating the DLQ route), and log the error.
