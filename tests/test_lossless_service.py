from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from shared.lossless.models import LosslessCandidate
from shared.lossless.service import MAX_TRACKS_PER_DAY, LosslessUpgradeService, Preempted
from shared.lossless.store import LosslessStore
from shared.models import LibraryMetadata, Track


def _track(path: Path) -> Track:
    return Track(
        id="stable-id",
        title="Song",
        artist="Artist",
        album="Album",
        duration=180,
        file_hash="old-hash",
        original_filename=path.name,
        compressed=True,
        file_size=path.stat().st_size,
        bitrate=128,
        format="m4a",
        youtube_id="dQw4w9WgXcQ",
    )


def _candidate() -> LosslessCandidate:
    return LosslessCandidate(
        provider="jamendo",
        source_id="42",
        title="Song",
        artist="Artist",
        album="Album",
        duration=180,
        download_url="https://prod-1.storage.jamendo.com/42.flac",
        webpage_url="https://www.jamendo.com/track/42",
        license_url="https://creativecommons.org/licenses/by/4.0/",
        format="flac",
    )


class Provider:
    name = "jamendo"
    available = True

    def __init__(self, rows=None, error=None):
        self.rows = rows or []
        self.error = error
        self.calls = 0

    def search(self, track, *, limit=3):
        self.calls += 1
        if self.error:
            raise self.error
        return self.rows[:limit]


def test_store_persists_queue_cache_and_daily_budget(tmp_path):
    store = LosslessStore(tmp_path / "instance.db")
    assert store.enqueue("a", "youtube") is True
    assert store.enqueue("a", "youtube") is False
    assert store.next_ready()["track_id"] == "a"
    store.cache_put("a", "jamendo", [{"source_id": "x"}], 60)
    assert store.cache_get("a", "jamendo") == [{"source_id": "x"}]
    store.add_budget("2026-07-30", tracks=1, bytes_downloaded=10)
    assert store.budget("2026-07-30") == {
        "tracks_examined": 1,
        "bytes_downloaded": 10,
    }


