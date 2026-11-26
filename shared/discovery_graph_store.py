"""Persistent federated artist similarity graph, consensus scoring, MMR, and release projection."""

from __future__ import annotations

import datetime
import logging
import math
import threading
import time
from typing import Any

from shared.database import instance_db
from shared.deezer_catalog import (
    DEEZER_ARTIST_SEARCH_LIMIT,
    literal_artist_key,
    main_contributors,
    select_artist_matches,
)
from shared.discovery_intelligence import (
    artist_recommendation_multiplier,
    is_artist_demoted,
)
from shared.providers import deezer
from shared.text_utils import fold_text, identity_key

logger = logging.getLogger(__name__)

_RELATED_TTL_SEC = 21 * 86400
_RELEASES_TTL_SEC = 24 * 3600
_ALLOWED_RECORD_TYPES = frozenset({"album", "ep", "single"})
_RECENT_BADGE_DAYS = 30

_PROVIDER_WEIGHTS = {
    "deezer": 1.00,
    "lastfm": 1.00,
    "listenbrainz": 1.10,
    "youtube": 0.65,
}

_INFLIGHT_LOCK = threading.Lock()
_RELEASES_INFLIGHT: set[str] = set()


def _safe_int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    try:
        return int(value or default)
    except (TypeError, ValueError):
        return default


def _parse_release_date(value: object) -> datetime.date | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.date.fromisoformat(text)
    except ValueError:
        return None


def _node_from_deezer_row(row: dict[str, Any], *, now: int) -> dict[str, Any] | None:
    aid = str(row.get("id") or "").strip()
    name = str(row.get("name") or "").strip()
    if not aid.isdigit() or not name:
        return None
    return {
        "deezer_artist_id": aid,
        "name": name,
        "literal_key": literal_artist_key(name),
        "folded_key": fold_text(name),
        "nb_fan": max(0, _safe_int(row.get("nb_fan"), 0)),
        "picture_url": deezer.image(row, "picture"),
        "updated_at": now,
    }


def resolve_artist_node(
    name: str,
    *,
    deezer_id: str = "",
    deadline: float | None = None,
    now: int | None = None,
) -> dict[str, Any] | None:
    """Resolve an artist name or Deezer ID using instance.db first, then Deezer."""
    now_ts = int(now if now is not None else time.time())
    db = instance_db()
    clean_id = str(deezer_id or "").strip()
    clean_name = str(name or "").strip()
    lit = literal_artist_key(clean_name)
    folded = fold_text(clean_name)

    if clean_id.isdigit():
        existing = db.get_graph_nodes_by_ids([clean_id]).get(clean_id)
        if existing:
            return existing
        if clean_name and lit and folded:
            stub = {
                "deezer_artist_id": clean_id,
                "name": clean_name,
                "literal_key": lit,
                "folded_key": folded,
                "nb_fan": 0,
                "picture_url": "",
                "updated_at": now_ts,
            }
            db.upsert_graph_nodes([stub], now=now_ts)
            return db.get_graph_nodes_by_ids([clean_id]).get(clean_id) or stub

    if not lit or not folded:
        return None

    cached = db.find_graph_node_by_literal(lit)
    if cached:
        return cached

    if deadline is not None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        timeout = min(3.0, remaining)
    else:
        timeout = 5.0

    try:
        response = deezer.get(
            "search/artist",
            {"q": clean_name, "limit": DEEZER_ARTIST_SEARCH_LIMIT},
            timeout=timeout,
        )
    except deezer.DeezerQuotaError:
        raise
    except Exception:
        return None
    if not isinstance(response, dict) or response.get("error"):
        return None
    rows = response.get("data")
    if not isinstance(rows, list):
        return None
    valid = [r for r in rows if isinstance(r, dict) and str(r.get("id") or "").strip().isdigit()]
    exact = select_artist_matches(clean_name, valid, fans_key="nb_fan")
    if not exact:
        return None
    node = _node_from_deezer_row(exact[0], now=now_ts)
    if not node:
        return None
    db.upsert_graph_nodes([node], now=now_ts)
    return db.get_graph_nodes_by_ids([node["deezer_artist_id"]]).get(node["deezer_artist_id"]) or node


