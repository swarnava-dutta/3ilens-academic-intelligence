"""Branded PDF reports, built with PyMuPDF only (pymupdf.Story + pymupdf.DocumentWriter).

    render_student_pdf(result, *, superseded_by=None) -> bytes   SAIR-style student report
    render_cohort_pdf(cohort, *, students) -> bytes               cohort / class report

Layout: the content is a list of small blocks (a paragraph, a headed table, ...). Each block is
its own Story, placed into the space left on the current A4 page; a block that does not fit moves
to the next page, and tables split at row boundaries with their header row repeated. (Placing one
long Story across several pages makes MuPDF repaint the backgrounds of earlier boxes as strips at
the top of every later page, so long stories are deliberately avoided.) HTML uses tables and div
bars only - no flexbox or grid. The header band, footer and diagonal watermark are stamped on the
reopened document afterwards, then fonts are subset and the file is saved with garbage=3 + deflate.
Charts are Html blocks ending in a blank box of a known height; once the pages exist, the bars, axes
and labels are drawn into that box with plain PyMuPDF vector calls.

Text that may reach the PDF is always HTML-escaped. Every narrative list renders gracefully when
it is empty (older rows and stubbed analytics).
"""
from __future__ import annotations

import html
import io
import logging
import math
import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from functools import partial
from itertools import zip_longest
from typing import Any

import pymupdf

import marking
import voice
from analytics import HIGH_ROI_SHARE, TARGET_MASTERY, WEAK_MASTERY
from config import get_settings
from report_meta import fmt_ist, to_ist
from schemas import CohortOut, ResultOut, StudentCard

logger = logging.getLogger("3ilens.reports")

# --------------------------------------------------------------------------- #
# Page geometry and palette
# --------------------------------------------------------------------------- #
A4 = pymupdf.paper_rect("a4")                    # 595 x 842 pt
CONTENT = pymupdf.Rect(40, 66, A4.width - 40, A4.height - 52)  # inset about 40 pt, below the header band
CONTENT_WIDTH = CONTENT.width
BLOCK_GAP = 7.0
SECTION_GAP = 16.0
PAGE1_GAP = 11.0  # the summary page is denser so the score, insights, subjects and focus fit on page 1
CELL_PAD = 3.5  # CSS padding of table cells (each side)

NAVY = "#13233f"
# The design system's navy / blue (design-system/3ilens/MASTER.md), as on the web report.
TEAL = "#3b82f6"
SECTION = "#1e40af"
INK = "#1f2a37"
MUTED = "#5b6876"
RULE = "#d5dde5"
ALT = "#f3f6f9"
GOOD = "#3a87ad"
AMBER = "#b7791f"
RED = "#c0503f"
GREEN = "#3f8f3a"
URGENCY_COLORS = {"on_track": GREEN, "needs_attention": AMBER, "at_risk": RED}
URGENCY_LABELS = {"on_track": "On track", "needs_attention": "Needs attention", "at_risk": "At risk"}
PRIORITY_COLORS = {"high": RED, "medium": AMBER, "low": GOOD}
# Report redesign (design-system MASTER.md): navy measures, amber only for targets / highlights.
MEASURE = "#1e40af"
MEASURE_LIGHT = "#3b82f6"
AMBER_MARK = "#d97706"
AMBER_TEXT = "#b45309"
WRONG = "#dc2626"
BLANK_EDGE = "#64748b"
BONUS_FILL = "#bfdbfe"
BAND_GREYS = ("#eef0f3", "#dfe3e8", "#c9cfd7")  # neutral greys, darker towards On track

ILLUSTRATIVE_LABEL = "Illustrative, unvalidated projection - coefficients not calibrated"
PROVISIONAL_FOOTER = "PROVISIONAL - teacher review pending"
BRAND = "3i Academic Intelligence"
KICKER_BRAND = "3i ACADEMIC INTELLIGENCE"

CSS = f"""
* {{ font-family: sans-serif; }}
body {{ font-size: 9pt; color: {INK}; margin: 0; padding: 0; line-height: 1.3; }}
p {{ margin: 0; }}
h1 {{ font-size: 21pt; color: {NAVY}; margin: 2pt 0 3pt 0; padding-bottom: 4pt; border-bottom: 2pt solid {TEAL}; }}
h2 {{ font-size: 13.5pt; color: {SECTION}; margin: 0 0 5pt 0; padding-bottom: 3pt; border-bottom: 0.6pt solid {RULE}; }}
h3 {{ font-size: 10.5pt; color: {NAVY}; margin: 0 0 4pt 0; }}
.kicker {{ font-size: 8pt; color: {SECTION}; font-weight: bold; }}
.lead {{ font-size: 10.5pt; color: {MUTED}; }}
.cap {{ font-size: 7.6pt; color: {MUTED}; margin-top: 3pt; }}
.muted {{ color: {MUTED}; }}
.small {{ font-size: 7.8pt; }}
.label {{ font-size: 8pt; font-weight: bold; color: {NAVY}; margin-bottom: 1pt; }}
.para {{ margin-bottom: 2pt; }}
.summary {{ font-style: italic; color: {NAVY}; }}
table {{ border-collapse: collapse; margin: 0; }}
td {{ border: 0.5pt solid {RULE}; padding: {CELL_PAD}pt; vertical-align: top; font-size: 8.3pt; }}
tr.h td {{ background-color: {NAVY}; color: #ffffff; font-weight: bold; font-size: 8pt; }}
tr.alt td {{ background-color: {ALT}; }}
tr.na td {{ color: #9aa5b1; }}
tr.cur td {{ font-weight: bold; }}
td.k {{ font-weight: bold; color: {NAVY}; }}
.big {{ font-size: 13pt; font-weight: bold; color: {NAVY}; }}
.track {{ background-color: #e5edf2; height: 7pt; width: 100%; }}
.fill {{ height: 7pt; }}
.banner {{ padding: 5pt 7pt; font-weight: bold; font-size: 8.6pt; border-left: 3pt solid {RED}; background-color: #fdecea; color: #9b2c1f; }}
.banner.ok {{ border-left: 3pt solid {GREEN}; background-color: #e8f4e6; color: #2c6a28; }}
.banner.demo {{ border-left: 3pt solid {AMBER}; background-color: #fbf3e2; color: #7a5110; }}
.banner.old {{ border-left: 3pt solid {MUTED}; background-color: #eef1f4; color: #3c4652; }}
.illus {{ padding: 4pt 7pt; font-weight: bold; font-size: 8.2pt; border-left: 3pt solid {AMBER}; background-color: #fbf3e2; color: #7a5110; }}
.denom {{ padding: 5pt 7pt; font-size: 9pt; border-left: 3pt solid {TEAL}; background-color: #eff6ff; color: {NAVY}; }}
.hero {{ font-size: 24pt; font-weight: bold; color: {MEASURE}; }}
.heropct {{ font-size: 15pt; font-weight: bold; color: {MEASURE}; }}
.chip {{ font-size: 9.5pt; font-weight: bold; }}
.notice {{ padding: 4pt 7pt; font-size: 8.6pt; border-left: 3pt solid {AMBER_MARK}; background-color: #fef6e7; color: #7a4a06; }}
.insight {{ font-size: 10pt; font-weight: bold; color: {MEASURE}; }}
ul {{ margin: 0 0 0 12pt; padding: 0; }}
li {{ margin: 0 0 1pt 0; }}
"""


# --------------------------------------------------------------------------- #
# Small formatting helpers
# --------------------------------------------------------------------------- #
def _e(value: Any) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def _n(value: Any, digits: int = 1) -> str:
    """14.0 -> '14', 3.5 -> '3.5', 66.666 -> '66.7'."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "-"
    rounded = round(number, digits)
    return f"{rounded:.{digits}f}".rstrip("0").rstrip(".") if digits else f"{rounded:.0f}"


def _frac(score: Any, total: Any) -> str:
    return f"{_n(score)}/{_n(total)}"


def _pct(value: Any) -> str:
    """One percentage format everywhere: always 1 decimal ('55.8%', '40.0%')."""
    try:
        return f"{float(value):.1f}%"
    except (TypeError, ValueError):
        return "-"


def _pct_of(part: Any, whole: Any) -> str:
    """1-decimal percentage from the unrounded ratio."""
    try:
        whole = float(whole)
        return f"{float(part) / whole * 100:.1f}%" if whole else "-"
    except (TypeError, ValueError):
        return "-"


def _marks(value: Any) -> str:
    """Marks: whole when whole, real minus sign ('402', '30.6', '−26')."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "-"
    text = _n(abs(number), 2)
    return f"−{text}" if number < 0 and text != "0" else text


def _minus(text: str) -> str:
    """Real minus signs in '+4 / -1' and '-1 wrong' (never inside words or ranges like 'Q1-Q5')."""
    return re.sub(r"(?<![\w-])-(\d)", r"−\1", text)


def _rs(value: Any) -> str:
    return "-" if value is None else f"Rs {float(value):.2f}"


def _qs(numbers: Iterable[Any], empty: str = "-") -> str:
    items = [f"Q{n}" for n in numbers]
    return ", ".join(items) if items else empty


def _pages(numbers: Iterable[Any]) -> str:
    items = [f"p.{n}" for n in numbers]
    return ", ".join(items) if items else "-"


def _first_sentence(text: str | None, limit: int = 170) -> str:
    text = " ".join(str(text or "").split())
    if not text:
        return ""
    match = re.match(r"(.+?\.)(\s|$)", text)
    sentence = match.group(1) if match else text
    return sentence if len(sentence) <= limit else sentence[: limit - 3].rstrip() + "..."


def _mastery_color(mastery: float) -> str:
    if mastery < 40:
        return RED
    if mastery < 70:
        return AMBER
    return GOOD


def _bar(pct: Any, color: str | None = None) -> str:
    try:
        value = max(0.0, min(100.0, float(pct)))
    except (TypeError, ValueError):
        value = 0.0
    fill = (
        f'<div class="fill" style="width:{value:.1f}%;background-color:{color or _mastery_color(value)}"></div>'
        if value > 0
        else ""
    )
    return f'<div class="track">{fill}</div>'


def _urgency(urgency: str | None) -> str:
    if not urgency:
        return "-"
    return f'<b style="color:{URGENCY_COLORS.get(urgency, INK)}">{_e(URGENCY_LABELS.get(urgency, urgency))}</b>'


def _latin1(text: str) -> str:
    """Header/footer/watermark use the base-14 fonts (Latin-1 only)."""
    replacements = {"–": "-", "—": "-", "‘": "'", "’": "'", "“": '"', "”": '"',
                    "→": "->", "≥": ">=", "≤": "<=", "₹": "Rs ", "…": "...", "−": "-", "★": "*"}
    for src, dst in replacements.items():
        text = text.replace(src, dst)
    return text.encode("latin-1", "replace").decode("latin-1")


def _ist(dt: datetime | None) -> str:
    return fmt_ist(dt) if dt is not None else "-"


# --------------------------------------------------------------------------- #
# Blocks and the page layout engine
# --------------------------------------------------------------------------- #
@dataclass
class Html:
    """An atomic block: moved to the next page when it does not fit."""

    html: str
    gap: float = BLOCK_GAP


@dataclass
class Table:
    """A table that may split across pages at row boundaries (header row repeated)."""

    columns: Sequence[tuple[str, float]]  # (header label, width fraction)
    rows: Sequence[Sequence[str]]          # cell HTML (already escaped)
    head: str = ""                         # HTML kept with the first chunk (heading / intro)
    foot: str = ""                         # HTML after the last chunk (caption)
    row_classes: Sequence[str] | None = None
    header: bool = True
    gap: float = BLOCK_GAP
    zebra: bool = True
    widths: list[float] = field(init=False, default_factory=list)

    def __post_init__(self) -> None:
        total = sum(w for _, w in self.columns) or 1.0
        usable = CONTENT_WIDTH - len(self.columns) * (2 * CELL_PAD + 0.5)
        self.widths = [usable * w / total for _, w in self.columns]

    def _cells(self, cells: Sequence[str]) -> str:
        return "".join(
            f'<td style="width:{width:.1f}pt">{cell}</td>' for cell, width in zip(cells, self.widths)
        )

    def chunk_html(self, rows: Sequence[int], *, first: bool, last: bool) -> str:
        parts = [self.head if first else ""]
        parts.append("<table>")
        if self.header:
            parts.append(f'<tr class="h">{self._cells([_e(label) for label, _ in self.columns])}</tr>')
        for index in rows:
            classes = []
            if self.zebra and index % 2 == 1:
                classes.append("alt")
            if self.row_classes and index < len(self.row_classes) and self.row_classes[index]:
                classes.append(self.row_classes[index])
            attr = f' class="{" ".join(classes)}"' if classes else ""
            cells = list(self.rows[index]) + [""] * (len(self.columns) - len(self.rows[index]))
            parts.append(f"<tr{attr}>{self._cells(cells)}</tr>")
        parts.append("</table>")
        if last and self.foot:
            parts.append(self.foot)
        return "".join(parts)


@dataclass
class Chart(Html):
    """An Html block whose last `height` points are left blank for draw(page, rect)."""

    height: float = 0.0
    draw: Callable[[pymupdf.Page, pymupdf.Rect], None] | None = None


@dataclass
class PageBreak:
    pass


Block = Html | Table | PageBreak


