"""Admin authentication on the command line."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from beecrawl import auth

SCHEMA = Path(__file__).resolve().parents[2] / "shared" / "schema.sql"

# Produced by web/lib/auth.ts's hash() for this password and salt. If the two
# implementations ever drift, a password set in the browser stops working on
# the command line — this pins them together.
KNOWN_PASSWORD = "a-good-long-password"
KNOWN_SALT = "0123456789abcdef0123456789abcdef"
KNOWN_HASH_PREFIX = "a8346de7e539c8bf75f9e11f200b5afa"


@pytest.fixture()
def conn() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA.read_text(encoding="utf-8"))
    return connection


def add(conn, *, id, name, email, role="admin", status="approved", password=KNOWN_PASSWORD):
    hashed = auth._hash(password, KNOWN_SALT) if password else None
    # REPLACE, not INSERT: schema.sql seeds account 1, and some cases want to
    # stand in its place.
    conn.execute(
        """INSERT OR REPLACE INTO users
             (id, name, email, role, status, password_hash, password_salt)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (id, name, email, role, status, hashed, KNOWN_SALT if password else None),
    )
    conn.commit()


def test_hash_matches_the_web_app():
    # The single fact the whole scheme rests on: one password, two languages.
    assert auth._hash(KNOWN_PASSWORD, KNOWN_SALT).startswith(KNOWN_HASH_PREFIX)


def test_hash_is_unicode_normalised():
    # "é" composed vs decomposed must not be two different passwords.
    assert auth._hash("café-password", KNOWN_SALT) == auth._hash(
        "café-password", KNOWN_SALT
    )


def test_accepts_the_right_admin(conn):
    add(conn, id=1, name="Adam", email="adam@example.com")
    assert auth.verify_admin(conn, "adam@example.com", KNOWN_PASSWORD) == "Adam"


def test_email_is_case_insensitive(conn):
    add(conn, id=1, name="Adam", email="adam@example.com")
    assert auth.verify_admin(conn, "ADAM@Example.com ", KNOWN_PASSWORD) == "Adam"


def test_rejects_the_wrong_password(conn):
    add(conn, id=1, name="Adam", email="adam@example.com")
    with pytest.raises(auth.AuthError):
        auth.verify_admin(conn, "adam@example.com", "not-the-password")


def test_rejects_a_member(conn):
    add(conn, id=2, name="Jamie", email="jamie@example.com", role="member")
    with pytest.raises(auth.AuthError):
        auth.verify_admin(conn, "jamie@example.com", KNOWN_PASSWORD)


def test_rejects_an_unapproved_admin(conn):
    add(conn, id=3, name="Ghost", email="ghost@example.com", status="pending")
    with pytest.raises(auth.AuthError):
        auth.verify_admin(conn, "ghost@example.com", KNOWN_PASSWORD)


def test_rejects_an_admin_with_no_password_set(conn):
    add(conn, id=4, name="Blank", email="blank@example.com", password=None)
    with pytest.raises(auth.AuthError):
        auth.verify_admin(conn, "blank@example.com", "")
    with pytest.raises(auth.AuthError):
        auth.verify_admin(conn, "blank@example.com", KNOWN_PASSWORD)


def test_rejects_an_unknown_address(conn):
    add(conn, id=1, name="Adam", email="adam@example.com")
    with pytest.raises(auth.AuthError):
        auth.verify_admin(conn, "nobody@example.com", KNOWN_PASSWORD)


def test_every_failure_reads_the_same(conn):
    """Otherwise the CLI tells an attacker which addresses exist."""
    add(conn, id=1, name="Adam", email="adam@example.com")
    add(conn, id=2, name="Jamie", email="jamie@example.com", role="member")

    messages = set()
    for email, password in [
        ("nobody@example.com", KNOWN_PASSWORD),
        ("adam@example.com", "wrong"),
        ("jamie@example.com", KNOWN_PASSWORD),
    ]:
        with pytest.raises(auth.AuthError) as caught:
            auth.verify_admin(conn, email, password)
        messages.add(str(caught.value))
    assert len(messages) == 1


class TestBootstrapDetection:
    def test_a_fresh_install_has_no_usable_admin(self, conn):
        assert auth.any_admin_has_password(conn) is False

    def test_the_seeded_account_does_not_count(self, conn):
        # schema.sql seeds account 1 with no email and no password on purpose.
        assert conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] >= 1
        assert auth.any_admin_has_password(conn) is False

    def test_an_admin_without_a_password_does_not_count(self, conn):
        add(conn, id=5, name="Waiting", email="w@example.com", password=None)
        assert auth.any_admin_has_password(conn) is False

    def test_a_member_with_a_password_does_not_count(self, conn):
        add(conn, id=6, name="Jamie", email="j@example.com", role="member")
        assert auth.any_admin_has_password(conn) is False

    def test_one_real_admin_is_enough(self, conn):
        add(conn, id=7, name="Adam", email="adam@example.com")
        assert auth.any_admin_has_password(conn) is True


class TestCredentialResolution:
    def test_prefers_explicit_values(self):
        asked = []
        email, password = auth.resolve_credentials(
            "a@example.com", "secret", prompt=lambda *a, **k: asked.append(a) or "x"
        )
        assert (email, password) == ("a@example.com", "secret")
        assert asked == []

    def test_falls_back_to_the_environment(self, monkeypatch):
        monkeypatch.setenv("BEE_ADMIN_EMAIL", "env@example.com")
        monkeypatch.setenv("BEE_ADMIN_PASSWORD", "env-password")
        assert auth.resolve_credentials(None, None, prompt=lambda *a, **k: "") == (
            "env@example.com",
            "env-password",
        )

    def test_prompts_for_what_is_missing(self, monkeypatch):
        monkeypatch.delenv("BEE_ADMIN_EMAIL", raising=False)
        monkeypatch.delenv("BEE_ADMIN_PASSWORD", raising=False)
        prompts = []

        def prompt(label, hide_input=False):
            prompts.append((label, hide_input))
            return "typed@example.com" if "email" in label.lower() else "typed-password"

        email, password = auth.resolve_credentials(None, None, prompt=prompt)
        assert (email, password) == ("typed@example.com", "typed-password")
        # The password prompt must not echo.
        assert prompts[1][1] is True
