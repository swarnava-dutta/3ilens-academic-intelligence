# Report branding

The student report (`GET /api/reports/{id}/pdf`), the cohort report (`GET /api/cohort/pdf`) and the
ZIP bundle are rendered by `backend/reports.py` with PyMuPDF. Every page gets the same header band:
`3i ACADEMIC INTELLIGENCE / NEET POC` on the left and a brand mark on the right.

## Institute logo: `REPORT_LOGO_PATH`

Set `REPORT_LOGO_PATH` in the repo-root `.env` to the absolute path of a PNG or JPEG logo, for example:

```
REPORT_LOGO_PATH=H:/3ilens/backend/branding/institute-logo.png
```

- The logo is drawn top-right on every page, scaled to fit a 150 x 34 pt box with its aspect ratio kept.
  A wide logo (about 4:1) with a transparent or white background looks best.
- The setting is read on every request, so a new logo shows on the next report download. Cached
  student PDFs (`artifacts/<submission id>/report_*.pdf`) are keyed on the report content and on the
  logo path and file time, so changing or replacing the logo re-renders them.
- If the variable is empty, the file is missing or it cannot be drawn, the report falls back to the
  built-in text mark: a teal "3i" square, "3iLens" and the institution name. A bad logo never
  breaks a report.

No logo file is shipped or required. This folder is a convenient place to keep one locally;
it is not served by the API.

## Related settings

| Variable | Default | Effect on outputs |
|---|---|---|
| `REPORT_LOGO_PATH` | empty | Header logo (above). |
| `WHATSAPP_MODE` | `blocked` | `blocked` records deliveries as `BLOCKED_TEMPLATE_PENDING` (Meta template `3ilens_report_ready_v1` pending approval); `simulate` records `SIMULATED_NOT_SENT`. Nothing is ever sent in this PoC. |
| `DOWNLOAD_LINK_SECRET` | random per process | HMAC-SHA256 key for signed download links. Set it to keep links valid across restarts. |
| `DOWNLOAD_LINK_TTL_HOURS` | `24` | Lifetime of a signed download link. |
