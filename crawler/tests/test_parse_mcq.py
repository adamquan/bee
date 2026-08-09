"""MCQ parser tests, using the bee.md sample exam questions."""

from __future__ import annotations

from beecrawl.parse.mcq import parse_mcqs

EXAM = """
Question 1: U.S. History
Which standard United States military rifle, adopted in 1936, was famously
praised by General George S. Patton as "the greatest battle implement ever
devised" during World War II?
A. M1 Garand
B. M1903 Springfield
C. M1 Carbine
D. Thompson Submachine Gun
Correct Answer: A. M1 Garand

Question 2: World History
Which absolute monarch of France, known as the "Sun King," consolidated royal
power by forcing the nobility to reside with him at his massive Palace of
Versailles?
A. Louis XIV
B. Louis XVI
C. Henry IV
D. Charlemagne
Correct Answer: A. Louis XIV

Question 3: Ancient History
What specialized system of writing, consisting of wedge-shaped marks pressed
into wet clay tablets, was developed by the ancient Sumerians of Mesopotamia?
A. Hieroglyphics
B. Cuneiform
C. Linear B
D. Phoenician Alphabet
Correct Answer: B. Cuneiform
"""


def test_parses_all_three_sample_questions():
    parsed, rejected = parse_mcqs(EXAM)
    assert len(parsed) == 3, (rejected, [p.answer for p in parsed])
    assert [q.answer for q in parsed] == ["M1 Garand", "Louis XIV", "Cuneiform"]


def test_marks_exactly_one_correct_option():
    parsed, _ = parse_mcqs(EXAM)
    for q in parsed:
        assert len(q.options) == 4
        assert sum(1 for _, _, correct in q.options if correct) == 1


def test_correct_option_is_the_expected_label():
    parsed, _ = parse_mcqs(EXAM)
    correct_labels = [next(l for l, _, c in q.options if c) for q in parsed]
    assert correct_labels == ["A", "A", "B"]


def test_stem_is_the_question_not_the_section_header():
    parsed, _ = parse_mcqs(EXAM)
    assert parsed[0].stem.endswith("?")
    assert "M1 Garand" not in parsed[0].stem
    assert "U.S. History" not in parsed[0].stem
    assert parsed[2].stem.startswith("What specialized system")


def test_bare_letter_answer_line_resolves_to_option_text():
    block = """
Which river flows through Cairo?
A. Nile
B. Congo
C. Niger
D. Zambezi
Answer: A
"""
    parsed, rejected = parse_mcqs(block)
    assert len(parsed) == 1, rejected
    assert parsed[0].answer == "Nile"


def test_answer_that_matches_no_option_is_quarantined():
    block = """
Which river flows through Cairo?
A. Nile
B. Congo
C. Niger
D. Zambezi
Correct Answer: Amazon
"""
    parsed, rejected = parse_mcqs(block)
    assert parsed == []
    assert rejected and "does not match" in rejected[0][0]
