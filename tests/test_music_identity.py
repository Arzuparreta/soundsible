from shared.music_identity import canonical_music_identity, synced_lyrics_safe


def test_youtube_presentation_noise_is_removed_but_version_is_retained():
    identity = canonical_music_identity(
        "Uploader",
        "Abel York - Where Are You (Remix) | Official Music Video",
        channel="Uploader",
    )
    assert identity.artist == "Abel York"
    assert identity.title == "Where Are You (Remix)"
    assert identity.version_tokens == frozenset({"remix"})


def test_topic_audio_is_preferred_over_third_party_lyrics():
    topic = canonical_music_identity(
        "KREAM - Topic", "KREAM - Arrival", channel="KREAM - Topic"
    )
    lyrics = canonical_music_identity(
        "Lyrics Cloud", "KREAM - Arrival (Lyrics)", channel="Lyrics Cloud"
    )
    assert topic.key == lyrics.key
    assert topic.source_kind == "official_audio"
    assert topic.source_rank > lyrics.source_rank


def test_official_word_alone_does_not_make_a_foreign_channel_official():
    identity = canonical_music_identity(
        "Definitely Official",
        "KREAM - Arrival (Official Video)",
        channel="Definitely Official",
    )
    assert identity.source_kind == "unverified"


def test_an_uploader_without_independent_artist_metadata_cannot_certify_itself():
    identity = canonical_music_identity("", "Arrival", channel="Music Mirror")
    assert identity.artist == "Music Mirror"
    assert identity.source_kind == "unverified"


def test_lyrics_timing_requires_album_like_audio_source():
    assert synced_lyrics_safe("official_audio")
    assert synced_lyrics_safe("artist_audio")
    assert not synced_lyrics_safe("official_video")
    assert not synced_lyrics_safe("third_party_lyrics")
