"""The reading has to be honest or it is worse than no reading at all."""

import shared.link_quality as link_quality
from shared.link_quality import (
    SCOPE_LAN,
    SCOPE_LOCAL,
    SCOPE_REMOTE,
    SCOPE_TAILNET,
    classify_scope,
    record,
    snapshot,
)
import pytest


@pytest.fixture(autouse=True)
def clean():
    link_quality.reset()
    yield
    link_quality.reset()


@pytest.mark.parametrize(
    "address,expected",
    [
        ("127.0.0.1", SCOPE_LOCAL),
        ("192.168.1.138", SCOPE_LAN),
        ("10.0.0.4", SCOPE_LAN),
        ("100.86.18.8", SCOPE_TAILNET),  # Tailscale hands out 100.64/10
        ("79.116.218.53", SCOPE_REMOTE),
        ("", SCOPE_REMOTE),
        (None, SCOPE_REMOTE),
    ],
)
def test_scope_is_read_off_the_address_and_nothing_else(address, expected):
    assert classify_scope(address) == expected


def test_the_reading_is_the_peak_of_the_complete_responses():
    """A deck that has buffered reads slowly on purpose; averaging that in
    measures the player's patience, not the link."""
    record("u", scope=SCOPE_TAILNET, delivered_bytes=2_000_000, elapsed_ms=1000, complete=True)
    record("u", scope=SCOPE_TAILNET, delivered_bytes=2_000_000, elapsed_ms=20_000, complete=True)

    assert snapshot("u")["kbps"] == pytest.approx(16000, rel=0.01)


def test_an_abandoned_response_is_counted_but_not_timed():
    """Its bytes may still be sitting in a socket buffer, so it cannot say
    anything true about speed."""
    record("u", scope=SCOPE_TAILNET, delivered_bytes=5_000_000, elapsed_ms=1, complete=False)

    reading = snapshot("u")
    assert reading["kbps"] is None
    assert reading["samples"] == 1


def test_a_chunk_too_small_to_measure_bandwidth_is_ignored():
    """256 KB over a 200 ms path reads as slow however fat the pipe is."""
    record("u", scope=SCOPE_LAN, delivered_bytes=8_000, elapsed_ms=500, complete=True)

    assert snapshot("u")["kbps"] is None


def test_nothing_measured_says_so_instead_of_saying_zero():
    assert snapshot("nobody") == {"scope": None, "kbps": None, "samples": 0, "measured_at": None}


def test_readings_expire_so_a_listener_is_not_told_about_last_hour(monkeypatch):
    record("u", scope=SCOPE_LAN, delivered_bytes=1_000_000, elapsed_ms=100, complete=True)
    later = link_quality.SAMPLE_TTL_SEC + 60

    import time as clock

    assert snapshot("u", now=clock.time() + later)["samples"] == 0
