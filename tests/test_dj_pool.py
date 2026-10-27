"""Cold-cache fairness, measured bridge safety and full-library coverage."""

import copy
import threading
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from shared import dj_library
from shared.dj.contracts import fallback_analysis as _fallback
from shared.dj_engine import analysis_identity, order_continuous_route, plan_transition
from shared.dj_pool import add_measured_bridges


def measured(bpm=120):
    return {"analysed": True, "duration": 240, "bpm": bpm, "key": "C", "mode": "major",
            "confidence": .9, "tempo_confidence": 1., "note_rate": 2., "loudness_lufs": -14., "spectral_flatness": .05}


def test_bridge_improves_both_seams_and_preserves_every_original_start():
    seed, target, bridge = measured(100), measured(112), measured(106)
    route = order_continuous_route(seed, [({"id": "target"}, target), ({"id": "last"}, target)])
    snapshot = copy.deepcopy(route)
    result = add_measured_bridges(seed, route, [({"id": "bridge"}, bridge)])
    assert [row["id"] for row in result] == ["bridge", "target", "last"]
    assert result[0]["route_kind"] == "bridge"
    assert min(row["transition"]["score"] for row in result[:2]) > plan_transition(seed, target)["score"]
    previous = seed
    for row in result:
        assert row["transition"] == plan_transition(previous, row["analysis"])
        previous = row["analysis"]
    assert route == snapshot


@pytest.mark.parametrize("cold", ["seed", "target", "spare"])
def test_partial_coverage_never_selects_the_only_downloaded_bridge(cold):
    features = {"seed": measured(100), "target": measured(112), "spare": measured(106)}
    features[cold] = _fallback(240)
    route = order_continuous_route(features["seed"], [({"id": "target"}, features["target"])])
    spares = [({"id": "warm-bridge"}, measured(106)), ({"id": "unknown-competitor"}, features["spare"])]
    assert add_measured_bridges(features["seed"], route, spares) == route


def test_compatible_seam_and_useless_spares_add_no_delay():
    for tempo, spare in [(106, 103), (112, 150)]:
        seed = measured(100)
        route = order_continuous_route(seed, [({"id": "target"}, measured(tempo))])
        assert add_measured_bridges(seed, route, [({"id": "spare"}, measured(spare))]) == route


def test_library_sweep_continues_after_broken_files_and_honours_stop(tmp_path):
    paths = [tmp_path / str(i) for i in range(4)]
    for path in paths:
        path.write_bytes(b"audio")
    stop = threading.Event()
    seen = []
    def measure(path, identity, **kwargs):
        seen.append(identity)
        if identity == "0":
            raise OSError("deleted while reading")
        if identity == "2":
            stop.set()
    with (patch.object(dj_library, "analyse_audio", side_effect=measure),
          patch.object(dj_library, "cached_analysis", return_value=None),
          patch.object(dj_library, "requests_waiting", return_value=False)):
        dj_library.sweep_library(((str(p), p.name, 240) for p in paths), stop)
    assert seen == ["0", "1", "2"]


def test_library_sweep_waits_for_songs_a_dj_session_asked_for(tmp_path):
    # With the beat model a song costs seconds of CPU; after an analyser update
    # the session's songs must not queue behind the whole library.
    paths = [tmp_path / name for name in ("cached", "new")]
    for path in paths:
        path.write_bytes(b"audio")
    stop = threading.Event()
    seen, pending = [], {"waits": 0}

    def waiting():
        pending["waits"] += 1
        return pending["waits"] <= 3  # A session request finishes after three checks.

    with (patch.object(dj_library, "analyse_audio", side_effect=lambda path, identity, **_: seen.append((identity, pending["waits"]))),
          patch.object(dj_library, "cached_analysis", side_effect=lambda path, identity: {} if identity == "cached" else None),
          patch.object(dj_library, "requests_waiting", side_effect=waiting),
          patch.object(stop, "wait", return_value=False)):
        dj_library.sweep_library(((str(p), p.name, 240) for p in paths), stop)
    # A measured song is a cache hit and does not wait; the new one waits.
    assert seen == [("cached", 0), ("new", 4)]


def test_library_inventory_spans_accounts_and_skips_podcasts_missing_audio_and_duplicates(tmp_path):
    from shared.user_context import current_user_id
    def track(key, kind=None):
        return SimpleNamespace(id=key, media_kind=kind, duration=240)
    inventories = {"a": [track("one"), track("cloud"), track("podcast", "podcast_episode")],
                   "b": [track("one"), track("two")]}
    accounts = []
    def core(user_id):
        assert current_user_id() == user_id
        accounts.append(user_id)
        return SimpleNamespace(library=SimpleNamespace(metadata=SimpleNamespace(tracks=inventories[user_id])))
    with (patch("shared.users.list_users", return_value=[{"id": "a"}, {"id": "b"}]),
          patch("shared.api.get_user_core", side_effect=core),
          patch.object(dj_library, "resolve_local_track_path", side_effect=lambda t: None if t.id == "cloud" else str(tmp_path / t.id))):
        inventory = list(dj_library.library_inventory())
    assert accounts == ["a", "b"]
    assert [row[1] for row in inventory] == [analysis_identity({"track_id": key}) for key in ("one", "two")]


def test_bridge_legs_must_fit_the_players_rate_limit():
    # Each leg is more than 8 % apart, beyond the players' range.
    seed, target, spare = measured(100), measured(119), measured(109)
    assert plan_transition(seed, spare)["technique"] == "structural_fade"
    assert plan_transition(seed, spare)["playback_rate"] == 1
    route = order_continuous_route(seed, [({"id": "target"}, target)])
    assert add_measured_bridges(seed, route, [({"id": "spare"}, spare)]) == route


def test_bridge_can_repair_a_pair_beyond_the_players_rate_limit():
    seed, target = measured(100), measured(109)
    route = order_continuous_route(seed, [({"id": "target"}, target)])
    assert route[0]["transition"]["technique"] == "structural_fade"
    assert route[0]["transition"]["playback_rate"] == 1
    result = add_measured_bridges(seed, route, [({"id": "bridge"}, measured(104.5))])
    assert [row["id"] for row in result] == ["bridge", "target"]
    assert all(row["transition"]["playback_rate"] != 1 for row in result)


def test_unknown_tempo_cannot_bridge_using_the_fallback_120_bpm_period():
    seed, target = measured(114), measured(126)
    route = order_continuous_route(seed, [({"id": "target"}, target)])
    assert add_measured_bridges(seed, route, [({"id": "unknown"}, measured(0))]) == route
