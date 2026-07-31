from unittest.mock import patch

from shared.api.routes.discovery import (
    _planner_item_from_related,
    _resolve_generated_playback,
)


def _lyrics_upload():
    return _planner_item_from_related({
        "id": "lyrics00001",
        "title": "KREAM - Arrival (Lyrics)",
        "channel": "Lyrics Cloud",
        "duration": 180,
    })


def test_generated_song_keeps_its_graph_node_but_plays_official_audio():
    item = _lyrics_upload()
    assert item is not None
    best = {
        "id": "official001",
        "title": "KREAM - Arrival",
        "channel": "KREAM - Topic",
        "duration": 180,
        "confidence": 0.95,
    }

    with patch(
        "shared.api.routes.catalog._resolve_candidates",
        return_value=(best, [best]),
    ):
        resolved = _resolve_generated_playback(item, None)

    assert resolved["youtube_id"] == "official001"
    assert resolved["discovery_youtube_id"] == "lyrics00001"
    assert resolved["playback_source_kind"] == "official_audio"
    assert resolved["recommendation_identity"] == item["recommendation_identity"]


def test_generated_song_never_substitutes_a_different_version():
    item = _lyrics_upload()
    assert item is not None
    remix = {
        "id": "remix000001",
        "title": "KREAM - Arrival (Remix)",
        "channel": "KREAM - Topic",
        "duration": 180,
        "confidence": 0.95,
    }

    with patch(
        "shared.api.routes.catalog._resolve_candidates",
        return_value=(remix, [remix]),
    ):
        resolved = _resolve_generated_playback(item, None)

    assert resolved["youtube_id"] == "lyrics00001"
