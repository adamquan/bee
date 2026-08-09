"""Parse multiple-choice questions out of exam text.

Target shape (National History Bee Online Regional Qualifying Exam and the
examples in bee.md):

    Question 1: U.S. History
    Which standard United States military rifle ...?
    A. M1 Garand
    B. M1903 Springfield
    C. M1 Carbine
    D. Thompson Submachine Gun
    Correct Answer: A. M1 Garand

Like the tossup parser, this splits the document at answer lines — each block
is one question — so a malformed question can't swallow its neighbours.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .clean import clean_text

# "A. text", "A) text", "(A) text" at the start of a line.
_OPTION = re.compile(r"^[ \t]*\(?([A-Ea-e])[.)\]][ \t]+(.{1,300}?)[ \t]*$", re.MULTILINE)

# The answer line; the payload is parsed separately so a text-only answer
# beginning with a letter ("Amazon") is not mistaken for the label "A".
_ANSWER_LINE = re.compile(
    r"^[ \t]*(?:Correct[ \t]+)?(?:ANSWER|ANS|Answer)[ \t]*[:.\-–][ \t]*(.+)$",
    re.MULTILINE | re.IGNORECASE,
)
_LABEL_ONLY = re.compile(r"^\(?([A-Ea-e])\)?[.):]?$")
_LABEL_AND_TEXT = re.compile(r"^\(?([A-Ea-e])\)?[.):]\s+(.+)$")

# "Question 1: U.S. History" style headers that sit above the stem.
_QUESTION_HEADER = re.compile(
    r"^[ \t]*(?:Question|Q|Item)[ \t]*\d{1,3}[ \t]*[:.)\-][ \t]*[^?]{0,60}$",
    re.IGNORECASE,
)
# Bare section headers between questions.
_SECTION_HEADER = re.compile(
    r"^[ \t]*(?:(?:U\.?S\.?|World|Ancient|European|Modern)[ \t]+)?History[ \t]*$"
    r"|^[ \t]*Section[ \t]+\w+[ \t]*$"
    r"|^[ \t]*Page[ \t]+\d+.*$",
    re.IGNORECASE,
)
_LEAD_NUMBER = re.compile(r"^[ \t]*(?:(?:Question|Q)[ \t]*)?\d{1,3}[ \t]*[.)\-:][ \t]*", re.IGNORECASE)

MIN_OPTIONS = 3
MIN_STEM_CHARS = 20


@dataclass
class ParsedMCQ:
    stem: str
    options: list[tuple[str, str, bool]]  # (label, text, is_correct)
    answer: str
    raw: str = ""


def _clean_stem(region: str) -> str:
    lines = [ln.strip() for ln in region.splitlines() if ln.strip()]
    kept = [
        ln for ln in lines if not _QUESTION_HEADER.match(ln) and not _SECTION_HEADER.match(ln)
    ]
    stem = " ".join(kept)
    stem = _LEAD_NUMBER.sub("", stem).strip()
    return " ".join(stem.split())


def _parse_answer_payload(payload: str) -> tuple[str | None, str]:
    """Split an answer payload into `(label, text)`; either may be absent."""
    payload = payload.strip().rstrip(".")
    m = _LABEL_ONLY.match(payload)
    if m:
        return m.group(1).upper(), ""
    m = _LABEL_AND_TEXT.match(payload)
    if m:
        return m.group(1).upper(), m.group(2).strip()
    return None, payload


def parse_mcqs(text: str) -> tuple[list[ParsedMCQ], list[tuple[str, str]]]:
    """Parse every MCQ in `text`. Returns `(parsed, rejected_for_quarantine)`."""
    text = clean_text(text)
    parsed: list[ParsedMCQ] = []
    rejected: list[tuple[str, str]] = []

    cursor = 0
    for match in _ANSWER_LINE.finditer(text):
        block = text[cursor : match.end()]
        cursor = match.end()

        options: list[tuple[str, str]] = []
        seen: set[str] = set()
        for m in _OPTION.finditer(block):
            label = m.group(1).upper()
            if label in seen:
                break  # a second 'A' means the next question's options
            seen.add(label)
            options.append((label, m.group(2).strip()))

        if len(options) < MIN_OPTIONS:
            # Not an MCQ (a tossup answer line, a rules doc). Skip quietly —
            # quarantining every non-MCQ answer line would drown the signal.
            continue

        first_option = _OPTION.search(block)
        stem = _clean_stem(block[: first_option.start()] if first_option else "")
        if len(stem) < MIN_STEM_CHARS:
            rejected.append(("MCQ stem missing or too short", block[:2000]))
            continue

        label, answer_text = _parse_answer_payload(match.group(1))
        option_map = {l: t for l, t in options}

        if label and label in option_map:
            answer = option_map[label]
        elif answer_text:
            hit = next((t for _, t in options if t.lower() == answer_text.lower()), None)
            if hit is None:
                rejected.append(("MCQ answer does not match any option", block[:2000]))
                continue
            answer = hit
            label = next(l for l, t in options if t == hit)
        else:
            rejected.append(("MCQ answer line unparseable", block[:2000]))
            continue

        parsed.append(
            ParsedMCQ(
                stem=stem,
                options=[(l, t, l == label) for l, t in options],
                answer=answer,
                raw=block[:2000],
            )
        )

    return parsed, rejected
