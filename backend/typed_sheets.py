"""Typed answer sheets read from their text layer instead of page images (FR-2.x).

A student who types the answers (a Word file, or a PDF exported from one) hands in text, not ink.
Reading it back through page images costs a vision call and can only lose what the file already
says: on a typed answer list ("12. B", "13. -") with Word's automatic numbering the vision reader
read 65 of 84 answers wrong, while the text layer read all 84 right. This module decides - with a
strict gate - whether a PDF / Word upload is such a sheet, and reads it:

    route(data, rubric) -> Route          "text_mcq" | "text_structure" | "keep"
    read_mcq(route) -> OcrResult          an all-MCQ rubric: the typed list itself, no AI call
    read_structure(route, data, rubric)   a descriptive or mixed rubric: one text-only mapping call
    check_structure(route, ocr)           the mapped answers are the sheet's own words

"keep" means the pipeline does what it always did (pre-processing, then the tick reader or the
vision transcription). Any doubt keeps it. The gate (every rule must pass):

1. A PDF or Word file (photos, scans and audio have no text layer).
2. Not a printed paper (paper_detect): a printed question paper's text layer holds the QUESTIONS;
   its answers are ticks on the page, which only the tick reader sees. An answer grid that reads as
   a question paper gets a second look only for an all-MCQ rubric, and passes only when it has no
   question text at all (rule 4a).
3. Every page carries typed text, and nothing can hold handwriting or a mark the text does not
   show: no picture over MAX_IMAGE_SHARE of a PDF page, no pen / shape / stamp annotation, no curved
   strokes, no struck-through text, no line mixing styles (a bold or coloured chosen option); in a
   Word file no embedded image, drawing, ink, tracked change, strike, highlight, shading, underline
   or coloured text.
4a. All-MCQ rubric: every line is an answer entry ("12. B", "Q12 (2)", "12 | 2, 3", "12. -" or
    "12." for a blank) apart from at most MAX_RESIDUAL_WORDS header words (name, roll number), at
    least MIN_ENTRIES answers, no number listed twice or outside the rubric, every answer an option
    of this paper, and answer_keys' own parser reads exactly the same answers (two independent
    parsers must agree). A list that equals the key keeps today's route (an answer key uploaded as
    a student sheet; review catches it there).
4b. Descriptive or mixed rubric: at least MIN_STRUCTURE_CHARS of text, mapped by one text-only
    call (ai.structure_transcript, the voice-answer mapper; superscripts written as "^" so X^c Y or
    mv^2 survive). check_structure() then requires that MIN_WORD_SUPPORT of each answer's words
    occur in the sheet and that the answers cover MIN_COVERAGE of the sheet's words after its header;
    a failure sends the sheet to the vision path.
"""
from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass, field
from typing import Any
from xml.etree import ElementTree as ET

import pymupdf

import ai
import answer_keys
import docx_reader
import paper_detect
from ai_schemas import OcrAnswer, OcrResult, PageAssessment
from config import DOCX_MIME, Settings, get_settings

PATH_MCQ = "text_mcq"
PATH_STRUCTURE = "text_structure"
PATH_KEEP = "keep"
PROVIDER = "text-layer"          # OcrResult.provider of a typed list read without any AI call
MODEL = "typed-list"
SOURCE = "typed"                 # OcrAnswer.source

MIN_PAGE_CHARS = 20
MAX_IMAGE_SHARE = 0.05           # of a PDF page's area
MAX_RESIDUAL_WORDS = 40
MIN_ENTRIES = 5
KEY_LIKE_SHARE = 0.95
MIN_STRUCTURE_CHARS = 100
MIN_WORD_SUPPORT = 0.90
MIN_COVERAGE = 0.80
PEN_ANNOTS = {"Ink", "Polygon", "PolyLine", "Line", "Square", "Circle", "Stamp", "FreeText", "Caret", "Highlight",
              "Underline", "StrikeOut", "Squiggly"}
PDF_MIME = "application/pdf"

