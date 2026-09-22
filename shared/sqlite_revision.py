"""Transactional invalidation tokens for small independently written stores."""
from __future__ import annotations

import sqlite3


def install_revision(conn: sqlite3.Connection, tables: tuple[str, ...]) -> None:
    """Install once during schema initialization, before serving any readers.

    Tables are internal constants. Tokens change in the same transaction as
    every row mutation, including writes from another connection/process. Random
    tokens also distinguish a recreated store from its predecessor.
    """
    conn.execute("CREATE TABLE IF NOT EXISTS public_revision (singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL)")
    conn.execute("INSERT OR IGNORE INTO public_revision VALUES (1, lower(hex(randomblob(16))))")
    for table in tables:
        if not table.isidentifier():
            raise ValueError("Invalid revision table")
        for operation in ("INSERT", "UPDATE", "DELETE"):
            conn.execute(f"""CREATE TRIGGER IF NOT EXISTS public_revision_{table}_{operation}
                AFTER {operation} ON {table} BEGIN
                  UPDATE public_revision SET token=lower(hex(randomblob(16))) WHERE singleton=1;
                END""")


def read_revision(conn: sqlite3.Connection) -> str:
    return str(conn.execute("SELECT token FROM public_revision WHERE singleton=1").fetchone()[0])
