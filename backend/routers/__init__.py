"""Package routers. main.py includes each module's `router`:

- pipeline_ops     [WP2]  retry / re-evaluate / OCR review / rescan / pages / invocations / ops costs /
                          intake batches / rubric versions
- analytics_routes [WP1]  study plan / weightage / exams / batch patch / consistency check /
                          rubric parse / rubric create
- outputs          [WP3]  PDFs / bundle / release / deliveries / download links / students / filters

Endpoint shapes are fixed in /API_CONTRACT.md; use errors.ApiError for coded errors.
"""