_ENTRY = re.compile(
    r"^\s*(?:Q(?:ue(?:s(?:tion)?)?)?\.?\s*(?:No\.?\s*)?)?(\d{1,3})(?:\s*[.):\-–|]\s*|\s+|$)(?P<ans>.*)$",
    re.IGNORECASE,
)
_BLANK = re.compile(
    r"^(?:|[-–—_]+|\(\s*\)|\[\s*\]|skip(?:ped)?|n/?a|not\s+attempted|unattempted|left|blank|none)$",
    re.IGNORECASE,
)
_PREFIX = re.compile(r"^(?:ans(?:wer)?\.?\s*[:.\-]?\s*|opt(?:ion)?\.?\s*)", re.IGNORECASE)
_OPTION = re.compile(r"\(?\s*([1-6]|[A-Fa-f])\s*\)?")
_JOIN = re.compile(r"\s*(?:,|/|&|\band\b|\bor\b|\s)\s*", re.IGNORECASE)
_WORD = re.compile(r"[A-Za-z]{2,}|\d+")
_TOKEN = re.compile(r"[a-z0-9%']+")
_NOTE = re.compile(r"\[note to examiner:\s*(.*?)\]", re.IGNORECASE | re.DOTALL)
_LABEL = re.compile(r"^\s*(?:(?:Q(?:ue(?:s(?:tion)?)?)?|Ans(?:wer)?)\.?\s*)?\d{1,3}\s*[.):\-]?(?=\s|$)\s*", re.IGNORECASE)
_CONTD = re.compile(r"\(\s*Q?\s*\d{1,3}\s*(?:contd|continued)\.?\s*\)", re.IGNORECASE)
_DOCX_MEANING = re.compile(
    r'<w:(?:strike|dstrike|highlight)\b(?![^>]*w:val="(?:false|0|none)")'
    r'|<w:shd\b[^>]*w:fill="(?!auto|FFFFFF|ffffff)[0-9A-Fa-f]{6}"'
    r'|<w:u\b(?![^>]*w:val="none")'
    r'|<w:color\b[^>]*w:val="(?!auto|000000)[0-9A-Fa-f]{6}"'
)


@dataclass
class Route:
    path: str                     # PATH_MCQ | PATH_STRUCTURE | PATH_KEEP
    reason: str
    mime: str
    pages: int = 0                # PDF pages, or 1 for a Word file until the pipeline lays it out
    page_texts: list[str] = field(default_factory=list)
    entries: dict[int, list[str]] = field(default_factory=dict)   # PATH_MCQ: question -> letters ([] = blank)
    entry_pages: dict[int, int] = field(default_factory=dict)

    @property
    def text(self) -> str:
        return "\n".join(self.page_texts)

    @property
    def answered(self) -> int:
        return sum(1 for letters in self.entries.values() if letters)


def file_mime(data: bytes) -> str | None:
    """application/pdf or the Word MIME type from the file's own bytes; None for anything else."""
    if data[:5] == b"%PDF-":
        return PDF_MIME
    if data[:2] == b"PK" and docx_reader.package_kind(data) == "docx":
        return DOCX_MIME
    return None


# --------------------------------------------------------------------------- #
# The gate
# --------------------------------------------------------------------------- #
def route(data: bytes, rubric_content: dict[str, Any] | None, settings: Settings | None = None) -> Route:
    """Where a stored upload is read: from its text layer (PATH_MCQ / PATH_STRUCTURE) or as today
    (PATH_KEEP, with the first rule that refused it as the reason). Never raises."""
    mime = file_mime(data)
    if mime is None:
        return Route(PATH_KEEP, "not a PDF or Word file: no text layer", "other")
    try:
        return _route(data, mime, rubric_content or {}, settings or get_settings())
    except Exception as exc:  # noqa: BLE001 - a file the gate cannot read keeps today's route
        return Route(PATH_KEEP, f"text layer unreadable ({type(exc).__name__})", mime)