class _Layout:
    def __init__(self) -> None:
        self.buffer = io.BytesIO()
        self.writer = pymupdf.DocumentWriter(self.buffer)
        self.device: Any = None
        self.y = CONTENT.y0
        self.pages = 0
        self.charts: list[tuple[int, pymupdf.Rect, Any]] = []

    # -- pages -----------------------------------------------------------------------------
    def _new_page(self) -> None:
        if self.device is not None:
            self.writer.end_page()
        self.device = self.writer.begin_page(A4)
        self.y = CONTENT.y0
        self.pages += 1

    @property
    def at_top(self) -> bool:
        return self.device is None or self.y <= CONTENT.y0 + 0.5

    def _rect(self, gap: float) -> pymupdf.Rect:
        return pymupdf.Rect(CONTENT.x0, self.y + (0 if self.at_top else gap), CONTENT.x1, CONTENT.y1)

    @staticmethod
    def _story(source: str) -> pymupdf.Story:
        return pymupdf.Story(html=source, user_css=CSS)

    def _fits(self, source: str, gap: float) -> tuple[bool, pymupdf.Story, pymupdf.Rect]:
        story = self._story(source)
        more, filled = story.place(self._rect(gap))
        filled = pymupdf.Rect(filled)
        # An empty fixed-height div (chart space) never reports overflow, so check the filled box too.
        return not more and filled.y1 <= CONTENT.y1 + 0.5, story, filled

    def _draw(self, story: pymupdf.Story, filled: pymupdf.Rect) -> None:
        story.draw(self.device)
        self.y = max(self.y, filled.y1)

    def _flow(self, source: str) -> None:
        """Last resort for a block taller than a whole page: flow it across pages."""
        if not self.at_top:
            self._new_page()
        story = self._story(source)
        while True:
            more, filled = story.place(self._rect(0))
            story.draw(self.device)
            self.y = pymupdf.Rect(filled).y1
            if not more:
                return
            self._new_page()

    # -- blocks ----------------------------------------------------------------------------
    def add(self, block: Block) -> None:
        if isinstance(block, PageBreak):
            if not self.at_top:
                self._new_page()
            return
        if self.device is None:
            self._new_page()
        if isinstance(block, Table):
            self._add_table(block)
        else:
            self._add_html(block.html, block.gap)
            if isinstance(block, Chart):
                box = pymupdf.Rect(CONTENT.x0, self.y - block.height, CONTENT.x1, self.y)
                self.charts.append((self.pages - 1, box, block.draw))

    def _add_html(self, source: str, gap: float) -> None:
        ok, story, filled = self._fits(source, gap)
        if not ok and not self.at_top:
            self._new_page()
            ok, story, filled = self._fits(source, gap)
        if ok:
            self._draw(story, filled)
        else:
            self._flow(source)

    def _add_table(self, table: Table) -> None:
        remaining = list(range(len(table.rows)))
        first = True
        if not remaining:
            self._add_html(table.chunk_html([], first=True, last=True), table.gap)
            return
        while remaining:
            source = table.chunk_html(remaining, first=first, last=True)
            ok, story, filled = self._fits(source, table.gap)
            if ok:
                self._draw(story, filled)
                return
            # Largest prefix of rows that fits here (header row repeated on every chunk).
            low, high, best = 1, len(remaining) - 1, 0
            best_story: tuple[pymupdf.Story, pymupdf.Rect] | None = None
            while low <= high:
                mid = (low + high) // 2
                ok, story, filled = self._fits(table.chunk_html(remaining[:mid], first=first, last=False), table.gap)
                if ok:
                    best, best_story = mid, (story, filled)
                    low = mid + 1
                else:
                    high = mid - 1
            min_rows = 1 if self.at_top else min(2, len(remaining))  # no orphaned heading + 1 row
            if best >= min_rows and best_story is not None:
                self._draw(*best_story)
                remaining = remaining[best:]
                first = False
                self._new_page()
                continue
            if self.at_top:  # a single row taller than a page
                self._flow(table.chunk_html(remaining, first=first, last=True))
                return
            self._new_page()

    def finish(self) -> bytes:
        if self.device is None:
            self._new_page()
        self.writer.end_page()
        self.writer.close()
        return self.buffer.getvalue()


def _layout(blocks: Iterable[Block]) -> bytes:
    layout = _Layout()
    for block in blocks:
        layout.add(block)
    data = layout.finish()
    if not layout.charts:
        return data
    with pymupdf.open("pdf", data) as doc:
        for page, box, draw in layout.charts:
            draw(doc[page], box)
        return doc.tobytes()


