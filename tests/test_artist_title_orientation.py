"""Orientation is decided by a catalog, not by which side of the dash a word sat on."""

import pytest

from shared.artist_title_orientation import choose_orientation, resolve_orientation


def _row(artist: str, title: str, duration: int = 240) -> dict:
    return {"artist": {"name": artist}, "title": title, "duration": duration}


# The song that started this: uploaded as "I Follow Rivers - Lykke Li (…)", so
# the positional guess makes "I Follow Rivers" the artist and files the track
# under a name nobody would look for.
LYKKE = ("I Follow Rivers", "Lykke Li (La Vie d'Adèle/La Vida de Adele)")


def test_the_reversed_upload_is_read_the_right_way_round():
    decided = choose_orientation(*LYKKE, [_row("Lykke Li", "I Follow Rivers", 244)])

    assert decided.swapped is True
    # The artist name comes from the row that earned the swap, so the film
    # reference the uploader appended does not become part of a band's name.
    assert decided.artist == "Lykke Li"
    assert decided.title == "I Follow Rivers"
    assert decided.reason == "catalog"


def test_a_conventional_upload_is_left_alone():
    decided = choose_orientation("Lykke Li", "I Follow Rivers", [_row("Lykke Li", "I Follow Rivers", 244)])

    assert decided.swapped is False
    assert (decided.artist, decided.title) == ("Lykke Li", "I Follow Rivers")


@pytest.mark.parametrize(
    "rows, why",
    [
        ([], "the catalog knows nothing"),
        ([_row("Somebody Else", "A Different Song")], "the row is not this recording"),
        ([{"artist": {"name": ""}, "title": ""}], "the row is empty"),
        ([{"nonsense": True}], "the row is malformed"),
    ],
)
def test_anything_short_of_a_clear_answer_keeps_the_positional_reading(rows, why):
    decided = choose_orientation(*LYKKE, rows)
    assert decided.swapped is False, why
    assert decided.reason == "positional"


def test_remixes_and_edits_still_answer_the_question():
    """What Deezer actually returns for this song: not one cut of it anywhere
    near the 284s upload, and every row agreeing on whose song it is."""
    rows = [
        _row("Lykke Li", "I Follow Rivers (The Lost Sessions)", 202),
        _row("Lykke Li", "I Follow Rivers (Van Rivers & The Subliminal Kid)", 401),
        _row("Lykke Li", "I Follow Rivers (David Sitek Remix)", 238),
        _row("Lykke Li", "I Follow Rivers (Radio Edit)", 200),
    ]
    decided = choose_orientation(*LYKKE, rows)
    assert decided.swapped is True
    assert decided.artist == "Lykke Li"


def test_duration_is_not_consulted_at_all():
    """A row of any length answers the orientation question the same way."""
    for seconds in (0, 200, 284, 401):
        assert choose_orientation(*LYKKE, [_row("Lykke Li", "I Follow Rivers", seconds)]).swapped is True


@pytest.mark.parametrize("artist, title", [("", "Something"), ("Someone", ""), ("", "")])
def test_half_a_pair_is_never_reoriented(artist, title):
    assert choose_orientation(artist, title, [_row("Lykke Li", "I Follow Rivers")]).swapped is False


def test_ambiguity_is_not_a_reason_to_rename_a_song():
    """Both readings match the row about equally — leave it as the caller had it."""
    decided = choose_orientation("Air", "Air", [_row("Air", "Air")])
    assert decided.swapped is False


def test_one_query_serves_both_readings():
    seen = []

    def search(query):
        seen.append(query)
        return [_row("Lykke Li", "I Follow Rivers", 244)]

    decided = resolve_orientation(*LYKKE, search=search)

    assert len(seen) == 1, "a second round trip would buy nothing"
    assert decided.swapped is True


def test_a_provider_that_fails_never_blocks_acquisition():
    def search(_query):
        raise RuntimeError("deezer is down")

    decided = resolve_orientation(*LYKKE, search=search)

    assert decided.swapped is False
    assert (decided.artist, decided.title) == LYKKE
    assert decided.reason == "lookup_failed"


def test_the_query_drops_the_noise_a_catalog_cannot_answer():
    """The raw pair returns zero rows from Deezer; the normalised one returns five."""
    seen = []

    def search(query):
        seen.append(query)
        return [_row("Lykke Li", "I Follow Rivers")]

    resolve_orientation(*LYKKE, search=search)

    assert seen == ["i follow rivers lykke li"]
    assert "(" not in seen[0] and "/" not in seen[0]
