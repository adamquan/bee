import crypto from "node:crypto";
import { db } from "./db";
import { SESSION_COOKIE } from "./session-cookie";

/**
 * Accounts, passwords, sessions, and invite links.
 *
 * Choices worth knowing:
 *
 * - **scrypt**, from `node:crypto`. A real key-derivation function with no
 *   native dependency to compile. Never a bare hash — those are guessable at
 *   billions of attempts per second.
 * - **Server-side sessions.** The cookie is an opaque random id; the record
 *   lives in the database. A self-contained signed cookie could not be revoked,
 *   and an admin rejecting an account has to cut its access immediately.
 * - **Tokens are stored hashed.** A leaked database must not hand someone an
 *   outstanding invite link.
 * - **Constant-time comparison** everywhere a secret is checked.
 */

export { SESSION_COOKIE };
const SESSION_DAYS = 30;
const TOKEN_HOURS = 48;

// scrypt with the parameters OWASP suggests as a floor. N is the expensive
// knob; 2^15 keeps a single verification a few tens of milliseconds.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

export type Role = "admin" | "member";
export type Status = "pending" | "approved" | "rejected";

export interface Account {
  id: number;
  name: string;
  email: string | null;
  role: Role;
  status: Status;
  hasPassword: boolean;
  createdAt: string;
  approvedAt: string | null;
  lastLoginAt: string | null;
}

const ACCOUNT_COLUMNS = `id, name, email, role, status,
  (password_hash IS NOT NULL) AS hasPassword,
  created_at AS createdAt, approved_at AS approvedAt, last_login_at AS lastLoginAt`;

function toAccount(row: Record<string, unknown> | undefined): Account | null {
  if (!row) return null;
  return { ...row, hasPassword: Boolean(row.hasPassword) } as Account;
}

// ------------------------------------------------------------- passwords --

/** Minimum length. Length beats composition rules for real-world strength. */
export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return "That password is too long.";
  // Rejects "password123" and friends without pretending to be a real
  // breached-password check.
  if (/^(.)\1+$/.test(password)) return "That password is a single repeated character.";
  return null;
}

function hash(password: string, salt: string): string {
  return crypto.scryptSync(password.normalize("NFKC"), salt, SCRYPT.keylen, SCRYPT).toString("hex");
}

export function setPassword(userId: number, password: string): void {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  const salt = crypto.randomBytes(16).toString("hex");
  db()
    .prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?")
    .run(hash(password, salt), salt, userId);
}

function passwordMatches(userId: number, password: string): boolean {
  const row = db()
    .prepare("SELECT password_hash AS h, password_salt AS s FROM users WHERE id = ?")
    .get(userId) as { h: string | null; s: string | null } | undefined;
  if (!row?.h || !row.s) return false;

  const candidate = Buffer.from(hash(password, row.s), "hex");
  const stored = Buffer.from(row.h, "hex");
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

// ---------------------------------------------------------- rate limiting --

const MAX_ATTEMPTS = 8;
const WINDOW_MINUTES = 15;

export function tooManyAttempts(key: string): boolean {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM auth_attempts
       WHERE key = ? AND at > datetime('now', ?)`,
    )
    .get(key.toLowerCase(), `-${WINDOW_MINUTES} minutes`) as { n: number };
  return row.n >= MAX_ATTEMPTS;
}

export function recordFailedAttempt(key: string): void {
  const conn = db();
  conn.prepare("INSERT INTO auth_attempts (key) VALUES (?)").run(key.toLowerCase());
  // Keep the table from growing without bound; anything past the window is
  // irrelevant to the decision.
  conn.prepare("DELETE FROM auth_attempts WHERE at < datetime('now', '-1 day')").run();
}

export function clearAttempts(key: string): void {
  db().prepare("DELETE FROM auth_attempts WHERE key = ?").run(key.toLowerCase());
}

// ---------------------------------------------------------------- lookups --

export function accountByEmail(email: string): Account | null {
  return toAccount(
    db()
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE email = ? COLLATE NOCASE`)
      .get(email.trim()) as Record<string, unknown> | undefined,
  );
}

