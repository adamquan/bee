"""Re-running the parser over sources that were already mined."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from beecrawl.pipeline import reset_parsed

SCHEMA = Path(__file__).resolve().parents[2] / "shared" / "schema.sql"


@pytest.fixture()
def conn() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    # `beecrawl.db` reads columns by name throughout.
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA.read_text(encoding="utf-8"))
    return connection


def add_source(conn: sqlite3.Connection, sid: int, status: str, *, text: str | None) -> None:
    conn.execute(
        "INSERT INTO sources (id, url, host, kind, status) VALUES (?, ?, 'x.example', 'packet', ?)",
        (sid, f"https://x.example/{sid}.pdf", status),
    )
    if text is not None:
        conn.execute(
            """INSERT INTO source_texts (source_id, text, char_count, extracted_at)
               VALUES (?, ?, ?, datetime('now'))""",
            (sid, text, len(text)),
        )
    conn.commit()


def statuses(conn: sqlite3.Connection) -> dict[int, str]:
    return {row[0]: row[1] for row in conn.execute("SELECT id, status FROM sources")}


def test_parsed_sources_go_back_to_extracted(conn):
    add_source(conn, 1, "parsed", text="some packet text")
    add_source(conn, 2, "parsed", text="more packet text")

    assert reset_parsed(conn) == 2
    assert statuses(conn) == {1: "extracted", 2: "extracted"}


def test_other_statuses_are_left_alone(conn):
    add_source(conn, 1, "parsed", text="text")
    add_source(conn, 2, "pending", text=None)
    add_source(conn, 3, "error", text=None)
    add_source(conn, 4, "robots_denied", text=None)
    add_source(conn, 5, "fetched", text=None)

    reset_parsed(conn)

    assert statuses(conn) == {
        1: "extracted",
        2: "pending",
        3: "error",
        4: "robots_denied",
        5: "fetched",
    }


def test_a_parsed_source_with_no_extracted_text_is_not_re_queued(conn):
    # Non-question kinds are marked parsed without ever storing text; sending
    # them back would strand them at 'extracted' forever.
    add_source(conn, 1, "parsed", text=None)

    assert reset_parsed(conn) == 0
    assert statuses(conn) == {1: "parsed"}


def test_existing_questions_are_not_deleted(conn):
    add_source(conn, 1, "parsed", text="text")
    conn.execute(
        """INSERT INTO questions (id, type, origin, source_id, difficulty, answer, fingerprint)
           VALUES (1, 'tossup', 'official', 1, 'middle', 'Charlemagne', 'fp-1')"""
    )
    conn.commit()

    reset_parsed(conn)

    assert conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0] == 1


def test_is_idempotent_when_nothing_is_parsed(conn):
    add_source(conn, 1, "pending", text=None)
    assert reset_parsed(conn) == 0


def test_reparsing_replaces_a_source_quarantine_instead_of_stacking_it(conn):
    """Otherwise the quarantine count doubles on every --reparse."""
    from beecrawl.pipeline import parse_source

    add_source(conn, 1, "extracted", text="too short to be a tossup\nANSWER: Nothing")

    parse_source(conn, 1, "too short to be a tossup\nANSWER: Nothing")
    first = conn.execute("SELECT COUNT(*) FROM quarantine WHERE source_id = 1").fetchone()[0]

    parse_source(conn, 1, "too short to be a tossup\nANSWER: Nothing")
    second = conn.execute("SELECT COUNT(*) FROM quarantine WHERE source_id = 1").fetchone()[0]

    assert first == second


def test_reparsing_does_not_touch_another_source_quarantine(conn):
    from beecrawl.pipeline import parse_source

    add_source(conn, 1, "extracted", text="a")
    add_source(conn, 2, "extracted", text="b")
    conn.execute(
        "INSERT INTO quarantine (source_id, reason, raw_text) VALUES (2, 'body too short', 'x')"
    )
    conn.commit()

    parse_source(conn, 1, "too short\nANSWER: Nothing")

    assert conn.execute("SELECT COUNT(*) FROM quarantine WHERE source_id = 2").fetchone()[0] == 1


def test_a_republished_packet_is_credited_with_the_questions_it_contains(conn):
    """IHBB reprints tossups across divisions; the second copy showed "0"."""
    from beecrawl.pipeline import parse_source

    packet = (
        "(1) This Athenian general was jailed after a failed expedition to Paros. "
        "He defeated Datis and Artaphernes at a battle ending Darius the Great's "
        "invasion of Greece. For the point, name this victor at Marathon.\n"
        "ANSWER: Miltiades the Younger\n"
    )
    add_source(conn, 1, "extracted", text=packet)
    add_source(conn, 2, "extracted", text=packet)  # the same packet, republished

    first = parse_source(conn, 1, packet)
    second = parse_source(conn, 2, packet)

    assert first["tossups"] == 1
    assert second["tossups"] == 0 and second["duplicates"] == 1

    def coverage(sid):
        return conn.execute(
            "SELECT COUNT(*) FROM question_sources WHERE source_id = ?", (sid,)
        ).fetchone()[0]

    # Credit goes to the first copy, but both are recorded as containing it.
    assert coverage(1) == 1
    assert coverage(2) == 1
    assert conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0] == 1


def test_linking_a_source_twice_does_not_duplicate_the_row(conn):
    from beecrawl.db import link_question_source

    add_source(conn, 1, "parsed", text="text")
    conn.execute(
        """INSERT INTO questions (id, type, origin, source_id, difficulty, answer, fingerprint)
           VALUES (1, 'tossup', 'official', 1, 'middle', 'X', 'fp-x')"""
    )
    link_question_source(conn, 1, 1)
    link_question_source(conn, 1, 1)

    assert conn.execute("SELECT COUNT(*) FROM question_sources").fetchone()[0] == 1


def test_linking_tolerates_a_missing_source_id(conn):
    from beecrawl.db import link_question_source

    link_question_source(conn, 1, None)  # generated questions have no source
    assert conn.execute("SELECT COUNT(*) FROM question_sources").fetchone()[0] == 0
