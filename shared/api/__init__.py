"""
Unified API Server for Soundsible.
Acts as the bridge between the Python core and various frontends (Tauri, Web, PWA).
"""

import os
import sys
import errno
import signal
import threading
import json
import logging
import time
from html import escape as html_escape
from pathlib import Path
from flask import Flask, g, request, jsonify, send_from_directory, Response, redirect, make_response
from flask_socketio import join_room, leave_room
from flask_cors import CORS

logger = logging.getLogger(__name__)
API_STARTED_AT = time.time()

from shared import request_scope
from shared.constants import STATION_PORT, DEFAULT_OUTPUT_DIR_FALLBACK
from shared.app_config import set_output_dir as set_app_output_dir
from shared.runtime import (
    configure_runtime,
    ensure_runtime_directories,
    get_config_dir,
    get_music_dir,
    get_runtime_config,
    migrate_legacy_app_dirs,
    runtime_with_overrides,
    RuntimeConfig,
)
from shared.ensure_ui_dist import ensure_ui_dist
from shared.ui_assets import serve_ui_asset
from shared.version import resolve_version
from shared.playback_state import (  # noqa: F401  # aliases re-exported to blueprints
    get_state as get_playback_state,
    put_state as put_playback_state,
    get_scope_from_request,
    get_registered_device,
    get_watch_state,
    register_device,
    register_socket_instance,
    unregister_socket,
)
from shared.downloader.settings import setting

from typing import Optional, Any

# Re-exported for the blueprints, which reach back into this module rather than
# importing `shared.security` directly (see `_get_api` in routes/).
from shared.security import is_trusted_network, is_safe_path, request_client_address  # noqa: F401
from shared.hardening import SCOPE_PLAYBACK_CONTROL, apply_security_headers, get_request_auth_context
from shared.telemetry import init_telemetry

from .errors import register_error_handlers
from .origins import make_socket_origin_check, rest_origins, socket_origins
from shared.download_pump import queue_manager_dl, start_downloader_pump
from shared.orchestrator import orchestrator
from shared.realtime import (
    emit_device_updated,
    server_now_ms,
    socketio,
    user_room,
    watch_room,
)
from shared.station_addresses import active_endpoints
from shared.user_cores import get_user_core


app = Flask(__name__)
# Anything a route does not catch answers JSON from here rather than escaping as
# Flask's HTML 500 page, which a client parsing JSON cannot read.
register_error_handlers(app)


CORS(
    app,
    origins=rest_origins(),
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "X-Soundsible-Admin-Token",
        "X-Soundsible-Agent-Token",
        "X-Soundsible-CSRF",
        "X-Soundsible-Work",
        "X-Soundsible-Work-Request",
        "Range",
    ],
)


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("API: %s=%r is not an int; using default %d", name, raw, default)
        return default


# Engine.IO heartbeat tuned for Tailscale / mobile NAT rebinding (plan T5).
# Server pings every ping_interval seconds and declares a peer dead if no
# pong arrives within ping_timeout. With the defaults below, the server
# detects a wedged peer within ~45s — short enough that the client's
# reconnect loop can heal a city-block walk without a manual refresh, but
# long enough to ride out the typical LTE → Wi-Fi handoff (~10-30s) and
# brief screen-lock pauses.
SOCKET_PING_INTERVAL = _int_env("SOUNDSIBLE_SOCKET_PING_INTERVAL", 20)
SOCKET_PING_TIMEOUT = _int_env("SOUNDSIBLE_SOCKET_PING_TIMEOUT", 25)

socketio.init_app(
    app,
    cors_allowed_origins=make_socket_origin_check(socket_origins()),
    async_mode="gevent",
    ping_interval=SOCKET_PING_INTERVAL,
    ping_timeout=SOCKET_PING_TIMEOUT,
)

# Note: Suppress engineio/socketio INFO logs (e.g. "invalid session" when browser reconnects with stale sid)
logging.getLogger("engineio").setLevel(logging.WARNING)
logging.getLogger("socketio").setLevel(logging.WARNING)


def _wrap_iterable_suppress_client_disconnect(iterable, log):
    """Wrap response iterable; on client disconnect (EIO/BrokenPipe/ConnectionReset) log at debug and stop."""
    it = iter(iterable)
    while True:
        try:
            chunk = next(it)
        except StopIteration:
            break
        except (BrokenPipeError, ConnectionResetError):
            log.debug("Client disconnected while sending response (broken pipe or connection reset)")
            break
        except OSError as e:
            if e.errno == errno.EIO:
                log.debug("Client disconnected while sending response (I/O error)")
                break
            raise
        yield chunk


class _SuppressClientDisconnectMiddleware:
    """WSGI middleware: catch EIO/BrokenPipe/ConnectionReset when streaming response and log at debug."""

    def __init__(self, app, log=None):
        self.app = app
        self.log = log or logger

    def __call__(self, environ, start_response):
        result = self.app(environ, start_response)
        return _wrap_iterable_suppress_client_disconnect(result, self.log)


