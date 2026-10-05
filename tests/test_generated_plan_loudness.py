"""Accepted plan measurements belong to account-owned content identities."""
from types import SimpleNamespace
from unittest.mock import patch

from shared.api.routes.auto_mode import _annotate_plan_loudness


def test_plan_facts_use_recording_hash_and_preserve_selection():
    metadata = SimpleNamespace(tracks=[SimpleNamespace(id="owned", file_hash="recording-hash", duration=120)])
    items = [
        {"source": "library", "track_id": "owned", "id": "owned", "score": 3},
        {"source": "preview", "id": "video", "loudness_lufs": -12},
        {"source": "library", "track_id": "another-account", "loudness_lufs": -12},
    ]
    with patch("shared.loudness.LoudnessStore") as store:
        store.return_value.measured_for.return_value = {"recording-hash": (-20.254, -3.456)}
        result = _annotate_plan_loudness(metadata, items)
        assert list(store.return_value.measured_for.call_args.args[0]) == ["recording-hash"]
    assert result[0] == {"source": "library", "track_id": "owned", "id": "owned", "score": 3, "duration": 120, "loudness_lufs": -20.25, "loudness_peak_dbtp": -3.46}
    assert all("loudness_lufs" not in row for row in result[1:])
    assert all("file_hash" not in row for row in result)
    assert "loudness_lufs" not in items[0]
    assert items[1]["loudness_lufs"] == -12


def test_unavailable_meter_keeps_selected_tracks_unmeasured():
    metadata = SimpleNamespace(tracks=[SimpleNamespace(id="owned", file_hash="new-recording", duration=120)])
    with patch("shared.loudness.LoudnessStore", side_effect=RuntimeError("cache unavailable")):
        result = _annotate_plan_loudness(metadata, [{"source": "library", "track_id": "owned", "loudness_lufs": -12}])
    assert result == [{"source": "library", "track_id": "owned", "duration": 120}]
