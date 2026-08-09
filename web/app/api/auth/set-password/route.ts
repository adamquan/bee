import { NextResponse } from "next/server";
import { SESSION_COOKIE, accountById, login, redeemSetPasswordToken } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Redeem an invite link and sign the account straight in. */
export async function POST(request: Request) {
  const { token, password } = (await request.json()) as { token?: string; password?: string };
  if (!token || !password) {
    return NextResponse.json({ error: "Missing token or password." }, { status: 400 });
  }

  let userId: number;
  try {
    userId = redeemSetPasswordToken(token, password);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }

  const account = accountById(userId);
  if (!account?.email) return NextResponse.json({ ok: true, signedIn: false });

  // Straight in, rather than bouncing to a login form to retype what was just
  // chosen. Goes through the same `login` path so nothing skips its checks.
  const result = login(account.email, password, request.headers.get("user-agent") ?? undefined);
  if (!result.ok || !result.sessionId) return NextResponse.json({ ok: true, signedIn: false });

  db().prepare("DELETE FROM auth_sessions WHERE user_id = ? AND id <> ?").run(userId, result.sessionId);

  const response = NextResponse.json({ ok: true, signedIn: true });
  response.cookies.set(SESSION_COOKIE, result.sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && !!process.env.BEE_SITE_URL?.startsWith("https"),
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