app.wsgi_app = _SuppressClientDisconnectMiddleware(app.wsgi_app)


@app.after_request
def _set_security_headers(resp):
    resp = apply_security_headers(resp)
    xf_proto = (request.headers.get("X-Forwarded-Proto") or "").lower()
    if request.is_secure or xf_proto == "https":
        resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return resp


# ---------------------------------------------------------------------------
# Identity gate
#
# Most read routes carry no scope decorator — they predate accounts, when every
# caller was the same person. Rather than decorate ~126 endpoints and hope none
# is missed, authentication happens once here: no request reaches a blueprint
# without a resolved user, and every request runs with that user bound so the
# managers underneath read the right directories.
# ---------------------------------------------------------------------------

# Endpoints reachable before you are anybody: the login itself, the check the
# player uses to decide whether to show a login screen, health for the shell,
# and the pairing claim a new device performs with only a visible code.
PUBLIC_API_PATHS = frozenset({
    "/api/auth/state",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/health",
    "/api/pairing/sessions/claim",
    "/api/tv-auth/requests",
    "/api/tv-auth/status",
    "/api/tv-auth/redeem",
    "/api/tv-auth/cancel",
})

# Redeeming an invitation happens before you have an account, so these two
# cannot require one. The token itself is the credential.
PUBLIC_API_PREFIXES = ("/api/invites/",)
PUBLIC_API_SUFFIXES = ("/preview", "/accept")


def _resolve_request_user_id() -> Optional[str]:
    """Identity behind this request, or ``None`` when it is anonymous."""
    from shared.users import sole_passwordless_user

    context = get_request_auth_context(allow_trusted_network=True)
    user_id = (context or {}).get("user_id")
    if user_id:
        return user_id
    # One account, no password: the instance behaves exactly like it did before
    # accounts existed, so the lone user is implied.
    sole = sole_passwordless_user()
    return sole["id"] if sole else None


def _api_request_is_public() -> bool:
    path = (request.path or "").rstrip("/")
    if not path.startswith("/api/"):
        return True
    if request.method == "OPTIONS":
        return True
    if path in PUBLIC_API_PATHS:
        return True
    # `/api/invites/<token>/preview` and `/…/accept`, but never the admin
    # collection routes that list or mint invitations.
    return path.startswith(PUBLIC_API_PREFIXES) and path.endswith(PUBLIC_API_SUFFIXES)


@app.before_request
def _bind_request_user():
    from shared.user_context import bind_user
    from shared.users import instance_requires_login

    # Opened before anything reads: resolving the caller is itself one of the
    # repeat readers this scope exists to collapse. Track stacks so nested test
    # client calls on the same thread cannot overwrite outer teardown tokens.
    scope_tokens = getattr(g, "_soundsible_scope_tokens", None)
    if scope_tokens is None:
        scope_tokens = []
        g._soundsible_scope_tokens = scope_tokens
    scope_tokens.append(request_scope.begin())

    user_tokens = getattr(g, "_soundsible_user_tokens", None)
    if user_tokens is None:
        user_tokens = []
        g._soundsible_user_tokens = user_tokens
    user_tokens.append(None)
    user_id = _resolve_request_user_id()

    if user_id is None and instance_requires_login() and not _api_request_is_public():
        return jsonify({"error": "Authentication required", "code": "login_required"}), 401

    if user_id:
        user_tokens[-1] = bind_user(user_id)
    return None


@app.teardown_request
def _unbind_request_user(_exc=None):
    from shared.user_context import unbind_user

    user_tokens = getattr(g, "_soundsible_user_tokens", None)
    if user_tokens:
        token = user_tokens.pop()
        if token is not None:
            unbind_user(token)

    scope_tokens = getattr(g, "_soundsible_scope_tokens", None)
    if scope_tokens:
        request_scope.end(scope_tokens.pop())


@socketio.on('playback_register')
def on_playback_register(data):
    """Register this socket instance for remote control and broadcast its device row."""
    payload = data if isinstance(data, dict) else {}
    device_id = str(payload.get('device_id') or '').strip()
    if not device_id:
        return
    # Socket events bypass Flask's user-binding hooks. Resolve the account for
    # this event instead of registering every socket in the default scope.
    from shared.user_context import user_context

    with request_scope.request_scope():
        user_id = _resolve_request_user_id()
        if not user_id:
            return
        with user_context(user_id):
            scope = get_scope_from_request()
            row, moved_from = register_socket_instance(
                scope,
                device_id,
                request.sid,
                device_name=payload.get("device_name"),
                device_type=payload.get("device_type"),
                form_factor=payload.get("form_factor"),
                instance_id=payload.get("instance_id"),
                protocol=payload.get("protocol"),
                commands=payload.get("commands"),
            )
            if moved_from:
                old_scope, old_row = moved_from
                emit_device_updated(old_scope, old_row)
            if row:
                emit_device_updated(scope, row)


