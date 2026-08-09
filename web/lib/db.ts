import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { migrate } from "./migrate";

/**
 * Single shared connection to the SQLite file the crawler also writes.
 * WAL mode lets the crawler keep ingesting while the app is serving.
 */

/**
 * Locate the repo root by walking up for `shared/schema.sql`.
 *
 * `process.cwd()` is not dependable here: Next's standalone server chdirs into
 * `.next/standalone`, which silently pointed the app at an empty database.
 */
function findRepoRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "shared", "schema.sql"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const REPO_ROOT = findRepoRoot();

export const DATA_DIR =
  process.env.BEE_DATA_DIR ?? path.join(REPO_ROOT ?? path.join(process.cwd(), ".."), "data");
const DB_PATH = process.env.BEE_DB_PATH ?? path.join(DATA_DIR, "bee.db");
/**
 * The database baked into the image. Deliberately outside DATA_DIR: a volume
 * mounted there would hide a seed placed inside it, and the app would come up
 * empty. Copying it in instead populates a fresh volume and still keeps every
 * write made afterwards.
 */
const SEED_DB_PATH = process.env.BEE_SEED_DB ?? "/opt/bee/seed.db";
const SCHEMA_PATH =
  process.env.BEE_SCHEMA_PATH ??
  path.join(REPO_ROOT ?? path.join(process.cwd(), ".."), "shared", "schema.sql");

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (instance) return instance;

  if (!fs.existsSync(SCHEMA_PATH)) {
    // Failing here beats opening an empty database and reporting "0 questions"
    // as though the bank were simply unbuilt.
    throw new Error(
      `Cannot find shared/schema.sql (looked at ${SCHEMA_PATH}). ` +
        `Set BEE_SCHEMA_PATH, or run the app from the repository.`,
    );
  }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  // First boot against an empty volume: install the seed the image carries.
  // Never overwrites — an existing file holds the real accounts and practice.
  const empty = !fs.existsSync(DB_PATH) || fs.statSync(DB_PATH).size === 0;
  if (empty && fs.existsSync(SEED_DB_PATH)) {
    fs.copyFileSync(SEED_DB_PATH, DB_PATH);
    console.log(`[bee] installed the bundled database from ${SEED_DB_PATH}`);
  }

  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.pragma("busy_timeout = 10000");

  // Applying the schema on boot means a fresh `docker compose up` with an
  // empty volume still starts, and the crawler can attach to the same file.
  conn.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  // schema.sql only creates what is missing; altering what already exists is
  // the migration's job, and it must run second.
  migrate(conn);

  instance = conn;
  return conn;
}

export const INBOX_DIR = process.env.BEE_INBOX_DIR ?? path.join(DATA_DIR, "inbox");

/** True when question generation / LLM judging are available. */
export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
