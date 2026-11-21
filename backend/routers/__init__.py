"""Package routers. main.py includes each module's `router`:

- pipeline_ops     [WP2]  retry / re-evaluate / OCR review / rescan / pages / invocations / ops costs /
                          intake batches / rubric versions
- analytics_routes [WP1]  study plan / weightage / exams / batch patch / consistency check /
                          rubric parse / rubric create
- outputs          [WP3]  PDFs / bundle / release / deliveries / download links / students / filters

Wave 2 (contract v3):
- ai_ops           [W2-1] LLM provider chain + fallback drill / Bloom level detection
- voice_routes     [W2-2] voice answer audio + transcript
- lms              [W2-2] read-only LMS export (X-API-Key) + key management
- owner_routes     [W2-2] institute-owner dashboard
- insights_routes  [W2-3] intervention log + effectiveness / what-if

Endpoint shapes are fixed in /API_CONTRACT.md; use errors.ApiError for coded errors.
"""
