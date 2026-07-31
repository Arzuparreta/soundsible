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

from shared.text_utils import collapse_text, identity_key, normalize_text


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