@socketio.on("watch_device")
def on_watch_device(data):
    """Subscribe this socket to live playback updates for one device in its own account."""
    payload = data if isinstance(data, dict) else {}
    device_id = str(payload.get("device_id") or "").strip()
    now_ms = server_now_ms()
    if not device_id:
        return {"device": None, "state": None, "server_now_ms": now_ms, "error": "unknown_device"}
    from shared.user_context import user_context

    with request_scope.request_scope():
        user_id = _resolve_request_user_id()
        if not user_id:
            return {"device": None, "state": None, "server_now_ms": now_ms, "error": "unknown_device"}
        with user_context(user_id):
            scope = get_scope_from_request()
            row = get_registered_device(scope, device_id)
            if not row:
                return {"device": None, "state": None, "server_now_ms": now_ms, "error": "unknown_device"}
            join_room(watch_room(scope, device_id), sid=request.sid)
            state = get_watch_state(scope, device_id)
            return {"device": row, "state": state, "server_now_ms": server_now_ms()}


@socketio.on("unwatch_device")
def on_unwatch_device(data):
    """Unsubscribe this socket from live playback updates for one device."""
    payload = data if isinstance(data, dict) else {}
    device_id = str(payload.get("device_id") or "").strip()
    if not device_id:
        return {"ok": False}
    from shared.user_context import user_context

    with request_scope.request_scope():
        user_id = _resolve_request_user_id()
        if not user_id:
            return {"ok": False}
        with user_context(user_id):
            scope = get_scope_from_request()
            leave_room(watch_room(scope, device_id), sid=request.sid)
            return {"ok": True, "device_id": device_id}


#: How often an open socket's credential is checked again. A socket is
#: admitted once, at connect; without this, logging out, revoking a paired
#: device, disabling an account or the session expiring left it subscribed to
#: that account's private events until it happened to reconnect.
SOCKET_AUTH_RECHECK_SEC = 30

#: Admitted sockets and the account each was admitted for (None: no account).
_admitted_sockets: dict[str, Optional[str]] = {}


def _socket_admission() -> tuple[bool, Optional[str]]:
    """Whether the socket in this request context may stay, and for whom.

    Run at connect and again by `recheck_sockets` on the environ the socket
    connected with, so both apply the same rule.
    """
    from shared.users import instance_requires_login

    runtime = get_runtime_config()
    context = get_request_auth_context(allow_trusted_network=True)
    if context and (context.get("kind") == "owner" or SCOPE_PLAYBACK_CONTROL in set(context.get("scopes") or [])):
        return True, _resolve_request_user_id()
    # Once the instance has accounts, a local or LAN address proves nothing
    # about who is connecting — the socket carries library events.
    if not instance_requires_login():
        if runtime.advanced_mode:
            return True, _resolve_request_user_id()
        if request_client_address() in {"127.0.0.1", "::1"} and not runtime.lan_enabled:
            return True, _resolve_request_user_id()
    return False, None


@socketio.on("connect")
def on_socket_connect(auth=None):
    # Socket.IO events never pass through Flask's before_request/teardown_request,
    # so give auth resolution its own memo lifetime. SQLite loans end with
    # their database blocks independently of this scope.
    with request_scope.request_scope():
        admitted, user_id = _socket_admission()
    if not admitted:
        logger.warning("Socket.IO connect denied for remote=%s origin=%s",
                       request_client_address(), request.headers.get("Origin"))
        return False
    if user_id:
        join_room(user_room(user_id), sid=request.sid)
    _admitted_sockets[request.sid] = user_id
    return True


@socketio.on("disconnect")
def on_socket_disconnect():
    _admitted_sockets.pop(request.sid, None)
    updated = unregister_socket(request.sid)
    if updated:
        scope, row = updated
        emit_device_updated(scope, row)


def recheck_sockets() -> int:
    """Disconnect every socket whose credential no longer admits it, or admits
    it for another account. Returns how many were disconnected."""
    dropped = 0
    for sid, user_id in list(_admitted_sockets.items()):
        try:
            environ = socketio.server.get_environ(sid)
        except KeyError:
            environ = None
        if environ is None:
            _admitted_sockets.pop(sid, None)
            continue
        with app.request_context(environ), request_scope.request_scope():
            admitted, current = _socket_admission()
        if admitted and current == user_id:
            continue
        _admitted_sockets.pop(sid, None)
        socketio.server.disconnect(sid)
        dropped += 1
    return dropped


def _recheck_sockets_forever() -> None:
    while True:
        socketio.sleep(SOCKET_AUTH_RECHECK_SEC)
        try:
            dropped = recheck_sockets()
            if dropped:
                logger.info("Socket.IO: disconnected %d socket(s) whose credential lapsed", dropped)
        except Exception:
            logger.warning("Socket.IO: credential recheck failed", exc_info=True)


