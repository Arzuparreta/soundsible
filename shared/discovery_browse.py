"""Bounded metadata enrichment for the Search home, independent of track ranking."""
from __future__ import annotations

from collections import Counter
from itertools import zip_longest
import time

from shared.providers import deezer


def build_browse_sections(seed_names: list[str], limit: int = 10) -> dict:
    """Return navigable catalog entities; never infer artists from video channels.

    Runs only in the feed's background worker. Each provider failure is isolated,
    and a deadline prevents a large library from causing unbounded fan-out.
    """
    deadline = time.monotonic() + 20
    failed = False

    def rows(path: str, params: dict | None = None) -> list[dict]:
        nonlocal failed
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            failed = True
            return []
        try:
            response = deezer.get(path, params, timeout=min(3, remaining))
            if response.get("error"):
                failed = True
            data = response.get("data")
            return [r for r in data if isinstance(r, dict)] if isinstance(data, list) else []
        except Exception:
            failed = True
            return []

    def artist_item(row: dict, reason: str = "") -> dict | None:
        aid, name = str(row.get("id") or ""), str(row.get("name") or "").strip()
        if not aid.isdigit() or not name:
            return None
        return {"id": f"deezer:artist:{aid}", "type": "artist", "source": "deezer",
                "title": name, "artist": name,
                "cover": row.get("picture_xl") or row.get("picture_big") or row.get("picture_medium") or "",
                "external_ids": {"deezer_artist_id": aid},
                "reason_artist": reason}

    seeds: list[dict] = []
    pools: list[list[dict]] = []
    popular = not seed_names
    if popular:
        pools = [[item for row in rows("chart/0/artists", {"limit": 20})
                  if (item := artist_item(row))]]
    else:
        for name in seed_names[:5]:
            matches = rows("search/artist", {"q": name, "limit": 5})
            # A homonym or an approximate search hit must not become a taste seed.
            match = next((r for r in matches if str(r.get("name") or "").casefold() == name.casefold()), None)
            seed = artist_item(match) if match else None
            if not seed or any(s["id"] == seed["id"] for s in seeds):
                continue
            seeds.append(seed)
            aid = seed["external_ids"]["deezer_artist_id"]
            pools.append([item for row in rows(f"artist/{aid}/related", {"limit": 10})
                          if (item := artist_item(row, name))])

    artists: list[dict] = []
    seen = {s["id"] for s in seeds}
    for round_items in zip_longest(*pools):
        for item in round_items:
            if item and item["id"] not in seen and len(artists) < limit:
                seen.add(item["id"])
                artists.append(item)

    album_pools: list[list[dict]] = []
    if popular:
        album_pools.append(rows("chart/0/albums", {"limit": 30}))
    else:
        # Alternate familiar and related artists, so albums also lead outward.
        owners = []
        for pair in zip_longest(seeds, artists):
            owners.extend(item for item in pair if item)
        for owner in owners[:5]:
            aid = owner["external_ids"]["deezer_artist_id"]
            releases = rows(f"artist/{aid}/albums", {"limit": 20})
            album_pools.append([
                {**r, "artist": {"id": aid, "name": owner["title"]},
                 "reason_artist": owner.get("reason_artist") or owner["title"]}
                for r in releases if r.get("record_type") == "album"
            ])

    albums: list[dict] = []
    seen_albums: set[str] = set()
    per_artist: Counter = Counter()
    for round_items in zip_longest(*album_pools):
        for row in round_items:
            if not row or len(albums) >= limit:
                continue
            aid = str(row.get("id") or "")
            owner = row.get("artist") if isinstance(row.get("artist"), dict) else {}
            owner_id, name = str(owner.get("id") or ""), str(owner.get("name") or "").strip()
            title = str(row.get("title") or "").strip()
            if (not aid.isdigit() or not owner_id.isdigit() or not name or not title
                    or aid in seen_albums or per_artist[owner_id] >= 2
                    or row.get("record_type") in ("single", "ep")):
                continue
            seen_albums.add(aid)
            per_artist[owner_id] += 1
            albums.append({"id": f"deezer:album:{aid}", "type": "album", "source": "deezer",
                           "title": title, "artist": name, "subtitle": name,
                           "cover": row.get("cover_xl") or row.get("cover_big") or row.get("cover_medium") or "",
                           "external_ids": {"deezer_album_id": aid, "deezer_artist_id": owner_id},
                           "reason_artist": row.get("reason_artist", "")})
    return {"browse_sections": [
        {"id": kind, "popular": popular, "items": items}
        for kind, items in (("artists", artists), ("albums", albums)) if items
    ], "browse_error": failed}
