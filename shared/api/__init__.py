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
import uuid
import logging
import time
from html import escape as html_escape
from datetime import datetime
from pathlib import Path
from flask import Flask, request, jsonify, send_file, send_from_directory, Response, stream_with_context, redirect, make_response
from flask_socketio import SocketIO, emit, join_room
from flask_cors import CORS

logger = logging.getLogger(__name__)
API_STARTED_AT = time.time()

from shared.models import PlayerConfig, Track, LibraryMetadata, StorageProvider
from shared.constants import LIBRARY_METADATA_FILENAME, STATION_PORT, DEFAULT_OUTPUT_DIR_FALLBACK, SourceType
from shared.path_resolver import resolve_local_track_path
from shared.app_config import set_output_dir as set_app_output_dir
from shared.runtime import (
    configure_runtime,
    ensure_runtime_directories,
    get_cache_dir,
    get_config_dir,
    get_music_dir,
    get_runtime_config,
    migrate_legacy_app_dirs,
    runtime_with_overrides,
    RuntimeConfig,
)
from shared.playback_state import (
    get_state as get_playback_state,
    put_state as put_playback_state,
    get_scope_from_request,
    register_device,
    mark_device_socket_active,
    unregister_socket,
)
from player.library import LibraryManager
from player.queue_manager import QueueManager
from player.favourites_manager import FavouritesManager
from odst_tool.odst_downloader import ODSTDownloader
from odst_tool.cloud_sync import CloudSync
from odst_tool.optimize_library import optimize_library
from setup_tool.uploader import UploadEngine
from setup_tool.provider_factory import StorageProviderFactory
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

import random
import socket
import requests
import hashlib
import tempfile
from typing import Optional, Any

from shared.url_utils import normalize_youtube_url, extract_youtube_video_id, validate_youtube_video_id
from shared.security import is_trusted_network, is_safe_path
from shared.hardening import SCOPE_PLAYBACK_CONTROL, apply_security_headers, get_request_auth_context
from shared.telemetry import init_telemetry
from shared.database import DatabaseManager

from .download_queue import DownloadQueueManager, LibraryFileWatcher, parse_intake_item
from .orchestrator import orchestrator


def get_active_endpoints():
    """Gather all network-accessible IPv4 addresses for this machine."""
    endpoints = []
    try:
        # Note: Standard socket-based discovery
        hostname = socket.gethostname()
        local_ip = socket.gethostbyname(hostname)
        if local_ip and not local_ip.startswith('127.'):
            endpoints.append(local_ip)
            
        # Note: More robust discovery using all interfaces
        import psutil
        for interface, addrs in psutil.net_if_addrs().items():
            # Note: Skip common bridge/virtual interfaces that aren't useful for mobile sync
            if any(skip in interface.lower() for skip in ['docker', 'br-', 'veth', 'lo']):
                continue
            for addr in addrs:
                if addr.family == socket.AF_INET:
                    ip = addr.address
                    if ip not in endpoints and not ip.startswith('127.'):
                        endpoints.append(ip)
    except Exception as e:
        logger.debug("get_active_endpoints: primary discovery failed, using fallback: %s", e)
        # Note: Fallback to A simple socket test if psutil fails or isn't installed
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip not in endpoints: endpoints.append(ip)
            s.close()
        except Exception:
            pass

    return endpoints

app = Flask(__name__)


def _build_cors_origins():
    raw = (os.getenv("SOUNDSIBLE_ALLOWED_ORIGINS") or "").strip()
    if raw:
        return [v.strip() for v in raw.split(",") if v.strip()]
    runtime = get_runtime_config()
    if not runtime.lan_enabled or runtime.host in {"127.0.0.1", "localhost"}:
        return [
            r"^https?://localhost(:\d+)?$",
            r"^https?://127\.0\.0\.1(:\d+)?$",
        ]
    # Default: allow browser clients coming from localhost, private LAN, and Tailscale.
    return [
        r"^https?://localhost(:\d+)?$",
        r"^https?://127\.0\.0\.1(:\d+)?$",
        r"^https?://192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$",
        r"^https?://10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$",
        r"^https?://172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}(:\d+)?$",
        r"^https?://100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(:\d+)?$",
    ]


_socket_cors = (os.getenv("SOUNDSIBLE_SOCKET_CORS_ORIGINS") or "").strip()
_socket_cors_origins = [v.strip() for v in _socket_cors.split(",") if v.strip()] if _socket_cors else "*"

