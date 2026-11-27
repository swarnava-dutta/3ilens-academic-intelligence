"""Same-paper check: is a student's printed paper the rubric's paper, and the same version of it?

Answers are matched to rubric questions by number only, so a sheet printed from another paper - or
from another code / set of the same paper (NEET codes such as A / P / W carry the same questions in
a different order) - would be scored against the wrong key without any error. compare() lines up
the first words of each printed question (from the marked-option reader, mcq_marks, or from a PDF's
text layer, paper_detect.question_stems) with the rubric's question text, by number. Deterministic,
no AI call.

- Words: lower-case runs of 3+ letters / digits, a crude plural strip, minus a short stopword list
  (exam phrasing such as "which of the following" carries no paper identity).
- Similarity of a printed stem to a rubric question: the share of the stem's words that appear in
  the rubric question's prompt and options. One-sided on purpose: a rubric prompt drafted from
  the paper is often a shortened paraphrase, and a stem is only the first ~12 words.
- matched: the same number has similarity >= MATCH_SIMILARITY. moved: otherwise, when one OTHER
  rubric question clearly fits the stem (>= MOVED_SIMILARITY, ahead of the same number and of the
  next-best question by MOVED_MARGIN).
- verdict: unknown below MIN_COMPARED compared questions; match at >= MATCH_SHARE matched;
  reordered at >= REORDERED_SHARE moved; mismatch below MISMATCH_SHARE matched; unknown otherwise.
- Paper codes: the sheet's printed code against the rubric's paper_code (or a code named in the
  rubric name, e.g. "NEET 2016 Code A"). Two known codes with nothing in common turn an unknown
  text verdict into a mismatch, and are mentioned in the message otherwise.

shape_check() is the fallback when the question text cannot tell (a descriptive rubric has no
printed stems to compare): a printed paper with many numbered questions against a small rubric that
is not an MCQ rubric is not that paper's rubric. Its message states the fact only; a caller that
holds the sheet adds what to do about it.

paper_check() puts the two in one order for every caller (intake inspect, the upload hint, the
pipeline's text-layer check): the comparison's hold verdict, or its positive evidence (found_on_paper:
a "match", or an "unknown" over too few compared questions that nearly all matched - a rubric for one
short section of the paper), wins; the shape check runs only when the comparison found neither.

Calibrated on a scanned NEET 2016 paper (noisy two-column OCR text layer) and a typed NEET 2025
paper against AI-drafted rubrics of both: the scan against its own rubric reads as a match, the
typed paper against the 2016 rubric as a mismatch, and the scan against a copy of its rubric with
the questions shuffled within each subject (another code) as reordered.
"""
from __future__ import annotations

import re
from typing import Any

import marking
from schemas import RubricMatch

MIN_STEM_WORDS = 3          # a stem with fewer distinctive words is not compared
MIN_COMPARED = 8            # fewer compared questions -> unknown
MIN_RUBRIC_WORDS = 5        # a rubric question with fewer distinctive words (a typed summary) is not compared
MIN_RUBRIC_TEXT_SHARE = 0.5  # below this share of rubric questions with question text -> never hold
MATCH_SIMILARITY = 0.5
MOVED_SIMILARITY = 0.6
MOVED_MARGIN = 0.2
MATCH_SHARE = 0.6
REORDERED_SHARE = 0.4
MISMATCH_SHARE = 0.3
MAX_EXAMPLES = 3
EXAMPLE_CHARS = 48

HOLD_VERDICTS = ("reordered", "mismatch")

# shape_check(): a printed paper this long against a non-MCQ rubric covering under half of it.
SHAPE_MIN_QUESTIONS = 10
# The MCQ-heavy rule of mcq_marks.mcq_heavy (not imported: mcq_marks pulls in the AI layer).
MCQ_HEAVY_MIN_QUESTIONS = 10
MCQ_HEAVY_SHARE = 0.8

# Short function words are already dropped by the 3-character minimum.
_STOPWORDS = frozenset(
    """
    the and for are was were with that this which what when where who whom whose why how from into
    onto than then them they there their these those has have had been being its also can will would
    shall should may might must not but all any each other such only very more most some one his her
    you your our out per about above below over under between both either neither nor
    following given shown figure diagram statement statements correct incorrect true false option
    options choose select answer answers question questions consider respectively among find
    calculate value values
    """.split()
)
_WORD = re.compile(r"[^\W_]{3,}")

