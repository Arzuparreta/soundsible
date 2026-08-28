"""How much database work a single API request costs.

Every authenticated request runs through `_bind_request_user`, which resolves
who is calling. That resolution used to rebuild a `DatabaseManager` — and with
it open a fresh connection and run three PRAGMAs behind a process-global lock —
several times over, before any handler ran. These budgets are deliberately
tight so a regression shows up as a failing test rather than as latency.
"""

import sqlite3

import pytest

import shared.database as database
from shared import request_scope


@pytest.fixture()
def db_budget(monkeypatch):
    """Count connections opened and managers built while it is active."""
    counts = {"connect": 0, "manager": 0}

    real_connect = sqlite3.connect

    def counting_connect(*args, **kwargs):
        counts["connect"] += 1
        return real_connect(*args, **kwargs)

    real_init = database.DatabaseManager.__init__

    def counting_init(self, *args, **kwargs):
        counts["manager"] += 1
        return real_init(self, *args, **kwargs)

    monkeypatch.setattr(sqlite3, "connect", counting_connect)
    monkeypatch.setattr(database.DatabaseManager, "__init__", counting_init)
    return counts


@pytest.fixture()
def client():
    from shared.api import app

    app.config["TESTING"] = True
    with app.test_client() as test_client:
        # Warm anything built lazily on first contact so the budget measures a
        # steady-state request, not startup.
        test_client.get("/api/health")
        yield test_client


def test_health_is_cheap(client, db_budget):
    response = client.get("/api/health")

    assert response.status_code == 200
    assert db_budget["connect"] <= 1, (
        f"/api/health opened {db_budget['connect']} connections"
    )


def test_library_request_does_not_rebuild_managers(client, db_budget):
    response = client.get("/api/library")

    assert response.status_code == 200
    # Was 7 managers and 15 connections before managers were shared per path and
    # connections reused per thread.
    assert db_budget["manager"] <= 1, (
        f"one request built {db_budget['manager']} DatabaseManagers"
    )
    assert db_budget["connect"] <= 2, (
        f"one request opened {db_budget['connect']} connections"
    )


def test_many_requests_do_not_grow_connections_unboundedly(client, db_budget):
    """The incident this budget was widened for: a connection cached per
    calling thread forever is, under gevent's per-request greenlet, a
    connection leaked per request. 25 sequential requests should settle into
    reusing a small, bounded set of pooled connections — not open a new one
    each time. See `shared.database.ConnectionPool`."""
    for _ in range(25):
        response = client.get("/api/health")
        assert response.status_code == 200

    # Generous ceiling: what matters is "bounded", not a specific small
    # number — 25 requests must not have opened 25 connections.
    assert db_budget["connect"] <= 4, (
        f"25 requests opened {db_budget['connect']} connections"
    )


def test_streaming_route_can_release_request_resources_before_teardown():
    released = []
    token = request_scope.begin()
    try:
        request_scope.on_end(lambda: released.append("connection"))
        request_scope.release_resources()
        assert released == ["connection"]
    finally:
        request_scope.end(token)
    assert released == ["connection"]
