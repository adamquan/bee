import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session-cookie";

/**
 * Everything requires a signed-in account except the pages needed to get one.
 *
 * This is a gate, not the authorisation itself: middleware runs on the Edge
 * runtime and cannot open SQLite, so it only checks that a session cookie is
 * present. Whether that cookie names a live, approved account is settled by
 * `currentAccount()` on the page or route itself. A forged cookie gets past
 * here and then fails there.
 */

const PUBLIC_PATHS = ["/login", "/register", "/set-password"];
const PUBLIC_APIS = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/register",
  "/api/auth/set-password",
];

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const isPublic =
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    PUBLIC_APIS.some((p) => pathname === p);
  if (isPublic) return NextResponse.next();

  if (request.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();

  // An API call gets a status it can act on; a page gets sent to sign in, with
  // where it was headed so the trip resumes afterwards.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything but Next's own assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
