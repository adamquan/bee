import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  clearAttempts,
  login,
  recordFailedAttempt,
  tooManyAttempts,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Client address, for rate limiting. Behind a proxy this is the forwarded one. */
function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return (forwarded?.split(",")[0] ?? "local").trim();
}

export async function POST(request: Request) {
  const { email, password } = (await request.json()) as { email?: string; password?: string };
  if (!email || !password) {
    return NextResponse.json({ error: "Enter your email and password." }, { status: 400 });
  }

  // Two buckets: one per address, one per client. Neither a single account nor
  // a single host can be hammered.
  const keys = [`email:${email}`, `ip:${clientKey(request)}`];
  if (keys.some(tooManyAttempts)) {
    return NextResponse.json(
      { error: "Too many attempts. Wait a few minutes and try again." },
      { status: 429 },
    );
  }

  const result = login(email, password, request.headers.get("user-agent") ?? undefined);
  if (!result.ok || !result.sessionId) {
    keys.forEach(recordFailedAttempt);
    return NextResponse.json({ error: result.reason }, { status: 401 });
  }

  keys.forEach(clearAttempts);
  const response = NextResponse.json({
    ok: true,
    account: { name: result.account!.name, role: result.account!.role },
  });
  response.cookies.set(SESSION_COOKIE, result.sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && !!process.env.BEE_SITE_URL?.startsWith("https"),
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