def sync_related_artists(
    seed_nodes: list[dict[str, Any]],
    *,
    ttl_sec: int = _RELATED_TTL_SEC,
    max_sync: int = 6,
    deadline: float | None = None,
    now: int | None = None,
) -> bool:
    """Incrementally hydrate Deezer related-artist edges into instance.db within quota budget."""
    now_ts = int(now if now is not None else time.time())
    db = instance_db()
    synced = 0
    failed = False
    seen: set[str] = set()

    for node in seed_nodes:
        aid = str(node.get("deezer_artist_id") or "").strip()
        if not aid.isdigit() or aid in seen:
            continue
        seen.add(aid)
        last_sync = _safe_int(node.get("related_synced_at"), 0)
        if last_sync > 0 and (now_ts - last_sync) <= ttl_sec:
            continue
        if synced >= max_sync:
            break
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                failed = True
                break
            timeout = min(3.0, remaining)
        else:
            timeout = 5.0
        synced += 1
        try:
            response = deezer.get(f"artist/{aid}/related", {"limit": 20}, timeout=timeout)
        except deezer.DeezerQuotaError:
            failed = True
            break
        except Exception:
            failed = True
            continue
        if not isinstance(response, dict) or response.get("error"):
            failed = True
            continue
        raw_rows = response.get("data")
        rows = [r for r in raw_rows if isinstance(r, dict)] if isinstance(raw_rows, list) else []
        target_nodes: list[dict[str, Any]] = []
        edges: list[tuple[str, int, float]] = []
        rank_pos = 0
        for row in rows:
            target = _node_from_deezer_row(row, now=now_ts)
            if not target:
                continue
            tid = target["deezer_artist_id"]
            if tid == aid:
                continue
            rank_pos += 1
            target_nodes.append(target)
            weight = _PROVIDER_WEIGHTS["deezer"] / math.log2(1.0 + rank_pos)
            edges.append((tid, rank_pos, round(weight, 6)))
        if target_nodes:
            db.upsert_graph_nodes(target_nodes, now=now_ts)
        db.replace_similarity_edges(aid, "deezer", edges, now_ts)
    return failed


def project_youtube_mix_edges(
    metadata,
    seed_nodes: list[dict[str, Any]],
    *,
    now: int | None = None,
) -> int:
    """Project cached YouTube related-mix co-occurrences into artist similarity edges (zero network)."""
    if not metadata or not getattr(metadata, "tracks", None) or not seed_nodes:
        return 0
    now_ts = int(now if now is not None else time.time())
    db = instance_db()
    seed_by_literal = {
        str(node.get("literal_key") or ""): str(node.get("deezer_artist_id") or "")
        for node in seed_nodes
        if node.get("literal_key") and str(node.get("deezer_artist_id") or "").isdigit()
    }
    if not seed_by_literal:
        return 0

    vid_to_seed: dict[str, str] = {}
    for track in metadata.tracks:
        if getattr(track, "media_kind", None) == "podcast_episode":
            continue
        vid = str(getattr(track, "youtube_id", "") or "").strip()
        if not vid:
            continue
        lit = literal_artist_key(getattr(track, "album_artist", None) or getattr(track, "artist", None) or "")
        seed_id = seed_by_literal.get(lit)
        if seed_id:
            vid_to_seed[vid] = seed_id
            if len(vid_to_seed) >= 200:
                break
    if not vid_to_seed:
        return 0

    cached_mixes = db.get_related_mixes(vid_to_seed.keys())
    if not cached_mixes:
        return 0

    candidate_literals: set[str] = set()
    parsed_pairs: list[tuple[str, str, int]] = []
    for vid, rows in cached_mixes.items():
        seed_id = vid_to_seed.get(vid)
        if not seed_id or not isinstance(rows, list):
            continue
        for pos, row in enumerate(rows[:15], start=1):
            if not isinstance(row, dict):
                continue
            if row.get("artist_is_channel"):
                continue
            artist_name = str(row.get("artist") or row.get("channel") or row.get("uploader") or "").strip()
            lit = literal_artist_key(artist_name)
            if not lit:
                continue
            candidate_literals.add(lit)
            parsed_pairs.append((seed_id, lit, pos))

    if not parsed_pairs:
        return 0
    resolved_targets = db.find_graph_nodes_by_literals(candidate_literals)
    if not resolved_targets:
        return 0

    edges: list[tuple[str, str, int, float]] = []
    for seed_id, lit, pos in parsed_pairs:
        target = resolved_targets.get(lit)
        if not target:
            continue
        target_id = str(target.get("deezer_artist_id") or "")
        if not target_id or target_id == seed_id:
            continue
        weight = _PROVIDER_WEIGHTS["youtube"] / math.log2(1.0 + pos)
        edges.append((seed_id, target_id, pos, round(weight, 6)))
    if not edges:
        return 0
    db.merge_similarity_edges("youtube", edges, now_ts)
    return len(edges)


