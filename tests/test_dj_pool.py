"""Cold-cache fairness, measured bridge safety and full-library coverage."""

import copy
import threading
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from shared import dj_library
from shared.dj_engine import _fallback, analysis_identity, order_continuous_route, plan_transition
from shared.dj_pool import add_measured_bridges


def measured(bpm=120):
    return {"analysed": True, "duration": 240, "bpm": bpm, "key": "C", "mode": "major",
            "confidence": .9, "note_rate": 2., "loudness_lufs": -14., "spectral_flatness": .05}


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
    with patch.object(dj_library, "analyse_audio", side_effect=measure):
        dj_library.sweep_library(((str(p), p.name, 240) for p in paths), stop)
    assert seen == ["0", "1", "2"]


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
