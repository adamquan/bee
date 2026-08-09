import Link from "next/link";
import ClearHistoryButton from "@/components/ClearHistoryButton";
import DrillButton from "@/components/DrillButton";
import LocalTime from "@/components/LocalTime";
import { hasApiKey } from "@/lib/db";
import { reviewCounts, reviewList } from "@/lib/review";
import { accuracyByTag, mostMissed, overview, recentSessions, weakAreas } from "@/lib/stats";
import { requireAccount } from "@/lib/users";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireAccount("/dashboard");
  const o = overview(user.id);
  const sessions = recentSessions(user.id);
  const weak = weakAreas(user.id);
  const tagAccuracy = accuracyByTag(user.id, 2);
  const review = reviewCounts(user.id);
  const queue = reviewList(user.id, 12);
  const missed = mostMissed(user.id, 8);
  const keyed = hasApiKey();

  if (o.attempts === 0) {
    return (
      <div className="card mx-auto mt-10 max-w-xl p-8 text-center">
        <h1 className="font-display text-2xl">No practice yet for {user.name}</h1>
        <p className="mt-2 text-ink-300">
          Answer a few questions and this page will show {user.name}&apos;s accuracy, how early
          they buzz, and which categories need work. Every profile keeps its own history.
        </p>
        <Link href="/" className="btn-primary mt-6">
          Start practising
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl tracking-tight">{user.name}</h1>
            <p className="mt-1 text-sm text-ink-400">
              Practice history for this profile. Switch profiles from the header.
            </p>
          </div>
          <ClearHistoryButton
            attempts={o.attempts}
            sessions={o.sessions}
            review={review.total}
          />
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Questions answered" value={o.attempts.toLocaleString()} />
          <Stat label="Accuracy" value={`${Math.round(o.accuracy * 100)}%`} accent />
          <Stat
            label="Average buzz point"
            value={o.buzzPosition === null ? "—" : `${Math.round(o.buzzPosition * 100)}%`}
            hint="through the clues; lower is better"
          />
          <Stat label="Sessions" value={String(o.sessions)} />
        </dl>
      </section>

      {/* ------------------------------------------------- weak areas ---- */}
      <section>
        <SectionHeading
          title="Where to study next"
          hint="Categories below your own average, with at least four attempts."
        />
        {weak.length === 0 ? (
          <p className="card p-5 text-sm text-ink-400">
            Nothing stands out yet — keep practising and weak categories will surface here.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {weak.map((area) => (
              <div key={area.tag} className="card p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-medium">{area.tag}</h3>
                  <span className="tabular-nums text-sm text-bad-400">
                    {Math.round(area.accuracy * 100)}%
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-400">
                  {area.correct} of {area.attempts} correct · {area.unseen} unseen question
                  {area.unseen === 1 ? "" : "s"} in the bank
                </p>

                <Meter value={area.accuracy} />

                {area.resources.length > 0 && (
                  <ul className="mt-3 space-y-1 text-xs">
                    {area.resources.map((resource) => (
                      <li key={resource.url}>
                        <a
                          href={resource.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-honey-400 underline underline-offset-4 hover:text-honey-300"
                        >
                          {resource.title.slice(0, 70)}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  <Link
                    href={`/quiz/buzz?origin=both&difficulty=any&mode=mixed&tags=${encodeURIComponent(area.tag)}`}
                    className="btn-ghost text-xs"
                  >
                    Drill this category
                  </Link>
                  {area.unseen < 5 && <DrillButton tag={area.tag} enabled={keyed} />}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---------------------------------------------- review queue ----- */}
      <section>
        <SectionHeading
          title="Missed questions"
          hint={
            review.total > 0
              ? `${review.due} due now of ${review.total} saved for retaking.`
              : "Questions you miss are saved here to come back around."
          }
        />
        {queue.length === 0 ? (
          <p className="card p-5 text-sm text-ink-400">Nothing saved for review.</p>
        ) : (
          <div className="card divide-y divide-ink-800">
            {queue.map((item) => (
              <div key={item.questionId} className="flex items-start gap-4 p-4">
                <span
                  className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                    item.overdue ? "bg-honey-400" : "bg-ink-600"
                  }`}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink-300">{item.prompt}</p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    Answer: <span className="text-honey-300">{item.answer}</span> · missed{" "}
                    {item.lapses}×
                  </p>
                </div>
                <span className="shrink-0 text-xs text-ink-400">
                  {item.overdue ? "due now" : <LocalTime utc={item.dueAt} mode="date" />}
                </span>
              </div>
            ))}
          </div>
        )}
        {review.due > 0 && (
          <Link href="/quiz/buzz?origin=both&difficulty=any&mode=review" className="btn-primary mt-3">
            Retake the {review.due} due
          </Link>
        )}
      </section>

      {/* ------------------------------------------- accuracy by tag ----- */}
      {tagAccuracy.length > 0 && (
        <section>
          <SectionHeading title="Accuracy by category" />
          <div className="card divide-y divide-ink-800">
            {tagAccuracy.map((row) => (
              <div key={row.tag} className="flex items-center gap-4 px-4 py-2.5">
                <span className="w-44 shrink-0 truncate text-sm">{row.tag}</span>
                <div className="flex-1">
                  <Meter value={row.accuracy} />
                </div>
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-ink-400">
                  {row.correct}/{row.attempts} · {Math.round(row.accuracy * 100)}%
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* --------------------------------------------- most missed ------- */}
      {missed.length > 0 && (
        <section>
          <SectionHeading title="Most-missed answers" />
          <div className="flex flex-wrap gap-2">
            {missed.map((m) => (
              <span key={m.id} className="chip">
                {m.answer}
                <span className="ml-1.5 text-bad-400">{m.misses}×</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* ------------------------------------------------- sessions ------ */}
      <section>
        <SectionHeading title="Recent sessions" />
        <div className="card divide-y divide-ink-800">
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <span className="text-ink-300">
                <LocalTime utc={s.startedAt} />
              </span>
              <span className="flex items-center gap-3">
                <span className="chip">{s.format === "buzz" ? "buzzer" : "multiple choice"}</span>
                <span className="tabular-nums text-ink-300">
                  {s.correct}/{s.questions}
                </span>
                <span className="w-12 text-right tabular-nums text-ink-400">
                  {Math.round(s.accuracy * 100)}%
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3">
      <h2 className="font-display text-xl">{title}</h2>
      {hint && <p className="mt-0.5 text-sm text-ink-400">{hint}</p>}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="card px-4 py-3">
      <dt className="text-xs uppercase tracking-wider text-ink-400">{label}</dt>
      <dd className={`mt-1 font-display text-2xl ${accent ? "text-honey-400" : ""}`}>{value}</dd>
      {hint && <p className="text-xs text-ink-400">{hint}</p>}
    </div>
  );
}

function Meter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 70 ? "bg-good-600" : pct >= 45 ? "bg-honey-500" : "bg-bad-600";
  return (
    <div
      className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink-800"
      role="img"
      aria-label={`${pct} percent`}
    >
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(2, pct)}%` }} />
    </div>
  );
}