def _route(data: bytes, mime: str, rubric: dict[str, Any], settings: Settings) -> Route:
    inspection, texts = paper_detect.inspect_document(data, settings)
    role = inspection.role
    numbers = {n for q in ai._rubric_questions(rubric) if (n := ai._question_number(q)) is not None}
    all_mcq = bool(numbers) and ai._mcq_numbers(rubric) == numbers
    printed = paper_detect.printed_paper(inspection) or role in ("question_paper", "answer_key_paper")
    # A typed answer grid ("Q12 (2)") can read as a question paper (numbered lines with option
    # tokens); only an all-MCQ rubric gets a second look, and the list rules below accept it only
    # without question text (a printed paper has hundreds of stem words).
    if printed and not (all_mcq and role == "question_paper"):
        return Route(PATH_KEEP, f"printed paper (role {role}): its answers are marks on the page, not text", mime)
    page_texts = list(texts) if mime == PDF_MIME else [_docx_text(data)]   # Word list numbers written out
    base = Route(PATH_KEEP, "", mime, pages=len(page_texts), page_texts=page_texts)
    if all_mcq:
        base = _route_mcq(base, rubric, numbers, printed_role=printed)
        if base.path == PATH_KEEP:
            return base
    elif len("".join(base.text.split())) < MIN_STRUCTURE_CHARS:
        base.reason = "too little typed text to map"
        return base
    else:
        base.path, base.reason = PATH_STRUCTURE, "typed descriptive / mixed answers"
    problem = _pdf_problem(data) if mime == PDF_MIME else _docx_problem(data)
    if problem:
        base.path, base.reason = PATH_KEEP, problem
    return base


def _route_mcq(base: Route, rubric: dict[str, Any], numbers: set[int], *, printed_role: bool) -> Route:
    n_options = _option_count(rubric)
    entries, pages, residual, repeats, unread = _scan_entries(base.page_texts, n_options)
    base.entries, base.entry_pages = entries, pages
    answered = {q: v for q, v in entries.items() if v}
    if repeats:
        base.reason = f"question(s) listed twice: {sorted(set(repeats))[:10]}"
        return base
    unread = [q for q in unread if q in numbers]
    if unread:
        base.reason = f"numbered line(s) whose answer is not an option of this paper: {unread[:10]}"
        return base
    every = [q for q, v in answered.items() if len(v) >= max(3, n_options)]
    if every:
        base.reason = f"entries list every option ({every[:10]}): the chosen one may be marked by formatting"
        return base
    if residual > MAX_RESIDUAL_WORDS:
        base.reason = (f"{residual} words outside answer entries (more than {MAX_RESIDUAL_WORDS}): "
                       + ("printed question text" if printed_role else "not a plain answer list"))
        return base
    if len(answered) < MIN_ENTRIES:
        base.reason = f"only {len(answered)} typed answers found"
        return base
    outside = sorted(set(entries) - numbers)
    if outside:
        base.reason = f"numbers not in the rubric: {outside[:10]}"
        return base
    parsed = answer_keys._parse(base.text)
    if parsed.bonus or parsed.clashes or parsed.per_code or parsed.id_key or parsed.unplaced:
        base.reason = "the answer-key parser found bonus, clashing, per-code or unplaced entries"
        return base
    readings = {q: [v] for q, v in parsed.entries.items()}
    for q, letters in parsed.accepted.items():
        readings[q] = sorted(set(letters))
    # answer_keys reads keys, which come in runs: an answer alone between typed blanks ("7. -", "8. D",
    # "9. -") is not a run and it skips it; the line scan reads it ("8. D" is unambiguous). A question
    # both read differently, or read only by answer_keys, is a disagreement.
    conflicts = sorted(q for q, v in readings.items() if answered.get(q) != v)
    if conflicts:
        base.reason = f"the two parsers disagree on {len(conflicts)} question(s): {conflicts[:10]}"
        return base
    key = _key_letters(rubric)
    same = sum(1 for q, v in answered.items() if key.get(q) and v == [key[q]])
    if key and len(answered) >= KEY_LIKE_SHARE * len(numbers) and same >= KEY_LIKE_SHARE * len(numbers):
        base.reason = "every answer equals the key: an answer key uploaded as a student sheet"
        return base
    base.path = PATH_MCQ
    base.reason = (f"typed answer list: {len(answered)} answer(s), {len(entries) - len(answered)} typed blank(s), "
                   f"{len(numbers - set(entries))} not listed; two parsers agree")
    return base


