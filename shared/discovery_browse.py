"""Bounded metadata enrichment for the Search home, independent of track ranking."""
from __future__ import annotations

from collections import Counter
import datetime
from itertools import zip_longest
import time

from shared.providers import deezer
from shared.text_utils import fold_text

_ALLOWED_RECORD_TYPES = {"album", "ep", "single"}
_NEW_RELEASE_WINDOW_DAYS = 180
_RECENT_BADGE_DAYS = 30
_MAX_RELEASE_OWNERS = 8


def _parse_release_date(value: object) -> datetime.date | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.date.fromisoformat(text)
    except ValueError:
        return None


def build_browse_sections(
    seed_names: list[str],
    limit: int = 10,
    *,
    release_seeds: list[dict[str, str]] | None = None,
    today: datetime.date | None = None,
) -> dict:
    """Return navigable catalog entities; never infer artists from video channels.

    Runs only in the feed's background worker. Each provider failure is isolated,
    and a deadline prevents a large library from causing unbounded fan-out.
    """
    deadline = time.monotonic() + 20
    failed = False
    ref_today = today or datetime.date.today()
    resolved_by_folded: dict[str, dict | None] = {}
    albums_by_artist: dict[str, list[dict]] = {}

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
        return {
            "id": f"deezer:artist:{aid}",
            "type": "artist",
            "source": "deezer",
            "title": name,
            "artist": name,
            "cover": deezer.image(row, "picture"),
            "external_ids": {"deezer_artist_id": aid},
            "reason_artist": reason,
        }

    def resolve_seed_artist(name: str) -> dict | None:
        wanted = fold_text(name)
        if not wanted:
            return None
        if wanted in resolved_by_folded:
            return resolved_by_folded[wanted]
        matches = rows("search/artist", {"q": name, "limit": 8})
        # A homonym or an approximate search hit must not become a taste seed;
        # fold diacritics and break exact-match ties by fan count.
        exact = [r for r in matches if fold_text(r.get("name")) == wanted]
        exact.sort(key=lambda r: int(r.get("nb_fan") or 0), reverse=True)
        match = exact[0] if exact else None
        seed = artist_item(match) if match else None
        resolved_by_folded[wanted] = seed
        return seed

    def artist_albums(aid: str) -> list[dict]:
        if aid not in albums_by_artist:
            albums_by_artist[aid] = rows(f"artist/{aid}/albums", {"limit": 20})
        return albums_by_artist[aid]

    seeds: list[dict] = []
    pools: list[list[dict]] = []
    popular = not seed_names and not release_seeds
    if popular:
        pools = [[item for row in rows("chart/0/artists", {"limit": 20})
                  if (item := artist_item(row))]]
    else:
        for name in seed_names[:5]:
            seed = resolve_seed_artist(name)
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

    new_releases: list[dict] = []
    new_release_ids: set[str] = set()
    if not popular:
        candidates = (
            release_seeds[:_MAX_RELEASE_OWNERS]
            if release_seeds is not None
            else [
                {"name": s["title"], "deezer_id": s["external_ids"]["deezer_artist_id"]}
                for s in seeds[:_MAX_RELEASE_OWNERS]
            ]
        )
        release_owners: list[tuple[str, str]] = []
        seen_release_owners: set[str] = set()
        for candidate in candidates:
            cname = str(candidate.get("name") or "").strip()
            caid = str(candidate.get("deezer_id") or "").strip()
            if caid.isdigit() and cname:
                owner_id, owner_name = caid, cname
            elif cname:
                resolved_seed = resolve_seed_artist(cname)
                if not resolved_seed:
                    continue
                owner_id = resolved_seed["external_ids"]["deezer_artist_id"]
                owner_name = resolved_seed["title"]
            else:
                continue
            if owner_id in seen_release_owners:
                continue
            seen_release_owners.add(owner_id)
            release_owners.append((owner_id, owner_name))

        raw_releases: list[tuple[datetime.date, int, str, str, dict]] = []
        for owner_id, owner_name in release_owners:
            for row in artist_albums(owner_id):
                aid = str(row.get("id") or "")
                title = str(row.get("title") or "").strip()
                rtype = str(row.get("record_type") or "").strip().casefold() or "album"
                if not aid.isdigit() or not title or rtype not in _ALLOWED_RECORD_TYPES:
                    continue
                rel_date = _parse_release_date(row.get("release_date"))
                if rel_date is None:
                    continue
                age_days = (ref_today - rel_date).days
                if age_days < 0 or age_days > _NEW_RELEASE_WINDOW_DAYS:
                    continue
                raw_releases.append((rel_date, int(aid), owner_id, owner_name, row))

        raw_releases.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
        new_release_per_artist: Counter = Counter()
        for rel_date, aid_num, owner_id, owner_name, row in raw_releases:
            if len(new_releases) >= limit:
                break
            aid = str(aid_num)
            if aid in new_release_ids or new_release_per_artist[owner_id] >= 2:
                continue
            title = str(row.get("title") or "").strip()
            rtype = str(row.get("record_type") or "").strip().casefold() or "album"
            new_release_ids.add(aid)
            new_release_per_artist[owner_id] += 1
            new_releases.append({
                "id": f"deezer:album:{aid}",
                "type": "album",
                "source": "deezer",
                "title": title,
                "artist": owner_name,
                "subtitle": owner_name,
                "cover": deezer.image(row, "cover"),
                "record_type": rtype,
                "release_date": rel_date.isoformat(),
                "is_new": (ref_today - rel_date).days <= _RECENT_BADGE_DAYS,
                "external_ids": {"deezer_album_id": aid, "deezer_artist_id": owner_id},
                "reason_artist": "",
            })

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
            releases = artist_albums(aid)
            album_pools.append([
                {**r, "artist": {"id": aid, "name": owner["title"]},
                 "reason_artist": owner.get("reason_artist") or owner["title"]}
                for r in releases
                if (str(r.get("record_type") or "").strip().casefold() or "album") in _ALLOWED_RECORD_TYPES
            ])

    albums: list[dict] = []
    seen_albums: set[str] = set(new_release_ids)
    per_artist: Counter = Counter()
    for round_items in zip_longest(*album_pools):
        for row in round_items:
            if not row or len(albums) >= limit:
                continue
            aid = str(row.get("id") or "")
            owner = row.get("artist") if isinstance(row.get("artist"), dict) else {}
            owner_id, name = str(owner.get("id") or ""), str(owner.get("name") or "").strip()
            title = str(row.get("title") or "").strip()
            rtype = str(row.get("record_type") or "").strip().casefold()
            if (not aid.isdigit() or not owner_id.isdigit() or not name or not title
                    or aid in seen_albums or per_artist[owner_id] >= 2
                    or (rtype and rtype not in _ALLOWED_RECORD_TYPES)):
                continue
            seen_albums.add(aid)
            per_artist[owner_id] += 1
            albums.append({
                "id": f"deezer:album:{aid}",
                "type": "album",
                "source": "deezer",
                "title": title,
                "artist": name,
                "subtitle": name,
                "cover": deezer.image(row, "cover"),
                "record_type": rtype or "album",
                "release_date": str(row.get("release_date") or "").strip(),
                "external_ids": {"deezer_album_id": aid, "deezer_artist_id": owner_id},
                "reason_artist": row.get("reason_artist", ""),
            })
    browse_sections = [
        {"id": "new_releases", "popular": False, "items": new_releases},
        {"id": "artists", "popular": popular, "items": artists},
        {"id": "albums", "popular": popular, "items": albums},
    ]
    return {
        "browse_sections": [section for section in browse_sections if section["items"]],
        "browse_error": failed,
    }
