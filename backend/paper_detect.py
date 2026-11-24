"""What an intake file looks like, read locally from its text layer (no AI call, nothing stored).

Used by POST /api/intake/inspect (routers/intake_routes.py) before upload, and by POST /api/upload
for one Ingestion log line. The result is a hint for faculty only: it never rejects a file or
changes how it is processed.

Heuristics (all counts come from the PDF / DOCX text layer; images and audio have none):

- answer_markers: inline answer markers - "Ans. (2)", "Ans (B)", "Answer: 3", "Ans. 4", including
  "Ans." and "( 2 )" on separate lines - plus the entries of an answer-key table ("1. (2)", "1-B",
  "Q1 (c)", or a "Que. 1 2 3 / Ans. 2 4 1" grid) after a standalone "Answer key" heading line. A bare
  option after "Answer" needs punctuation ("Answer: 3"), so prose such as "Answer the following" or
  "Answer any 3 questions" never counts.
- numbered_questions: distinct question numbers 1-300 at line starts ("1.", "12 .", "7)", "Q.5",
  "Q5)", "Que 5"); "2.365 W" is a decimal, not question 2.
- option_groups: option lists - a "(4)" / "(d)" option that follows a "(3)" / "(c)" since the
  last group ended.
- subjects: short standalone section headings (PHYSICS, CHEMISTRY, BIOLOGY, BOTANY, ZOOLOGY,
  MATHEMATICS / MATHS), in order of first appearance.
- title: the first line of the first two pages that names an exam or paper (NEET, JEE, CBSE, Board,
  Examination, Test / Question Paper, Mock, Olympiad), cleaned, at most 120 characters.
- role:
  - answer_key_paper: answer_markers >= max(5, half the numbered questions), with an answer-key
    table or printed option lists for at least half the markers (a student's typed "1. Ans: B"
    sheet has neither);
  - question_paper: at least 10 numbered questions and 5 option groups (a printed MCQ paper with
    no printed key - ticks on it are a student's answers, or mark the key);
  - answer_sheet: no usable text layer (fewer than 200 characters), or fewer than 10 numbered
    questions with fewer than 5 option groups (a handwritten scan or a typed answer sheet);
  - unknown: anything else (e.g. a descriptive question paper with many numbered questions).
"""
from __future__ import annotations

import logging
import re

import pymupdf

import docx_reader
import insights
import preprocessing
import uploads
from config import DOCX_MIME, MIME_LABELS, Settings
from errors import ApiError
from schemas import PaperInspection

logger = logging.getLogger("3ilens.paper_detect")

MAX_TEXT_PAGES = 40            # pages whose text is read
MIN_TEXT_CHARS = 200           # below this the PDF has no usable text layer (a plain scan)
MAX_QUESTION_NUMBER = 300
MIN_KEY_MARKERS = 5
KEY_SHARE = 0.5                # answer markers per numbered question for an answer-key paper
MIN_PAPER_QUESTIONS = 10
MIN_PAPER_OPTION_GROUPS = 5
MAX_TITLE_CHARS = 120
MAX_HEADING_CHARS = 40

AUDIO_LABELS = {"audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg"}
UNSUPPORTED_DETAIL = uploads.UNSUPPORTED_DETAIL

