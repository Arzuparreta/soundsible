"""Unhandled failures must answer JSON, not Flask's HTML 500 page.

A client that parses every response as JSON got an unparseable body whenever a
route raised something it did not anticipate — and the crash was reported with
`traceback.print_exc()`, which never reaches the log file the desktop app ships.
"""

import json
import logging

import pytest
from flask import Flask

from shared.api.errors import api_error, register_error_handlers


@pytest.fixture()
def app():
    application = Flask(__name__)
    register_error_handlers(application)

    @application.route("/boom")
    def boom():
        raise RuntimeError("something specific and internal")

    @application.route("/teapot")
    def teapot():
        from werkzeug.exceptions import ImATeapot

        raise ImATeapot()

    @application.route("/handled")
    def handled():
        return api_error("Track not found", 404, code="track_missing", track_id="t1")

    return application


def test_unhandled_exception_answers_json(app):
    response = app.test_client().get("/boom")

    assert response.status_code == 500
    assert response.is_json
    assert response.get_json()["code"] == "internal_error"


def test_unhandled_exception_does_not_leak_internals(app):
    """The message reaches the log, not the client."""
    body = json.dumps(app.test_client().get("/boom").get_json())

    assert "something specific and internal" not in body


def test_unhandled_exception_is_logged_with_a_traceback(app, caplog):
    with caplog.at_level(logging.ERROR, logger="shared.api.errors"):
        app.test_client().get("/boom")

    assert any(record.exc_info for record in caplog.records), "no traceback was logged"


def test_unknown_route_answers_json(app):
    response = app.test_client().get("/no-such-route")

    assert response.status_code == 404
    assert response.is_json
    assert "error" in response.get_json()


def test_http_exceptions_keep_their_status(app):
    response = app.test_client().get("/teapot")

    assert response.status_code == 418
    assert response.is_json


def test_api_error_carries_a_code_and_extra_fields(app):
    response = app.test_client().get("/handled")
    body = response.get_json()

    assert response.status_code == 404
    assert body == {"error": "Track not found", "code": "track_missing", "track_id": "t1"}


def test_api_error_omits_the_code_when_there_is_none():
    application = Flask(__name__)
    with application.test_request_context():
        payload, status = api_error("Bad input")

    assert status == 400
    assert payload.get_json() == {"error": "Bad input"}
