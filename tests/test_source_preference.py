"""Prefer the artist's own upload over somebody else's repost of it.

`_norm` treats "official" and "lyrics" as filler and strips them, so the
canonical upload and a third party's repackaging of the same recording score
identically on title. What separated them was accident: a six-second gap from
the album running time lost to a five-second one, because the duration bands
break at five. That put "Bohemian Rhapsody (Official Video)" third, below a
lyrics reupload.

Two mechanisms, deliberately different in kind:
- a small score adjustment, because a reupload really is a worse answer,
- a tiebreak in ranking, because once two candidates are equally credible as
  *this track*, which upload to keep is a separate question — and settling it
  by nudging a constant until one wins by 0.01 would re-answer it at random.
"""

import pytest

from shared.resolution_confidence import (
    best_candidate,
    classify_confidence,
    is_official_source,
    score_candidate,
)

OFFICIAL = {"title": "Coldplay - Yellow (Official Video)", "channel": "Coldplay", "duration": 273}
LYRICS = {"title": "Coldplay - Yellow (Lyrics)", "channel": "LyricLandia", "duration": 269}


def test_the_official_upload_outscores_the_reupload():
    official, _ = score_candidate("Coldplay", "Yellow", 269, OFFICIAL)
    lyrics, _ = score_candidate("Coldplay", "Yellow", 269, LYRICS)

    assert official > lyrics


def test_the_official_upload_is_chosen_even_when_it_scores_lower():
    """The real case: an official video six seconds off the album length, beside
    a lyrics reupload five seconds off. Both are plainly the right track."""
    official = {"title": "Queen – Bohemian Rhapsody (Official Video)", "channel": "Queen Official", "duration": 360}
    reupload = {"title": "Queen - Bohemian Rhapsody (Lyrics In Italian)", "channel": "Queen Official", "duration": 359}

    best, score, _, _ = best_candidate("Queen", "Bohemian Rhapsody", 354, [reupload, official])

    assert best is official
    assert classify_confidence(score) == "high"


def test_a_tiebreak_never_crosses_a_confidence_band():
    """Preferring the official upload must not promote a worse match. A wrong
    track from the right channel is still the wrong track."""
    right_track = {"title": "Yellow", "channel": "Somber Sounds", "duration": 269}
    wrong_track = {"title": "Coldplay - Viva La Vida (Official Video)", "channel": "Coldplay", "duration": 242}

    best, _, _, _ = best_candidate("Coldplay", "Yellow", 269, [wrong_track, right_track])

    assert best is right_track


@pytest.mark.parametrize(
    "candidate",
    [
        {"title": "Yellow (Official Video)", "channel": "somebody"},
        {"title": "Yellow", "channel": "ColdplayVEVO"},
        {"title": "Yellow", "channel": "Coldplay - Topic"},
        {"title": "Yellow", "channel": "Queen Official"},
    ],
    ids=["official in title", "vevo", "topic channel", "official channel"],
)
def test_what_counts_as_the_artists_own_upload(candidate):
    assert is_official_source(candidate) is True


@pytest.mark.parametrize(
    "candidate",
    [
        {"title": "Yellow", "channel": "LyricLandia"},
        {"title": "Coldplay - Yellow (Lyrics)", "channel": "7clouds"},
        {"title": "Yellow", "channel": ""},
    ],
    ids=["third party", "lyrics reupload", "no channel"],
)
def test_what_does_not(candidate):
    assert is_official_source(candidate) is False


@pytest.mark.parametrize(
    "title",
    [
        "Coldplay - Yellow (Lyrics)",
        "Coldplay - Yellow (Letra)",
        "Coldplay - Yellow (Sub Español + Lyrics)",
        "Coldplay - Yellow (Traducida)",
        "Coldplay - Yellow (Subtitulado)",
    ],
)
def test_repackagings_are_marked_down(title):
    repackaged, _ = score_candidate("Coldplay", "Yellow", 269, {"title": title, "channel": "Third Party", "duration": 269})
    plain, _ = score_candidate("Coldplay", "Yellow", 269, {"title": "Coldplay - Yellow", "channel": "Third Party", "duration": 269})

    assert repackaged < plain


def test_an_official_lyric_video_nets_out():
    """It is both things at once, and neither cancels the other's truth."""
    both = {"title": "Yellow (Official Lyric Video)", "channel": "Coldplay", "duration": 269}
    neither = {"title": "Yellow", "channel": "Coldplay", "duration": 269}

    with_both, _ = score_candidate("Coldplay", "Yellow", 269, both)
    with_neither, _ = score_candidate("Coldplay", "Yellow", 269, neither)

    assert with_both == pytest.approx(with_neither, abs=0.01)
