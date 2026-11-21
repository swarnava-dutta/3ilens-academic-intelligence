"""Bloom's taxonomy levels K1-K5 for rubric questions (FR-3.9). Pure module (re, typing).

A level comes from the rubric (set by faculty, or AI-suggested and accepted) or, when the
rubric has none, from a verb heuristic over the question prompt. The heuristic is a labelled
fallback ("heuristic"), not a judgement: the highest-level verb found in the prompt wins.
"""
from __future__ import annotations

import re
from typing import Any

LEVELS: tuple[str, ...] = ("K1", "K2", "K3", "K4", "K5")
LABELS: dict[str, str] = {
    "K1": "Remember",
    "K2": "Understand",
    "K3": "Apply",
    "K4": "Analyse",
    "K5": "Evaluate",
}
RECALL_LEVELS: tuple[str, ...] = ("K1", "K2")
TRANSFER_LEVELS: tuple[str, ...] = ("K3", "K4", "K5")
SOURCES: tuple[str, ...] = ("faculty", "ai", "heuristic")
DEFAULT_LEVEL = "K2"

# Verbs / phrases per level, matched as whole words, case-insensitive. Highest matching level wins.
VERBS: dict[str, tuple[str, ...]] = {
    "K1": ("define", "state", "name", "list", "identify", "recall", "label", "mention", "what is", "what are"),
    "K2": (
        "describe", "explain", "distinguish", "differentiate", "compare", "summarise", "summarize", "outline",
        "classify", "illustrate", "discuss", "interpret", "give an example", "give one example",
    ),
    "K3": (
        "calculate", "compute", "solve", "apply", "derive", "determine", "find", "predict", "show", "work out",
        "using", "construct", "draw", "sketch", "convert",
    ),
    "K4": (
        "analyse", "analyze", "deduce", "infer", "examine", "why is", "why does", "why do", "account for",
        "contrast", "relate", "investigate",
    ),
    "K5": ("evaluate", "justify", "assess", "critique", "critically", "judge", "recommend", "defend", "argue",
           "to what extent"),
}

# One sentence per level; the grading prompt carries it for level-aware grading.
GUIDANCE: dict[str, str] = {
    "K1": "Recall: award each mark for an accurate fact, term or definition named in the criteria; brevity is fine.",
    "K2": (
        "Understanding: award for explaining relationships in the student's own words; a correct term without "
        "explanation earns only its recall share."
    ),
    "K3": (
        "Application: award method marks for a correct set-up (cross, formula, substitution) even if later "
        "arithmetic slips; the final answer and units earn the final step."
    ),
    "K4": (
        "Analysis: reward comparisons and cause-effect reasoning on the stated bases; listing facts without "
        "relating them earns partial credit only."
    ),
    "K5": "Evaluation: reward a justified judgement that weighs evidence; an unsupported verdict earns no judgement marks.",
}

_NAMES: dict[str, str] = {
    "remember": "K1", "knowledge": "K1", "recall": "K1",
    "understand": "K2", "comprehension": "K2", "understanding": "K2",
    "apply": "K3", "application": "K3",
    "analyse": "K4", "analyze": "K4", "analysis": "K4",
    "evaluate": "K5", "evaluation": "K5",
}
_PATTERNS: dict[str, list[tuple[str, re.Pattern[str]]]] = {
    level: [(verb, re.compile(r"\b" + r"\s+".join(map(re.escape, verb.split())) + r"\b", re.IGNORECASE))
            for verb in verbs]
    for level, verbs in VERBS.items()
}


def parse_level(raw: Any) -> str | None:
    """'K3', 'k3', '3', 3, 'apply', 'Application' -> 'K3'. None when unrecognised."""
    if raw is None or isinstance(raw, bool):
        return None
    text = str(raw).strip().casefold()
    if not text:
        return None
    match = re.fullmatch(r"k?\s*([1-5])", text)
    if match:
        return f"K{match.group(1)}"
    return _NAMES.get(text)


def _prompt_of(question: dict[str, Any] | None) -> str:
    if not isinstance(question, dict):
        return ""
    return " ".join(str(question.get("prompt") or "").split())


def heuristic_level(question: dict[str, Any] | None) -> tuple[str, str]:
    """(level, rationale) from the verbs in the question prompt; K2 when nothing matches."""
    prompt = _prompt_of(question)
    if prompt:
        for level in reversed(LEVELS):
            for verb, pattern in _PATTERNS[level]:
                if pattern.search(prompt):
                    return level, f"Verb '{verb}' -> {level} {LABELS[level]} (heuristic)"
    return DEFAULT_LEVEL, f"No level verb found - defaulted to {DEFAULT_LEVEL} {LABELS[DEFAULT_LEVEL]} (heuristic)"


def resolve_levels(rubric_content: dict[str, Any] | None) -> dict[int, tuple[str, str]]:
    """{question_number: (level, source)}: the rubric's level (source bloom_source or 'faculty')
    when it is valid, else the heuristic level with source 'heuristic'."""
    out: dict[int, tuple[str, str]] = {}
    questions = (rubric_content or {}).get("questions") if isinstance(rubric_content, dict) else None
    for q in questions or []:
        if not isinstance(q, dict):
            continue
        try:
            number = int(q.get("question"))
        except (TypeError, ValueError):
            continue
        level = parse_level(q.get("bloom_level"))
        if level is not None:
            source = q.get("bloom_source") if q.get("bloom_source") in ("faculty", "ai") else "faculty"
            out[number] = (level, source)
        else:
            out[number] = (heuristic_level(q)[0], "heuristic")
    return out


def concept_key(question: dict[str, Any] | None) -> str:
    """The concept a question tests: rubric concept, else chapter, else topic (whitespace-normalised)."""
    if not isinstance(question, dict):
        return ""
    for key in ("concept", "chapter", "topic"):
        value = " ".join(str(question.get(key) or "").split())
        if value:
            return value
    return ""


def is_transfer(level: str | None) -> bool:
    return parse_level(level) in TRANSFER_LEVELS


def label(level: str | None) -> str:
    """'K3 Apply' (empty string for an unknown level)."""
    parsed = parse_level(level)
    return f"{parsed} {LABELS[parsed]}" if parsed else ""