def _option_count(rubric: dict[str, Any]) -> int:
    counts = [len(q.get("options") or []) for q in ai._rubric_questions(rubric)]
    return max([c for c in counts if c] or [4])


def _answer_letters(raw: str, n_options: int) -> list[str] | None:
    """Letters for an entry's answer text, [] for a blank, None when it is not an answer."""
    text = _PREFIX.sub("", raw.strip()).strip().rstrip(".;")
    if _BLANK.match(text):
        return []
    letters = []
    for part in (p for p in _JOIN.split(text) if p):
        match = _OPTION.fullmatch(part)
        if not match:
            return None
        token = match.group(1).upper()
        letter = "ABCDEF"[int(token) - 1] if token.isdigit() else token
        if "ABCDEF".index(letter) >= n_options:
            return None
        letters.append(letter)
    return sorted(set(letters)) or None


def _scan_entries(page_texts: list[str], n_options: int):
    """(question -> letters ([] = typed blank), question -> page, words outside entries, numbers seen
    twice, numbered lines whose answer is not an option list ("8. E" on a 4-option paper))."""
    entries: dict[int, list[str]] = {}
    pages: dict[int, int] = {}
    residual, repeats, unread = 0, [], []
    for page_no, text in enumerate(page_texts, start=1):
        for line in text.splitlines():
            if not line.strip():
                continue
            match = _ENTRY.match(line)
            got = _answer_letters(match.group("ans"), n_options) if match else None
            if match is None or got is None:
                residual += len(_WORD.findall(line))
                if match is not None:
                    unread.append(int(match.group(1)))
                continue
            number = int(match.group(1))
            if number in entries:
                repeats.append(number)
            entries[number] = got
            pages[number] = page_no
    return entries, pages, residual, repeats, unread


def _key_letters(rubric: dict[str, Any]) -> dict[int, str]:
    out = {}
    for q in ai._rubric_questions(rubric):
        number = ai._question_number(q)
        if number is not None and q.get("correct_option"):
            out[number] = str(q["correct_option"]).upper()
    return out


# --------------------------------------------------------------------------- #
# Rule 3: nothing on the pages can hold handwriting or a mark the text does not show
# --------------------------------------------------------------------------- #
def _pdf_problem(data: bytes) -> str | None:
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        for index, page in enumerate(doc, start=1):
            if len("".join(page.get_text().split())) < MIN_PAGE_CHARS:
                return f"page {index} has no text layer (a scan or a photo)"
            area = abs(page.rect) or 1.0
            for info in page.get_image_info():
                share = abs(pymupdf.Rect(info["bbox"]) & page.rect) / area
                if share > MAX_IMAGE_SHARE:
                    return f"page {index} holds an image ({share:.0%} of the page) that may carry handwriting"
            kinds = {annot.type[1] for annot in page.annots() or []}
            if kinds & PEN_ANNOTS:
                return f"page {index} has pen / shape annotations ({', '.join(sorted(kinds & PEN_ANNOTS))})"
            drawings = page.get_drawings()
            if any(item[0] == "c" for path in drawings for item in path["items"]):
                return f"page {index} has curved strokes (pen input or ticks)"
            problem = _pdf_format_problem(page, drawings, index)
            if problem:
                return problem
    return None