def impression_fatigue_multiplier(
    impression: dict[str, Any] | None,
    *,
    now: int | None = None,
) -> float:
    """Return [0.2..1.0] exposure cooling factor; resets to 1.0 after positive interaction."""
    if not impression:
        return 1.0
    last_shown = _safe_int(impression.get("last_shown_at"), 0)
    last_interacted = _safe_int(impression.get("last_interacted_at"), 0)
    shown_count = max(0, _safe_int(impression.get("shown_count"), 0))
    if shown_count <= 0 or last_interacted >= last_shown:
        return 1.0
    now_ts = int(now if now is not None else time.time())
    age_days = max(0.0, (now_ts - last_shown) / 86400.0)
    effective_shows = shown_count * math.pow(0.5, age_days / 10.0)
    return 1.0 / (1.0 + 0.50 * effective_shows)


def score_consensus_candidates(
    seed_weights: dict[str, float],
    seed_names_by_id: dict[str, str],
    *,
    exclude_artist_ids: set[str] | None = None,
    exclude_folded_names: set[str] | None = None,
    extra_candidate_boosts: dict[str, tuple[float, str, str]] | None = None,
    impressions: dict[str, dict[str, Any]] | None = None,
    now: int | None = None,
    limit: int = 40,
) -> list[dict[str, Any]]:
    """Rank outward candidate artists by multi-seed consensus, provider diversity, and hub IDF."""
    if not seed_weights:
        return []
    now_ts = int(now if now is not None else time.time())
    db = instance_db()
    max_seed_w = max((float(w) for w in seed_weights.values()), default=1.0) or 1.0
    norm_weights = {sid: max(0.0, float(w)) / max_seed_w for sid, w in seed_weights.items()}

    edges = db.get_similarity_edges_for_sources(seed_weights.keys())
    excluded_ids = set(exclude_artist_ids or ()) | set(seed_weights.keys())
    excluded_names = set(exclude_folded_names or ()) | {
        fold_text(name) for name in seed_names_by_id.values() if fold_text(name)
    }

    seed_best_edge: dict[str, dict[str, float]] = {}
    candidate_providers: dict[str, set[str]] = {}
    for row in edges:
        src = str(row.get("source_artist_id") or "").strip()
        dst = str(row.get("target_artist_id") or "").strip()
        prov = str(row.get("provider") or "").strip()
        weight = float(row.get("weight") or 0.0)
        if not src or not dst or dst in excluded_ids or weight <= 0:
            continue
        per_seed = seed_best_edge.setdefault(dst, {})
        if weight > per_seed.get(src, 0.0):
            per_seed[src] = weight
        if prov:
            candidate_providers.setdefault(dst, set()).add(prov)

    if extra_candidate_boosts:
        for dst, (boost_w, prov, sample_seed) in extra_candidate_boosts.items():
            if not dst or dst in excluded_ids or boost_w <= 0:
                continue
            per_seed = seed_best_edge.setdefault(dst, {})
            anchor = sample_seed if sample_seed in norm_weights else f"__ext__{prov or 'cf'}"
            if boost_w > per_seed.get(anchor, 0.0):
                per_seed[anchor] = float(boost_w)
            if prov:
                candidate_providers.setdefault(dst, set()).add(prov)

    if not seed_best_edge:
        return []

    candidate_ids = list(seed_best_edge.keys())
    nodes = db.get_graph_nodes_by_ids(candidate_ids)
    in_degrees = db.get_target_in_degrees(candidate_ids)

    scored: list[dict[str, Any]] = []
    for cid in candidate_ids:
        node = nodes.get(cid)
        if not node:
            continue
        name = str(node.get("name") or "").strip()
        folded = str(node.get("folded_key") or fold_text(name))
        if not name or not folded or folded in excluded_names:
            continue

        contributions: dict[str, float] = {}
        for sid, edge_w in seed_best_edge[cid].items():
            seed_w = norm_weights.get(sid, 1.0)
            contributions[sid] = seed_w * edge_w

        base_vote = sum(contributions.values())
        if base_vote <= 0:
            continue

        supporting_seeds = len(contributions)
        distinct_providers = len(candidate_providers.get(cid, {"deezer"}))
        consensus = 1.0 + 0.35 * math.log(max(1, supporting_seeds)) + 0.25 * max(0, distinct_providers - 1)

        in_deg = max(1, in_degrees.get(cid, 1))
        nb_fan = max(0, _safe_int(node.get("nb_fan"), 0))
        deg_factor = 1.0 / (math.log2(2.0 + in_deg) ** 0.35)
        fan_excess = max(0.0, math.log10(max(1, nb_fan)) - 5.5)
        fan_factor = 1.0 / (1.0 + 0.12 * fan_excess)
        hub_penalty = deg_factor * fan_factor

        feedback_mult = artist_recommendation_multiplier(name, deezer_artist_id=cid)
        demoted = is_artist_demoted(name, deezer_artist_id=cid)
        imp = impressions.get(f"deezer:artist:{cid}") if impressions else None
        fatigue = impression_fatigue_multiplier(imp, now=now_ts)

        final_score = base_vote * consensus * hub_penalty * feedback_mult * fatigue
        seed_contributions = {sid: contrib for sid, contrib in contributions.items() if sid in seed_names_by_id}
        top_seed_id = max(seed_contributions, key=lambda sid: seed_contributions[sid]) if seed_contributions else ""
        reason_artist = seed_names_by_id.get(top_seed_id, "")

        scored.append({
            "id": f"deezer:artist:{cid}",
            "type": "artist",
            "source": "deezer",
            "title": name,
            "artist": name,
            "cover": str(node.get("picture_url") or ""),
            "external_ids": {"deezer_artist_id": cid},
            "reason_artist": reason_artist,
            "score": round(final_score, 6),
            "supporting_seeds": supporting_seeds,
            "distinct_providers": distinct_providers,
            "nb_fan": nb_fan,
            "_supporting_seed_ids": set(contributions.keys()),
            "_demoted": demoted,
        })

    scored.sort(
        key=lambda item: (
            not item["_demoted"],
            float(item["score"]),
            int(item["supporting_seeds"]),
            int(item["nb_fan"]),
        ),
        reverse=True,
    )
    return scored[:limit]


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    union = len(a | b)
    return (len(a & b) / union) if union else 0.0


