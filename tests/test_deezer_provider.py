"""The single Deezer client.

Two clients used to exist, with different timeouts, User-Agents and caching —
so the same query answered differently depending on which route asked, and an
artist page fired five uncached calls on five fresh connections.
"""

import threading
from unittest.mock import MagicMock

import pytest
import requests

from shared.providers import deezer


@pytest.fixture(autouse=True)
def _clean_cache():
    deezer.clear_cache()
    yield
    deezer.clear_cache()


def _response(payload, status=200):
    response = MagicMock()
    response.json.return_value = payload
    response.status_code = status
    response.raise_for_status.return_value = None
    return response


def test_repeated_calls_hit_the_network_once(monkeypatch):
    get = MagicMock(return_value=_response({"id": 77, "name": "Artist"}))
    monkeypatch.setattr(deezer, "session", lambda: MagicMock(get=get))

    first = deezer.get("artist/77")
    second = deezer.get("artist/77")

    assert first == second == {"id": 77, "name": "Artist"}
    assert get.call_count == 1


def test_different_params_are_different_entries(monkeypatch):
    get = MagicMock(side_effect=lambda *a, **k: _response({"q": k["params"]["q"]}))
    monkeypatch.setattr(deezer, "session", lambda: MagicMock(get=get))

    assert deezer.get("search", {"q": "a"}) == {"q": "a"}
    assert deezer.get("search", {"q": "b"}) == {"q": "b"}
    assert get.call_count == 2


def test_param_order_does_not_change_the_key(monkeypatch):
    get = MagicMock(return_value=_response({"ok": True}))
    monkeypatch.setattr(deezer, "session", lambda: MagicMock(get=get))

    deezer.get("search", {"q": "x", "limit": 5})
    deezer.get("search", {"limit": 5, "q": "x"})

    assert get.call_count == 1


def test_concurrent_callers_collapse_onto_one_request(monkeypatch):
    """Ten clients opening the same artist must not become ten Deezer calls."""
    started = threading.Event()
    release = threading.Event()
    calls = []

    def slow_get(*args, **kwargs):
        calls.append(1)
        started.set()
        release.wait(5)
        return _response({"id": 1})

    monkeypatch.setattr(deezer, "session", lambda: MagicMock(get=slow_get))

    threads = [threading.Thread(target=lambda: deezer.get("artist/1")) for _ in range(10)]
    for thread in threads:
        thread.start()
    started.wait(5)
    release.set()
    for thread in threads:
        thread.join(5)

    assert len(calls) == 1


def test_non_object_payloads_become_empty_dicts(monkeypatch):
    monkeypatch.setattr(deezer, "session", lambda: MagicMock(get=MagicMock(return_value=_response([1, 2]))))

    assert deezer.get("weird") == {}


def test_rows_extracts_the_data_list(monkeypatch):
    payload = {"data": [{"id": 1}, "not-a-row", {"id": 2}]}
    monkeypatch.setattr(deezer, "session", lambda: MagicMock(get=MagicMock(return_value=_response(payload))))

    assert deezer.rows("search") == [{"id": 1}, {"id": 2}]


def test_rows_is_empty_when_data_is_missing(monkeypatch):
    monkeypatch.setattr(deezer, "session", lambda: MagicMock(get=MagicMock(return_value=_response({}))))

    assert deezer.rows("search") == []


def test_errors_reach_the_caller(monkeypatch):
    failing = MagicMock()
    failing.raise_for_status.side_effect = requests.HTTPError("503")
    monkeypatch.setattr(deezer, "session", lambda: MagicMock(get=MagicMock(return_value=failing)))

    with pytest.raises(requests.HTTPError):
        deezer.get("artist/77")


def test_failures_are_not_cached(monkeypatch):
    calls = []

    def flaky(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise requests.ConnectionError("boom")
        return _response({"ok": True})

    monkeypatch.setattr(deezer, "session", lambda: MagicMock(get=flaky))

    with pytest.raises(requests.ConnectionError):
        deezer.get("artist/77")
    assert deezer.get("artist/77") == {"ok": True}


def test_uncached_calls_bypass_the_memo(monkeypatch):
    get = MagicMock(return_value=_response({"ok": True}))
    monkeypatch.setattr(deezer, "session", lambda: MagicMock(get=get))

    deezer.get("artist/77", use_cache=False)
    deezer.get("artist/77", use_cache=False)

    assert get.call_count == 2


def test_session_is_pooled_and_reused():
    """Every call used to open its own TCP+TLS connection."""
    first = deezer.session()

    assert deezer.session() is first
    assert first.headers["User-Agent"] == deezer.USER_AGENT
    adapter = first.get_adapter("https://api.deezer.com/")
    assert adapter._pool_maxsize > 1