# --------------------------------------------------------------------------- #
# Header band, footer, watermark
# --------------------------------------------------------------------------- #
def _hex(color: str) -> tuple[float, float, float]:
    color = color.lstrip("#")
    return tuple(int(color[i : i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


def _fit_text(text: str, fontname: str, size: float, width: float, minimum: float = 5.5) -> float:
    while size > minimum and pymupdf.get_text_length(text, fontname=fontname, fontsize=size) > width:
        size -= 0.25
    return size


def _draw_logo(page: pymupdf.Page, institution: str) -> None:
    right = A4.width - 40
    logo = get_settings().report_logo_path
    if logo is not None:
        try:
            if logo.is_file():
                page.insert_image(pymupdf.Rect(right - 150, 12, right, 46), filename=str(logo), keep_proportion=True)
                return
        except Exception:  # noqa: BLE001 - a bad logo file must never break the report
            logger.warning("REPORT_LOGO_PATH could not be drawn - using the text mark instead")
    # Text mark: teal square with "3i", then the product name and the institution.
    box = pymupdf.Rect(right - 132, 15, right - 108, 39)
    page.draw_rect(box, color=None, fill=_hex(TEAL), radius=0.18)
    page.insert_text((box.x0 + 4.2, box.y1 - 7.6), "3i", fontname="hebo", fontsize=12, color=(1, 1, 1))
    page.insert_text((box.x1 + 6, 27), "3iLens", fontname="hebo", fontsize=11.5, color=_hex(SECTION))
    name = _latin1(institution)
    size = _fit_text(name, "helv", 7, right - box.x1 - 6)
    page.insert_text((box.x1 + 6, 37), name, fontname="helv", fontsize=size, color=_hex(MUTED))


def _watermark(page: pymupdf.Page, lines: Sequence[tuple[str, str]]) -> None:
    center = pymupdf.Point(A4.width / 2, A4.height / 2)
    offsets = [0.0] if len(lines) == 1 else [-34.0 + 68.0 * i / (len(lines) - 1) for i in range(len(lines))]
    for (text, color), dy in zip(lines, offsets):
        text = _latin1(text)
        size = 64.0 if len(lines) == 1 else 50.0
        size = _fit_text(text, "hebo", size, 640, minimum=24)
        length = pymupdf.get_text_length(text, fontname="hebo", fontsize=size)
        origin = pymupdf.Point(center.x - length / 2, center.y + size * 0.35 + dy)
        page.insert_text(
            origin, text, fontname="hebo", fontsize=size, color=_hex(color),
            fill_opacity=0.09, stroke_opacity=0.09, morph=(center, pymupdf.Matrix(38)), overlay=True,
        )


def _stamp(
    data: bytes,
    *,
    kicker: str,
    institution: str,
    footer_parts: Sequence[str],
    watermarks: Sequence[tuple[str, str]],
    title: str,
    subject: str,
) -> bytes:
    doc = pymupdf.open("pdf", data)
    total = doc.page_count
    for index, page in enumerate(doc, start=1):
        # Header band
        page.insert_text((40, 30), _latin1(kicker), fontname="hebo", fontsize=8, color=_hex(NAVY))
        _draw_logo(page, institution)
        page.draw_line((40, 50), (A4.width - 40, 50), color=_hex(TEAL), width=1.3)
        # Footer
        page.draw_line((40, A4.height - 38), (A4.width - 40, A4.height - 38), color=_hex(RULE), width=0.6)
        footer = _latin1(" · ".join([*footer_parts, f"page {index}/{total}"]))
        size = _fit_text(footer, "helv", 7.2, A4.width - 80)
        length = pymupdf.get_text_length(footer, fontname="helv", fontsize=size)
        page.insert_text(((A4.width - length) / 2, A4.height - 26), footer, fontname="helv", fontsize=size,
                         color=_hex(MUTED))
        if watermarks:
            _watermark(page, watermarks)
    doc.set_metadata(
        {
            "title": _latin1(title),
            "author": f"{BRAND} (3iLens PoC)",
            "subject": _latin1(subject),
            "creator": "3iLens",
            "producer": f"PyMuPDF {pymupdf.__version__}",
        }
    )
    try:
        doc.subset_fonts()
    except Exception:  # noqa: BLE001 - subsetting is an optimisation only
        logger.warning("Font subsetting failed - saving the report with full fonts")
    out = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    return out


# --------------------------------------------------------------------------- #
# Shared section helpers
# --------------------------------------------------------------------------- #
def _h2(number: str, title: str) -> str:
    return f"<h2>{_e(number)} | {_e(title)}</h2>"


def _kv(rows: Sequence[tuple[str, str]], head: str = "", labels: tuple[str, str] = ("Item", "Value"),
        gap: float = BLOCK_GAP, key_width: float = 0.3) -> Table:
    return Table(
        columns=[(labels[0], key_width), (labels[1], 1 - key_width)],
        rows=[[f"<b>{_e(k)}</b>", v] for k, v in rows],
        head=head,
        gap=gap,
    )


def _exam_line(batch: Any) -> str:
    exam = getattr(batch, "exam", None) or "NEET"
    if not getattr(batch, "exam_date", None):
        return f"{exam} - exam date not set"
    assumed = " (assumed date)" if getattr(batch, "exam_date_assumed", True) else ""
    days = getattr(batch, "days_to_exam", None)
    mode = getattr(batch, "strategy_mode", None)
    tail = f" - {days} days to go, {mode} mode" if days is not None else " - date has passed"
    return f"{exam} on {batch.exam_date}{assumed}{tail}"


# --------------------------------------------------------------------------- #
# Student report (SAIR)
# --------------------------------------------------------------------------- #
def _release_text(result: ResultOut) -> str:
    release = result.release
    if release.status == "RELEASED":
        who = release.reviewed_by or "faculty"
        when = f" on {_ist(release.reviewed_at)}" if release.reviewed_at else ""
        return f"RELEASED by {who}{when}"
    return f"PROVISIONAL - AI-assisted; {result.scoring_controls.rubric_status} rubric; teacher review pending"


def _footer_status(result: ResultOut, superseded_by: str | None) -> str:
    if superseded_by:
        return f"SUPERSEDED by {superseded_by}"
    release = result.release
    if release.status == "RELEASED":
        date = fmt_ist(release.reviewed_at)[:10] if release.reviewed_at else ""
        return f"RELEASED by {release.reviewed_by or 'faculty'}" + (f" on {date}" if date else "")
    return PROVISIONAL_FOOTER


def _student_meta(result: ResultOut, superseded_by: str | None) -> list[Block]:
    meta = result.report_meta
    batch = meta.batch
    sub = result.submission
    rubric = result.rubric
    extraction = result.extraction
    student = _e(sub.student_name) + (' <span class="muted">(synthetic demo record)</span>' if meta.is_demo else "")
    is_voice = voice.is_voice(sub)
    if meta.is_demo:
        ocr = (
            "Synthetic sample voice answer - no audio stored, no transcription or AI call was made" if is_voice
            else "Synthetic demo transcription - no OCR or AI call was made"
        )
    else:
        conf = (f"confidence {result.ocr_confidence * 100:.1f}%" if result.ocr_confidence is not None
                else "confidence n/a")
        ocr = f"{conf} (review gate {extraction.threshold * 100:.0f}%) · {extraction.ocr_adapter}"
        if extraction.ocr_cache_hit:
            ocr += " · OCR cache hit - no vision call (Rs 0.00)"
    current = next((v for v in result.versions if v.current), None)
    rows = [
        ("Student", student),
        ("Student ref", _e(meta.student_ref)),
        ("Institution / batch", _e(f"{meta.institution.name} / {batch.name} · {batch.exam_type}")),
        ("Target exam", _e(_exam_line(batch))),
        ("Processing run", _e(meta.run_id)),
        (
            "Rubric",
            _e(f"{rubric.name} {rubric.version} · sha256 {(rubric.rubric_hash or '-')[:12]} · {rubric.status}"),
        ),
        ("Evaluated at", _e(f"{_ist(meta.executed_at)} ({meta.timezone})")),
        ("Speech-to-text" if is_voice else "OCR", _e(ocr)),
    ]
    if superseded_by or len(result.versions) > 1:
        version = current.version if current else 1
        label = f"v{version}" + (f" - SUPERSEDED by {superseded_by}" if superseded_by else " (current)")
        rows.append(("Evaluation version", _e(label)))
    rows.append(("Academic release", _e(_release_text(result))))
    blocks: list[Block] = [
        Table(columns=[("Run metadata", 0.3), ("Value", 0.7)], rows=[[f"<b>{k}</b>", v] for k, v in rows], gap=10)
    ]
    # Banners
    if superseded_by:
        blocks.append(Html(
            f'<div class="banner old">SUPERSEDED - this archived evaluation was replaced by {_e(superseded_by)}. '
            "Kept for audit only; use the current report for teaching decisions.</div>"
        ))
    if result.release.status == "RELEASED":
        note = f" Note: {result.release.note}" if result.release.note else ""
        blocks.append(Html(
            f'<div class="banner ok">{_e(_release_text(result))} - faculty sign-off recorded.{_e(note)}</div>'
        ))
    else:
        blocks.append(Html(
            '<div class="banner">PROVISIONAL - AI-assisted marks against rubric '
            f"{_e(rubric.version)} ({_e(rubric.status)}). Teacher review is pending; this is not official "
            f"{_e(batch.exam or 'NEET')} scoring and model agreement is not faculty certification.</div>"
        ))
    if meta.is_demo:
        blocks.append(Html(
            '<div class="banner demo">DEMO DATA - synthetic record generated locally without any AI call. '
            "Names, answers and marks are fictional.</div>"
        ))
    return blocks


def _section_topics(result: ResultOut, num: str = "02", title: str = "Topic screening (not proven mastery)") -> list[Block]:
    topics = sorted(result.topic_mastery, key=lambda t: (t.mastery, t.topic))
    rows = []
    for t in topics:
        rows.append([
            f"<b>{_e(t.topic)}</b> <span class=\"muted\">({_e(t.subject)})</span>",
            _bar(t.mastery),
            _pct(t.mastery),
            _frac(t.score, t.max_marks),
            _n(t.n or len(t.questions)),
            _e(f"{t.full} / {t.partial} / {t.zero} / {t.blank}"),
        ])
    return [Table(
        columns=[("Topic (subject)", 0.3), ("Screening result", 0.27), ("%", 0.09), ("Marks", 0.1), ("n", 0.06),
                 ("Full / partial / zero / blank", 0.18)],
        rows=rows,
        head=_h2(num, title),
        foot='<p class="cap">Observed marks on this paper\'s questions per topic, weakest first. n = questions '
             "covering the topic. These are screening proportions from one assessment, not psychometric mastery "
             "estimates.</p>",
        gap=SECTION_GAP,
    )]


def _section_nudges(result: ResultOut, head: str | None = None) -> list[Block]:
    head = _h2("04", "Teaching nudges") if head is None else head
    if not result.teaching_nudges:
        return [Html(head + '<p class="muted">No teaching nudges were generated for this sheet.</p>', gap=SECTION_GAP)]
    return [Table(
        columns=[("Priority", 0.13), ("Nudge for the teacher", 0.67), ("Questions", 0.2)],
        rows=[[
            f'<b style="color:{PRIORITY_COLORS.get(n.priority, INK)}">{_e(n.priority.upper())}</b>',
            f"<b>{_e(n.label)}</b><br/>{_e(n.text)}" + (f' <span class="muted">({_e(n.topic)})</span>' if n.topic else ""),
            _e(_qs(n.question_refs)),
        ] for n in result.teaching_nudges[:3]],
        head=head,
        foot='<p class="cap">Provisional teaching prompts derived from the graded evidence; review before use.</p>',
        gap=SECTION_GAP,
    )]


def _focus_rows(result: ResultOut) -> list[dict[str, Any]]:
    """Next-five rows: study-plan focus (engine v2) or, failing that, the stored top-5 ROI list."""
    rationale = {p.topic: p.rationale for p in result.roi_recommendations}
    plan = result.study_plan
    rows: list[dict[str, Any]] = []
    for index, t in enumerate(plan.focus[:5], start=1):
        rows.append({
            "rank": t.rank or index, "topic": t.topic, "subject": t.subject, "mastery": t.mastery,
            "target": t.target_mastery, "gain": t.gain_marks, "low": t.gain_low, "high": t.gain_high,
            "hours": t.effort_hours, "roi": t.roi,
            "why": _first_sentence(rationale.get(t.topic)) or _first_sentence(t.quadrant_reason),
        })
    if rows:
        return rows
    for index, p in enumerate(result.roi_recommendations[:5], start=1):
        rows.append({
            "rank": index, "topic": p.topic, "subject": p.subject, "mastery": p.mastery,
            "target": p.target_mastery, "gain": p.projected_gain_marks, "low": p.gain_low, "high": p.gain_high,
            "hours": p.effort_hours, "roi": p.roi, "why": _first_sentence(p.rationale),
        })
    return rows


def _section_roi(result: ResultOut, num: str = "05") -> list[Block]:
    plan = result.study_plan
    # Placeholder effort hours (a whole subject, the 1 h rubric default): no effort or ROI per hour.
    show_roi = result.roi_basis.effort_source_kind != "placeholder"
    head = (
        _h2(num, "Study plan lab (illustrative, for faculty)")
        + f'<div class="illus">{_e(ILLUSTRATIVE_LABEL)}</div>'
        + f'<p class="small muted" style="margin-top:3pt">{_e(plan.strategy_title)} · '
        + _e(f"{plan.exam} {_day_text(plan.exam_date)}".strip())
        + (" (assumed date)" if result.report_meta.batch.exam_date_assumed and plan.exam_date else "")
        + (_e(f" · {plan.days_to_exam} days to go") if plan.days_to_exam is not None else "")
        + _e(f" · study budget {_n(plan.study_hours)} h/week")
        + '</p><p style="margin-top:3pt"></p>'
    )
    rows = _focus_rows(result)
    if not rows:
        return [Html(head + '<p class="muted">No topic needs focus - every topic is at or above the target.</p>',
                     gap=SECTION_GAP)]
    table_rows = []
    for r in rows:
        target = (
            f"{_pct(r['mastery'])} → {_pct(r['target'])}"
            if r["target"] is not None and float(r["target"]) > float(r["mastery"])
            else _pct(r["mastery"])
        )
        if r["gain"] is not None:
            gain = f"+{_n(r['gain'])} marks"
            if r["low"] is not None and r["high"] is not None:
                gain += f' <span class="muted">({_n(r["low"])}-{_n(r["high"])})</span>'
        else:
            gain = '<span class="muted">n/a</span>'
        row = [
            _e(f"#{r['rank']}"),
            f"<b>{_e(r['topic'])}</b><br/><span class=\"muted\">{_e(r['subject'])}</span>",
            _e(target),
            gain,
        ]
        if show_roi:
            row += [_e(f"~{_n(r['hours'])} h"), _e(f"{float(r['roi']):.2f}")]
        why = r["why"] if show_roi else _first_sentence(r["why"])
        why = re.sub(r"(?<![\d.])(\d+(?:\.\d+)?)%", lambda m: f"{float(m.group(1)):.1f}%", why or "")
        row.append(_e(why or "-"))
        table_rows.append(row)
    notes = []
    if plan.explanation is not None and show_roi:
        notes.append(f"{plan.explanation.formula} - {plan.explanation.topic}: {plan.explanation.arithmetic}")
    if not show_roi:
        notes.append("Study-time estimates for these topics are placeholders, so the order follows the marks each "
                     "topic can still add.")
    ps = plan.projected_score
    if ps.scale_max:
        notes.append(f"{ps.label}: score {_pct(ps.current)} → {_pct(ps.expected)} of this paper "
                     f"(range {_pct(ps.low)}-{_pct(ps.high)}).")
    if plan.allocation_note:
        notes.append(plan.allocation_note)
    foot = "".join(f'<p class="cap">{_e(n)}</p>' for n in notes)
    columns = [("#", 0.05), ("Topic", 0.18), ("Current → target", 0.14), ("+marks projected (range)", 0.16)]
    columns += [("Effort", 0.08), ("ROI (illustr.)", 0.09), ("Why this topic", 0.3)] if show_roi else [
        ("Why this topic", 0.47)]
    return [Table(
        columns=columns,
        rows=table_rows,
        head=head,
        foot=foot,
        gap=SECTION_GAP,
    )]


def _section_actions(result: ResultOut, head: str | None = None) -> list[Block]:
    head = _h2("06", "Teacher action plan") if head is None else head
    priorities = result.roi_recommendations[:5]
    if not priorities:
        return [Html(head + '<p class="muted">No priority topics - maintain with timed mixed practice.</p>',
                     gap=SECTION_GAP)]
    rows = []
    for index, p in enumerate(priorities, start=1):
        iv = p.intervention
        rows.append([
            f"<b>P{index} | {_e(p.topic)}</b>" + (f'<br/><span class="muted">{_pct(p.mastery)} now</span>'),
            _e(_qs(p.trigger_questions[:6]) + (f" +{len(p.trigger_questions) - 6} more"
                                               if len(p.trigger_questions) > 6 else "")),
            _e(iv.teach if iv else f"Re-teach {p.topic} from the missed rubric points"),
            _e(iv.practice if iv else "-"),
            _e(iv.check_criterion if iv else "-"),
        ])
    return [Table(
        columns=[("Priority / topic", 0.19), ("Trigger questions", 0.12), ("Teach", 0.24), ("Practice", 0.23),
                 ("Check (measurable)", 0.22)],
        rows=rows,
        head=head,
        foot='<p class="cap">Teach / practice / check per priority, linked to the questions that triggered it. '
             "All prescriptions are provisional pending teacher review.</p>",
        gap=SECTION_GAP,
    )]


def _section_roadmap(result: ResultOut, num: str = "07") -> list[Block]:
    plan = result.study_plan
    head = _h2(num, "7 / 30 / 60 / 90-day teaching roadmap (for faculty)")
    intro = head + (f'<p class="para"><b>{_e(plan.strategy_title)}.</b> {_e(plan.strategy_text)}</p>'
                    if plan.strategy_title or plan.strategy_text else "")
    blocks: list[Block] = []
    if plan.roadmap:
        rows, classes = [], []
        for stage in plan.roadmap:
            rows.append([
                _e(f"{stage.days_label}"),
                f"<b>{_e(stage.title)}</b>" + ("" if stage.applicable else '<br/><span class="small">not applicable '
                                                                        "before the exam</span>"),
                _e("; ".join(stage.tasks) or "-"),
                _e(stage.checkpoint or "-"),
                _e(stage.condition or "-"),
            ])
            classes.append("" if stage.applicable else "na")
        blocks.append(Table(
            columns=[("Horizon", 0.11), ("Stage", 0.17), ("Tasks", 0.34), ("Checkpoint", 0.2), ("Condition", 0.18)],
            rows=rows,
            row_classes=classes,
            head=intro,
            foot='<p class="cap">Stages that do not fit before the exam date are greyed out.</p>',
            gap=SECTION_GAP,
            zebra=False,
        ))
    else:
        blocks.append(Html(intro + '<p class="muted">Roadmap not available for this result.</p>', gap=SECTION_GAP))
    return blocks


ACTIVITY_WORDS = {"learn": "Learn", "drill": "Fix errors", "fix_errors": "Fix errors", "review": "Review",
                  "checkpoint": "Checkpoint"}


def planned_time(minutes: Any) -> str:
    """'255 min (4 h 15 min)': the one planned-time format (the web report's too)."""
    try:
        total = int(round(float(minutes)))
    except (TypeError, ValueError):
        return "-"
    return f"{total} min" + (f" ({_duration(total)})" if total >= 60 else "")


def _section_week(result: ResultOut, num: str) -> list[Block]:
    """The student's study plan: this week's calendar and one line on where the time goes."""
    plan = result.study_plan
    days = [d for d in plan.weekly_calendar if d.blocks]
    if not days:
        return []
    minutes: dict[str, int] = {}
    for day in days:
        for b in day.blocks:
            minutes[b.topic] = minutes.get(b.topic, 0) + int(b.minutes)
    rank = {t.topic: i for i, t in enumerate(plan.focus)}
    split = ", ".join(f"{topic} {m} min" for topic, m in sorted(
        minutes.items(), key=lambda kv: (kv[0] not in rank, -kv[1], rank.get(kv[0], 0), kv[0])))
    head = (_h2(num, "Your study plan this week")
            + f'<p class="para">About {_e(planned_time(plan.planned_minutes_total))} this week: {_e(split)}.</p>')
    rows = []
    for day in plan.weekly_calendar:
        entries = "<br/>".join(
            f"<b>{_e(ACTIVITY_WORDS.get(b.activity, b.activity))}</b> · {_e(b.topic)} · {_e(b.minutes)} min"
            + (f' <span class="muted">- {_e(b.note)}</span>' if b.note else "")
            for b in day.blocks
        ) or '<span class="muted">Rest / buffer</span>'
        rows.append([_e(_day_text(day.date, weekday=True) or f"Day {day.day}"), entries])
    return [Table(columns=[("Day", 0.18), ("Study blocks", 0.82)], rows=rows, head=head, gap=SECTION_GAP)]


def _section_coverage(result: ResultOut, heading: bool = True) -> list[Block]:
    ex = result.extraction
    sc = result.scoring_controls
    custody = result.custody
    meta = result.report_meta
    established = [
        f"{ex.mapped} of {ex.total_questions} rubric questions transcribed and mapped"
        + (f"; mean OCR confidence {ex.mean_confidence * 100:.1f}%" if ex.mean_confidence is not None else "")
        + (f", lowest {ex.min_confidence:.2f}" if ex.min_confidence is not None else "")
        + f" (gate {ex.threshold:.2f}).",
        f"Item marks sum to {_n(sc.item_sum, 2)} = reported total {_n(sc.reported_total, 2)} "
        f"({'parity OK' if sc.parity else 'PARITY MISMATCH'}); marking rule: {_minus(sc.marking_rule)}.",
        f"Rubric {sc.rubric_version} ({sc.rubric_status}), sha256 {(sc.rubric_hash or '-')[:16]}...",
    ]
    if custody is not None:
        established.append(
            f"Source file sha256 {custody.sha256} ({custody.size_bytes:,} bytes, {custody.mime_type}"
            + (f", {custody.page_count} page(s)" if custody.page_count else "")
            + f"); type detected by {custody.detected_by}; custody "
            + ("verified" + (f" at {_ist(custody.verified_at)}" if custody.verified_at else "") if custody.verified
               else "NOT verified") + "."
        )
    else:
        established.append("No source scan is attached (synthetic demo or legacy record) - custody not applicable.")
    not_established = [
        f"Official {meta.batch.exam or 'NEET'} scoring, rank or percentile.",
        f"A calibrated score forecast - status {result.roi_basis.forecast_status} ({result.roi_basis.reason}).",
        "Root causes of errors beyond the grader's written evidence.",
        f"Mastery beyond the {ex.total_questions} question(s) on this paper.",
        "Faculty certification of the answer key" + (" - pending." if result.release.status != "RELEASED"
                                                       else " - recorded below."),
    ]
    blocks: list[Block] = [Table(
        columns=[("Established by this run", 0.5), ("Not established", 0.5)],
        rows=[[_e(a or ""), _e(b or "")] for a, b in zip_longest(established, not_established)],
        head=_h2("08", "Coverage, limitations and sign-off") if heading else "",
        gap=SECTION_GAP,
        zebra=False,
    )]
    cost = result.cost
    latency = result.latency
    bonus = {q.question for q in result.question_evaluations if q.bonus and q.outcome == "FULL"}
    unattempted = ", ".join(f"Q{n}" + (" (bonus, full marks)" if n in bonus else "") for n in ex.unattempted)
    details = [
        ("Extraction coverage", _e(f"{ex.mapped}/{ex.total_questions} mapped · unattempted {unattempted or 'none'}"
                                   f" · dropped {_qs(ex.dropped, 'none')} · {ex.below_threshold} answer(s) below the "
                                   f"gate")),
        ("Page confidence", _e(", ".join(f"p.{p.page} {p.confidence:.2f}" for p in ex.page_confidences) or "-")
         + (_e(f" · flagged {_pages(ex.flagged_pages)}") if ex.flagged_pages else "")),
        ("OCR adapter", _e(ex.ocr_adapter + (" · OCR cache hit - no vision call (Rs 0.00)" if ex.ocr_cache_hit
                                             else "") + f" · languages {', '.join(ex.language_hints)}")),
        ("Faculty corrections", _e("Yes - transcript corrected by faculty" if ex.corrected_by_faculty else "None")),
        ("Model cost", _e(
            ("Synthetic demo - no model calls (Rs 0.00)" if cost.synthetic else
             f"{_rs(cost.llm_cost_inr)} for {cost.calls} call(s) (OCR {_rs(cost.ocr_inr)}, evaluation "
             f"{_rs(cost.evaluation_inr)}) vs target {_rs(cost.target_inr)}"
             + ("" if cost.within_target is None else (" - within target" if cost.within_target else
                                                         " - OVER target")))
        )),
        ("Latency", _e(
            "-" if latency.seconds is None else
            f"{_n(latency.seconds)} s vs target {_n(latency.target_seconds)} s"
            + ("" if latency.within_target is None else (" - within target" if latency.within_target else
                                                          " - OVER target"))
        )),
    ]
    blocks.append(_kv(details, head='<p class="label">Extraction, cost and latency</p>', labels=("Check", "Detail"),
                      key_width=0.24))
    release = result.release
    signoff = [
        ("Release status", _e(release.status)),
        ("Reviewed by", _e(release.reviewed_by or "_______________________________")),
        ("Reviewed at", _e(_ist(release.reviewed_at) if release.reviewed_at else "_______________________________")),
        ("Note", _e(release.note or "-")),
        ("Faculty signature", "_______________________________"),
    ]
    blocks.append(_kv(signoff, head='<p class="label">Faculty certification</p>', labels=("Sign-off", "Record"),
                      key_width=0.24))
    return blocks


def _section_appendix(result: ResultOut) -> list[Block]:
    head = (_h2("Appendix A", "Non-full-credit questions with source pages")
            + '<p class="para small muted">Every question that did not receive full credit, with the grader\'s '
              "evidence and the answer-sheet pages it was transcribed from.</p>")
    items = [q for q in result.question_evaluations if q.outcome != "FULL"]
    if not items:
        return [PageBreak(), Html(head + '<p class="muted">Every question received full credit.</p>', gap=0)]
    rows = []
    for q in items:
        gap_text = _gap_words(q.gaps[0]) if q.gaps else ""
        detail = (f"<b>{_e(gap_text)}</b><br/>" if gap_text else "") + _e(_gap_words(q.evidence or ""))
        if q.uncertain_words:
            detail += '<br/><span class="muted small">Uncertain OCR: ' + _e(
                ", ".join(f"{w.text} ({w.confidence:.2f})" for w in q.uncertain_words[:6])) + "</span>"
        rows.append([
            _e(f"Q{q.question}"),
            _e(q.topic),
            f"{_marks(q.estimated_marks)}/{_marks(q.max_marks)}",
            _e(_outcome_label(q)),
            detail,
            _e(_pages(q.source_pages)) + (" · faculty-corrected" if q.corrected_by_faculty else ""),
        ])
    return [PageBreak(), Table(
        columns=[("Q", 0.06), ("Topic", 0.16), ("Marks", 0.09), ("Outcome", 0.1), ("Gap and grader evidence", 0.47),
                 ("Source", 0.12)],
        rows=rows,
        head=head,
        gap=0,
    )]


RESULT_LABELS = {"right": "Right", "wrong": "Wrong", "blank": "Blank", "bonus": "Bonus", "partial": "Partial",
                 "zero": "Zero"}


def _outcome_label(q: Any) -> str:
    """'Wrong −1', 'Blank 0', 'Partial 1.5': the web cards' words, never raw codes (ZERO / BLANK)."""
    kind = q.result_kind or {"FULL": "right", "PARTIAL": "partial", "ZERO": "zero", "BLANK": "blank"}.get(
        q.outcome, "zero")
    label = RESULT_LABELS.get(kind, kind.title())
    return label if kind in ("right", "bonus") else f"{label} {_marks(q.estimated_marks)}"


_CHOSE = re.compile(r"Chose (?P<marked>[^;]+); correct (?P<key>.+?)(?: \((?P<marks>[+-]?\d+(?:\.\d+)?)\))?")


def _gap_words(text: str) -> str:
    """'Chose A; correct B or C (-1)' -> 'Marked A · Accepted B or C · −1' (the web cards' wording);
    other text only gets real minus signs in '(-1)'."""
    match = _CHOSE.fullmatch(text.strip())
    if match:
        out = f"Marked {match['marked']} · Accepted {match['key']}"
        return out + (f" · {_marks(float(match['marks']))}" if match["marks"] else "")
    return re.sub(r"\(-(\d)", "(−\\1", text)


# --------------------------------------------------------------------------- #
# Student charts
# --------------------------------------------------------------------------- #
CYAN = "#1e40af"         # the data series (navy, as on the web)
CONTEXT = "#cbd5e1"      # context marks: marks available, the starting score
GRID = "#e2e8f0"
SLATE = "#334155"
SLATE_MUTED = "#64748b"
GAIN = "#0ca30c"
BAR_ROW = 15.0
BAR_ROWS_PER_CHART = 40  # keeps a bar chart shorter than a page

Bar = tuple[str, list[tuple[float, float, str]], str, float | None]  # label, (from, to, colour)s, value, tick


def _chart(title: str, text: str, height: float = 0.0, draw: Callable | None = None) -> Html:
    head = f"<h3>{_e(title)}</h3>" + (f'<p class="small" style="color:{SLATE}">{_e(text)}</p>' if text else "")
    if draw is None:
        return Html(head, gap=10)
    return Chart(head + f'<div style="height:{height:.1f}pt"></div>', gap=10, height=height, draw=draw)


def _clip(text: str, size: float, width: float) -> str:
    text = _latin1(text)
    if pymupdf.get_text_length(text, fontname="helv", fontsize=size) <= width:
        return text
    while len(text) > 1 and pymupdf.get_text_length(text + "...", fontname="helv", fontsize=size) > width:
        text = text[:-1]
    return text.rstrip() + "..."


def _text(page: pymupdf.Page, x: float, y: float, text: str, size: float = 7.0, color: str = SLATE,
          align: float = 0.0, width: float = 1000.0) -> pymupdf.Rect:
    """Text with its baseline at y; align 0 = left, 0.5 = centred, 1 = right of x. Returns its box."""
    text = _clip(text, size, width)
    length = pymupdf.get_text_length(text, fontname="helv", fontsize=size)
    x -= length * align
    page.insert_text((x, y), text, fontname="helv", fontsize=size, color=_hex(color))
    return pymupdf.Rect(x, y - size * 0.75, x + length, y + size * 0.25)


def _line(page: pymupdf.Page, a: Any, b: Any, color: str = GRID, width: float = 0.5, dashes: str | None = None) -> None:
    page.draw_line(a, b, color=_hex(color), width=width, dashes=dashes)


def _ticks(top: float) -> list[float]:
    """0 up to a round number >= top, in at most five steps."""
    step = next((s for s in (0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100) if top / s <= 5), top / 5) or 1
    return [i * step for i in range(max(1, math.ceil(top / step - 1e-9)) + 1)]


def _scale(start: float, end: float, top: float) -> Callable[[float], float]:
    return lambda v: start + (end - start) * max(0.0, min(float(v), top)) / top


def _grid(page: pymupdf.Page, plot: pymupdf.Rect, ticks: list[float], pos: Callable[[float], float],
          fmt: Callable[[float], str], vertical: bool = True) -> None:
    """Light grid lines with their tick labels below (vertical lines) or to the left (horizontal)."""
    for tick in ticks:
        p = pos(tick)
        if vertical:
            _line(page, (p, plot.y0), (p, plot.y1))
            _text(page, p, plot.y1 + 9, fmt(tick), 6.5, SLATE_MUTED, 0.5)
        else:
            _line(page, (plot.x0, p), (plot.x1, p))
            _text(page, plot.x0 - 4, p + 2.3, fmt(tick), 6.5, SLATE_MUTED, 1.0)


def _draw_bars(rows: Sequence[Bar], ticks: list[float], fmt: Callable[[float], str], page: pymupdf.Page,
               box: pymupdf.Rect) -> None:
    plot = pymupdf.Rect(box.x0 + 150, box.y0, box.x1 - 50, box.y1 - 14)
    sx = _scale(plot.x0, plot.x1, ticks[-1])
    _grid(page, plot, ticks, sx, fmt)
    for i, (label, segments, value, tick) in enumerate(rows):
        mid = plot.y0 + BAR_ROW * (i + 0.5)
        _text(page, plot.x0 - 6, mid + 2.5, label, align=1.0, width=140)
        for start, end, colour in segments:
            if end > start:
                page.draw_rect(pymupdf.Rect(sx(start), mid - 4.5, sx(end), mid + 4.5), color=None, fill=_hex(colour))
        if tick is not None:
            _line(page, (sx(tick), mid - 6.5), (sx(tick), mid + 6.5), SLATE, 1.2)
        right = max(end for _, end, _ in segments)
        if tick is not None and 0 <= sx(tick) - sx(right) < 30:  # keep the value clear of a nearby tick
            right = tick
        _text(page, sx(right) + 4, mid + 2.5, value)


def _bar_charts(title: str, text: str, rows: Sequence[Bar], top: float, fmt: Callable[[float], str]) -> list[Block]:
    """Horizontal bars; a long list continues in a second chart rather than running off the page."""
    ticks = _ticks(top)
    blocks: list[Block] = []
    for i in range(0, len(rows), BAR_ROWS_PER_CHART):
        chunk = rows[i:i + BAR_ROWS_PER_CHART]
        blocks.append(_chart(f"{title} (continued)" if i else title, "" if i else text,
                             len(chunk) * BAR_ROW + 14, partial(_draw_bars, chunk, ticks, fmt)))
    return blocks


def _chart_trend(result: ResultOut) -> list[Block]:
    title = "Score trend"
    tests = sorted(result.history, key=lambda h: h.date)
    if len(tests) < 2:
        return [_chart(title, "Only this test is on record for the student, so there is no trend yet.")]
    first, last = tests[0], tests[-1]
    change = last.pct - first.pct
    text = (f"{_pct(first.pct)} on {_ist(first.date)[:10]} to {_pct(last.pct)} on {_ist(last.date)[:10]} "
            f"({'+' if change >= 0 else ''}{_n(change)} points over {len(tests)} tests); the tests are not "
            "equated for difficulty.")

    def draw(page: pymupdf.Page, box: pymupdf.Rect) -> None:
        plot = pymupdf.Rect(box.x0 + 30, box.y0 + 12, box.x1 - 10, box.y1 - 22)
        sy = _scale(plot.y1, plot.y0, 100.0)
        step = plot.width / len(tests)
        _grid(page, plot, _ticks(100), sy, _pct, vertical=False)
        points = [(plot.x0 + step * (i + 0.5), sy(h.pct)) for i, h in enumerate(tests)]
        page.draw_polyline(points, color=_hex(CYAN), width=1.4)
        for (x, y), h in zip(points, tests):
            page.draw_circle((x, y), 3.4 if h.current else 2.4, color=(1, 1, 1), fill=_hex(CYAN), width=0.8)
            _text(page, x, y - 6, _pct(h.pct), align=0.5)
            _text(page, x, plot.y1 + 9, _ist(h.date)[:10], 6.5, SLATE_MUTED, 0.5)
            _text(page, x, plot.y1 + 17, "this report" if h.current else h.rubric_name, 6.5, SLATE_MUTED, 0.5,
                  step - 6)

    return [_chart(title, text, 150, draw)]


def _chart_topics(result: ResultOut) -> list[Block]:
    title = "Topic mastery vs target"
    topics = sorted(result.topic_mastery, key=lambda t: (t.mastery, t.topic))
    if not topics:
        return [_chart(title, "No topic-level marks were recorded for this result.")]
    target = {t.topic: t.target_mastery for t in result.study_plan.topics}
    rows = [(t.topic, [(0.0, t.mastery, CYAN)], _pct(t.mastery), target.get(t.topic, TARGET_MASTERY))
            for t in topics]
    below = sum(t.mastery < target.get(t.topic, TARGET_MASTERY) for t in topics)
    lowest = sum(t.mastery == topics[0].mastery for t in topics)
    weakest = (f"the weakest is {topics[0].topic} at {_pct(topics[0].mastery)}." if lowest == 1
               else f"{lowest} topics tie for weakest at {_pct(topics[0].mastery)}.")
    text = (f"{below} of {len(topics)} topics are below target (dark tick); {weakest}" if below
            else f"All {len(topics)} topics are at or above target (dark tick).")
    return _bar_charts(title, text, rows, 100.0, _pct)


def _chart_questions(result: ResultOut) -> list[Block]:
    title = "Marks by question"
    questions = sorted(result.question_evaluations, key=lambda q: q.question)
    if not questions:
        return [_chart(title, "No question-level marks were recorded for this result.")]
    rows = [(f"Q{q.question} {q.topic}", [(0.0, q.max_marks, CONTEXT), (0.0, q.estimated_marks, CYAN)],
             f"{_n(q.estimated_marks)} / {_n(q.max_marks)}", None) for q in questions]
    full = sum(q.estimated_marks >= q.max_marks for q in questions)
    most = max(q.max_marks - q.estimated_marks for q in questions)
    worst = [q for q in questions if q.max_marks - q.estimated_marks == most]
    lost = (f"; most marks lost on Q{worst[0].question} ({_n(worst[0].estimated_marks)} / {_n(worst[0].max_marks)}, "
            f"{worst[0].topic})." if len(worst) == 1 else
            f"; the largest loss on one question is {_n(most)} mark{'' if most == 1 else 's'}, on {len(worst)} questions.")
    text = f"Full marks on {full} of {len(questions)} questions" + (
        lost if full < len(questions) else ".") + " Grey = marks available."
    return _bar_charts(title, text, rows, max(q.max_marks for q in questions), _n)


def _chart_quadrant(result: ResultOut) -> list[Block]:
    """Mastery against the expected gain (return), split where the plan splits it (70% mastery, half
    the top return), so every marker sits in the quadrant the plan gave it (t.quadrant)."""
    placeholder = result.roi_basis.effort_source_kind == "placeholder"
    y_name = "Expected gain (marks)" if placeholder else "Return per study hour"
    title = f"Where to focus - mastery vs {'expected gain' if placeholder else 'return per hour'}"
    topics = result.study_plan.topics
    if not topics:
        return [_chart(title, "No topic plan is available for this result, so there is nothing to place.")]
    top = max((t.roi for t in topics), default=0.0)
    split = HIGH_ROI_SHARE * top
    names = {"priority_focus": "priority focus", "maintain": "maintain", "deprioritise": "deprioritise",
             "no_action": "no action"}
    groups: dict[str, list[str]] = {}
    for t in topics:
        groups.setdefault(names.get(t.quadrant, "no action"), []).append(t.topic)
    text = "; ".join(f"{k}: {', '.join(v)}" for k, v in groups.items()) + "."
    text = text[0].upper() + text[1:]
    text += (f" Split at {_n(WEAK_MASTERY)}% mastery and half the top {'gain' if placeholder else 'return'} "
             f"({_n(split)}).")

    def draw(page: pymupdf.Page, box: pymupdf.Rect) -> None:
        plot = pymupdf.Rect(box.x0 + 36, box.y0 + 16, box.x1 - 10, box.y1 - 24)
        y_ticks = _ticks(max(top, 1.0))
        sx, sy = _scale(plot.x0, plot.x1, 100.0), _scale(plot.y1, plot.y0, y_ticks[-1])
        _grid(page, plot, _ticks(100), sx, _pct)
        _grid(page, plot, y_ticks, sy, _n, vertical=False)
        _text(page, box.x0, plot.y0 - 9, y_name, 6.5, SLATE_MUTED)
        _text(page, plot.x1, plot.y1 + 19, "Mastery %", 6.5, SLATE_MUTED, 1.0)
        split_x, split_y = sx(WEAK_MASTERY), sy(split)
        _line(page, (split_x, plot.y0), (split_x, plot.y1), SLATE_MUTED, 0.7, "[3 2] 0")
        _line(page, (plot.x0, split_y), (plot.x1, split_y), SLATE_MUTED, 0.7, "[3 2] 0")
        # Everything a point label must not cover: quadrant names, split lines, markers.
        taken = [_text(page, x, y, label, 7, SLATE_MUTED, align)
                 for x, y, label, align in ((plot.x0 + 4, plot.y0 + 9, "priority focus", 0.0),
                                            (plot.x1 - 4, plot.y0 + 9, "maintain", 1.0),
                                            (plot.x0 + 4, plot.y1 - 4, "deprioritise", 0.0),
                                            (plot.x1 - 4, plot.y1 - 4, "no action", 1.0))]
        taken += [pymupdf.Rect(split_x - 1, plot.y0, split_x + 1, plot.y1),
                  pymupdf.Rect(plot.x0, split_y - 1, plot.x1, split_y + 1)]
        markers: dict[str, pymupdf.Rect] = {}
        for t in topics:
            x, y, r = sx(t.mastery), sy(max(0.0, t.roi)), 4.0
            page.draw_circle((x, y), r, color=(1, 1, 1), fill=_hex(MEASURE), width=0.6, fill_opacity=0.85)
            markers[t.topic] = pymupdf.Rect(x - r, y - r, x + r, y + r)
        taken += markers.values()
        for t in result.study_plan.focus[:5] or sorted(topics, key=lambda t: -t.roi)[:5]:  # the next five
            label = _clip(t.topic, 6.5, 120)
            width = pymupdf.get_text_length(label, fontname="helv", fontsize=6.5)
            m = markers[t.topic]
            spots = [pymupdf.Rect(x, (m.y0 + m.y1) / 2 + dy - 3, x + width, (m.y0 + m.y1) / 2 + dy + 4)
                     for dy in (0, -8, 8) for x in (m.x1 + 3, m.x0 - 3 - width)]
            spot = next((s for s in spots if plot.contains(s) and not any(s.intersects(o) for o in taken)), None)
            if spot is not None:
                taken.append(_text(page, spot.x0, spot.y1 - 1.7, label, 6.5))

    return [_chart(title, text, 230, draw)]


def projected_steps(result: ResultOut) -> list[tuple[str, float]]:
    """(topic, marks) steps of the projected score on THIS paper: the window's share of each focus
    topic's gap to its target, from the unrounded score / max (Physics 0.85 x 180 - 64 = 89). The
    steps add up exactly: total_score + sum = projected_score.expected x total_marks / 100."""
    plan = result.study_plan
    own = {t.topic: (float(t.score), float(t.max_marks)) for t in result.topic_mastery}
    steps = []
    for t in plan.focus[:5]:
        score, max_marks = own.get(t.topic, (0.0, 0.0))
        share = min(1.0, t.allocated_hours / t.effort_hours) if t.effort_hours > 0 else 0.0
        gap = max(0.0, float(t.target_mastery) / 100.0 * max_marks - score) if max_marks > 0 else 0.0
        if gap * share > 1e-9:
            steps.append((t.topic, gap * share))
    return steps


def _chart_gain(result: ResultOut) -> list[Block]:
    """The projected score as steps in marks (402 -> +89 -> +81 -> +40 -> 612 of 720, 85.0%), so the
    steps, the end and the percentages always agree."""
    title = "Projected gain (illustrative)"
    total = float(result.total_marks)
    steps = projected_steps(result)
    if not steps or total <= 0:
        return [_chart(title, "No projected gain: no focus topic is below target.")]
    start = float(result.total_score)
    rows: list[Bar] = [("Current score", [(0.0, start, CONTEXT)], _marks(start), None)]
    level = start
    for topic, gain in steps:
        rows.append((f"+ {topic}", [(level, min(total, level + gain), GAIN)], f"+{_marks(round(gain, 2))}", None))
        level += gain
    rows.append(("Projected score", [(0.0, level, MEASURE)], f"{_marks(round(level, 2))} ({_pct_of(level, total)})",
                 None))
    topic, gain = max(steps, key=lambda s: s[1])
    top = "the top topic" if len(steps) == 1 else f"the top {len(steps)} topics"
    ps = result.study_plan.projected_score
    text = (f"Working {top} to target could take this paper from {_marks(start)} to {_marks(round(level, 2))}/"
            f"{_marks(total)} ({_pct_of(start, total)} to {_pct_of(level, total)}; range {_pct(ps.low)}-"
            f"{_pct(ps.high)}); the biggest step is {topic} (+{_marks(round(gain, 2))} marks). Not a calibrated "
            "forecast.")
    return _bar_charts(title, text, rows, total, _marks)


# --------------------------------------------------------------------------- #
# Report redesign: page 1 mirrors the web report's summary (score, insights, subjects, focus)
# --------------------------------------------------------------------------- #
def _mcq_paper(result: ResultOut) -> bool:
    questions = result.question_evaluations
    return bool(questions) and all(q.question_type == "mcq" for q in questions)


def _right_marks(result: ResultOut) -> float | None:
    """The usual marks of one right answer (modal max_marks of the non-bonus MCQs)."""
    counts: dict[float, int] = {}
    for q in result.question_evaluations:
        if q.question_type == "mcq" and q.result_kind != "bonus" and q.max_marks > 0:
            counts[q.max_marks] = counts.get(q.max_marks, 0) + 1
    return max(counts, key=lambda v: (counts[v], v)) if counts else None


def _plain_notice(result: ResultOut) -> str:
    release = result.release
    if release.status == "RELEASED":
        when = f" on {fmt_ist(release.reviewed_at)[:10]}" if release.reviewed_at else ""
        return f"Reviewed by {release.reviewed_by or 'your teacher'}{when}."
    drafted = (" and the answer key was drafted from the paper" if result.scoring_controls.rubric_status != "FACULTY_APPROVED"
               else "")
    return f"Provisional result — your teacher has not reviewed these marks yet{drafted}, so marks may change."


def _student_header(result: ResultOut, superseded_by: str | None) -> list[Block]:
    """Name, batch / test / date / days to the exam, the band and the plain-language notice. Run
    ids, rubric hashes and the OCR adapter live on the last page ('Processing, coverage and sign-off')."""
    meta = result.report_meta
    batch = meta.batch
    date = _day_text(meta.executed_at)
    parts = [batch.name, batch.exam_type, date]
    if batch.days_to_exam is not None:
        parts.append(f"{batch.days_to_exam} days to {batch.exam or 'NEET'}")
    demo = ' <span class="muted">(synthetic demo record)</span>' if meta.is_demo else ""
    html_parts = [
        f'<p class="kicker">{_e(KICKER_BRAND)} / {_e(batch.exam or "NEET")} / STUDENT REPORT</p>',
        "<h1>Student Academic Intelligence Report</h1>",
        f'<p class="lead"><b>{_e(student_name(result) or "Student (name not set)")}</b>{demo} · '
        f'{_e(" · ".join(p for p in parts if p))}</p>',
    ]
    blocks: list[Block] = [Html("".join(html_parts), gap=0)]
    if superseded_by:
        blocks.append(Html(
            f'<div class="banner old">SUPERSEDED - this archived evaluation was replaced by {_e(superseded_by)}. '
            "Kept for audit only; use the current report.</div>"
        ))
    css = "banner ok" if result.release.status == "RELEASED" else "notice"
    blocks.append(Html(f'<div class="{css}">{_e(_plain_notice(result))}</div>'))
    if meta.is_demo:
        blocks.append(Html('<div class="banner demo">DEMO DATA - a synthetic record; names, answers and marks are '
                           "fictional.</div>"))
    if result.student_summary:
        blocks.append(Html('<p class="label">In short</p>'
                           + "".join(f'<p class="para">{_e(line)}</p>' for line in result.student_summary),
                           gap=PAGE1_GAP))
    return blocks


def _norm_name(text: str) -> str:
    return " ".join(re.sub(r"[_\s]+", " ", text).split()).casefold()


def student_name(result: ResultOut) -> str | None:
    """The student's name, or None while it is only the uploaded file's name ('2016 Editable (1)' for
    '2016_Editable (1).pdf') - a file name is never shown as a student's name."""
    sub = result.submission
    name = (sub.student_name or "").strip()
    stem = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", (sub.original_filename or "").strip())
    if not name or (stem and _norm_name(name) == _norm_name(stem)):
        return None
    return name


def _day_text(value: Any, weekday: bool = False) -> str:
    """'27 Nov 2026' (or 'Fri, 27 Nov 2026') from a datetime or an ISO date, the web report's format."""
    if value is None or value == "":
        return ""
    try:
        if isinstance(value, datetime):
            day = to_ist(value).date()
        else:
            day = datetime.fromisoformat(str(value)[:10]).date()
    except (TypeError, ValueError):
        return str(value)
    return (f"{day:%a}, " if weekday else "") + f"{day.day} {day:%b %Y}"


def _gap_line(result: ResultOut) -> str:
    band = result.score_band
    if band is None:
        return ""
    if band.marks_to_target <= 0:
        return f"At or above {'your target' if band.target_source == 'batch_target' else 'the On track line'} " \
               f"({_marks(band.target_marks)} marks)."
    to = "your target" if band.target_source == "batch_target" else "On track"
    line = f"{_marks(band.marks_to_target)} marks to {to}"
    per = _right_marks(result)
    if per and band.right_answers_to_target:
        line += f" — about {band.right_answers_to_target} more right answers (+{_marks(per)} each)"
    return line + "."


def _draw_bullet(result: ResultOut, page: pymupdf.Page, box: pymupdf.Rect) -> None:
    """Bullet chart: grey qualitative bands (At risk / Needs attention / On track), a navy measure
    bar a third of the band height with its value, an amber target marker, the batch median when
    known, and an axis in marks."""
    band = result.score_band
    total = float(result.total_marks) or 1.0
    plot = pymupdf.Rect(box.x0 + 2, box.y0 + 12, box.x1 - 24, box.y0 + 36)
    sx = _scale(plot.x0, plot.x1, total)
    for rng, grey in zip(band.thresholds, BAND_GREYS):
        rect = pymupdf.Rect(sx(rng.from_marks), plot.y0, sx(rng.to_marks), plot.y1)
        page.draw_rect(rect, color=None, fill=_hex(grey))
        _text(page, (rect.x0 + rect.x1) / 2, plot.y0 - 3.5, rng.label, 6.8, SLATE, 0.5, rect.width - 4)
    score = max(0.0, float(result.total_score))
    third = plot.height / 3
    page.draw_rect(pymupdf.Rect(sx(0), plot.y0 + third, sx(score), plot.y1 - third), color=None, fill=_hex(MEASURE))
    _text(page, sx(score) + 3, plot.y0 + third * 1.5 + 2.6, _marks(result.total_score), 7.5, MEASURE)
    target = band.target_marks
    _line(page, (sx(target), plot.y0 - 2), (sx(target), plot.y1 + 2), AMBER_MARK, 3.0)
    _text(page, sx(target), plot.y1 + 10, f"Target {_marks(target)} ({_n(band.target_pct)}%)", 6.8, AMBER_TEXT,
          0.5)
    if band.batch_median_marks is not None:
        median_x = sx(band.batch_median_marks)
        _line(page, (median_x, plot.y0), (median_x, plot.y1), SLATE, 1.0, "[2 1] 0")
        _text(page, median_x, plot.y1 + 19, f"Batch median {_marks(band.batch_median_marks)}", 6.5, SLATE, 0.5)
    ticks = sorted({0.0, *(r.to_marks for r in band.thresholds)} - {round(target, 2)})
    for tick in ticks:  # the target's own value is in its label
        _text(page, sx(tick), plot.y1 + 9, _marks(tick), 6.3, SLATE_MUTED, 0.5)


def _section_score(result: ResultOut, num: str) -> list[Block]:
    band = result.score_band
    label = URGENCY_LABELS.get(result.urgency, result.urgency)
    head = (
        _h2(num, "Your score")
        + f'<p><span class="hero">{_marks(result.total_score)} / {_marks(result.total_marks)}</span> &#160; '
        f'<span class="heropct">{_pct_of(result.total_score, result.total_marks)}</span> &#160; '
        f'<span class="chip" style="color:{URGENCY_COLORS.get(result.urgency, INK)}">{_e(label)}</span></p>'
    )
    if band is None or not band.thresholds:
        return [Html(head, gap=SECTION_GAP)]
    bands = " · ".join(f"{r.label} {_marks(r.from_marks)}-{_marks(r.to_marks)}" for r in band.thresholds)
    caption = (f'<p class="cap">Chart data: score {_marks(result.total_score)} of {_marks(result.total_marks)} '
               f"· {_e(bands)} · target {_marks(band.target_marks)} ({_n(band.target_pct)}%)"
               + (f" · batch median {_marks(band.batch_median_marks)}" if band.batch_median_marks is not None
                  else "") + ".</p>")
    height = 56.0 if band.batch_median_marks is not None else 48.0
    blocks: list[Block] = [Chart(head + f'<div style="height:{height:.0f}pt"></div>', gap=PAGE1_GAP,
                                 height=height, draw=partial(_draw_bullet, result))]
    gap = _gap_line(result)
    blocks.append(Html((f'<p><b>{_e(gap)}</b></p>' if gap else "") + caption, gap=4))
    return blocks


def shown_insights(result: ResultOut) -> list[Any]:
    """The key insights the summary shows next to 'In short': its lines already give the weakest subject
    and the next step, so only the insights they do not cover (the attempts one) stay - as on the web."""
    covered = {"subjects", "gain"} if len(result.student_summary) >= 3 else set()
    return [i for i in result.key_insights if i.id not in covered]


def _section_insights(result: ResultOut, num: str) -> list[Block]:
    insights = shown_insights(result)
    if not insights:
        return []
    title = "Key insight" if len(insights) == 1 else "Key insights"
    rows = [[f'<span class="insight">{_e(i.headline)}</span><br/>{_e(i.detail)}'] for i in insights]
    return [Table(columns=[(title, 1.0)], rows=rows, head=_h2(num, title), gap=PAGE1_GAP,
                  zebra=False, header=False)]


def _section_subjects(result: ResultOut, num: str) -> list[Block]:
    subjects = result.subject_rollup
    if not subjects:
        return []
    if _mcq_paper(result):
        columns = [("Subject", 0.14), ("Right", 0.07), ("Wrong", 0.1), ("Blank", 0.07), ("Bonus", 0.07),
                   ("Answered", 0.19), ("Right when answered", 0.17), ("Marks", 0.19)]
        rows = []
        for s in subjects:
            scorable = s.questions - s.bonus
            rows.append([
                f"<b>{_e(s.subject)}</b>", _n(s.right),
                _n(s.wrong) + (f' <span class="muted">({_marks(-s.penalty)})</span>' if s.penalty else ""),
                _n(s.blank_scorable), _n(s.bonus),
                f"{s.attempted} of {scorable} ({_pct_of(s.attempted, scorable)})",
                f"{_pct_of(s.right, s.attempted)} ({s.right}/{s.attempted})" if s.attempted else "-",
                f"{_marks(s.score)}/{_marks(s.max_marks)} ({_pct_of(s.score, s.max_marks)})",
            ])
        c = result.outcome_counts
        if len(subjects) > 1:
            scorable = c.total_questions - c.bonus
            rows.append([
                "<b>Total</b>", _n(c.right), _n(c.wrong), _n(sum(s.blank_scorable for s in subjects)), _n(c.bonus),
                f"{c.attempted} of {scorable} ({_pct_of(c.attempted, scorable)})",
                f"{_pct_of(c.right, c.attempted)} ({c.right}/{c.attempted})" if c.attempted else "-",
                f"<b>{_marks(result.total_score)}/{_marks(result.total_marks)} "
                f"({_pct_of(result.total_score, result.total_marks)})</b>",
            ])
        foot = ('<p class="cap">Right / wrong / blank exclude bonus questions (full marks to everyone). Right when '
                "answered = right ÷ answered.</p>")
    else:
        columns = [("Subject", 0.24), ("Full", 0.1), ("Partial", 0.1), ("Zero", 0.1), ("Blank", 0.1),
                   ("Marks", 0.36)]
        rows = [[f"<b>{_e(s.subject)}</b>", _n(s.full), _n(s.partial), _n(s.zero), _n(s.blank),
                 f"{_marks(s.score)}/{_marks(s.max_marks)} ({_pct_of(s.score, s.max_marks)})"] for s in subjects]
        foot = ""
    return [Table(columns=columns, rows=rows, head=_h2(num, "Subjects"), foot=foot, gap=PAGE1_GAP)]



def _section_focus(result: ResultOut, num: str) -> list[Block]:
    focus = result.focus_topics
    head = _h2(num, "Where to focus")
    target = _n(focus.target_pct if focus is not None else TARGET_MASTERY)
    if focus is None or not focus.rows:
        return [Html(head + f'<p class="muted">Nothing below {target}% on this paper.</p>', gap=PAGE1_GAP)]
    noun = "Chapter" if focus.level == "chapter" else "Subject"
    rows = []
    for rank, r in enumerate(focus.rows, start=1):
        where = f"<b>{_e(r.topic)}</b>" + (f'<br/><span class="muted">{_e(r.subject)}</span>'
                                          if focus.level == "chapter" else "")
        if r.low_evidence:
            where += f'<br/><span class="muted small">based on {marking.plural(r.n, "question")}</span>'
        rows.append([
            _e(f"{rank}"), where,
            f"{_marks(r.score)}/{_marks(r.max_marks)} ({_pct(r.mastery)})",
            _e(f"{r.wrong} wrong · {r.blank} blank"),
            # The sentence starts with its verb ('Learn the Physics basics ...'): no separate label.
            _e(r.what_to_study),
            f"<b>+{_marks(r.gain)}</b>",
        ])
    share = _n(float(focus.target_pct) / 100.0, 4)
    foot = (f'<p class="cap">Marks to {target}% = what reaching {target}% adds on this paper: max(0, {share} × '
            "max − score).</p>")
    if focus.keep_warm:
        warm = ", ".join(f"{w.topic} ({_pct(w.mastery)})" for w in focus.keep_warm)
        more = f" and {focus.keep_warm_more} more" if focus.keep_warm_more else ""
        foot += (f'<p class="cap">Already at {target}% or above, keep warm with a short weekly mixed set: '
                 f"{_e(warm)}{more}.</p>")
    if not focus.chapters_available and focus.reason:
        foot += f'<p class="cap">{_e(focus.reason)}</p>'
    return [Table(columns=[("#", 0.04), (noun, 0.14), ("Score", 0.14), ("Lost", 0.15), ("What to study", 0.43),
                           (f"To {target}%", 0.1)],
                  rows=rows, head=head, foot=foot, gap=PAGE1_GAP)]


def _draw_question_grid(result: ResultOut, groups: list[tuple[str, list[Any]]], per_row: int,
                        page: pymupdf.Page, box: pymupdf.Rect) -> None:
    """One row band per subject, numbered cells. Right: navy fill; wrong: red with a diagonal hatch;
    blank: hollow outline; bonus: light blue with a star; hard to read: dashed outline."""
    label_w = 62.0
    cell = (box.width - label_w) / per_row
    y = box.y0
    for name, items in groups:
        _text(page, box.x0, y + cell * 0.62, name, 7.2, SLATE, 0.0, label_w - 6)
        for index, q in enumerate(items):
            row, col = divmod(index, per_row)
            x0 = box.x0 + label_w + col * cell
            y0 = y + row * cell
            rect = pymupdf.Rect(x0 + 1, y0 + 1, x0 + cell - 1, y0 + cell - 1)
            kind = q.result_kind
            number = str(q.question)
            hard = q.student_answer.strip() and q.confidence < 0.7 and kind != "blank"
            dashes = "[1.5 1] 0" if hard else None
            if kind == "right":
                page.draw_rect(rect, color=_hex(MEASURE) if not hard else (1, 1, 1), fill=_hex(MEASURE),
                               width=0.8, dashes=dashes)
                ink = "#ffffff"
            elif kind == "wrong":
                page.draw_rect(rect, color=None, fill=_hex(WRONG))
                for step in range(-int(rect.height), int(rect.width), 4):
                    a = pymupdf.Point(max(rect.x0, rect.x0 + step), rect.y1 - max(0, -step))
                    b = pymupdf.Point(min(rect.x1, rect.x0 + step + rect.height),
                                      rect.y1 - min(rect.height, rect.width - step))
                    page.draw_line(a, b, color=(1, 1, 1), width=0.5, stroke_opacity=0.45)
                if hard:
                    page.draw_rect(rect, color=_hex(INK), fill=None, width=0.8, dashes=dashes)
                ink = "#ffffff"
            elif kind == "bonus":
                page.draw_rect(rect, color=_hex(MEASURE_LIGHT), fill=_hex(BONUS_FILL), width=0.6)
                number += "*"
                ink = MEASURE
            else:  # blank (and partial / zero on mixed papers)
                page.draw_rect(rect, color=_hex(BLANK_EDGE), fill=None, width=0.7)
                ink = SLATE_MUTED
            _text(page, (rect.x0 + rect.x1) / 2, rect.y1 - cell * 0.32, number, min(6.2, cell * 0.33), ink, 0.5)
        y += math.ceil(len(items) / per_row) * cell + 4


def _chart_question_grid(result: ResultOut, num: str) -> list[Block]:
    head = _h2(num, "Questions")
    questions = sorted(result.question_evaluations, key=lambda q: q.question)
    if not questions:
        return [Html(head + '<p class="muted">No question-level marks were recorded for this result.</p>')]
    subject_of = {t.topic: t.subject for t in result.topic_mastery}
    groups: dict[str, list[Any]] = {}
    for q in questions:
        groups.setdefault(subject_of.get(q.topic, "Questions"), []).append(q)
    per_row = 20
    label_w = 62.0
    cell = (CONTENT_WIDTH - label_w) / per_row
    height = sum(math.ceil(len(items) / per_row) * cell + 4 for items in groups.values())
    c = result.outcome_counts
    hard = [q.question for q in questions
            if q.student_answer.strip() and q.confidence < 0.7 and q.result_kind not in ("blank", "bonus")]
    text = (f"All {len(questions)} · Right {c.right} · Wrong {c.wrong} · "
            f"Blank {sum(1 for q in questions if q.result_kind == 'blank')} · Bonus {c.bonus}. "
            "Navy = right, red with stripes = wrong, outline = blank, * = bonus, dashed edge = hard to read.")
    blocks: list[Block] = [Chart(
        head + f'<p class="small" style="color:{SLATE}">{_e(text)}</p><div style="height:{height:.1f}pt"></div>',
        gap=SECTION_GAP, height=height, draw=partial(_draw_question_grid, result, list(groups.items()), per_row),
    )]
    if hard:
        blocks.append(Html(f'<p class="cap">{len(hard)} answer{"s were" if len(hard) != 1 else " was"} hard to read '
                           f"and may change after teacher review ({_e(_qs(hard))}).</p>", gap=4))
    return blocks


def _section_technique(result: ResultOut, num: str) -> list[Block]:
    """Exam technique: attempts and negative marking per subject, the score reconciliation, pacing
    within each subject, and the Bloom profile only when it says something."""
    patterns_ = result.patterns
    neg = patterns_.negative_marking
    fatigue = patterns_.fatigue
    head = _h2(num, "Exam technique: attempts and negative marking")
    blocks: list[Block] = []
    if neg is not None and result.subject_rollup:
        per = _right_marks(result)
        rows = [[f"<b>{_e(s.subject)}</b>", f"{s.attempted} of {s.questions - s.bonus}", _n(s.right), _n(s.wrong),
                 _n(s.blank_scorable), f"{_pct_of(s.right, s.attempted)}" if s.attempted else "-",
                 _marks(-s.penalty) if s.penalty else "0"] for s in result.subject_rollup]
        rec = neg.reconciliation
        notes = []
        if rec is not None:
            line = (f"{neg.correct} right × {_marks(per)}" if per else f"{neg.correct} right")
            line += f" − {_marks(neg.marks_lost)} = {_marks(rec.net_answered)}"
            if rec.bonus_marks:
                line += f", + {_marks(rec.bonus_marks)} bonus"
            other = rec.total - rec.net_answered - rec.bonus_marks
            if abs(other) > 1e-9:
                line += f", + {_marks(other)} other questions"
            notes.append(f"How the score adds up: {line} = {_marks(rec.total)}.")
        scheme = re.sub(r"(?<!\w)-(\d)", "−\\1", neg.scheme)
        notes.append(f"Attempt rule ({scheme}): an answer is worth it once you can rule out one option "
                     f"(break-even {neg.break_even:.0%} sure).")
        blocks.append(Table(
            columns=[("Subject", 0.2), ("Answered", 0.15), ("Right", 0.1), ("Wrong", 0.1), ("Blank", 0.1),
                     ("Right when answered", 0.18), ("Lost to wrong answers", 0.17)],
            rows=rows, head=head, foot="".join(f'<p class="cap">{_e(n)}</p>' for n in notes), gap=SECTION_GAP,
        ))
    if fatigue is not None and fatigue.within_subject:
        rows = []
        for p in fatigue.within_subject:
            first = (f"Q{p.first_from}-Q{p.first_to}: {_pct(p.first_accuracy * 100)} ({p.first_right}/"
                     f"{p.first_attempted})" if p.first_accuracy is not None else f"Q{p.first_from}-Q{p.first_to}: -")
            second = (f"Q{p.second_from}-Q{p.second_to}: {_pct(p.second_accuracy * 100)} ({p.second_right}/"
                      f"{p.second_attempted})" if p.second_accuracy is not None
                      else f"Q{p.second_from}-Q{p.second_to}: -")
            change = "-" if p.change_pts is None else (
                f"+{p.change_pts:.1f} pts" if p.change_pts > 0 else
                (f"−{-p.change_pts:.1f} pts" if p.change_pts < 0 else "no change"))
            rows.append([f"<b>{_e(p.subject)}</b>", _e(first), _e(second), _e(change)])
        lead = "" if blocks else head
        blocks.append(Table(
            columns=[("Subject", 0.2), ("First half (answered only)", 0.31), ("Second half (answered only)", 0.31),
                     ("Change", 0.18)],
            rows=rows, head=lead + '<p class="label">Pacing within each subject</p>',
            foot=f'<p class="cap">{_e((fatigue.reasons[0] + ".") if fatigue.reasons else "")}</p>',
        ))
    if patterns_.bloom_informative and patterns_.bloom_profile:
        blocks.append(Table(
            columns=[("Bloom level", 0.3), ("Questions", 0.2), ("Marks (net)", 0.25), ("Share", 0.25)],
            rows=[[_e(b.level), _n(b.questions), f"{_marks(b.marks)}/{_marks(b.max_marks)}",
                   _pct_of(max(0.0, b.marks), b.max_marks)] for b in patterns_.bloom_profile],
            head='<p class="label">Marks by thinking level</p>',
        ))
    return blocks


def _section_chapters(result: ResultOut, num: str) -> list[Block]:
    """Every chapter or topic, weakest first - only when the paper has a chapter breakdown."""
    focus = result.focus_topics
    if focus is None or not focus.chapters_available:
        return []
    return [*_section_topics(result, num=num, title="All chapters and topics"), *_chart_topics(result)]


def _duration(minutes: Any) -> str:
    """345 -> '5 h 45 min'."""
    try:
        total = int(round(float(minutes)))
    except (TypeError, ValueError):
        return "-"
    hours, rest = divmod(max(0, total), 60)
    return f"{rest} min" if not hours else f"{hours} h" + (f" {rest} min" if rest else "")


def _section_teaching(result: ResultOut, num: str) -> list[Block]:
    """For faculty: the teaching nudges, the action plan (its question list appears once, in the
    trigger-questions column), confusions when there are any, and the faculty narrative."""
    head = (_h2(num, "Teaching actions (for faculty)")
            + '<p class="small muted">Provisional prompts for the teacher, built from the graded evidence.</p>')
    blocks: list[Block] = []
    blocks += _section_nudges(result, head=head + '<p class="label">Teaching nudges</p>')
    blocks += _section_actions(result, head='<p class="label">Teacher action plan</p>')
    if result.confusions:
        blocks.append(Table(
            columns=[("Confused concepts", 0.36), ("Question", 0.12), ("Evidence", 0.52)],
            rows=[[f"<b>{_e(c.concept_a)}</b> vs <b>{_e(c.concept_b)}</b>",
                   _e(f"Q{c.question}") if c.question else "-", _e(c.evidence or "-")] for c in result.confusions],
            head='<p class="label">Concept confusions observed</p>',
        ))
    if result.summary or result.executive_summary:
        texts = ([result.summary] if result.summary else []) + list(result.executive_summary)
        blocks.append(Html('<p class="label">Faculty summary</p>'
                           + "".join(f'<p class="para small">{_e(t)}</p>' for t in texts), gap=BLOCK_GAP))
    return blocks


def _section_processing(result: ResultOut, superseded_by: str | None, num: str) -> list[Block]:
    """Last page: run metadata (run id, OCR adapter, rubric hash), coverage, cost and sign-off."""
    basis = result.roi_basis
    plan_line = (f'<p class="cap">Study plan: forecast status {_e(basis.forecast_status)} ({_e(basis.reason)}); '
                 f"calculation {_e(basis.calculation_version)}, weightage matrix {_e(basis.matrix_version)}.</p>")
    return [PageBreak(), Html(_h2(num, "Processing, coverage and sign-off"), gap=0),
            *_student_meta(result, superseded_by), *_section_coverage(result, heading=False),
            Html(plan_line, gap=BLOCK_GAP)]


def render_student_pdf(result: ResultOut, *, superseded_by: str | None = None) -> bytes:
    """The branded multi-page Student Academic Intelligence Report for one completed result. Page 1
    mirrors the web report's summary: header and notice, score + band + bullet chart, the three key
    insights, the subject table and the top focus rows. Then the question grid, chapters (when the
    paper has them), the illustrative study plan, exam technique, the faculty's teaching actions and
    Appendix A; the last page carries the processing metadata, coverage and sign-off."""
    counter = iter(range(1, 100))

    def num() -> str:
        return f"{next(counter):02d}"

    blocks: list[Block] = [*_student_header(result, superseded_by)]
    blocks += _section_score(result, num())
    if shown_insights(result):
        blocks += _section_insights(result, num())
    blocks += _section_subjects(result, num()) if result.subject_rollup else []
    blocks += _section_focus(result, num())
    if len(result.history) >= 2:  # a trend needs two tests; no empty card otherwise
        blocks += _chart_trend(result)
    if _mcq_paper(result):
        blocks += _chart_question_grid(result, num())
    else:
        blocks += [Html(_h2(num(), "Questions"), gap=SECTION_GAP), *_chart_questions(result)]
    if result.focus_topics is not None and result.focus_topics.chapters_available:
        blocks += _section_chapters(result, num())
    if any(d.blocks for d in result.study_plan.weekly_calendar):
        blocks += _section_week(result, num())
    technique = _section_technique(result, "")
    if technique:
        blocks += _section_technique(result, num())
    # For faculty: teaching actions, then the illustrative study-plan lab.
    blocks += _section_teaching(result, num())
    blocks += _section_roi(result, num=num())
    blocks += _chart_quadrant(result)
    blocks += _chart_gain(result)
    blocks += _section_roadmap(result, num=num())
    blocks += _section_appendix(result)
    blocks += _section_processing(result, superseded_by, num())
    meta = result.report_meta
    watermarks: list[tuple[str, str]] = []
    if superseded_by:
        watermarks.append((f"SUPERSEDED by {superseded_by}", MUTED))
    elif result.release.status != "RELEASED":
        watermarks.append(("PROVISIONAL", RED))
    if meta.is_demo:
        watermarks.append(("DEMO DATA", AMBER))
    return _stamp(
        _layout(blocks),
        kicker=f"{KICKER_BRAND}  /  {meta.batch.exam or 'NEET'}",
        institution=meta.institution.name,
        # No run id in the footer: it lives on the last page ('Processing, coverage and sign-off').
        footer_parts=["3iLens", meta.institution.name, _footer_status(result, superseded_by)],
        watermarks=watermarks,
        title=f"Student Academic Intelligence Report - {student_name(result) or 'Student'}",
        subject=f"{result.rubric.name} {result.rubric.version} - {meta.run_id}",
    )


# --------------------------------------------------------------------------- #
# Cohort report
# --------------------------------------------------------------------------- #
def denominator_line(cohort: CohortOut) -> str:
    """'N completed of M; k in review, f failed - excluded: names'."""
    line = (
        f"{cohort.completed} completed of {cohort.total_submissions}; {cohort.human_review} in review, "
        f"{cohort.failed} failed"
    )
    if cohort.processing:
        line += f", {cohort.processing} processing"
    names = [*cohort.excluded.review, *cohort.excluded.failed, *cohort.excluded.processing]
    line += f" - excluded: {', '.join(names)}" if names else " - excluded: none"
    return line


def _filters_text(cohort: CohortOut) -> str:
    f = cohort.filters
    parts = []
    if f.batch_id is not None:
        parts.append(f"batch {cohort.batch.name}")
    if f.rubric_id is not None:
        names = [f"{r.name} {r.version}" for r in cohort.rubric_versions if r.id == f.rubric_id]
        parts.append(f"test {names[0] if names else f.rubric_id}")
    if f.urgency:
        parts.append(f"urgency {URGENCY_LABELS.get(f.urgency, f.urgency)}")
    if f.topic:
        parts.append(f"topic {f.topic}")
    return ", ".join(parts) or "none (all batches and tests)"


def _cohort_title(cohort: CohortOut, generated: datetime) -> list[Block]:
    batch = cohort.batch
    head = (
        f'<p class="kicker">{_e(KICKER_BRAND)} / {_e(batch.exam or "NEET")} / COHORT REPORT</p>'
        "<h1>Cohort Academic Intelligence Report</h1>"
        f'<p class="lead">{_e(cohort.institution.name)} - class-level screening, ranking and interventions</p>'
    )
    tests = ", ".join(f"{r.name} {r.version} ({r.status})" for r in cohort.rubric_versions) or "-"
    if cohort.mixed_rubrics:
        tests += " - MIXED tests: compared by percentage"
    rows = [
        ("Institution", _e(cohort.institution.name)),
        ("Batch", _e(batch.name if cohort.filters.batch_id is not None else "All batches")),
        ("Filters", _e(_filters_text(cohort))),
        ("Tests in scope", _e(tests)),
        ("Target exam", _e(_exam_line(batch))),
        ("Generated at", _e(fmt_ist(generated))),
        ("Academic release", _e(f"{cohort.release_counts.released} released, {cohort.release_counts.provisional} "
                                "provisional (teacher review pending)")),
        ("Data", _e(f"{cohort.real_count} live, {cohort.demo_count} synthetic demo record(s)")),
    ]
    blocks: list[Block] = [
        Html(head, gap=0),
        Table(columns=[("Run metadata", 0.3), ("Value", 0.7)], rows=[[f"<b>{k}</b>", v] for k, v in rows], gap=10),
        Html(f'<div class="denom"><b>Denominator:</b> {_e(denominator_line(cohort))}</div>'),
    ]
    if cohort.is_demo:
        blocks.append(Html(
            f'<div class="banner demo">DEMO DATA - {cohort.demo_count} synthetic record(s) generated locally without '
            "any AI call are included. Names, answers and marks are fictional.</div>"
        ))
    if cohort.release_counts.provisional:
        blocks.append(Html(
            '<div class="banner">PROVISIONAL - AI-assisted marks; teacher review pending for '
            f"{cohort.release_counts.provisional} result(s). Not official exam scoring.</div>"
        ))
    return blocks


def _cohort_kpis(cohort: CohortOut) -> list[Block]:
    uc = cohort.urgency_counts
    ops = cohort.operations
    kpi = Table(
        columns=[("Completed", 0.16), ("Average score", 0.2), ("Average mastery", 0.18), ("Released", 0.16),
                 ("Cost per student", 0.3)],
        rows=[[
            f'<span class="big">{cohort.completed}</span>',
            f'<span class="big">{_frac(cohort.average_score, cohort.total_marks) if cohort.average_score is not None else "-"}</span>',
            f'<span class="big">{_pct(cohort.average_mastery)}</span>',
            f'<span class="big">{cohort.release_counts.released}/{cohort.completed}</span>',
            _e(f"{_rs(ops.avg_cost_per_student_inr)} (target {_rs(ops.target_inr)})"
               if ops.avg_cost_per_student_inr is not None else "No live model calls in scope"),
        ]],
        head=_h2("01", "Class summary"),
        gap=SECTION_GAP,
        zebra=False,
    )
    total = max(1, uc.on_track + uc.needs_attention + uc.at_risk)
    urgency = Table(
        columns=[("Urgency", 0.2), ("Students", 0.12), ("Share", 0.5), ("Rule", 0.18)],
        rows=[
            [_urgency(key), _e(count), _bar(count / total * 100, URGENCY_COLORS[key]), _e(rule)]
            for key, count, rule in (
                ("on_track", uc.on_track, ">= 70%"),
                ("needs_attention", uc.needs_attention, "55-70%"),
                ("at_risk", uc.at_risk, "< 55%"),
            )
        ],
        head='<p class="label">Urgency mix</p>',
        foot='<p class="cap">One level worse when 2+ topics are below 40%.</p>',
    )
    return [kpi, urgency]


def _cohort_ranking(cohort: CohortOut, cards: dict[int, StudentCard]) -> list[Block]:
    head = _h2("02", "Ranking")
    if not cohort.ranking:
        return [Html(head + '<p class="muted">No completed results in scope.</p>', gap=SECTION_GAP)]
    rows = []
    for r in cohort.ranking:
        card = cards.get(r.submission_id)
        focus = card.top_focus[0].topic if card and card.top_focus else "-"
        release = card.release_status if card and card.release_status else "-"
        rows.append([
            _e(r.rank), f"<b>{_e(r.student_name)}</b>", _e(r.student_ref), _frac(r.score, r.total_marks),
            _pct(r.pct), _urgency(r.urgency), _e(focus), _e(release),
        ])
    return [Table(
        columns=[("#", 0.05), ("Student", 0.21), ("Ref", 0.15), ("Score", 0.1), ("%", 0.08), ("Urgency", 0.14),
                 ("Top focus", 0.15), ("Release", 0.12)],
        rows=rows,
        head=head,
        foot='<p class="cap">Ranked by percentage (tests on different rubrics are compared by percentage).</p>',
        gap=SECTION_GAP,
    )]


def _cohort_topics(cohort: CohortOut, cards: Sequence[StudentCard]) -> list[Block]:
    blocks: list[Block] = []
    head = _h2("03", "Topic averages and score distribution")
    if cohort.topic_mastery:
        below: dict[str, int] = {}
        covered: dict[str, int] = {}
        for card in cards:
            for point in card.topic_mastery:
                covered[point.topic] = covered.get(point.topic, 0) + 1
                if point.mastery < 60:
                    below[point.topic] = below.get(point.topic, 0) + 1
        topics = sorted(cohort.topic_mastery, key=lambda t: (t.mastery, t.topic))
        blocks.append(Table(
            columns=[("Topic", 0.3), ("Class average", 0.36), ("Avg %", 0.12), ("Students below 60%", 0.22)],
            rows=[[
                f"<b>{_e(t.topic)}</b>", _bar(t.mastery), _pct(t.mastery),
                _e(f"{below.get(t.topic, 0)} of {covered[t.topic]}" if t.topic in covered else "-"),
            ] for t in topics],
            head=head,
            foot='<p class="cap">Averages include only the assessments that cover each topic.</p>',
            gap=SECTION_GAP,
        ))
    else:
        blocks.append(Html(head + '<p class="muted">No topic data in scope.</p>', gap=SECTION_GAP))
    peak = max([b.count for b in cohort.score_distribution] + [1])
    blocks.append(Table(
        columns=[("Score band", 0.2), ("Students", 0.6), ("Count", 0.2)],
        rows=[[_e(b.label), _bar(b.count / peak * 100, GOOD), _e(b.count)] for b in cohort.score_distribution],
        head='<p class="label">Score distribution</p>',
    ))
    if cohort.top_priorities:
        blocks.append(Table(
            columns=[("Topic", 0.22), ("Class mastery", 0.13), ("ROI (illustr.)", 0.13), ("Rationale", 0.52)],
            rows=[[f"<b>{_e(p.topic)}</b>", _pct(p.mastery), _e(f"{p.roi:.2f}"), _e(_first_sentence(p.rationale, 220))]
                  for p in cohort.top_priorities],
            head=f'<p class="label">Class preparation priorities</p><div class="illus">{_e(ILLUSTRATIVE_LABEL)}</div>',
        ))
    return blocks


def _cohort_errors(cohort: CohortOut) -> list[Block]:
    head = _h2("04", "Common errors")
    if not cohort.common_errors:
        return [Html(head + '<p class="muted">No error shared by two or more students in scope.</p>', gap=SECTION_GAP)]
    return [Table(
        columns=[("Q", 0.07), ("Topic", 0.17), ("Error", 0.4), ("Students", 0.12), ("Who", 0.24)],
        rows=[[
            _e(f"Q{c.question}"), _e(c.topic), _e(c.error), _e(f"{c.count}/{c.denominator}"),
            _e(", ".join(c.students[:6]) + (f" +{len(c.students) - 6}" if len(c.students) > 6 else "")),
        ] for c in cohort.common_errors],
        head=head,
        foot=('<p class="cap">count/denominator = students with the gap / students who answered that question.</p>'
              if cohort.scope is not None else
              '<p class="cap">count/denominator = students showing the error / completed students in scope.</p>'),
        gap=SECTION_GAP,
    )]


def _cohort_interventions(cohort: CohortOut) -> list[Block]:
    head = _h2("05", "Class interventions and confusion clusters")
    blocks: list[Block] = []
    if cohort.interventions:
        blocks.append(Table(
            columns=[("Topic", 0.18), ("Class action", 0.42), ("Students", 0.1), ("Rationale", 0.3)],
            rows=[[f"<b>{_e(i.topic)}</b>", _e(i.action), _e(i.students_count), _e(i.rationale)]
                  for i in cohort.interventions],
            head=head,
            gap=SECTION_GAP,
        ))
    else:
        blocks.append(Html(head + '<p class="muted">No class-level intervention suggested for this scope.</p>',
                           gap=SECTION_GAP))
    if cohort.confusion_clusters:
        blocks.append(Table(
            columns=[("Confused concepts", 0.42), ("Students", 0.12), ("Who", 0.46)],
            rows=[[f"<b>{_e(c.concept_a)}</b> vs <b>{_e(c.concept_b)}</b>",
                   _e(f"{c.count} of {c.denominator}" if c.denominator else c.count),
                   _e(", ".join(c.students[:8]))] for c in cohort.confusion_clusters],
            head='<p class="label">Confusion clusters</p>',
        ))
    return blocks


def _cohort_at_risk(cohort: CohortOut) -> list[Block]:
    head = _h2("06", "Students at risk")
    if not cohort.at_risk:
        return [Html(head + '<p class="muted">No student in scope is at risk.</p>', gap=SECTION_GAP)]
    return [Table(
        columns=[("Student", 0.2), ("%", 0.08), ("Why", 0.54), ("Top gap", 0.18)],
        rows=[[f"<b>{_e(a.student_name)}</b>", _pct(a.pct), _e(" ".join(a.reasons)), _e(a.top_gap or "-")]
              for a in cohort.at_risk],
        head=head,
        gap=SECTION_GAP,
    )]


def _cohort_operations(cohort: CohortOut) -> list[Block]:
    ops = cohort.operations
    rows = [
        ("Model calls", _e(f"{ops.calls} (OCR cache hits {ops.ocr_cache_hits})")),
        ("Total model cost", _e(_rs(ops.total_cost_inr))),
        ("Cost per completed live sheet (traced calls)", _e(
            f"{_rs(ops.avg_cost_per_student_inr)} vs target {_rs(ops.target_inr)}"
            if ops.avg_cost_per_student_inr is not None else
            f"n/a - no live sheets with traced calls in scope (target {_rs(ops.target_inr)})")),
        ("Latency per sheet", _e(
            "-" if ops.avg_latency_seconds is None else
            f"avg {_n(ops.avg_latency_seconds)} s, p95 {_n(ops.p95_latency_seconds)} s vs target "
            f"{_n(ops.target_latency_seconds)} s ({ops.over_latency_target} over)")),
        ("Dead-letter queue", _e(f"{ops.dlq_count} failed sheet(s)")),
        ("Mean OCR confidence", _e("-" if ops.mean_ocr_confidence is None else f"{ops.mean_ocr_confidence:.2f}")),
    ]
    limits = [
        "Marks are AI-assisted and provisional until faculty release each report.",
        "Preparation ROI and projected gains are illustrative - weightage and effort coefficients are not calibrated.",
        "Students in review, failed or still processing are excluded from every average and ranking above.",
    ]
    if cohort.mixed_rubrics:
        limits.append("Several tests are mixed in this scope; scores are compared by percentage, not raw marks.")
    if cohort.is_demo:
        limits.append("Synthetic demo records are included and must not be used for real decisions.")
    return [
        _kv(rows, head=_h2("07", "Operations and limitations"), labels=("Metric", "Value"), gap=SECTION_GAP),
        Html("<ul>" + "".join(f"<li>{_e(t)}</li>" for t in limits) + "</ul>"),
    ]


# --- The cohort page's PDF (per_student=true): the same figures as the page --------------- #
def _page_title(cohort: CohortOut, generated: datetime) -> list[Block]:
    scope = cohort.scope
    assert scope is not None
    head = (
        f'<p class="kicker">{_e(KICKER_BRAND)} / {_e(cohort.batch.exam or "NEET")} / COHORT REPORT</p>'
        "<h1>Cohort Academic Intelligence Report</h1>"
        f'<p class="lead">{_e(cohort.institution.name)} - one row per student (their latest sheet in scope)</p>'
    )
    if scope.mode == "sitting":
        test = scope.test_name or "-"
        if scope.date is not None:
            test += f", sat {fmt_ist(scope.date)}"
        versions = ", ".join(f"key {v.version}: {v.sheets} sheet(s)" for v in scope.key_versions)
        if versions:
            test += f" ({versions})"
    else:
        test = "Each student's latest test - tests differ, so students are compared by percentage"
    demo = scope.demo_sheets
    rows = [
        ("Institution", _e(cohort.institution.name)),
        ("Batch", _e(scope.batch_name or "All batches")),
        ("Test", _e(test)),
        ("Students", _e(f"{scope.students} (latest sheet each; {scope.sheets} graded sheet(s) in scope)")),
        ("Target exam", _e(_exam_line(cohort.batch)) if scope.batch_id is not None else "-"),
        ("Generated at", _e(fmt_ist(generated))),
        ("Academic release", _e(f"{cohort.release_counts.released} released, {cohort.release_counts.provisional} "
                                "provisional (teacher review pending)")),
        ("Data", _e(f"{scope.sheets_in_scope - demo} uploaded, {demo} synthetic demo sheet(s) in scope")),
    ]
    blocks: list[Block] = [
        Html(head, gap=0),
        Table(columns=[("Scope", 0.3), ("Value", 0.7)], rows=[[f"<b>{k}</b>", v] for k, v in rows], gap=10),
        Html(f'<div class="denom"><b>Not counted:</b> {_e(_page_excluded(cohort))}</div>'),
    ]
    if demo:
        blocks.append(Html(
            f'<div class="banner demo">DEMO DATA - {demo} of {scope.sheets_in_scope} sheet(s) in scope are synthetic, '
            "generated locally without any AI call. Names, answers and marks are fictional.</div>"
        ))
    if cohort.release_counts.provisional:
        blocks.append(Html(
            '<div class="banner">PROVISIONAL - AI-assisted marks; teacher review pending for '
            f"{cohort.release_counts.provisional} result(s). Not official exam scoring.</div>"
        ))
    return blocks


def _page_excluded(cohort: CohortOut) -> str:
    ex = cohort.excluded
    parts = []
    if ex.review:
        parts.append(f"held for review: {', '.join(ex.review)}")
    if ex.failed:
        parts.append(f"could not be read: {', '.join(ex.failed)}")
    if ex.processing:
        parts.append(f"still being read: {', '.join(ex.processing)}")
    return "; ".join(parts) or "every sheet in scope is counted"


def _signed(value: float) -> str:
    return f"+{value:.1f}" if value > 0 else (f"-{abs(value):.1f}" if value < 0 else "0.0")


def _page_kpis(cohort: CohortOut) -> list[Block]:
    scope, head, prev, attempt, paired = cohort.scope, cohort.headline, cohort.previous, cohort.attempt, cohort.paired_change
    assert scope is not None and head is not None
    n = scope.students
    uc = cohort.urgency_counts
    average = _pct(head.average_pct)
    detail = [f"median {_pct(head.median_pct)}"]
    if head.average_marks is not None and head.total_marks is not None:
        detail.insert(0, f"{_n(head.average_marks)}/{_n(head.total_marks)} avg marks")
    change = "-"
    if prev is not None:
        if prev.comparable and head.delta_pts is not None:
            change = f"{_signed(head.delta_pts)} pts vs {prev.short_name} ({_pct(prev.average_pct)})"
        elif paired is not None and paired.paired:
            change = (f"{_signed(paired.mean_change)} pts for the {paired.paired} who also sat {prev.short_name} "
                      f"(class averages not compared: {prev.note or 'different paper'})")
    at_risk = f"{uc.at_risk} of {n}"
    if prev is not None:
        at_risk += f" ({prev.short_name}: {prev.urgency_counts.at_risk} of {prev.students})"
    cells = [
        ("Class average", f'<span class="big">{_e(average)}</span><br>{_e(" · ".join(detail))}'),
        ("Change", _e(change)),
        ("At risk", f'<span class="big">{_e(uc.at_risk)}</span> of {_e(n)}'),
    ]
    if attempt is not None:
        qualifier = f" ({attempt.students} with MCQ papers)" if attempt.students < n else ""
        cells.append(("Negative marking", f'<span class="big">-{_e(_n(attempt.negative_marks_total))}</span>'
                      f"<br>{_e(_n(attempt.negative_per_student))} per student{_e(qualifier)}"))
        blank = attempt.blank_rate if attempt.blank_rate is not None else round(100 - attempt.attempt_rate, 1)
        cells.append(("Attempted", f'<span class="big">{_e(_pct(attempt.attempt_rate))}</span>'
                      f"<br>{_e(_pct(attempt.accuracy_attempted))} right when attempted · {_e(_pct(blank))} blank"))
    else:
        cells.append(("Top score", f'<span class="big">{_e(_pct(head.top_pct))}</span><br>{_e(head.top_student or "")}'))
    width = 1 / len(cells)
    kpi = Table(
        columns=[(label, width) for label, _ in cells],
        rows=[[value for _, value in cells]],
        head=_h2("01", "Class summary"),
        gap=SECTION_GAP,
        zebra=False,
    )
    notes = [f"At risk: {at_risk}. Released: {cohort.release_counts.released} of {n}."]
    if head.negative_scores:
        notes.append(f"{head.negative_scores} student(s) scored below 0 marks; their % is counted as 0.")
    reading = cohort.reading
    if reading is not None and reading.cost_per_live_sheet_inr is not None:
        notes.append(f"AI cost per uploaded sheet: {_rs(reading.cost_per_live_sheet_inr)} "
                     f"({reading.costed_sheets} sheet(s) with traced calls).")
    total = max(1, uc.on_track + uc.needs_attention + uc.at_risk)
    urgency = Table(
        columns=[("Urgency", 0.2), ("Students", 0.12), ("Share", 0.5), ("Rule", 0.18)],
        rows=[
            [_urgency(key), _e(count), _bar(count / total * 100, URGENCY_COLORS[key]), _e(rule)]
            for key, count, rule in (
                ("on_track", uc.on_track, ">= 70%"),
                ("needs_attention", uc.needs_attention, "55-70%"),
                ("at_risk", uc.at_risk, "< 55%"),
            )
        ],
        head='<p class="cap">' + _e(" ".join(notes)) + '</p><p class="label">Urgency mix</p>',
        foot='<p class="cap">One level worse when 2+ chapters are below 40%.</p>',
    )
    return [kpi, urgency]


def _page_ranking(cohort: CohortOut) -> list[Block]:
    head = _h2("02", "Ranking")
    rows = cohort.students_view
    if not rows:
        return [Html(head + '<p class="muted">No graded sheets in scope.</p>', gap=SECTION_GAP)]
    sitting = cohort.scope is not None and cohort.scope.mode == "sitting"
    prev = cohort.previous if sitting else None
    columns = [("#", 0.05), ("Student", 0.22), ("Score", 0.1), ("%", 0.08)]
    if prev is not None:
        columns.append((f"vs {prev.short_name}", 0.1))
    columns += [("Urgency", 0.14), ("Weakest chapter", 0.2 if prev is not None else 0.3), ("Release", 0.11)]
    out = []
    for r in rows:
        cells = [_e(r.rank), f"<b>{_e(r.student_name)}</b>", _frac(r.score, r.total_marks), _pct(r.pct)]
        if prev is not None:
            cells.append(_e("-" if r.change_pts is None else f"{_signed(r.change_pts)} pts"))
        cells += [_urgency(r.urgency), _e(r.weakest_topic or "-"),
                  _e("Released" if r.release_status == "RELEASED" else "Provisional")]
        out.append(cells)
    return [Table(
        columns=columns,
        rows=out,
        head=head,
        foot='<p class="cap">Ranked by percentage; equal percentages share a rank.'
             + ("" if sitting else " Tests differ, so students are compared by percentage.") + "</p>",
        gap=SECTION_GAP,
    )]


def _page_chapters(cohort: CohortOut) -> list[Block]:
    head = _h2("03", "Chapters and score distribution")
    blocks: list[Block] = []
    chapters = [c for c in cohort.chapters if not c.subject_level]
    if chapters:
        ranked = sorted(chapters, key=lambda c: (c.reteach_rank is None, c.reteach_rank or 0, c.mean, c.topic))
        blocks.append(Table(
            columns=[("Chapter", 0.3), ("Class mean", 0.28), ("Mean", 0.1), ("Below 60%", 0.14), ("Re-teach", 0.18)],
            rows=[[
                f"<b>{_e(c.topic)}</b>" + (f' <span class="muted">({_e(c.subject)})</span>' if c.subject else ""),
                _bar(c.mean), _pct(c.mean), _e(f"{c.below_60} of {c.students}"),
                _e(f"#{c.reteach_rank}" + (" (1 question)" if c.hint else "")) if c.reteach_rank else
                _e("1 question" if c.questions < 2 else "-"),
            ] for c in ranked],
            head=head,
            foot='<p class="cap">Re-teach: at least a third of the students who sat the chapter (2 or more) below '
                 "60%, then the NEET chapter weight. Chapters with one question count only on a short paper.</p>",
            gap=SECTION_GAP,
        ))
    else:
        blocks.append(Html(head + '<p class="muted">No chapter tags in scope.</p>', gap=SECTION_GAP))
    peak = max([b.count for b in cohort.score_distribution] + [1])
    blocks.append(Table(
        columns=[("Score band", 0.2), ("Students", 0.6), ("Count", 0.2)],
        rows=[[_e(b.label.replace("–", "-")), _bar(b.count / peak * 100, GOOD), _e(b.count)]
              for b in cohort.score_distribution],
        head='<p class="label">Score distribution</p>',
    ))
    if cohort.top_priorities:
        blocks.append(Table(
            columns=[("Chapter", 0.22), ("Class mastery", 0.13), ("ROI (illustr.)", 0.13), ("Rationale", 0.52)],
            rows=[[f"<b>{_e(p.topic)}</b>", _pct(p.mastery), _e(f"{p.roi:.2f}"), _e(_first_sentence(p.rationale, 220))]
                  for p in cohort.top_priorities],
            head='<p class="label">Study-plan priority (marks per revision hour) - a different ranking from re-teach</p>'
                 f'<div class="illus">{_e(ILLUSTRATIVE_LABEL)}</div>',
        ))
    return blocks


def _page_at_risk(cohort: CohortOut) -> list[Block]:
    head = _h2("06", "Students at risk")
    rows = sorted((r for r in cohort.students_view if r.urgency == "at_risk"), key=lambda r: (r.pct, r.student_name))
    if not rows:
        return [Html(head + '<p class="muted">No student in scope is at risk.</p>', gap=SECTION_GAP)]
    return [Table(
        columns=[("Student", 0.22), ("%", 0.08), ("Why", 0.5), ("Weakest chapter", 0.2)],
        rows=[[f"<b>{_e(r.student_name)}</b>" + (" <b>(new)</b>" if r.newly_at_risk else ""), _pct(r.pct),
               _e(" ".join(r.reasons)), _e(r.weakest_topic or "-")] for r in rows],
        head=head,
        gap=SECTION_GAP,
    )]


def render_cohort_pdf(cohort: CohortOut, *, students: list[StudentCard]) -> bytes:
    """The cohort report: denominator, KPIs, urgency, ranking, topic averages, distribution,
    common errors, class interventions, confusion clusters, at-risk list and operations. With the
    cohort page's fields (per_student=true) every figure is the page's own."""
    generated = datetime.now().astimezone()
    cards = {c.submission_id: c for c in students}
    completed_cards = [c for c in students if c.status == "COMPLETED"]
    if cohort.scope is not None and cohort.headline is not None:
        blocks: list[Block] = [
            *_page_title(cohort, generated),
            *_page_kpis(cohort),
            *_page_ranking(cohort),
            *_page_chapters(cohort),
            *_cohort_errors(cohort),
            *_cohort_interventions(cohort),
            *_page_at_risk(cohort),
            *_cohort_operations(cohort),
        ]
    else:
        blocks = [
            *_cohort_title(cohort, generated),
            *_cohort_kpis(cohort),
            *_cohort_ranking(cohort, cards),
            *_cohort_topics(cohort, completed_cards),
            *_cohort_errors(cohort),
            *_cohort_interventions(cohort),
            *_cohort_at_risk(cohort),
            *_cohort_operations(cohort),
        ]
    watermarks: list[tuple[str, str]] = []
    if cohort.release_counts.provisional:
        watermarks.append(("PROVISIONAL", RED))
    if cohort.is_demo:
        watermarks.append(("DEMO DATA", AMBER))
    released = f"{cohort.release_counts.released}/{cohort.completed} released"
    return _stamp(
        _layout(blocks),
        kicker=f"{KICKER_BRAND}  /  {cohort.batch.exam or 'NEET'} POC",
        institution=cohort.institution.name,
        footer_parts=["3iLens", cohort.institution.name, f"Cohort report - {released}",
                      f"generated {fmt_ist(generated)}"],
        watermarks=watermarks,
        title=f"Cohort Academic Intelligence Report - {cohort.institution.name}",
        subject=_filters_text(cohort),
    )


# --------------------------------------------------------------------------- #
# File names
# --------------------------------------------------------------------------- #
def slug(text: str, fallback: str = "x") -> str:
    value = re.sub(r"[^A-Za-z0-9]+", "-", text or "").strip("-")
    return value[:60] or fallback


def student_pdf_filename(student_name: str, test_name: str, rubric_version: str) -> str:
    """'3iLens_<student slug>_<test slug>_<rubric version>.pdf' (ASCII only)."""
    return f"3iLens_{slug(student_name, 'student')}_{slug(test_name, 'test')}_{slug(rubric_version, 'v')}.pdf"
