"""Read queries over the projected catalog: tracks, albums, artists, genres and years.

One part of `shared.database.DatabaseManager`; every method runs on the manager
and reaches SQLite through `self._get_connection()`.
"""

import sqlite3
import json
import logging
from typing import List, Dict, Any, Optional
from shared.models import Track


logger = logging.getLogger(__name__)


# Podcast episodes share the tracks table with songs. Queries that describe a
# *music* library say so with this, rather than each one inventing its own idea
# of what counts.
MUSIC_ONLY = "(t.media_kind IS NULL OR t.media_kind != 'podcast_episode')"


class CatalogQueries:

    def search_tracks(self, query: str) -> List[Track]:
        """Fast search tracks using FTS5 or LIKE."""
        if not query:
            return self.get_all_tracks()
            
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            try:
                # Note: Try FTS5 first
                cursor = conn.execute("""
                    SELECT t.* FROM tracks t
                    JOIN tracks_fts f ON t.id = f.id
                    WHERE tracks_fts MATCH ?
                    ORDER BY rank
                """, (f"{query}*",))
                return self._rows_to_tracks(conn, cursor.fetchall())
            except sqlite3.OperationalError:
                # Note: Fallback to LIKE
                cursor = conn.execute("""
                    SELECT * FROM tracks 
                    WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?
                    ORDER BY artist, title
                """, (f"%{query}%", f"%{query}%", f"%{query}%"))
                return self._rows_to_tracks(conn, cursor.fetchall())

    def get_track(self, track_id: str) -> Optional[Track]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
            return self._rows_to_tracks(conn, [row])[0] if row else None

    def get_library_track(self, track_id: str) -> Optional[Track]:
        """Resolve an acquisition checkpoint alias only while still a member."""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            seen = set()
            for _ in range(64):
                if track_id in seen:
                    return None
                seen.add(track_id)
                alias = conn.execute('SELECT new_track_id FROM track_id_aliases WHERE old_track_id=?',
                                     (track_id,)).fetchone()
                if not alias:
                    row = conn.execute('SELECT t.* FROM tracks t JOIN library_tracks l ON l.track_id=t.id '
                                       'WHERE t.id=?', (track_id,)).fetchone()
                    return self._rows_to_tracks(conn, [row])[0] if row else None
                track_id = alias[0]
        return None

    def get_albums(self) -> List[Dict[str, Any]]:
        """Fetch first-class albums without merging homonymous releases."""
        return self._albums_query("GROUP BY a.id ORDER BY a.album_artist, a.title")

    def get_album(self, catalog_album_id: str) -> Optional[Dict[str, Any]]:
        rows = self._albums_query("WHERE a.id = ? GROUP BY a.id", (catalog_album_id,))
        return rows[0] if rows else None

    def _albums_query(self, tail: str, params: tuple = ()) -> List[Dict[str, Any]]:
        """One album projection, reused by every ordering the clients ask for.

        `track_user_state` is keyed by track id, so the left join adds no rows
        and the aggregates below stay honest.

        `cover_track_id` is the album's opening track, ordered the way the disc
        is — the same row `getCoverArt` reaches through
        ``get_tracks_by_album_id(...)[0]``. Picking it here rather than letting
        each caller pick its own is what keeps the artwork on a grid identical
        to the artwork a Subsonic client fetches for that album.
        """
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(f"""
                SELECT a.id,
                       a.title,
                       a.title AS album,
                       a.album_artist,
                       a.album_artist AS artist,
                       a.album_artist_id,
                       a.year,
                       a.genre,
                       a.is_compilation,
                       (SELECT t2.id FROM tracks t2
                         WHERE t2.album_id = a.id
                         ORDER BY COALESCE(t2.disc_number, 1), COALESCE(t2.track_number, 0), t2.title
                         LIMIT 1) AS cover_track_id,
                       COUNT(t.id) AS track_count,
                       COALESCE(SUM(t.duration), 0) AS duration,
                       COALESCE(SUM(s.play_count), 0) AS play_count,
                       MAX(s.last_played_at) AS last_played_at,
                       MAX(COALESCE(t.added_at, t.last_updated)) AS added_at,
                       AVG(s.rating) AS average_rating
                FROM albums a
                JOIN tracks t ON t.album_id = a.id
                LEFT JOIN track_user_state s ON s.track_id = t.id
                {tail}
            """, params).fetchall()
            return [dict(row) for row in rows]

    #: The orderings ``getAlbumList2`` understands, mapped to SQL. Public
    #: because it is the shared contract: the player's album grid offers these
    #: and nothing else, so the two surfaces cannot drift into disagreeing
    #: about what "by year" means. ``starred`` is missing on purpose:
    #: favourites are not in this database.
    ALBUM_ORDERINGS = {
        # When the album joined the library, not when its rows were last
        # rewritten: `last_updated` is set by every write, so a library that has
        # been migrated once carries one identical timestamp on every track and
        # "newest" degenerates into "by title".
        "newest": "MAX(COALESCE(t.added_at, t.last_updated)) DESC, a.title",
        "alphabeticalByName": "a.title_key, a.album_artist",
        "alphabeticalByArtist": "a.album_artist, a.title_key",
        "byYear": "a.year, a.title_key",
        "byGenre": "a.album_artist, a.title_key",
        "random": "RANDOM()",
        "frequent": "COALESCE(SUM(s.play_count), 0) DESC, a.title_key",
        "recent": "MAX(s.last_played_at) DESC, a.title_key",
        "highest": "AVG(s.rating) DESC, a.title_key",
    }

    def get_albums_page(
        self,
        list_type: str = "alphabeticalByName",
        *,
        size: Optional[int] = 10,
        offset: int = 0,
        genre: Optional[str] = None,
        from_year: Optional[int] = None,
        to_year: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Albums in the order a client asked for, one page at a time.

        ``size=None`` means every match. Subsonic always names a page size, so
        that path is unchanged; the player's grid scrolls the whole library at
        once and would otherwise have to page a list it is about to render in
        full anyway.
        """
        order = self.ALBUM_ORDERINGS.get(list_type)
        if order is None:
            return []

        filters: List[str] = []
        params: List[Any] = []
        having = ""

        if list_type == "byGenre":
            if not genre:
                return []
            filters.append("a.genre = ? COLLATE NOCASE")
            params.append(genre)
        elif list_type == "byYear":
            low, high = from_year, to_year
            if low is None or high is None:
                return []
            # `fromYear > toYear` is how the protocol asks for descending order.
            descending = low > high
            if descending:
                low, high = high, low
                order = "a.year DESC, a.title_key"
            filters.append("a.year IS NOT NULL AND a.year BETWEEN ? AND ?")
            params.extend([low, high])
        elif list_type == "recent":
            having = "HAVING MAX(s.last_played_at) IS NOT NULL"
        elif list_type == "frequent":
            having = "HAVING COALESCE(SUM(s.play_count), 0) > 0"
        elif list_type == "highest":
            having = "HAVING AVG(s.rating) IS NOT NULL"

        where = f"WHERE {' AND '.join(filters)}" if filters else ""
        limit = ""
        if size is not None:
            limit = " LIMIT ? OFFSET ?"
            params.extend([max(0, int(size)), max(0, int(offset))])
        return self._albums_query(
            f"{where} GROUP BY a.id {having} ORDER BY {order}{limit}",
            tuple(params),
        )

    def get_albums_by_ids(self, album_ids: List[str]) -> List[Dict[str, Any]]:
        if not album_ids:
            return []
        placeholders = ",".join("?" for _ in album_ids)
        return self._albums_query(
            f"WHERE a.id IN ({placeholders}) GROUP BY a.id ORDER BY a.album_artist, a.title",
            tuple(album_ids),
        )

    def get_artists(self) -> List[Dict[str, Any]]:
        """Fetch first-class artists with album and track counts."""
        return self._artists_query("GROUP BY ar.id ORDER BY ar.name")

    def get_artist(self, catalog_artist_id: str) -> Optional[Dict[str, Any]]:
        rows = self._artists_query("WHERE ar.id = ? GROUP BY ar.id", (catalog_artist_id,))
        return rows[0] if rows else None

    def _artists_query(self, tail: str, params: tuple = ()) -> List[Dict[str, Any]]:
        """One artist projection. `cover_track_id` matches `getCoverArt`'s pick
        for an artist — the first track they perform on — so the player's grid
        and a Subsonic client draw the same face."""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(f"""
                SELECT ar.id,
                       ar.name,
                       COUNT(DISTINCT ta.track_id) AS track_count,
                       COUNT(DISTINCT al.id) AS album_count,
                       (SELECT t2.id FROM tracks t2
                         JOIN track_artists ta2 ON ta2.track_id = t2.id
                         WHERE ta2.artist_id = ar.id
                         ORDER BY t2.album, COALESCE(t2.disc_number, 1),
                                  COALESCE(t2.track_number, 0), t2.title
                         LIMIT 1) AS cover_track_id
                FROM artists ar
                LEFT JOIN track_artists ta ON ta.artist_id = ar.id
                LEFT JOIN albums al ON al.album_artist_id = ar.id
                {tail}
            """, params).fetchall()
            return [dict(row) for row in rows]

    def get_albums_by_artist_id(self, catalog_artist_id: str) -> List[Dict[str, Any]]:
        """The releases credited to this artist, newest year first."""
        return self._albums_query(
            "WHERE a.album_artist_id = ? GROUP BY a.id ORDER BY a.year, a.title_key",
            (catalog_artist_id,),
        )

    def search_albums(self, query: str, *, count: int = 20, offset: int = 0) -> List[Dict[str, Any]]:
        """Albums matching a query, compared on the folded keys the catalog stores."""
        from shared.library_catalog import entity_key

        like = f"%{entity_key(query)}%"
        return self._albums_query(
            "WHERE a.title_key LIKE ? OR LOWER(a.album_artist) LIKE ? "
            "GROUP BY a.id ORDER BY a.album_artist, a.title LIMIT ? OFFSET ?",
            (like, like, max(0, int(count)), max(0, int(offset))),
        )

    def search_artists(self, query: str, *, count: int = 20, offset: int = 0) -> List[Dict[str, Any]]:
        from shared.library_catalog import entity_key

        like = f"%{entity_key(query)}%"
        return self._artists_query(
            "WHERE ar.name_key LIKE ? GROUP BY ar.id ORDER BY ar.name LIMIT ? OFFSET ?",
            (like, max(0, int(count)), max(0, int(offset))),
        )

    def get_genres(self) -> List[Dict[str, Any]]:
        """Genres present in the library, with what carries each one."""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(f"""
                SELECT TRIM(t.genre) AS name,
                       COUNT(*) AS song_count,
                       COUNT(DISTINCT t.album_id) AS album_count
                FROM tracks t
                WHERE t.genre IS NOT NULL AND TRIM(t.genre) != '' AND {MUSIC_ONLY}
                GROUP BY TRIM(t.genre) COLLATE NOCASE
                ORDER BY name COLLATE NOCASE
            """).fetchall()
            return [dict(row) for row in rows]

    def get_years(self) -> List[Dict[str, Any]]:
        """Release years present in the catalog, newest first.

        Read off `albums` rather than `tracks`: the year of a release belongs to
        the release, and counting it per track would rank a long album above a
        year that holds several short ones.
        """
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("""
                SELECT a.year AS year,
                       COUNT(DISTINCT a.id) AS album_count,
                       COUNT(t.id) AS track_count
                FROM albums a
                JOIN tracks t ON t.album_id = a.id
                WHERE a.year IS NOT NULL
                GROUP BY a.year
                ORDER BY a.year DESC
            """).fetchall()
            return [dict(row) for row in rows]

    def get_tracks_by_genre(self, genre: str, *, count: int = 10, offset: int = 0) -> List[Track]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(f"""
                SELECT t.* FROM tracks t
                WHERE t.genre = ? COLLATE NOCASE AND {MUSIC_ONLY}
                ORDER BY t.artist, t.album, COALESCE(t.disc_number, 1), COALESCE(t.track_number, 0)
                LIMIT ? OFFSET ?
            """, (genre, max(0, int(count)), max(0, int(offset)))).fetchall()
            return self._rows_to_tracks(conn, rows)

    def get_random_tracks(
        self,
        *,
        size: int = 10,
        genre: Optional[str] = None,
        from_year: Optional[int] = None,
        to_year: Optional[int] = None,
    ) -> List[Track]:
        filters = [MUSIC_ONLY]
        params: List[Any] = []
        if genre:
            filters.append("t.genre = ? COLLATE NOCASE")
            params.append(genre)
        if from_year is not None:
            filters.append("t.year >= ?")
            params.append(int(from_year))
        if to_year is not None:
            filters.append("t.year <= ?")
            params.append(int(to_year))
        params.append(max(0, int(size)))
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(f"""
                SELECT t.* FROM tracks t
                WHERE {' AND '.join(filters)}
                ORDER BY RANDOM() LIMIT ?
            """, tuple(params)).fetchall()
            return self._rows_to_tracks(conn, rows)

    def count_tracks_per_album(self, track_ids: List[str]) -> Dict[str, int]:
        """How many of these tracks each album holds, as ``album_id -> count``.

        One query so a caller deciding "is this whole album starred?" over a
        page of fifty albums does not ask fifty times.
        """
        if not track_ids:
            return {}
        placeholders = ",".join("?" for _ in track_ids)
        with self._get_connection() as conn:
            rows = conn.execute(f"""
                SELECT album_id, COUNT(*) FROM tracks
                WHERE id IN ({placeholders}) AND album_id IS NOT NULL
                GROUP BY album_id
            """, tuple(track_ids)).fetchall()
            return {str(row[0]): int(row[1]) for row in rows}

    def get_tracks_by_ids(self, track_ids: List[str]) -> List[Track]:
        """Tracks for a list of ids, in the order the caller gave them."""
        if not track_ids:
            return []
        placeholders = ",".join("?" for _ in track_ids)
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"""SELECT DISTINCT t.* FROM tracks t LEFT JOIN collection_files f ON f.file_id=t.id
                    WHERE t.id IN ({placeholders}) OR f.item_id IN ({placeholders})""", tuple(track_ids) * 2
            ).fetchall()
            by_id = {track.id: track for track in self._rows_to_tracks(conn, rows)}
            for track in list(by_id.values()):
                if track.item_id:
                    by_id.setdefault(track.item_id, track)
            return [by_id[track_id] for track_id in track_ids if track_id in by_id]

    def get_tracks_by_album_id(self, catalog_album_id: str) -> List[Track]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("""
                SELECT * FROM tracks
                WHERE album_id = ?
                ORDER BY COALESCE(disc_number, 1), COALESCE(track_number, 0), title
            """, (catalog_album_id,)).fetchall()
            return self._rows_to_tracks(conn, rows)

    def get_tracks_by_artist_id(self, catalog_artist_id: str) -> List[Track]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("""
                SELECT t.*
                FROM tracks t
                JOIN track_artists ta ON ta.track_id = t.id
                WHERE ta.artist_id = ?
                ORDER BY t.album, COALESCE(t.disc_number, 1), COALESCE(t.track_number, 0), t.title
            """, (catalog_artist_id,)).fetchall()
            return self._rows_to_tracks(conn, rows)

    @staticmethod
    def _artist_names_by_track(conn, track_ids: list[str]) -> Dict[str, List[str]]:
        if not track_ids:
            return {}
        placeholders = ",".join("?" for _ in track_ids)
        rows = conn.execute(f"""
            SELECT ta.track_id, ar.name
            FROM track_artists ta
            JOIN artists ar ON ar.id = ta.artist_id
            WHERE ta.track_id IN ({placeholders})
            ORDER BY ta.track_id, ta.position
        """, track_ids).fetchall()
        result: Dict[str, List[str]] = {}
        for row in rows:
            result.setdefault(str(row["track_id"]), []).append(str(row["name"]))
        return result

    def _rows_to_tracks(self, conn, rows: list[sqlite3.Row]) -> List[Track]:
        artists = self._artist_names_by_track(conn, [str(row["id"]) for row in rows])
        from shared.collection import attach_ids
        return attach_ids(conn, [self._row_to_track(row, artists.get(str(row["id"]))) for row in rows])

    def _row_to_track(self, row: sqlite3.Row, artists: Optional[List[str]] = None) -> Track:
        # Machine-local scan fields live only in SQLite and are restored here.
        data = dict(row)
        data.pop("last_updated", None)
        data.pop("album_id", None)
        stored_artists = data.pop("artists_json", None)
        data["is_local"] = bool(data.get("is_local"))
        data["metadata_modified_by_user"] = bool(data.get("metadata_modified_by_user"))
        data["is_compilation"] = bool(data.get("is_compilation"))
        data["artists"] = artists or (json.loads(stored_artists) if stored_artists else None)
        return Track.from_dict(data)

    def search_music_tracks(self, query: str, *, count: int = 20, offset: int = 0) -> List[Track]:
        """Track search restricted to music, paged the way clients page it."""
        like = f"%{query}%"
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(f"""
                SELECT t.* FROM tracks t
                WHERE {MUSIC_ONLY}
                  AND (t.title LIKE ? OR t.artist LIKE ? OR t.album LIKE ?)
                ORDER BY t.artist, t.album, COALESCE(t.disc_number, 1), COALESCE(t.track_number, 0), t.title
                LIMIT ? OFFSET ?
            """, (like, like, like, max(0, int(count)), max(0, int(offset)))).fetchall()
            return self._rows_to_tracks(conn, rows)
