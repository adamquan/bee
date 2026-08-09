/**
 * The session cookie's name, and nothing else.
 *
 * Kept apart from `lib/auth` because the middleware needs it and runs on the
 * Edge runtime, where neither `node:crypto` nor better-sqlite3 can be bundled.
 * Importing the auth module there fails the build.
 */
export const SESSION_COOKIE = "bee_session";