# Note: Path to the new web UI and repo branding
from shared.bundle_paths import repo_root as _bundle_repo_root

_REPO_ROOT = os.path.abspath(str(_bundle_repo_root()))
WEB_UI_PATH = os.path.join(_REPO_ROOT, "ui_web")
WEB_UI_DIST_PATH = os.path.join(WEB_UI_PATH, "dist")
REPO_ROOT = _REPO_ROOT
BRANDING_PATH = os.path.join(REPO_ROOT, 'branding')


def _web_ui_root():
    """Resolve the directory that ``/player`` is served from.

    Precedence:
      1. An explicit ``ui_dist`` runtime override (set by the desktop engine).
      2. ``SOUNDSIBLE_WEB_UI_DIST`` env override — a truthy value forces the
         bundled ``ui_web/dist`` build, a falsey value (``0``/``false``/``no``)
         forces the raw source tree.
      3. Auto-detect: serve ``ui_web/dist`` whenever it has been built,
         otherwise fall back to the ``ui_web`` source tree.

    The SolidJS player only works from a build: its source
    entry is a Vite dev shell pointing at ``/src/main.tsx``, which Flask cannot
    serve. So a present build is preferred automatically — no env var needed.
    """
    runtime = get_runtime_config()
    if runtime.ui_dist and os.path.isfile(os.path.join(str(runtime.ui_dist), "index.html")):
        return str(runtime.ui_dist)

    dist_built = os.path.isfile(os.path.join(WEB_UI_DIST_PATH, "index.html"))
    env_override = os.environ.get("SOUNDSIBLE_WEB_UI_DIST", "").strip().lower()
    if env_override in ("0", "false", "no"):
        return WEB_UI_PATH
    return WEB_UI_DIST_PATH if dist_built else WEB_UI_PATH


def _read_owner_token_for_ui() -> Optional[str]:
    runtime = get_runtime_config()
    token_file = runtime.owner_token_file
    if not token_file:
        return None
    try:
        token = token_file.read_text().strip()
    except Exception:
        logger.debug("UI token injection: failed to read owner token file", exc_info=True)
        return None
    return token or None


def _inject_owner_token_bootstrap(html: str, token: Optional[str]) -> str:
    if not token:
        return html
    bootstrap = (
        '<meta name="soundsible-owner-token" content="{token}">\n'
        '<script>window.__SOUNDSIBLE_OWNER_TOKEN__={token_json};</script>\n'
    ).format(
        token=html_escape(token, quote=True),
        token_json=json.dumps(token),
    )
    if "</head>" in html:
        return html.replace("</head>", f"{bootstrap}</head>", 1)
    return bootstrap + html


def _render_web_ui_html(filename: str, *, inject_owner_token: bool = False):
    # Rebuild dist when sources changed while the engine was already running.
    ensure_ui_dist(external_dist=get_runtime_config().ui_dist)
    root = _web_ui_root()
    path = os.path.join(root, filename)
    if not inject_owner_token:
        response = serve_ui_asset(root, filename)
        response.headers["Cache-Control"] = "no-store"
        return response
    with open(path, "r", encoding="utf-8") as handle:
        html = handle.read()
    token = _read_owner_token_for_ui()
    html = _inject_owner_token_bootstrap(html, token)
    return Response(html, mimetype="text/html")

# Note: Serve web player
@app.route('/player')
def serve_web_player_redirect():
    return redirect('/player/', code=308)


@app.route('/player/')
def serve_web_player():
    return make_response(_render_web_ui_html('index.html'))


# Compatibility aliases for URLs exposed by the legacy multi-page player. The
# SolidJS rebuild is one responsive application, so these surfaces all land on
# the canonical player entry point.
@app.route('/player/app.html')
@app.route('/player/mobile')
@app.route('/player/mobile/')
def serve_web_player_legacy_aliases():
    return redirect('/player/', code=308)

@app.route('/player/desktop')
def serve_web_player_desktop_redirect():
    return redirect('/player/desktop/', code=308)


@app.route('/player/desktop/')
def serve_web_player_desktop():
    return make_response(_render_web_ui_html('index.html', inject_owner_token=True))


def _tv_unavailable_response():
    html = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<title>Soundsible TV Unavailable</title></head>'
        '<body style="background:#0c0c0e;color:#f2f2f5;font-family:system-ui,sans-serif;padding:48px;">'
        '<h1>Soundsible TV is unavailable</h1>'
        '<p>The installed UI bundle does not include the Smart TV entry. '
        'Rebuild or update Soundsible, or open the '
        '<a href="/player/" style="color:#f97a12">web player</a>.</p>'
        '</body></html>'
    )
    resp = Response(html, status=503, mimetype='text/html')
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@app.route('/tv')
def serve_web_tv_redirect():
    return redirect('/tv/', code=308)


