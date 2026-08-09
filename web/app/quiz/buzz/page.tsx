import { Suspense } from "react";
import QuizShell from "@/components/QuizShell";

export const dynamic = "force-dynamic";

export default function BuzzQuizPage() {
  return (
    <Suspense fallback={<div className="card p-10 text-center text-ink-400">Loading…</div>}>
      <QuizShell format="buzz" />
    </Suspense>
  );
}
