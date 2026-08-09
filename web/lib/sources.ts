import { db } from "./db";

/** Browsing the crawled source list: filters, facets, and pagination. */

export const SOURCES_PER_PAGE = 25;

export interface SourceRow {
  id: number;
  url: string;
  host: string;
  kind: string;
  title: string | null;
  status: string;
  statusDetail: string | null;
  bytes: number | null;
  fetchedAt: string | null;
  aiTrainOk: number;
  /** Questions this source contains, including ones another packet supplied. */
  questions: number;
  /** Of those, how many entered the bank from this source. */
  contributed: number;
}

export interface SourceFilters {
  host?: string;
  kind?: string;
  status?: string;
  /** Substring match over title and URL. */
  q?: string;
  page?: number;
}

export interface Facet {
  value: string;
  count: number;
}

export interface SourcePage {
  rows: SourceRow[];
  total: number;
  page: number;
  pages: number;
  /** Total across the whole table, ignoring filters — for "N of M". */
  grandTotal: number;
  hosts: Facet[];
  kinds: Facet[];
  statuses: Facet[];
  /** Hosts that published `ai-train=no`. See `restrictedHosts()`. */
  restricted: Set<string>;
}

/**
 * Hosts whose publisher signalled `ai-train=no`.
 *
 * The per-row `ai_train_ok` column is only written once a source has actually
 * been fetched and its `Content-Signal` header read, so rows still `pending`
 * carry the default of 1 even on a restricted host. The signal is a property
 * of the host, not the document, so roll it up — otherwise the Library page
 * shows an unfetched quizbowlpackets file as unrestricted.
 */
export function restrictedHosts(): Set<string> {
  const rows = db()
    .prepare("SELECT DISTINCT host FROM sources WHERE ai_train_ok = 0")
    .all() as { host: string }[];
  return new Set(rows.map((r) => r.host));
}

/** Build the shared WHERE fragment. Empty/"all" values mean no constraint. */
function where(filters: SourceFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.host && filters.host !== "all") {
    clauses.push("s.host = ?");
    params.push(filters.host);
  }
  if (filters.kind && filters.kind !== "all") {
    clauses.push("s.kind = ?");
    params.push(filters.kind);
  }
  if (filters.status && filters.status !== "all") {
    clauses.push("s.status = ?");
    params.push(filters.status);
  }
  const term = filters.q?.trim();
  if (term) {
    // LIKE, not FTS: `sources` isn't in the full-text index, and the list is
    // small enough (~2k rows) that a scan is imperceptible.
    clauses.push("(s.title LIKE ? OR s.url LIKE ?)");
    const like = `%${term.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listSources(filters: SourceFilters = {}): SourcePage {
  const conn = db();
  const { sql, params } = where(filters);

  const { n: total } = conn
    .prepare(`SELECT COUNT(*) AS n FROM sources s ${sql}`)
    .get(...params) as { n: number };

  const pages = Math.max(1, Math.ceil(total / SOURCES_PER_PAGE));
  const page = Math.min(Math.max(1, filters.page ?? 1), pages);
  const offset = (page - 1) * SOURCES_PER_PAGE;

  const rows = conn
    .prepare(
      `SELECT s.id, s.url, s.host, s.kind, s.title, s.status, s.status_detail AS statusDetail,
              s.bytes, s.fetched_at AS fetchedAt, s.ai_train_ok AS aiTrainOk,
              -- Coverage, not credit: the same tossup is republished across
              -- divisional packets and only the first copy parsed gets
              -- questions.source_id, which reported 60-question packets as "1".
              (SELECT COUNT(*) FROM question_sources qs WHERE qs.source_id = s.id) AS questions,
              (SELECT COUNT(*) FROM questions q WHERE q.source_id = s.id) AS contributed
       FROM sources s
       ${sql}
       ORDER BY questions DESC, s.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, SOURCES_PER_PAGE, offset) as SourceRow[];

  // Facets are computed over the whole table rather than the filtered set, so
  // the counts stay stable as you narrow down and you can always widen again.
  const facet = (column: "host" | "kind" | "status"): Facet[] =>
    conn
      .prepare(
        `SELECT ${column} AS value, COUNT(*) AS count
         FROM sources GROUP BY ${column} ORDER BY count DESC`,
      )
      .all() as Facet[];

  const { n: grandTotal } = conn.prepare("SELECT COUNT(*) AS n FROM sources").get() as {
    n: number;
  };

  return {
    rows,
    total,
    page,
    pages,
    grandTotal,
    hosts: facet("host"),
    kinds: facet("kind"),
    statuses: facet("status"),
    restricted: restrictedHosts(),
  };
}

export interface SourceSummary {
  total: number;
  withQuestions: number;
  questionsFromSources: number;
  hosts: number;
  aiTrainRestricted: number;
}

export function sourceSummary(): SourceSummary {
  const conn = db();
  return conn
    .prepare(
      `SELECT (SELECT COUNT(*) FROM sources) AS total,
              (SELECT COUNT(DISTINCT source_id) FROM question_sources) AS withQuestions,
              (SELECT COUNT(*) FROM questions WHERE source_id IS NOT NULL)
                AS questionsFromSources,
              (SELECT COUNT(DISTINCT host) FROM sources) AS hosts,
              -- Host-level, for the reason given on restrictedHosts().
              (SELECT COUNT(*) FROM sources WHERE host IN
                 (SELECT host FROM sources WHERE ai_train_ok = 0)) AS aiTrainRestricted`,
    )
    .get() as SourceSummary;
}

/**
 * Path segments that are verbs rather than identities. Google Docs and Drive
 * links end in one — `/document/d/<id>/export`, `/uc?export=download&id=<id>` —
 * so taking the last segment naively labels a third of the bank "export".
 */
const GENERIC_SEGMENT = new Set([
  "export", "edit", "view", "preview", "open", "pub", "uc", "download", "file", "d",
]);

/** A readable stand-in when the crawler never captured a title. */
export function displayName(source: SourceRow): string {
  if (source.title?.trim()) return source.title.trim();
  try {
    const { pathname, searchParams } = new URL(source.url);
    // Walk back from the end for the first segment that identifies something.
    const segments = pathname.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = decodeURIComponent(segments[i]);
      if (!GENERIC_SEGMENT.has(segment.toLowerCase())) return segment;
    }
    const id = searchParams.get("id");
    if (id) return id;
  } catch {
    /* fall through to the raw URL */
  }
  return source.url;
}
