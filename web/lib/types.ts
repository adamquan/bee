export type QuestionType = "tossup" | "mcq";
export type Origin = "official" | "generated";
export type Difficulty = "elementary" | "middle" | "high" | "open";
export type ClueTier = "leadin" | "middle" | "giveaway";
export type Verdict = "correct" | "incorrect" | "timeout" | "skipped";
export type JudgedBy = "exact" | "fuzzy" | "llm" | "mcq" | "timeout";

export interface Clue {
  ordinal: number;
  tier: ClueTier;
  text: string;
}

export interface McqOption {
  label: string;
  text: string;
}

/** A question as delivered to the quiz UI. The correct MCQ option is never
 *  included — grading happens server-side so the answer isn't in the payload. */
export interface QuizQuestion {
  id: number;
  type: QuestionType;
  origin: Origin;
  difficulty: Difficulty;
  tags: string[];
  /** Tossups only. */
  clues?: Clue[];
  /** MCQ only. */
  stem?: string;
  options?: McqOption[];
  sourceTitle?: string | null;
  sourceUrl?: string | null;
}

/** Revealed after an attempt is recorded. */
export interface Reveal {
  answer: string;
  alternates: string[];
  explanation: string | null;
  correctLabel?: string;
}

export interface QuizFilters {
  format: "buzz" | "mcq";
  origin: "official" | "generated" | "both";
  difficulty?: Difficulty | "any";
  tags?: string[];
  /** "review" draws only from the missed-question queue. */
  mode?: "fresh" | "review" | "mixed";
  /** How many questions this practice runs for. 0 means "until the bank runs out". */
  limit?: number;
}

export interface JudgeResult {
  verdict: Verdict;
  judgedBy: JudgedBy;
  reason?: string;
}

export interface TagAccuracy {
  tag: string;
  attempts: number;
  correct: number;
  accuracy: number;
}

export interface WeakArea extends TagAccuracy {
  /** Questions left in the bank for this tag that the student hasn't seen. */
  unseen: number;
  resources: { title: string; url: string }[];
}
