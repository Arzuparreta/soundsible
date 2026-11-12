"""One account's scrobbling connections and the plays waiting to be sent.

Lives in the account's own directory, like the rest of what belongs to a
person: deleting the account removes its tokens and its unsent listening
history with it, and nothing here is ever read for somebody else.

The token a service issued has to be sent back to that service, so it cannot
be a hash. It is stored encrypted with ``scrobble.key`` from the config
directory (see :mod:`shared.keyfile`).
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

from cryptography.fernet import Fernet, InvalidToken

from shared.database import BUSY_TIMEOUT_MS
from shared.keyfile import fernet_key
from shared.runtime import get_config_dir
from shared.user_context import user_config_dir, users_config_root

from .listen import Listen

logger = logging.getLogger(__name__)

STORE_FILENAME = "scrobble.sqlite3"
KEY_FILENAME = "scrobble.key"

#: Plays kept per connection while its service cannot be reached. At a hundred
#: songs a day this is over three months; past it the oldest go first, which
#: are also the first a service would refuse as too old.
MAX_QUEUED = 10_000

_SCHEMA = """
CREATE TABLE IF NOT EXISTS connections (
    service         TEXT PRIMARY KEY,
    enabled         INTEGER NOT NULL DEFAULT 1,
    username        TEXT NOT NULL DEFAULT '',
    server          TEXT NOT NULL DEFAULT '',
    secret_enc      TEXT NOT NULL,
    needs_reconnect INTEGER NOT NULL DEFAULT 0,
    failures        INTEGER NOT NULL DEFAULT 0,
    retry_at        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT NOT NULL DEFAULT '',
    last_sent_at    INTEGER,
    connected_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS queue (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT NOT NULL,
    listen  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS queue_by_service ON queue (service, id);
"""


def _key() -> bytes:
    return fernet_key(Path(get_config_dir()) / KEY_FILENAME)


def encrypt_secret(secret: str) -> str:
    return Fernet(_key()).encrypt(secret.encode("utf-8")).decode("ascii")


def decrypt_secret(secret_enc: str) -> Optional[str]:
    try:
        return Fernet(_key()).decrypt(secret_enc.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        # The key file was replaced or lost. The owner connects the service again.
        logger.warning("Scrobble: a stored token could not be decrypted with the current key")
        return None


def users_with_store() -> list[str]:
    """Every account that has ever connected a service on this instance."""
    root = users_config_root()
    if not root.is_dir():
        return []
    return sorted(path.parent.name for path in root.glob(f"*/{STORE_FILENAME}"))


class ScrobbleStore:
    def __init__(self, user_id: str) -> None:
        self.user_id = user_id
        self._path = user_config_dir(user_id, create=False) / STORE_FILENAME

    def exists(self) -> bool:
        return self._path.exists()

    @contextmanager
    def _open(self, *, create: bool = False) -> Iterator[Optional[sqlite3.Connection]]:
        """A connection for one block, committed on success. ``None`` if nothing was ever stored."""
        if not create and not self._path.exists():
            yield None
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self._path, timeout=BUSY_TIMEOUT_MS / 1000)) as conn:
            conn.row_factory = sqlite3.Row
            conn.executescript(_SCHEMA)
            with conn:
                yield conn

    # -- connections -------------------------------------------------------

    def connections(self) -> dict[str, dict[str, Any]]:
        with self._open() as conn:
            if conn is None:
                return {}
            rows = conn.execute("SELECT * FROM connections").fetchall()
            pending = dict(conn.execute("SELECT service, COUNT(*) FROM queue GROUP BY service").fetchall())
        return {row["service"]: {**dict(row), "pending": int(pending.get(row["service"], 0))} for row in rows}

    def connect(self, service: str, *, secret: str, username: str = "", server: str = "") -> None:
        """Store a connection, replacing an earlier one. Plays already waiting stay queued."""
        with self._open(create=True) as conn:
            conn.execute(
                """
                INSERT INTO connections (service, username, server, secret_enc, connected_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(service) DO UPDATE SET
                    username=excluded.username, server=excluded.server, secret_enc=excluded.secret_enc,
                    enabled=1, needs_reconnect=0, failures=0, retry_at=0, last_error='',
                    connected_at=excluded.connected_at
                """,
                (service, username, server, encrypt_secret(secret), int(time.time())),
            )

    def disconnect(self, service: str) -> bool:
        with self._open() as conn:
            if conn is None:
                return False
            conn.execute("DELETE FROM queue WHERE service = ?", (service,))
            return conn.execute("DELETE FROM connections WHERE service = ?", (service,)).rowcount > 0

    def update(self, service: str, **fields: Any) -> None:
        if not fields:
            return
        assignments = ", ".join(f"{name} = ?" for name in fields)
        with self._open() as conn:
            if conn is not None:
                conn.execute(f"UPDATE connections SET {assignments} WHERE service = ?", (*fields.values(), service))  # nosec B608

    # -- queue -------------------------------------------------------------

    def enqueue(self, listen: Listen) -> list[str]:
        """Queue a play for every enabled connection. Returns the services it went to."""
        with self._open() as conn:
            if conn is None:
                return []
            services = [row[0] for row in conn.execute("SELECT service FROM connections WHERE enabled = 1")]
            payload = json.dumps(listen.to_json(), ensure_ascii=False, separators=(",", ":"))
            for service in services:
                conn.execute("INSERT INTO queue (service, listen) VALUES (?, ?)", (service, payload))
                conn.execute(
                    """
                    DELETE FROM queue WHERE service = ? AND id <= (
                        SELECT id FROM queue WHERE service = ? ORDER BY id DESC LIMIT 1 OFFSET ?
                    )
                    """,
                    (service, service, MAX_QUEUED),
                )
        return services

    def batch(self, service: str, limit: int) -> list[tuple[int, Listen]]:
        """The oldest plays waiting for ``service``, oldest first."""
        with self._open() as conn:
            if conn is None:
                return []
            rows = conn.execute(
                "SELECT id, listen FROM queue WHERE service = ? ORDER BY id LIMIT ?", (service, limit)
            ).fetchall()
        return [(row["id"], Listen.from_json(json.loads(row["listen"]))) for row in rows]

    def remove(self, ids: list[int]) -> None:
        if not ids:
            return
        with self._open() as conn:
            if conn is not None:
                conn.executemany("DELETE FROM queue WHERE id = ?", [(item,) for item in ids])
