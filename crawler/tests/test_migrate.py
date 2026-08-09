"""Upgrading a single-user database in place."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from beecrawl.migrate import migrate

SCHEMA = Path(__file__).resolve().parents[2] / "shared" / "schema.sql"

# The shape of the practice tables before profiles existed.
LEGACY = """
CREATE TABLE questions (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, origin TEXT NOT NULL,
  answer TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
  difficulty TEXT NOT NULL DEFAULT 'middle'
);
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  format TEXT NOT NULL,
  origin_filter TEXT NOT NULL DEFAULT 'both',
  difficulty TEXT,
  filters_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE TABLE attempts (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE review_queue (
  question_id INTEGER PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  interval_days REAL NOT NULL DEFAULT 1,
  ease REAL NOT NULL DEFAULT 2.5,
  lapses INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


@pytest.fixture()
def legacy() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(LEGACY)
    conn.execute(
        """INSERT INTO questions (id, type, origin, answer, fingerprint)
           VALUES (10, 'tossup', 'official', 'Hannibal', 'fp-10')"""
    )
    conn.execute("INSERT INTO sessions (id, format) VALUES (1, 'buzz')")
    conn.execute(
        "INSERT INTO attempts (session_id, question_id, verdict) VALUES (1, 10, 'incorrect')"
    )
    conn.execute(
        "INSERT INTO review_queue (question_id, due_at, lapses) VALUES (10, '2026-01-01', 3)"
    )
    conn.commit()
    return conn


def columns(conn, table):
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def test_creates_the_default_profile(legacy):
    migrate(legacy)
    rows = legacy.execute("SELECT id, name FROM users").fetchall()
    assert [(r["id"], r["name"]) for r in rows] == [(1, "Student")]


def test_existing_sessions_are_assigned_to_the_default_profile(legacy):
    migrate(legacy)
    assert "user_id" in columns(legacy, "sessions")
    assert legacy.execute("SELECT user_id FROM sessions WHERE id = 1").fetchone()[0] == 1


def test_review_queue_is_rekeyed_without_losing_its_schedule(legacy):
    migrate(legacy)
    assert "user_id" in columns(legacy, "review_queue")
    row = legacy.execute(
        "SELECT user_id, question_id, due_at, lapses FROM review_queue"
    ).fetchone()
    assert tuple(row) == (1, 10, "2026-01-01", 3)


def test_the_new_primary_key_is_per_user(legacy):
    migrate(legacy)
    legacy.execute("INSERT INTO users (id, name) VALUES (2, 'Alex')")
    # The same question can now be queued for a second profile.
    legacy.execute(
        "INSERT INTO review_queue (user_id, question_id, due_at) VALUES (2, 10, '2026-02-02')"
    )
    assert legacy.execute("SELECT COUNT(*) FROM review_queue").fetchone()[0] == 2
    with pytest.raises(sqlite3.IntegrityError):
        legacy.execute(
            "INSERT INTO review_queue (user_id, question_id, due_at) VALUES (2, 10, '2026-03-03')"
        )


def test_attempts_survive_the_migration(legacy):
    migrate(legacy)
    assert legacy.execute("SELECT COUNT(*) FROM attempts").fetchone()[0] == 1


def test_is_idempotent(legacy):
    first = migrate(legacy)
    second = migrate(legacy)
    assert first  # something happened the first time
    assert second == []  # and nothing the second
    assert legacy.execute("SELECT COUNT(*) FROM review_queue").fetchone()[0] == 1


def test_a_fresh_schema_needs_no_migration():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA.read_text(encoding="utf-8"))
    assert migrate(conn) == []
    assert conn.execute("SELECT name FROM users WHERE id = 1").fetchone()[0] == "Student"
