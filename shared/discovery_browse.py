"""Bounded metadata enrichment for the Search home, independent of track ranking."""
from __future__ import annotations

from collections import Counter
import datetime
from itertools import zip_longest
import time

from shared.deezer_catalog import (
    DEEZER_ARTIST_SEARCH_LIMIT,
    literal_artist_key,
    main_contributors,
    select_artist_matches,
)
from shared.discovery_intelligence import artist_recommendation_multiplier
from shared.providers import deezer
from shared.text_utils import fold_text, identity_key


def _artist_mult(name: str, deezer_artist_id: str = "") -> float:
    try:
        return artist_recommendation_multiplier(name, deezer_artist_id=deezer_artist_id)
    except Exception:
        return 1.0

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
    owned_album_keys: set[str] | None = None,
    today: datetime.date | None = None,
) -> dict:
    """Return navigable catalog entities; never infer artists from video channels.

    Runs only in the feed's background worker. Each provider failure is isolated,
    and a deadline prevents a large library from causing unbounded fan-out.
    """
    deadline = time.monotonic() + 20
    failed = False
    ref_today = today or datetime.date.today()
    resolved_by_name: dict[str, dict | None] = {}
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
        wanted = literal_artist_key(name)
        if not wanted or not fold_text(name):
            return None
        if wanted in resolved_by_name:
            return resolved_by_name[wanted]
        matches = rows("search/artist", {"q": name, "limit": DEEZER_ARTIST_SEARCH_LIMIT})
        # A homonym or approximate search hit must not become a taste seed;
        # keep literal diacritic matches separate from folded fallbacks.
        valid_matches = [r for r in matches if str(r.get("id") or "").strip().isdigit()]
        exact = select_artist_matches(name, valid_matches, fans_key="nb_fan")
        match = exact[0] if exact else None
        seed = artist_item(match) if match else None
        resolved_by_name[wanted] = seed
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
            if item and item["id"] not in seen:
                seen.add(item["id"])
                artists.append(item)
    artists.sort(
        key=lambda item: _artist_mult(
            item["title"],
            item["external_ids"]["deezer_artist_id"],
        ),
        reverse=True,
    )
    artists = artists[:limit]

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

        def credited_artist(album_id: str, fallback: str) -> str:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return fallback
            try:
                album = deezer.get(f"album/{album_id}", timeout=min(3, remaining))
            except Exception:
                return fallback
            names = [name for _, name in main_contributors(album)] if isinstance(album, dict) else []
            return ", ".join(names) if len(names) > 1 else fallback

        raw_releases.sort(
            key=lambda entry: (
                _artist_mult(entry[3], entry[2]),
                entry[0],
                entry[1],
            ),
            reverse=True,
        )
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
            credited = credited_artist(aid, owner_name)
            new_releases.append({
                "id": f"deezer:album:{aid}",
                "type": "album",
                "source": "deezer",
                "title": title,
                "artist": credited,
                "subtitle": credited,
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
        # Prioritize related artists so "Albums for you" leads outward with
        # "Similar to {artist}" attribution; fall back to seed artists only when
        # related artists do not fill five album pools.
        seen_owners: set[str] = set()
        candidate_owners = sorted(
            [*artists, *seeds],
            key=lambda owner: _artist_mult(
                owner["title"],
                owner["external_ids"]["deezer_artist_id"],
            ),
            reverse=True,
        )
        for owner in candidate_owners:
            if len(album_pools) >= 5:
                break
            aid = owner["external_ids"]["deezer_artist_id"]
            if aid in seen_owners:
                continue
            seen_owners.add(aid)
            owner_name = owner["title"]
            releases = artist_albums(aid)
            pool = [
                {
                    **r,
                    "artist": {"id": aid, "name": owner_name},
                    "reason_artist": owner.get("reason_artist") or "",
                }
                for r in releases
                if (str(r.get("record_type") or "").strip().casefold() or "album") in _ALLOWED_RECORD_TYPES
                and str(r.get("id") or "") not in new_release_ids
                and not (
                    owned_album_keys
                    and identity_key(str(r.get("title") or "").strip(), owner_name) in owned_album_keys
                )
            ]
            if pool:
                album_pools.append(pool)

    albums: list[dict] = []
    seen_albums: set[str] = set(new_release_ids)
    per_artist: Counter = Counter()
    for round_items in zip_longest(*album_pools):
        for row in round_items:
            if not row:
                continue
            aid = str(row.get("id") or "")
            owner = row.get("artist") if isinstance(row.get("artist"), dict) else {}
            owner_id, name = str(owner.get("id") or ""), str(owner.get("name") or "").strip()
            title = str(row.get("title") or "").strip()
            rtype = str(row.get("record_type") or "").strip().casefold()
            if (not aid.isdigit() or not owner_id.isdigit() or not name or not title
                    or aid in seen_albums or per_artist[owner_id] >= 2
                    or (rtype and rtype not in _ALLOWED_RECORD_TYPES)
                    or (owned_album_keys and identity_key(title, name) in owned_album_keys)):
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
    albums.sort(
        key=lambda item: _artist_mult(
            item["artist"],
            item["external_ids"]["deezer_artist_id"],
        ),
        reverse=True,
    )
    albums = albums[:limit]
    browse_sections = [
        {"id": "new_releases", "popular": False, "items": new_releases},
        {"id": "artists", "popular": popular, "items": artists},
        {"id": "albums", "popular": popular, "items": albums},
    ]
    return {
        "browse_sections": [section for section in browse_sections if section["items"]],
        "browse_error": failed,
    }