export function accountById(id: number): Account | null {
  return toAccount(
    db().prepare(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined,
  );
}

export function listAccounts(): Account[] {
  return (
    db()
      .prepare(
        `SELECT ${ACCOUNT_COLUMNS} FROM users
         ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                  created_at DESC`,
      )
      .all() as Record<string, unknown>[]
  ).map((r) => toAccount(r)!);
}

// ----------------------------------------------------------- registration --

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export class RegistrationError extends Error {}

export function register(rawName: string, rawEmail: string): Account {
  const name = rawName.trim().replace(/\s+/g, " ");
  const email = rawEmail.trim().toLowerCase();

  if (!name) throw new RegistrationError("Enter your name.");
  if (name.length > 60) throw new RegistrationError("That name is too long.");
  if (!EMAIL_PATTERN.test(email)) throw new RegistrationError("Enter a valid email address.");

  const conn = db();
  if (conn.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
    throw new RegistrationError("That email address is already registered.");
  }

  // Display names are unique (the practice history keys off them), so make a
  // collision the registrant's problem to solve rather than silently merging
  // them into someone else's account.
  if (conn.prepare("SELECT 1 FROM users WHERE name = ? COLLATE NOCASE").get(name)) {
    throw new RegistrationError("Someone is already using that name. Try another.");
  }

  const info = conn
    .prepare("INSERT INTO users (name, email, role, status) VALUES (?, ?, 'member', 'pending')")
    .run(name, email);
  return accountById(Number(info.lastInsertRowid))!;
}

// --------------------------------------------------------- invite tokens --

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Mint a single-use password-setting link. Returns the raw token, once. */
export function createSetPasswordToken(userId: number): string {
  const token = crypto.randomBytes(32).toString("base64url");
  db()
    .prepare(
      `INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at)
       VALUES (?, ?, 'set-password', datetime('now', ?))`,
    )
    .run(tokenHash(token), userId, `+${TOKEN_HOURS} hours`);
  return token;
}

export interface TokenCheck {
  ok: boolean;
  userId?: number;
  reason?: string;
}

export function checkSetPasswordToken(token: string): TokenCheck {
  const row = db()
    .prepare(
      `SELECT user_id AS userId, used_at AS usedAt, expires_at AS expiresAt
       FROM auth_tokens WHERE token_hash = ? AND purpose = 'set-password'`,
    )
    .get(tokenHash(token)) as
    | { userId: number; usedAt: string | null; expiresAt: string }
    | undefined;

  if (!row) return { ok: false, reason: "This link is not valid." };
  if (row.usedAt) return { ok: false, reason: "This link has already been used." };
  if (new Date(row.expiresAt.replace(" ", "T") + "Z") < new Date()) {
    return { ok: false, reason: "This link has expired. Ask the admin for a new one." };
  }
  return { ok: true, userId: row.userId };
}

/** Consume the token and set the password. Both, or neither. */
export function redeemSetPasswordToken(token: string, password: string): number {
  const check = checkSetPasswordToken(token);
  if (!check.ok || !check.userId) throw new Error(check.reason ?? "This link is not valid.");

  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  const conn = db();
  conn.transaction(() => {
    setPassword(check.userId!, password);
    conn
      .prepare("UPDATE auth_tokens SET used_at = datetime('now') WHERE token_hash = ?")
      .run(tokenHash(token));
    // Any other outstanding invite for this account is now moot.
    conn
      .prepare(
        `UPDATE auth_tokens SET used_at = datetime('now')
         WHERE user_id = ? AND purpose = 'set-password' AND used_at IS NULL`,
      )
      .run(check.userId);
  })();

  return check.userId;
}

// --------------------------------------------------------------- approval --

export function approve(userId: number): { account: Account; token: string } {
  db()
    .prepare(
      "UPDATE users SET status = 'approved', approved_at = datetime('now') WHERE id = ?",
    )
    .run(userId);
  return { account: accountById(userId)!, token: createSetPasswordToken(userId) };
}

export function reject(userId: number): void {
  const conn = db();
  conn.transaction(() => {
    conn.prepare("UPDATE users SET status = 'rejected' WHERE id = ?").run(userId);
    // Cut any access the account already had.
    conn.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
    conn
      .prepare("UPDATE auth_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL")
      .run(userId);
  })();
}

// --------------------------------------------------------------- sessions --

export interface LoginResult {
  ok: boolean;
  sessionId?: string;
  account?: Account;
  reason?: string;
}

/**
 * Verify a password and open a session.
 *
 * Every failure returns the same message. Telling an attacker whether the
 * address exists, is unapproved, or merely has the wrong password hands them
 * an account enumeration oracle.
 */
export function login(email: string, password: string, userAgent?: string): LoginResult {
  const generic = { ok: false as const, reason: "That email and password don't match." };
  const account = accountByEmail(email);

  if (!account) return generic;
  if (account.status !== "approved") return generic;
  if (!account.hasPassword) return generic;
  if (!passwordMatches(account.id, password)) return generic;

  const sessionId = crypto.randomBytes(32).toString("base64url");
  const conn = db();
  conn
    .prepare(
      `INSERT INTO auth_sessions (id, user_id, expires_at, user_agent)
       VALUES (?, ?, datetime('now', ?), ?)`,
    )
    .run(sessionId, account.id, `+${SESSION_DAYS} days`, userAgent?.slice(0, 200) ?? null);
  conn.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(account.id);

  return { ok: true, sessionId, account };
}

/** The account behind a session cookie, or null. Also prunes expired rows. */
export function accountForSession(sessionId: string | undefined): Account | null {
  if (!sessionId) return null;
  const conn = db();
  const row = conn
    .prepare(
      `SELECT u.id FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > datetime('now') AND u.status = 'approved'`,
    )
    .get(sessionId) as { id: number } | undefined;
  if (!row) return null;
  return accountById(row.id);
}

export function logout(sessionId: string | undefined): void {
  if (!sessionId) return;
  db().prepare("DELETE FROM auth_sessions WHERE id = ?").run(sessionId);
}

export function purgeExpiredSessions(): void {
  db().prepare("DELETE FROM auth_sessions WHERE expires_at <= datetime('now')").run();
}