def _pdf_format_problem(page: Any, drawings: list[dict], index: int) -> str | None:
    """Formatting that can carry an answer: struck-through text, or one text line whose spans differ
    in colour / weight / italics (a bold or coloured chosen option). Superscripts are allowed."""
    spans = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            styles = {(s["color"], s["flags"] & ~1 & ~4, s["font"]) for s in line["spans"] if s["text"].strip()}
            if len(styles) > 1:
                return f"page {index}: a text line mixes styles (bold / colour / italic) - formatting may carry the answer"
            spans.extend(pymupdf.Rect(s["bbox"]) for s in line["spans"] if s["text"].strip())
    for path in drawings:
        for item in path["items"]:
            if item[0] == "l":
                a, b = item[1], item[2]
                segment = pymupdf.Rect(min(a.x, b.x), min(a.y, b.y) - 0.5, max(a.x, b.x), max(a.y, b.y) + 0.5)
            elif item[0] == "re" and item[1].height < 2.0:
                segment = item[1]
            else:
                continue
            if segment.width < 3 * max(segment.height, 1.0):
                continue  # not horizontal
            middle = (segment.y0 + segment.y1) / 2
            for box in spans:
                if box.intersects(segment) and box.y0 + 0.3 * box.height < middle < box.y0 + 0.7 * box.height:
                    return f"page {index}: text is struck through (a corrected answer)"
    return None


def _docx_problem(data: bytes) -> str | None:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        media = [n for n in archive.namelist() if n.lower().startswith("word/media/")]
        if media:
            return f"the Word document embeds {len(media)} image(s) that may carry handwriting or a diagram"
        body = archive.read("word/document.xml").decode("utf-8", "replace")
    if re.search(r"<(?:w:object|v:shape|w14:contentPart|w:contentPart|mc:AlternateContent)\b", body):
        return "the Word document has drawn objects or ink"
    meaning = _DOCX_MEANING.search(body)
    if meaning:
        return "the Word document uses formatting that can carry an answer (strike, highlight, shading, underline or colour)"
    if re.search(r"<w:ins\b|<w:del\b", body):
        return "the Word document has tracked changes"
    return None


def _docx_text(data: bytes) -> str:
    """The Word text with list numbers written out ("1.", "2."), as answer_keys reads a Word key."""
    docx_reader.validate_docx(data)
    return docx_reader.numbered_text(data) or docx_reader.docx_text(data)


# --------------------------------------------------------------------------- #
# Readers
# --------------------------------------------------------------------------- #
def read_mcq(r: Route) -> OcrResult:
    """The typed list as the OCR result: one answer per typed option (confidence 1.0, it is the
    file's own text), no AI call."""
    answers = [
        OcrAnswer(question=q, answer=", ".join(letters), confidence=1.0, pages=[r.entry_pages.get(q, 1)], source=SOURCE)
        for q, letters in sorted(r.entries.items()) if letters
    ]
    return OcrResult(
        answers=answers,
        overall_confidence=1.0 if answers else 0.0,
        provider=PROVIDER,
        model=MODEL,
        page_assessments=[PageAssessment(page=i, legibility_confidence=1.0) for i in range(1, r.pages + 1)],
    )


def read_structure(
    r: Route, data: bytes, rubric_content: dict[str, Any], *, language_hints: list[str] | None = None,
    on_usage: ai.UsageCallback | None = None,
) -> tuple[OcrResult, Route]:
    """The sheet's text (superscripts as "^") mapped onto the rubric questions by one text-only call
    (ai.structure_transcript; its usage is reported as purpose "ocr", the stage it replaces). Returns
    the result and the route with the text that was sent (check_structure compares against it)."""
    texts = notation_text(data, r.mime)
    sent = Route(r.path, r.reason, r.mime, pages=r.pages, page_texts=texts)

    def as_ocr(usage):
        if on_usage is not None:
            on_usage(usage.model_copy(update={"purpose": "ocr"}))

    ocr = ai.structure_transcript(sent.text, rubric_content, language_hints=language_hints, on_usage=as_ocr)
    answers = [
        a.model_copy(update={"source": SOURCE, "pages": _pages_of(a.answer, texts)}) for a in ocr.answers
    ]
    return ocr.model_copy(update={
        "answers": answers,
        "page_assessments": [PageAssessment(page=i, legibility_confidence=1.0) for i in range(1, r.pages + 1)],
    }), sent


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall(text.lower())


