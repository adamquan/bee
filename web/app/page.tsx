import Link from "next/link";
import QuizSetup from "@/components/QuizSetup";
import { db, hasApiKey } from "@/lib/db";
import { reviewCounts } from "@/lib/review";
import { allTags } from "@/lib/selection";
import { requireAccount } from "@/lib/users";

export const dynamic = "force-dynamic";

function bankCounts() {
  const rows = db()
    .prepare(
      `SELECT type, origin, COUNT(*) AS n FROM questions GROUP BY type, origin`,
    )
    .all() as { type: string; origin: string; n: number }[];

  const get = (type: string, origin?: string) =>
    rows
      .filter((r) => r.type === type && (!origin || r.origin === origin))
      .reduce((sum, r) => sum + r.n, 0);

  return {
    tossups: get("tossup"),
    mcqs: get("mcq"),
    official: get("tossup", "official") + get("mcq", "official"),
    generated: get("tossup", "generated") + get("mcq", "generated"),
    total: rows.reduce((sum, r) => sum + r.n, 0),
  };
}

export default async function HomePage() {
  const user = await requireAccount();
  const bank = bankCounts();
  const tags = allTags().filter((t) => t.count > 0);
  const review = reviewCounts(user.id);
  const keyed = hasApiKey();

  if (bank.total === 0) {
    return (
      <div className="card mx-auto mt-10 max-w-2xl p-8">
        <h1 className="font-display text-2xl">The question bank is empty</h1>
        <p className="mt-3 text-ink-300">
          Build it with the crawler, which fetches the official past questions and study guides,
          then parses them into practice questions:
        </p>
        <pre className="mt-5 overflow-x-auto rounded-xl border border-ink-700 bg-ink-950 p-4 text-sm text-honey-300">
{`docker compose run --rm crawler build`}
        </pre>
        <p className="mt-4 text-sm text-ink-400">
          Or add your own material on the{" "}
          <Link href="/library" className="text-honey-400 underline underline-offset-4">
            Library
          </Link>{" "}
          page.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section className="pt-4">
        <h1 className="font-display text-3xl tracking-tight sm:text-4xl">
          What are we drilling today?
        </h1>
        <p className="mt-2 max-w-2xl text-ink-300">
          Buzzer tossups read one clue at a time and take a spoken answer. Multiple choice is the
          Regional Qualifying Exam format.
        </p>

        <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Tossups" value={bank.tossups} />
          <Stat label="Multiple choice" value={bank.mcqs} />
          <Stat label="Official" value={bank.official} />
          <Stat
            label="Due for review"
            value={review.due}
            accent={review.due > 0}
            hint={review.total > 0 ? `${review.total} in queue` : undefined}
          />
        </dl>
      </section>

      <QuizSetup
        tags={tags}
        hasReview={review.due > 0}
        counts={{ tossups: bank.tossups, mcqs: bank.mcqs }}
      />

      {!keyed && (
        <p className="card p-4 text-sm text-ink-300">
          <span className="font-medium text-warn-400">Running without a Claude API key.</span>{" "}
          Official questions, buzzing, and scoring all work. Question generation, auto-tagging,
          and moderator-style judging of close answers are unavailable — set{" "}
          <code className="rounded bg-ink-850 px-1.5 py-0.5 text-honey-300">ANTHROPIC_API_KEY</code>{" "}
          to enable them.
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  hint,
}: {
  label: string;
  value: number;
  accent?: boolean;
  hint?: string;
}) {
  return (
    <div className="card px-4 py-3">
      <dt className="text-xs uppercase tracking-wider text-ink-400">{label}</dt>
      <dd
        className={`mt-1 font-display text-2xl ${accent ? "text-honey-400" : "text-ink-100"}`}
      >
        {value.toLocaleString()}
      </dd>
      {hint && <p className="text-xs text-ink-400">{hint}</p>}
    </div>
  );
}