# Paper codes. Keyword forms: "Test Booklet Code: P", "Question Paper Code A/P/W", "CODE - 45",
# "Set No. 2", "Paper Set B". The code itself is an upper-case letter with up to 2 digits ("A",
# "E1") or a number of up to 3 digits, optionally several joined by "/" ("A/P/W").
_CODE_TOKEN = r"(?:[A-Z]\d{0,2}|\d{1,3})"
_CODE_VALUE = rf"{_CODE_TOKEN}(?:[ \t]*/[ \t]*{_CODE_TOKEN})*"
_CODE_KEYWORD = (
    r"(?i:(?:test[ \t]+)?booklet[ \t]+code|(?:question[ \t]+)?paper[ \t]+code|q\.?[ \t]*p\.?[ \t]*code|"
    r"code|(?:paper[ \t]+)?set(?:[ \t]+no\.?)?|version)"
)
_CODE = re.compile(
    rf"(?<![\w.])(?P<keyword>{_CODE_KEYWORD})(?![\w])[ \t]*(?:[:#\-–—.][ \t]*)*\n?[ \t]*(?:[:#\-–—.][ \t]*)*"
    rf"(?P<code>{_CODE_VALUE})(?![\w/])"
    # Not the column header of a "match the columns" question ("Code:\nA B C D", "Code: 1 2 3 4",
    # "Code:\nA\nB\nC\nD").
    r"(?![ \t]+(?:[A-Za-z]|\d|[ivxIVX]{1,4}|\(\w{1,4}\))(?![\w/]))"
    r"(?![ \t]*\n[ \t]*(?:[A-Da-d]|[ivxIVX]{1,4})[ \t]*(?:\n|$))"
)
# Words before "code" / "set" that make it something else ("Pin Code 324005", "Centre Code 12").
_NOT_PAPER = re.compile(
    r"(?i:\b(?:pin|postal|zip|std|centre|center|roll|course|subject|access|promo|coupon|discount|area|"
    r"country|dial|bar|qr|colou?r|data|tool)\W*$)"
)
_BARE_CODE = re.compile(rf"^\s*(?P<code>{_CODE_VALUE})\s*$")


# --------------------------------------------------------------------------- #
# Text
# --------------------------------------------------------------------------- #
def _stem_word(word: str) -> str:
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 4 and word.endswith(("sses", "xes", "ches", "shes")):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith(("ss", "us", "is")):
        return word[:-1]
    return word


def words(text: Any) -> set[str]:
    """Distinctive words of a text: lower-case runs of 3+ letters / digits, plural-stripped,
    without stopwords."""
    if not isinstance(text, str) or not text:
        return set()
    out = set()
    for raw in _WORD.findall(text.casefold()):
        if raw in _STOPWORDS:
            continue
        word = _stem_word(raw)
        if word not in _STOPWORDS:
            out.add(word)
    return out


def similarity(stem_words: set[str], rubric_words: set[str]) -> float:
    """Share of the stem's words found in the rubric question's words."""
    if not stem_words:
        return 0.0
    return len(stem_words & rubric_words) / len(stem_words)


def _short(text: str, limit: int = EXAMPLE_CHARS) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 3].rstrip() + "..."


