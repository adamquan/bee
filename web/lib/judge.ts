import type { JudgeResult, Verdict } from "./types";
import { hasApiKey } from "./db";

/**
 * Answer judging in three tiers, cheapest first:
 *
 *   1. normalize + exact match against the answer and its accepted alternates
 *   2. token-set matching with numeral folding and typo tolerance
 *   3. one Claude call, only when tiers 1-2 are genuinely undecided
 *
 * Tier 3 is skipped entirely when no API key is present, so buzzer gameplay
 * never blocks on the network.
 */

// ------------------------------------------------------------- normalizing --

const ARTICLES = new Set(["the", "a", "an"]);

/** Words that describe the *kind* of thing, not which one it is. Dropping them
 *  lets "Mali" match "Mali Empire" without letting "Empire" match it. */
const GENERIC = new Set([
  "empire", "kingdom", "dynasty", "republic", "confederacy", "federation",
  "war", "battle", "siege", "treaty", "act", "amendment", "doctrine", "plan",
  "city", "town", "river", "mountain", "mount", "sea", "ocean", "lake", "island",
  "president", "king", "queen", "emperor", "empress", "tsar", "czar", "sultan",
  "pharaoh", "general", "admiral", "prime", "minister", "chancellor", "pope",
  "saint", "st", "sir", "lord", "dr", "mr", "mrs", "states", "state", "province",
  "movement", "revolution", "period", "era", "age", "dispute", "crisis",
  "of", "and", "or", "de", "la", "le", "el", "von", "van",
]);

const NUMBER_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20,
};

const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

/**
 * Canonical roman numerals only. A loose `[ivxlcdm]+` test misreads ordinary
 * words built from those letters — "civil", "did", "mill" — as numbers.
 */
const ROMAN_RE = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;

function romanToArabic(token: string): number | null {
  if (!token || !ROMAN_RE.test(token)) return null;
  let total = 0;
  let prev = 0;
  for (let i = token.length - 1; i >= 0; i--) {
    const value = ROMAN_VALUES[token[i]];
    total += value < prev ? -value : value;
    if (value > prev) prev = value;
  }
  return total > 0 && total < 4000 ? total : null;
}

/** Lowercase, strip accents and punctuation, drop leading articles. */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token, i, all) => !(i === 0 && ARTICLES.has(token) && all.length > 1))
    .join(" ");
}

/**
 * Tokenize with numeral folding, so "Louis XIV", "Louis the 14th", and
 * "Louis the fourteenth" all reduce to the same tokens — while "Louis XVI"
 * stays distinct.
 */
export function tokenize(text: string): string[] {
  const raw = normalize(text).split(" ").filter(Boolean);
  // Regnal numerals are written in caps ("Louis XIV"); a lowercase look-alike
  // in running text is far more likely to be a word.
  const wasUpper = text
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.length > 0 && w === w.toUpperCase() && /\p{L}/u.test(w));

  const out: string[] = [];

  raw.forEach((token, index) => {
    if (ARTICLES.has(token)) return;

    const ordinal = token.match(/^(\d+)(st|nd|rd|th)$/);
    if (ordinal) {
      out.push(ordinal[1]);
      return;
    }
    if (token in NUMBER_WORDS) {
      out.push(String(NUMBER_WORDS[token]));
      return;
    }
    // Fold to a number only where a numeral is actually plausible: the token
    // was capitalised, or it trails a name ("Henry V", "Louis xiv").
    const trailing = index === raw.length - 1 && raw.length > 1;
    if (wasUpper[index] || trailing) {
      const arabic = romanToArabic(token);
      if (arabic !== null) {
        out.push(String(arabic));
        return;
      }
    }
    out.push(token);
  });

  return out;
}

/** The tokens that actually identify the answer. */
function distinctive(tokens: string[]): string[] {
  const kept = tokens.filter((t) => !GENERIC.has(t));
  return kept.length > 0 ? kept : tokens;
}

function numbersIn(tokens: string[]): string[] {
  return tokens.filter((t) => /^\d+$/.test(t));
}

// -------------------------------------------------------------- similarity --

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

/** A near-match token, to absorb speech-recognition slips and spelling. */
function tokenMatches(needle: string, haystack: string[]): boolean {
  if (haystack.includes(needle)) return true;
  if (/^\d+$/.test(needle)) return false; // numerals must be exact
  if (needle.length < 5) return false;
  return haystack.some((t) => t.length >= 4 && similarity(needle, t) >= 0.82);
}

/**
 * True when what the student said is the answer's tokens in order, starting
 * from the first one, with only non-numeric tokens omitted.
 *
 * Accepts "Napoleon" for "Napoleon Bonaparte" and "Franklin Roosevelt" for
 * "Franklin Delano Roosevelt" — both calls a moderator makes without thinking.
 * Rejects "Roosevelt" alone (which Roosevelt?) and "Louis" for "Louis XIV",
 * because the regnal number is the identifying part.
 */
function isLeadingSubsequence(said: string[], required: string[]): boolean {
  if (said.length === 0 || required.length === 0) return false;
  if (!tokenMatches(required[0], [said[0]])) return false;

  let cursor = 0;
  for (const token of required) {
    if (cursor < said.length && tokenMatches(token, [said[cursor]])) {
      cursor++;
    } else if (/^\d+$/.test(token)) {
      return false; // never skip a regnal number, date, or ordinal
    }
  }
  return cursor === said.length;
}

// -------------------------------------------------------- offline judging ---

export type OfflineOutcome =
  | { decided: true; verdict: Verdict; judgedBy: "exact" | "fuzzy"; reason: string }
  | { decided: false; reason: string };

