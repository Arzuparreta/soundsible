"""Opt-in ListenBrainz and Last.fm read-back federation into the shared discovery graph."""
from __future__ import annotations

import logging
import math
import threading
import time
from typing import Any

from shared.database import instance_db
from shared.deezer_catalog import literal_artist_key
from shared.discovery_graph_store import resolve_artist_node
from shared.discovery_intelligence import load_discovery_settings
from shared.scrobble.clients import LastFmClient, ListenBrainzClient
from shared.scrobble.service import LASTFM, LISTENBRAINZ, lastfm_app
from shared.scrobble.store import ScrobbleStore, decrypt_secret
from shared.user_context import user_context

logger = logging.getLogger(__name__)

_LASTFM_TTL_SEC = 21 * 86400
_LB_TTL_SEC = 6 * 3600
_MAX_LASTFM_SEEDS = 4
_MAX_RESOLVES_PER_SYNC = 6

_FED_LOCK = threading.Lock()
_LB_MEMO: dict[tuple[str, str, str], tuple[float, dict[str, tuple[float, str, str]]]] = {}
_LB_INFLIGHT: set[tuple[str, str, str]] = set()


def clear_federation_cache() -> None:
    """Reset in-memory ListenBrainz recommendation memo state (for tests)."""
    with _FED_LOCK:
        _LB_MEMO.clear()
        _LB_INFLIGHT.clear()


def _resolve_artist_budgeted(
    name: str,
    *,
    db: Any,
    budget: list[int],
    deadline: float | None,
    now_ts: int,
) -> dict[str, Any] | None:
    """Resolve an artist via local instance.db first, spending Deezer budget only when needed."""
    lit = literal_artist_key(name)
    if not lit:
        return None
    cached = db.find_graph_node_by_literal(lit)
    if cached:
        return cached
    if budget[0] <= 0:
        return None
    if deadline is not None and time.monotonic() >= deadline:
        return None
    budget[0] -= 1
    try:
        return resolve_artist_node(name, deadline=deadline, now=now_ts)
    except Exception:
        return None


def _sync_lastfm_edges(
    seed_entries: list[Any],
    *,
    connections: dict[str, dict[str, Any]],
    budget: list[int],
    deadline: float | None,
    now_ts: int,
) -> None:
    conn = connections.get(LASTFM)
    if not conn or not conn.get("enabled") or conn.get("needs_reconnect"):
        return
    app = lastfm_app()
    if not app or not app.api_key:
        return

    db = instance_db()
    client = LastFmClient(app.api_key, app.api_secret)
    synced = 0

    for entry in seed_entries:
        if synced >= _MAX_LASTFM_SEEDS:
            break
        if deadline is not None and time.monotonic() >= deadline:
            break
        name = str(getattr(entry, "display_name", "") or "").strip()
        did = str(getattr(entry, "deezer_artist_id", "") or "").strip()
        if not name:
            continue
        seed_node = _resolve_artist_budgeted(name, db=db, budget=budget, deadline=deadline, now_ts=now_ts)
        if not seed_node and did.isdigit():
            seed_node = db.get_graph_nodes_by_ids([did]).get(did)
        if not seed_node:
            continue
        last_sync = int(seed_node.get("lastfm_synced_at") or 0)
        if last_sync > 0 and (now_ts - last_sync) <= _LASTFM_TTL_SEC:
            continue

        src_id = str(seed_node["deezer_artist_id"])
        if deadline is not None and time.monotonic() >= deadline:
            break
        reply = client.artist_similar(str(seed_node.get("name") or name), limit=20)
        if not reply.ok:
            continue
        synced += 1

        peers = reply.data.get("artists") or []
        edges: list[tuple[str, int, float]] = []
        seen_targets: set[str] = {src_id}
        truncated = False
        for rank_pos, peer in enumerate(peers):
            if deadline is not None and time.monotonic() >= deadline:
                truncated = True
                break
            peer_name = str(peer.get("name") or "").strip()
            lit_peer = literal_artist_key(peer_name)
            if not lit_peer:
                continue
            target = db.find_graph_node_by_literal(lit_peer)
            if not target:
                if budget[0] <= 0:
                    truncated = True
                    continue
                target = _resolve_artist_budgeted(peer_name, db=db, budget=budget, deadline=deadline, now_ts=now_ts)
            if not target:
                continue
            target_id = str(target.get("deezer_artist_id") or "")
            if not target_id or target_id in seen_targets:
                continue
            seen_targets.add(target_id)
            match_val = max(0.0, min(1.0, float(peer.get("match") or 0.0)))
            rank_weight = 1.0 / math.log2(2.0 + rank_pos)
            weight = 0.6 * match_val + 0.4 * rank_weight if match_val > 0 else rank_weight
            edges.append((target_id, rank_pos, round(weight, 6)))
        if truncated:
            # Partial resolution must never wipe existing edges or stamp the 21-day TTL.
            if edges:
                db.merge_similarity_edges(
                    "lastfm",
                    [(src_id, dst, rank_pos, weight) for dst, rank_pos, weight in edges],
                    now_ts,
                )
        else:
            db.replace_similarity_edges(src_id, "lastfm", edges, now_ts)


def _extract_lb_artists(meta_entry: Any) -> list[str]:
    if not isinstance(meta_entry, dict):
        return []
    artist_block = meta_entry.get("artist")
    if not isinstance(artist_block, dict):
        return []
    out: list[str] = []
    artists = artist_block.get("artists")
    if isinstance(artists, list):
        for item in artists:
            if isinstance(item, dict):
                name = str(item.get("artist_mb_name") or item.get("name") or "").strip()
                if name and name not in out:
                    out.append(name)
    if not out:
        fallback = str(artist_block.get("name") or "").strip()
        if fallback:
            out.append(fallback)
    return out


