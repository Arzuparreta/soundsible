from shared.models import Track


def preserve_track_identity(original: Track, refreshed: Track) -> Track:
    """Keep source identities when a metadata edit re-hashes the same audio.

    ``added_at`` travels with them: editing a tag or upgrading a file to
    lossless produces a new id for a song that has been in the library all
    along, and a song that has not moved must not move in "recently added".
    """
    if original.youtube_id:
        refreshed.youtube_id = original.youtube_id
    for field in (
        "added_at",
        "musicbrainz_id",
        "isrc",
        "media_kind",
        "podcast_feed_id",
        "podcast_episode_guid",
        "podcast_rss_url",
        "audio_source",
        "audio_source_url",
        "audio_license_url",
    ):
        if getattr(refreshed, field, None) is None:
            setattr(refreshed, field, getattr(original, field, None))
    if original.audio_quality != "unknown":
        refreshed.audio_quality = original.audio_quality
    if original.audio_identity_verified:
        refreshed.audio_identity_verified = True
    return refreshed
