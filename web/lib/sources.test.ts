import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `lib/db` resolves its paths at module load, so the environment has to be set
 * before the dynamic import below.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bee-sources-"));
const repoRoot = path.resolve(__dirname, "..", "..");

process.env.BEE_DB_PATH = path.join(tmp, "test.db");
process.env.BEE_SCHEMA_PATH = path.join(repoRoot, "shared", "schema.sql");

type SourcesModule = typeof import("./sources");
let mod: SourcesModule;

const HOSTS = ["a.example", "b.example", "c.example"];

beforeAll(async () => {
  const { db } = await import("./db");
  mod = await import("./sources");
  const conn = db();

  const insert = conn.prepare(
    `INSERT INTO sources (id, url, host, kind, title, status, ai_train_ok)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // 60 sources: enough for three pages at 25 per page.
  for (let i = 1; i <= 60; i++) {
    insert.run(
      i,
      `https://${HOSTS[i % 3]}/packets/set-${i}.pdf`,
      HOSTS[i % 3],
      i % 4 === 0 ? "studyguide" : "packet",
      i % 5 === 0 ? null : `Set ${i}`,
      i % 7 === 0 ? "error" : "parsed",
      i === 3 ? 0 : 1,
    );
  }
  // One source with questions attached, to check the ordering and the count.
  conn
    .prepare(
      `INSERT INTO questions (id, type, origin, source_id, difficulty, answer, fingerprint)
       VALUES (1, 'tossup', 'official', 42, 'middle', 'Charlemagne', 'test-fp-1')`,
    )
    .run();
  // Coverage is tracked separately from credit; source 42 has both.
  conn
    .prepare("INSERT INTO question_sources (question_id, source_id) VALUES (1, 42)")
    .run();
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("listSources", () => {
  it("pages at 25 and reports the page count", () => {
    const first = mod.listSources();
    expect(first.rows).toHaveLength(25);
    expect(first.total).toBe(60);
    expect(first.pages).toBe(3);
    expect(first.page).toBe(1);

    const last = mod.listSources({ page: 3 });
    expect(last.rows).toHaveLength(10);
    expect(last.page).toBe(3);
  });

  it("does not repeat or skip rows across pages", () => {
    const ids = [1, 2, 3].flatMap((page) => mod.listSources({ page }).rows.map((r) => r.id));
    expect(new Set(ids).size).toBe(60);
  });

  it("clamps an out-of-range page instead of returning nothing", () => {
    expect(mod.listSources({ page: 99 }).page).toBe(3);
    expect(mod.listSources({ page: 0 }).rows.length).toBeGreaterThan(0);
    expect(mod.listSources({ page: -5 }).page).toBe(1);
  });

  it("puts sources that yielded questions first, with their count", () => {
    const top = mod.listSources().rows[0];
    expect(top.id).toBe(42);
    expect(top.questions).toBe(1);
    expect(top.contributed).toBe(1);
  });

  it("counts questions a source contains, not only those it contributed", async () => {
    // Source 7 republishes question 1, which was imported from source 42.
    const { db } = await import("./db");
    const conn = db();
    conn
      .prepare("INSERT OR IGNORE INTO question_sources (question_id, source_id) VALUES (1, 7)")
      .run();

    const row = mod.listSources({ host: HOSTS[7 % 3] }).rows.find((r) => r.id === 7)!;
    expect(row.questions).toBe(1); // contains it
    expect(row.contributed).toBe(0); // but did not supply it

    conn.prepare("DELETE FROM question_sources WHERE source_id = 7").run();
  });

  it("filters by host, kind, and status", () => {
    const byHost = mod.listSources({ host: "a.example" });
    expect(byHost.total).toBe(20);
    expect(byHost.rows.every((r) => r.host === "a.example")).toBe(true);

    expect(mod.listSources({ kind: "studyguide" }).total).toBe(15);
    expect(mod.listSources({ status: "error" }).total).toBe(8);
  });

  it("combines filters", () => {
    const both = mod.listSources({ host: "a.example", kind: "studyguide" });
    expect(both.total).toBeLessThan(20);
    expect(both.rows.every((r) => r.host === "a.example" && r.kind === "studyguide")).toBe(true);
  });

  it("treats 'all' as no constraint", () => {
    expect(mod.listSources({ host: "all", kind: "all", status: "all" }).total).toBe(60);
  });

  it("searches title and URL", () => {
    expect(mod.listSources({ q: "Set 7" }).total).toBe(1);
    // Title is null for multiples of 5, so this only matches via the URL.
    expect(mod.listSources({ q: "set-25.pdf" }).total).toBe(1);
    expect(mod.listSources({ q: "no-such-thing" }).total).toBe(0);
  });

  it("does not let LIKE wildcards in the query match everything", () => {
    expect(mod.listSources({ q: "%" }).total).toBe(0);
    expect(mod.listSources({ q: "_" }).total).toBe(0);
  });

  it("reports the unfiltered total alongside the filtered one", () => {
    const page = mod.listSources({ host: "a.example" });
    expect(page.total).toBe(20);
    expect(page.grandTotal).toBe(60);
  });

  it("returns facets covering every host, kind, and status", () => {
    const { hosts, kinds, statuses } = mod.listSources();
    expect(hosts.map((h) => h.value).sort()).toEqual(HOSTS);
    expect(hosts.reduce((n, h) => n + h.count, 0)).toBe(60);
    expect(kinds.map((k) => k.value).sort()).toEqual(["packet", "studyguide"]);
    expect(statuses.map((s) => s.value).sort()).toEqual(["error", "parsed"]);
  });

  it("keeps facet counts unfiltered so you can always widen again", () => {
    const narrowed = mod.listSources({ host: "a.example" });
    expect(narrowed.hosts.reduce((n, h) => n + h.count, 0)).toBe(60);
  });
});

describe("restrictedHosts", () => {
  it("rolls the per-row flag up to the host", () => {
    // Only source id 3 has ai_train_ok = 0, but the signal is a property of
    // the publisher — every source on its host is restricted.
    const hosts = mod.restrictedHosts();
    expect(hosts.has(HOSTS[3 % 3])).toBe(true);
    expect(hosts.size).toBe(1);
  });

  it("is exposed on the page result so unfetched rows are still flagged", () => {
    const page = mod.listSources({ host: HOSTS[0] });
    const pending = page.rows.find((r) => r.aiTrainOk === 1);
    expect(pending).toBeDefined();
    expect(page.restricted.has(pending!.host)).toBe(true);
  });
});

describe("sourceSummary", () => {
  it("counts sources, hosts, and restricted publishers", () => {
    const s = mod.sourceSummary();
    expect(s.total).toBe(60);
    expect(s.hosts).toBe(3);
    expect(s.withQuestions).toBe(1);
    expect(s.questionsFromSources).toBe(1);
    // Host-level: all 20 sources on the restricted host, not just the 1 row
    // whose ai_train_ok column was written.
    expect(s.aiTrainRestricted).toBe(20);
  });
});

describe("displayName", () => {
  const base = {
    id: 1,
    host: "x.example",
    kind: "packet",
    status: "parsed",
    statusDetail: null,
    bytes: null,
    fetchedAt: null,
    aiTrainOk: 1,
    questions: 0,
    contributed: 0,
  };

  it("prefers the title", () => {
    expect(mod.displayName({ ...base, url: "https://x.example/a.pdf", title: "Round 3" })).toBe(
      "Round 3",
    );
  });

  it("falls back to the decoded filename", () => {
    expect(
      mod.displayName({ ...base, url: "https://x.example/p/2019%20Nationals.pdf", title: null }),
    ).toBe("2019 Nationals.pdf");
  });

  it("ignores a blank title", () => {
    expect(mod.displayName({ ...base, url: "https://x.example/a.pdf", title: "   " })).toBe("a.pdf");
  });

  it("uses the document id, not the trailing verb, for Google Docs links", () => {
    expect(
      mod.displayName({
        ...base,
        url: "https://docs.google.com/document/d/abc123/export?format=txt",
        title: null,
      }),
    ).toBe("abc123");
    expect(
      mod.displayName({
        ...base,
        url: "https://docs.google.com/spreadsheets/d/xyz789/edit?gid=0",
        title: null,
      }),
    ).toBe("xyz789");
  });

  it("uses the id query parameter for Drive download links", () => {
    expect(
      mod.displayName({
        ...base,
        url: "https://drive.google.com/uc?export=download&id=1fznsWVnXsht",
        title: null,
      }),
    ).toBe("1fznsWVnXsht");
  });

  it("falls back to the raw value when the URL will not parse", () => {
    expect(mod.displayName({ ...base, url: "not a url", title: null })).toBe("not a url");
  });
});