def test_worker_never_contacts_provider_while_foreground_is_busy(tmp_path, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_LOSSLESS_UPGRADES", "true")
    audio = tmp_path / "song.m4a"
    audio.write_bytes(b"audio")
    provider = Provider([_candidate()])
    service = LosslessUpgradeService(
        store=LosslessStore(tmp_path / "instance.db"),
        providers=[provider],
        foreground_busy=lambda: True,
        inventory=lambda: [(_track(audio), str(audio))],
        quiet_seconds=0,
    )
    assert service.run_once_if_idle() is False
    assert provider.calls == 0


def test_inventory_is_gradual_and_only_enqueues_youtube_lossy_music(tmp_path, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_LOSSLESS_UPGRADES", "true")
    audio = tmp_path / "song.m4a"
    audio.write_bytes(b"audio")
    eligible = _track(audio)
    local = _track(audio)
    local.id = "local"
    local.youtube_id = None
    lossless = _track(audio)
    lossless.id = "flac"
    lossless.format = "flac"
    store = LosslessStore(tmp_path / "instance.db")
    service = LosslessUpgradeService(
        store=store,
        providers=[],
        foreground_busy=lambda: False,
        inventory=lambda: [
            (eligible, str(audio)),
            (local, str(audio)),
            (lossless, str(audio)),
        ],
        quiet_seconds=0,
    )
    service._quiet_since = time.monotonic()
    service.run_once_if_idle()
    assert store.get("stable-id") is not None
    assert store.get("local") is None
    assert store.get("flac") is None


def test_inventory_scan_is_throttled_between_idle_iterations(tmp_path, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_LOSSLESS_UPGRADES", "true")
    calls: list[bool] = []
    service = LosslessUpgradeService(
        store=LosslessStore(tmp_path / "instance.db"),
        providers=[],
        foreground_busy=lambda: False,
        inventory=lambda: calls.append(True) or [],
        quiet_seconds=0,
    )
    service._quiet_since = time.monotonic()
    assert service.run_once_if_idle() is False
    assert service.run_once_if_idle() is False
    assert calls == [True]


def test_provider_failures_are_isolated_and_cached_candidates_replace(tmp_path, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_LOSSLESS_UPGRADES", "true")
    current = tmp_path / "song.m4a"
    current.write_bytes(b"current")
    track = _track(current)
    failing = Provider(error=RuntimeError("offline"))
    failing.name = "broken"
    working = Provider([_candidate()])
    replacements = []
    service = LosslessUpgradeService(
        store=LosslessStore(tmp_path / "instance.db"),
        providers=[failing, working],
        foreground_busy=lambda: False,
        inventory=lambda: [(track, str(current))],
        replace_track=lambda *args: replacements.append(args) or True,
        quiet_seconds=0,
    )
    candidate_file = tmp_path / "candidate.flac"
    candidate_file.write_bytes(b"lossless")
    monkeypatch.setattr(service, "_download_candidate", lambda candidate: candidate_file)
    monkeypatch.setattr(service, "_validate_lossless", lambda path, candidate: None)
    monkeypatch.setattr(service, "_fingerprint_match_cancelable", lambda a, b: (True, 0.97))
    service._quiet_since = time.monotonic()
    assert service.run_once_if_idle() is True
    assert failing.calls == 1
    assert working.calls == 1
    assert len(replacements) == 1
    assert service.store.get(track.id)["status"] == "completed"


def test_bad_candidate_does_not_prevent_trying_the_next_candidate(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("SOUNDSIBLE_LOSSLESS_UPGRADES", "true")
    current = tmp_path / "song.m4a"
    current.write_bytes(b"current")
    first = _candidate()
    second = LosslessCandidate.from_dict({**first.to_dict(), "source_id": "43"})
    replacements = []
    service = LosslessUpgradeService(
        store=LosslessStore(tmp_path / "instance.db"),
        providers=[Provider([first, second])],
        foreground_busy=lambda: False,
        inventory=lambda: [(_track(current), str(current))],
        replace_track=lambda *args: replacements.append(args) or True,
        quiet_seconds=0,
    )

    def download(candidate):
        path = tmp_path / f"{candidate.source_id}.flac"
        path.write_bytes(b"audio")
        return path

    def validate(_path, candidate):
        if candidate.source_id == "42":
            raise ValueError("not really lossless")

    monkeypatch.setattr(service, "_download_candidate", download)
    monkeypatch.setattr(service, "_validate_lossless", validate)
    monkeypatch.setattr(
        service, "_fingerprint_match_cancelable", lambda _a, _b: (True, 0.99)
    )
    service._quiet_since = time.monotonic()

    assert service.run_once_if_idle() is True
    assert len(replacements) == 1
    assert replacements[0][2].source_id == "43"


def test_preemption_keeps_job_retryable(tmp_path, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_LOSSLESS_UPGRADES", "true")
    current = tmp_path / "song.m4a"
    current.write_bytes(b"current")
    track = _track(current)
    service = LosslessUpgradeService(
        store=LosslessStore(tmp_path / "instance.db"),
        providers=[Provider([_candidate()])],
        foreground_busy=lambda: False,
        inventory=lambda: [(track, str(current))],
        quiet_seconds=0,
    )
    monkeypatch.setattr(
        service,
        "_download_candidate",
        lambda candidate: (_ for _ in ()).throw(Preempted("playback started")),
    )
    service._quiet_since = time.monotonic()
    service.run_once_if_idle()
    assert service.store.get(track.id)["status"] == "retry"


def test_stable_logical_id_survives_technical_replacement(tmp_path):
    path = tmp_path / "song.m4a"
    path.write_bytes(b"audio")
    source = _track(path)
    upgraded = Track.from_dict(
        {
            **source.to_dict(),
            "file_hash": "new-flac-hash",
            "format": "flac",
            "audio_quality": "lossless",
            "audio_source": "wikimedia",
            "audio_identity_verified": True,
        }
    )
    LosslessUpgradeService._apply_technical_fields(source, upgraded)
    assert source.id == "stable-id"
    assert source.file_hash == "new-flac-hash"
    assert source.audio_quality == "lossless"
    assert source.audio_identity_verified is True


def test_download_preemption_counts_partial_bytes(tmp_path, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_LOSSLESS_UPGRADES", "true")
    service = LosslessUpgradeService(
        store=LosslessStore(tmp_path / "instance.db"),
        providers=[],
        foreground_busy=lambda: True,
        inventory=lambda: [],
    )

    class Response:
        url = _candidate().download_url
        headers = {}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def raise_for_status(self):
            return None

        def iter_content(self, chunk_size):
            yield b"x" * 32

    monkeypatch.setattr("shared.lossless.service.requests.get", lambda *a, **k: Response())
    with pytest.raises(Preempted):
        service._download_candidate(_candidate())
    assert service.store.budget(service._day())["bytes_downloaded"] == 0


def test_download_rejects_redirect_before_contacting_untrusted_host(
    tmp_path, monkeypatch
):
    service = LosslessUpgradeService(
        store=LosslessStore(tmp_path / "instance.db"),
        providers=[],
        foreground_busy=lambda: False,
        inventory=lambda: [],
    )
    contacted: list[str] = []

    class Redirect:
        is_redirect = True
        headers = {"Location": "http://127.0.0.1/private"}
        url = _candidate().download_url

        def close(self):
            return None

    def fake_get(url, **_kwargs):
        contacted.append(url)
        return Redirect()

    monkeypatch.setattr("shared.lossless.service.requests.get", fake_get)
    with pytest.raises(ValueError, match="untrusted"):
        service._open_download_response(_candidate())
    assert contacted == [_candidate().download_url]


def test_disabled_service_never_inventories_or_contacts_network(tmp_path, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_LOSSLESS_UPGRADES", "false")
    provider = Provider([_candidate()])
    inventory_calls = []
    service = LosslessUpgradeService(
        store=LosslessStore(tmp_path / "instance.db"),
        providers=[provider],
        foreground_busy=lambda: False,
        inventory=lambda: inventory_calls.append(True) or [],
        quiet_seconds=0,
    )
    assert service.run_once_if_idle() is False
    assert inventory_calls == []
    assert provider.calls == 0


def test_commit_updates_pool_and_every_user_before_removing_old_audio(
    tmp_path, monkeypatch
):
    old_path = tmp_path / "old.m4a"
    old_path.write_bytes(b"old")
    new_path = tmp_path / "new.flac"
    new_path.write_bytes(b"new")
    old = _track(old_path)
    upgraded = Track.from_dict(
        {
            **old.to_dict(),
            "file_hash": "new-hash",
            "format": "flac",
            "original_filename": "Artist - Song.flac",
            "audio_quality": "lossless",
            "audio_source": "wikimedia",
            "audio_identity_verified": True,
        }
    )
    pool_track = Track.from_dict(old.to_dict())
    user_tracks = {
        user_id: Track.from_dict(old.to_dict()) for user_id in ("one", "two")
    }
    saved_users: list[str] = []

    class FakeLibrary:
        def __init__(self, track, user_id=None):
            self.metadata = LibraryMetadata(
                version=1, tracks=[track], playlists=[], settings={}
            )
            self.manifest_path = tmp_path / f"{user_id or 'pool'}.json"
            self.user_id = user_id

        def get_track_by_id(self, track_id):
            return self.metadata.get_track_by_id(track_id)

        def _save_metadata(self):
            saved_users.append(self.user_id)

    pool = FakeLibrary(pool_track)
    downloader = SimpleNamespace(library=pool, save_library=lambda: None)
    user_libraries = {
        user_id: FakeLibrary(track, user_id)
        for user_id, track in user_tracks.items()
    }

    @contextmanager
    def fake_user_context(_user_id):
        yield

    monkeypatch.setattr("shared.api.get_downloader", lambda **_kwargs: downloader)
    monkeypatch.setattr(
        "shared.api.get_user_core",
        lambda user_id: SimpleNamespace(library=user_libraries[user_id]),
    )
    monkeypatch.setattr(
        "shared.users.list_users", lambda: [{"id": "one"}, {"id": "two"}]
    )
    monkeypatch.setattr("shared.user_context.user_context", fake_user_context)

    store = LosslessStore(tmp_path / "instance.db")
    store.enqueue(old.id, old.youtube_id)
    store.update(old.id, "committing", old_path=str(old_path), new_path=str(new_path))
    service = LosslessUpgradeService(store=store, providers=[])

    assert service._commit_snapshot(old, upgraded, new_path, _candidate()) is True
    assert old_path.exists() is False
    assert saved_users == ["one", "two"]
    assert pool_track.id == old.id
    assert pool_track.file_hash == "new-hash"
    assert all(track.id == old.id for track in user_tracks.values())
    assert all(track.audio_quality == "lossless" for track in user_tracks.values())


def test_commit_keeps_old_audio_when_any_user_manifest_fails(tmp_path, monkeypatch):
    old_path = tmp_path / "old.m4a"
    old_path.write_bytes(b"old")
    new_path = tmp_path / "new.flac"
    new_path.write_bytes(b"new")
    old = _track(old_path)
    upgraded = Track.from_dict(
        {
            **old.to_dict(),
            "file_hash": "new-hash",
            "format": "flac",
            "audio_quality": "lossless",
        }
    )

    class FailingLibrary:
        metadata = LibraryMetadata(
            version=1,
            tracks=[Track.from_dict(old.to_dict())],
            playlists=[],
            settings={},
        )
        manifest_path = tmp_path / "broken.json"

        def _save_metadata(self):
            raise OSError("disk full")

    @contextmanager
    def fake_user_context(_user_id):
        yield

    monkeypatch.setattr("shared.api.get_downloader", lambda **_kwargs: None)
    monkeypatch.setattr(
        "shared.api.get_user_core",
        lambda _user_id: SimpleNamespace(library=FailingLibrary()),
    )
    monkeypatch.setattr("shared.users.list_users", lambda: [{"id": "broken"}])
    monkeypatch.setattr("shared.user_context.user_context", fake_user_context)

    store = LosslessStore(tmp_path / "instance.db")
    store.enqueue(old.id, old.youtube_id)
    store.update(old.id, "committing", old_path=str(old_path), new_path=str(new_path))
    service = LosslessUpgradeService(store=store, providers=[])

    assert service._commit_snapshot(old, upgraded, new_path, _candidate()) is False
    assert old_path.exists() is True
    assert store.get(old.id)["status"] == "committing"


def test_manual_run_ignores_the_idle_gate_and_the_daily_cap(tmp_path, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_LOSSLESS_UPGRADES", "true")
    audio = tmp_path / "song.m4a"
    audio.write_bytes(b"audio")
    provider = Provider([])
    store = LosslessStore(tmp_path / "instance.db")
    today = datetime.now().astimezone().date().isoformat()
    store.add_budget(today, tracks=MAX_TRACKS_PER_DAY)
    service = LosslessUpgradeService(
        store=store,
        providers=[provider],
        foreground_busy=lambda: True,
        inventory=lambda: [(_track(audio), str(audio))],
        quiet_seconds=3600,
    )
    assert service.run_once_if_idle() is False
    assert provider.calls == 0

    # The worker thread would race the assertions below; drive it by hand.
    monkeypatch.setattr(service, "start", lambda: False)
    service.start_manual()
    assert service.run_once_manual() is True
    assert provider.calls == 1
    assert store.get("stable-id")["status"] == "no_match"
    assert store.budget(today)["tracks_examined"] > MAX_TRACKS_PER_DAY


def test_manual_run_ends_itself_when_the_queue_drains(tmp_path, monkeypatch):
    monkeypatch.setenv("SOUNDSIBLE_LOSSLESS_UPGRADES", "true")
    service = LosslessUpgradeService(
        store=LosslessStore(tmp_path / "instance.db"),
        providers=[],
        foreground_busy=lambda: True,
        inventory=lambda: [],
        quiet_seconds=3600,
    )
    # The worker thread would race the assertions below; drive it by hand.
    monkeypatch.setattr(service, "start", lambda: False)
    service.start_manual()
    assert service.run_once_manual() is False
    assert service.manual_state() == "off"
    assert service.status()["activity"] == "idle"


def test_pausing_a_manual_run_preempts_the_job_and_keeps_it_first_in_line(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("SOUNDSIBLE_LOSSLESS_UPGRADES", "true")
    current = tmp_path / "song.m4a"
    current.write_bytes(b"current")
    track = _track(current)
    service = LosslessUpgradeService(
        store=LosslessStore(tmp_path / "instance.db"),
        providers=[Provider([_candidate()])],
        foreground_busy=lambda: False,
        inventory=lambda: [(track, str(current))],
        quiet_seconds=0,
    )

    def pause_mid_download(_candidate):
        service.pause_manual()
        service._preempt_if_busy()
        raise AssertionError("preemption did not fire")

    monkeypatch.setattr(service, "_download_candidate", pause_mid_download)
    # The worker thread would race the assertions below; drive it by hand.
    monkeypatch.setattr(service, "start", lambda: False)
    service.start_manual()
    service.run_once_manual()

    job = service.store.get(track.id)
    assert job["status"] == "retry"
    assert job["next_attempt_at"] <= int(time.time())
    assert service.manual_state() == "paused"
    assert service.run_once_manual() is False
    assert service.status()["activity"] == "paused"

    assert service.resume_manual() is True
    assert service.manual_state() == "running"
    assert service.cancel_manual() is True
    assert service.manual_state() == "off"


def test_recheck_requeues_unmatched_tracks_and_drops_cached_verdicts(tmp_path):
    store = LosslessStore(tmp_path / "instance.db")
    store.enqueue("a", "yt-a")
    store.enqueue("b", "yt-b")
    store.update("a", "no_match", next_attempt_at=int(time.time()) + 30 * 86400)
    store.update("b", "completed")
    store.cache_put("a", "jamendo", [{"source_id": "x"}], 3600)

    assert store.requeue_all() == 1
    assert store.get("a")["status"] == "pending"
    assert store.get("b")["status"] == "completed"
    assert store.cache_get("a", "jamendo") is None
    assert store.ready_count() == 1


def test_a_client_that_died_mid_song_does_not_block_upgrades_forever(tmp_path):
    users = tmp_path / "users"
    (users / "alice").mkdir(parents=True)
    state = users / "alice" / "playback_state.json"

    state.write_text(
        json.dumps({"is_playing": True, "updated_at": time.time()}), encoding="utf-8"
    )
    assert LosslessUpgradeService.playback_live(users) is True

    state.write_text(
        json.dumps({"is_playing": True, "updated_at": time.time() - 3600}), encoding="utf-8"
    )
    assert LosslessUpgradeService.playback_live(users) is False