def _number(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        number = int(str(value).strip()) if isinstance(value, str) else int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _rubric_texts(rubric_content: dict | None) -> tuple[dict[int, set[str]], dict[int, str]]:
    """({number: words of prompt + options}, {number: prompt}) for rubric questions with text."""
    questions = rubric_content.get("questions") if isinstance(rubric_content, dict) else None
    texts: dict[int, set[str]] = {}
    prompts: dict[int, str] = {}
    for question in questions or []:
        if not isinstance(question, dict):
            continue
        number = _number(question.get("question"))
        if number is None or number in texts:
            continue
        prompt = question.get("prompt") if isinstance(question.get("prompt"), str) else ""
        options = question.get("options") if isinstance(question.get("options"), list) else []
        found = words(prompt) | words(" ".join(str(o) for o in options if isinstance(o, (str, int, float))))
        if len(found) >= MIN_RUBRIC_WORDS:
            texts[number] = found
            prompts[number] = prompt
    return texts, prompts


# --------------------------------------------------------------------------- #
# Paper codes
# --------------------------------------------------------------------------- #
def _code_tokens(value: str) -> list[str]:
    tokens = []
    for raw in value.split("/"):
        token = raw.strip().upper()
        if token.isdigit():
            token = str(int(token))
        if token and token not in tokens:
            tokens.append(token)
    return tokens


def _find(text: Any) -> tuple[str, bool] | None:
    """(canonical code, named as a set) of the most frequent printed code; None when there is none."""
    if not isinstance(text, str) or not text:
        return None
    counts: dict[str, int] = {}
    order: list[str] = []
    sets: dict[str, bool] = {}
    for match in _CODE.finditer(text):
        keyword = match.group("keyword")
        if keyword[:1].islower():
            continue  # "a set of 4 resistors", "the genetic code" - prose, not a printed header
        if _NOT_PAPER.search(text[max(0, match.start() - 20): match.start()]):
            continue
        code = "/".join(_code_tokens(match.group("code")))
        if not code:
            continue
        if code not in counts:
            order.append(code)
            sets[code] = "set" in keyword.casefold() and "code" not in keyword.casefold()
        counts[code] = counts.get(code, 0) + 1
    if not counts:
        return None
    code = max(order, key=lambda item: (counts[item], -order.index(item)))
    return code, sets[code]


def find_code(text: Any) -> str | None:
    """The paper code / set printed in a text ("Test Booklet Code: P" -> "P", "CODE - 45" -> "45",
    "Paper Code A/P/W" -> "A/P/W", "Set 2" -> "2"): the most frequent one (page headers repeat it),
    the first on a tie; None when there is none. Lower-case "code" / "set" is prose and never counts."""
    found = _find(text)
    return found[0] if found else None


def code_label(text: Any) -> str | None:
    """find_code() for display: "Code 45", "Code A/P/W", "Set 2"."""
    found = _find(text)
    if found is None:
        return None
    code, is_set = found
    return f"{'Set' if is_set else 'Code'} {code}"


def normalise_code(value: Any) -> str | None:
    """A paper code in canonical form ("Code A" -> "A", "CODE - 45" -> "45", "045" -> "45",
    "A / P / W" -> "A/P/W", "set b" -> "B"); None when the value names no code."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().upper()  # a typed name or a reader's reply may say "code a" / "set b"
    bare = _BARE_CODE.match(text)
    if bare is not None:
        return "/".join(_code_tokens(bare.group("code")))
    return find_code(text)


def codes_differ(sheet_code: str | None, rubric_code: str | None) -> bool:
    """Both codes known and no code in common ("A" vs "A/P/W" is the same booklet family)."""
    if not sheet_code or not rubric_code:
        return False
    return not set(sheet_code.split("/")) & set(rubric_code.split("/"))


def rubric_code(rubric_content: dict | None) -> str | None:
    """The rubric's paper_code, else a code named in the rubric name ("NEET 2016 Code A")."""
    if not isinstance(rubric_content, dict):
        return None
    return normalise_code(rubric_content.get("paper_code")) or find_code(rubric_content.get("name"))


# --------------------------------------------------------------------------- #
# Comparison
# --------------------------------------------------------------------------- #
def _plural(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


def compare(stems: dict[int, str], rubric_content: dict, *, sheet_code: str | None = None) -> RubricMatch:
    """How the printed question stems (by number) line up with the rubric's questions."""
    rubric_words, rubric_prompts = _rubric_texts(rubric_content)
    sheet: dict[int, tuple[set[str], str]] = {}
    for key, stem in (stems or {}).items():
        number = _number(key)
        if number is None or not isinstance(stem, str):
            continue
        found = words(stem)
        if len(found) >= MIN_STEM_WORDS:
            sheet[number] = (found, stem)

    matched = 0
    moved: list[tuple[int, int]] = []
    unmatched: list[int] = []
    compared = sorted(n for n in sheet if n in rubric_words)
    for number in compared:
        stem_words = sheet[number][0]
        same = similarity(stem_words, rubric_words[number])
        if same >= MATCH_SIMILARITY:
            matched += 1
            continue
        best, best_number, second = 0.0, None, 0.0
        for other, other_words in rubric_words.items():
            if other == number:
                continue
            score = similarity(stem_words, other_words)
            if score > best:
                best, best_number, second = score, other, best
            elif score > second:
                second = score
        if (
            best_number is not None and best >= MOVED_SIMILARITY
            and best - same >= MOVED_MARGIN and best - second >= MOVED_MARGIN
        ):
            moved.append((number, best_number))
        else:
            unmatched.append(number)

    sheet_norm = normalise_code(sheet_code)
    rubric_norm = rubric_code(rubric_content)
    differ = codes_differ(sheet_norm, rubric_norm)
    total = len(compared)
    questions = [q for q in (rubric_content or {}).get("questions") or [] if isinstance(q, dict)]
    # Typed summaries instead of the printed question text: the comparison cannot tell, so never hold.
    text_rich = bool(questions) and len(rubric_words) >= MIN_RUBRIC_TEXT_SHARE * len(questions)

    if total < MIN_COMPARED or not text_rich:
        verdict = "unknown"
    elif matched >= MATCH_SHARE * total:
        verdict = "match"
    elif len(moved) >= REORDERED_SHARE * total:
        verdict = "reordered"
    elif matched < MISMATCH_SHARE * total:
        verdict = "mismatch"
    else:
        verdict = "unknown"

    # One subject block in another order (a version that shuffles only Physics) hides in the
    # overall share: check each subject block on its own.
    block_note = ""
    if verdict == "match" and text_rich:
        subject_of = {_number(q.get("question")): str(q.get("subject") or "") for q in questions}
        moved_numbers = {n for n, _ in moved}
        blocks: dict[str, list[int]] = {}
        for number in compared:
            blocks.setdefault(subject_of.get(number, ""), []).append(number)
        for subject, numbers in blocks.items():
            block_moved = sum(1 for n in numbers if n in moved_numbers)
            if len(numbers) >= MIN_COMPARED and block_moved >= REORDERED_SHARE * len(numbers):
                verdict = "reordered"
                block_note = f" in {subject or 'one section'}"
                break
    # Two known printed codes that differ: another version even when the text lines up (some
    # versions shuffle only the options), so hold it for review.
    if verdict == "match" and differ:
        verdict = "reordered"

    code_note = f"its paper code ({sheet_norm}) differs from the rubric's ({rubric_norm})" if differ else ""
    if verdict == "match":
        message = (
            f"The sheet's printed questions match the rubric ({matched} of {total} compared)"
            + (f", but {code_note}" if differ else "") + "."
        )
    elif verdict == "reordered" and not moved:
        message = (
            f"The sheet's printed questions match the rubric ({matched} of {total} compared), but {code_note} - "
            f"it looks like another version of the paper (options may be in another order); grade it with "
            f"the rubric for code {sheet_norm}."
        )
    elif verdict == "reordered":
        sheet_q, rubric_q = moved[0]
        message = (
            f"The sheet has the rubric's questions in a different order{block_note} (e.g. sheet Q{sheet_q} is "
            f"rubric Q{rubric_q})" + (f" and {code_note}" if differ else "")
            + " - probably another code or set of this paper; grade it with the rubric for that version."
        )
    elif verdict == "mismatch":
        message = (
            f"The sheet's printed questions do not match the rubric ({matched} of {total} compared)"
            + (f" and {code_note}" if differ else "") + " - it looks like a different paper."
        )
    elif differ:
        verdict = "mismatch"
        message = (
            f"The sheet's printed paper code ({sheet_norm}) differs from the rubric's ({rubric_norm}) - "
            f"it looks like another version of the paper; grade it with the rubric for code {sheet_norm}."
        )
    elif total and matched >= MATCH_SHARE * total:
        # Too few compared (a rubric for one short section) or too little rubric text to be sure, but
        # what was compared is printed on this paper (found_on_paper).
        message = (
            f"The sheet's printed questions match the rubric ({matched} of {total} compared) - too few to "
            "confirm the paper and its version."
        )
    elif not rubric_words or not text_rich:
        message = "The rubric has no question text to check the sheet's printed questions against."
    elif total < MIN_COMPARED:
        message = (
            f"Too little printed question text to check the sheet against the rubric "
            f"({_plural(total, 'question')} compared)."
        )
    else:
        message = (
            f"The sheet's printed questions only partly match the rubric ({matched} of {total} compared) - "
            "check that it is the same paper and version."
        )

    # Up to MAX_EXAMPLES lines: questions found under another number first for a reordered sheet,
    # questions whose text differs first otherwise.
    moved_lines = [f"Sheet Q{s} '{_short(sheet[s][1])}' is rubric Q{r}." for s, r in moved[:MAX_EXAMPLES]]
    differ_lines = [
        f"Q{n}: sheet '{_short(sheet[n][1])}' vs rubric '{_short(rubric_prompts.get(n, ''))}'."
        for n in unmatched[:MAX_EXAMPLES]
    ]
    ordered = moved_lines + differ_lines if verdict == "reordered" else differ_lines + moved_lines
    examples = ordered[:MAX_EXAMPLES]
    return RubricMatch(
        verdict=verdict,  # type: ignore[arg-type]
        compared=total,
        matched=matched,
        moved=len(moved),
        sheet_code=sheet_norm,
        rubric_code=rubric_norm,
        examples=examples,
        message=message,
    )


# --------------------------------------------------------------------------- #
# Shape check (no question text needed)
# --------------------------------------------------------------------------- #
def _mcq_note(total: int, mcqs: int) -> str:
    if total == 1:
        return "1 question, an MCQ" if mcqs else "1 question, not an MCQ"
    if mcqs == 0:
        return f"{total} questions, none of them MCQs"
    if mcqs == total:
        return f"{total} questions, all of them MCQs"
    return f"{total} questions, {mcqs} of them {'an MCQ' if mcqs == 1 else 'MCQs'}"


def shape_check(
    numbered_questions: int, rubric_content: dict | None, *, rubric_label: str | None = None
) -> RubricMatch | None:
    """A printed paper (paper_detect: question_paper / answer_key_paper) against a rubric that cannot
    be its rubric: at least SHAPE_MIN_QUESTIONS numbered questions, a rubric that is not MCQ-heavy
    (mcq_marks.mcq_heavy: >= 10 questions, >= 80% MCQs) and covers fewer than half of them. A
    "mismatch" RubricMatch (nothing compared, no printed code: see structural) in that case; None
    otherwise, also for an empty rubric. rubric_label names the rubric in the message ("'Biology -
    Genetics' (v1)"). The message states the fact only - it is also shown before the file is uploaded;
    a caller that holds the sheet adds what to do (pipeline.document_paper_check)."""
    raw = rubric_content.get("questions") if isinstance(rubric_content, dict) else None
    questions = [q for q in raw or [] if isinstance(q, dict)]
    try:
        printed = int(numbered_questions)
    except (TypeError, ValueError):
        return None
    if not questions or printed < SHAPE_MIN_QUESTIONS:
        return None
    mcqs = sum(1 for q in questions if marking.question_type(q) == "mcq")
    if len(questions) >= MCQ_HEAVY_MIN_QUESTIONS and mcqs >= MCQ_HEAVY_SHARE * len(questions):
        return None  # an MCQ rubric: the printed-question comparison decides
    if len(questions) * 2 >= printed:
        return None
    name = f"rubric {rubric_label}" if rubric_label else "the selected rubric"
    message = (
        f"This is a printed question paper with about {printed} numbered questions, but {name} has "
        f"{_mcq_note(len(questions), mcqs)} - it is not this paper's rubric."
    )
    return RubricMatch(
        verdict="mismatch", compared=0, matched=0, moved=0, sheet_code=None,
        rubric_code=rubric_code(rubric_content), examples=[], message=message,
    )


def structural(match: RubricMatch | None) -> bool:
    """A shape_check() verdict: a mismatch with nothing compared and no printed sheet code. compare()
    never returns one - its hold verdicts with nothing compared come from two differing printed codes,
    so they carry the sheet's code."""
    return match is not None and match.verdict == "mismatch" and match.compared == 0 and not match.sheet_code


# --------------------------------------------------------------------------- #
# The verdict of a printed paper against a rubric (comparison first, then shape)
# --------------------------------------------------------------------------- #
def found_on_paper(match: RubricMatch | None) -> bool:
    """The comparison found the rubric's questions printed on the sheet: a "match", or an "unknown"
    that compared at least one question and matched at least MATCH_SHARE of them (fewer than
    MIN_COMPARED compared - a rubric for one short section of the paper - or too little rubric text to
    be sure). Such a rubric is never called another paper's by its shape."""
    if match is None:
        return False
    if match.verdict == "match":
        return True
    return match.verdict == "unknown" and match.compared > 0 and match.matched >= MATCH_SHARE * match.compared


def paper_check(
    match: RubricMatch | None, numbered_questions: int, rubric_content: dict | None, *,
    rubric_label: str | None = None,
) -> RubricMatch | None:
    """One order for intake inspect, the upload hint and the pipeline's text-layer check: the
    comparison (compare() of the printed stems, or None without stems) when it holds (reordered /
    mismatch) or found the rubric's questions on the paper (found_on_paper); else shape_check when it
    calls the rubric another paper's; else the comparison as it is (unknown, or None)."""
    if match is not None and (match.verdict in HOLD_VERDICTS or found_on_paper(match)):
        return match
    return shape_check(numbered_questions, rubric_content, rubric_label=rubric_label) or match
