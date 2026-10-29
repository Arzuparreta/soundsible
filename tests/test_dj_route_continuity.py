"""Route ordering with measured quantities, without listener ratings."""

import copy

import pytest

from shared.dj.contracts import fallback_analysis as _fallback
from shared.dj_engine import order_continuous_route, plan_transition

import test_dj_sections as sections


def measured(**features):
    return {**sections.measured(bpm=features.get("bpm", 120)), "note_rate": 2., "loudness_lufs": -14.,
            "spectral_flatness": .05, **features}


def candidate(identity, **features):
    return ({"id": identity}, measured(**features))


def ids(route):
    return [row["id"] for row in route]


@pytest.mark.parametrize("feature,origin,near,far", [
    ("note_rate", 1., 2., 8.),
    ("loudness_lufs", -20., -18., -7.),
    ("spectral_flatness", .01, .03, .4),
    ("bpm", 120., 121., 136.),
])
def test_each_physical_magnitude_prefers_continuity(feature, origin, near, far):
    seed = measured(**{feature: origin})
    pool = [candidate("far", **{feature: far}), candidate("near", **{feature: near})]
    assert ids(order_continuous_route(seed, pool)) == ["near", "far"]


def test_harmonic_transition_quality_breaks_equal_continuity():
    seed = measured()
    pool = [candidate("parallel", mode="minor"), candidate("relative", key="A", mode="minor")]
    route = order_continuous_route(seed, pool)
    assert ids(route) == ["relative", "parallel"]
    assert route[0]["transition"]["score"] > plan_transition(seed, pool[0][1])["score"]


def test_reorders_each_seam_from_the_chosen_predecessor_and_does_not_mutate_inputs():
    seed = measured(note_rate=1.)
    pool = [candidate("eight", note_rate=8.), candidate("four", note_rate=4.), candidate("two", note_rate=2.)]
    snapshot = copy.deepcopy(pool)
    route = order_continuous_route(seed, pool)
    assert ids(route) == ["two", "four", "eight"]
    previous = seed
    for row in route:
        assert row["transition"] == plan_transition(previous, row["analysis"])
        previous = row["analysis"]
    assert pool == snapshot


def test_dimensions_have_equal_influence_after_scaling_and_do_not_depend_on_units():
    seed = measured(note_rate=1., loudness_lufs=-20., spectral_flatness=.01)
    pool = [candidate("a", note_rate=4., loudness_lufs=-19., spectral_flatness=.3),
            candidate("b", note_rate=2., loudness_lufs=-17., spectral_flatness=.03),
            candidate("c", note_rate=8., loudness_lufs=-7., spectral_flatness=.5)]
    baseline = ids(order_continuous_route(seed, pool))
    assert baseline[0] == "b"
    # Any change of units or zero point leaves the same geometry. Deliberately
    # exchange the note and loudness axes as well: neither gets a taste weight.
    def converted(analysis):
        return {**analysis, "note_rate": analysis["loudness_lufs"] * 60 + 2000,
                "loudness_lufs": analysis["note_rate"] * .001 - 50,
                "spectral_flatness": analysis["spectral_flatness"] * 100}
    assert ids(order_continuous_route(converted(seed), [(item, converted(a)) for item, a in pool])) == baseline


def test_tempo_octaves_describe_the_same_pulse():
    seed = measured()
    pool = [candidate("half", bpm=60), candidate("fast", bpm=130), candidate("double", bpm=240)]
    assert ids(order_continuous_route(seed, pool)) == ["half", "double", "fast"]


@pytest.mark.parametrize("missing", [None, float("nan"), float("inf")])
def test_incomplete_dimensions_are_omitted_for_every_candidate(missing):
    seed = measured(note_rate=1.)
    pool = [candidate("unknown-loudness", note_rate=2., loudness_lufs=missing),
            candidate("known-loudness", note_rate=8., loudness_lufs=-14.)]
    assert ids(order_continuous_route(seed, pool)) == ["unknown-loudness", "known-loudness"]


def test_zero_is_a_measurement_and_constant_dimensions_keep_stable_ties():
    seed = measured(note_rate=0., spectral_flatness=0.)
    assert ids(order_continuous_route(seed, [candidate("active", note_rate=8.),
                                            candidate("silent", note_rate=0.)])) == ["silent", "active"]
    pool = [candidate("z"), candidate("a"), candidate("b")]
    assert ids(order_continuous_route(measured(), pool)) == ["z", "a", "b"]
    assert order_continuous_route(seed, []) == []
    assert ids(order_continuous_route(seed, pool[:1])) == ["z"]


def test_cold_songs_keep_their_slots_and_do_not_lose_to_downloaded_music():
    pool = [candidate("far", note_rate=8.), ({"id": "cold"}, _fallback(240)),
            candidate("near", note_rate=2.), candidate("middle", note_rate=4.)]
    route = order_continuous_route(measured(note_rate=1.), pool)
    assert ids(route) == ["near", "cold", "far", "middle"]
    assert route[1]["transition"]["confidence"] < .35
    # After the cold row the DJ cannot compare seams and keeps shuffled order.
    assert route[2]["transition"]["confidence"] < .35
    assert ids(order_continuous_route(_fallback(240), pool)) == ["far", "cold", "near", "middle"]
    assert ids(order_continuous_route(measured(), [(item, _fallback(240)) for item, _ in pool])) == [
        "far", "cold", "near", "middle",
    ]


def test_recommendation_scores_and_source_weights_cannot_change_the_chosen_set():
    pool = [({"id": "far", "score": 1., "semantic_score": 1., "source_weight": 1.}, measured(note_rate=8.)),
            ({"id": "near", "score": 0., "semantic_score": 0., "source_weight": 0.}, measured(note_rate=2.))]
    assert ids(order_continuous_route(measured(note_rate=1.), pool)) == ["near", "far"]
