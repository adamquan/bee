"""Generate new practice questions with Claude.

Everything written here is marked `origin='generated'` per bee.md requirement 2.
Study-guide text from crawled sources is used as topic grounding — but only from
sources whose host permits it (`sources.ai_train_ok = 1`); text from a host that
publishes `ai-train=no` is never sent as source material.
"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any, Sequence

from . import db, llm, tagging

# The example questions from bee.md, used as few-shot anchors so generated
# questions match real House style rather than a generic LLM approximation.
_STYLE_EXAMPLES = """Reference tossup (middle school):
This empire was governed by the Gbara, which drew delegates from its territories \
across the "Twelve Doors". According to myth, a rooster-tipped arrow allowed this \
empire to win the Battle of Kirina. A ruler of this empire allegedly devalued gold \
throughout North Africa with his lavish gifts while on a hajj to Mecca. For the \
point, name this West African empire that was supplanted by the Songhai and was \
once ruled by Mansa Musa.
ANSWER: Mali Empire

Reference multiple choice (middle school):
Which standard United States military rifle, adopted in 1936, was famously praised \
by General George S. Patton as "the greatest battle implement ever devised" during \
World War II?
A. M1 Garand
B. M1903 Springfield
C. M1 Carbine
D. Thompson Submachine Gun
Correct Answer: A. M1 Garand"""


def _grounding(conn: sqlite3.Connection, tag: str | None, char_budget: int = 6000) -> str:
    """Excerpts from crawled study guides for `tag`, respecting ai-train opt-outs."""
    if tag:
        rows = conn.execute(
            """
            SELECT st.text, s.title, s.url
            FROM source_texts st
            JOIN sources s ON s.id = st.source_id
            LEFT JOIN source_tags stg ON stg.source_id = s.id
            LEFT JOIN tags t ON t.id = stg.tag_id
            WHERE s.kind IN ('studyguide', 'index')
              AND s.ai_train_ok = 1
              AND (t.name = ? COLLATE NOCASE OR s.title LIKE ?)
            LIMIT 4
            """,
            (tag, f"%{tag}%"),
        ).fetchall()
    else:
        rows = []

    if not rows:
        rows = conn.execute(
            """
            SELECT st.text, s.title, s.url
            FROM source_texts st JOIN sources s ON s.id = st.source_id
            WHERE s.kind = 'studyguide' AND s.ai_train_ok = 1
            LIMIT 3
            """
        ).fetchall()

    if not rows:
        return ""

    parts: list[str] = []
    budget = char_budget
    for row in rows:
        excerpt = row["text"][: min(budget, 2500)].strip()
        if not excerpt:
            continue
        parts.append(f"--- from {row['title'] or row['url']} ---\n{excerpt}")
        budget -= len(excerpt)
        if budget <= 0:
            break
    if not parts:
        return ""
    return (
        "\n\nOfficial study-guide material for grounding. Draw topics and emphasis "
        "from it; do not copy its sentences verbatim:\n\n" + "\n\n".join(parts)
    )


def _existing_answers(conn: sqlite3.Connection, tag: str | None, limit: int = 120) -> list[str]:
    """Answers already in the bank, so generation does not duplicate them."""
    if tag:
        rows = conn.execute(
            """
            SELECT DISTINCT q.answer FROM questions q
            JOIN question_tags qt ON qt.question_id = q.id
            JOIN tags t ON t.id = qt.tag_id
            WHERE t.name = ? COLLATE NOCASE
            ORDER BY q.id DESC LIMIT ?
            """,
            (tag, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT DISTINCT answer FROM questions ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [r["answer"] for r in rows]


def _user_prompt(
    *,
    tag: str | None,
    difficulty: str,
    fmt: str,
    count: int,
    avoid: Sequence[str],
    grounding: str,
) -> str:
    topic = f"the category \"{tag}\"" if tag else "general history across varied categories"
    kind = "pyramidal tossups" if fmt == "tossup" else "multiple-choice questions"
    avoid_block = ""
    if avoid:
        avoid_block = (
            "\n\nThese answers are already in the practice bank. Choose different "
            "answers:\n" + ", ".join(avoid)
        )
    return (
        f"Write exactly {count} {kind} at {difficulty} difficulty on {topic}.\n\n"
        f"Return all {count} in the `questions` array — not fewer. Give each "
        f"question two to five categories from the controlled vocabulary.\n\n"
        f"{_STYLE_EXAMPLES}"
        f"{avoid_block}"
        f"{grounding}"
    )


def _categories(item: dict[str, Any], body: str, answer: str) -> list[str]:
    """Model-assigned categories, topped up by keyword tagging.

    Structured outputs cannot enforce a minimum array length, so a model that
    returns a single category would leave the question nearly unfilterable.
    """
    tags = [c for c in item.get("categories", []) if isinstance(c, str) and c.strip()]
    if len(tags) < 2:
        for guess in tagging.suggest_tags(body, answer):
            if guess not in tags:
                tags.append(guess)
            if len(tags) >= 3:
                break
    return tags[:5]


def _insert_tossup(conn: sqlite3.Connection, item: dict[str, Any], difficulty: str) -> bool:
    leadin = (item.get("leadin") or "").strip()
    middles = [m.strip() for m in item.get("middle", []) if isinstance(m, str) and m.strip()][:3]
    giveaway = (item.get("giveaway") or "").strip()
    answer = (item.get("answer") or "").strip()
    if not (leadin and giveaway and answer):
        return False

    clues: list[tuple[str, str]] = [("leadin", leadin)]
    clues += [("middle", m) for m in middles]
    clues.append(("giveaway", giveaway))
    body = " ".join(t for _, t in clues)

    if db.near_duplicate_exists(conn, answer, body, "tossup"):
        return False

    qid = db.insert_tossup(
        conn,
        clues=clues,
        answer=answer,
        origin="generated",
        difficulty=difficulty,
        answer_alternates=[a for a in item.get("answer_alternates", []) if isinstance(a, str)],
        explanation=(item.get("explanation") or "").strip() or None,
        tags=_categories(item, body, answer),
    )
    return qid is not None


def _insert_mcq(conn: sqlite3.Connection, item: dict[str, Any], difficulty: str) -> bool:
    stem = (item.get("stem") or "").strip()
    raw_options = item.get("options") or []
    correct = item.get("correct_label")
    options: list[tuple[str, str, bool]] = []
    answer = ""
    for opt in raw_options:
        label = (opt.get("label") or "").strip().upper()
        text = (opt.get("text") or "").strip()
        if not label or not text:
            continue
        is_correct = label == correct
        if is_correct:
            answer = text
        options.append((label, text, is_correct))

    if not stem or len(options) != 4 or sum(1 for *_, c in options if c) != 1 or not answer:
        return False
    if db.near_duplicate_exists(conn, answer, stem, "mcq"):
        return False

    qid = db.insert_mcq(
        conn,
        stem=stem,
        options=options,
        answer=answer,
        origin="generated",
        difficulty=difficulty,
        explanation=(item.get("explanation") or "").strip() or None,
        tags=_categories(item, stem, answer),
    )
    return qid is not None


def generate(
    conn: sqlite3.Connection,
    *,
    tags: Sequence[str | None],
    difficulty: str = "middle",
    fmt: str = "tossup",
    per_tag: int = 10,
    use_batch: bool = True,
    concurrency: int = 8,
    on_event=None,
) -> dict[str, int]:
    """Generate questions for each tag. Returns counts."""

    def emit(msg: str) -> None:
        if on_event:
            on_event(msg)

    schema = llm.generation_schema(fmt)
    counts = {"requested": 0, "returned": 0, "inserted": 0, "duplicates": 0}

    # Ask in slices of 5 — a single request producing 40 questions drifts in
    # quality and risks hitting max_tokens mid-array.
    slice_size = 5
    requests: list[dict[str, Any]] = []
    slice_meta: dict[str, str] = {}

    for tag in tags:
        remaining = per_tag
        index = 0
        while remaining > 0:
            n = min(slice_size, remaining)
            remaining -= n
            cid = f"gen-{(tag or 'general').replace(' ', '_')}-{fmt}-{index}"
            index += 1
            slice_meta[cid] = difficulty
            requests.append(
                llm.build_request(
                    cid,
                    system=llm.GENERATE_SYSTEM,
                    user=_user_prompt(
                        tag=tag,
                        difficulty=difficulty,
                        fmt=fmt,
                        count=n,
                        avoid=_existing_answers(conn, tag),
                        grounding=_grounding(conn, tag),
                    ),
                    schema=schema,
                    max_tokens=6000,
                    # Writing questions is a generation task, not a reasoning
                    # one; "high" spends minutes thinking per request for no
                    # measurable gain in question quality.
                    effort="medium",
                )
            )
            counts["requested"] += n

    if not requests:
        return counts

    emit(f"generating {counts['requested']} {fmt} question(s) across {len(requests)} request(s)")

    if use_batch:
        results = llm.run_batch(requests, on_poll=lambda b: emit(f"batch {b.id}: {b.processing_status}"))
    else:
        # Insert each slice the moment it lands. A long run interrupted
        # half-way then keeps every question it already paid for.
        streamed = {"inserted": 0, "duplicates": 0}

        def landed(done: int, total: int, cid: str, data: Any | None) -> None:
            if data:
                for item in data.get("questions", []):
                    counts["returned"] += 1
                    ok = (
                        _insert_tossup(conn, item, slice_meta.get(cid, difficulty))
                        if fmt == "tossup"
                        else _insert_mcq(conn, item, slice_meta.get(cid, difficulty))
                    )
                    streamed["inserted" if ok else "duplicates"] += 1
                conn.commit()
            if done % 20 == 0 or done == total:
                emit(f"{done}/{total} requests · {streamed['inserted']} inserted")

        llm.run_parallel(requests, concurrency=concurrency, on_done=landed)
        counts["inserted"] += streamed["inserted"]
        counts["duplicates"] += streamed["duplicates"]
        emit(f"inserted {counts['inserted']} (skipped {counts['duplicates']})")
        return counts

    for cid, data in results.items():
        difficulty_for_slice = slice_meta.get(cid, difficulty)
        for item in data.get("questions", []):
            counts["returned"] += 1
            ok = (
                _insert_tossup(conn, item, difficulty_for_slice)
                if fmt == "tossup"
                else _insert_mcq(conn, item, difficulty_for_slice)
            )
            if ok:
                counts["inserted"] += 1
            else:
                counts["duplicates"] += 1
    conn.commit()
    emit(f"inserted {counts['inserted']} (skipped {counts['duplicates']} duplicate/invalid)")
    return counts


def fill_to_target(
    conn: sqlite3.Connection,
    *,
    target: int,
    difficulty: str = "middle",
    fmt: str = "tossup",
    per_round: int = 60,
    tags_per_round: int = len(llm.CATEGORY_VOCABULARY),
    yield_headroom: float = 1.45,
    use_batch: bool = True,
    concurrency: int = 8,
    on_event=None,
) -> dict[str, int]:
    """Generate in rounds until there are `target` generated questions of `fmt`.

    The target counts *generated* questions of this format, not the whole bank —
    with thousands of crawled official tossups already loaded, a bank-wide
    target would be satisfied before writing a single new question.

    A request can come back short and duplicates are dropped on insert, so
    aiming at a count is more reliable than multiplying per-request numbers.
    Rounds walk the category vocabulary so coverage stays even, and stop early
    if two consecutive rounds add nothing.
    """

    def emit(msg: str) -> None:
        if on_event:
            on_event(msg)

    def made() -> int:
        return int(
            conn.execute(
                "SELECT COUNT(*) FROM questions WHERE origin = 'generated' AND type = ?",
                (fmt,),
            ).fetchone()[0]
        )

    # Order categories by how little *generated* material each has. Ranking by
    # total would just re-pick whichever categories the official corpus happens
    # to be thin on, round after round.
    def by_need() -> list[str]:
        counts = {
            r["name"]: r["n"]
            for r in conn.execute(
                """
                SELECT t.name, COUNT(q.id) AS n
                FROM tags t
                LEFT JOIN question_tags qt ON qt.tag_id = t.id
                LEFT JOIN questions q
                       ON q.id = qt.question_id AND q.origin = 'generated' AND q.type = ?
                GROUP BY t.id
                """,
                (fmt,),
            )
        }
        vocab = [c for c in llm.CATEGORY_VOCABULARY]
        return sorted(vocab, key=lambda c: (counts.get(c, 0), c))

    totals = {"rounds": 0, "inserted": 0, "duplicates": 0, "start": made()}
    barren = 0

    # Every round is one Message Batches submission, and queue latency dwarfs
    # generation time — a round of 36 questions waits just as long as a round
    # of 1,400. So each round asks every category at once and sizes itself to
    # clear the whole remaining target, with headroom for questions dropped as
    # duplicates. Two or three rounds finish the job instead of twenty.
    while made() < target and barren < 2:
        remaining = target - made()
        batch_tags = by_need()[:tags_per_round]
        wanted = -(-int(remaining * yield_headroom) // max(1, len(batch_tags)))
        per_tag = max(2, min(per_round, wanted))

        before = made()
        counts = generate(
            conn,
            tags=batch_tags,
            difficulty=difficulty,
            fmt=fmt,
            per_tag=per_tag,
            use_batch=use_batch,
            concurrency=concurrency,
            on_event=on_event,
        )
        added = made() - before
        totals["rounds"] += 1
        totals["inserted"] += added
        totals["duplicates"] += counts["duplicates"]
        barren = barren + 1 if added == 0 else 0
        emit(f"round {totals['rounds']}: +{added} generated {fmt}s → {made()} / {target}")

    totals["final"] = made()
    return totals


def run_pending_jobs(conn: sqlite3.Connection, *, on_event=None) -> int:
    """Process `generation_jobs` rows queued by the dashboard's 'drill this'."""
    jobs = conn.execute(
        "SELECT * FROM generation_jobs WHERE status = 'pending' ORDER BY id"
    ).fetchall()

    for job in jobs:
        conn.execute(
            "UPDATE generation_jobs SET status = 'running' WHERE id = ?", (job["id"],)
        )
        conn.commit()
        try:
            counts = generate(
                conn,
                tags=[job["tag_name"]],
                difficulty=job["difficulty"],
                fmt=job["format"],
                per_tag=job["count"],
                on_event=on_event,
            )
            conn.execute(
                """
                UPDATE generation_jobs
                SET status = 'done', status_detail = ?, finished_at = datetime('now')
                WHERE id = ?
                """,
                (json.dumps(counts), job["id"]),
            )
        except Exception as exc:
            conn.execute(
                """
                UPDATE generation_jobs
                SET status = 'error', status_detail = ?, finished_at = datetime('now')
                WHERE id = ?
                """,
                (f"{exc.__class__.__name__}: {exc}", job["id"]),
            )
        conn.commit()

    return len(jobs)


