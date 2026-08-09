"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchNextQuestion, submitAttempt } from "@/lib/client-api";
import type { JudgeResult, QuizFilters, QuizQuestion, Reveal } from "@/lib/types";
import ScoreBar from "./ScoreBar";

/** Multiple-choice runner: pick an option, get immediate feedback. */
export default function McqRunner({
  sessionId,
  filters,
}: {
  sessionId: number;
  filters: QuizFilters;
}) {
  const [question, setQuestion] = useState<QuizQuestion | null>(null);
  const [loading, setLoading] = useState(true);
  const [exhausted, setExhausted] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [result, setResult] = useState<(JudgeResult & { reveal: Reveal | null }) | null>(null);
  const [seen, setSeen] = useState<number[]>([]);
  const [score, setScore] = useState({ asked: 0, correct: 0 });
  const questionStart = useRef(0);
  const [reachedLimit, setReachedLimit] = useState(false);
  const limit = filters.limit ?? 0;

  const loadNext = useCallback(async () => {
    // Stop at the requested length before fetching, so the practice ends on
    // the last answer rather than on a question that appears and vanishes.
    if (limit > 0 && seen.length >= limit) {
      setReachedLimit(true);
      setExhausted(true);
      setLoading(false);
      return;
    }

    setLoading(true);
    setPicked(null);
    setResult(null);

    const { question: next } = await fetchNextQuestion(filters, seen);
    if (!next) {
      setExhausted(true);
      setLoading(false);
      return;
    }
    setQuestion(next);
    setSeen((prev) => [...prev, next.id]);
    questionStart.current = Date.now();
    setLoading(false);
  }, [filters, seen, limit]);

  useEffect(() => {
    void loadNext();
    // Runs once; loadNext closes over the `seen` list it appends to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = useCallback(
    async (label: string) => {
      if (picked || !question) return;
      setPicked(label);

      const outcome = await submitAttempt({
        sessionId,
        questionId: question.id,
        selectedLabel: label,
        latencyMs: Date.now() - questionStart.current,
      });
      setResult(outcome);
      setScore((s) => ({
        asked: s.asked + 1,
        correct: s.correct + (outcome.verdict === "correct" ? 1 : 0),
      }));
    },
    [picked, question, sessionId],
  );

  // A-D picks an option; Enter advances.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Enter" && result) {
        event.preventDefault();
        void loadNext();
        return;
      }
      if (picked || !question?.options) return;
      const key = event.key.toUpperCase();
      if (question.options.some((o) => o.label === key)) void choose(key);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked, question, result, choose, loadNext]);

  if (exhausted) {
    return (
      <div className="card p-10 text-center">
        <h2 className="font-display text-2xl">Session complete</h2>
        <p className="mt-2 text-ink-300">
          {reachedLimit
            ? `That's all ${limit} question${limit === 1 ? "" : "s"} for this practice.`
            : "You've worked through every question that matches these filters."}
        </p>
        {score.asked > 0 && (
          <p className="mt-4 font-display text-3xl text-honey-300">
            {score.correct} / {score.asked}
          </p>
        )}
        <div className="mt-6 flex justify-center gap-3">
          <Link href="/dashboard" className="btn-primary">
            See dashboard
          </Link>
          <Link href="/" className="btn-ghost">
            New session
          </Link>
        </div>
      </div>
    );
  }

  if (loading || !question) {
    return <div className="card p-10 text-center text-ink-400">Loading question…</div>;
  }

  const correctLabel = result?.reveal?.correctLabel;

  return (
    <div className="space-y-4">
      <ScoreBar
        asked={score.asked}
        correct={score.correct}
        position={seen.length}
        total={limit}
      />

      <article className="card p-6">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="chip">{question.difficulty}</span>
          <span className="chip">{question.origin}</span>
          {question.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="chip">
              {tag}
            </span>
          ))}
        </div>

        <h2 className="text-xl leading-relaxed">{question.stem}</h2>

        <div className="mt-5 grid gap-2">
          {question.options?.map((option) => {
            const isPicked = picked === option.label;
            const isAnswer = correctLabel === option.label;

            let tone = "border-ink-700 hover:bg-ink-850";
            if (result) {
              if (isAnswer) tone = "border-good-600 bg-good-600/15";
              else if (isPicked) tone = "border-bad-600 bg-bad-600/15";
              else tone = "border-ink-800 opacity-60";
            }

            return (
              <button
                key={option.label}
                type="button"
                disabled={Boolean(picked)}
                onClick={() => void choose(option.label)}
                className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-default ${tone}`}
              >
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border border-ink-600 text-xs font-semibold">
                  {option.label}
                </span>
                <span className="leading-relaxed">{option.text}</span>
              </button>
            );
          })}
        </div>
      </article>

      {result && (
        <section
          className={`card border p-6 ${
            result.verdict === "correct" ? "border-good-600/50" : "border-bad-600/50"
          }`}
        >
          <h3
            className={`font-display text-xl ${
              result.verdict === "correct" ? "text-good-400" : "text-bad-400"
            }`}
          >
            {result.verdict === "correct" ? "Correct" : "Not quite"}
          </h3>
          <p className="mt-2 font-display text-lg text-honey-300">{result.reveal?.answer}</p>
          {result.reveal?.explanation ? (
            <p className="mt-3 leading-relaxed text-ink-300">{result.reveal.explanation}</p>
          ) : null}
          <button type="button" className="btn-primary mt-5" onClick={() => void loadNext()}>
            Next question
            <kbd className="rounded bg-ink-950/20 px-1.5 py-0.5 text-xs">enter</kbd>
          </button>
        </section>
      )}
    </div>
  );
}
