"""Admin authentication for the command line.

Credentials are the same ones the web app uses — one accounts table, one
password per person. The hash is recomputed here with parameters that must
match `web/lib/auth.ts` exactly, so a password set in the browser verifies on
the command line and vice versa:

    scrypt(NFKC(password), salt=<the hex salt string, as UTF-8 bytes>,
           n=32768, r=8, p=1, dklen=64)

**What this does and does not protect.** It stops someone who is not an admin
from running the crawler — a shared build box, a second account on the
machine, an accidental invocation of a command that spends money on the API.
It is not a boundary against anyone who can already read and write
`data/bee.db`: they can edit the accounts table directly. Treat filesystem
access to the data directory as equivalent to admin.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import sqlite3
import unicodedata

# Must stay in step with SCRYPT in web/lib/auth.ts.
_SCRYPT = {"n": 32768, "r": 8, "p": 1, "dklen": 64, "maxmem": 96 * 1024 * 1024}


class AuthError(Exception):
    """Raised when the command line cannot prove it is an admin."""


def _hash(password: str, salt: str) -> str:
    return hashlib.scrypt(
        unicodedata.normalize("NFKC", password).encode("utf-8"),
        salt=salt.encode("utf-8"),
        **_SCRYPT,
    ).hex()


def any_admin_has_password(conn: sqlite3.Connection) -> bool:
    """True once the install has a usable admin.

    Until then the bootstrap has to be allowed through, or there would be no
    way to create the first one.
    """
    row = conn.execute(
        """SELECT 1 FROM users
           WHERE role = 'admin' AND status = 'approved'
             AND password_hash IS NOT NULL AND email IS NOT NULL
           LIMIT 1"""
    ).fetchone()
    return row is not None


def verify_admin(conn: sqlite3.Connection, email: str, password: str) -> str:
    """Return the admin's name, or raise `AuthError`.

    One message for every kind of failure, matching the web app: saying which
    part was wrong tells an attacker which addresses exist.
    """
    generic = AuthError("That email and password don't match an admin account.")

    row = conn.execute(
        """SELECT name, password_hash, password_salt FROM users
           WHERE email = ? COLLATE NOCASE AND role = 'admin' AND status = 'approved'""",
        (email.strip(),),
    ).fetchone()
    if row is None:
        raise generic

    name, stored, salt = row[0], row[1], row[2]
    if not stored or not salt:
        raise generic
    if not hmac.compare_digest(_hash(password, salt), stored):
        raise generic
    return str(name)


def resolve_credentials(
    email: str | None, password: str | None, *, prompt
) -> tuple[str, str]:
    """Work out which admin is running this, asking if need be.

    Falls back to `BEE_ADMIN_EMAIL` / `BEE_ADMIN_PASSWORD` so scheduled runs
    work unattended. Passing the password as a flag is deliberately not
    supported — it would land in shell history and in `ps`.
    """
    email = email or os.environ.get("BEE_ADMIN_EMAIL")
    password = password or os.environ.get("BEE_ADMIN_PASSWORD")

    if not email:
        email = prompt("Admin email")
    if not password:
        password = prompt("Password", hide_input=True)

    if not email or not password:
        raise AuthError("An admin email and password are required.")
    return email, password
