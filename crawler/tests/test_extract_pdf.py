"""PDF word-spacing recovery.

A quarter of the crawled packets encode no space glyphs, so pdfplumber returns
run-together text. `page_text` must notice and retry with a tighter tolerance.
"""

from __future__ import annotations

from beecrawl.extract.pdf import page_text, space_ratio


class FakePage:
    """Stands in for a pdfplumber page; records the tolerance it was asked for."""

    def __init__(self, default: str, tight: str | None = None):
        self.default = default
        self.tight = tight
        self.calls: list[object] = []

    def extract_text(self, x_tolerance=None, **_):
        self.calls.append(x_tolerance)
        if x_tolerance is None:
            return self.default
        return self.tight if self.tight is not None else self.default


GOOD = "The Republic of San Marino is the oldest surviving sovereign state in the world today."
RUNON = "TheRepublicofSanMarinoistheoldestsurvivingsovereignstateintheworldtoday.Founded301AD."


def test_space_ratio_separates_prose_from_runon_text():
    assert space_ratio(GOOD) > 0.12
    assert space_ratio(RUNON) < 0.02
    assert space_ratio("") == 0.0


def test_normal_page_is_left_alone():
    page = FakePage(GOOD)
    assert page_text(page) == GOOD
    assert page.calls == [None]  # no retry


def test_runon_page_is_retried_with_a_tighter_tolerance():
    page = FakePage(RUNON, tight=GOOD)
    assert page_text(page) == GOOD
    assert page.calls == [None, 1]


def test_retry_is_discarded_when_it_does_not_help():
    page = FakePage(RUNON, tight=RUNON)
    assert page_text(page) == RUNON


def test_short_pages_are_not_retried():
    page = FakePage("Round 3")
    assert page_text(page) == "Round 3"
    assert page.calls == [None]
