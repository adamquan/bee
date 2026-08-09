"""Parser tests over real packet text (the bee.md examples plus edge cases)."""

from __future__ import annotations

from beecrawl.parse.clean import clean_text, split_sentences
from beecrawl.parse.tossup import assign_tiers, parse_answer_line, parse_tossups

MALI = """
1. This empire was governed by the Gbara, which drew delegates from its
territories across the "Twelve Doors". According to myth, a rooster-tipped
arrow allowed this empire to win the Battle of Kirina. A ruler of this empire
allegedly devalued gold throughout North Africa with his lavish gifts while on
a hajj to Mecca. For the point, name this West African empire that was
supplanted by the Songhai and was once ruled by Mansa Musa.
ANSWER: Mali Empire
"""

# Verbatim from bee.md: mojibake and inter-character spacing intact.
ISRAEL = """
2. This country   took   five   boats   from   a   French   port   in   the   Cherbourg   Project.
France  had  refused to  deliver  the  boats,  for  which  this  country  had  paid,  when
diplomatic  relations  broke  after  the  Six-Day  War. Operation  Wrath  of  God  was
launched  after  11  members  of  this  country's  Olympic  team  were  killed  in  1972.
For  the  point,  name  this  Middle  Eastern  country  that  carried  out  those  missions
via  Mossad,  an  intelligence  agency  that  reports  to  Prime  Minister  Benjamin  Netanyahu.
ANSWER:   Israel
"""


def test_parses_mali_tossup():
    parsed, rejected = parse_tossups(MALI)
    assert len(parsed) == 1, rejected
    q = parsed[0]
    assert q.answer == "Mali Empire"
    assert len(q.clues) == 4
    assert q.clues[0][0] == "leadin"
    assert "Gbara" in q.clues[0][1]
    assert q.clues[-1][0] == "giveaway"
    assert "Mansa Musa" in q.clues[-1][1]
    # The leading "1." must not survive into the first clue.
    assert not q.clues[0][1].startswith("1.")


def test_parses_israel_tossup_despite_mangled_whitespace():
    parsed, rejected = parse_tossups(ISRAEL)
    assert len(parsed) == 1, rejected
    q = parsed[0]
    assert q.answer == "Israel"
    assert q.clues[0][0] == "leadin"
    assert "Cherbourg" in q.clues[0][1]
    assert q.clues[-1][0] == "giveaway"
    assert "Mossad" in q.clues[-1][1]
    assert any(tier == "middle" for tier, _ in q.clues)


def test_parses_multiple_tossups_in_one_packet():
    parsed, _ = parse_tossups(MALI + "\n\n" + ISRAEL)
    assert [q.answer for q in parsed] == ["Mali Empire", "Israel"]


def test_answer_line_alternates():
    assert parse_answer_line("Mali Empire [or Manden Kurufaba; accept Mali]") == (
        "Mali Empire",
        ["Manden Kurufaba", "Mali"],
    )
    assert parse_answer_line("Israel (accept State of Israel)") == (
        "Israel",
        ["State of Israel"],
    )
    assert parse_answer_line("Louis XIV or Louis the Great") == (
        "Louis XIV",
        ["Louis the Great"],
    )
    assert parse_answer_line("Cuneiform.") == ("Cuneiform", [])
    # Underlining markup that survived PDF extraction is dropped.
    assert parse_answer_line("_Mansa_ _Musa_")[0] == "Mansa Musa"


def test_tiers_have_a_giveaway_even_without_the_house_cue():
    sentences = ["Alpha clue.", "Beta clue.", "Gamma clue.", "Delta clue."]
    tiers = assign_tiers(sentences)
    assert tiers[-1][0] == "giveaway"
    assert tiers[0][0] == "leadin"


def test_short_or_bonus_text_is_rejected_not_dropped():
    bonus = "[10] Name this river.\nANSWER: Nile"
    parsed, rejected = parse_tossups(bonus)
    assert parsed == []
    assert rejected  # surfaced for review rather than silently discarded


def test_sentence_split_keeps_abbreviations_together():
    text = "He served under Gen. Grant in 1864. The war then ended."
    assert split_sentences(text) == [
        "He served under Gen. Grant in 1864.",
        "The war then ended.",
    ]


def test_clean_text_fixes_mojibake_and_smart_quotes():
    mojibake = "the \u00e2\u20ac\u0153Twelve Doors\u00e2\u20ac\u009d"
    assert clean_text(mojibake) == 'the "Twelve Doors"'
    assert clean_text("this country\u2019s team") == "this country's team"
    assert clean_text("Six-\nDay War") == "Six-Day War"


def test_answer_line_ignores_moderator_rejection_notes():
    # Real IAC packet shape: the note lists what NOT to accept.
    primary, alts = parse_answer_line(
        'Cat (or Feline; before mentioned, do not accept specific kinds of '
        'big cats like "Lion" or "Tiger")'
    )
    assert primary == "Cat"
    assert alts == ["Feline"]
    assert "Lion" not in alts and "Tiger" not in alts


def test_answer_line_does_not_accept_prompts():
    primary, alts = parse_answer_line("Israel (accept State of Israel; prompt on Palestine)")
    assert primary == "Israel"
    assert alts == ["State of Israel"]


def test_bonus_army_is_not_a_bonus_part():
    """"Bonus Army" is history prose, not a quizbowl bonus marker."""
    hoover = (
        "This man's secretary of state, Henry Stimson, said the United States would not "
        "recognize territorial gains made through force. Douglas MacArthur was dispatched "
        "to the Anacostia Flats to disperse the protesting Bonus Army by this politician. "
        "This president's idea of rugged individualism limited his response to the crash. "
        "For the point, name this president who preceded Franklin Roosevelt.\n"
        "ANSWER: Herbert Hoover"
    )
    parsed, rejected = parse_tossups(hoover)
    assert len(parsed) == 1, rejected
    assert parsed[0].answer == "Herbert Hoover"


def test_real_bonus_parts_are_still_rejected():
    bonus = (
        "For 10 points each, name these things about the Roman Republic. "
        "[10] This general crossed the Rubicon in 49 BC and later became dictator.\n"
        "ANSWER: Julius Caesar"
    )
    parsed, rejected = parse_tossups(bonus)
    assert parsed == []
    assert rejected


def test_moderator_marks_never_reach_the_student():
    """Power marks and difficulty labels are for the reader, not the player."""
    assert "(*)" not in clean_text("(*) For ten points, name these constructs.")
    assert "(+)" not in clean_text("designed a steel example in (+) 2010.")
    assert "[E]" not in clean_text("[E] Srivijaya's capital was sacked.")
    # The surrounding words survive intact.
    assert "For ten points" in clean_text("(*) For ten points, name these constructs.")
    assert "Srivijaya" in clean_text("[E] Srivijaya's capital was sacked.")


def test_reordered_combining_accents_are_repaired():
    # PDF extraction emits the accent before its letter: "prot ́eg ́e".
    mangled = "prot ́eg ́e of Richelieu"
    assert clean_text(mangled).startswith("protégé")