@app.route('/tv/')
def serve_web_tv():
    ensure_ui_dist(external_dist=get_runtime_config().ui_dist)
    root = _web_ui_root()
    if not os.path.isfile(os.path.join(root, 'tv.html')):
        return _tv_unavailable_response()
    return make_response(_render_web_ui_html('tv.html'))

@app.route('/favicon.ico')
def serve_favicon():
    # Browsers request /favicon.ico at the root regardless of <link> tags.
    return send_from_directory(BRANDING_PATH, 'logo-mark.svg', mimetype='image/svg+xml')

@app.route('/player/branding/<path:path>')
def serve_branding(path):
    return send_from_directory(BRANDING_PATH, path)

@app.route('/player/<path:path>')
def serve_web_player_assets(path):
    resp = serve_ui_asset(_web_ui_root(), path)
    lp = path.lower()
    # Every branch assigns rather than defaults: `send_file` has already put
    # `Cache-Control: no-cache` on the response (that is what it does when no
    # max_age is given), so `setdefault` here was a no-op and the whole policy
    # below never took effect — the player revalidated its entire bundle,
    # fonts included, on every single load.
    if lp == "sw.js":
        # The one file that must never be served stale: a cached service worker
        # is a worker that can never be replaced, and it would go on serving an
        # old shell long after the app moved on. Browsers cap its freshness at
        # 24h regardless; saying `no-store` makes every update land at once.
        resp.headers["Cache-Control"] = "no-store"
        # Scope is the directory the worker is served from, so it already covers
        # exactly /player/ — but be explicit rather than rely on placement.
        resp.headers["Service-Worker-Allowed"] = "/player/"
    elif lp.endswith(".html"):
        resp.headers["Cache-Control"] = "no-store"
    elif lp.endswith(".webmanifest"):
        # Some platforms won't treat it as a manifest without this type; its name
        # is stable (not hashed) so it must revalidate rather than pin for a year.
        resp.headers["Content-Type"] = "application/manifest+json"
        resp.headers["Cache-Control"] = "public, max-age=3600"
    elif "assets/" in lp and lp.split("?")[0].endswith((".js", ".css", ".woff", ".woff2", ".ttf", ".map", ".svg", ".png", ".ico")):
        # Content-hashed by the build: the URL changes whenever the bytes do,
        # so this can be pinned for as long as the spec allows.
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif lp.startswith("icons/"):
        # Install icons: stable names (the manifest has to be able to point at
        # them), so they revalidate rather than pin — but not on every launch.
        resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp

api_observer = None  # Note: Store observer reference for cleanup in daemon mode
_api_shutdown_lock = threading.Lock()
_api_shutdown_done = False
#: Why this instance came up wrong, or None when it came up whole. Startup
#: refuses to let a failure it survived pass for a healthy server: it still
#: serves — a broken library is exactly when you need the UI that fixes it —
#: but `/api/health` says so, and that is the difference between a bad
#: afternoon and a week of not knowing the watcher was dead.
_startup_degraded_reason: Optional[str] = None


































































# Note: Blueprints details
from shared.api.routes.library import library_bp
from shared.api.routes.library_catalog import library_catalog_bp
from shared.api.routes.playback import playback_bp
from shared.api.routes.downloader import downloader_bp
from shared.api.routes.config import config_bp
from shared.api.routes.discovery import discovery_bp
from shared.api.routes.catalog import catalog_bp
from shared.api.routes.podcasts import podcasts_bp
from shared.api.routes.agent import agent_bp
from shared.api.routes.pairing import pairing_bp
from shared.api.routes.tv_auth import tv_auth_bp
from shared.api.routes.setup import setup_bp
from shared.api.routes.migration import migration_bp
from shared.api.routes.car import car_bp
from shared.api.routes.auth import auth_bp
from shared.api.routes.loudness import loudness_bp
from shared.api.routes.scrobble import scrobble_bp
from shared.api.routes.community import community_bp
from shared.api.routes.subsonic import subsonic_bp
app.register_blueprint(library_bp)
app.register_blueprint(library_catalog_bp)
app.register_blueprint(playback_bp)
app.register_blueprint(downloader_bp)
app.register_blueprint(config_bp)
app.register_blueprint(discovery_bp)
app.register_blueprint(catalog_bp)
app.register_blueprint(podcasts_bp)
app.register_blueprint(agent_bp)
app.register_blueprint(pairing_bp)
app.register_blueprint(tv_auth_bp)
app.register_blueprint(setup_bp)
app.register_blueprint(migration_bp)
app.register_blueprint(car_bp)
app.register_blueprint(auth_bp)
app.register_blueprint(loudness_bp)
app.register_blueprint(scrobble_bp)
app.register_blueprint(community_bp)
# `/rest` is not under `/api`, so `_bind_request_user` leaves it anonymous
# on purpose: the Subsonic surface carries its own credentials and binds
# the account itself.
app.register_blueprint(subsonic_bp)