# Private-use glyphs (symbol fonts) and control characters left over in extracted text.
_JUNK = re.compile(r"[\ue000-\uf8ff\x00-\x08\x0b-\x1f\x7f]")
_OPTION_TOKEN = r"\(\s*([1-6]|[a-fA-F])\s*\)"
# "Ans. ( 2 )", "Ans (B)", "Answer: (c)" - parenthesised option after Ans / Answer.
_ANS_PAREN = re.compile(r"\bAns(?:wer)?\b\s*[.:\-–]*\s*" + _OPTION_TOKEN)
# "Ans. 4", "Ans: B", "Answer - 3" - a bare option needs punctuation after Ans / Answer.
_ANS_BARE = re.compile(r"\bAns(?:wer)?\b\s*[.:\-–]+\s*([1-6]|[a-fA-F])(?=\s*$|[\s.,;)])", re.MULTILINE)
_KEY_HEADING_LINE = re.compile(
    r"^(?:final\s+|provisional\s+)?answers?\s*[-_ ]?\s*keys?\b.{0,30}$", re.IGNORECASE
)
# Answer-key table entries: "1. (2)", "1-B", "12) c", "Q1 (c)", "Q.5 - 3".
_KEY_ENTRY = re.compile(
    r"(?<![\w.])(?:Q(?:ue(?:s(?:tion)?)?)?\.?\s*(\d{1,3})\s*[.):\-–]?|(\d{1,3})\s*[.):\-–])\s*"
    r"\(?\s*([1-6]|[a-dA-D])\s*\)?(?![\w.])"
)
# "Que. 1 2 3 4 ... Ans. 2 4 1 3 ..." grids: one row of numbers, one row of options.
_GRID_ROW = re.compile(r"\bAns\.?\s*((?:[1-4a-dA-D]\s+){2,}[1-4a-dA-D])(?!\w)")
_QUESTION_LINE = re.compile(
    r"^(?:Q(?:ue(?:s(?:tion)?)?)?\.?\s*(\d{1,3})\s*[.):\-–]?(?!\d)|(\d{1,3})\s*[.)](?!\d))"
)
_SPLIT_NUMBER = re.compile(r"(?m)^[ \t]*(\d{1,3})[ \t]*\n[ \t]*([.)])(?!\d)")
_SPACED_DIGITS = re.compile(r"(?m)^[ \t]*(\d)[ \t](\d)(?:[ \t](\d))?(?=[ \t]*[.)](?!\d))")
_OPTION = re.compile(r"(?<![\w)])" + _OPTION_TOKEN)
# Options that start a line without parentheses: "c) ...", "C. ...", "d) ...". Letters only -
# "3)" / "3." at a line start is a question number far more often than an option.
_OPTION_LINE = re.compile(r"(?m)^[ \t]*([a-dA-D])[ \t]*[.)][ \t]+(?=\S)")
_SUBJECTS = {
    "physics": "Physics", "chemistry": "Chemistry", "biology": "Biology", "botany": "Botany",
    "zoology": "Zoology", "mathematics": "Mathematics", "maths": "Mathematics", "math": "Mathematics",
}
_SUBJECT_HEADING = re.compile(
    r"^(?:(?:part|section|subject|paper)\s*[-–:]?\s*(?:[a-d]|[ivx]+|\d)?\s*[-–:.)]?\s*)?"
    r"(physics|chemistry|biology|botany|zoology|mathematics|maths|math)\b"
    r"(?:\s*[-–:(]?\s*(?:part|section)?\s*[-–:]?\s*(?:[a-d]|[ivx]+|\d)?\s*\)?)?$",
    re.IGNORECASE,
)
_TITLE_WORDS = re.compile(
    r"\b(?:NEET|JEE|AIIMS|CBSE|ICSE|KCET|MHT[- ]?CET|board|examination|exam|test\s+paper|"
    r"question\s+paper|mock|olympiad)\b",
    re.IGNORECASE,
)


# --------------------------------------------------------------------------- #
# Text measures
# --------------------------------------------------------------------------- #
def _clean(text: str) -> str:
    return _JUNK.sub(" ", text or "")


def _option_index(token: str) -> int:
    return int(token) if token.isdigit() else "abcdef".index(token.lower()) + 1


def _key_table(text: str) -> str | None:
    """The text after the first standalone "Answer key" heading line (flattened), or None."""
    lines = _clean(text).splitlines()
    for index, raw in enumerate(lines):
        if _KEY_HEADING_LINE.match(" ".join(raw.split())):
            return " ".join(" ".join(lines[index + 1:]).split())
    return None


