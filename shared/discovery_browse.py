"""Bounded metadata enrichment for Discover and Home release rails."""
from __future__ import annotations

from collections import Counter
import datetime
from itertools import zip_longest
import time
from typing import Any

from shared.database import instance_db
from shared.deezer_catalog import literal_artist_key
from shared.discovery_graph_store import (
    build_release_rail,
    find_companion_singles,
    project_youtube_mix_edges,
    resolve_artist_node,
    score_consensus_candidates,
    select_2hop_exploration,
    select_mmr_diverse,
    sync_artist_releases,
    sync_related_artists,
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
_RELEASE_RADAR_WINDOW_DAYS = 45


def build_browse_sections(
    seed_names: list[str],
    limit: int = 10,
    *,
    release_seeds: list[dict[str, Any]] | None = None,
    seed_weights: dict[str, float] | None = None,
    profile_artist_keys: set[str] | None = None,
    profile_artist_ids: set[str] | None = None,
    owned_album_keys: set[str] | None = None,
    metadata: Any = None,
    extra_candidate_boosts: dict[str, tuple[float, str, str]] | None = None,
    impressions: dict[str, dict[str, Any]] | None = None,
    today: datetime.date | None = None,
) -> dict:
    """Return outward Discover shelves: Release Radar, Artists to discover, and Albums for you.

    Runs only in the feed's background worker. Each provider failure is isolated,
    and a deadline prevents a large library from causing unbounded fan-out.
    """
    del release_seeds  # Pins and user release checks now live strictly on Home New Releases.
    deadline = time.monotonic() + 20
    failed = False
    ref_today = today or datetime.date.today()
    db = instance_db()

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

    popular = not seed_names
    artists: list[dict] = []
    release_radar: list[dict] = []
    albums: list[dict] = []
    consensus_pool: list[dict] = []

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

        seen_albums: set[str] = set()
        per_artist: Counter = Counter()
        for row in rows("chart/0/albums", {"limit": 30}):
            aid = str(row.get("id") or "")
            owner = row.get("artist") if isinstance(row.get("artist"), dict) else {}
            owner_id, name = str(owner.get("id") or ""), str(owner.get("name") or "").strip()
            title = str(row.get("title") or "").strip()
            rtype = str(row.get("record_type") or "").strip().casefold()
            if (
                not aid.isdigit()
                or not owner_id.isdigit()
                or not name
                or not title
                or aid in seen_albums
                or per_artist[owner_id] >= 2
                or (rtype and rtype not in _ALLOWED_RECORD_TYPES)
                or (owned_album_keys and identity_key(title, name) in owned_album_keys)
            ):
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
                "reason_artist": "",
            })
        albums.sort(
            key=lambda item: _artist_mult(
                item["artist"],
                item["external_ids"]["deezer_artist_id"],
            ),
            reverse=True,
        )
        albums = albums[:limit]
    else:
        seed_nodes: list[dict[str, Any]] = []
        seed_weight_by_id: dict[str, float] = {}
        seed_names_by_id: dict[str, str] = {}
        seed_folded_names: set[str] = set()
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
            try:
                project_youtube_mix_edges(metadata, seed_nodes)
            except Exception:
                pass

        consensus_pool = score_consensus_candidates(
            seed_weight_by_id,
            seed_names_by_id,
            exclude_artist_ids=seen_seed_ids,
            exclude_folded_names=seed_folded_names,
            extra_candidate_boosts=extra_candidate_boosts,
            impressions=impressions,
            limit=max(40, limit * 4),
        )
        primary_artists = select_mmr_diverse(consensus_pool, limit=limit)
        artists = primary_artists
        if limit >= 6 and consensus_pool:
            hop1_ids = {
                str(c["external_ids"]["deezer_artist_id"])
                for c in consensus_pool
                if c.get("external_ids", {}).get("deezer_artist_id")
            }
            keep_count = max(0, limit - 2)
            protected = primary_artists[:keep_count]
            explore = select_2hop_exploration(
                list(seen_seed_ids),
                hop1_ids,
                exclude_artist_ids=seen_seed_ids
                | {
                    str(a["external_ids"]["deezer_artist_id"])
                    for a in protected
                    if a.get("external_ids", {}).get("deezer_artist_id")
                },
                exclude_folded_names=seed_folded_names
                | {fold_text(a["title"]) for a in protected if fold_text(a["title"])},
                seed_names_by_id=seed_names_by_id,
                impressions=impressions,
                limit=2,
            )
            if explore:
                explore_ids = {item["id"] for item in explore}
                remaining_primary = [item for item in primary_artists if item["id"] not in explore_ids]
                head = remaining_primary[: max(0, limit - len(explore))]
                artists = [*head, *explore][:limit]

        # Hydrate discographies once for the top outward consensus artists (shared
        # cleanly between Release Radar and Albums for you).
        radar_candidates = [
            candidate for candidate in consensus_pool
            if candidate["reason_artist"] and not candidate["_demoted"]
            and literal_artist_key(candidate["title"]) not in (profile_artist_keys or ())
            and candidate["external_ids"]["deezer_artist_id"] not in (profile_artist_ids or ())
        ][: max(15, min(20, limit * 2))]
        seed_owner_items = [
            {
                "id": f"deezer:artist:{s['deezer_artist_id']}",
                "type": "artist",
                "source": "deezer",
                "title": seed_names_by_id.get(str(s["deezer_artist_id"]), str(s["name"])),
                "artist": seed_names_by_id.get(str(s["deezer_artist_id"]), str(s["name"])),
                "external_ids": {"deezer_artist_id": str(s["deezer_artist_id"])},
                "reason_artist": "",
                "score": 0.0,
            }
            for s in seed_nodes
        ]
        candidate_owners = sorted(
            [*artists, *seed_owner_items],
            key=lambda owner: (
                _artist_mult(owner["title"], owner["external_ids"]["deezer_artist_id"]),
                float(owner.get("score") or 0.0),
            ),
            reverse=True,
        )
        candidate_owners.extend(radar_candidates)
        album_owner_ids: list[str] = []
        seen_owner_ids: set[str] = set()
        for owner in candidate_owners:
            oid = str(owner["external_ids"]["deezer_artist_id"])
            if oid in seen_owner_ids:
                continue
            seen_owner_ids.add(oid)
            album_owner_ids.append(oid)

        radar_owners = {str(c["external_ids"]["deezer_artist_id"]): c for c in radar_candidates}
        # Spend the first batch on artists who can actually populate Radar.
        # Keep the album shelf ranking separate from network hydration order.
        sync_ids = list(dict.fromkeys([*radar_owners, *album_owner_ids]))
        cached_nodes = db.get_graph_nodes_by_ids(sync_ids)
        sync_nodes = [cached_nodes[aid] for aid in sync_ids if aid in cached_nodes]
        release_batch = 10
        rel_failed, _ = sync_artist_releases(sync_nodes, max_sync=release_batch, deadline=deadline)
        failed |= rel_failed

        companion_singles: dict[str, str] = {}

        def project_radar() -> list[dict]:
            first_date = (ref_today - datetime.timedelta(days=_RELEASE_RADAR_WINDOW_DAYS)).isoformat()
            rows = db.get_artist_releases(radar_owners, min_release_date=first_date)
            companion_singles.update(find_companion_singles([
                row for row in rows
                if row["release_date"] <= ref_today.isoformat()
                and identity_key(row["title"], radar_owners[row["artist_deezer_id"]]["title"]) not in (owned_album_keys or ())
            ], deadline=deadline))
            return build_release_rail(
                {aid: float(c["score"]) for aid, c in radar_owners.items()},
                window_days=_RELEASE_RADAR_WINDOW_DAYS,
                exclude_album_keys=owned_album_keys,
                exclude_album_ids=set(companion_singles),
                reason_by_artist={aid: c["reason_artist"] for aid, c in radar_owners.items()},
                artist_names_by_id={aid: str(c["title"]) for aid, c in radar_owners.items()},
                max_per_artist=2,
                limit=limit,
                today=ref_today,
                deadline=deadline,
            )

        if radar_owners:
            release_radar = project_radar()
            # Check the remaining ranked artists when the first batch yields
            # releases from fewer than two artists. Keep the shared deadline.
            represented_artists = {item["external_ids"]["deezer_artist_id"] for item in release_radar}
            if len(represented_artists) < 2 and not rel_failed and len(radar_owners) > release_batch:
                remaining_nodes = db.get_graph_nodes_by_ids(radar_owners)
                rel_failed, had_stale = sync_artist_releases(
                    [remaining_nodes[aid] for aid in radar_owners if aid in remaining_nodes],
                    max_sync=len(radar_owners) - release_batch,
                    deadline=deadline,
                )
                failed |= rel_failed
                if had_stale:
                    release_radar = project_radar()

        # 2) Albums for you: full-catalog discovery reusing the exact same cache.
        radar_album_ids = {
            str(item["external_ids"]["deezer_album_id"])
            for item in release_radar
            if item.get("external_ids", {}).get("deezer_album_id")
        }
        radar_album_ids.update(single for single, album in companion_singles.items() if album in radar_album_ids)
        owner_meta = {
            str(owner["external_ids"]["deezer_artist_id"]): (
                str(owner["title"]),
                str(owner.get("reason_artist") or ""),
            )
            for owner in candidate_owners
        }
        cached_releases = db.get_artist_releases(album_owner_ids)
        by_owner: dict[str, list[dict[str, Any]]] = {}
        for row in cached_releases:
            oid = str(row.get("artist_deezer_id") or "")
            by_owner.setdefault(oid, []).append(row)

        album_pools: list[list[dict[str, Any]]] = []
        for oid in album_owner_ids:
            if len(album_pools) >= 5:
                break
            owner_name, owner_reason = owner_meta.get(oid, ("", ""))
            pool = []
            for row in by_owner.get(oid, []):
                album_id = str(row.get("deezer_album_id") or "")
                title = str(row.get("title") or "").strip()
                rtype = str(row.get("record_type") or "album").strip().casefold() or "album"
                if (
                    not album_id
                    or album_id in radar_album_ids
                    or rtype not in _ALLOWED_RECORD_TYPES
                    or (owned_album_keys and identity_key(title, owner_name) in owned_album_keys)
                ):
                    continue
                pool.append({
                    **row,
                    "owner_name": owner_name,
                    "reason_artist": owner_reason,
                })
            if pool:
                album_pools.append(pool)

        seen_albums = set(radar_album_ids)
        per_artist = Counter()
        for round_items in zip_longest(*album_pools):
            for row in round_items:
                if not row:
                    continue
                album_id = str(row.get("deezer_album_id") or "")
                owner_id = str(row.get("artist_deezer_id") or "")
                name = str(row.get("owner_name") or row.get("artist_credit") or "").strip()
                title = str(row.get("title") or "").strip()
                rtype = str(row.get("record_type") or "album").strip().casefold() or "album"
                if (
                    not album_id.isdigit()
                    or not owner_id.isdigit()
                    or not name
                    or not title
                    or album_id in seen_albums
                    or per_artist[owner_id] >= 2
                ):
                    continue
                seen_albums.add(album_id)
                per_artist[owner_id] += 1
                albums.append({
                    "id": f"deezer:album:{album_id}",
                    "type": "album",
                    "source": "deezer",
                    "title": title,
                    "artist": name,
                    "subtitle": name,
                    "cover": str(row.get("cover_url") or ""),
                    "record_type": rtype,
                    "release_date": str(row.get("release_date") or "").strip(),
                    "external_ids": {"deezer_album_id": album_id, "deezer_artist_id": owner_id},
                    "reason_artist": str(row.get("reason_artist") or ""),
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
        {"id": "release_radar", "popular": False, "items": release_radar},
        {"id": "artists", "popular": popular, "items": clean_artists},
        {"id": "albums", "popular": popular, "items": albums},
    ]
    return {
        "browse_sections": [section for section in browse_sections if section["items"]],
        "browse_error": failed,
        "_consensus_artists": consensus_pool if not popular else [],
    }