@app.route('/api/health')
def health_check():
    """Liveness probe.

    Reachable without a session (the desktop shell and the player poll it before
    they know who they are), so the anonymous payload is deliberately thin: no
    server paths, no PID, no account count, no running job ids. Everything that
    describes the machine — or hints that more than one person uses it — needs
    ``admin:instance``.
    """
    from shared.ffmpeg_runtime import ffmpeg_status
    from shared.build_info import source_revision
    from shared.hardening import request_is_admin_user

    runtime = get_runtime_config()
    ffmpeg = ffmpeg_status()
    payload = {
        "status": "degraded" if _startup_degraded_reason else "healthy",
        "version": resolve_version(),
        "ffmpeg": {"available": bool(ffmpeg.get("available"))},
        "uptime_seconds": round(time.time() - API_STARTED_AT, 3),
    }
    if _startup_degraded_reason:
        # Anonymous callers learn *that* the instance came up wrong, never how:
        # the exception text carries file paths and class names, and this route
        # answers before anyone has proved who they are.
        payload["degraded_reason"] = "core initialization failed"

    # The instance DB pool is shared by every request (auth runs before all of
    # them) — a leak elsewhere silently drains it over hours until it's flagged
    # here, instead of this endpoint reporting "healthy" the whole time while
    # every request stalls 10s and then fails. No server paths or account data
    # in these numbers, so this is safe in the anonymous payload too.
    try:
        from shared.database import instance_db

        pool = instance_db().pool_stats()
        payload["db_pool"] = pool
        if pool["created"] >= pool["max_size"] and pool["idle"] == 0:
            payload["status"] = "degraded"
            payload.setdefault("degraded_reason", "database connection pool exhausted")
    except Exception:
        logger.debug("Health: failed to collect db pool stats", exc_info=True)

    # Your own library counts, once we know who you are.
    try:
        from shared.database import user_db
        from shared.user_context import current_user_id

        if current_user_id():
            payload["library"] = user_db().get_stats()
    except Exception:
        logger.debug("Health: failed to collect library stats", exc_info=True)

    if not request_is_admin_user():
        return jsonify(payload)

    config_exists = False
    accounts = 0
    try:
        config_exists = (runtime.config_dir / "config.json").exists()
    except Exception:
        pass
    try:
        from shared.users import count_users

        accounts = count_users()
    except Exception:
        logger.debug("Health: failed to count accounts", exc_info=True)

    payload.update(
        {
            "ffmpeg": ffmpeg,
            # The watcher is the one startup service whose absence is silent:
            # folders simply stop noticing new files. Nothing else reports it.
            "watcher_active": api_observer is not None,
            "pid": os.getpid(),
            "base_url": f"http://{runtime.host}:{runtime.port}",
            "host": runtime.host,
            "port": runtime.port,
            "config_dir": str(runtime.config_dir),
            "cache_dir": str(runtime.cache_dir),
            "data_dir": str(runtime.data_dir),
            "log_dir": str(runtime.log_dir),
            "music_dir": str(runtime.music_dir),
            "ui_dist": str(runtime.ui_dist) if runtime.ui_dist else None,
            "owner_token_file": str(runtime.owner_token_file) if runtime.owner_token_file else None,
            "advanced_mode": runtime.advanced_mode,
            "lan_enabled": runtime.lan_enabled,
            "config_exists": config_exists,
            "accounts": accounts,
            "source_revision": source_revision(_REPO_ROOT),
            "jobs": {
                "active_count": len(orchestrator.active_jobs),
                "active_ids": sorted(orchestrator.active_jobs.keys()),
                "pending_metadata_commit": False,
            },
        }
    )
    if _startup_degraded_reason:
        payload["degraded_detail"] = _startup_degraded_reason
    return jsonify(payload)

@app.route('/')
def home():
    return jsonify({
        "status": "online",
        "service": "Soundsible Core API",
        "version": "1.0.0"
    })

# Note: Server management

def _resolve_output_dir():
    """Resolve OUTPUT_DIR once at startup: environment, then saved settings."""
    target = os.getenv("OUTPUT_DIR") or setting("OUTPUT_DIR")
    if not target:
        try:
            from shared.downloader.config import DEFAULT_OUTPUT_DIR
            target = str(DEFAULT_OUTPUT_DIR)
        except Exception:
            target = str(get_music_dir() or Path(DEFAULT_OUTPUT_DIR_FALLBACK).expanduser().resolve())
    return Path(target).expanduser().resolve() if target else None


