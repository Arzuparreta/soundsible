import pytest

from shared.listening_planner import plan_generated_queue


def _candidate(item_id: str, pool: str, score: float, artist: str | None = None) -> dict:
    return {
        "id": item_id,
        "title": item_id,
        "artist": artist or f"Artist {item_id}",
        "score": score,
        "recommendation_identity": f"music:{item_id}",
        "source_pool": pool,
    }


def test_radio_stays_seed_focused_but_can_fall_back():
    pools = {
        "related": [_candidate(f"r{i}", "related", 1 - i / 100) for i in range(6)],
        "discovery": [_candidate("d1", "discovery", 0.9)],
        "local": [_candidate("l1", "local", 0.8)],
    }

    plan = plan_generated_queue(pools, intent="radio", limit=8)

    assert [item["source_pool"] for item in plan] == [
        "related",
        "related",
        "related",
        "related",
        "related",
        "related",
        "discovery",
        "local",
    ]


@pytest.mark.parametrize(
    ("profile", "expected_local"),
    [("familiar", 4), ("balanced", 2), ("explore", 1)],
)
def test_auto_mode_profiles_keep_the_existing_source_mix(profile, expected_local):
    pools = {
        pool: [_candidate(f"{pool}-{i}", pool, 1 - i / 100) for i in range(8)]
        for pool in ("local", "related", "discovery")
    }

    plan = plan_generated_queue(pools, intent="auto_mode", profile=profile, limit=8)

    assert sum(item["source_pool"] == "local" for item in plan) == expected_local
    assert len(plan) == 8


def test_plan_deduplicates_exclusions_and_caps_artist_repetition():
    pools = {
        "related": [
            _candidate("skip", "related", 1.0, "Repeated"),
            _candidate("r1", "related", 0.9, "Repeated"),
            _candidate("r2", "related", 0.8, "Repeated"),
            _candidate("r3", "related", 0.7, "Repeated"),
            _candidate("r4", "related", 0.6, "Other"),
        ],
        "discovery": [],
        "local": [],
    }

    plan = plan_generated_queue(
        pools,
        intent="autoplay",
        limit=8,
        exclude=["music:skip"],
    )

    assert [item["id"] for item in plan] == ["r1", "r2", "r4"]


def test_malformed_provider_score_does_not_break_the_plan():
    candidate = _candidate("r1", "related", 0.5)
    candidate["score"] = "unknown"

    plan = plan_generated_queue({"related": [candidate]}, intent="radio")

    assert [item["id"] for item in plan] == ["r1"]


def test_invalid_intent_and_profile_are_rejected():
    with pytest.raises(ValueError):
        plan_generated_queue({}, intent="search")
    with pytest.raises(ValueError):
        plan_generated_queue({}, intent="auto_mode", profile="chaos")


def test_auto_session_entropy_is_retry_stable_but_varies_between_sessions():
    pools = {
        pool: [_candidate(f"{pool}-{i}", pool, 0.8) for i in range(16)]
        for pool in ("local", "related", "discovery")
    }

    first = plan_generated_queue(
        pools,
        intent="auto_mode",
        profile="balanced",
        entropy="session-a:0",
    )
    retry = plan_generated_queue(
        pools,
        intent="auto_mode",
        profile="balanced",
        entropy="session-a:0",
    )
    another_session = plan_generated_queue(
        pools,
        intent="auto_mode",
        profile="balanced",
        entropy="session-b:0",
    )

    assert [item["id"] for item in first] == [item["id"] for item in retry]
    assert [item["id"] for item in first] != [item["id"] for item in another_session]
    assert sum(item["source_pool"] == "local" for item in first) == 2


def test_auto_normalises_channel_aliases_before_applying_artist_cap():
    pools = {
        "related": [
            _candidate("one", "related", 1.0, "KREAM"),
            _candidate("two", "related", 0.9, "KREAM - Topic"),
            _candidate("three", "related", 0.8, "KREAM Official"),
            _candidate("other", "related", 0.7, "Another Artist"),
        ],
    }

    plan = plan_generated_queue(
        pools,
        intent="auto_mode",
        profile="balanced",
        entropy="alias-session:0",
    )

    assert sum(item["artist"].startswith("KREAM") for item in plan) == 1


def test_a_shallow_local_pool_is_a_preference_not_a_mandatory_repeat():
    pools = {
        "local": [_candidate("only-compatible-local", "local", 0.95)],
        "related": [_candidate(f"related-{i}", "related", 0.8) for i in range(16)],
        "discovery": [_candidate(f"discovery-{i}", "discovery", 0.8) for i in range(16)],
    }

    appearances = sum(
        any(
            item["id"] == "only-compatible-local"
            for item in plan_generated_queue(
                pools,
                intent="auto_mode",
                profile="balanced",
                entropy=f"session-{index}:0",
            )
        )
        for index in range(32)
    )

    assert 0 < appearances < 32


def test_auto_counts_recent_context_artists_before_building_the_next_segment():
    pools = {
        "related": [
            _candidate("same", "related", 1.0, "KREAM"),
            _candidate("collab", "related", 0.95, "KREAM and KOROLOVA"),
            _candidate("next", "related", 0.9, "ARTBAT"),
        ],
    }

    plan = plan_generated_queue(
        pools,
        intent="auto_mode",
        profile="balanced",
        entropy="context-session:1",
        context_artists=["KREAM"],
    )

    assert [item["id"] for item in plan] == ["next"]
