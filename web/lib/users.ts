import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";
import { SESSION_COOKIE, accountForSession, type Account } from "./auth";

/**
 * Who the current request belongs to.
 *
 * This used to be a cookie the browser could set to any profile id — a picker,
 * not a login. Identity now comes from the signed-in session, so nothing here
 * lets a caller choose whose practice history it reads or writes.
 */

export type User = Account;

export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in.");
  }
}

/** The signed-in account, or null. */
export async function currentAccount(): Promise<Account | null> {
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value;
  return accountForSession(sessionId);
}

/**
 * The signed-in account's id.
 *
 * Throws rather than falling back to some default account: a page that reaches
 * this without a session is a hole in the middleware, and quietly attributing
 * the request to somebody else would be far worse than a 500.
 */
export async function currentUserId(): Promise<number> {
  const account = await currentAccount();
  if (!account) throw new NotSignedInError();
  return account.id;
}

export async function currentUser(): Promise<Account> {
  const account = await currentAccount();
  if (!account) throw new NotSignedInError();
  return account;
}

/**
 * The signed-in account, or a redirect to the sign-in page.
 *
 * For pages. The middleware only checks that a session cookie *exists* — it
 * runs on the Edge runtime and cannot open the database — so a cookie for a
 * revoked or expired session reaches the page anyway. Without this the page
 * would throw and the person would see a 500 instead of a login form.
 */
export async function requireAccount(next?: string): Promise<Account> {
  const account = await currentAccount();
  if (!account) {
    redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  }
  return account;
}

export async function requireAdmin(): Promise<Account> {
  const account = await currentUser();
  if (account.role !== "admin") throw new Error("Admins only.");
  return account;
}

/** Every account, for the admin screen. */
export function listUsers(): User[] {
  return db()
    .prepare(
      `SELECT id, name, email, role, status,
              (password_hash IS NOT NULL) AS hasPassword,
              created_at AS createdAt, approved_at AS approvedAt,
              last_login_at AS lastLoginAt
       FROM users ORDER BY id`,
    )
    .all()
    .map((r) => ({ ...(r as Record<string, unknown>), hasPassword: Boolean((r as Record<string, unknown>).hasPassword) })) as User[];
}

/** How much practice each account has recorded. */
export function attemptCounts(): Map<number, number> {
  const rows = db()
    .prepare(
      `SELECT s.user_id AS userId, COUNT(a.id) AS n
       FROM sessions s LEFT JOIN attempts a ON a.session_id = s.id
       GROUP BY s.user_id`,
    )
    .all() as { userId: number; n: number }[];
  return new Map(rows.map((r) => [r.userId, r.n]));
}