def stop_api() -> None:
    """Stop background workers and the gevent SocketIO server."""
    global api_observer, _api_shutdown_done
    with _api_shutdown_lock:
        if _api_shutdown_done:
            return
        _api_shutdown_done = True

    logger.info("API: Shutting down...")
    from shared.cooperative import stop_loop_watchdog
    stop_loop_watchdog()
    queue_manager_dl.accepting = False
    from shared.artwork_recovery import recovery
    recovery.stop()
    from shared.artwork_worker import worker as artwork_worker, http_worker
    artwork_worker.close()
    http_worker.close()

    try:
        wsgi_server = getattr(socketio, "wsgi_server", None)
        if wsgi_server is not None:
            wsgi_server.stop()
    except Exception:
        logger.exception("API: Error stopping WSGI server")

    observer = api_observer
    api_observer = None
    if observer is not None:
        try:
            observer.stop()
        except Exception:
            logger.exception("API: Error stopping music folder watcher")

    try:
        from shared.loudness import stop_loudness_service_if_started

        stop_loudness_service_if_started()
    except Exception:
        logger.exception("API: Error stopping loudness idle worker")

    try:
        from shared.scrobble import stop_scrobble_service_if_started

        stop_scrobble_service_if_started()
    except Exception:
        logger.exception("API: Error stopping scrobble delivery")

    from shared import work
    from shared.dj.store import stop_analysis_process
    work.stop()
    stop_analysis_process()

    try:
        orchestrator.drain_downloads(timeout=5.0)
        orchestrator.shutdown(wait=False)
    except Exception:
        logger.exception("API: Error stopping orchestrator")


def _stop_wsgi_from_signal(_signum: int, _frame: object) -> None:
    """Minimal teardown safe to run inside gevent's signal callback."""
    try:
        wsgi_server = getattr(socketio, "wsgi_server", None)
        if wsgi_server is not None:
            wsgi_server.stop()
    except Exception:
        logger.exception("API: Error handling shutdown signal")


def _register_api_shutdown_handlers() -> None:
    """Stop the server on SIGINT/SIGTERM whichever thread receives the signal.

    A `signal.signal` handler only runs once the main thread executes Python,
    and an idle gevent hub sits in epoll until something wakes it: a SIGTERM the
    kernel handed to one of the worker threads left the engine running for
    good. libev's signal watcher wakes the loop itself.
    """
    try:
        import gevent
    except ImportError:
        signal.signal(signal.SIGINT, _stop_wsgi_from_signal)
        signal.signal(signal.SIGTERM, _stop_wsgi_from_signal)
        return
    for signum in (signal.SIGINT, signal.SIGTERM):
        gevent.signal_handler(signum, _stop_wsgi_from_signal, signum, None)


def _initialize_admin_core():
    """Warm the admin library and start its watcher before serving requests."""
    global api_observer

    from shared.user_context import user_context
    from shared.users import get_admin_user

    admin = get_admin_user()
    if not admin:
        return None

    with user_context(admin["id"]):
        admin_core = get_user_core(admin["id"])
        if admin_core.library.config and admin_core.library.config.watch_folders:
            # A watcher that will not start is a folder that stops scanning
            # itself, not an instance that cannot serve music. Inotify limits
            # and unreadable roots are the usual causes, and neither is a reason
            # to refuse every request. `watcher_active` in /api/health is what
            # keeps this from going unnoticed.
            try:
                from setup_tool.watcher import LibraryWatcher
                from shared.api.library_scan import library_scan_service

                def _scan_watched_path(_path):
                    try:
                        # Scan every configured root so events coalesced while
                        # one job is active cannot strand a second folder.
                        roots = library_scan_service.resolve_roots(admin_core.library)
                        library_scan_service.start(admin["id"], roots)
                    except ValueError as exc:
                        logger.warning("API: watcher ignored unsafe scan path: %s", exc)

                observer = LibraryWatcher(
                    admin_core.library.config,
                    scan_callback=_scan_watched_path,
                )
                observer.start()
                api_observer = observer
                logger.info("API: Music folder watcher started for the admin library.")
            except Exception:
                logger.warning(
                    "API: Music folder watcher could not start; folders will not scan themselves.",
                    exc_info=True,
                )
    return admin_core


