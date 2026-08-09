"""Building the database that ships inside the image."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from beecrawl import auth, seed

SCHEMA = Path(__file__).resolve().parents[2] / "shared" / "schema.sql"
SALT = "0123456789abcdef0123456789abcdef"


@pytest.fixture()
def live(tmp_path) -> Path:
    """A small stand-in for a working install."""
    path = tmp_path / "bee.db"
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA.read_text(encoding="utf-8"))
    conn.execute("PRAGMA foreign_keys = ON")

    conn.execute(
        """INSERT INTO users (id, name, email, role, status, password_hash, password_salt)
           VALUES (9, 'Adam', 'adam@example.com', 'admin', 'approved', ?, ?)""",
        (auth._hash("a-good-long-password", SALT), SALT),
    )
    conn.execute(
        """INSERT INTO questions (id, type, origin, difficulty, answer, fingerprint)
           VALUES (1, 'tossup', 'official', 'middle', 'Hannibal', 'fp-1')"""
    )
    conn.execute(
        "INSERT INTO sources (id, url, host) VALUES (1, 'https://x.example/a.pdf', 'x.example')"
    )
    conn.execute(
        """INSERT INTO source_texts (source_id, text, char_count, extracted_at)
           VALUES (1, 'some extracted text', 19, datetime('now'))"""
    )
    conn.execute(
        "INSERT INTO quarantine (source_id, reason, raw_text) VALUES (1, 'too short', 'x')"
    )
    conn.execute("INSERT INTO sessions (id, user_id, format) VALUES (1, 9, 'buzz')")
    conn.execute(
        "INSERT INTO attempts (session_id, question_id, verdict) VALUES (1, 1, 'incorrect')"
    )
    conn.execute(
        "INSERT INTO review_queue (user_id, question_id, due_at) VALUES (9, 1, '2026-01-01')"
    )
    conn.execute(
        """INSERT INTO auth_sessions (id, user_id, expires_at)
           VALUES ('live-cookie', 9, datetime('now', '+1 day'))"""
    )
    conn.execute(
        """INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at)
           VALUES ('hash', 9, 'set-password', datetime('now', '+1 day'))"""
    )
    conn.execute("INSERT INTO inbox (kind, path_or_url) VALUES ('file', '/data/inbox/x.pdf')")
    conn.commit()
    conn.close()
    return path


def read(path: Path):
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def count(path: Path, table: str) -> int:
    return read(path).execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


class TestWithAccounts:
    def test_carries_questions_accounts_and_history(self, live, tmp_path):
        out = tmp_path / "seed.db"
        summary = seed.build(live, out)

        assert summary["questions"] == 1
        assert summary["accounts"] >= 1
        assert summary["with_credentials"] is True
        assert count(out, "attempts") == 1
        assert count(out, "review_queue") == 1

    def test_the_password_still_verifies_from_the_seed(self, live, tmp_path):
        out = tmp_path / "seed.db"
        seed.build(live, out)
        # The whole point of including accounts: sign-in works after deploying.
        assert auth.verify_admin(read(out), "adam@example.com", "a-good-long-password") == "Adam"

    def test_live_sessions_and_invites_are_never_shipped(self, live, tmp_path):
        out = tmp_path / "seed.db"
        seed.build(live, out)
        # Those cookies belong to browsers that will not exist, and a token in
        # an image is a credential in an image.
        assert count(out, "auth_sessions") == 0
        assert count(out, "auth_tokens") == 0

    def test_the_local_inbox_is_dropped(self, live, tmp_path):
        out = tmp_path / "seed.db"
        seed.build(live, out)
        assert count(out, "inbox") == 0


class TestWithoutAccounts:
    def test_strips_credentials_and_history(self, live, tmp_path):
        out = tmp_path / "seed.db"
        summary = seed.build(live, out, accounts=False)

        assert summary["with_credentials"] is False
        assert count(out, "attempts") == 0
        assert count(out, "sessions") == 0
        assert count(out, "review_queue") == 0
        # The bank is the point of the seed and must survive either way.
        assert summary["questions"] == 1

    def test_no_password_hash_remains_anywhere(self, live, tmp_path):
        out = tmp_path / "seed.db"
        seed.build(live, out, accounts=False)
        rows = read(out).execute(
            "SELECT COUNT(*) FROM users WHERE password_hash IS NOT NULL"
        ).fetchone()[0]
        assert rows == 0


class TestSize:
    def test_dropping_texts_shrinks_the_file(self, live, tmp_path):
        fat = tmp_path / "fat.db"
        lean = tmp_path / "lean.db"
        seed.build(live, fat, texts=True)
        seed.build(live, lean, texts=False)

        assert count(fat, "source_texts") == 1
        assert count(lean, "source_texts") == 0
        assert count(lean, "quarantine") == 0
        # Questions are untouched — only the re-parse material goes.
        assert count(lean, "questions") == 1


class TestInstall:
    def test_installs_into_an_empty_location(self, live, tmp_path):
        target = tmp_path / "fresh" / "bee.db"
        assert seed.install_if_missing(target, live) is True
        assert count(target, "questions") == 1

    def test_never_overwrites_an_existing_database(self, live, tmp_path):
        target = tmp_path / "existing.db"
        conn = sqlite3.connect(target)
        conn.executescript(SCHEMA.read_text(encoding="utf-8"))
        conn.commit()
        conn.close()

        # An existing file holds the real accounts and practice; the seed is by
        # definition older. Clobbering it would lose everything since deploy.
        assert seed.install_if_missing(target, live) is False
        assert count(target, "questions") == 0

    def test_treats_a_zero_byte_file_as_absent(self, live, tmp_path):
        target = tmp_path / "empty.db"
        target.touch()
        assert seed.install_if_missing(target, live) is True
        assert count(target, "questions") == 1

    def test_does_nothing_without_a_seed(self, tmp_path):
        assert seed.install_if_missing(tmp_path / "bee.db", tmp_path / "no-seed.db") is False