CORS(
    app,
    origins=_build_cors_origins(),
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "X-Soundsible-Admin-Token",
        "X-Soundsible-Agent-Token",
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

socketio = SocketIO(
    app,
    cors_allowed_origins=_socket_cors_origins,
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


@socketio.on('playback_register')
def on_playback_register(data):
    """Register this socket for playback stop requests. Join room playback:{scope}:{device_id}."""
    device_id = (data or {}).get('device_id')
    if not device_id:
        return
    scope = get_scope_from_request()
    register_device(
        scope,
        device_id=device_id,
        device_name=(data or {}).get("device_name"),
        device_type=(data or {}).get("device_type") or "desktop",
    )
    room = f"playback:{scope}:{device_id}"
    join_room(room, sid=request.sid)
    mark_device_socket_active(scope, device_id, request.sid)


@socketio.on("connect")
def on_socket_connect(auth=None):
    runtime = get_runtime_config()
    remote_addr = request.remote_addr or ""
    if runtime.advanced_mode:
        return True
    if remote_addr in {"127.0.0.1", "::1"} and not runtime.lan_enabled:
        return True
    context = get_request_auth_context(allow_trusted_network=False)
    if context and (context.get("kind") == "owner" or SCOPE_PLAYBACK_CONTROL in set(context.get("scopes") or [])):
        return True
    logger.warning("Socket.IO connect denied for remote=%s origin=%s", remote_addr, request.headers.get("Origin"))
    return False


@socketio.on("disconnect")
def on_socket_disconnect():
    unregister_socket(request.sid)


# Note: Path to the new web UI and repo branding
from shared.bundle_paths import repo_root as _bundle_repo_root

_REPO_ROOT = os.path.abspath(str(_bundle_repo_root()))
WEB_UI_PATH = os.path.join(_REPO_ROOT, "ui_web")
WEB_UI_DIST_PATH = os.path.join(WEB_UI_PATH, "dist")
REPO_ROOT = _REPO_ROOT
BRANDING_PATH = os.path.join(REPO_ROOT, 'branding')


def _web_ui_root():
    """Serve configured Vite build path when present, else fall back to source UI."""
    runtime = get_runtime_config()
    if runtime.ui_dist and os.path.isfile(os.path.join(str(runtime.ui_dist), "index.html")):
        return str(runtime.ui_dist)
    if os.environ.get("SOUNDSIBLE_WEB_UI_DIST", "").lower() in ("1", "true", "yes"):
        if os.path.isfile(os.path.join(WEB_UI_DIST_PATH, "index.html")):
            return WEB_UI_DIST_PATH
    return WEB_UI_PATH


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
    root = _web_ui_root()
    path = os.path.join(root, filename)
    if not inject_owner_token:
        return send_from_directory(root, filename)
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

@app.route('/player/desktop')
def serve_web_player_desktop_redirect():
    return redirect('/player/desktop/', code=308)


@app.route('/player/desktop/')
def serve_web_player_desktop():
    return make_response(_render_web_ui_html('desktop.html', inject_owner_token=True))

@app.route('/player/branding/<path:path>')
def serve_branding(path):
    return send_from_directory(BRANDING_PATH, path)

@app.route('/player/<path:path>')
def serve_web_player_assets(path):
    resp = send_from_directory(_web_ui_root(), path)
    lp = path.lower()
    if lp.endswith(".html"):
        resp.headers.setdefault("Cache-Control", "no-store")
    elif "assets/" in lp and lp.split("?")[0].endswith((".js", ".css", ".woff", ".woff2", ".ttf", ".map")):
        resp.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    return resp

# Note: Global instances
library_manager = None
playback_engine = None
queue_manager = None
favourites_manager = None
downloader_service = None
_downloader_lock = threading.Lock()  # Note: Prevent concurrent init when many discover/resolve requests hit at once
queue_manager_dl = DownloadQueueManager(socketio=socketio)
api_observer = None  # Note: Store observer reference for cleanup in daemon mode
_api_shutdown_lock = threading.Lock()
_api_shutdown_done = False

def get_core():
    global library_manager, playback_engine, queue_manager, favourites_manager
    if not library_manager:
        logger.info("API: Initializing Library Manager...")
        library_manager = LibraryManager()
        # Note: Ensure we have metadata loaded from local cache at minimum
        if not library_manager.metadata:
            logger.info("API: No metadata in memory, checking cache...")
            cache_path = get_config_dir() / LIBRARY_METADATA_FILENAME
            library_manager._load_from_cache(cache_path)
            # Note: If cache looks like it's from a different path (e.g. old install), don't use it
            if library_manager.metadata and library_manager._is_cache_likely_stale():
                logger.info("API: Cached library does not match current music path; starting fresh.")
                library_manager.metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
                library_manager._save_metadata()

        logger.info("API: Initializing Queue, Playback Engine and Favourites...")
        queue_manager = QueueManager()
        favourites_manager = FavouritesManager()
        # Note: API server runs headless; web player uses browser for playback. skip MPV to avoid blocking on display/audio.
        playback_engine = None
    return library_manager, playback_engine, queue_manager

def get_downloader(output_dir=None, open_browser=False, log_callback=None):
    global downloader_service

    def _log(msg):
        logger.info("API: %s", msg)
        if log_callback:
            log_callback(msg)

    # Note: Load env once (used for quality/cookie_browser below)
    from dotenv import dotenv_values
    _env_path = Path(_REPO_ROOT) / "odst_tool" / ".env"
    env_vars = dotenv_values(_env_path) if _env_path.exists() else {}

    # Note: 1. Determine the target output directory (prefer app_config set at startup)
    from shared.app_config import get_output_dir
    _app_out = get_output_dir()
    if output_dir:
        target_path = Path(output_dir).expanduser().absolute()
    elif _app_out is not None:
        target_path = _app_out
    else:
        target_dir = env_vars.get("OUTPUT_DIR") or os.getenv("OUTPUT_DIR") or DEFAULT_OUTPUT_DIR_FALLBACK
        target_path = Path(target_dir).expanduser().absolute()

    with _downloader_lock:
        should_init = False
        if not downloader_service:
            should_init = True
        elif downloader_service.output_dir != target_path:
            _log(f"Path changed to {target_path}. Re-initializing...")
            should_init = True

        if should_init:
            _log("Downloader: Entering setup...")
            _log(f"Step 1/3: Accessing storage at {target_path}...")
            try:
                target_path.mkdir(parents=True, exist_ok=True)
                _log("Step 1.1: Path is accessible.")
            except Exception as e:
                _log(f"⚠️ Step 1 Warning: NAS/Path issue: {e}")

            _log("Step 2/3: Loading Soundsible core...")
            lib_core, _, _ = get_core()

            _log("Step 3/3: Starting Engine...")
            quality = env_vars.get("DEFAULT_QUALITY", lib_core.config.quality_preference if lib_core.config else "high")
            from odst_tool.config import DEFAULT_WORKERS
            cookie_browser = env_vars.get("COOKIE_BROWSER") or os.getenv("COOKIE_BROWSER")
            cookie_file = (
                env_vars.get("SOUNDSIBLE_YTDLP_COOKIE_FILE")
                or env_vars.get("YTDLP_COOKIE_FILE")
                or env_vars.get("COOKIE_FILE")
                or os.getenv("SOUNDSIBLE_YTDLP_COOKIE_FILE")
                or os.getenv("YTDLP_COOKIE_FILE")
                or os.getenv("COOKIE_FILE")
            )
            _log(f"Initializing Downloader (Quality: {quality})...")
            downloader_service = ODSTDownloader(
                target_path,
                DEFAULT_WORKERS,
                cookie_browser=cookie_browser,
                cookie_file=cookie_file,
                quality=quality,
            )
            _log("✅ Downloader Engine Ready.")

    return downloader_service


def _youtube_metadata_artist_usable(artist: Optional[Any]) -> bool:
    """Flat YouTube Music search entries omit channel/uploader; empty artist must not block a peek fill."""
    if artist is None:
        return False
    s = str(artist).strip()
    if not s:
        return False
    if s.lower() in ("unknown", "unknown artist"):
        return False
    return True


def _youtube_metadata_title_usable(title: Optional[Any], song_str: str) -> bool:
    """Reject URLs and placeholders so we do not embed them as track titles."""
    if title is None:
        return False
    t = str(title).strip()
    if not t:
        return False
    s = str(song_str or "").strip()
    if t == s:
        return False
    tl = t.lower()
    if "youtube.com" in tl or "youtu.be" in tl:
        return False
    if tl.startswith("http://") or tl.startswith("https://"):
        return False
    return True


def _fill_youtube_runtime_hint(dl, song_str: str, item: dict, metadata_evidence: dict) -> dict:
    """Build metadata_hint for process_video; never prefer raw URLs over yt-dlp/peek titles.

    YouTube Music text search uses yt-dlp with extract_flat on music.youtube.com results; those
    entries often have title but no channel/uploader/artist (see youtube_downloader.search_youtube).
    A usable title from search then skipped peek_brief previously, so artist stayed empty and
    tags fell through to Unknown Artist. We call peek_brief when title or artist is still unusable.
    """
    runtime_hint = dict(metadata_evidence or {})
    if not _youtube_metadata_title_usable(runtime_hint.get("title"), song_str):
        runtime_hint.pop("title", None)

    if item.get("duration_sec") is not None:
        runtime_hint.setdefault("duration_sec", item["duration_sec"])

    dt = item.get("display_title")
    if _youtube_metadata_title_usable(dt, song_str):
        runtime_hint.setdefault("title", str(dt).strip())

    da = item.get("display_artist")
    if da and str(da).strip():
        dls = str(da).strip().lower()
        if dls not in ("unknown", "unknown artist", "resolving…", "resolving..."):
            runtime_hint.setdefault("artist", str(da).strip())

    need_peek = (
        not _youtube_metadata_title_usable(runtime_hint.get("title"), song_str)
        or not _youtube_metadata_artist_usable(runtime_hint.get("artist"))
    )
    brief = None
    if need_peek:
        try:
            brief = dl.downloader.peek_brief(song_str)
        except Exception as ex:
            logger.debug("peek_brief for queue item failed: %s", ex)

    if brief:
        if not _youtube_metadata_title_usable(runtime_hint.get("title"), song_str):
            bt = str(brief.get("title") or "").strip()
            if _youtube_metadata_title_usable(bt, song_str):
                runtime_hint["title"] = bt
        if not _youtube_metadata_artist_usable(runtime_hint.get("artist")):
            ch = brief.get("artist") or brief.get("channel") or ""
            if ch and str(ch).strip():
                runtime_hint["artist"] = str(ch).strip()
        if brief.get("duration") and not runtime_hint.get("duration_sec"):
            try:
                runtime_hint["duration_sec"] = int(brief["duration"])
            except (TypeError, ValueError):
                pass

    if not _youtube_metadata_title_usable(runtime_hint.get("title"), song_str):
        runtime_hint.pop("title", None)
    return runtime_hint


def _process_single_queue_item(item):
    """Worker function for A single download queue item."""
    global downloader_service, queue_manager_dl
    item_id = item['id']
    song_str = item.get('song_str')
    output_dir = item.get('output_dir')
    source_type = item.get('source_type') or 'manual'
    metadata_evidence = item.get('metadata_evidence') if isinstance(item.get('metadata_evidence'), dict) else {}

    queue_manager_dl.add_log(f"Preparing: {song_str or item_id}...")
    queue_manager_dl.update_status(item_id, 'downloading')
    with app.app_context():
        socketio.emit('downloader_update', {'id': item_id, 'status': 'downloading'})

    try:
        dl = get_downloader(output_dir, log_callback=queue_manager_dl.add_log)
        queue_manager_dl.add_log(f"Processing: {song_str or item_id}...")

        track = None
        st = (source_type or "").strip()
        if st == SourceType.PODCAST_ENCLOSURE or st == "podcast_enclosure":
            enclosure_url = (item.get("enclosure_url") or song_str or "").strip()
            if not enclosure_url:
                raise Exception("Missing podcast enclosure URL")
            lib_early, _, _ = get_core()
            fid = (item.get("podcast_feed_id") or "").strip()
            eg = (item.get("episode_guid") or "").strip()
            if lib_early.metadata and fid and eg:
                for t in lib_early.metadata.tracks:
                    if (getattr(t, "podcast_feed_id", None) or "") == fid and (
                        getattr(t, "podcast_episode_guid", None) or ""
                    ) == eg:
                        td = t.to_dict()
                        td.pop("local_path", None)
                        queue_manager_dl.update_status(item_id, "completed")
                        with app.app_context():
                            queue_manager_dl.remove_item(item_id)
                            socketio.emit(
                                "downloader_update",
                                {"id": item_id, "status": "completed", "track": td, "duplicate": True},
                            )
                        queue_manager_dl.add_log(f"Already in library: {t.title}")
                        return
            from shared.podcast_rss import assert_safe_http_url

            assert_safe_http_url(enclosure_url)
            queue_manager_dl.add_log(f"Downloading podcast enclosure...")
            _max_bytes = 600 * 1024 * 1024
            headers = {"User-Agent": "SoundsiblePodcast/1.0"}
            r = requests.get(enclosure_url, stream=True, timeout=(15, 600), headers=headers, allow_redirects=True)
            r.raise_for_status()
            ctype = (r.headers.get("Content-Type") or "").lower()
            if not (
                ctype.startswith("audio/")
                or "mpeg" in ctype
                or "mp3" in ctype
                or "mp4" in ctype
                or "octet-stream" in ctype
                or ctype.startswith("binary/")
            ):
                raise Exception(f"Unexpected content type: {ctype or 'unknown'}")
            suf = ".mp3"
            if "mp4" in ctype or "m4a" in ctype or "aac" in ctype:
                suf = ".m4a"
            elif "ogg" in ctype or "opus" in ctype:
                suf = ".ogg"
            total = 0
            tmp_path = None
            try:
                with tempfile.NamedTemporaryFile(delete=False, suffix=suf) as tmp:
                    tmp_path = tmp.name
                    for chunk in r.iter_content(chunk_size=65536):
                        if not chunk:
                            continue
                        total += len(chunk)
                        if total > _max_bytes:
                            raise Exception("Episode file too large")
                        tmp.write(chunk)
                p = Path(tmp_path)
                clean_meta = {
                    "title": (item.get("podcast_title") or "Episode").strip(),
                    "artist": (item.get("podcast_show_title") or "Podcast").strip(),
                    "album": (item.get("podcast_album") or item.get("podcast_show_title") or "Podcasts").strip(),
                    "duration_sec": int(item.get("duration_sec") or 0),
                    "track_number": 1,
                    "media_kind": "podcast_episode",
                    "podcast_feed_id": fid or None,
                    "podcast_episode_guid": eg or None,
                    "podcast_rss_url": (item.get("podcast_rss_url") or "").strip() or None,
                    "genre": "Podcast",
                }
                cover = (item.get("thumbnail_url") or "").strip() or None
                track = dl.downloader.finalize_local_audio_file(
                    p,
                    clean_meta,
                    cover_art_url=cover,
                    cover_source="podcast" if cover else "none",
                )
            finally:
                if tmp_path and track is None:
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass
        elif song_str:
            if source_type in {"youtube_url", "ytmusic_search", "youtube_search"} or "youtube.com" in song_str or "youtu.be" in song_str:
                song_str = normalize_youtube_url(song_str)
                queue_manager_dl.add_log(f"Downloading direct YouTube: {song_str}...")
                runtime_hint = _fill_youtube_runtime_hint(dl, song_str, item, metadata_evidence)

                def _on_progress(payload):
                    if not isinstance(payload, dict):
                        return
                    kwargs = {}
                    if payload.get("percent") is not None:
                        kwargs["percent"] = float(payload["percent"])
                    if payload.get("speed") is not None:
                        kwargs["speed"] = payload["speed"]
                    if payload.get("eta") is not None:
                        kwargs["eta"] = payload["eta"]
                    if payload.get("phase") is not None:
                        kwargs["phase"] = payload["phase"]
                    if payload.get("total_bytes") is not None:
                        kwargs["total_bytes"] = payload["total_bytes"]
                    if kwargs:
                        queue_manager_dl.update_progress(item_id, **kwargs)

                track = dl.downloader.process_video(
                    song_str,
                    metadata_hint=runtime_hint,
                    source=source_type,
                    progress_callback=_on_progress,
                )
            else:
                fake_meta = {
                    'title': song_str,
                    'artist': 'Unknown',
                    'album': 'Manual',
                    'duration_sec': 0,
                    'id': f"manual_{uuid.uuid4().hex[:8]}",
                }
                if metadata_evidence:
                    fake_meta.update({k: v for k, v in metadata_evidence.items() if v is not None})
                track = dl.downloader.process_track(fake_meta, source="manual")

        if track:
            # Note: Update ODST internal record (replace by hash if already present)
            existing = dl.library.get_track_by_hash(track.file_hash)
            if existing:
                dl.library.remove_track(existing.id)
            dl.add_track(track)
            dl.save_library()

            # Note: Pre-cache cover so first request serves it
            track_dict = track.to_dict()
            track_dict.pop("local_path", None)
            shared_track = Track.from_dict(track_dict)
            
            local_track_path = resolve_local_track_path(shared_track)
            covers_dir = os.path.join(str(get_cache_dir()), "covers")
            os.makedirs(covers_dir, exist_ok=True)
            cover_path = os.path.join(covers_dir, f"{shared_track.id}.jpg")
            if not os.path.exists(cover_path):
                try:
                    from setup_tool.audio import AudioProcessor
                    cover_data = AudioProcessor.extract_cover_art(local_track_path) if local_track_path else None
                    if cover_data:
                        with open(cover_path, 'wb') as f:
                            f.write(cover_data)
                except Exception as e:
                    logger.warning("API: Pre-cache cover failed: %s", e)

            # Note: Sync to main soundsible core
            _sync_odst_to_main_core()
            
            with app.app_context():
                queue_manager_dl.remove_item(item_id)
                socketio.emit('downloader_update', {'id': item_id, 'status': 'completed', 'track': track_dict})
            queue_manager_dl.add_log(f"✅ Finished: {track.artist} - {track.title}")
        else:
            raise Exception("Downloader returned no track. Check logs for details.")

    except Exception as e:
        logger.warning("API Downloader Error: %s", e)
        queue_manager_dl.update_status(item_id, 'failed', error=str(e))
        with app.app_context():
            socketio.emit('downloader_update', {'id': item_id, 'status': 'failed', 'error': str(e)})
        queue_manager_dl.add_log(f"❌ Failed: {song_str or item_id} - {e}")


def process_queue_background(stop_event: Optional[threading.Event] = None):
    """
    Downloader pump. Submits pending queue items to the orchestrator's
    background pool and sleeps between checks. Owned by JobOrchestrator
    (see start_downloader_pump) — do not start via raw threading.Thread.

    Exits early when `stop_event` is set, ensuring shutdown releases the
    `is_processing` flag.
    """
    global downloader_service, queue_manager_dl
    if queue_manager_dl.is_processing:
        return

    queue_manager_dl.is_processing = True
    queue_manager_dl.add_log("Station Engine: Background orchestrator active.")

    def _stopped() -> bool:
        return stop_event is not None and stop_event.is_set()

    try:
        while True:
            if _stopped():
                queue_manager_dl.add_log("Station Engine: Pump stop requested; exiting.")
                break

            # Note: Only count jobs that start with "dl_"
            active_ids = [jid for jid in orchestrator.active_jobs if jid.startswith("dl_")]

            pending = queue_manager_dl.get_pending()
            # Note: Filter out those already being processed
            pending = [p for p in pending if f"dl_{p['id']}" not in active_ids]

            if not pending and not active_ids:
                queue_manager_dl.add_log("Station Engine: All tasks complete.")
                break

            # Note: Fill slots if we have capacity (max 3 concurrent downloads by default)
            # The effective concurrency can be tuned via the JobOrchestrator max_workers if needed.
            capacity = max(0, 3 - len(active_ids))
            if capacity > 0 and pending:
                for i in range(min(capacity, len(pending))):
                    item = pending[i]
                    orchestrator.submit_task(f"dl_{item['id']}", _process_single_queue_item, item)
                continue # Re-check immediately

            # Interruptible sleep — stop_event short-circuits the wait.
            if stop_event is not None:
                if stop_event.wait(timeout=1):
                    continue
            else:
                time.sleep(1)

    except Exception as e:
        logger.error("CRITICAL: Downloader background thread crashed: %s", e)
        import traceback
        traceback.print_exc()
    finally:
        queue_manager_dl.is_processing = False


def start_downloader_pump() -> bool:
    """Module-level entrypoint: route the pump through the orchestrator (plan 5A)."""
    return orchestrator.start_downloader_pump(process_queue_background)


# Note: Helpers (used by blueprints)
def get_track_by_id(lib, track_id: str) -> Optional[Track]:
    """Resolve track by ID: metadata first, then DB fallback. Single place for consistency."""
    if lib.metadata:
        track = lib.metadata.get_track_by_id(track_id)
        if track:
            return track
    if lib.db:
        return lib.db.get_track(track_id)
    return None


def _mirror_track_into_odst_downloader(track: Track) -> None:
    """
    Keep ODSTDownloader.library in sync with the main manifest.
    Otherwise the next dl.save_library() overwrites library.json with stale titles/artists.
    """
    try:
        dl = get_downloader(open_browser=False)
    except Exception:
        return
    if not dl or not dl.library:
        return
    other = dl.library.get_track_by_id(track.id)
    if not other:
        return
    other.title = track.title
    other.artist = track.artist
    other.album = track.album
    other.album_artist = track.album_artist
    other.duration = track.duration
    other.original_filename = track.original_filename
    other.year = track.year
    other.track_number = track.track_number
    other.cover_source = track.cover_source
    other.metadata_modified_by_user = track.metadata_modified_by_user
    other.file_hash = track.file_hash
    other.file_size = track.file_size
    other.bitrate = track.bitrate
    other.format = track.format
    other.media_kind = getattr(track, "media_kind", None)
    other.podcast_feed_id = getattr(track, "podcast_feed_id", None)
    other.podcast_episode_guid = getattr(track, "podcast_episode_guid", None)
    other.podcast_rss_url = getattr(track, "podcast_rss_url", None)


def _mark_track_metadata_updated(lib, track_id: str, cover_source: Optional[str] = None) -> bool:
    """Set track metadata flags, save, and emit library_updated. Returns True if track was found."""
    track = get_track_by_id(lib, track_id)
    if not track:
        return False
    if cover_source is not None:
        track.cover_source = cover_source
    track.metadata_modified_by_user = True
    lib._save_metadata()
    _mirror_track_into_odst_downloader(track)
    socketio.emit('library_updated')
    return True


def _ensure_lib_metadata():
    """Ensure library and metadata are loaded; return (lib, metadata) or (None, None)."""
    lib, _, _ = get_core()
    if not lib.metadata:
        lib.sync_library()
    return lib, lib.metadata if lib else None


# Note: Discover / downloader background helpers (used by downloader blueprint)
_resolve_executor = None

def _get_resolve_executor():
    global _resolve_executor
    if _resolve_executor is None:
        from concurrent.futures import ThreadPoolExecutor
        _resolve_executor = ThreadPoolExecutor(max_workers=8)
    return _resolve_executor


def _warm_downloader():
    try:
        get_downloader(open_browser=False)
    except Exception:
        pass


def _sync_odst_to_main_core():
    """Helper to sync ODST library metadata back to the main Soundsible core."""
    dl = get_downloader()
    lib, _, _ = get_core()
    
    # Note: Ensure main library is loaded
    cache_path = get_config_dir() / LIBRARY_METADATA_FILENAME
    if not lib.metadata and cache_path.exists():
        lib._load_from_cache(cache_path)
    if not lib.metadata:
        lib.metadata = LibraryMetadata(version=1, tracks=[], playlists={}, settings={})
    
    # Note: Merge all tracks from ODST to core
    changed = False
    for track in dl.library.tracks:
        if not lib.metadata.get_track_by_id(track.id):
            track_dict = track.to_dict()
            track_dict.pop("local_path", None)
            shared_track = Track.from_dict(track_dict)
            lib.metadata.add_track(shared_track)
            changed = True
            
    if changed:
        def _emit_updated():
            with app.app_context():
                socketio.emit('library_updated')
        orchestrator.schedule_metadata_commit(lib._save_metadata, _emit_updated)


def run_optimization_task(dry_run):
    def _task():
        try:
            dl = get_downloader(log_callback=queue_manager_dl.add_log)
            mode = "DRY RUN" if dry_run else "LIVE"
            queue_manager_dl.add_log(f"--- Starting Library Optimization ({mode}) ---")
            def cb(msg): queue_manager_dl.add_log(f"🔧 {msg}")
            
            optimize_library(
                dl.output_dir, 
                dry_run=dry_run, 
                progress_callback=cb,
                library=dl.library,
                save_callback=dl.save_library
            )
            
            if not dry_run:
                _sync_odst_to_main_core()
                
            queue_manager_dl.add_log("--- Optimization Finished ---")
        except Exception as e:
            queue_manager_dl.add_log(f"❌ Optimization Error: {e}")
            
    orchestrator.submit_task("optimization", _task)


def run_sync_task():
    def _task():
        try:
            dl = get_downloader(log_callback=queue_manager_dl.add_log)
            if not dl.cloud.is_configured():
                queue_manager_dl.add_log("❌ Cloud Sync not configured. Add R2/S3 keys in Settings.")
                return
            queue_manager_dl.add_log("--- Starting Cloud Sync ---")
            def cb(msg): queue_manager_dl.add_log(f"☁️ {msg}")
            
            # Note: Refresh library from disk before sync to ensure we have latest local changes
            dl.library = dl._load_library()
            result = dl.cloud.sync_library(dl.library, progress_callback=cb)
            
            if 'error' in result:
                queue_manager_dl.add_log(f"❌ Sync Error: {result['error']}")
            else:
                synced_library = result.get("synced_library")
                if isinstance(synced_library, LibraryMetadata):
                    dl.library = synced_library
                    dl.save_library()

                queue_manager_dl.add_log("✅ Sync Complete!")
                queue_manager_dl.add_log(f"   Uploaded: {result.get('uploaded', 0)}, Merged: {result.get('merged', 0)}")
                queue_manager_dl.add_log(f"   Total Remote: {result.get('total_remote', 0)}")
                _sync_odst_to_main_core()
        except Exception as e:
            queue_manager_dl.add_log(f"❌ Critical Sync Error: {e}")
            import traceback
            traceback.print_exc()

    orchestrator.submit_task("sync", _task)


# Note: Blueprints details
from shared.api.routes.library import library_bp
from shared.api.routes.playback import playback_bp
from shared.api.routes.downloader import downloader_bp
from shared.api.routes.config import config_bp
from shared.api.routes.discovery import discovery_bp
from shared.api.routes.podcasts import podcasts_bp
from shared.api.routes.agent import agent_bp
from shared.api.routes.pairing import pairing_bp
from shared.api.routes.setup import setup_bp
from shared.api.routes.migration import migration_bp
from shared.api.routes.car import car_bp
app.register_blueprint(library_bp)
app.register_blueprint(playback_bp)
app.register_blueprint(downloader_bp)
app.register_blueprint(config_bp)
app.register_blueprint(discovery_bp)
app.register_blueprint(podcasts_bp)
app.register_blueprint(agent_bp)
app.register_blueprint(pairing_bp)
app.register_blueprint(setup_bp)
app.register_blueprint(migration_bp)
app.register_blueprint(car_bp)


@app.route('/api/health')
def health_check():
    runtime = get_runtime_config()
    stats = {"tracks": 0, "local": 0, "cloud": 0}
    config_exists = False
    try:
        stats = DatabaseManager().get_stats()
    except Exception:
        logger.debug("Health: failed to collect library stats", exc_info=True)
    try:
        config_exists = (runtime.config_dir / "config.json").exists()
    except Exception:
        pass
    from shared.ffmpeg_runtime import ffmpeg_status

    return jsonify(
        {
            "status": "healthy",
            "version": os.getenv("SOUNDSIBLE_VERSION", "0.0.0-dev"),
            "ffmpeg": ffmpeg_status(),
            "pid": os.getpid(),
            "uptime_seconds": round(time.time() - API_STARTED_AT, 3),
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
            "library": stats,
            "jobs": {
                "active_count": len(orchestrator.active_jobs),
                "active_ids": sorted(orchestrator.active_jobs.keys()),
                "pending_metadata_commit": orchestrator.pending_commits,
            },
        }
    )

@app.route('/')
def home():
    return jsonify({
        "status": "online",
        "service": "Soundsible Core API",
        "version": "1.0.0"
    })

# Note: Server management

def _resolve_output_dir():
    """Resolve OUTPUT_DIR once at startup (only place that may read odst_tool/.env)."""
    target = os.getenv("OUTPUT_DIR")
    if not target:
        try:
            from dotenv import dotenv_values
            _env_path = Path(_REPO_ROOT) / "odst_tool" / ".env"
            _env = dotenv_values(_env_path) if _env_path.exists() else {}
            target = _env.get("OUTPUT_DIR")
        except Exception:
            pass
    if not target:
        try:
            from odst_tool.config import DEFAULT_OUTPUT_DIR
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
            observer.join(timeout=2)
        except Exception:
            logger.exception("API: Error stopping library file watcher")

    try:
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
    """Register SIGINT/SIGTERM handlers compatible with gevent's event loop."""
    try:
        from gevent import signal as gevent_signal

        gevent_signal.signal(signal.SIGINT, _stop_wsgi_from_signal)
        gevent_signal.signal(signal.SIGTERM, _stop_wsgi_from_signal)
    except Exception:
        signal.signal(signal.SIGINT, _stop_wsgi_from_signal)
        signal.signal(signal.SIGTERM, _stop_wsgi_from_signal)


def start_api(
    port=STATION_PORT,
    *,
    host: Optional[str] = None,
    debug: bool = False,
    runtime_config: Optional[RuntimeConfig] = None,
    on_ready: Optional[Any] = None,
):
    global api_observer
    runtime = runtime_config or get_runtime_config()
    runtime = runtime_with_overrides(base=runtime, host=host, port=port)
    configure_runtime(runtime)
    migrate_legacy_app_dirs(runtime)
    ensure_runtime_directories(runtime)
    init_telemetry(runtime)
    logger.info("--- Soundsible API Boot Sequence ---")
    logger.info("Target Host: %s", runtime.host)
    logger.info("Target Port: %s", runtime.port)
    logger.info("CWD: %s", os.getcwd())
    logger.info("For full startup (sync + watcher) use: python run.py --daemon")

    # Note: Set app config so path_resolver and security do not depend on odst_tool layout
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

    _defer_ytdlp_thread = False
    _run_ytdlp_update = None

    try:
        lib, _, _ = get_core()
        logger.info("API: Core services initialized successfully.")
        
        # Note: Optional auto-update yt-dlp in background if user enabled it (thread started after terminal message)
        try:
            from dotenv import dotenv_values
            # Note: Always resolve the .env path from the repo root so auto-update works regardless of CWD.
            _env_path = Path(_REPO_ROOT) / "odst_tool" / ".env"
            _env = dotenv_values(_env_path) if _env_path.exists() else {}
            _raw_auto = (_env.get("YTDLP_AUTO_UPDATE", os.getenv("YTDLP_AUTO_UPDATE", "false")) or "false").strip()
            _auto = _raw_auto.lower() in ("true", "1")
            logger.info(
                "API: yt-dlp auto-update config resolved (env_file=%s, exists=%s, raw=%r, enabled=%s)",
                _env_path,
                _env_path.exists(),
                _raw_auto,
                _auto,
            )
            if _auto:
                logger.info("API: yt-dlp auto-update requested (YTDLP_AUTO_UPDATE=true). Will run in background after startup banner.")
                def _run_ytdlp_update():
                    import subprocess
                    pip_cmd = None
                    try:
                        root = Path(_REPO_ROOT)
                        if os.name == "nt":
                            pip_exe = root / "venv" / "Scripts" / "pip.exe"
                        else:
                            pip_exe = root / "venv" / "bin" / "pip"
                        if pip_exe.exists():
                            pip_cmd = [str(pip_exe), "install", "-U", "yt-dlp"]
                    except Exception:
                        pass
                    if not pip_cmd:
                        pip_cmd = [sys.executable, "-m", "pip", "install", "-U", "yt-dlp"]
                    try:
                        logger.info("API: Updating yt-dlp (auto-update enabled)...")
                        logger.info("API: Starting yt-dlp auto-update via pip: %s", " ".join(pip_cmd))
                        result = subprocess.run(
                            pip_cmd,
                            capture_output=True,
                            text=True,
                            timeout=120,
                        )
                        if result.returncode == 0:
                            logger.info("API: yt-dlp auto-update completed successfully.")
                            if result.stdout:
                                logger.info("API: yt-dlp auto-update stdout (first 400 chars): %s", result.stdout[:400])
                        else:
                            logger.warning("API: yt-dlp auto-update failed: %s", result.stderr or result.stdout or 'unknown')
                    except Exception as e:
                        logger.warning("API: yt-dlp auto-update error: %s", e)
                _defer_ytdlp_thread = True
            else:
                logger.info("API: yt-dlp auto-update disabled. Skipping update attempt.")
        except Exception:
            logger.debug("API: yt-dlp auto-update setup skipped due to error", exc_info=True)

        # Note: Start library file watcher
        config_dir = get_config_dir()
        config_dir.mkdir(parents=True, exist_ok=True)

        event_handler = LibraryFileWatcher(lib, socketio)
        api_observer = Observer()
        api_observer.schedule(event_handler, str(config_dir), recursive=False)
        api_observer.start()
        logger.info("API: Library File Watcher started on %s", config_dir)

    except Exception as e:
        logger.error("FATAL: Core initialization failed: %s", e)
        import traceback
        traceback.print_exc()

    # Note: Access summary
    logger.info("\n" + "="*40)
    logger.info("       SOUNDSIBLE ONLINE")
    logger.info("="*40)
    if runtime.host in {"127.0.0.1", "localhost"}:
        logger.info("Local:  http://127.0.0.1:%s/player/", runtime.port)
    else:
        logger.info("Local:  http://localhost:%s/player/", runtime.port)
        endpoints = get_active_endpoints()
        for ip in endpoints:
            logger.info("Remote: http://%s:%s/player/", ip, runtime.port)
    logger.info("="*40 + "\n")

    if on_ready is not None:
        try:
            on_ready(runtime)
        except Exception:
            logger.exception("API: readiness callback failed")

    try:
        import gevent
        logger.info("API: gevent active — concurrent request handling enabled")
    except ImportError:
        logger.info("API: gevent not installed — single-threaded (long requests may block others)")
    logger.info("API: Starting SocketIO server on %s:%s...", runtime.host, runtime.port)

    from shared.daemon_launcher import MSG_KEEP_TERMINAL_OPEN
    _terminal_msg = MSG_KEEP_TERMINAL_OPEN
    logger.info("API: %s", _terminal_msg)
    if _defer_ytdlp_thread and _run_ytdlp_update:
        # Route through orchestrator so the update is visible in /api/health
        # active_jobs and queues behind other disk-heavy work on HDD (plan T3).
        orchestrator.submit_background("ytdlp_update", _run_ytdlp_update)
    sys.stdout.flush()
    sys.stderr.flush()
    _register_api_shutdown_handlers()
    try:
        socketio.run(app, host=runtime.host, port=runtime.port, debug=debug)
    finally:
        stop_api()

if __name__ == '__main__':
    start_api()