def _sync_listenbrainz_boosts(
    user_id: str,
    *,
    connections: dict[str, dict[str, Any]],
    budget: list[int],
    deadline: float | None,
    now_ts: int,
) -> dict[str, tuple[float, str, str]]:
    conn = connections.get(LISTENBRAINZ)
    if not conn or not conn.get("enabled") or conn.get("needs_reconnect"):
        return {}
    username = str(conn.get("username") or "").strip()
    secret_enc = str(conn.get("secret_enc") or "")
    server = str(conn.get("server") or "").strip()
    if not username or not secret_enc:
        return {}

    memo_key = (user_id, username, server)
    now_mono = time.time()
    stale_fallback: dict[str, tuple[float, str, str]] = {}
    with _FED_LOCK:
        cached = _LB_MEMO.get(memo_key)
        if cached and cached[0] > now_mono:
            return dict(cached[1])
        if cached:
            stale_fallback = dict(cached[1])
        if memo_key in _LB_INFLIGHT:
            return stale_fallback
        _LB_INFLIGHT.add(memo_key)

    try:
        token = decrypt_secret(secret_enc)
        if not token:
            return {}
        client = ListenBrainzClient(token, server=server, maloja=False)
        artist_scores: dict[str, float] = {}
        display_names: dict[str, str] = {}
        any_ok = False

        if deadline is None or time.monotonic() < deadline:
            cf_reply = client.cf_recommendations(username, count=50)
            if cf_reply.ok:
                any_ok = True
                mbid_rows = cf_reply.data.get("mbids") or []
                mbid_list = [row["recording_mbid"] for row in mbid_rows[:50]]
                if mbid_list and (deadline is None or time.monotonic() < deadline):
                    meta_reply = client.recording_metadata(mbid_list)
                    recordings = meta_reply.data.get("recordings") or {} if meta_reply.ok else {}
                    for rank_pos, row in enumerate(mbid_rows[:50]):
                        rec = recordings.get(row["recording_mbid"])
                        artists = _extract_lb_artists(rec)
                        base_score = 1.0 / math.log2(2.0 + rank_pos)
                        for art_name in artists[:2]:
                            lit = literal_artist_key(art_name)
                            if not lit:
                                continue
                            display_names.setdefault(lit, art_name)
                            artist_scores[lit] = min(1.35, artist_scores.get(lit, 0.0) + base_score * 0.55)

        if deadline is None or time.monotonic() < deadline:
            fr_reply = client.fresh_releases(username, days=14)
            if fr_reply.ok:
                any_ok = True
                for rel in (fr_reply.data.get("releases") or [])[:25]:
                    credit = str(rel.get("artist_credit_name") or "").strip()
                    if not credit and isinstance(rel.get("artists"), list) and rel["artists"]:
                        first = rel["artists"][0]
                        if isinstance(first, dict):
                            credit = str(first.get("artist_credit_name") or first.get("artist_name") or "").strip()
                    lit = literal_artist_key(credit)
                    if not lit:
                        continue
                    display_names.setdefault(lit, credit)
                    artist_scores[lit] = min(1.35, artist_scores.get(lit, 0.0) + 0.75)

        if not any_ok:
            return stale_fallback

        db = instance_db()
        boosts: dict[str, tuple[float, str, str]] = {}
        truncated = False
        ranked = sorted(artist_scores.items(), key=lambda pair: pair[1], reverse=True)
        for lit, boost_w in ranked[:12]:
            name = display_names[lit]
            node = db.find_graph_node_by_literal(lit)
            if not node:
                if budget[0] <= 0 or (deadline is not None and time.monotonic() >= deadline):
                    truncated = True
                    continue
                node = _resolve_artist_budgeted(name, db=db, budget=budget, deadline=deadline, now_ts=now_ts)
            if not node:
                continue
            aid = str(node.get("deezer_artist_id") or "")
            if aid.isdigit() and boost_w > 0:
                boosts[aid] = (round(boost_w, 6), "listenbrainz", "")

        if not (artist_scores and not boosts and truncated):
            with _FED_LOCK:
                _LB_MEMO[memo_key] = (time.time() + _LB_TTL_SEC, dict(boosts))
        return boosts
    except Exception as exc:
        logger.debug("ListenBrainz federation skipped: %s", exc)
        return stale_fallback
    finally:
        with _FED_LOCK:
            _LB_INFLIGHT.discard(memo_key)


def sync_federated_signals(
    user_id: str | None,
    seed_entries: list[Any],
    *,
    deadline: float | None = None,
    now: int | None = None,
) -> dict[str, tuple[float, str, str]]:
    """Ingest opt-in Last.fm similarity edges and ListenBrainz boosts for Discover."""
    if not user_id:
        return {}
    with user_context(str(user_id)):
        if not load_discovery_settings().get("learning_enabled", True):
            return {}
        try:
            connections = ScrobbleStore(str(user_id)).connections()
        except Exception:
            return {}
        if not connections:
            return {}

        now_ts = int(now if now is not None else time.time())
        lastfm_budget = [_MAX_RESOLVES_PER_SYNC]
        lb_budget = [_MAX_RESOLVES_PER_SYNC]

        try:
            _sync_lastfm_edges(
                seed_entries,
                connections=connections,
                budget=lastfm_budget,
                deadline=deadline,
                now_ts=now_ts,
            )
        except Exception as exc:
            logger.debug("Last.fm federation skipped: %s", exc)

        return _sync_listenbrainz_boosts(
            str(user_id),
            connections=connections,
            budget=lb_budget,
            deadline=deadline,
            now_ts=now_ts,
        )
