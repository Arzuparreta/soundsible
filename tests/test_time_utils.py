"""Sanity checks for UTC time helpers."""

from shared.time_utils import utc_naive, utc_now_iso_naive, utc_now_iso_z


def test_utc_now_iso_z_suffix():
    assert utc_now_iso_z().endswith("Z")
    assert "+00:00" not in utc_now_iso_z()


def test_utc_now_iso_naive_has_no_tz_offset():
    s = utc_now_iso_naive()
    assert "+00:00" not in s
    assert "T" in s


def test_utc_naive_is_timezone_unaware():
    assert utc_naive().tzinfo is None


# ── Shared text helpers ──────────────────────────────────────────────────────
# `collapse_text` / `normalize_text` / `identity_key` replaced byte-identical
# copies in routes/catalog.py, routes/discovery.py and shared/migration/.

from shared.text_utils import (
    collapse_text,
    fold_text,
    identity_key,
    match_tokens,
    normalize_text,
    strip_release_junk,
)


def test_collapse_text_trims_and_squeezes_whitespace():
    assert collapse_text("  Boards   of\tCanada \n") == "Boards of Canada"


def test_collapse_text_handles_missing_values():
    assert collapse_text(None) == ""
    assert collapse_text("") == ""


def test_collapse_text_truncates_only_when_asked():
    assert collapse_text("abcdef", 3) == "abc"
    assert collapse_text("abcdef") == "abcdef"


def test_normalize_text_folds_case_for_comparison():
    assert normalize_text("MASSIVE  Attack") == normalize_text("massive attack")
    # casefold, not lower: ß compares equal to ss.
    assert normalize_text("STRASSE") == normalize_text("Straße")


def test_identity_key_matches_regardless_of_spacing_or_case():
    assert identity_key("Teardrop", "Massive Attack") == identity_key("  teardrop ", "MASSIVE   ATTACK")


def test_identity_key_keeps_title_and_artist_apart():
    """A NUL separator means a space cannot migrate between the two fields."""
    assert identity_key("b c", "a") != identity_key("c", "a b")


def test_fold_text_ignores_accents():
    assert fold_text("José") == fold_text("Jose") == "jose"
    assert fold_text("Björk") == "bjork"


def test_fold_text_keeps_the_casefold_behaviour_it_builds_on():
    """Case is folded before decomposition, so ß still reaches ss."""
    assert fold_text("STRASSE") == fold_text("Straße") == "strasse"


def test_fold_text_leaves_scripts_without_an_ascii_form_intact():
    """An ascii-encode would empty these out and make them all match each other."""
    assert fold_text("周杰倫") == "周杰倫"
    assert fold_text("Кино") == "кино"
    assert fold_text("周杰倫") != fold_text("Кино")


def test_normalize_text_was_left_alone():
    """`identity_key` decides what counts as the same recording app-wide.

    Folding accents there would silently change ownership matching everywhere,
    which is why `fold_text` is a separate function rather than an upgrade.
    """
    assert normalize_text("José") != normalize_text("Jose")


def test_match_tokens_splits_the_folded_text():
    assert match_tokens("In Rainbows!") == ("in", "rainbows")
    assert match_tokens("José González") == ("jose", "gonzalez")
    assert match_tokens("") == ()


def test_strip_release_junk_drops_format_annotations():
    assert strip_release_junk("Creep (Official Video) [HD]") == "Creep"
    assert strip_release_junk("Nude [4K Remastered]") == "Nude"


def test_strip_release_junk_keeps_what_distinguishes_a_recording():
    """`(Live)` and `(Remix)` are different takes, not uploader boilerplate."""
    assert strip_release_junk("Creep (Live)") == "Creep (Live)"
    assert strip_release_junk("Creep (Zero 7 Remix)") == "Creep (Zero 7 Remix)"