def select_mmr_diverse(
    candidates: list[dict[str, Any]],
    *,
    limit: int = 10,
    lam: float = 0.72,
    neighbor_sets: dict[str, set[str]] | None = None,
) -> list[dict[str, Any]]:
    """Diversify consensus candidates via Maximal Marginal Relevance over graph neighborhoods."""
    if not candidates or limit <= 0:
        return []
    eligible = [c for c in candidates if not c.get("_demoted")]
    demoted = [c for c in candidates if c.get("_demoted")]
    if len(eligible) <= 1:
        combined = [*eligible, *demoted]
        return combined[:limit]

    cids = [str(c["external_ids"]["deezer_artist_id"]) for c in eligible]
    if neighbor_sets is None:
        edges = instance_db().get_similarity_edges_for_sources(cids)
        neighbor_sets = {}
        for row in edges:
            src = str(row.get("source_artist_id") or "")
            dst = str(row.get("target_artist_id") or "")
            if src and dst:
                neighbor_sets.setdefault(src, set()).add(dst)

    contexts: dict[str, set[str]] = {}
    for cand in eligible:
        cid = str(cand["external_ids"]["deezer_artist_id"])
        supporters = set(cand.get("_supporting_seed_ids") or ())
        contexts[cid] = supporters | set(neighbor_sets.get(cid, ())) | {cid}

    max_score = max((float(c.get("score") or 0.0) for c in eligible), default=1.0) or 1.0
    pool = list(eligible)
    selected: list[dict[str, Any]] = []

    while pool and len(selected) < limit:
        best_idx = 0
        best_mmr = -1e9
        for idx, cand in enumerate(pool):
            cid = str(cand["external_ids"]["deezer_artist_id"])
            rel = float(cand.get("score") or 0.0) / max_score
            if not selected:
                mmr = rel
            else:
                max_sim = max(
                    _jaccard(
                        contexts[cid],
                        contexts[str(sel["external_ids"]["deezer_artist_id"])],
                    )
                    for sel in selected
                )
                mmr = lam * rel - (1.0 - lam) * max_sim
            if mmr > best_mmr:
                best_mmr = mmr
                best_idx = idx
        selected.append(pool.pop(best_idx))

    if len(selected) < limit and demoted:
        selected.extend(demoted[: limit - len(selected)])
    return selected


