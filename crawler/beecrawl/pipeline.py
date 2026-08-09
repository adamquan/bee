"""Run the parsers over extracted source text and write questions to the bank."""

from __future__ import annotations

import re
import sqlite3
from urllib.parse import unquote, urlparse

from . import db, tagging
from .parse import parse_mcqs, parse_tossups

# Source kinds that plausibly contain questions. Study guides and rules are
# kept as reference/grounding material rather than parsed for questions.
QUESTION_KINDS = ("packet", "exam", "upload", "unknown")


def parse_source(
    conn: sqlite3.Connection, source_id: int, text: str, *, difficulty: str = "middle"
) -> dict[str, int]:
    counts = {"tossups": 0, "mcqs": 0, "duplicates": 0, "quarantined": 0}

    # Quarantine records why *this* parse rejected each block, so a re-parse
    # replaces the source's entries rather than stacking a second copy on top.
    conn.execute("DELETE FROM quarantine WHERE source_id = ?", (source_id,))

    tossups, t_rejected = parse_tossups(text)
    for t in tossups:
        # A duplicate still means this source *contains* the question — IHBB
        # republishes packets across divisions. Record the appearance so the
        # Library can report real coverage instead of crediting only the first
        # copy the crawler happened to reach.
        seen = db.find_near_duplicate(conn, t.answer, t.body, "tossup")
        if seen is not None:
            db.link_question_source(conn, seen, source_id)
            counts["duplicates"] += 1
            continue
        qid = db.insert_tossup(
            conn,
            clues=t.clues,
            answer=t.answer,
            origin="official",
            source_id=source_id,
            difficulty=difficulty,
            answer_alternates=t.alternates,
            # Keyword tags so category filtering and weak-area analysis work
            # before (or without) Claude enrichment, which replaces them.
            tags=tagging.suggest_tags(t.body, t.answer),
        )
        if qid is None:
            # Exact fingerprint collision — still an appearance in this source.
            db.link_question_source(
                conn, db.question_id_for_fingerprint(conn, t.answer, t.clues[0][1]), source_id
            )
            counts["duplicates"] += 1
        else:
            db.link_question_source(conn, qid, source_id)
            counts["tossups"] += 1

    mcqs, m_rejected = parse_mcqs(text)
    for m in mcqs:
        seen = db.find_near_duplicate(conn, m.answer, m.stem, "mcq")
        if seen is not None:
            db.link_question_source(conn, seen, source_id)
            counts["duplicates"] += 1
            continue
        qid = db.insert_mcq(
            conn,
            stem=m.stem,
            options=m.options,
            answer=m.answer,
            origin="official",
            source_id=source_id,
            difficulty=difficulty,
            # Stem + answer only; distractors are deliberately off-topic.
            tags=tagging.suggest_tags(m.stem, m.answer),
        )
        if qid is None:
            db.link_question_source(
                conn, db.question_id_for_fingerprint(conn, m.answer, m.stem), source_id
            )
            counts["duplicates"] += 1
        else:
            db.link_question_source(conn, qid, source_id)
            counts["mcqs"] += 1

    for reason, raw in t_rejected + m_rejected:
        db.quarantine(conn, source_id, reason, raw)
        counts["quarantined"] += 1

    return counts