def start_api(
    port=STATION_PORT,
    *,
    host: Optional[str] = None,
    debug: bool = False,
    runtime_config: Optional[RuntimeConfig] = None,
    on_ready: Optional[Any] = None,
):
    from shared.logging_setup import configure_logging

    configure_logging()
    global api_observer, _startup_degraded_reason
    _startup_degraded_reason = None
    runtime = runtime_config or get_runtime_config()
    runtime = runtime_with_overrides(base=runtime, host=host, port=port)
    configure_runtime(runtime)
    migrate_legacy_app_dirs(runtime)
    ensure_runtime_directories(runtime)
    init_telemetry(runtime)
    # Accounts before anything else: every manager below resolves its paths
    # through the bound user, so the instance needs at least one to exist.
    from shared.multiuser_migration import ensure_multiuser_layout

    _migration = ensure_multiuser_layout()
    queue_manager_dl.initialize(recover=True)
    if _migration and _migration.get("adopted_existing_library"):
        logger.info(
            "API: Existing library adopted by account %r; originals kept as *.singleuser.bak",
            _migration.get("username"),
        )
    logger.info("--- Soundsible API Boot Sequence ---")
    logger.info("Target Host: %s", runtime.host)
    logger.info("Target Port: %s", runtime.port)
    logger.info("CWD: %s", os.getcwd())
    logger.info("For full startup (sync + watcher) use: python run.py --daemon")
    ensure_ui_dist(external_dist=runtime.ui_dist)

    # Saved downloader settings become environment defaults before anything
    # reads them: the output folder, cloud credentials, the auto-updates.
    from shared.downloader.settings import export_to_environ

    export_to_environ()
    # Set app config so path_resolver and security do not depend on the downloader
    _out = _resolve_output_dir()
    if _out:
        set_app_output_dir(_out)
        logger.info("API: Output dir set to %s", _out)
        # Note: So desktop player finds path when it reads the runtime config dir output_dir file
        try:
            cfg = get_config_dir()
            cfg.mkdir(parents=True, exist_ok=True)
            (cfg / "output_dir").write_text(str(_out))
        except Exception:
            pass


    try:
        # Warm the admin's core so the first request is not the one that pays
        # for loading a manifest. Everyone else's is built on demand.
        _initialize_admin_core()
        logger.info("API: Core services initialized successfully.")
        from shared.artwork_recovery import recovery
        recovery.start()

        # Note: Auto-start the downloader pump so queued items begin processing
        # immediately without waiting for a manual trigger from the frontend.
        # The pump stays alive as a watchdog — when the queue empties it sleeps
        # instead of exiting, so new items are always picked up.
        try:
            if queue_manager_dl.get_pending():
                start_downloader_pump()
                logger.info("API: Downloader pump started (pending items in queue).")
            else:
                start_downloader_pump()
                logger.info("API: Downloader pump started (watchdog mode).")
        except Exception:
            logger.debug("API: Downloader pump start skipped", exc_info=True)

        # Loudness measurement is background work: it waits for a quiet
        # instance, and it reads each file exactly once, ever.
        try:
            from shared.loudness import get_loudness_service

            get_loudness_service().start()
            logger.info("API: Loudness idle worker scheduled.")
        except Exception:
            logger.debug("API: Loudness idle worker start skipped", exc_info=True)

        # Plays that were queued for a scrobbling service and not sent yet —
        # the service was down, or the engine was stopped first — go out now.
        try:
            from shared.scrobble import get_scrobble_service

            get_scrobble_service().start()
        except Exception:
            logger.debug("API: Scrobble delivery start skipped", exc_info=True)

        from shared.dj.store import start_analysis_process
        # Measurements never run in this process: see shared/dj/worker.py.
        start_analysis_process()
        from shared.work import start_reaper
        start_reaper()

    except Exception as e:
        logger.exception("FATAL: Core initialization failed: %s", e)
        _startup_degraded_reason = f"{type(e).__name__}: {e}"

    # Note: Access summary
    logger.info("\n" + "="*40)
    logger.info("       SOUNDSIBLE ONLINE")
    logger.info("="*40)
    if runtime.host in {"127.0.0.1", "localhost"}:
        logger.info("Local:  http://127.0.0.1:%s/player/", runtime.port)
    else:
        logger.info("Local:  http://localhost:%s/player/", runtime.port)
        endpoints = active_endpoints()
        for ip in endpoints:
            logger.info("Remote: http://%s:%s/player/", ip, runtime.port)
    logger.info("="*40 + "\n")

    if on_ready is not None:
        try:
            on_ready(runtime)
        except Exception:
            logger.exception("API: readiness callback failed")

    try:
        import gevent  # noqa: F401  # imported to probe availability
        logger.info("API: gevent active — concurrent request handling enabled")
    except ImportError:
        logger.info("API: gevent not installed — single-threaded (long requests may block others)")
    logger.info("API: Starting SocketIO server on %s:%s...", runtime.host, runtime.port)

    from shared.daemon_launcher import MSG_KEEP_TERMINAL_OPEN
    _terminal_msg = MSG_KEEP_TERMINAL_OPEN
    logger.info("API: %s", _terminal_msg)
    sys.stdout.flush()
    sys.stderr.flush()
    _register_api_shutdown_handlers()
    # From here a loop that stops running ends the process, so the service
    # manager restarts a station that would otherwise stay unreachable.
    from shared.cooperative import start_loop_watchdog
    start_loop_watchdog()
    socketio.start_background_task(_recheck_sockets_forever)
    try:
        socketio.run(app, host=runtime.host, port=runtime.port, debug=debug)
    finally:
        stop_api()

if __name__ == '__main__':
    start_api()