def count_answer_markers(text: str) -> tuple[int, bool]:
    """(markers, has_key_table): inline "Ans. (2)" markers plus the entries of an answer-key table
    under a standalone "Answer key" heading line."""
    flat = " ".join(_clean(text).split())
    inline = len(_ANS_PAREN.findall(flat)) + len(_ANS_BARE.findall(flat))
    tail = _key_table(text)
    if not tail:
        return inline, False
    numbers: set[int] = set()
    for match in _KEY_ENTRY.finditer(tail):
        number = int(match.group(1) or match.group(2))
        if 1 <= number <= MAX_QUESTION_NUMBER:
            numbers.add(number)
    grid = sum(len(row.group(1).split()) for row in _GRID_ROW.finditer(tail))
    if grid:
        inline -= len(_ANS_BARE.findall(tail))  # a grid row's first option is not an inline marker
    table = max(len(numbers), grid)
    return max(0, inline) + table, table > 0


def _rejoin_numbers(text: str) -> str:
    """Undo text-layer splits of question numbers: "15" / ". In ..." on two lines -> "15. In ...";
    "1 3 . In ..." (spaced digits) -> "13. In ..."."""
    text = _SPLIT_NUMBER.sub(lambda m: m.group(1) + m.group(2), text)
    return _SPACED_DIGITS.sub(lambda m: "".join(g for g in m.groups() if g), text)


def question_numbers(text: str) -> set[int]:
    """Distinct question numbers 1-300 written at the start of a line."""
    numbers: set[int] = set()
    for raw in _rejoin_numbers(_clean(text)).splitlines():
        match = _QUESTION_LINE.match(raw.strip())
        if match is None:
            continue
        number = int(match.group(1) or match.group(2))
        if 1 <= number <= MAX_QUESTION_NUMBER:
            numbers.add(number)
    return numbers


def count_option_groups(text: str) -> int:
    """Option lists: a (4)/(d) option after a (3)/(c) since the previous group ended. Options are
    "(3)" / "(c)" anywhere, or "c)" / "C." starting a line."""
    groups = 0
    seen_third = False
    cleaned = _clean(text)
    tokens = sorted(
        [(m.start(), m.group(1)) for m in _OPTION.finditer(cleaned)]
        + [(m.start(1), m.group(1)) for m in _OPTION_LINE.finditer(cleaned)]
    )
    for _position, token in tokens:
        index = _option_index(token)
        if index == 3:
            seen_third = True
        elif index == 4 and seen_third:
            groups += 1
            seen_third = False
    return groups


def section_subjects(text: str) -> list[str]:
    """Section headings (Physics / Chemistry / Biology / ...) in order of first appearance."""
    known = {name.casefold(): name for name in insights.SUBJECT_WEIGHTS}
    found: list[str] = []
    for raw in _clean(text).splitlines():
        line = " ".join(raw.split())
        if not line or len(line) > MAX_HEADING_CHARS:
            continue
        match = _SUBJECT_HEADING.match(line)
        if match is None:
            continue
        word = match.group(1)
        if not (word.isupper() or line == line.title() or line.casefold() == word.casefold()):
            continue
        name = _SUBJECTS[word.casefold()]
        name = known.get(name.casefold(), name)
        if name not in found:
            found.append(name)
    return found


def paper_title(page_texts: list[str]) -> str | None:
    """The first line of the first two pages that names an exam or paper."""
    for text in page_texts[:2]:
        for raw in _clean(text).splitlines():
            line = " ".join(raw.split()).strip(" -–|,;:")
            if len(line) < 6 or not _TITLE_WORDS.search(line):
                continue
            if sum(ch.isalpha() for ch in line) < 4:
                continue
            return line[:MAX_TITLE_CHARS].rstrip()
    return None


