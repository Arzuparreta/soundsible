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
