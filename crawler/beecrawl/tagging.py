"""Keyword-based category tagging, used when Claude enrichment is unavailable.

Every question needs categories for the filter UI and the weak-area analysis to
work at all (bee.md requirements 3 and 5). Claude does this far better, but it
needs an API key — so questions also get a keyword pass at parse time. Claude
enrichment later replaces these tags outright rather than merging, so a wrong
guess here is corrected rather than compounded.
"""

from __future__ import annotations

import re
from typing import Iterable

# name -> the terms that imply it. Deliberately high-precision: it is better to
# leave a question with two broad tags than to bury it under wrong ones.
RULES: dict[str, tuple[str, ...]] = {
    "US History": (
        "united states", "american", "america", "congress", "president", "washington",
        "lincoln", "jefferson", "confederate", "union army", "colonies", "yankee",
        "u.s.", "new york", "california", "virginia", "roosevelt", "white house",
    ),
    "European History": (
        "europe", "france", "french", "britain", "british", "england", "english",
        "germany", "german", "spain", "spanish", "italy", "italian", "russia",
        "russian", "poland", "prussia", "habsburg", "papal", "scandinav", "dutch",
    ),
    "Asian History": (
        "china", "chinese", "japan", "japanese", "korea", "india", "indian",
        "mongol", "vietnam", "dynasty of", "shogun", "samurai", "mughal", "silk road",
    ),
    "African History": (
        "africa", "african", "egypt", "mali", "songhai", "ghana", "ethiopia",
        "zulu", "swahili", "carthage", "nile",
    ),
    "Latin American History": (
        "mexico", "mexican", "brazil", "argentina", "peru", "aztec", "inca", "maya",
        "bolivar", "latin america", "caribbean", "cuba",
    ),
    "Middle Eastern History": (
        "ottoman", "persia", "iran", "iraq", "israel", "arab", "mesopotamia",
        "babylon", "assyria", "sumer", "islamic caliphate", "baghdad", "jerusalem",
    ),
    "Ancient World": (
        "ancient", "rome", "roman", "greece", "greek", "athens", "sparta", "pharaoh",
        "mesopotamia", "sumer", "babylon", "b.c.", "bce", "hellenistic", "punic",
    ),
    "Middle Ages": (
        "medieval", "middle ages", "feudal", "crusade", "knight", "byzantine",
        "charlemagne", "viking", "norman", "magna carta", "black death",
    ),
    "Renaissance": ("renaissance", "medici", "michelangelo", "leonardo da vinci", "humanis"),
    "Exploration": (
        "explorer", "voyage", "columbus", "magellan", "circumnavigat", "conquistador",
        "new world", "expedition", "cartograph",
    ),
    "Revolutions": (
        "revolution", "revolt", "uprising", "rebellion", "bastille", "jacobin",
        "bolshevik", "independence movement",
    ),
    "World Wars": (
        "world war", "wwi", "wwii", "ww1", "ww2", "nazi", "hitler", "pearl harbor",
        "d-day", "holocaust", "trench", "blitz", "allied powers", "axis powers",
        # Not a bare "versailles" — the palace belongs to Louis XIV, not 1919.
        "treaty of versailles",
    ),
    "Empires": ("empire", "imperial", "colony", "colonial", "emperor", "empress", "caliphate"),
    "Leaders": (
        "president", "king", "queen", "emperor", "empress", "prime minister",
        "chancellor", "dictator", "pharaoh", "sultan", "tsar", "czar", "general",
    ),
    "Religions": (
        "church", "christian", "catholic", "protestant", "islam", "muslim", "buddhis",
        "hindu", "jewish", "judaism", "pope", "monk", "temple", "prophet", "bible",
        "quran", "reformation",
    ),
    "Art History": (
        "painting", "painter", "sculpture", "artist", "fresco", "portrait",
        "impressionis", "baroque", "architect", "cathedral", "mural",
    ),
    "Sports History": ("olympic", "world cup", "baseball", "football", "boxing", "athlete"),
    "Literature History": (
        "novel", "poet", "poem", "playwright", "shakespeare", "author", "wrote the book",
        "epic", "literature",
    ),
    "Science History": (
        "scientist", "physicist", "chemist", "biologist", "invention", "inventor",
        "telescope", "vaccine", "discovered the element", "theory of", "astronom",
    ),
    "Military History": (
        "battle", "siege", "army", "navy", "regiment", "cavalry", "artillery",
        "campaign", "war ", "soldier", "fleet", "musket", "infantry",
    ),
    "Economic History": (
        "trade", "tariff", "economy", "economic", "depression", "bank", "currency",
        "merchant", "industrial", "labor union", "stock market",
    ),
    "Mythology": (
        "myth", "god of", "goddess", "zeus", "odin", "norse", "olympus", "titan",
        "legend of", "deity", "pantheon",
    ),
    "Historical Geography": (
        "river", "mountain", "strait", "peninsula", "island", "capital city",
        "border", "territory", "canal",
    ),
    "Politics": (
        "election", "parliament", "senate", "constitution", "treaty", "law",
        "supreme court", "party", "vote", "amendment", "diplomat",
    ),
    "Social Movements": (
        "suffrage", "civil rights", "abolition", "slavery", "protest", "strike",
        "feminis", "segregation", "boycott",
    ),
    "Technology": (
        "railroad", "steam engine", "telegraph", "printing press", "automobile",
        "computer", "aircraft", "engine", "factory",
    ),
}