def _pages_of(answer: str, page_texts: list[str]) -> list[int]:
    words = set(_tokens(answer))
    hits = [i for i, t in enumerate(page_texts, start=1) if words and len(words & set(_tokens(t))) >= 0.5 * len(words)]
    return hits[:3] or [1]


def check_structure(r: Route, ocr: OcrResult) -> dict[str, Any]:
    """The mapped answers are the sheet's own words (no rewrite: MIN_WORD_SUPPORT of each answer's
    words occur in the text) and cover MIN_COVERAGE of the words after the sheet's header (question
    labels such as "12." or "(Q1 contd.)" do not count)."""
    vocabulary = set(_tokens(r.text))
    support: dict[int, float] = {}
    used: set[str] = set()
    for answer in ocr.answers:
        words = _tokens(_NOTE.sub(lambda m: m.group(1), answer.answer))
        known = [w for w in words if w in vocabulary]
        support[answer.question] = round(len(known) / len(words), 3) if words else 1.0
        used |= set(words)
    lines = [_LABEL.sub("", _CONTD.sub("", line)) for line in r.text.splitlines()]
    lines = [line for line in lines if line.strip()]
    start = next((i for i, line in enumerate(lines) if set(_tokens(line)) & used and i > 0), 0)
    body = [w for line in lines[start:] for w in _tokens(line)]
    coverage = round(sum(1 for w in body if w in used) / len(body), 3) if body else 1.0
    ok = bool(ocr.answers) and all(v >= MIN_WORD_SUPPORT for v in support.values()) and coverage >= MIN_COVERAGE
    return {"ok": ok, "word_support": support, "coverage": coverage, "body_words": len(body)}


# --------------------------------------------------------------------------- #
# Superscripts as "^": the text layer flattens X^c Y to "XcY" and mv^2 to "mv2"
# --------------------------------------------------------------------------- #
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def notation_text(data: bytes, mime: str) -> list[str]:
    """Page texts with superscripts written as "^" (PDF spans flagged superscript: "^" and the span;
    Word runs with vertAlign superscript: "^c" for one character, "^15" for digits, "^(ab)" otherwise)."""
    if mime == DOCX_MIME:
        return [_docx_text(_docx_with_carets(data))]
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        pages = []
        for page in doc:
            lines = []
            for block in page.get_text("dict")["blocks"]:
                for line in block.get("lines", []):
                    lines.append("".join(
                        "^" + s["text"].strip() if s["flags"] & 1 and s["text"].strip() else s["text"]
                        for s in line["spans"]
                    ))
            pages.append("\n".join(lines))
        return pages


def _caret(text: str) -> str:
    return f"^{text}" if len(text) <= 1 or text.isdigit() else f"^({text})"


def _docx_with_carets(data: bytes) -> bytes:
    """A copy of the Word file whose superscript runs carry the "^" in their text (read by the usual
    docx_reader functions; the upload itself is never changed)."""
    source = zipfile.ZipFile(io.BytesIO(data))
    try:
        root = ET.fromstring(source.read("word/document.xml"))
        changed = False
        for run in root.iter(f"{_W}r"):
            align = run.find(f"{_W}rPr/{_W}vertAlign")
            if align is None or align.get(f"{_W}val") != "superscript":
                continue
            for node in run.findall(f"{_W}t"):
                if node.text:
                    node.text = _caret(node.text)
                    changed = True
        if not changed:
            return data
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as target:
            for item in source.infolist():
                payload = ET.tostring(root, encoding="utf-8", xml_declaration=True) if item.filename == "word/document.xml" \
                    else source.read(item.filename)
                target.writestr(item, payload)
        return out.getvalue()
    finally:
        source.close()
