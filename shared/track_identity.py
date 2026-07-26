from shared.models import Track


def preserve_track_identity(original: Track, refreshed: Track) -> Track:
    """Keep source identities when a metadata edit re-hashes the same audio."""
    if original.youtube_id:
        refreshed.youtube_id = original.youtube_id
    for field in (
        "musicbrainz_id",
        "isrc",
        "media_kind",
        "podcast_feed_id",
        "podcast_episode_guid",
        "podcast_rss_url",
    ):
        if getattr(refreshed, field, None) is None:
            setattr(refreshed, field, getattr(original, field, None))
    return refreshed
