"""Text normalization and sentence splitting shared by both parsers.

Packet PDFs arrive with soft hyphens, smart quotes, mojibake from bad encoding
round-trips, and (in some IHBB sets) a space between every character pair. All
of that has to go before sentence boundaries mean anything.
"""

from __future__ import annotations

import re
import unicodedata

# Mojibake seen in real IHBB/IAC packets, in the order it must be applied.
_MOJIBAKE = [
    ("â€™", "'"),
    ("â€œ", '"'),
    ("â€", '"'),
    ("â€“", "-"),
    ("â€”", "-"),
    ("â€˜", "'"),
    ("â€¦", "..."),
    ("Ã©", "e"),
]

_SMART = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'",
    "“": '"', "”": '"', "„": '"',
    "–": "-", "—": "-", "―": "-",
    "…": "...", " ": " ", "⁠": "", "­": "",
    "﻿": "", "​": "", "‌": "", "‍": "",
}

_WS = re.compile(r"[ \t ]+")
_BLANKS = re.compile(r"\n{3,}")

# Pronunciation guides the reader is meant to speak but that add noise to
# clue text: "Chartres (SHART-ruh)" or "[read slowly]".
_READER_NOTE = re.compile(r"\[(?:read|note|moderator|emphasize)[^\]]*\]", re.IGNORECASE)

# Moderator marks that must not reach the student. "(*)" and "(+)" are the
# power/bonus buzz points in IHBB packets; "[E]/[M]/[H]" are difficulty labels
# in the Quizbowl Packet Archive sets. Text-to-speech reads them aloud.
_MODERATOR_MARK = re.compile(r"\((?:\*|\+)\)|\[(?:E|M|H)\]|(?<=\s)\(\*\)")

# Some PDFs emit a combining accent *before* its letter, with a space:
# "prot ́eg ́e" instead of "protégé". Swap them back before NFC composition.
_LOOSE_ACCENT = re.compile(r"\s?([̀-ͯ])([A-Za-z])")

# "S p a c e d   o u t" text from certain PDF encoders: a run of single
# characters separated by spaces.
_SPACED_OUT = re.compile(r"(?:(?<=\s)|^)(?:\w\s){4,}\w(?=\s|$)")


def _despace(match: re.Match[str]) -> str:
    return match.group(0).replace(" ", "")


def clean_text(text: str) -> str:
    for bad, good in _MOJIBAKE:
        text = text.replace(bad, good)
    text = "".join(_SMART.get(ch, ch) for ch in text)
    # Reorder stray combining accents before composing, or NFC leaves them
    # dangling as their own characters.
    text = _LOOSE_ACCENT.sub(lambda m: f"{m.group(2)}{m.group(1)}", text)
    text = unicodedata.normalize("NFKC", text)
    text = unicodedata.normalize("NFC", text)
    text = _READER_NOTE.sub(" ", text)
    text = _MODERATOR_MARK.sub(" ", text)
    text = _SPACED_OUT.sub(_despace, text)
    # Pull a hyphenated word back onto one line, but keep the hyphen: dropping
    # it would turn "Six-\nDay War" into "SixDay War". A true justification
    # break uses a soft hyphen, which is already stripped above.
    text = re.sub(r"(\w)-[ \t]*\n[ \t]*(\w)", r"\1-\2", text)
    text = _WS.sub(" ", text)
    text = _BLANKS.sub("\n\n", text)
    return text.strip()


# Abbreviations whose trailing period must not end a sentence.
_ABBREV = (
    r"Mr|Mrs|Ms|Dr|Prof|St|Mt|Ft|Gen|Col|Sgt|Capt|Lt|Adm|Gov|Sen|Rep|Pres"
    r"|Jr|Sr|vs|etc|No|Vol|Ch|approx|ca|c|e\.g|i\.e|U\.S|U\.K|U\.S\.S\.R|A\.D|B\.C|B\.C\.E|C\.E"
)
_ABBREV_RE = re.compile(rf"(?:\b(?:{_ABBREV})|\b[A-Z])\.$", re.IGNORECASE)

_BOUNDARY = re.compile(r'(?<=[.!?])["\')\]]?\s+')


def split_sentences(text: str) -> list[str]:
    """Split prose into sentences, tolerating abbreviations and initials."""
    text = " ".join(text.split())
    if not text:
        return []

    pieces = _BOUNDARY.split(text)
    sentences: list[str] = []
    for piece in pieces:
        piece = piece.strip()
        if not piece:
            continue
        # An abbreviation or single-letter initial means the previous split was
        # spurious — glue this piece back onto the last one.
        if sentences and _ABBREV_RE.search(sentences[-1]):
            sentences[-1] = f"{sentences[-1]} {piece}"
        else:
            sentences.append(piece)
    return sentences
