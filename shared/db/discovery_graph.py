"""Shared artist similarity graph and release cache stored in instance.db.

One part of `shared.database.DatabaseManager`; every method runs on the manager
and reaches SQLite through `self._get_connection()`.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from typing import Any, Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)


class DiscoveryGraphStore:

    def upsert_graph_nodes(self, nodes: Iterable[Dict[str, Any]], *, now: int | None = None) -> None:
        ts = int(now if now is not None else time.time())
        payload = []
        for node in nodes:
            aid = str(node.get("deezer_artist_id") or "").strip()
            if not aid.isdigit():
                continue
            payload.append((
                aid,
                str(node.get("name") or "")[:220],
                str(node.get("literal_key") or "")[:220],
                str(node.get("folded_key") or "")[:220],
                max(0, int(node.get("nb_fan") or 0)),
                str(node.get("picture_url") or "")[:400],
                str(node.get("mbid") or "")[:80],
                int(node.get("related_synced_at") or 0),
                int(node.get("lastfm_synced_at") or 0),
                int(node.get("releases_synced_at") or 0),
                int(node.get("top_tracks_synced_at") or 0),
                int(node.get("updated_at") or ts),
            ))
        if not payload:
            return
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.executemany(
                """
                INSERT INTO artist_graph_nodes (
                    deezer_artist_id, name, literal_key, folded_key, nb_fan,
                    picture_url, mbid, related_synced_at, lastfm_synced_at,
                    releases_synced_at, top_tracks_synced_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(deezer_artist_id) DO UPDATE SET
                    name = CASE WHEN excluded.name != '' THEN excluded.name ELSE artist_graph_nodes.name END,
                    literal_key = CASE WHEN excluded.literal_key != '' THEN excluded.literal_key ELSE artist_graph_nodes.literal_key END,
                    folded_key = CASE WHEN excluded.folded_key != '' THEN excluded.folded_key ELSE artist_graph_nodes.folded_key END,
                    nb_fan = CASE WHEN excluded.nb_fan > 0 THEN excluded.nb_fan ELSE artist_graph_nodes.nb_fan END,
                    picture_url = COALESCE(NULLIF(excluded.picture_url, ''), artist_graph_nodes.picture_url),
                    mbid = COALESCE(NULLIF(excluded.mbid, ''), artist_graph_nodes.mbid),
                    related_synced_at = MAX(artist_graph_nodes.related_synced_at, excluded.related_synced_at),
                    lastfm_synced_at = MAX(artist_graph_nodes.lastfm_synced_at, excluded.lastfm_synced_at),
                    releases_synced_at = MAX(artist_graph_nodes.releases_synced_at, excluded.releases_synced_at),
                    top_tracks_synced_at = MAX(artist_graph_nodes.top_tracks_synced_at, excluded.top_tracks_synced_at),
                    updated_at = MAX(artist_graph_nodes.updated_at, excluded.updated_at)
                """,
                payload,
            )
            conn.execute("COMMIT")

    def get_graph_nodes_by_ids(self, artist_ids: Iterable[str]) -> Dict[str, Dict[str, Any]]:
        wanted = [str(aid).strip() for aid in artist_ids if str(aid).strip()]
        if not wanted:
            return {}
        out: Dict[str, Dict[str, Any]] = {}
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            for offset in range(0, len(wanted), 500):
                batch = wanted[offset:offset + 500]
                placeholders = ",".join("?" for _ in batch)
                rows = conn.execute(
                    f"SELECT * FROM artist_graph_nodes WHERE deezer_artist_id IN ({placeholders})",
                    tuple(batch),
                ).fetchall()
                for row in rows:
                    out[str(row["deezer_artist_id"])] = dict(row)
        return out

    def find_graph_node_by_literal(self, literal_key: str) -> Optional[Dict[str, Any]]:
        key = str(literal_key or "").strip()
        if not key:
            return None
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT * FROM artist_graph_nodes
                WHERE literal_key = ?
                ORDER BY nb_fan DESC, deezer_artist_id ASC
                LIMIT 1
                """,
                (key,),
            ).fetchone()
            return dict(row) if row else None

    def find_graph_nodes_by_literals(self, literal_keys: Iterable[str]) -> Dict[str, Dict[str, Any]]:
        wanted = [str(key).strip() for key in literal_keys if str(key).strip()]
        if not wanted:
            return {}
        out: Dict[str, Dict[str, Any]] = {}
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            for offset in range(0, len(wanted), 500):
                batch = wanted[offset:offset + 500]
                placeholders = ",".join("?" for _ in batch)
                rows = conn.execute(
                    f"""
                    SELECT * FROM artist_graph_nodes
                    WHERE literal_key IN ({placeholders})
                    ORDER BY nb_fan DESC, deezer_artist_id ASC
                    """,
                    tuple(batch),
                ).fetchall()
                for row in rows:
                    lit = str(row["literal_key"])
                    if lit not in out:
                        out[lit] = dict(row)
        return out

    def replace_similarity_edges(
        self,
        source_artist_id: str,
        provider: str,
        edges: Iterable[tuple[str, int, float]],
        synced_at: int,
    ) -> None:
        src = str(source_artist_id or "").strip()
        prov = str(provider or "").strip()
        if not src or not prov:
            return
        rows = [
            (src, str(target_id).strip(), prov, int(rank_pos), float(weight), int(synced_at))
            for target_id, rank_pos, weight in edges
            if str(target_id).strip() and str(target_id).strip() != src and float(weight) > 0
        ]
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "DELETE FROM artist_similarity_edges WHERE source_artist_id = ? AND provider = ?",
                (src, prov),
            )
            if rows:
                conn.executemany(
                    """
                    INSERT OR REPLACE INTO artist_similarity_edges (
                        source_artist_id, target_artist_id, provider, rank_pos, weight, synced_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    rows,
                )
            if prov == "deezer":
                conn.execute(
                    "UPDATE artist_graph_nodes SET related_synced_at = ?, updated_at = ? WHERE deezer_artist_id = ?",
                    (int(synced_at), int(synced_at), src),
                )
            elif prov == "lastfm":
                conn.execute(
                    "UPDATE artist_graph_nodes SET lastfm_synced_at = ?, updated_at = ? WHERE deezer_artist_id = ?",
                    (int(synced_at), int(synced_at), src),
                )
            conn.execute("COMMIT")

    def merge_similarity_edges(
        self,
        provider: str,
        edges: Iterable[tuple[str, str, int, float]],
        synced_at: int,
    ) -> None:
        prov = str(provider or "").strip()
        if not prov:
            return
        rows = [
            (str(src).strip(), str(dst).strip(), prov, int(rank_pos), float(weight), int(synced_at))
            for src, dst, rank_pos, weight in edges
            if str(src).strip() and str(dst).strip() and str(src).strip() != str(dst).strip() and float(weight) > 0
        ]
        if not rows:
            return
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.executemany(
                """
                INSERT INTO artist_similarity_edges (
                    source_artist_id, target_artist_id, provider, rank_pos, weight, synced_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_artist_id, target_artist_id, provider) DO UPDATE SET
                    rank_pos = MIN(artist_similarity_edges.rank_pos, excluded.rank_pos),
                    weight = MAX(artist_similarity_edges.weight, excluded.weight),
                    synced_at = MAX(artist_similarity_edges.synced_at, excluded.synced_at)
                """,
                rows,
            )
            conn.execute("COMMIT")

    def get_similarity_edges_for_sources(
        self,
        source_ids: Iterable[str],
        *,
        providers: Iterable[str] | None = None,
    ) -> List[Dict[str, Any]]:
        sources = [str(s).strip() for s in source_ids if str(s).strip()]
        if not sources:
            return []
        prov_list = [str(p).strip() for p in (providers or ()) if str(p).strip()]
        out: List[Dict[str, Any]] = []
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            for offset in range(0, len(sources), 500):
                batch = sources[offset:offset + 500]
                src_ph = ",".join("?" for _ in batch)
                if prov_list:
                    prov_ph = ",".join("?" for _ in prov_list)
                    rows = conn.execute(
                        f"""
                        SELECT source_artist_id, target_artist_id, provider, rank_pos, weight, synced_at
                        FROM artist_similarity_edges
                        WHERE source_artist_id IN ({src_ph}) AND provider IN ({prov_ph})
                        """,
                        (*batch, *prov_list),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        f"""
                        SELECT source_artist_id, target_artist_id, provider, rank_pos, weight, synced_at
                        FROM artist_similarity_edges
                        WHERE source_artist_id IN ({src_ph})
                        """,
                        tuple(batch),
                    ).fetchall()
                out.extend(dict(row) for row in rows)
        return out

    def get_target_in_degrees(self, target_ids: Iterable[str]) -> Dict[str, int]:
        targets = [str(t).strip() for t in target_ids if str(t).strip()]
        if not targets:
            return {}
        out: Dict[str, int] = {}
        with self._get_connection() as conn:
            for offset in range(0, len(targets), 500):
                batch = targets[offset:offset + 500]
                placeholders = ",".join("?" for _ in batch)
                rows = conn.execute(
                    f"""
                    SELECT target_artist_id, COUNT(DISTINCT source_artist_id)
                    FROM artist_similarity_edges
                    WHERE target_artist_id IN ({placeholders})
                    GROUP BY target_artist_id
                    """,
                    tuple(batch),
                ).fetchall()
                for row in rows:
                    out[str(row[0])] = int(row[1] or 0)
        return out

    def get_2hop_candidates(
        self,
        seed_ids: Iterable[str],
        hop1_ids: Iterable[str],
        *,
        limit: int = 30,
    ) -> List[Dict[str, Any]]:
        """Find 2nd-hop candidates supported by at least two distinct 1st-hop neighbors."""
        seeds = list(dict.fromkeys(str(s).strip() for s in seed_ids if str(s).strip()))
        hop1 = list(dict.fromkeys(str(h).strip() for h in hop1_ids if str(h).strip()))
        if not seeds or not hop1:
            return []
        excluded = list(dict.fromkeys([*seeds, *hop1]))
        seed_ph = ",".join("?" for _ in seeds)
        hop1_ph = ",".join("?" for _ in hop1)
        excl_ph = ",".join("?" for _ in excluded)
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"""
                SELECT
                    e2.target_artist_id AS target_artist_id,
                    COUNT(DISTINCT e2.source_artist_id) AS hop1_supporters,
                    SUM(e1.weight * e2.weight) AS path_score,
                    MIN(e1.source_artist_id) AS sample_seed_id
                FROM artist_similarity_edges e1
                JOIN artist_similarity_edges e2
                    ON e1.target_artist_id = e2.source_artist_id
                WHERE e1.source_artist_id IN ({seed_ph})
                  AND e1.target_artist_id IN ({hop1_ph})
                  AND e2.target_artist_id NOT IN ({excl_ph})
                GROUP BY e2.target_artist_id
                HAVING COUNT(DISTINCT e2.source_artist_id) >= 2
                ORDER BY path_score DESC, hop1_supporters DESC
                LIMIT ?
                """,
                (*seeds, *hop1, *excluded, max(1, int(limit))),
            ).fetchall()
            return [dict(row) for row in rows]

    def upsert_artist_releases(
        self,
        artist_deezer_id: str,
        releases: Iterable[Dict[str, Any]],
        synced_at: int,
    ) -> None:
        owner_id = str(artist_deezer_id or "").strip()
        if not owner_id.isdigit():
            return
        payload = []
        for rel in releases:
            album_id = str(rel.get("deezer_album_id") or "").strip()
            title = str(rel.get("title") or "").strip()[:220]
            credit = str(rel.get("artist_credit") or "").strip()[:220]
            rtype = str(rel.get("record_type") or "album").strip().casefold() or "album"
            rel_date = str(rel.get("release_date") or "").strip()
            cover = str(rel.get("cover_url") or "")[:400]
            verified = 1 if rel.get("credit_verified") else 0
            if not album_id.isdigit() or not title or not rel_date:
                continue
            payload.append((album_id, owner_id, title, credit, verified, rtype, rel_date, cover, int(synced_at)))
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if payload:
                conn.executemany(
                    """
                    INSERT INTO artist_releases_cache (
                        deezer_album_id, artist_deezer_id, title, artist_credit,
                        credit_verified, record_type, release_date, cover_url, synced_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(deezer_album_id) DO UPDATE SET
                        artist_deezer_id = excluded.artist_deezer_id,
                        title = excluded.title,
                        artist_credit = CASE
                            WHEN artist_releases_cache.credit_verified = 1 THEN artist_releases_cache.artist_credit
                            ELSE COALESCE(NULLIF(excluded.artist_credit, ''), artist_releases_cache.artist_credit)
                        END,
                        credit_verified = MAX(artist_releases_cache.credit_verified, excluded.credit_verified),
                        record_type = excluded.record_type,
                        release_date = excluded.release_date,
                        cover_url = COALESCE(NULLIF(excluded.cover_url, ''), artist_releases_cache.cover_url),
                        synced_at = excluded.synced_at
                    """,
                    payload,
                )
            conn.execute(
                """
                UPDATE artist_graph_nodes
                SET releases_synced_at = ?, updated_at = ?
                WHERE deezer_artist_id = ?
                """,
                (int(synced_at), int(synced_at), owner_id),
            )
            conn.execute("COMMIT")

    def get_artist_releases(
        self,
        artist_ids: Iterable[str],
        *,
        min_release_date: str = "",
    ) -> List[Dict[str, Any]]:
        wanted = [str(aid).strip() for aid in artist_ids if str(aid).strip().isdigit()]
        if not wanted:
            return []
        out: List[Dict[str, Any]] = []
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            for offset in range(0, len(wanted), 500):
                batch = wanted[offset:offset + 500]
                placeholders = ",".join("?" for _ in batch)
                if min_release_date:
                    rows = conn.execute(
                        f"""
                        SELECT * FROM artist_releases_cache
                        WHERE artist_deezer_id IN ({placeholders})
                          AND release_date >= ?
                        ORDER BY release_date DESC, CAST(deezer_album_id AS INTEGER) DESC
                        """,
                        (*batch, min_release_date),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        f"""
                        SELECT * FROM artist_releases_cache
                        WHERE artist_deezer_id IN ({placeholders})
                        ORDER BY release_date DESC, CAST(deezer_album_id AS INTEGER) DESC
                        """,
                        tuple(batch),
                    ).fetchall()
                out.extend(dict(row) for row in rows)
        return out

    def update_release_credit(self, deezer_album_id: str, artist_credit: str) -> None:
        album_id = str(deezer_album_id or "").strip()
        if not album_id.isdigit():
            return
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                """
                UPDATE artist_releases_cache
                SET artist_credit = ?, credit_verified = 1
                WHERE deezer_album_id = ?
                """,
                (str(artist_credit or "")[:220], album_id),
            )
            conn.execute("COMMIT")