# --------------------------------------------------- study-guide topic mining --

# Study guides list their syllabus as bullets, often several to a line because
# the PDF was laid out in columns:
#   "- Battle of Marathon - Jesus Christ - Beowulf"
_BULLET_SPLIT = re.compile(r"(?:^|\s)[-•–]\s+")
# A topic is a short noun phrase, not prose. Sentences and headings are not.
_TOPIC_OK = re.compile(r"^[A-Z0-9][\w'&.,()\- /]{2,58}$")
# Capitalised runs of 1-4 words: "Martin Luther", "Battle of Hastings",
# "Hagia Sophia". Lower-case connectors are allowed inside, never at the edges.
_PROPER_NOUN = re.compile(
    r"\b[A-Z][a-zA-Z'\-]{2,}(?:\s+(?:of|the|and|de|von|van)\s+[A-Z][a-zA-Z'\-]{2,}"
    r"|\s+[A-Z][a-zA-Z'\-]{2,}){0,3}\b"
)

_TOPIC_REJECT = re.compile(
    r"(?i)\b(chapter|part \d|study guide|see also|page|www\.|http|tournament|"
    r"competitors?|students?|coaches|division|the following|etc)\b|[?!:;]"
)

# The guides talk about themselves constantly. None of this is a history topic.
_ORG_WORDS = re.compile(
    r"(?i)\b(bee|bowl|olympiad|iac|ihbb|academic|competitions?|tournament|"
    r"regional|nationals?|championships?|qualifier|round|packet|guide|set|"
    r"junior|varsity|worldwide|events?|online|website|email|register)\b"
)