def select_2hop_exploration(
    seed_ids: list[str],
    hop1_ids: set[str],
    *,
    exclude_artist_ids: set[str],
    exclude_folded_names: set[str],
    seed_names_by_id: dict[str, str],
    impressions: dict[str, dict[str, Any]] | None = None,
    limit: int = 2,
) -> list[dict[str, Any]]:
    """Select unseen 2nd-hop graph candidates supported by >= 2 hop-1 neighbors (zero network)."""
    if not seed_ids or not hop1_ids or limit <= 0:
        return []
    db = instance_db()
    rows = db.get_2hop_candidates(seed_ids, hop1_ids, limit=limit * 6)
    if not rows:
        return []
    nodes = db.get_graph_nodes_by_ids([str(r["target_artist_id"]) for r in rows])
    out: list[dict[str, Any]] = []
    for row in rows:
        if len(out) >= limit:
            break
        cid = str(row["target_artist_id"])
        if cid in exclude_artist_ids:
            continue
        node = nodes.get(cid)
        if not node:
            continue
        name = str(node.get("name") or "").strip()
        folded = str(node.get("folded_key") or fold_text(name))
        if not name or not folded or folded in exclude_folded_names:
            continue
        if is_artist_demoted(name, deezer_artist_id=cid):
            continue
        if impressions and _safe_int((impressions.get(f"deezer:artist:{cid}") or {}).get("shown_count"), 0) > 0:
            continue
        sample_seed = str(row.get("sample_seed_id") or "")
        out.append({
            "id": f"deezer:artist:{cid}",
            "type": "artist",
            "source": "deezer",
            "title": name,
            "artist": name,
            "cover": str(node.get("picture_url") or ""),
            "external_ids": {"deezer_artist_id": cid},
            "reason_artist": seed_names_by_id.get(sample_seed, ""),
            "score": round(float(row.get("path_score") or 0.1), 6),
            "exploration": True,
        })
    return out


def select_diverse_track_anchors(
    profile_entries: list[Any],
    seed_nodes_by_key: dict[str, dict[str, Any]],
    *,
    limit: int = 3,
    lam: float = 0.72,
) -> list[Any]:
    """Select diverse taste anchors for 'More like X' shelves using MMR over graph neighborhoods."""
    if not profile_entries or limit <= 0:
        return []
    candidates = list(profile_entries[:15])
    if len(candidates) <= 1 or limit == 1:
        return candidates[:limit]

    seed_ids = [
        str(seed_nodes_by_key[e.artist_key]["deezer_artist_id"])
        for e in candidates
        if e.artist_key in seed_nodes_by_key
        and str(seed_nodes_by_key[e.artist_key].get("deezer_artist_id") or "").isdigit()
    ]
    edges = instance_db().get_similarity_edges_for_sources(seed_ids) if seed_ids else []
    neighbors_by_id: dict[str, set[str]] = {}
    for row in edges:
        src = str(row.get("source_artist_id") or "")
        dst = str(row.get("target_artist_id") or "")
        if src and dst:
            neighbors_by_id.setdefault(src, set()).add(dst)

    def context_for(entry) -> set[str]:
        node = seed_nodes_by_key.get(entry.artist_key)
        aid = str(node.get("deezer_artist_id") or "") if node else ""
        if aid and neighbors_by_id.get(aid):
            return neighbors_by_id[aid] | {aid}
        return {f"key:{entry.artist_key}"}

    contexts = {e.artist_key: context_for(e) for e in candidates}
    selected: list[Any] = []
    remaining = list(candidates)

    # Anchor 1: strongest long-term core (fallback effective_score).
    anchor1 = max(
        remaining,
        key=lambda e: (float(e.long_term_score), float(e.effective_score)),
    )
    selected.append(anchor1)
    remaining.remove(anchor1)

    if remaining and len(selected) < limit:
        # Anchor 2: active short-term interest distinct from Anchor 1 (falling back only when none are active).
        has_short_term = any(float(e.short_term_score) > 0 for e in remaining)
        if has_short_term:
            denom = max(float(e.short_term_score) for e in remaining) or 1.0
        else:
            denom = max((float(e.effective_score) for e in remaining), default=1.0) or 1.0

        def anchor2_rel(entry: Any) -> float:
            raw = float(entry.short_term_score) if has_short_term else float(entry.effective_score)
            return raw / denom

        best = max(
            remaining,
            key=lambda e: (
                lam * anchor2_rel(e)
                - (1.0 - lam) * _jaccard(contexts[e.artist_key], contexts[anchor1.artist_key])
            ),
        )
        selected.append(best)
        remaining.remove(best)

    while remaining and len(selected) < limit:
        max_eff = max((float(e.effective_score) for e in remaining), default=1.0) or 1.0
        best = max(
            remaining,
            key=lambda e: (
                lam * (float(e.effective_score) / max_eff)
                - (1.0 - lam) * max(_jaccard(contexts[e.artist_key], contexts[s.artist_key]) for s in selected)
            ),
        )
        selected.append(best)
        remaining.remove(best)

    return selected


