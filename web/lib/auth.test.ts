import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bee-auth-"));
const repoRoot = path.resolve(__dirname, "..", "..");

process.env.BEE_DB_PATH = path.join(tmp, "test.db");
process.env.BEE_SCHEMA_PATH = path.join(repoRoot, "shared", "schema.sql");

type AuthModule = typeof import("./auth");
let auth: AuthModule;
let conn: import("better-sqlite3").Database;

beforeAll(async () => {
  const { db } = await import("./db");
  conn = db();
  auth = await import("./auth");
});

beforeEach(() => {
  conn.exec(
    "DELETE FROM auth_sessions; DELETE FROM auth_tokens; DELETE FROM auth_attempts; DELETE FROM users",
  );
  conn
    .prepare(
      `INSERT INTO users (id, name, email, role, status, approved_at)
       VALUES (1, 'Adam', 'admin@example.com', 'admin', 'approved', datetime('now'))`,
    )
    .run();
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const GOOD = "correct-horse-battery";

describe("passwords", () => {
  it("rejects anything too short", () => {
    expect(auth.passwordProblem("short")).toMatch(/at least 10/);
    expect(auth.passwordProblem(GOOD)).toBeNull();
  });

  it("rejects a single repeated character", () => {
    expect(auth.passwordProblem("aaaaaaaaaaaa")).toMatch(/repeated/);
  });

  it("never stores the password itself", () => {
    auth.setPassword(1, GOOD);
    const row = conn
      .prepare("SELECT password_hash AS h, password_salt AS s FROM users WHERE id = 1")
      .get() as { h: string; s: string };
    expect(row.h).not.toContain(GOOD);
    expect(row.h).toMatch(/^[0-9a-f]{128}$/);
    expect(row.s).toMatch(/^[0-9a-f]{32}$/);
  });

  it("salts, so two accounts with the same password hash differently", () => {
    conn
      .prepare(
        "INSERT INTO users (id, name, email, status) VALUES (2, 'Bee', 'b@example.com', 'approved')",
      )
      .run();
    auth.setPassword(1, GOOD);
    auth.setPassword(2, GOOD);
    const hashes = conn.prepare("SELECT password_hash AS h FROM users").all() as { h: string }[];
    expect(hashes[0].h).not.toBe(hashes[1].h);
  });
});

describe("login", () => {
  beforeEach(() => auth.setPassword(1, GOOD));

  it("accepts the right password", () => {
    const result = auth.login("admin@example.com", GOOD);
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeTruthy();
  });

  it("is case-insensitive on the address", () => {
    expect(auth.login("ADMIN@example.com", GOOD).ok).toBe(true);
  });

  it("rejects the wrong password", () => {
    expect(auth.login("admin@example.com", "not-the-password").ok).toBe(false);
  });

  it("gives the same message whether or not the account exists", () => {
    // Otherwise the form is an account-enumeration oracle.
    const missing = auth.login("nobody@example.com", GOOD);
    const wrong = auth.login("admin@example.com", "wrong-password-here");
    expect(missing.reason).toBe(wrong.reason);
  });

  it("refuses an account that is only pending", () => {
    conn.prepare("UPDATE users SET status = 'pending' WHERE id = 1").run();
    expect(auth.login("admin@example.com", GOOD).ok).toBe(false);
  });

  it("refuses an account that was rejected", () => {
    conn.prepare("UPDATE users SET status = 'rejected' WHERE id = 1").run();
    expect(auth.login("admin@example.com", GOOD).ok).toBe(false);
  });

  it("refuses an approved account that has not set a password", () => {
    conn.prepare("UPDATE users SET password_hash = NULL, password_salt = NULL WHERE id = 1").run();
    expect(auth.login("admin@example.com", "").ok).toBe(false);
    expect(auth.login("admin@example.com", GOOD).ok).toBe(false);
  });
});

describe("sessions", () => {
  beforeEach(() => auth.setPassword(1, GOOD));

  it("resolves a session cookie to its account", () => {
    const { sessionId } = auth.login("admin@example.com", GOOD);
    expect(auth.accountForSession(sessionId)!.email).toBe("admin@example.com");
  });

  it("rejects an unknown or absent cookie", () => {
    expect(auth.accountForSession("made-up")).toBeNull();
    expect(auth.accountForSession(undefined)).toBeNull();
  });

  it("stops working the moment the account is rejected", () => {
    const { sessionId } = auth.login("admin@example.com", GOOD);
    auth.reject(1);
    // The whole reason sessions live server-side rather than in a signed cookie.
    expect(auth.accountForSession(sessionId)).toBeNull();
  });

  it("stops working once expired", () => {
    const { sessionId } = auth.login("admin@example.com", GOOD);
    conn.prepare("UPDATE auth_sessions SET expires_at = datetime('now', '-1 hour')").run();
    expect(auth.accountForSession(sessionId)).toBeNull();
  });

  it("signing out invalidates only that session", () => {
    const a = auth.login("admin@example.com", GOOD).sessionId!;
    const b = auth.login("admin@example.com", GOOD).sessionId!;
    auth.logout(a);
    expect(auth.accountForSession(a)).toBeNull();
    expect(auth.accountForSession(b)).not.toBeNull();
  });
});

describe("rate limiting", () => {
  it("locks a key out after repeated failures", () => {
    expect(auth.tooManyAttempts("email:x@example.com")).toBe(false);
    for (let i = 0; i < 8; i++) auth.recordFailedAttempt("email:x@example.com");
    expect(auth.tooManyAttempts("email:x@example.com")).toBe(true);
  });

  it("a success clears the count", () => {
    for (let i = 0; i < 8; i++) auth.recordFailedAttempt("email:x@example.com");
    auth.clearAttempts("email:x@example.com");
    expect(auth.tooManyAttempts("email:x@example.com")).toBe(false);
  });

  it("does not lock out a different key", () => {
    for (let i = 0; i < 8; i++) auth.recordFailedAttempt("email:x@example.com");
    expect(auth.tooManyAttempts("email:y@example.com")).toBe(false);
  });
});

describe("registration", () => {
  it("creates a pending account with no password", () => {
    const account = auth.register("Alex Kim", "Alex@Example.com ");
    expect(account).toMatchObject({ name: "Alex Kim", email: "alex@example.com", status: "pending" });
    expect(account.hasPassword).toBe(false);
    expect(account.role).toBe("member");
  });

  it("will not let a registrant grant themselves anything", () => {
    // Role and status are not inputs — there is no path from the form to them.
    const account = auth.register("Alex", "alex@example.com");
    expect(account.role).toBe("member");
    expect(account.status).toBe("pending");
  });

  it("rejects a duplicate address, whatever the case", () => {
    auth.register("Alex", "alex@example.com");
    expect(() => auth.register("Other", "ALEX@example.com")).toThrow(auth.RegistrationError);
  });

  it("rejects a duplicate display name", () => {
    auth.register("Alex", "alex@example.com");
    expect(() => auth.register("alex", "other@example.com")).toThrow(auth.RegistrationError);
  });

  it("rejects a malformed address or empty name", () => {
    expect(() => auth.register("Alex", "not-an-email")).toThrow(auth.RegistrationError);
    expect(() => auth.register("", "alex@example.com")).toThrow(auth.RegistrationError);
  });
});

describe("approval and invite links", () => {
  function pending() {
    return auth.register("Alex", "alex@example.com");
  }

  it("approving mints a working single-use token", () => {
    const { token } = auth.approve(pending().id);
    expect(auth.checkSetPasswordToken(token).ok).toBe(true);
  });

  it("stores only the hash of the token", () => {
    const { token } = auth.approve(pending().id);
    const rows = conn.prepare("SELECT token_hash AS h FROM auth_tokens").all() as { h: string }[];
    // A leaked database must not hand someone an outstanding invite.
    expect(rows.some((r) => r.h === token)).toBe(false);
    expect(rows[0].h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("redeeming sets the password and signs the account in", () => {
    const account = pending();
    const { token } = auth.approve(account.id);
    auth.redeemSetPasswordToken(token, GOOD);
    expect(auth.login("alex@example.com", GOOD).ok).toBe(true);
  });

  it("a token works exactly once", () => {
    const { token } = auth.approve(pending().id);
    auth.redeemSetPasswordToken(token, GOOD);
    expect(() => auth.redeemSetPasswordToken(token, "another-password")).toThrow(/already been used/);
  });

  it("an expired token is refused", () => {
    const { token } = auth.approve(pending().id);
    conn.prepare("UPDATE auth_tokens SET expires_at = datetime('now', '-1 hour')").run();
    expect(auth.checkSetPasswordToken(token).ok).toBe(false);
    expect(() => auth.redeemSetPasswordToken(token, GOOD)).toThrow(/expired/);
  });

  it("a made-up token is refused", () => {
    expect(auth.checkSetPasswordToken("not-a-real-token").ok).toBe(false);
  });

  it("a weak password is refused and the token stays unused", () => {
    const { token } = auth.approve(pending().id);
    expect(() => auth.redeemSetPasswordToken(token, "short")).toThrow(/at least 10/);
    expect(auth.checkSetPasswordToken(token).ok).toBe(true);
  });

  it("declining kills outstanding invites and sessions", () => {
    const account = pending();
    const { token } = auth.approve(account.id);
    auth.reject(account.id);
    expect(auth.checkSetPasswordToken(token).ok).toBe(false);
  });

  it("a pending account cannot sign in even holding a token", () => {
    const account = pending();
    // No approval — mint a token directly and redeem it.
    const token = auth.createSetPasswordToken(account.id);
    auth.redeemSetPasswordToken(token, GOOD);
    expect(auth.login("alex@example.com", GOOD).ok).toBe(false);
  });
});
