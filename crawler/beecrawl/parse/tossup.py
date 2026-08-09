"""Parse pyramidal tossups out of packet text.

A tossup is a paragraph of clues terminated by an `ANSWER:` line. Clues run
hardest-first; the final sentence is the giveaway and almost always opens with
a "For the point, name this ..." style prompt.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .clean import clean_text, split_sentences

# The answer line. Packets use ANSWER / ANS / A: with varying spacing, and
# occasionally bold markup survives extraction.
_ANSWER_LINE = re.compile(
    r"^[ \t]*(?:\*\*)?(?:ANSWER|ANS|Answer)(?:\*\*)?[ \t]*[:.–-][ \t]*(.+)$",
    re.MULTILINE,
)

# Leading question number: "1.", "12)", "(5)", "TU 3.", "Tossup 4 -"
_LEAD_NUMBER = re.compile(
    r"^\s*(?:(?:TU|Tossup|Question|Q)\s*)?\(?\d{1,3}\)?\s*[.)\-:]?\s*", re.IGNORECASE
)

# Where a tossup actually begins inside a chunk. IAC packets prefix each
# question with a bare point value "(5)" / "(10)"; some rounds label practice
# questions "Practice Question A - ". Cutting at the last such marker strips
# round preambles and any tail of the previous answer line.
_QUESTION_MARKER = re.compile(
    r"(?:(?:Practice\s+)?Question\s+[A-Z0-9]{1,3}\s*[-–—:.]\s*)|(?:\(\d{1,2}\)\s*)",
    re.IGNORECASE,
)

# True quizbowl bonus parts are marked "[10]" in square brackets. A
# parenthesised "(10)" in an IAC Bee packet is a point value, and the bare word
# "bonus" appears in ordinary history prose — the Bonus Army marched on
# Washington in 1932 — so neither may reject a question.
_BONUS_MARKER = re.compile(r"\[10\]|^\s*BONUS\b", re.IGNORECASE)

# The giveaway sentence in IAC/IHBB house style.
_GIVEAWAY_CUE = re.compile(
    r"\b(?:for (?:the point|10 points|ten points)|ftp|name this|identify this)\b",
    re.IGNORECASE,
)

# Alternate-answer markup inside the answer line:
#   Mali Empire [or Manden Kurufaba; accept Mali]
#   Israel (accept State of Israel; prompt on Palestine)
_BRACKETED = re.compile(r"[\[(]([^\])]*)[\])]")
_ALT_CUE = re.compile(r"^\s*(?:or|accept|also accept|equivalents?)\b\s*", re.IGNORECASE)

# Everything from here on in an answer note is an instruction to the moderator,
# not an accepted answer: "(or Feline; do not accept big cats like Lion)" must
# not turn "Lion" into a correct response. "prompt on X" likewise means ask for
# more, not accept.
_REJECTION_CUE = re.compile(
    r"\b(?:do\s+not|don'?t|never|reject|anti-?prompt|prompt\s+on|prompt|until\s+read|"
    r"before\s+mentioned|after\s+mentioned)\b",
    re.IGNORECASE,
)

# A leftover fragment that is prose about grading rather than an answer.
_INSTRUCTIONAL = re.compile(
    r"\b(?:mentioned|kinds?\s+of|specific|answer|read|underlined|require|any\s+of"
    r"|either|both|word\s+form)\b",
    re.IGNORECASE,
)

# Underlining in packets marks the required portion of the answer; extraction
# turns it into underscores often enough to be worth stripping.
_UNDERSCORE = re.compile(r"_+")

MIN_CLUES = 2
MIN_BODY_CHARS = 120
MAX_BODY_CHARS = 4000


@dataclass
class ParsedTossup:
    clues: list[tuple[str, str]]  # (tier, text) in reveal order
    answer: str
    alternates: list[str] = field(default_factory=list)
    raw: str = ""

    @property
    def body(self) -> str:
        return " ".join(text for _, text in self.clues)


def parse_answer_line(line: str) -> tuple[str, list[str]]:
    """Split an answer line into its primary answer and accepted alternates."""
    line = _UNDERSCORE.sub("", line).strip().rstrip(".")

    alternates: list[str] = []
    for group in _BRACKETED.findall(line):
        # Keep only the part before any "do not accept" / "prompt on" cue.
        cue = _REJECTION_CUE.search(group)
        acceptable = group[: cue.start()] if cue else group

        for piece in re.split(r"[;,]|\bor\b", acceptable):
            piece = _ALT_CUE.sub("", piece).strip(" .–-\"'")
            if len(piece) < 2 or len(piece.split()) > 6:
                continue
            if _INSTRUCTIONAL.search(piece):
                continue
            alternates.append(piece)

    primary = _BRACKETED.sub("", line).strip(" .;,")
    primary = re.sub(r"\s{2,}", " ", primary)

    # Some sets write "Mali Empire or Mali" with no brackets at all.
    if not alternates:
        parts = re.split(r"\s+or\s+", primary, maxsplit=1, flags=re.IGNORECASE)
        if len(parts) == 2 and parts[1].strip():
            primary, alternates = parts[0].strip(), [parts[1].strip()]

    seen: dict[str, None] = {}
    for alt in alternates:
        if alt.lower() != primary.lower():
            seen.setdefault(alt, None)
    return primary, list(seen)


def assign_tiers(sentences: list[str]) -> list[tuple[str, str]]:
    """Label sentences leadin / middle / giveaway.

    The last sentence is the giveaway when it carries the house-style cue;
    otherwise fall back to position. The first ~30% is the lead-in.
    """
    n = len(sentences)
    if n == 1:
        return [("giveaway", sentences[0])]
    if n == 2:
        return [("leadin", sentences[0]), ("giveaway", sentences[1])]

    giveaway_start = n - 1
    # A cue can appear one sentence early when the packet appends a
    # "This person's..." coda; scan the tail for the earliest cued sentence.
    for i in range(n - 1, max(n - 3, 0) - 1, -1):
        if _GIVEAWAY_CUE.search(sentences[i]):
            giveaway_start = i
            break

    leadin_end = max(1, round(giveaway_start * 0.34))
    tiers: list[tuple[str, str]] = []
    for i, sentence in enumerate(sentences):
        if i >= giveaway_start:
            tiers.append(("giveaway", sentence))
        elif i < leadin_end:
            tiers.append(("leadin", sentence))
        else:
            tiers.append(("middle", sentence))
    return tiers


def trim_to_question_start(body: str) -> str:
    """Drop round preambles and previous-answer spillover ahead of clue one.

    Cuts at the last question marker that still leaves a full-length question
    behind it, so a marker appearing inside real clue prose can't truncate it.
    """
    best = body
    for match in _QUESTION_MARKER.finditer(body):
        tail = body[match.end() :].strip()
        if len(tail) >= MIN_BODY_CHARS:
            best = tail
    return best


def _extend_wrapped_answer(text: str, start: int, answer_line: str) -> tuple[str, int]:
    """Absorb continuation lines of an answer whose brackets are still open.

    "ANSWER: Napoleon (accept Napoleon Bonaparte; accept Napoleon\\nthe Formidable)"
    would otherwise leave "the Formidable)" glued to the next question's lead-in.
    """
    cursor = start
    for _ in range(3):  # answers wrap at most a line or two in practice
        if answer_line.count("(") <= answer_line.count(")") and answer_line.count(
            "["
        ) <= answer_line.count("]"):
            break
        newline = text.find("\n", cursor)
        if newline == -1:
            break
        next_end = text.find("\n", newline + 1)
        if next_end == -1:
            next_end = len(text)
        continuation = text[newline + 1 : next_end].strip()
        if not continuation:
            break
        answer_line = f"{answer_line} {continuation}"
        cursor = next_end
    return answer_line, cursor


def _looks_like_tossup(body: str) -> tuple[bool, str]:
    if len(body) < MIN_BODY_CHARS:
        return False, "body too short"
    if len(body) > MAX_BODY_CHARS:
        return False, "body too long (likely multiple questions merged)"
    if _BONUS_MARKER.search(body):
        return False, "contains bonus-part markers"
    return True, ""


def parse_tossups(text: str) -> tuple[list[ParsedTossup], list[tuple[str, str]]]:
    """Parse every tossup in `text`.

    Returns `(parsed, rejected)` where each rejected entry is
    `(reason, raw_text)` for the quarantine table.
    """
    text = clean_text(text)
    parsed: list[ParsedTossup] = []
    rejected: list[tuple[str, str]] = []

    matches = list(_ANSWER_LINE.finditer(text))
    if not matches:
        return parsed, rejected

    cursor = 0
    for match in matches:
        if match.start() < cursor:
            continue  # already consumed as part of a wrapped answer line

        body_raw = text[cursor : match.start()]
        answer_line, cursor = _extend_wrapped_answer(text, match.end(), match.group(1).strip())

        # Everything after the previous answer line is the body; keep only the
        # final paragraph so stray headers between questions fall away.
        #
        # Joining all the paragraphs instead looks tempting — a question split
        # across a page break loses its stem — but these PDFs put a running
        # header in its own paragraph ("NHB Regional Bowl C JV Round 1 Page 8
        # of 10"), and `trim_to_question_start` cannot remove it because these
        # packets number questions "7." rather than "(7)". Joining glued that
        # header onto the lead-in of ~1,800 questions and, because it changed
        # their fingerprints, re-imported them all as near-copies.
        chunks = [c.strip() for c in re.split(r"\n\s*\n", body_raw) if c.strip()]
        if not chunks:
            rejected.append(("no body before ANSWER line", (body_raw + answer_line)[:2000]))
            continue
        body = " ".join(chunks[-1].split())
        body = trim_to_question_start(body)
        body = _LEAD_NUMBER.sub("", body)

        ok, reason = _looks_like_tossup(body)
        if not ok:
            rejected.append((reason, f"{body}\nANSWER: {answer_line}"[:2000]))
            continue

        sentences = split_sentences(body)
        if len(sentences) < MIN_CLUES:
            rejected.append(("fewer than two clue sentences", f"{body}\nANSWER: {answer_line}"))
            continue

        answer, alternates = parse_answer_line(answer_line)
        if not answer:
            rejected.append(("empty answer", f"{body}\nANSWER: {answer_line}"))
            continue

        parsed.append(
            ParsedTossup(
                clues=assign_tiers(sentences),
                answer=answer,
                alternates=alternates,
                raw=f"{body}\nANSWER: {answer_line}",
            )
        )

    return parsed, rejected