def _difficulty_hint(url: str, title: str | None = None) -> str:
    """Guess the competition division from a packet's file name.

    Division markers are separate tokens in these archives —
    `2019-2020-HS-History-Bee-Finals.pdf`, `2020-2021-EMS-History-Bee-Round-1`
    — so matching has to be token-aware. Substring checks like "/hs" miss every
    one of them and silently label the whole corpus "middle".
    """
    text = unquote(f"{url} {title or ''}")
    tokens = {t.upper() for t in re.split(r"[^A-Za-z0-9]+", text) if t}
    lowered = text.lower()

    # Elementary first: "EMS" covers elementary+middle sets, which sit below MS.
    if tokens & {"ES", "EMS", "ELEMENTARY"} or "elementary" in lowered:
        return "elementary"
    if tokens & {"HS", "VARSITY", "JV"} or "high school" in lowered:
        return "high"
    if tokens & {"COLLEGIATE", "COLLEGE", "OPEN"} or "collegiate" in lowered:
        return "open"
    if tokens & {"MS"} or "middle school" in lowered:
        return "middle"

    # No division in the name. The Quizbowl Packet Archive splits by host, and
    # its "novice" sets are pitched at roughly middle-school difficulty.
    host = urlparse(url).netloc
    if host.startswith("ms."):
        return "middle"
    if "novice" in lowered:
        return "middle"
    if host.endswith("quizbowlpackets.com"):
        return "high"  # the main archive is the high-school database
    return "middle"


def reset_parsed(conn: sqlite3.Connection) -> int:
    """Send already-parsed sources back through the parser.

    The status ladder (pending -> fetched -> extracted -> parsed) makes every
    stage incremental, which also means a source is only ever mined once. After
    a parser fix there is no way to revisit the text short of this. Nothing is
    deleted: the questions already extracted stay, and the near-duplicate check
    in `parse_source` drops anything the second pass finds again.
    """
    cursor = conn.execute(
        """UPDATE sources SET status = 'extracted'
           WHERE status = 'parsed'
             AND EXISTS (SELECT 1 FROM source_texts st WHERE st.source_id = sources.id)"""
    )
    conn.commit()
    return cursor.rowcount


def parse_all(conn: sqlite3.Connection, *, on_event=None) -> dict[str, int]:
    """Parse every extracted source that has not been parsed yet."""
    totals = {"sources": 0, "tossups": 0, "mcqs": 0, "duplicates": 0, "quarantined": 0}

    rows = conn.execute(
        """
        SELECT s.id, s.url, s.title, s.kind, st.text
        FROM sources s JOIN source_texts st ON st.source_id = s.id
        WHERE s.status = 'extracted'
        ORDER BY s.id
        """
    ).fetchall()

    for row in rows:
        if row["kind"] not in QUESTION_KINDS:
            db.set_source_status(conn, row["id"], "parsed", f"kind={row['kind']}, kept as reference")
            conn.commit()
            continue

        counts = parse_source(
            conn,
            int(row["id"]),
            row["text"],
            difficulty=_difficulty_hint(row["url"], row["title"]),
        )
        totals["sources"] += 1
        for key in ("tossups", "mcqs", "duplicates", "quarantined"):
            totals[key] += counts[key]

        found = counts["tossups"] + counts["mcqs"]
        db.set_source_status(
            conn,
            row["id"],
            "parsed",
            f"{counts['tossups']} tossups, {counts['mcqs']} mcqs, "
            f"{counts['duplicates']} dupes, {counts['quarantined']} quarantined",
        )
        conn.commit()
        if on_event:
            on_event("ok" if found else "empty", row["url"], f"{found} question(s)")

    # Study guides and index pages get tagged too, so the dashboard can point
    # at a real resource for each weak category.
    totals["sources_tagged"] = tagging.tag_sources(conn)
    return totals


def redifficulty(conn: sqlite3.Connection) -> dict[str, int]:
    """Recompute every question's difficulty from its source file name.

    Difficulty is derived, not parsed, so it can be corrected in place when the
    heuristic improves — no need to re-extract or re-parse the corpus.
    """
    rows = conn.execute(
        """
        SELECT q.id, s.url, s.title FROM questions q
        JOIN sources s ON s.id = q.source_id
        WHERE q.origin = 'official'
        """
    ).fetchall()

    changed = 0
    for row in rows:
        level = _difficulty_hint(row["url"], row["title"])
        cur = conn.execute(
            "UPDATE questions SET difficulty = ? WHERE id = ? AND difficulty != ?",
            (level, row["id"], level),
        )
        changed += cur.rowcount
    conn.commit()
    return {"examined": len(rows), "changed": changed}