# --------------------------------------------------------------------------- #
# Classification
# --------------------------------------------------------------------------- #
def _plural(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


def classify(
    page_texts: list[str], *, file_type: str, pages: int | None, settings: Settings, too_long: bool = False
) -> PaperInspection:
    """PaperInspection for a document whose text (one string per page) has been extracted.
    too_long: the page count is unknown but above the limit (a Word document that hit the layout cap)."""
    text = "\n".join(page_texts)
    text_layer = len("".join(_clean(text).split())) >= MIN_TEXT_CHARS
    numbers = question_numbers(text) if text_layer else set()
    markers, key_table = count_answer_markers(text) if text_layer else (0, False)
    groups = count_option_groups(text) if text_layer else 0
    subjects = section_subjects(text) if text_layer else []
    title = paper_title(page_texts) if text_layer else None
    numbered = len(numbers)
    within = not too_long and (pages is None or pages <= settings.max_pdf_pages)
    page_text = f"{_plural(pages, 'page')}, " if pages else ""

    if not text_layer and file_type == "docx":
        role = "answer_sheet"
        message = "Short typed answer sheet."
    elif not text_layer:
        role = "answer_sheet"
        message = (
            "Scanned pages without a text layer - the vision model reads them after upload (a handwritten "
            "sheet, or a printed paper with ticked options)."
        )
    elif markers >= max(MIN_KEY_MARKERS, KEY_SHARE * numbered) and (
        key_table or groups >= KEY_SHARE * markers
    ):
        role = "answer_key_paper"
        questions = max(numbered, markers)
        message = (
            f"Question paper with its answer key ({_plural(questions, 'question')}, "
            f"{_plural(markers, 'answer')} found) - draft the rubric from it; it is not a student's sheet."
        )
    elif numbered >= MIN_PAPER_QUESTIONS and groups >= MIN_PAPER_OPTION_GROUPS:
        role = "question_paper"
        message = (
            f"Printed MCQ paper ({page_text}about {_plural(numbered, 'question')}) - ticked, circled or shaded "
            "options are read as the student's answers; use it as the answer key instead if the ticks mark "
            "the correct options."
        )
    elif numbered < MIN_PAPER_QUESTIONS and groups < MIN_PAPER_OPTION_GROUPS:
        role = "answer_sheet"
        message = "Handwritten or typed answer sheet."
    else:
        role = "unknown"
        message = (
            f"Printed text with about {_plural(numbered, 'numbered question')} - check whether this is a "
            "student's answer sheet or a question paper."
        )
    if not within and pages is not None:
        message += (
            f" It has {_plural(pages, 'page')}; the upload limit is {settings.max_pdf_pages} pages - "
            "split it before uploading."
        )
    elif not within:
        message += (
            f" It is longer than the {settings.max_pdf_pages}-page upload limit - split it before uploading."
        )
    return PaperInspection(
        file_type=file_type,
        pages=pages,
        text_layer=text_layer,
        role=role,  # type: ignore[arg-type]
        numbered_questions=numbered,
        answer_markers=markers,
        option_groups=groups,
        subjects=subjects,
        title=title,
        max_pdf_pages=settings.max_pdf_pages,
        within_page_limit=within,
        message=message,
    )


# --------------------------------------------------------------------------- #
# Entry points
# --------------------------------------------------------------------------- #
def _pdf_texts(data: bytes) -> tuple[list[str], int]:
    try:
        document = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001 - pymupdf raises several types for corrupt files
        raise ApiError(422, "The PDF could not be opened - it may be corrupt.", "corrupt_pdf") from exc
    try:
        if document.needs_pass:
            raise ApiError(422, "Password-protected PDFs are not supported.", "password_pdf")
        pages = document.page_count
        if pages < 1:
            raise ApiError(422, "The PDF has no pages.", "no_pages")
        texts = []
        for index in range(min(pages, MAX_TEXT_PAGES)):
            try:
                texts.append(document[index].get_text())
            except Exception:  # noqa: BLE001 - one unreadable page leaves the rest usable
                texts.append("")
        return texts, pages
    finally:
        document.close()


def _docx_texts(data: bytes) -> tuple[list[str], int | None, bool]:
    """(text, A4 page count, too_long). Layout errors mirror POST /api/upload, except that a
    document over the layout cap is described as too long instead of rejected."""
    kind = docx_reader.package_kind(data)
    if kind == "zip":
        raise ApiError(415, UNSUPPORTED_DETAIL, "unsupported_signature")
    if kind == "corrupt":
        raise ApiError(422, "The Word document could not be opened - it may be corrupt.", "corrupt_docx")
    try:
        docx_reader.validate_docx(data)
        text = docx_reader.docx_text(data)
    except docx_reader.DocxError as exc:
        status = 415 if exc.code == "macro_docx" else 422
        raise ApiError(status, str(exc), exc.code) from exc
    try:
        _pdf, pages, _omitted = preprocessing.docx_to_pdf(data)
    except preprocessing.PreprocessingError as exc:
        if exc.code == "too_many_pages":
            return [text], None, True
        status = 415 if exc.code == "macro_docx" else 422
        raise ApiError(status, str(exc), exc.code) from exc
    return [text], pages, False


def inspect_bytes(data: bytes, settings: Settings) -> PaperInspection:
    """Inspect an intake file's bytes. Raises ApiError for empty, unsupported, corrupt or
    password-protected files (the same codes as POST /api/upload)."""
    if not data:
        raise ApiError(422, "The uploaded file is empty.", "empty_file")
    head = data[:8192]
    audio = uploads.sniff_audio(head)
    if audio is not None:
        if not settings.voice_answers_enabled:
            raise ApiError(415, uploads.VOICE_DISABLED_DETAIL, "voice_disabled")
        if audio == uploads.UNSUPPORTED_AUDIO or audio not in settings.allowed_audio_mime_types:
            raise ApiError(415, uploads.UNSUPPORTED_AUDIO_DETAIL, uploads.UNSUPPORTED_AUDIO)
        return PaperInspection(
            file_type=AUDIO_LABELS.get(audio, "audio"),
            pages=None,
            role="answer_sheet",
            max_pdf_pages=settings.max_pdf_pages,
            message="Voice answer - transcribed and mapped to the rubric questions after upload.",
        )
    mime_type = uploads.sniff_mime(head)
    if mime_type is None or mime_type not in settings.allowed_mime_types:
        raise ApiError(415, UNSUPPORTED_DETAIL, "unsupported_signature")
    label = MIME_LABELS.get(mime_type, mime_type)
    if mime_type == "application/pdf":
        texts, pages = _pdf_texts(data)
        return classify(texts, file_type=label, pages=pages, settings=settings)
    if mime_type == DOCX_MIME:
        texts, pages, too_long = _docx_texts(data)
        return classify(texts, file_type=label, pages=pages, settings=settings, too_long=too_long)
    return PaperInspection(
        file_type=label,
        pages=1,
        role="unknown",
        max_pdf_pages=settings.max_pdf_pages,
        message=(
            "Photo or scan - the vision model reads it after upload (handwriting, or ticked options on a "
            "printed paper)."
        ),
    )


def ingestion_hint(data: bytes, mime_type: str, settings: Settings) -> str | None:
    """One Ingestion log line for a printed MCQ paper or a question paper with its answer key;
    None otherwise. Never raises: the hint must not affect the upload."""
    if mime_type not in ("application/pdf", DOCX_MIME):
        return None
    try:
        result = inspect_bytes(data, settings)
    except Exception as exc:  # noqa: BLE001 - a hint only
        logger.debug("Paper detection skipped: %s", exc)
        return None
    if result.role == "question_paper":
        return (
            f"Printed MCQ paper detected (about {_plural(result.numbered_questions, 'numbered question')}) - "
            "the student's ticked / circled / shaded options are read as answers."
        )
    if result.role == "answer_key_paper":
        return (
            f"This file looks like a question paper with its answer key "
            f"({_plural(result.answer_markers, 'answer marker')}) - if it is not a student's sheet, draft the "
            "rubric from it instead."
        )
    return None
