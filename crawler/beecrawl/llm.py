"""Shared Claude client helpers: prompts, schemas, and Batch API plumbing.

Bulk work (tagging, explanations, question generation) goes through the Message
Batches API — it is half price and none of it is latency-sensitive. The stable
prompt prefix carries a `cache_control` breakpoint so the category vocabulary
and format spec are billed once per window rather than per question.
"""

from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Iterable, Sequence

from . import config

MODEL = config.MODEL

# ------------------------------------------------------------------ prompts --

# Kept byte-stable: it is the cached prefix. Anything that varies per request
# must live in the user turn, after the breakpoint.
CATEGORY_VOCABULARY = [
    "US History", "European History", "Asian History", "African History",
    "Latin American History", "Middle Eastern History", "World History",
    "Ancient World", "Middle Ages", "Renaissance", "Exploration", "Early Modern",
    "Modern", "Contemporary", "Revolutions", "World Wars", "Empires", "Leaders",
    "Religions", "Art History", "Sports History", "Literature History",
    "Science History", "Military History", "Economic History", "Mythology",
    "Historical Geography", "Politics", "Social Movements", "Technology",
]

_VOCAB_BLOCK = "\n".join(f"- {c}" for c in CATEGORY_VOCABULARY)

PYRAMIDAL_SPEC = """A History Bee tossup is a single paragraph of clues about one answer, \
ordered hardest-first:

- Lead-in (1-2 sentences): obscure facts — minor battles, early-life details, \
lesser-known works. Only an expert buzzes here.
- Middle (1-2 sentences): moderately difficult context — major turning points, \
regional associations. Most correct buzzes happen here.
- Giveaway (final sentence): a broad, widely recognizable fact, phrased as \
"For the point, name this ..." so an average student in the division can answer.

Every clue must be factually true and must point unambiguously at the answer. \
Never repeat a fact across clues, and never use the answer's own name inside a clue."""

ENRICH_SYSTEM = f"""You are a curriculum assistant for History Bee and History Bowl coaches.

You classify and explain competition history questions. Work only from the \
question text you are given.

Assign every question two to five categories from this controlled vocabulary. \
Use these exact strings — do not invent new ones:
{_VOCAB_BLOCK}

Pick categories that a coach would actually filter on: at least one region or \
era, plus the topics the question turns on.

Difficulty levels:
- elementary: US/world basics an under-11 division would know.
- middle: standard middle-school National History Bee difficulty.
- high: high-school varsity difficulty.
- open: collegiate or expert difficulty.

Explanations are for a student who just missed the question: two to four \
sentences that state why the answer is correct, name the decisive clue, and add \
one memorable hook. Do not restate the whole question."""

GENERATE_SYSTEM = f"""You are a question writer for History Bee and History Bowl practice sets.

{PYRAMIDAL_SPEC}

A multiple-choice question has a single-sentence stem ending in a question \
mark, exactly four options labeled A-D, exactly one correct option, and three \
distractors that are plausible and of the same kind as the answer (do not pad \
with obviously wrong choices).

Assign every question two to five categories from this controlled vocabulary. \
Use these exact strings — do not invent new ones:
{_VOCAB_BLOCK}

Accuracy is the hard constraint: every clue must be a fact you are confident \
is true. If you are unsure of a detail, choose a different clue. Prefer widely \
documented history over obscure trivia you cannot verify.

Each question also needs an explanation of two to four sentences aimed at a \
student who missed it."""

# ------------------------------------------------------------------ schemas --

ENRICH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "categories": {
            "type": "array",
            "items": {"type": "string", "enum": CATEGORY_VOCABULARY},
        },
        "difficulty": {"type": "string", "enum": ["elementary", "middle", "high", "open"]},
        "explanation": {"type": "string"},
        "answer_alternates": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Other spellings or phrasings a grader should accept.",
        },
    },
    "required": ["categories", "difficulty", "explanation", "answer_alternates"],
    "additionalProperties": False,
}

_TOSSUP_ITEM: dict[str, Any] = {
    "type": "object",
    "properties": {
        "leadin": {"type": "string"},
        # Counts are stated in the prompt and clamped after parsing: structured
        # outputs reject minItems/maxItems on arrays.
        "middle": {"type": "array", "items": {"type": "string"}},
        "giveaway": {"type": "string"},
        "answer": {"type": "string"},
        "answer_alternates": {"type": "array", "items": {"type": "string"}},
        "explanation": {"type": "string"},
        "categories": {
            "type": "array",
            "items": {"type": "string", "enum": CATEGORY_VOCABULARY},
        },
    },
    "required": [
        "leadin", "middle", "giveaway", "answer",
        "answer_alternates", "explanation", "categories",
    ],
    "additionalProperties": False,
}

_MCQ_ITEM: dict[str, Any] = {
    "type": "object",
    "properties": {
        "stem": {"type": "string"},
        "options": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string", "enum": ["A", "B", "C", "D"]},
                    "text": {"type": "string"},
                },
                "required": ["label", "text"],
                "additionalProperties": False,
            },
        },
        "correct_label": {"type": "string", "enum": ["A", "B", "C", "D"]},
        "explanation": {"type": "string"},
        "categories": {
            "type": "array",
            "items": {"type": "string", "enum": CATEGORY_VOCABULARY},
        },
    },
    "required": ["stem", "options", "correct_label", "explanation", "categories"],
    "additionalProperties": False,
}


