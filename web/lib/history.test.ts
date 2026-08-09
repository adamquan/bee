import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bee-journal-"));
const repoRoot = path.resolve(__dirname, "..", "..");

process.env.BEE_DB_PATH = path.join(tmp, "test.db");
process.env.BEE_SCHEMA_PATH = path.join(repoRoot, "shared", "schema.sql");
process.env.BEE_HISTORY_PATH = path.join(tmp, "nested", "history.jsonl");

type HistoryModule = typeof import("./history");
let mod: HistoryModule;

const ATTEMPT = {
  kind: "attempt",
  attemptId: 1,
  sessionId: 1,
  userId: 1,
  questionId: 101,
  buzzClueOrdinal: 2,
  clueCount: 4,
  response: "Charlemagne",
  verdict: "correct",
  judgedBy: "exact",
  latencyMs: 1800,
  createdAt: "2026-07-31 09:00:00",
} as const;

beforeAll(async () => {
  mod = await import("./history");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function lines(): unknown[] {
  return fs
    .readFileSync(mod.HISTORY_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("appendHistory", () => {
  it("creates the directory and writes one JSON object per line", () => {
    mod.appendHistory({
      kind: "session",
      sessionId: 1,
      userId: 1,
      userName: "Student",
      format: "buzz",
      origin: "both",
      difficulty: null,
      filters: { tags: [], mode: "mixed" },
      startedAt: "2026-07-31 08:59:00",
    });
    mod.appendHistory({ ...ATTEMPT });

    const written = lines();
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({ kind: "session", sessionId: 1 });
    expect(written[1]).toEqual(ATTEMPT);
  });

  it("appends rather than truncating", () => {
    const before = lines().length;
    mod.appendHistory({ ...ATTEMPT, attemptId: 2, questionId: 102 });
    expect(lines()).toHaveLength(before + 1);
  });

  it("never writes a bare newline that would parse as a blank record", () => {
    const raw = fs.readFileSync(mod.HISTORY_PATH, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).not.toMatch(/\n\n/);
  });

  it("swallows write failures so a full disk cannot break the quiz", () => {
    const spy = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("ENOSPC");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => mod.appendHistory({ ...ATTEMPT })).not.toThrow();

    spy.mockRestore();
    warn.mockRestore();
  });

  it("warns only once, so a persistent failure does not flood the log", () => {
    const spy = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("ENOSPC");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mod.appendHistory({ ...ATTEMPT });
    mod.appendHistory({ ...ATTEMPT });
    mod.appendHistory({ ...ATTEMPT });

    // The first failure already warned in the previous test.
    expect(warn).not.toHaveBeenCalled();

    spy.mockRestore();
    warn.mockRestore();
  });
});

describe("clearHistory", () => {
  async function seed() {
    const { db } = await import("./db");
    const conn = db();
    conn.exec("DELETE FROM attempts; DELETE FROM sessions; DELETE FROM review_queue");
    conn
      .prepare(
        `INSERT INTO questions (id, type, origin, difficulty, answer, fingerprint)
         VALUES (500, 'tossup', 'official', 'middle', 'Hannibal', 'fp-500')
         ON CONFLICT(id) DO NOTHING`,
      )
      .run();
    conn
      .prepare(
        `INSERT INTO sessions (id, user_id, format, origin_filter, filters_json)
         VALUES (1, 1, 'buzz', 'both', '{}')`,
      )
      .run();
    conn
      .prepare(
        `INSERT INTO attempts (session_id, question_id, verdict) VALUES (1, 500, 'incorrect')`,
      )
      .run();
    conn
      .prepare(
        `INSERT INTO review_queue (user_id, question_id, due_at)
         VALUES (1, 500, datetime('now'))`,
      )
      .run();
    return conn;
  }

  function counts(conn: import("better-sqlite3").Database) {
    return conn
      .prepare(
        `SELECT (SELECT COUNT(*) FROM attempts) AS attempts,
                (SELECT COUNT(*) FROM sessions) AS sessions,
                (SELECT COUNT(*) FROM review_queue) AS review`,
      )
      .get() as { attempts: number; sessions: number; review: number };
  }

  it("empties attempts, sessions, and the review queue", async () => {
    const conn = await seed();
    const result = mod.clearHistory(1);

    expect(result.cleared).toEqual({ attempts: 1, sessions: 1, review: 1 });
    expect(counts(conn)).toEqual({ attempts: 0, sessions: 0, review: 0 });
  });

  it("leaves the question bank alone", async () => {
    const conn = await seed();
    mod.clearHistory(1);
    expect(
      (conn.prepare("SELECT COUNT(*) AS n FROM questions").get() as { n: number }).n,
    ).toBeGreaterThan(0);
  });

  it("archives the journal rather than deleting it", async () => {
    await seed();
    mod.appendHistory({ ...ATTEMPT });
    const contents = fs.readFileSync(mod.HISTORY_PATH, "utf8");

    const result = mod.clearHistory(1);

    expect(result.archived).toMatch(/^history-cleared-.*\.jsonl$/);
    expect(fs.existsSync(mod.HISTORY_PATH)).toBe(false);
    const archived = path.join(path.dirname(mod.HISTORY_PATH), result.archived!);
    expect(fs.readFileSync(archived, "utf8")).toBe(contents);
  });

  it("produces an archive name with no characters Windows rejects", async () => {
    await seed();
    mod.appendHistory({ ...ATTEMPT });
    const result = mod.clearHistory(1);
    expect(result.archived).not.toMatch(/[:*?"<>|]/);
  });

  it("does not clear the database if the journal cannot be archived", async () => {
    const conn = await seed();
    mod.appendHistory({ ...ATTEMPT });
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EPERM");
    });

    expect(() => mod.clearHistory(1)).toThrow();
    // A restore would otherwise replay the journal into a wiped database.
    expect(counts(conn).attempts).toBe(1);

    spy.mockRestore();
  });

  it("works when no journal exists yet", async () => {
    const conn = await seed();
    fs.rmSync(mod.HISTORY_PATH, { force: true });

    const result = mod.clearHistory(1);

    expect(result.archived).toBeNull();
    expect(counts(conn)).toEqual({ attempts: 0, sessions: 0, review: 0 });
  });

  it("is safe to run twice", async () => {
    await seed();
    mod.clearHistory(1);
    const second = mod.clearHistory(1);
    expect(second.cleared).toEqual({ attempts: 0, sessions: 0, review: 0 });
  });

  it("keeps recording after a clear", async () => {
    const conn = await seed();
    mod.clearHistory(1);
    mod.appendHistory({ ...ATTEMPT });

    expect(fs.existsSync(mod.HISTORY_PATH)).toBe(true);
    expect(counts(conn).attempts).toBe(0);
  });
});

