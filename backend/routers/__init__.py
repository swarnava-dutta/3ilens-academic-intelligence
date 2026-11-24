"""Package routers. main.py includes each module's `router`:

- pipeline_ops      retry / re-evaluate / OCR review / rescan / pages / invocations / ops costs /
                    intake batches / rubric versions
- analytics_routes  study plan / weightage / exams / batch patch / consistency check /
                    rubric parse / rubric create
- outputs           PDFs / bundle / release / deliveries / download links / students / filters
- ai_ops            LLM provider chain + fallback drill / Bloom level detection
- voice_routes      voice answer audio + transcript
- lms               read-only LMS export (X-API-Key) + key management
- owner_routes      institute-owner dashboard
- insights_routes   intervention log + effectiveness / what-if
- intake_routes     intake file inspection (printed MCQ paper / answer-key paper / answer sheet)

Endpoint shapes are fixed in /API_CONTRACT.md; use errors.ApiError for coded errors.
"""