def load_artist_discography(
    artist_id: str,
    *,
    owner_name: str = "",
    timeout: float = 5.0,
    ttl_sec: int = _RELEASES_TTL_SEC,
    now: int | None = None,
) -> list[dict]:
    """Read the full provider response shared by artist pages and release rails."""
    db = instance_db()
    now_ts = int(time.time() if now is None else now)
    snapshot = db.get_artist_discography(artist_id)
    if snapshot and now_ts - snapshot[0] <= ttl_sec:
        if owner_name:
            db.mark_artist_discography_synced(artist_id, snapshot[0])
        return snapshot[1]

    # The provider coalesces concurrent requests with the same path and params.
    from shared import deezer_catalog

    response = deezer_catalog.deezer_get(f"artist/{artist_id}/albums", {"limit": 100}, timeout=timeout)
    raw_rows = response.get("data")
    if response.get("error") or not isinstance(raw_rows, list):
        raise ValueError("Invalid Deezer artist discography")
    rows = [row for row in raw_rows if isinstance(row, dict)]
    releases = []
    for row in rows:
        album_id = str(row.get("id") or "").strip()
        title = str(row.get("title") or "").strip()
        record_type = str(row.get("record_type") or "").strip().casefold() or "album"
        release_date = _parse_release_date(row.get("release_date"))
        if not album_id.isdigit() or not title or record_type not in _ALLOWED_RECORD_TYPES or release_date is None:
            continue
        artist = row.get("artist")
        credit = owner_name or (str(artist.get("name") or "") if isinstance(artist, dict) else "")
        releases.append({
            "deezer_album_id": album_id,
            "title": title,
            "artist_credit": credit,
            "record_type": record_type,
            "release_date": release_date.isoformat(),
            "cover_url": deezer.image(row, "cover"),
        })
    db.upsert_artist_releases(artist_id, releases, now_ts, discography=rows)
    return rows


def sync_artist_releases(
    artist_nodes: list[dict[str, Any]],
    *,
    ttl_sec: int = _RELEASES_TTL_SEC,
    max_sync: int = 8,
    deadline: float | None = None,
    now: int | None = None,
) -> tuple[bool, bool]:
    """Incrementally sync artist discographies into instance.db (single-flight per artist).

    Returns ``(failed, had_stale)``.
    """
    now_ts = int(now if now is not None else time.time())
    failed = False
    had_stale = False
    synced = 0
    seen: set[str] = set()

    for node in artist_nodes:
        aid = str(node.get("deezer_artist_id") or "").strip()
        owner_name = str(node.get("name") or "").strip()
        if not aid.isdigit() or aid in seen:
            continue
        seen.add(aid)
        last_sync = _safe_int(node.get("releases_synced_at"), 0)
        if last_sync > 0 and (now_ts - last_sync) <= ttl_sec:
            continue
        had_stale = True
        if synced >= max_sync:
            continue
        with _INFLIGHT_LOCK:
            if aid in _RELEASES_INFLIGHT:
                continue
            _RELEASES_INFLIGHT.add(aid)
        synced += 1
        try:
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    failed = True
                    continue
                timeout = min(3.0, remaining)
            else:
                timeout = 5.0
            load_artist_discography(
                aid, owner_name=owner_name, timeout=timeout, ttl_sec=ttl_sec, now=now_ts,
            )
        except deezer.DeezerQuotaError:
            failed = True
            break
        except Exception:
            failed = True
        finally:
            with _INFLIGHT_LOCK:
                _RELEASES_INFLIGHT.discard(aid)

    return failed, had_stale


