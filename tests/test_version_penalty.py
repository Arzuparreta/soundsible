"""A live take is not the track someone asked to save.

`_norm` strips bracketed text before comparing titles, so "(Live On The Tonight
Show)" and "(Karaoke Version)" disappear and the recording ties the studio one
on title. A live cut usually runs close enough in length to score on duration
too, which is how "Blinding Lights" resolved to a talk-show performance at 0.90
confidence — above the bar for saving without asking anyone.

The penalty only applies to a version the request did not ask for, so searching
for a remix still finds the remix.
"""

import pytest

from shared.resolution_confidence import (
    best_candidate,
    classify_confidence,
    score_candidate,
)

STUDIO = {"title": "The Weeknd - Blinding Lights (Official Audio)", "channel": "The Weeknd", "duration": 200}
LIVE = {"title": "The Weeknd - Blinding Lights (Live On The Tonight Show)", "channel": "The Weeknd", "duration": 202}


def test_the_studio_take_wins():
    best, score, reason, _ = best_candidate("The Weeknd", "Blinding Lights", 200, [LIVE, STUDIO])

    assert best is STUDIO
    assert classify_confidence(score) == "high"
    assert reason == "title_artist_duration"


def test_a_live_take_alone_asks_before_saving():
    """Not rejected — just not saved silently on the listener's behalf."""
    score, reason = score_candidate("The Weeknd", "Blinding Lights", 200, LIVE)

    assert classify_confidence(score) != "high"
    assert reason == "other_version"


@pytest.mark.parametrize(
    "title",
    [
        "Get Lucky (Karaoke Version)",
        "Get Lucky - Instrumental",
        "Get Lucky (Acoustic)",
        "Get Lucky [8D AUDIO]",
        "Get Lucky (sped up)",
        "Get Lucky (Nightcore)",
        "Get Lucky — cover by someone",
        "Get Lucky (Tribute to Daft Punk)",
    ],
)
def test_versions_nobody_asked_for(title):
    candidate = {"title": title, "channel": "Daft Punk", "duration": 369}
    marked, _ = score_candidate("Daft Punk", "Get Lucky", 369, candidate)
    plain, _ = score_candidate("Daft Punk", "Get Lucky", 369, {**candidate, "title": "Get Lucky"})

    assert marked < plain


def test_asking_for_a_remix_finds_the_remix():
    remix = {"title": "Levitating (Remix)", "channel": "Dua Lipa", "duration": 203}
    original = {"title": "Levitating", "channel": "Dua Lipa", "duration": 203}

    best, score, _, _ = best_candidate("Dua Lipa", "Levitating (Remix)", 203, [original, remix])

    assert best is remix
    assert classify_confidence(score) == "high"


@pytest.mark.parametrize("title", ["Alive", "Livewire", "Live Forever", "Delivery"])
def test_a_word_that_merely_contains_a_marker_is_not_one(title):
    """"Alive" is not a live recording, and matching on substrings would say it
    was — the check is word-bounded for that reason."""
    candidate = {"title": title, "channel": "Oasis", "duration": 200}
    scored, _ = score_candidate("Oasis", title, 200, candidate)
    baseline, _ = score_candidate("Oasis", title, 200, {**candidate, "title": title})

    assert scored == baseline
    assert classify_confidence(scored) == "high"


def test_a_candidate_without_a_title_is_not_penalised():
    score, _ = score_candidate("Queen", "Bohemian Rhapsody", 354, {"channel": "Queen", "duration": 354})

    assert score >= 0.0