def generation_schema(fmt: str) -> dict[str, Any]:
    item = _TOSSUP_ITEM if fmt == "tossup" else _MCQ_ITEM
    return {
        "type": "object",
        "properties": {"questions": {"type": "array", "items": item}},
        "required": ["questions"],
        "additionalProperties": False,
    }


# ------------------------------------------------------------------- client --


def get_client():
    """Construct an Anthropic client, or raise a clear error if unavailable."""
    if not config.has_api_key():
        raise RuntimeError(
            "No Anthropic credential found. Set ANTHROPIC_API_KEY (or run `ant auth login`) "
            "to use enrichment and question generation. Crawling and parsing work without it."
        )
    import anthropic

    return anthropic.Anthropic()


def cached_system(text: str) -> list[dict[str, Any]]:
    """A system prompt with a cache breakpoint on its final (only) block."""
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]


def build_request(
    custom_id: str,
    *,
    system: str,
    user: str,
    schema: dict[str, Any],
    max_tokens: int = 8000,
    effort: str = "high",
) -> dict[str, Any]:
    """One entry for a Message Batches request array."""
    return {
        "custom_id": custom_id,
        "params": {
            "model": MODEL,
            "max_tokens": max_tokens,
            "system": cached_system(system),
            "output_config": {
                "effort": effort,
                "format": {"type": "json_schema", "schema": schema},
            },
            "messages": [{"role": "user", "content": user}],
        },
    }


def run_batch(
    requests: Sequence[dict[str, Any]],
    *,
    poll_seconds: int = 30,
    max_wait_seconds: int = 24 * 3600,
    on_poll=None,
) -> dict[str, Any]:
    """Submit a batch, wait for it to end, and return `{custom_id: parsed_json}`.

    Results arrive in arbitrary order, so they are keyed by `custom_id`.
    Failed entries are omitted; the caller compares against what it sent.
    """
    if not requests:
        return {}

    client = get_client()
    batch = client.messages.batches.create(requests=list(requests))

    waited = 0
    while True:
        current = client.messages.batches.retrieve(batch.id)
        if current.processing_status == "ended":
            break
        if waited >= max_wait_seconds:
            raise TimeoutError(f"batch {batch.id} still running after {waited}s")
        if on_poll:
            on_poll(current)
        time.sleep(poll_seconds)
        waited += poll_seconds

    out: dict[str, Any] = {}
    for result in client.messages.batches.results(batch.id):
        if result.result.type != "succeeded":
            continue
        message = result.result.message
        if message.stop_reason == "refusal":
            continue
        text = next((b.text for b in message.content if b.type == "text"), None)
        if not text:
            continue
        try:
            out[result.custom_id] = json.loads(text)
        except json.JSONDecodeError:
            continue
    return out


def run_single(
    *,
    system: str,
    user: str,
    schema: dict[str, Any],
    max_tokens: int = 4000,
    effort: str = "high",
) -> dict[str, Any] | None:
    """Synchronous single call, for small interactive jobs."""
    client = get_client()
    response = client.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        system=cached_system(system),
        output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        messages=[{"role": "user", "content": user}],
    )
    if response.stop_reason == "refusal":
        return None
    text = next((b.text for b in response.content if b.type == "text"), None)
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def chunk(items: Iterable[Any], size: int) -> Iterable[list[Any]]:
    batch: list[Any] = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def run_parallel(
    requests: Sequence[dict[str, Any]],
    *,
    concurrency: int = 8,
    request_timeout: float = 180.0,
    on_done=None,
) -> dict[str, Any]:
    """Run batch-shaped requests as concurrent live calls.

    The Batch API is half price but its queue latency is unpredictable — a
    submission can sit for hours behind other traffic on the same account.
    When the questions are wanted now, this runs the identical requests
    directly, several at a time, and returns the same `{custom_id: json}` map.
    """
    if not requests:
        return {}

    # A worker with no deadline blocks its slot indefinitely; a handful of slow
    # requests then starve the pool and throughput collapses part-way through a
    # long run. Bound each call and let the target loop re-ask for what's missing.
    client = get_client().with_options(timeout=request_timeout, max_retries=1)
    out: dict[str, Any] = {}

    def one(req: dict[str, Any]) -> tuple[str, Any]:
        params = req["params"]
        try:
            response = client.messages.create(
                model=params["model"],
                max_tokens=params["max_tokens"],
                system=params["system"],
                output_config=params["output_config"],
                messages=params["messages"],
            )
            if response.stop_reason == "refusal":
                return req["custom_id"], None
            text = next((b.text for b in response.content if b.type == "text"), None)
            return req["custom_id"], json.loads(text) if text else None
        except Exception:
            # One failed slice must not sink the run; the caller sees a short
            # result and the target loop asks for another round.
            return req["custom_id"], None

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(one, req) for req in requests]
        finished = 0
        for future in as_completed(futures):
            cid, data = future.result()
            finished += 1
            if data is not None:
                out[cid] = data
            if on_done:
                # Hand the result over immediately: a caller that persists as
                # it goes keeps everything produced before an interruption.
                on_done(finished, len(requests), cid, data)
    return out
