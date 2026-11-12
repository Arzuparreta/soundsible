"""When published playback state becomes a play.

These drive the observer with the publications real clients send: a ``play``
push when a song starts, one every fifteen seconds while it plays, one on every
pause and seek, and the next song's ``play`` push when it ends.
"""

from __future__ import annotations

from typing import Optional

from shared.scrobble.listen import Listen, required_seconds
from shared.scrobble.observer import ListeningObserver

USER = "ana"
START = 1_700_000_000.0


class Recorder:
    def __init__(self) -> None:
        self.now_playing: list[tuple[str, Listen]] = []
        self.plays: list[tuple[str, Listen]] = []
        self.observer = ListeningObserver(
            lambda user, listen: self.now_playing.append((user, listen)),
            lambda user, listen: self.plays.append((user, listen)),
        )
        self.resolved = 0

    def publish(
        self,
        at: float,
        track: str = "song",
        position: float = 0.0,
        playing: bool = True,
        *,
        device: str = "phone",
        duration: int = 200,
        listen: Optional[Listen] = None,
        eligible: bool = True,
    ) -> None:
        def resolve() -> Optional[Listen]:
            self.resolved += 1
            if not eligible:
                return None
            return listen or Listen(artist="Artist", title=track.title(), duration=duration)

        self.observer.observe(USER, device, track, position, playing, START + at, resolve)

    def play_through(self, track: str, begins: float, seconds: float, **facts) -> float:
        """Publish like an awake client for ``seconds`` of ``track``. Returns when it stopped."""
        elapsed = 0.0
        self.publish(begins, track, 0, **facts)
        while elapsed + 15 <= seconds:
            elapsed += 15
            self.publish(begins + elapsed, track, elapsed, **facts)
        return begins + elapsed


def test_the_threshold_is_half_the_track_or_four_minutes():
    assert required_seconds(200) == 100
    assert required_seconds(600) == 240
    assert required_seconds(30) is None  # thirty seconds or less is never a play
    assert required_seconds(31) == 15.5
    assert required_seconds(0) == 240  # a length nobody reported


def test_a_song_counts_once_half_of_it_has_played():
    rec = Recorder()
    rec.play_through("song", 0, 90)
    assert rec.plays == []
    rec.publish(105, position=105)
    assert [(user, listen.title, listen.started_at) for user, listen in rec.plays] == [(USER, "Song", int(START))]
    # ...and only once, however much longer it plays.
    rec.publish(120, position=120)
    rec.publish(135, position=135)
    assert len(rec.plays) == 1


def test_now_playing_is_announced_when_the_song_starts_and_when_it_resumes():
    rec = Recorder()
    rec.publish(0)
    assert [listen.title for _, listen in rec.now_playing] == ["Song"]
    rec.publish(15, position=15)
    assert len(rec.now_playing) == 1
    rec.publish(20, position=20, playing=False)
    rec.publish(400, position=20, playing=True)
    assert len(rec.now_playing) == 2


def test_a_song_skipped_early_is_not_a_play():
    rec = Recorder()
    rec.play_through("first", 0, 45)
    rec.publish(50, "second", 0)
    rec.play_through("second", 50, 30)
    assert rec.plays == []


def test_time_spent_paused_is_not_listening():
    rec = Recorder()
    rec.play_through("song", 0, 60)
    rec.publish(60, position=60, playing=False)
    rec.publish(1000, position=60, playing=True)
    rec.publish(1015, position=75)
    assert rec.plays == []
    rec.publish(1030, position=90)
    rec.publish(1045, position=105)
    assert len(rec.plays) == 1
    # The play is dated from when the song first started, not from the resume.
    assert rec.plays[0][1].started_at == int(START)


def test_seeking_forward_does_not_manufacture_listening():
    rec = Recorder()
    rec.publish(0)
    rec.publish(5, position=180)  # the seek is published at once
    rec.publish(20, position=195)
    assert rec.plays == []


def test_a_stalled_stream_is_not_listening():
    rec = Recorder()
    rec.publish(0)
    for tick in range(1, 20):
        rec.publish(tick * 15, position=3.0)  # "playing", and the position never moves
    assert rec.plays == []


def test_seeking_back_keeps_what_was_already_heard():
    rec = Recorder()
    rec.play_through("song", 0, 90)
    rec.publish(92, position=40)
    rec.publish(107, position=55)
    assert len(rec.plays) == 1


