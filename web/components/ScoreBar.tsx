"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export default function ScoreBar({
  asked,
  correct,
  position = 0,
  total = 0,
  right,
}: {
  asked: number;
  correct: number;
  /** Which question is on screen (1-based). Counted from questions served, not
   *  answered, so the label matches what the student is looking at while a
   *  reveal is still up. */
  position?: number;
  /** Questions this practice runs for; 0 when it runs until the bank ends. */
  total?: number;
  right?: ReactNode;
}) {
  const pct = asked ? Math.round((correct / asked) * 100) : 0;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-800 bg-ink-900/50 px-4 py-2.5">
      <div className="flex items-center gap-4 text-sm">
        <Link href="/" className="text-ink-400 hover:text-ink-100">
          ← Setup
        </Link>
        <span className="tabular-nums text-ink-300">
          <span className="font-medium text-ink-100">{correct}</span> / {asked}
          {asked > 0 && <span className="ml-2 text-ink-400">{pct}%</span>}
        </span>
        {total > 0 && (
          <span className="tabular-nums text-xs text-ink-400">
            Question {Math.min(Math.max(position, 1), total)} of {total}
          </span>
        )}
      </div>
      {right}
    </div>
  );
}
