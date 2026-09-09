"""Bounded, account-local, idempotent playback evidence. No media or URLs."""
from __future__ import annotations

import json
from datetime import datetime
import math
import re
import sqlite3
import time
from pathlib import Path

MAX_BODY = 48_000
MAX_BATCHES = 32768
MAX_BYTES = 64 * 1024 * 1024  # payload cap; SQLite reuses free pages
RETENTION_SEC = 7 * 86400
KEY = re.compile(r"^[a-zA-Z0-9_.:-]{1,128}$")
FACTS = set("node operation error index from to state origin action reason expectedState mode phase syncReason persisted lost".split())
PROGRAM = set("activeIndex mixPhase dominant contextState contextTime outputMode gain0Target gain1Target localVolume localMuted".split())
MEDIA = set("id deckIndex paused ended muted position duration rate volume readyState networkState hasSource sourceKind errorCode".split())
CAPTURE = set("id startedAt clientRevision userId deviceId platform displayMode".split())


def clean_fields(value, allowed):
    if not isinstance(value, dict):
        raise ValueError("invalid trace fields")
    result = {}
    for key in allowed:
        item = value.get(key)
        if item is None or isinstance(item, bool):
            if key in value:
                result[key] = item
        elif isinstance(item, (int, float)):
            if not math.isfinite(item) or abs(item) > 1e15:
                raise ValueError("invalid trace number")
            result[key] = item
        elif isinstance(item, str) and len(item) <= 128 and re.fullmatch(r"[a-zA-Z0-9_.: +\-]*", item):
            result[key] = item
        else:
            raise ValueError("invalid trace field")
    return result


def validate_batch(data, user_id):
    if not isinstance(data, dict) or data.get("userId") != user_id:
        raise ValueError("trace account mismatch")
    batch_id = data.get("id")
    if not isinstance(batch_id, str) or not KEY.fullmatch(batch_id):
        raise ValueError("invalid trace id")
    capture = clean_fields(data.get("capture"), CAPTURE)
    if capture.get("userId") != user_id or not isinstance(capture.get("id"), str):
        raise ValueError("invalid trace capture")
    if any(not isinstance(capture.get(key), str) or not capture[key] for key in CAPTURE):
        raise ValueError("incomplete trace capture")
    if datetime.fromisoformat(capture['startedAt']).tzinfo is None:
        raise ValueError("trace start must include timezone")
    rows = data.get("events")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 24:
        raise ValueError("invalid trace event count")
    events = []
    previous = 0
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("invalid trace event")
        seq = row.get("sequence")
        if type(seq) is not int or not previous < seq < 1e12:
            raise ValueError("invalid trace sequence")
        previous = seq
        event = row.get("event")
        if not isinstance(event, str) or not KEY.fullmatch(event):
            raise ValueError("invalid trace event name")
        clean = clean_fields(row, {"elapsedMs", "declaredState", "visibility"})
        if not isinstance(clean.get("elapsedMs"), (int, float)) or clean["elapsedMs"] < 0:
            raise ValueError("invalid trace clock")
        media = row.get("media")
        if not isinstance(media, list) or len(media) > 4:
            raise ValueError("invalid trace media")
        clean.update(sequence=seq, event=event, facts=clean_fields(row.get("facts"), FACTS),
                     program=clean_fields(row.get("program"), PROGRAM),
                     media=[clean_fields(item, MEDIA) for item in media])
        events.append(clean)
    if batch_id != f"{capture['id']}:{events[0]['sequence']}":
        raise ValueError("trace id does not match sequence")
    dropped = data.get("dropped", 0)
    if type(dropped) is not int or not 0 <= dropped <= 1e12:
        raise ValueError("invalid trace loss count")
    return dict(id=batch_id, capture=capture, events=events, dropped=dropped)


def save_batch(batch, directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / 'playback-traces.sqlite3'
    with sqlite3.connect(path, timeout=5) as db:
        db.execute("PRAGMA synchronous=FULL")
        db.execute("CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, received REAL NOT NULL, payload TEXT NOT NULL)")
        db.execute("INSERT OR IGNORE INTO batches VALUES (?, ?, ?)",
                   (batch['id'], time.time(), json.dumps(batch, separators=(',', ':'), allow_nan=False)))
        db.execute("DELETE FROM batches WHERE received < ?", (time.time() - RETENTION_SEC,))
        db.execute("DELETE FROM batches WHERE id IN (SELECT id FROM batches ORDER BY received DESC LIMIT -1 OFFSET ?)", (MAX_BATCHES,))
        db.execute("DELETE FROM batches WHERE id IN (SELECT id FROM (SELECT id, SUM(length(payload)) OVER (ORDER BY received DESC, id DESC) AS total FROM batches) WHERE total > ?)", (MAX_BYTES,))
    # The context manager commits before the HTTP acknowledgement is returned.