# Sentence-initial capitals that are not subjects.
_STOP_TOPICS = {
    "the", "this", "that", "these", "those", "there", "then", "they", "their",
    "however", "additionally", "during", "after", "before", "while", "although",
    "welcome", "dear", "other", "many", "most", "some", "both", "each", "also",
    "for", "from", "with", "when", "where", "which", "who", "what", "his", "her",
    "its", "one", "two", "first", "second", "third", "part", "topics", "history",
    "middle", "high", "school", "please", "see", "note", "and", "but", "not",
}


def study_topics(
    conn: sqlite3.Connection, limit: int = 4000, include_prose: bool = False
) -> list[str]:
    """Mine specific subjects out of the crawled official study guides.

    These bullets are the syllabus the competitions actually draw from, so
    generating one question per topic keeps the set grounded in the official
    study material — and, because each answer is fixed up front, stops the
    model from repeatedly reaching for the same famous topics.

    Only sources whose host allows it (`ai_train_ok = 1`) are read.
    """
    rows = conn.execute(
        """
        SELECT st.text FROM source_texts st JOIN sources s ON s.id = st.source_id
        WHERE s.kind = 'studyguide' AND s.ai_train_ok = 1
        """
    ).fetchall()

    seen: dict[str, None] = {}

    def keep(raw: str) -> None:
        topic = " ".join(raw.split()).strip(" -–•.,")
        if not topic or len(topic.split()) > 8:
            return
        if _TOPIC_REJECT.search(topic) or not _TOPIC_OK.match(topic):
            return
        if topic.split()[0].lower() in _STOP_TOPICS:
            return
        if _ORG_WORDS.search(topic):
            return
        # Headers are set in caps; subjects are not.
        letters = [ch for ch in topic if ch.isalpha()]
        if letters and sum(ch.isupper() for ch in letters) / len(letters) > 0.7:
            return
        seen.setdefault(topic, None)

    for row in rows:
        text = row["text"]
        # 1. Syllabus bullets — the highest-signal source.
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith(("-", "•", "–")):
                continue
            for piece in _BULLET_SPLIT.split(line):
                keep(piece)
            if len(seen) >= limit:
                return list(seen)

        # 2. Proper nouns from the surrounding prose. This finds subjects the
        #    bullets miss, but also picks up sentence fragments ("Should France")
        #    that make poor answers — off by default, worth enabling only when
        #    the bullet syllabus has been exhausted.
        if not include_prose:
            continue
        for match in _PROPER_NOUN.finditer(text):
            candidate = match.group(0)
            # Single capitalised words in prose are usually sentence starts;
            # bullets already cover the legitimate one-word subjects.
            if len(candidate.split()) >= 2:
                keep(candidate)
            if len(seen) >= limit:
                return list(seen)

    return list(seen)


