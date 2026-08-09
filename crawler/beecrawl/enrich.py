"""Tag, grade, and explain parsed questions using Claude.

Runs over questions with `enriched = 0`. Uses the Batch API so a few thousand
official questions cost half as much and can be left to run.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from . import db, llm


def _question_payload(conn: sqlite3.Connection, row: sqlite3.Row) -> str:
    if row["type"] == "tossup":
        clues = conn.execute(
            "SELECT tier, text FROM tossup_clues WHERE question_id = ? ORDER BY ordinal",
            (row["id"],),
        ).fetchall()
        body = "\n".join(f"[{c['tier']}] {c['text']}" for c in clues)
        return f"Question type: pyramidal tossup\n\n{body}\n\nANSWER: {row['answer']}"

    options = conn.execute(
        "SELECT label, text, is_correct FROM mcq_options WHERE question_id = ? ORDER BY label",
        (row["id"],),
    ).fetchall()
    body = "\n".join(f"{o['label']}. {o['text']}" for o in options)
    return (
        f"Question type: multiple choice\n\n{row['stem']}\n{body}\n\n"
        f"Correct answer: {row['answer']}"
    )


def _apply(conn: sqlite3.Connection, question_id: int, data: dict[str, Any]) -> bool:
    categories = [c for c in data.get("categories", []) if isinstance(c, str)][:5]
    difficulty = data.get("difficulty")
    explanation = (data.get("explanation") or "").strip()
    alternates = [a for a in data.get("answer_alternates", []) if isinstance(a, str) and a.strip()]

    if not categories or not explanation:
        return False
    if difficulty not in ("elementary", "middle", "high", "open"):
        difficulty = "middle"

    existing = conn.execute(
        "SELECT answer_alternates FROM questions WHERE id = ?", (question_id,)
    ).fetchone()
    merged: list[str] = []
    if existing:
        try:
            merged = list(json.loads(existing["answer_alternates"]))
        except (json.JSONDecodeError, TypeError):
            merged = []
    for alt in alternates:
        if alt not in merged:
            merged.append(alt)

    conn.execute(
        """
        UPDATE questions
        SET difficulty = ?, explanation = ?, answer_alternates = ?, enriched = 1
        WHERE id = ?
        """,
        (difficulty, explanation, json.dumps(merged), question_id),
    )
    db.set_question_tags(conn, question_id, categories)
    return True


def pending_count(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COUNT(*) n FROM questions WHERE enriched = 0").fetchone()
    return int(row["n"])


def enrich(
    conn: sqlite3.Connection,
    *,
    limit: int | None = None,
    batch_size: int = 500,
    on_event=None,
) -> dict[str, int]:
    """Enrich un-enriched questions. Returns counts."""

    def emit(msg: str) -> None:
        if on_event:
            on_event(msg)

    sql = "SELECT id, type, stem, answer FROM questions WHERE enriched = 0 ORDER BY id"
    if limit:
        sql += f" LIMIT {int(limit)}"
    rows = conn.execute(sql).fetchall()
    counts = {"submitted": 0, "applied": 0, "failed": 0}
    if not rows:
        return counts

    for group in llm.chunk(rows, batch_size):
        requests = []
        for row in group:
            requests.append(
                llm.build_request(
                    f"q{row['id']}",
                    system=llm.ENRICH_SYSTEM,
                    user=(
                        "Classify and explain this competition history question.\n\n"
                        + _question_payload(conn, row)
                    ),
                    schema=llm.ENRICH_SCHEMA,
                    max_tokens=2000,
                    effort="medium",
                )
            )
        counts["submitted"] += len(requests)
        emit(f"submitting batch of {len(requests)} questions for enrichment")

        results = llm.run_batch(requests, on_poll=lambda b: emit(f"batch {b.id}: {b.processing_status}"))

        for row in group:
            data = results.get(f"q{row['id']}")
            if data and _apply(conn, int(row["id"]), data):
                counts["applied"] += 1
            else:
                counts["failed"] += 1
        conn.commit()
        emit(f"applied {counts['applied']} / {counts['submitted']}")

    return counts
