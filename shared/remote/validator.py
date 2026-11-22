"""Registry loading and argument validation for remote control commands."""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

from shared.url_utils import validate_youtube_video_id

_REGISTRY_PATH = Path(__file__).with_name("commands.json")

MAX_TRACK_BYTES = 32 * 1024
MAX_TRACKS_COUNT = 500
MAX_CONTEXT_BYTES = 4 * 1024
MAX_STATE_BYTES = 256 * 1024
MAX_STRING_LEN = 512
MAX_QUEUE_ID_LEN = 128

_TRACK_STRING_FIELDS = (
    "title",
    "artist",
    "album",
    "album_artist",
    "cover",
    "youtube_id",
    "media_kind",
    "podcast_episode_guid",
    "podcast_enclosure_url",
    "podcast_feed_id",
    "podcast_rss_url",
    "deezer_artist_id",
    "deezer_album_id",
    "canonical_identity",
    "source_title",
    "source_artist",
    "discovery_youtube_id",
    "playback_source_kind",
)
_TRACK_NUMERIC_FIELDS = ("duration", "track_number", "disc_number", "year")
_TRACK_LIST_FIELDS = ("originKeys", "artists")


@lru_cache(maxsize=1)
def load_registry() -> dict[str, Any]:
    """Load the command registry shared across engine, web and Android."""
    return json.loads(_REGISTRY_PATH.read_text(encoding="utf-8"))


def protocol_version() -> int:
    return int(load_registry()["protocol"])


def registered_commands() -> dict[str, dict[str, str]]:
    return load_registry()["commands"]