def test_a_song_on_repeat_counts_each_time_round():
    rec = Recorder()
    end = rec.play_through("song", 0, 195)
    assert len(rec.plays) == 1
    rec.publish(end + 10, position=2)  # it began again
    assert len(rec.now_playing) == 2
    rec.play_through("song", end + 10, 120)
    assert len(rec.plays) == 2
    assert rec.plays[1][1].started_at == int(START + end + 10)


def test_restarting_a_song_before_it_counted_is_still_one_listen():
    rec = Recorder()
    rec.play_through("song", 0, 60)
    rec.publish(62, position=0)
    rec.publish(77, position=15)
    rec.publish(92, position=30)
    rec.publish(107, position=45)
    assert len(rec.plays) == 1
    assert rec.plays[0][1].started_at == int(START)


def test_a_phone_with_its_screen_off_still_gets_its_plays():
    """The page stops ticking; the next thing heard is the track ending, with a stale position."""
    rec = Recorder()
    rec.publish(0)
    rec.publish(200, position=0, playing=False)  # `pause` at the natural end, clock never advanced
    assert len(rec.plays) == 1
    rec.publish(202, "next", 0)
    rec.publish(402, "third", 0)  # nothing at all between two songs
    assert [listen.title for _, listen in rec.plays] == ["Song", "Next"]


def test_a_client_that_vanished_mid_song_is_credited_nothing_for_the_silence():
    rec = Recorder()
    rec.publish(0)
    rec.publish(15, position=15)
    # Heard from again two hours later, with something else.
    rec.publish(7200, "other", 0)
    assert rec.plays == []


def test_a_quiet_client_that_comes_back_mid_song_is_believed_by_its_position():
    rec = Recorder()
    rec.publish(0, duration=600)
    # Silent for 100 s and then playing at 0:20: it was stuck, not playing.
    rec.publish(100, position=20, duration=600)
    rec.publish(115, position=35, duration=600)
    assert rec.plays == []


def test_a_track_of_thirty_seconds_never_counts():
    rec = Recorder()
    rec.play_through("jingle", 0, 30, duration=30)
    rec.publish(31, "next", 0)
    assert rec.plays == []


def test_a_track_of_unknown_length_needs_four_minutes():
    rec = Recorder()
    rec.play_through("song", 0, 225, duration=0)
    assert rec.plays == []
    rec.publish(240, position=240, duration=0)
    assert len(rec.plays) == 1


def test_what_is_not_music_is_tracked_but_never_reported():
    rec = Recorder()
    rec.play_through("episode", 0, 600, eligible=False)
    assert rec.plays == [] and rec.now_playing == []
    assert rec.resolved == 1  # looked up once, not on every publication


def test_handing_a_song_to_another_device_is_one_listen():
    rec = Recorder()
    rec.play_through("song", 0, 250, duration=600)  # counted on the phone at four minutes
    assert len(rec.plays) == 1
    rec.publish(252, position=250, device="desktop", duration=600)  # the desktop takes over
    rec.publish(253, position=250, playing=False, duration=600)  # the phone stops
    for tick in range(1, 20):
        rec.publish(252 + tick * 15, position=250 + tick * 15, device="desktop", duration=600)
    assert len(rec.plays) == 1


def test_a_handoff_before_the_song_counted_carries_the_listening_over():
    rec = Recorder()
    rec.play_through("song", 0, 60)
    rec.publish(62, position=60, device="desktop")
    rec.publish(77, position=75, device="desktop")
    rec.publish(92, position=90, device="desktop")
    rec.publish(107, position=105, device="desktop")
    assert len(rec.plays) == 1
    assert rec.plays[0][1].started_at == int(START)


def test_two_devices_playing_different_songs_are_two_listens():
    rec = Recorder()
    rec.play_through("song", 0, 120)
    rec.play_through("other", 0, 120, device="desktop")
    assert sorted(listen.title for _, listen in rec.plays) == ["Other", "Song"]


def test_a_device_that_holds_no_track_ends_the_listen():
    rec = Recorder()
    rec.play_through("song", 0, 60)
    rec.publish(61, "", 0, playing=False)
    rec.play_through("song", 100, 60)
    assert rec.plays == []