def unused_study_topics(
    conn: sqlite3.Connection, fmt: str = "tossup", include_prose: bool = False
) -> list[str]:
    """Study-guide topics that are not already an answer of this question type."""
    taken = {
        db.normalize_answer(r["answer"])
        for r in conn.execute("SELECT answer FROM questions WHERE type = ?", (fmt,))
    }
    return [
        t
        for t in study_topics(conn, include_prose=include_prose)
        if db.normalize_answer(t) not in taken
    ]


def generate_from_topics(
    conn: sqlite3.Connection,
    *,
    target: int,
    difficulty: str = "middle",
    fmt: str = "tossup",
    slice_size: int = 5,
    concurrency: int = 16,
    include_prose: bool = False,
    on_event=None,
) -> dict[str, int]:
    """Write one question per topic taken from the official study guides.

    Asking for "5 tossups on Ancient World" makes the model reach for the same
    famous answers every time, and with thousands of official questions already
    banked almost all of them are rejected as duplicates. Fixing the answer up
    front — one question per syllabus topic — keeps the set both grounded in
    the study material and genuinely varied.
    """

    def emit(msg: str) -> None:
        if on_event:
            on_event(msg)

    def made() -> int:
        return int(
            conn.execute(
                "SELECT COUNT(*) FROM questions WHERE origin = 'generated' AND type = ?",
                (fmt,),
            ).fetchone()[0]
        )

    counts = {"start": made(), "topics": 0, "returned": 0, "inserted": 0, "duplicates": 0}
    needed = target - counts["start"]
    if needed <= 0:
        counts["final"] = counts["start"]
        return counts

    topics = unused_study_topics(conn, fmt=fmt, include_prose=include_prose)
    if not topics:
        emit("no unused study-guide topics left")
        counts["final"] = made()
        return counts

    # Ask for more topics than questions needed; some come back unusable.
    topics = topics[: int(needed * 1.6) + slice_size]
    counts["topics"] = len(topics)
    schema = llm.generation_schema(fmt)
    kind = "pyramidal tossup" if fmt == "tossup" else "multiple-choice question"

    requests = []
    for i in range(0, len(topics), slice_size):
        chunk = topics[i : i + slice_size]
        listed = "\n".join(f"{n}. {t}" for n, t in enumerate(chunk, 1))
        requests.append(
            llm.build_request(
                f"topic-{i}",
                system=llm.GENERATE_SYSTEM,
                user=(
                    f"Write one {kind} at {difficulty} difficulty for each topic below. "
                    f"These come from the official History Bee and Bowl study guides.\n\n"
                    f"The answer to each question must be exactly the topic given, and you "
                    f"must return all {len(chunk)} questions in the `questions` array, in "
                    f"order. Give each question two to five categories from the controlled "
                    f"vocabulary.\n\nTopics:\n{listed}\n\n{_STYLE_EXAMPLES}"
                ),
                schema=schema,
                max_tokens=6000,
                effort="medium",
            )
        )

    emit(f"{len(topics)} study-guide topics across {len(requests)} request(s)")

    def landed(done: int, total: int, cid: str, data: Any | None) -> None:
        if data:
            for item in data.get("questions", []):
                counts["returned"] += 1
                ok = (
                    _insert_tossup(conn, item, difficulty)
                    if fmt == "tossup"
                    else _insert_mcq(conn, item, difficulty)
                )
                counts["inserted" if ok else "duplicates"] += 1
            conn.commit()
        if done % 20 == 0 or done == total:
            emit(f"{done}/{total} requests · {counts['inserted']} inserted · {made()} total")

    llm.run_parallel(requests, concurrency=concurrency, on_done=landed)
    counts["final"] = made()
    return counts