# Terms that place a question in a period when nothing more specific matched.
_ERA_FALLBACK = (
    (re.compile(r"\b(1[0-4]\d\d)\b"), "Middle Ages"),
    (re.compile(r"\b(1[5-7]\d\d)\b"), "Early Modern"),
    (re.compile(r"\b(18\d\d)\b"), "Modern"),
    (re.compile(r"\b(19[0-4]\d)\b"), "Modern"),
    (re.compile(r"\b(19[5-9]\d|20\d\d)\b"), "Contemporary"),
)

MAX_TAGS = 5


def suggest_tags(text: str, answer: str = "") -> list[str]:
    """Best-effort categories for a question, ordered by evidence strength."""
    hay = f"{text} {answer}".lower()

    scored: list[tuple[int, str]] = []
    for tag, terms in RULES.items():
        hits = sum(1 for term in terms if term in hay)
        if hits:
            scored.append((hits, tag))

    scored.sort(key=lambda pair: (-pair[0], pair[1]))
    tags = [tag for _, tag in scored[:MAX_TAGS]]

    # Make sure there is at least one era, using dates in the text.
    eras = {"Ancient World", "Middle Ages", "Renaissance", "Early Modern", "Modern", "Contemporary"}
    if not any(t in eras for t in tags):
        for pattern, era in _ERA_FALLBACK:
            if pattern.search(hay):
                tags.append(era)
                break

    if not tags:
        tags = ["World History"]
    return tags[:MAX_TAGS]


def tag_untagged(conn, *, only_unenriched: bool = True) -> int:
    """Apply keyword tags to every question that has none. Returns the count."""
    from . import db as db_module

    sql = """
        SELECT q.id, q.type, q.stem, q.answer
        FROM questions q
        WHERE NOT EXISTS (SELECT 1 FROM question_tags WHERE question_id = q.id)
    """
    if only_unenriched:
        sql += " AND q.enriched = 0"

    rows = conn.execute(sql).fetchall()
    for row in rows:
        if row["type"] == "tossup":
            clues = conn.execute(
                "SELECT text FROM tossup_clues WHERE question_id = ? ORDER BY ordinal",
                (row["id"],),
            ).fetchall()
            body = " ".join(c["text"] for c in clues)
        else:
            # Stem only. MCQ distractors are chosen from adjacent topics on
            # purpose, so tagging on them mislabels the question — a Louis XIV
            # item picks up "Middle Ages" from a Charlemagne distractor.
            body = row["stem"] or ""

        db_module.set_question_tags(conn, int(row["id"]), suggest_tags(body, row["answer"]))

    conn.commit()
    return len(rows)


def tag_sources(conn) -> int:
    """Tag study guides and index pages so weak-area resource links can match."""
    from . import db as db_module

    rows = conn.execute(
        """
        SELECT s.id, s.title, s.url, substr(st.text, 1, 4000) AS head
        FROM sources s JOIN source_texts st ON st.source_id = s.id
        WHERE s.kind IN ('studyguide', 'index', 'rules')
          AND NOT EXISTS (SELECT 1 FROM source_tags WHERE source_id = s.id)
        """
    ).fetchall()

    for row in rows:
        text = f"{row['title'] or ''} {row['url']} {row['head'] or ''}"
        db_module.set_source_tags(conn, int(row["id"]), suggest_tags(text))

    conn.commit()
    return len(rows)


def suggested_iterable(texts: Iterable[str]) -> list[list[str]]:
    return [suggest_tags(t) for t in texts]
