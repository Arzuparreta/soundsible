"""Unit coverage for shared.api.download_queue.classify_download_error.

The downloader surfaces ``error_message`` directly in the Downloads panel
(see ui_web/js/downloader_state.js), so the user-facing string each yt-dlp /
network failure maps to is part of the product contract. These tests pin the
stable ``error_kind`` and lock in the precedence between branches that share
substrings (age-vs-auth, geo-vs-unavailable).
"""

import pytest

from shared.api.download_queue import classify_download_error


@pytest.mark.parametrize(
    "raw, expected_kind",
    [
        # Existing classifications (regression guard).
        ("ERROR: Got error: 137 bytes read, 10400093 more expected.", "partial_read"),
        ("ERROR: Read operation timed out", "timeout"),
        ("ERROR: The read connection timeout was reached", "timeout"),
        ("ERROR: Requested format is not available", "format_unavailable"),
        ("ERROR: Sign in to confirm you're not a bot", "authentication_required"),
        ("ERROR: Please sign in to confirm your identity", "authentication_required"),
        ("OSError: [Errno 28] No space left on device", "disk_full"),
        # New classifications.
        ("ERROR: Sign in to confirm your age. This video may be inappropriate for some users.", "age_restricted"),
        ("ERROR: This video is age-restricted and only available on YouTube.", "age_restricted"),
        ("ERROR: Video unavailable. This video is private", "private_video"),
        ("ERROR: Private video. Sign in if you've been granted access to this video", "private_video"),
        (
            "ERROR: The uploader has not made this video available in your country",
            "geo_restricted",
        ),
        ("ERROR: This video is not available in your location.", "geo_restricted"),
        ("ERROR: Join this channel to get access to members-only content", "members_only"),
        ("ERROR: This video is available to this channel's members only", "members_only"),
        ("ERROR: Video unavailable", "video_unavailable"),
        ("ERROR: This video is no longer available because the YouTube account was terminated", "video_unavailable"),
        ("ERROR: This video has been removed by the user", "video_unavailable"),
        ("ERROR: This video is no longer available due to a copyright claim", "copyright"),
        ("ERROR: HTTP Error 429: Too Many Requests", "rate_limited"),
        ("ERROR: unable to connect to YouTube: Temporary failure in name resolution", "network_error"),
        ("ERROR: <urlopen error [Errno 111] Connection refused>", "network_error"),
    ],
)
def test_classify_download_error_kinds(raw, expected_kind):
    kind, message = classify_download_error(raw)
    assert kind == expected_kind
    assert message and isinstance(message, str)


def test_partial_read_message_is_stable():
    # Pinned because test_download_queue_persistence asserts the same string.
    kind, message = classify_download_error("137 bytes read, 10400093 more expected")
    assert kind == "partial_read"
    assert message == "YouTube closed the connection before the file finished downloading."


def test_age_restriction_wins_over_authentication():
    # "Sign in to confirm your age" matches both the age and the auth branch;
    # the actionable advice (add cookies) is specific to age-gated videos.
    kind, _ = classify_download_error("ERROR: Sign in to confirm your age")
    assert kind == "age_restricted"


def test_geo_restriction_wins_over_generic_unavailable():
    # "not available in your country" also contains "not available"; geo must win.
    kind, _ = classify_download_error("This video is not available in your country")
    assert kind == "geo_restricted"


def test_unknown_error_falls_back_to_last_meaningful_line():
    raw = "[download] Destination: song.webm\nERROR: Something genuinely novel broke"
    kind, message = classify_download_error(raw)
    assert kind == "download_failed"
    assert message == "ERROR: Something genuinely novel broke"


def test_empty_error_has_safe_default():
    kind, message = classify_download_error("")
    assert kind == "download_failed"
    assert message == "The download failed."


def test_message_is_truncated_to_300_chars():
    kind, message = classify_download_error("ERROR: " + "x" * 500)
    assert kind == "download_failed"
    assert len(message) <= 300


def test_none_error_does_not_raise():
    kind, message = classify_download_error(None)
    assert kind == "download_failed"
    assert message == "The download failed."
