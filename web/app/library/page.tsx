import Link from "next/link";
import { redirect } from "next/navigation";
import LibraryUploader from "@/components/LibraryUploader";
import { db } from "@/lib/db";
import { requireAccount } from "@/lib/users";
import {
  SOURCES_PER_PAGE,
  displayName,
  listSources,
  sourceSummary,
  type Facet,
  type SourceRow,
} from "@/lib/sources";

export const dynamic = "force-dynamic";

interface InboxRow {
  id: number;
  kind: "file" | "url";
  path_or_url: string;
  title: string | null;
  status: string;
  status_detail: string | null;
  created_at: string;
}

type Params = Record<string, string | string[] | undefined>;

function one(params: Params, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

/** Preserve the other filters when changing one, and reset to page 1. */
function href(params: Params, patch: Record<string, string | number | undefined>): string {
  const next = new URLSearchParams();
  for (const key of ["host", "kind", "status", "q", "page"]) {
    const value = one(params, key);
    if (value) next.set(key, value);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === "" || value === "all") next.delete(key);
    else next.set(key, String(value));
  }
  if (!("page" in patch)) next.delete("page");
  const qs = next.toString();
  return qs ? `/library?${qs}` : "/library";
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  // Admins only: the Library uploads material into the shared question bank
  // and exposes where every question came from. Members get sent home rather
  // than shown a 403 they can do nothing about.
  const account = await requireAccount("/library");
  if (account.role !== "admin") redirect("/");

  const params = await searchParams;
  const conn = db();

  const inbox = conn
    .prepare(
      `SELECT id, kind, path_or_url, title, status, status_detail, created_at
       FROM inbox ORDER BY id DESC LIMIT 25`,
    )
    .all() as InboxRow[];

  const summary = sourceSummary();
  const page = listSources({
    host: one(params, "host"),
    kind: one(params, "kind"),
    status: one(params, "status"),
    q: one(params, "q"),
    page: Number(one(params, "page")) || 1,
  });

  const filtered =
    page.total !== page.grandTotal ||
    Boolean(one(params, "q") || one(params, "host") || one(params, "kind") || one(params, "status"));
  const first = (page.page - 1) * SOURCES_PER_PAGE + 1;
  const last = Math.min(page.page * SOURCES_PER_PAGE, page.total);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="font-display text-3xl tracking-tight">Library</h1>
        <p className="mt-2 max-w-2xl text-ink-300">
          Add your own study material — PDFs, Word documents, or links. Uploads go through the
          same pipeline as the crawled sources: text extraction, question parsing, then tagging
          and explanations.
        </p>
      </section>

      <LibraryUploader />

      {inbox.length > 0 && (
        <section>
          <h2 className="mb-3 font-display text-xl">Queue</h2>
          <div className="card divide-y divide-ink-800">
            {inbox.map((item) => (
              <div key={item.id} className="flex items-start gap-4 p-4 text-sm">
                <StatusPill status={item.status} />
                <div className="min-w-0 flex-1">
                  <p className="truncate">{item.title ?? item.path_or_url}</p>
                  {item.status_detail && (
                    <p className="mt-0.5 text-xs text-ink-400">{item.status_detail}</p>
                  )}
                </div>
                <span className="shrink-0 text-xs text-ink-400">{item.kind}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-ink-400">
            Pending items are processed by the crawler:{" "}
            <code className="rounded bg-ink-850 px-1.5 py-0.5 text-honey-300">
              docker compose run --rm crawler ingest --inbox
            </code>
          </p>
        </section>
      )}

      <section>
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-xl">Sources</h2>
          <p className="text-sm text-ink-400">
            {summary.total.toLocaleString()} crawled from {summary.hosts} hosts ·{" "}
            {summary.withQuestions.toLocaleString()} yielded questions
          </p>
        </div>

        {summary.total === 0 ? (
          <p className="card p-5 text-sm text-ink-400">
            Nothing crawled yet. Run{" "}
            <code className="rounded bg-ink-850 px-1.5 py-0.5 text-honey-300">
              docker compose run --rm crawler build
            </code>
            .
          </p>
        ) : (
          <>
            <div className="card space-y-4 p-4">
              {/* A plain GET form, so search works with JavaScript disabled and
                  every filter state is a shareable URL. */}
              <form method="get" action="/library" className="flex flex-wrap gap-2">
                {(["host", "kind", "status"] as const).map((key) => {
                  const value = one(params, key);
                  return value ? (
                    <input key={key} type="hidden" name={key} value={value} />
                  ) : null;
                })}
                <input
                  type="search"
                  name="q"
                  defaultValue={one(params, "q") ?? ""}
                  placeholder="Search title or URL…"
                  aria-label="Search sources"
                  className="field flex-1 sm:max-w-sm"
                />
                <button type="submit" className="btn-ghost">
                  Search
                </button>
                {filtered && (
                  <Link href="/library" className="btn-quiet">
                    Clear filters
                  </Link>
                )}
              </form>

              <FacetRow label="Host" name="host" facets={page.hosts} params={params} />
              <FacetRow label="Type" name="kind" facets={page.kinds} params={params} />
              <FacetRow label="Status" name="status" facets={page.statuses} params={params} />
            </div>

            {page.total === 0 ? (
              <p className="card mt-4 p-5 text-sm text-ink-400">
                No sources match these filters.{" "}
                <Link href="/library" className="text-honey-300 hover:underline">
                  Clear them
                </Link>
                .
              </p>
            ) : (
              <>
                <p className="mt-4 text-sm text-ink-400">
                  Showing {first.toLocaleString()}–{last.toLocaleString()} of{" "}
                  {page.total.toLocaleString()}
                  {filtered && ` (filtered from ${page.grandTotal.toLocaleString()})`}
                </p>

                <ol className="card mt-2 divide-y divide-ink-800">
                  {page.rows.map((source) => (
                    <SourceItem
                      key={source.id}
                      source={source}
                      restricted={page.restricted.has(source.host)}
                    />
                  ))}
                </ol>

                <Pager params={params} page={page.page} pages={page.pages} />
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function SourceItem({ source, restricted }: { source: SourceRow; restricted: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
      <span className="w-20 shrink-0">
        <span className="chip">{source.kind}</span>
      </span>
      <div className="min-w-0 flex-1">
        <a
          href={source.url}
          target="_blank"
          rel="noreferrer noopener"
          title={source.url}
          className="block truncate text-ink-200 hover:text-honey-300"
        >
          {displayName(source)}
        </a>
        <p className="truncate text-xs text-ink-500">
          {source.host}
          {restricted && (
            <span
              className="ml-2 text-ink-400"
              title="Publisher signals ai-train=no — quizzing and reference only, never sent to a model as source material"
            >
              · reference only
            </span>
          )}
          {source.statusDetail && source.questions === 0 && (
            <span className="ml-2">· {source.statusDetail}</span>
          )}
        </p>
      </div>
      <span className="w-36 shrink-0 text-right text-xs tabular-nums">
        {source.questions > 0 ? (
          <>
            <span className="text-honey-300">{source.questions.toLocaleString()} questions</span>
            {source.contributed < source.questions && (
              <span
                className="block text-ink-500"
                title="The rest are republished in other packets and were imported from whichever copy was parsed first"
              >
                {source.contributed === 0
                  ? "all from other packets"
                  : `${source.contributed.toLocaleString()} first seen here`}
              </span>
            )}
          </>
        ) : (
          <span className="text-ink-500">{source.status}</span>
        )}
      </span>
    </li>
  );
}

function FacetRow({
  label,
  name,
  facets,
  params,
}: {
  label: string;
  name: string;
  facets: Facet[];
  params: Params;
}) {
  const active = one(params, name);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-14 shrink-0 text-xs font-semibold uppercase tracking-wider text-ink-500">
        {label}
      </span>
      <Link href={href(params, { [name]: undefined })} className={`chip ${!active ? "chip-on" : "hover:bg-ink-800"}`}>
        All
      </Link>
      {facets.map((facet) => (
        <Link
          key={facet.value}
          href={href(params, { [name]: active === facet.value ? undefined : facet.value })}
          className={`chip ${active === facet.value ? "chip-on" : "hover:bg-ink-800"}`}
        >
          {facet.value}
          <span className="ml-1.5 text-ink-500">{facet.count}</span>
        </Link>
      ))}
    </div>
  );
}

function Pager({ params, page, pages }: { params: Params; page: number; pages: number }) {
  if (pages <= 1) return null;

  // First, last, and a window around the current page — 80 pages of numbers
  // would be unusable.
  const window = new Set<number>([1, pages, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((n) => window.add(n));
  if (page >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach((n) => window.add(n));
  const numbers = [...window].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);

  return (
    <nav aria-label="Source pages" className="mt-4 flex flex-wrap items-center gap-1.5">
      <PagerLink params={params} to={page - 1} disabled={page === 1} label="Previous" />
      {numbers.map((n, i) => (
        <span key={n} className="flex items-center gap-1.5">
          {i > 0 && numbers[i - 1] !== n - 1 && <span className="px-1 text-ink-600">…</span>}
          <Link
            href={href(params, { page: n === 1 ? undefined : n })}
            aria-current={n === page ? "page" : undefined}
            className={`chip tabular-nums ${n === page ? "chip-on" : "hover:bg-ink-800"}`}
          >
            {n}
          </Link>
        </span>
      ))}
      <PagerLink params={params} to={page + 1} disabled={page === pages} label="Next" />
      <JumpToPage params={params} page={page} pages={pages} />
    </nav>
  );
}

/**
 * Direct page entry. With 80 pages the windowed numbers above only ever reach
 * the first few, the last few, and the current neighbourhood — everything in
 * between takes repeated clicks without this.
 *
 * A GET form rather than a controlled input: it keeps the page a server
 * component, works with JavaScript disabled, and lands on a real URL. An
 * out-of-range number is clamped by `listSources`, so there is nothing to
 * validate beyond what the browser already does.
 */
function JumpToPage({ params, page, pages }: { params: Params; page: number; pages: number }) {
  return (
    <form method="get" action="/library" className="ml-auto flex items-center gap-1.5">
      {(["host", "kind", "status", "q"] as const).map((key) => {
        const value = one(params, key);
        return value ? <input key={key} type="hidden" name={key} value={value} /> : null;
      })}
      <label htmlFor="page-jump" className="text-xs text-ink-400">
        Go to page
      </label>
      <input
        id="page-jump"
        type="number"
        name="page"
        min={1}
        max={pages}
        defaultValue={page}
        aria-label={`Page number, 1 to ${pages}`}
        className="field w-20 px-2 py-1 text-sm tabular-nums"
      />
      <span className="text-xs text-ink-500">of {pages}</span>
      <button type="submit" className="chip hover:bg-ink-800">
        Go
      </button>
    </form>
  );
}

function PagerLink({
  params,
  to,
  disabled,
  label,
}: {
  params: Params;
  to: number;
  disabled: boolean;
  label: string;
}) {
  if (disabled) {
    return <span className="chip cursor-not-allowed opacity-35">{label}</span>;
  }
  return (
    <Link href={href(params, { page: to === 1 ? undefined : to })} className="chip hover:bg-ink-800">
      {label}
    </Link>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone: Record<string, string> = {
    pending: "text-ink-400",
    processing: "text-honey-300",
    done: "text-good-400",
    error: "text-bad-400",
  };
  return (
    <span className={`w-20 shrink-0 text-xs uppercase tracking-wider ${tone[status] ?? ""}`}>
      {status}
    </span>
  );
}
