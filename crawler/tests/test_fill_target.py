"""`--target` must count generated questions of the chosen format.

The bank holds thousands of crawled official tossups, so a bank-wide target
would be satisfied instantly and generate nothing.
"""

from __future__ import annotations

import sqlite3

from beecrawl import db, generate as g


def _bank(tmp_path):
    conn = db.init_db(tmp_path / "t.db")
    # 50 official tossups already loaded, as after a crawl.
    for i in range(50):
        db.insert_tossup(
            conn,
            clues=[("leadin", f"Official clue {i} about a distinct topic."),
                   ("giveaway", f"For the point, name official answer {i}.")],
            answer=f"Official Answer {i}",
            origin="official",
            tags=["US History"],
        )
    conn.commit()
    return conn


def test_target_counts_generated_questions_not_the_whole_bank(tmp_path, monkeypatch):
    conn = _bank(tmp_path)
    assert conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0] == 50

    made = {"n": 0}

    def fake_generate(conn_, *, tags, difficulty, fmt, per_tag, use_batch, concurrency=8, on_event=None):
        for tag in tags:
            for _ in range(per_tag):
                made["n"] += 1
                i = made["n"]
                db.insert_tossup(
                    conn_,
                    clues=[("leadin", f"Generated clue {i} on an unrelated subject."),
                           ("giveaway", f"For the point, name generated answer {i}.")],
                    answer=f"Generated Answer {i}",
                    origin="generated",
                    tags=[tag],
                )
        conn_.commit()
        return {"requested": 0, "returned": 0, "inserted": 0, "duplicates": 0}

    monkeypatch.setattr(g, "generate", fake_generate)
    totals = g.fill_to_target(conn, target=20, fmt="tossup", per_round=3)

    generated = conn.execute(
        "SELECT COUNT(*) FROM questions WHERE origin='generated' AND type='tossup'"
    ).fetchone()[0]
    assert generated >= 20, totals
    assert totals["start"] == 0          # no generated tossups to begin with
    assert totals["final"] == generated
    # The 50 official questions must be untouched.
    assert conn.execute(
        "SELECT COUNT(*) FROM questions WHERE origin='official'"
    ).fetchone()[0] == 50


def test_stops_after_two_barren_rounds(tmp_path, monkeypatch):
    conn = _bank(tmp_path)
    monkeypatch.setattr(
        g, "generate",
        lambda *a, **k: {"requested": 0, "returned": 0, "inserted": 0, "duplicates": 0},
    )
    totals = g.fill_to_target(conn, target=100, fmt="tossup", per_round=5)
    assert totals["rounds"] == 2   # gives up instead of looping forever
    assert totals["final"] == 0


def test_generated_mcqs_do_not_satisfy_a_tossup_target(tmp_path, monkeypatch):
    conn = _bank(tmp_path)
    for i in range(30):
        db.insert_mcq(
            conn,
            stem=f"Which thing is number {i} in this series of examples?",
            options=[("A", f"a{i}", True), ("B", f"b{i}", False),
                     ("C", f"c{i}", False), ("D", f"d{i}", False)],
            answer=f"a{i}",
            origin="generated",
            tags=["US History"],
        )
    conn.commit()
    calls = {"n": 0}

    def counting(*a, **k):
        calls["n"] += 1
        return {"requested": 0, "returned": 0, "inserted": 0, "duplicates": 0}

    monkeypatch.setattr(g, "generate", counting)
    g.fill_to_target(conn, target=10, fmt="tossup", per_round=5)
    assert calls["n"] > 0, "30 generated MCQs must not satisfy a tossup target"
