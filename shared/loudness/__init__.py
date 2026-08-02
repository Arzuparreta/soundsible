"""Automatic volume levelling: measure on the engine, apply gain in the player.

The engine never touches the audio it serves. It measures each file once with
an EBU R128 meter and publishes two numbers — integrated loudness and true peak
— alongside the track. The player turns those into one gain per deck. That
split is what keeps `stream_local_track` a plain `send_file` with working range
requests, and what keeps the cost of levelling a track at one `AudioParam`
write.
"""

from __future__ import annotations

import logging
from typing import Any

from .measure import (
    LOUDNESS_VERSION,
    LoudnessMeasurement,
    MeasurementError,
    measure_loudness,
    parse_ebur128_summary,
)
from .store import LoudnessStore, identity_for, source_stamp

logger = logging.getLogger(__name__)

__all__ = [
    "LOUDNESS_VERSION",
    "LoudnessMeasurement",
    "LoudnessStore",
    "MeasurementError",
    "annotate_tracks",
    "get_loudness_service",
    "identity_for",
    "measure_loudness",
    "parse_ebur128_summary",
    "source_stamp",
    "stop_loudness_service_if_started",
]


def annotate_tracks(tracks: list[dict[str, Any]]) -> None:
    """Attach loudness to serialized tracks, in place.

    One query for the whole table, then a dict lookup per track. Deliberately
    silent on failure: levelling is an enhancement, and a cache that cannot be
    read must cost the listener their volume knob, never their library.
    """
    if not tracks:
        return
    try:
        measured = LoudnessStore().measured()
    except Exception:
        logger.debug("Loudness: could not read measurements for annotation", exc_info=True)
        return
    if not measured:
        return
    for track in tracks:
        if not isinstance(track, dict):
            continue
        found = measured.get(str(track.get("file_hash") or track.get("id") or ""))
        if found is None:
            continue
        lufs, peak = found
        track["loudness_lufs"] = round(lufs, 2)
        track["loudness_peak_dbtp"] = round(peak, 2)


def get_loudness_service():
    from .service import get_loudness_service as _get

    return _get()


def stop_loudness_service_if_started() -> None:
    from .service import stop_loudness_service_if_started as _stop

    _stop()
