"""The shared sliding-window rate limiter.

It used to keep one entry per (action, client IP) for the whole process
lifetime. `shared/api/routes/playback.py` had already hit that and bounded its
own copy; these tests pin the behaviour on the shared one.
"""

import shared.hardening as hardening
from shared.hardening import _WindowRateLimiter


def test_allows_up_to_the_limit_then_refuses():
    limiter = _WindowRateLimiter()

    assert [limiter.allow("save:1.2.3.4", limit=3, window_sec=60) for _ in range(4)] == [
        True,
        True,
        True,
        False,
    ]


def test_refused_hits_do_not_extend_the_window():
    """A blocked caller must not push its own window forward by hammering."""
    limiter = _WindowRateLimiter()
    limiter.allow("save:1.2.3.4", limit=1, window_sec=60)

    assert limiter.allow("save:1.2.3.4", limit=1, window_sec=60) is False
    _, events = limiter._events["save:1.2.3.4"]
    assert len(events) == 1


def test_prunes_elapsed_keys_once_over_the_cap(monkeypatch):
    monkeypatch.setattr(hardening, "_RATE_LIMIT_MAX_KEYS", 8)
    limiter = _WindowRateLimiter()

    # Windows of zero seconds are elapsed the moment they are recorded.
    for n in range(12):
        limiter.allow(f"save:10.0.0.{n}", limit=5, window_sec=0)

    assert len(limiter._events) <= 8


def test_pruning_keeps_keys_whose_own_window_is_still_open(monkeypatch):
    """Actions carry different windows; a short one must not evict a long one."""
    monkeypatch.setattr(hardening, "_RATE_LIMIT_MAX_KEYS", 4)
    limiter = _WindowRateLimiter()

    limiter.allow("login:1.2.3.4", limit=5, window_sec=3600)
    for n in range(8):
        limiter.allow(f"save:10.0.0.{n}", limit=5, window_sec=0)

    assert "login:1.2.3.4" in limiter._events