def _json_byte_length(value: Any) -> int:
    try:
        encoded = json.dumps(value, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError("Value must be valid JSON") from exc
    return len(encoded.encode("utf-8"))


def bound_track(value: Any) -> dict[str, Any]:
    """Bound a portable track descriptor. Only normal player resolvers may fetch audio."""
    if not isinstance(value, dict) or _json_byte_length(value) > MAX_TRACK_BYTES:
        raise ValueError("track must be an object of at most 32 KiB")
    track_id = value.get("id")
    if not isinstance(track_id, str) or not track_id.strip() or len(track_id) > MAX_STRING_LEN:
        raise ValueError("track.id required (at most 512 characters)")
    if value.get("source") not in (None, "local", "preview"):
        raise ValueError("Unsupported track source")
    # File paths, tokens, URLs resolved on the sender and queue/session ownership
    # never travel. Local metadata is read from the library instead.
    track: dict[str, Any] = {"id": track_id}
    for key in _TRACK_STRING_FIELDS:
        field = value.get(key)
        if field is not None:
            if not isinstance(field, str) or len(field) > 4096:
                raise ValueError(f"Invalid track.{key}")
            track[key] = field
    for key in _TRACK_NUMERIC_FIELDS:
        field = value.get(key)
        if field is not None:
            if isinstance(field, bool) or not isinstance(field, (int, float)) or not math.isfinite(field) or field < 0:
                raise ValueError(f"Invalid track.{key}")
            track[key] = field
    for key in _TRACK_LIST_FIELDS:
        field = value.get(key)
        if field is not None:
            if (
                not isinstance(field, list)
                or len(field) > 64
                or any(not isinstance(item, str) or len(item) > MAX_STRING_LEN for item in field)
            ):
                raise ValueError(f"Invalid track.{key}")
            track[key] = list(field)
    if isinstance(value.get("artist_is_channel"), bool):
        track["artist_is_channel"] = value["artist_is_channel"]
    if value.get("source") != "preview":
        return track
    track["source"] = "preview"
    if track.get("media_kind") == "podcast_episode" or track.get("podcast_episode_guid"):
        from shared.podcast_rss import assert_safe_http_url

        if not track.get("podcast_enclosure_url"):
            raise ValueError("Podcast enclosure URL required")
        assert_safe_http_url(track["podcast_enclosure_url"])
        track["media_kind"] = "podcast_episode"
    elif value.get("pendingResolve") is not None:
        pending = value["pendingResolve"]
        if not isinstance(pending, dict) or any(
            not isinstance(pending.get(key), str) or not pending[key].strip() or len(pending[key]) > limit
            for key, limit in (("catalogItemId", MAX_STRING_LEN), ("artist", 4096), ("title", 4096))
        ):
            raise ValueError("Invalid pending catalogue reference")
        track["pendingResolve"] = {key: pending[key] for key in ("catalogItemId", "artist", "title")}
        if "duration" in track:
            track["pendingResolve"]["duration"] = track["duration"]
    else:
        video_id = track.get("youtube_id") or track_id
        if not validate_youtube_video_id(video_id):
            raise ValueError("Invalid YouTube video id")
        # Both web and native preview resolvers use the playable id as the id.
        track["id"] = video_id
        track["youtube_id"] = video_id
    return track


def _validate_context(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or _json_byte_length(value) > MAX_CONTEXT_BYTES:
        raise ValueError("context must be an object of at most 4 KiB")
    cleaned: dict[str, Any] = {}
    for key in ("id", "kind", "label"):
        field = value.get(key)
        if not isinstance(field, str):
            raise ValueError(f"context.{key} must be a string")
        cleaned[key] = field
    for key in ("cover", "destination"):
        field = value.get(key)
        if field is not None:
            if not isinstance(field, str):
                raise ValueError(f"context.{key} must be a string")
            cleaned[key] = field
    return cleaned


def _validate_value(spec: str, value: Any) -> Any:
    if spec == "bool":
        if type(value) is not bool:
            raise ValueError("Expected bool")
        return value
    if spec == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("Expected finite number")
        return float(value)
    if spec == "int":
        if type(value) is not int:
            raise ValueError("Expected int")
        return value
    if spec == "string":
        if not isinstance(value, str) or len(value) > MAX_STRING_LEN:
            raise ValueError("Expected string (<= 512 chars)")
        return value
    if spec == "queue_id":
        if not isinstance(value, str) or not value.strip() or len(value) > MAX_QUEUE_ID_LEN:
            raise ValueError("Expected queue_id (non-empty string <= 128 chars)")
        return value
    if spec == "track":
        return bound_track(value)
    if spec == "tracks":
        if not isinstance(value, list) or not 1 <= len(value) <= MAX_TRACKS_COUNT:
            raise ValueError("Expected 1-500 track descriptors")
        return [bound_track(item) for item in value]
    if spec == "context":
        return _validate_context(value)
    if spec == "state":
        if not isinstance(value, dict) or _json_byte_length(value) > MAX_STATE_BYTES:
            raise ValueError("state must be an object of at most 256 KiB")
        return value
    if spec.startswith("enum:"):
        allowed = spec[5:].split("|")
        if not isinstance(value, str) or value not in allowed:
            raise ValueError(f"Expected one of {allowed}")
        return value
    raise ValueError(f"Unknown argument type {spec!r}")


def validate_command(
    name: Any,
    args: Any = None,
    *,
    allow_internal: bool = False,
) -> tuple[str, dict[str, Any]]:
    """Validate a command name and its arguments against commands.json."""
    if not isinstance(name, str):
        raise ValueError("Command name must be a string")
    commands = registered_commands()
    if name not in commands:
        raise ValueError(f"Unknown command {name!r}")
    if not allow_internal and name.startswith("session."):
        raise ValueError("session.* commands are internal to transfer")

    if args is None:
        raw_args: dict[str, Any] = {}
    elif isinstance(args, dict):
        raw_args = args
    else:
        raise ValueError("Command args must be an object")

    schema = commands[name]
    unknown = set(raw_args.keys()) - set(schema.keys())
    if unknown:
        raise ValueError(f"Unexpected arguments: {sorted(unknown)}")

    cleaned: dict[str, Any] = {}
    for arg_name, raw_spec in schema.items():
        optional = raw_spec.endswith("?")
        spec = raw_spec[:-1] if optional else raw_spec
        if arg_name not in raw_args or raw_args[arg_name] is None:
            if optional:
                if arg_name in raw_args:
                    cleaned[arg_name] = None
                continue
            raise ValueError(f"Missing required argument {arg_name!r}")
        cleaned[arg_name] = _validate_value(spec, raw_args[arg_name])

    if name == "transport.seek" and cleaned["position_sec"] < 0:
        raise ValueError("position_sec must be >= 0")
    if name == "transport.set_volume" and not 0.0 <= cleaned["level"] <= 1.0:
        raise ValueError("volume level must be between 0 and 1")
    if name == "play.tracks" and not 0 <= cleaned["index"] < len(cleaned["tracks"]):
        raise ValueError("index out of range for tracks")
    if name == "dj.remove_source" and not cleaned["source_id"].strip():
        raise ValueError("source_id must be non-empty")

    return name, cleaned
