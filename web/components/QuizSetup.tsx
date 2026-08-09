"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DEFAULT_QUESTION_COUNT, QUESTION_COUNTS } from "@/lib/client-api";
import type { Difficulty } from "@/lib/types";

/** Covers bee.md requirement 3: format, source, difficulty, and category. */

const FORMATS = [
  { id: "buzz", label: "Buzzer tossups", hint: "Pyramidal clues, answer out loud" },
  { id: "mcq", label: "Multiple choice", hint: "Regional Qualifying Exam style" },
] as const;

const ORIGINS = [
  { id: "both", label: "Both" },
  { id: "official", label: "Official only" },
  { id: "generated", label: "Generated only" },
] as const;

const DIFFICULTIES: { id: Difficulty | "any"; label: string }[] = [
  { id: "any", label: "Any" },
  { id: "elementary", label: "Elementary" },
  { id: "middle", label: "Middle school" },
  { id: "high", label: "High school" },
  { id: "open", label: "Open" },
];

interface Props {
  tags: { name: string; kind: string; count: number }[];
  hasReview: boolean;
  counts: { tossups: number; mcqs: number };
}

export default function QuizSetup({ tags, hasReview, counts }: Props) {
  const router = useRouter();
  const [format, setFormat] = useState<"buzz" | "mcq">(counts.tossups > 0 ? "buzz" : "mcq");
  const [origin, setOrigin] = useState<"official" | "generated" | "both">("both");
  const [difficulty, setDifficulty] = useState<Difficulty | "any">("any");
  const [mode, setMode] = useState<"mixed" | "fresh" | "review">("mixed");
  const [selected, setSelected] = useState<string[]>([]);
  const [count, setCount] = useState<number>(DEFAULT_QUESTION_COUNT);

  const [avail, setAvail] = useState<{ total: number; byTag: Record<string, number> } | null>(null);
  const [checking, setChecking] = useState(false);

  // Ask the server what these filters actually match. Without this the screen
  // happily offers combinations with nothing behind them — picking
  // "elementary" + "Art History" used to start a session that ended instantly.
  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    const timer = setTimeout(() => {
      fetch("/api/questions/count", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format, origin, difficulty, tags: selected }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (!cancelled) setAvail(data);
        })
        .catch(() => {
          if (!cancelled) setAvail(null);
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [format, origin, difficulty, selected]);

  function toggleTag(name: string) {
    setSelected((prev) =>
      prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name],
    );
  }

  function start() {
    const params = new URLSearchParams({ origin, difficulty, mode, count: String(count) });
    if (selected.length) params.set("tags", selected.join(","));
    router.push(`/quiz/${format}?${params.toString()}`);
  }

  const matching = avail?.total ?? null;
  const unavailable =
    matching !== null
      ? matching === 0
      : (format === "buzz" && counts.tossups === 0) || (format === "mcq" && counts.mcqs === 0);

  return (
    <section className="card p-6">
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <span className="label">Format</span>
          <div className="grid gap-2">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFormat(f.id)}
                aria-pressed={format === f.id}
                className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                  format === f.id
                    ? "border-honey-500 bg-honey-500/10"
                    : "border-ink-700 hover:bg-ink-850"
                }`}
              >
                <span className="block font-medium">{f.label}</span>
                <span className="text-xs text-ink-400">{f.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-5">
          <div>
            <span className="label">Question source</span>
            <SegmentedControl
              options={ORIGINS.map((o) => ({ id: o.id, label: o.label }))}
              value={origin}
              onChange={(v) => setOrigin(v as typeof origin)}
            />
          </div>

          <div>
            <span className="label">Difficulty</span>
            <SegmentedControl
              options={DIFFICULTIES.map((d) => ({ id: d.id, label: d.label }))}
              value={difficulty}
              onChange={(v) => setDifficulty(v as typeof difficulty)}
            />
          </div>

          <div>
            <span className="label">Questions</span>
            <SegmentedControl
              options={QUESTION_COUNTS.map((n) => ({
                id: String(n),
                label: n === 0 ? "All" : String(n),
              }))}
              value={String(count)}
              onChange={(v) => setCount(Number(v))}
            />
          </div>

          <div>
            <span className="label">Question pool</span>
            <SegmentedControl
              options={[
                { id: "mixed", label: "Review first" },
                { id: "fresh", label: "New only" },
                { id: "review", label: "Missed only", disabled: !hasReview },
              ]}
              value={mode}
              onChange={(v) => setMode(v as typeof mode)}
            />
          </div>
        </div>
      </div>

      {tags.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="label mb-0">Categories</span>
            {selected.length > 0 && (
              <button type="button" className="text-xs text-ink-400 hover:text-ink-100"
                      onClick={() => setSelected([])}>
                Clear {selected.length}
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => {
              const n = avail?.byTag[tag.name] ?? tag.count;
              const empty = avail !== null && n === 0;
              return (
                <button
                  key={tag.name}
                  type="button"
                  disabled={empty}
                  title={empty ? "No questions in this category for the current filters" : undefined}
                  onClick={() => toggleTag(tag.name)}
                  aria-pressed={selected.includes(tag.name)}
                  className={`chip ${
                    selected.includes(tag.name)
                      ? "chip-on"
                      : empty
                        ? "cursor-not-allowed opacity-35"
                        : "hover:bg-ink-800"
                  }`}
                >
                  {tag.name}
                  <span className="ml-1.5 text-ink-400">{n}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-ink-400">
            {selected.length === 0
              ? "No filter — questions come from every category."
              : `Filtering to ${selected.length} categor${selected.length === 1 ? "y" : "ies"}.`}
          </p>
        </div>
      )}

      <div className="mt-7 flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" onClick={start} disabled={unavailable}>
          Start practice
        </button>
        {unavailable ? (
          <span className="text-sm text-warn-400">
            Nothing matches these filters. Widen the difficulty, or clear a category.
          </span>
        ) : (
          <span className="text-sm text-ink-400">
            {checking && matching === null
              ? "Counting…"
              : matching !== null
                ? count === 0 || count >= matching
                  ? `${matching.toLocaleString()} question${matching === 1 ? "" : "s"} match`
                  : `${count} of ${matching.toLocaleString()} matching questions`
                : ""}
          </span>
        )}
      </div>
    </section>
  );
}

function SegmentedControl({
  options,
  value,
  onChange,
}: {
  options: { id: string; label: string; disabled?: boolean }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          disabled={option.disabled}
          onClick={() => onChange(option.id)}
          aria-pressed={value === option.id}
          className={`rounded-lg px-3 py-1.5 text-sm transition-colors disabled:opacity-35 ${
            value === option.id
              ? "bg-honey-400 text-ink-950"
              : "border border-ink-700 text-ink-300 hover:bg-ink-850"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
