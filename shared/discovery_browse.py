"""Bounded metadata enrichment for Discover and Home release rails."""
from __future__ import annotations

from collections import Counter
import datetime
from itertools import zip_longest
import time
from typing import Any

from shared.discovery_graph_store import (
    project_youtube_mix_edges,
    resolve_artist_node,
    score_consensus_candidates,
    select_mmr_diverse,
    sync_related_artists,
)
from shared.discovery_intelligence import artist_recommendation_multiplier
from shared.deezer_catalog import main_contributors
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
    release_seeds: list[dict[str, Any]] | None = None,
    seed_weights: dict[str, float] | None = None,
    owned_album_keys: set[str] | None = None,
    metadata: Any = None,
    extra_candidate_boosts: dict[str, tuple[float, str, str]] | None = None,
    impressions: dict[str, dict[str, Any]] | None = None,
    today: datetime.date | None = None,
) -> dict:
    """Return navigable catalog entities using persistent graph consensus and MMR diversity.

    Runs only in the feed's background worker. Each provider failure is isolated,
    and a deadline prevents a large library from causing unbounded fan-out.
    """
    deadline = time.monotonic() + 20
    failed = False
    ref_today = today or datetime.date.today()
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

    def artist_albums(aid: str) -> list[dict]:
        if aid not in albums_by_artist:
            albums_by_artist[aid] = rows(f"artist/{aid}/albums", {"limit": 20})
        return albums_by_artist[aid]

    popular = not seed_names and not release_seeds
    artists: list[dict] = []
    seed_nodes: list[dict[str, Any]] = []
    seed_weight_by_id: dict[str, float] = {}
    seed_names_by_id: dict[str, str] = {}
    seed_folded_names: set[str] = set()

    if popular:
        seen_pop: set[str] = set()
        for row in rows("chart/0/artists", {"limit": 20}):
            item = artist_item(row)
            if item and item["id"] not in seen_pop:
                seen_pop.add(item["id"])
                artists.append(item)
        artists.sort(
            key=lambda item: _artist_mult(
                item["title"],
                item["external_ids"]["deezer_artist_id"],
            ),
            reverse=True,
        )
        artists = artists[:limit]
    else:
        seen_seed_ids: set[str] = set()
        for idx, name in enumerate(seed_names[:25]):
            if time.monotonic() >= deadline:
                failed = True
                break
            try:
                node = resolve_artist_node(name, deadline=deadline)
            except deezer.DeezerQuotaError:
                failed = True
                break
            except Exception:
                failed = True
                continue
            if not node:
                continue
            aid = str(node.get("deezer_artist_id") or "")
            if not aid.isdigit() or aid in seen_seed_ids:
                continue
            seen_seed_ids.add(aid)
            seed_nodes.append(node)
            weight = float((seed_weights or {}).get(name, 1.0 / (1.0 + idx * 0.15)))
            seed_weight_by_id[aid] = weight
            seed_names_by_id[aid] = name
            folded = fold_text(name)
            if folded:
                seed_folded_names.add(folded)

        if sync_related_artists(seed_nodes, max_sync=6, deadline=deadline):
            failed = True
        if metadata is not None and seed_nodes:
            project_youtube_mix_edges(metadata, seed_nodes)

        consensus_pool = score_consensus_candidates(
            seed_weight_by_id,
            seed_names_by_id,
            exclude_artist_ids=seen_seed_ids,
            exclude_folded_names=seed_folded_names,
            extra_candidate_boosts=extra_candidate_boosts,
            impressions=impressions,
            limit=max(40, limit * 4),
        )
        artists = select_mmr_diverse(consensus_pool, limit=limit)

    new_releases: list[dict] = []
    new_release_ids: set[str] = set()
    if not popular:
        candidates = (
            release_seeds[:_MAX_RELEASE_OWNERS]
            if release_seeds is not None
            else [
                {"name": seed_names_by_id[str(s["deezer_artist_id"])], "deezer_id": str(s["deezer_artist_id"])}
                for s in seed_nodes[:_MAX_RELEASE_OWNERS]
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
                try:
                    resolved_node = resolve_artist_node(cname, deadline=deadline)
                except Exception:
                    resolved_node = None
                if not resolved_node:
                    continue
                owner_id = str(resolved_node["deezer_artist_id"])
                owner_name = str(resolved_node["name"])
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
        seed_owner_items = [
            {
                "id": f"deezer:artist:{s['deezer_artist_id']}",
                "type": "artist",
                "source": "deezer",
                "title": seed_names_by_id.get(str(s["deezer_artist_id"]), str(s["name"])),
                "artist": seed_names_by_id.get(str(s["deezer_artist_id"]), str(s["name"])),
                "external_ids": {"deezer_artist_id": str(s["deezer_artist_id"])},
                "reason_artist": "",
            }
            for s in seed_nodes
        ]
        seen_owners: set[str] = set()
        candidate_owners = sorted(
            [*artists, *seed_owner_items],
            key=lambda owner: (
                _artist_mult(owner["title"], owner["external_ids"]["deezer_artist_id"]),
                float(owner.get("score") or 0.0),
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
    clean_artists = [
        {k: v for k, v in item.items() if not k.startswith("_") and k != "score"}
        for item in artists
    ]
    browse_sections = [
        {"id": "new_releases", "popular": False, "items": new_releases},
        {"id": "artists", "popular": popular, "items": clean_artists},
        {"id": "albums", "popular": popular, "items": albums},
    ]
    return {
        "browse_sections": [section for section in browse_sections if section["items"]],
        "browse_error": failed,
        "_consensus_artists": artists if not popular else [],
    }