export function judgeOffline(
  response: string,
  answer: string,
  alternates: string[] = [],
): OfflineOutcome {
  const said = response.trim();
  if (!said) return { decided: true, verdict: "incorrect", judgedBy: "exact", reason: "no answer given" };

  const candidates = [answer, ...alternates].filter(Boolean);
  const saidNorm = normalize(said);
  const saidTokens = tokenize(said);

  // Tier 1 — exact match on the normalized form.
  for (const candidate of candidates) {
    if (saidNorm === normalize(candidate)) {
      return { decided: true, verdict: "correct", judgedBy: "exact", reason: "exact match" };
    }
  }

  // Tier 2 — token-set match against each accepted answer.
  let sharedAny = false;
  let conflictedAll = true;
  let bestDistinctiveSimilarity = 0;

  for (const candidate of candidates) {
    const answerTokens = tokenize(candidate);
    const required = distinctive(answerTokens);

    // A stated numeral that disagrees is decisive: Louis XVI is not Louis XIV.
    const answerNumbers = numbersIn(answerTokens);
    const saidNumbers = numbersIn(saidTokens);
    const numberConflict =
      answerNumbers.length > 0 &&
      saidNumbers.length > 0 &&
      !answerNumbers.every((n) => saidNumbers.includes(n));
    if (numberConflict) continue;
    conflictedAll = false;

    if (required.every((t) => tokenMatches(t, saidTokens))) {
      return {
        decided: true,
        verdict: "correct",
        judgedBy: "fuzzy",
        reason: `matched on ${required.join(" + ")}`,
      };
    }
    // Student said strictly more than the answer ("Mali Empire of West Africa").
    if (answerTokens.every((t) => tokenMatches(t, saidTokens))) {
      return { decided: true, verdict: "correct", judgedBy: "fuzzy", reason: "answer contained" };
    }
    if (isLeadingSubsequence(distinctive(saidTokens), required)) {
      return {
        decided: true,
        verdict: "correct",
        judgedBy: "fuzzy",
        reason: "leading part of the answer",
      };
    }

    if (required.some((t) => tokenMatches(t, saidTokens))) sharedAny = true;
    // Compare only the identifying words: "Songhai Empire" vs "Mali Empire"
    // looks similar as whole strings purely because of the shared "Empire".
    bestDistinctiveSimilarity = Math.max(
      bestDistinctiveSimilarity,
      similarity(distinctive(saidTokens).join(" "), required.join(" ")),
    );
  }

  // Every accepted answer disagreed on a number the student stated.
  if (conflictedAll && candidates.length > 0) {
    return {
      decided: true,
      verdict: "incorrect",
      judgedBy: "fuzzy",
      reason: "the number in the answer does not match",
    };
  }

  // Decisively wrong: nothing identifying in common with any accepted answer.
  if (!sharedAny && bestDistinctiveSimilarity < 0.55) {
    return { decided: true, verdict: "incorrect", judgedBy: "fuzzy", reason: "no overlap" };
  }

  // Partial overlap — a human grader would have to think. Escalate.
  return { decided: false, reason: sharedAny ? "partial token overlap" : "close spelling" };
}

// ------------------------------------------------------------- tier 3: LLM --

const JUDGE_SYSTEM = `You are the moderator of a History Bee match, ruling on whether a \
student's spoken answer should be accepted.

Accept an answer that identifies the same person, place, thing, or event as the \
official answer line, even if the wording differs, the student gives a partial \
name that is unambiguous in context, or speech-to-text garbled the spelling.

Reject an answer that names a different entity, that is too vague to distinguish \
between plausible candidates, or that gets a distinguishing regnal number, date, \
or ordinal wrong.

Rule the way a fair moderator would: prefer accepting when the student clearly \
knew the answer, and rejecting when they did not.`;

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    accept: { type: "boolean" },
    reason: { type: "string", description: "One short sentence for the student." },
  },
  required: ["accept", "reason"],
  additionalProperties: false,
} as const;

async function judgeWithClaude(
  response: string,
  answer: string,
  alternates: string[],
): Promise<JudgeResult | null> {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();

    const message = await client.messages.create({
      model: process.env.BEE_MODEL ?? "claude-opus-5",
      max_tokens: 500,
      system: [{ type: "text", text: JUDGE_SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: JUDGE_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content:
            `Official answer: ${answer}\n` +
            `Also accept: ${alternates.length ? alternates.join("; ") : "(none listed)"}\n` +
            `Student said: ${response}`,
        },
      ],
    });

    if (message.stop_reason === "refusal") return null;
    const text = message.content.find((b) => b.type === "text")?.text;
    if (!text) return null;

    const parsed = JSON.parse(text) as { accept: boolean; reason: string };
    return {
      verdict: parsed.accept ? "correct" : "incorrect",
      judgedBy: "llm",
      reason: parsed.reason,
    };
  } catch {
    // Network down, no credit, bad key — fall back to the offline decision.
    return null;
  }
}

/** Full judging ladder. Never throws. */
export async function judge(
  response: string,
  answer: string,
  alternates: string[] = [],
): Promise<JudgeResult> {
  const offline = judgeOffline(response, answer, alternates);
  if (offline.decided) {
    return { verdict: offline.verdict, judgedBy: offline.judgedBy, reason: offline.reason };
  }

  if (hasApiKey()) {
    const llm = await judgeWithClaude(response, answer, alternates);
    if (llm) return llm;
  }

  // Undecided and no adjudicator available. Give the buzz to the student when
  // they shared a distinguishing token — that is the call a moderator makes
  // on a genuinely close answer.
  const lenient = offline.reason === "partial token overlap";
  return {
    verdict: lenient ? "correct" : "incorrect",
    judgedBy: "fuzzy",
    reason: `${offline.reason} (judged offline)`,
  };
}
