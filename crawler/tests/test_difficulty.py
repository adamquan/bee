"""Division detection from packet file names."""

from __future__ import annotations

import pytest

from beecrawl.pipeline import _difficulty_hint

BASE = "https://www.iacompetitions.com/wp-content/uploads/2023/08/"


@pytest.mark.parametrize(
    "filename,expected",
    [
        ("2019-2020-HS-History-Bee-Finals-A-Set.pdf", "high"),
        ("2021-2022-MS-History-Bee-Round-1.pdf", "middle"),
        ("2020-2021-EMS-History-Bee-Round-1-Set-1.pdf", "elementary"),
        ("2018-Varsity-History-Bowl-Nationals.pdf", "high"),
        ("2019-JV-History-Bowl-Round-4.pdf", "high"),
        ("Collegiate-History-Bee-Round-2.pdf", "open"),
        ("2022-Elementary-Division-Sample.pdf", "elementary"),
    ],
)
def test_division_token_is_read_from_the_file_name(filename, expected):
    assert _difficulty_hint(BASE + filename) == expected


def test_url_encoded_names_are_decoded_first():
    assert _difficulty_hint("https://x.com/2019%20HS%20History%20Bee.pdf") == "high"


def test_quizbowl_archive_splits_by_host():
    assert _difficulty_hint("https://files.quizbowlpackets.com/2995/Packet%2010.pdf") == "high"
    assert _difficulty_hint("https://ms.quizbowlpackets.com/300/Packet%202.pdf") == "middle"


def test_novice_sets_are_middle_difficulty():
    assert _difficulty_hint("https://files.quizbowlpackets.com/2806/KICKOFF%20Novice%2003N.pdf") == "middle"


def test_unlabelled_files_fall_back_to_middle():
    assert _difficulty_hint("https://www.ihbbeurope.com/uploads/round-3.pdf") == "middle"


def test_a_stray_es_inside_a_word_is_not_elementary():
    # "Res" / "Games" must not trip the ES token.
    assert _difficulty_hint("https://x.com/2019-Games-Resources-Round-2.pdf") == "middle"