def _resolve_album_credit(
    album_id: str,
    fallback: str,
    *,
    deadline: float | None = None,
) -> str:
    if deadline is not None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return fallback
        timeout = min(3.0, remaining)
    else:
        timeout = 4.0
    try:
        album = deezer.get(f"album/{album_id}", timeout=timeout)
    except Exception:
        return fallback
    names = [name for _, name in main_contributors(album)] if isinstance(album, dict) else []
    credit = ", ".join(names) if len(names) > 1 else fallback
    if isinstance(album, dict) and not album.get("error"):
        try:
            instance_db().update_release_credit(album_id, credit)
        except Exception:
            pass
    return credit


def build_release_rail(
    artist_weights: dict[str, float],
    *,
    window_days: int,
    exclude_album_keys: set[str] | None = None,
    exclude_album_ids: set[str] | None = None,
    reason_by_artist: dict[str, str] | None = None,
    artist_names_by_id: dict[str, str] | None = None,
    max_per_artist: int = 2,
    limit: int = 10,
    today: datetime.date | None = None,
    deadline: float | None = None,
    verify_credits: bool = True,
) -> list[dict[str, Any]]:
    """Project cached releases into a chronological release shelf shared by Home and Discover."""
    if not artist_weights or limit <= 0:
        return []
    ref_today = today or datetime.date.today()
    min_date = (ref_today - datetime.timedelta(days=window_days)).isoformat()
    max_date = ref_today.isoformat()

    rows = instance_db().get_artist_releases(artist_weights.keys(), min_release_date=min_date)
    if not rows:
        return []

    filtered: list[tuple[datetime.date, float, int, dict[str, Any]]] = []
    for row in rows:
        rel_str = str(row.get("release_date") or "").strip()
        if not rel_str or rel_str > max_date or rel_str < min_date:
            continue
        rel_date = _parse_release_date(rel_str)
        if rel_date is None:
            continue
        owner_id = str(row.get("artist_deezer_id") or "").strip()
        owner_name = (artist_names_by_id or {}).get(owner_id) or str(row.get("artist_credit") or "").strip()
        if not owner_id.isdigit() or not owner_name:
            continue
        affinity = float(artist_weights.get(owner_id, 0.0))
        filtered.append((rel_date, affinity, _safe_int(row.get("deezer_album_id"), 0), row))

    filtered.sort(key=lambda entry: entry[:3], reverse=True)

    out: list[dict[str, Any]] = []
    seen_albums = set(exclude_album_ids or ())
    per_artist: dict[str, int] = {}

    for rel_date, _, album_num, row in filtered:
        if len(out) >= limit:
            break
        album_id = str(album_num)
        owner_id = str(row.get("artist_deezer_id") or "")
        title = str(row.get("title") or "").strip()
        owner_name = (artist_names_by_id or {}).get(owner_id) or str(row.get("artist_credit") or "").strip()
        if not album_id or album_id in seen_albums or per_artist.get(owner_id, 0) >= max_per_artist:
            continue
        if exclude_album_keys and identity_key(title, owner_name) in exclude_album_keys:
            continue

        credit = str(row.get("artist_credit") or "").strip() or owner_name
        if verify_credits and not row.get("credit_verified"):
            credit = _resolve_album_credit(album_id, owner_name, deadline=deadline)

        seen_albums.add(album_id)
        per_artist[owner_id] = per_artist.get(owner_id, 0) + 1
        out.append({
            "id": f"deezer:album:{album_id}",
            "type": "album",
            "source": "deezer",
            "title": title,
            "artist": credit,
            "subtitle": credit,
            "cover": str(row.get("cover_url") or ""),
            "record_type": str(row.get("record_type") or "album"),
            "release_date": rel_date.isoformat(),
            "is_new": (ref_today - rel_date).days <= _RECENT_BADGE_DAYS,
            "external_ids": {"deezer_album_id": album_id, "deezer_artist_id": owner_id},
            "reason_artist": (reason_by_artist or {}).get(owner_id, ""),
        })

    return out
