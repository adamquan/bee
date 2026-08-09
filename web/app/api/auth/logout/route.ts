import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, logout } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  logout((await cookies()).get(SESSION_COOKIE)?.value);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
