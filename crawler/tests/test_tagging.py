"""Keyword tagger tests — the no-API-key path for categories."""

from __future__ import annotations

from beecrawl.tagging import suggest_tags

MALI_BODY = (
    "This empire was governed by the Gbara. A ruler of this empire allegedly devalued "
    "gold throughout North Africa with his lavish gifts while on a hajj to Mecca. "
    "For the point, name this West African empire supplanted by the Songhai."
)


def test_tags_a_real_tossup_plausibly():
    tags = suggest_tags(MALI_BODY, "Mali Empire")
    assert "African History" in tags
    assert "Empires" in tags
    assert 2 <= len(tags) <= 5


def test_never_returns_nothing():
    tags = suggest_tags("This thing happened once.", "Something")
    assert tags == ["World History"]


def test_palace_of_versailles_is_not_a_world_wars_question():
    tags = suggest_tags(
        "Which absolute monarch of France, known as the Sun King, forced the nobility "
        "to reside with him at his massive Palace of Versailles?",
        "Louis XIV",
    )
    assert "World Wars" not in tags
    assert "European History" in tags


def test_treaty_of_versailles_is_a_world_wars_question():
    tags = suggest_tags("This 1919 agreement, the Treaty of Versailles, ended the war.", "")
    assert "World Wars" in tags


def test_adds_an_era_from_a_date_when_none_matched():
    tags = suggest_tags("This agreement was signed in 1973 by two delegations.", "")
    assert "Contemporary" in tags


def test_caps_the_tag_count():
    busy = (
        "The Roman emperor led an army into battle over trade routes, built a cathedral, "
        "wrote a poem, won an Olympic event, and signed a treaty in parliament in 1850."
    )
    assert len(suggest_tags(busy, "")) <= 5
