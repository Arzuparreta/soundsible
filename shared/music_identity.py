"""Shared musical identity and playback-source classification.

Discovery, lyrics, YouTube resolution, and lossless lookup all see slightly
different metadata for the same recording.  This module keeps two questions
separate:

* which song/version is this?
* how trustworthy is this particular upload as the playback source?

Presentation labels such as "official video" and "lyrics" are stripped from
the canonical title. Recording labels such as "live" and "remix" are retained.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
import unicodedata
from typing import Any

_SPACE_RE = re.compile(r"\s+")
_BRACKET_RE = re.compile(r"\s*[\[(]([^\])]+)[\])]\s*")
_SEPARATOR_RE = re.compile(r"\s+(?:-|–|—|\|)\s+")
_CHANNEL_SUFFIX_RE = re.compile(
    r"(?:\s*[-–—]\s*|\s+|(?=[(\[]))?(?:[(\[]\s*)?"
    r"(?:official(?:\s+music)?|oficial|topic|vevo)(?:\s*[)\]])?\s*$",
    re.IGNORECASE,
)
_TRAILING_PRESENTATION_RE = re.compile(
    r"(?:\s*[-–—|:]\s*)?(?:official|oficial)?\s*"
    r"(?:music\s+)?(?:audio|video|music\s+video|lyric\s+video|lyrics?|"
    r"videoclip|letras?|subtitulado|sub\s+espa(?:n|ñ)ol)"
    r"(?:\s+(?:official|oficial))?\s*$",
    re.IGNORECASE,
)

PRESENTATION_TOKENS = frozenset(
    {
        "4k",
        "audio",
        "clip",
        "full",
        "hd",
        "hq",
        "letra",
        "letras",
        "lyric",
        "lyrics",
        "music",
        "official",
        "oficial",
        "subtitulado",
        "video",
        "videoclip",
    }
)
VERSION_TOKENS = frozenset(
    {
        "8d",
        "acoustic",
        "acustico",
        "cover",
        "demo",
        "instrumental",
        "karaoke",
        "live",
        "mashup",
        "mix",
        "nightcore",
        "parody",
        "remaster",
        "remastered",
        "remix",
        "reverb",
        "slowed",
        "sped",
        "tribute",
        "unplugged",
    }
)

SOURCE_RANK = {
    "official_audio": 70,
    "artist_audio": 65,
    "official_video": 55,
    "official_lyrics": 48,
    "artist_upload": 45,
    "unverified": 30,
    "third_party_lyrics": 15,
}


def fold_music_text(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).casefold()
    text = re.sub(r"[^\w]+", " ", text, flags=re.UNICODE)
    return _SPACE_RE.sub(" ", text).strip()


def _strip_presentation_groups(value: str) -> str:
    def replace(match: re.Match[str]) -> str:
        tokens = set(fold_music_text(match.group(1)).split())
        return " " if tokens and tokens <= PRESENTATION_TOKENS else match.group(0)

    cleaned = _BRACKET_RE.sub(replace, value or "")
    previous = None
    while cleaned != previous:
        previous = cleaned
        cleaned = _TRAILING_PRESENTATION_RE.sub("", cleaned).strip()
    return _SPACE_RE.sub(" ", cleaned).strip(" -–—|:")


def clean_artist(value: Any) -> str:
    raw = str(value or "").strip()
    return _SPACE_RE.sub(" ", _CHANNEL_SUFFIX_RE.sub("", raw)).strip(" -–—|:")


def _artist_matches(left: Any, right: Any) -> bool:
    a = fold_music_text(clean_artist(left))
    b = fold_music_text(clean_artist(right))
    if not a or not b:
        return False
    return a == b or (len(a) >= 4 and a in b) or (len(b) >= 4 and b in a)


@dataclass(frozen=True)
class MusicIdentity:
    artist: str
    title: str
    version_tokens: frozenset[str]
    source_kind: str
    source_rank: int

    @property
    def key(self) -> str:
        versions = ",".join(sorted(self.version_tokens))
        return f"{fold_music_text(self.artist)}\x00{fold_music_text(self.title)}\x00{versions}"


def canonical_music_identity(
    artist: Any,
    title: Any,
    *,
    channel: Any = "",
    authoritative: bool = False,
    source_title: Any = "",
) -> MusicIdentity:
    """Which song this is, and how trustworthy the upload playing it is.

    ``authoritative`` marks ``artist`` and ``title`` as musical metadata — a
    library track, a catalog row, tags the provider supplied — rather than an
    upload to interpret: neither is parsed nor stripped. ``source_title`` is the
    title of the upload itself when ``title`` is not; only the source
    classification reads it, since catalog metadata cannot say whether a video
    is official audio or a lyric video.
    """
    raw_title = str(title or "").strip()
    raw_channel = str(channel or artist or "").strip()
    supplied_artist = str(artist or "").strip()
    channel_artist = clean_artist(raw_channel)
    supplied_clean = clean_artist(supplied_artist)
    title_artist = ""

    if authoritative and supplied_artist:
        canonical_artist = supplied_artist
        canonical_title = raw_title
    else:
        clean_title = _strip_presentation_groups(raw_title)
        parts = _SEPARATOR_RE.split(clean_title, maxsplit=1)
        if len(parts) == 2 and parts[0].strip() and parts[1].strip():
            # Positional, and therefore a guess: "Artist - Song" is the convention,
            # but uploaders write "Song - Artist" often enough that this files those
            # tracks under the wrong name with no signal that it happened. Settling
            # it needs a provider lookup, which this function deliberately cannot
            # do — see the roadmap entry on orientation by lookup.
            title_artist, clean_title = parts[0].strip(), parts[1].strip()

        # Related-video rows put the uploader in `artist`. A title prefix is better
        # song metadata whenever that uploader is not the named artist.
        if title_artist and not _artist_matches(title_artist, channel_artist):
            canonical_artist = title_artist
        else:
            canonical_artist = title_artist or supplied_clean or channel_artist
        canonical_title = _strip_presentation_groups(clean_title) or raw_title

    versions = frozenset(set(fold_music_text(raw_title).split()) & VERSION_TOKENS)
    folded_title = fold_music_text(source_title or raw_title)
    folded_channel = fold_music_text(raw_channel)
    # The uploader cannot certify itself as the artist. Ownership needs
    # independent song metadata: an explicit expected artist or the title's
    # "Artist - Track" prefix.
    artist_owned = _artist_matches(title_artist or supplied_clean, channel_artist)
    topic = bool(re.search(r"(?:^|\s)topic$", folded_channel))
    vevo = "vevo" in folded_channel
    official_audio = bool(re.search(r"\bofficial\s+audio\b|\baudio\s+oficial\b", folded_title))
    official_video = bool(
        re.search(r"\bofficial\s+(?:music\s+)?video\b|\bvideo\s+oficial\b", folded_title)
    )
    lyric = bool(re.search(r"\blyrics?\b|\bletras?\b|\bvideolyric\b", folded_title))
    official = "official" in folded_title or "oficial" in folded_title

    if topic or (official_audio and (artist_owned or vevo)):
        source_kind = "official_audio"
    elif artist_owned and ("audio" in folded_title or not (official_video or lyric)):
        source_kind = "artist_audio"
    elif (official_video or vevo) and (artist_owned or vevo):
        source_kind = "official_video"
    elif lyric and official and artist_owned:
        source_kind = "official_lyrics"
    elif artist_owned:
        source_kind = "artist_upload"
    elif lyric:
        source_kind = "third_party_lyrics"
    else:
        source_kind = "unverified"

    return MusicIdentity(
        artist=canonical_artist or supplied_clean or raw_channel,
        title=canonical_title,
        version_tokens=versions,
        source_kind=source_kind,
        source_rank=SOURCE_RANK[source_kind],
    )


def synced_lyrics_safe(source_kind: str | None) -> bool:
    """Whether album-timed LRC is safe for this playback-source class."""
    return source_kind in {"official_audio", "artist_audio"}


def youtube_music_metadata(row: dict) -> dict:
    """The song a YouTube row is, read once from what the row already carries.

    Every surface that turns an upload into music — search, related mixes, a
    pasted link, the planners — asks this instead of keeping its own rules, so
    one video cannot be "Extremoduro" in one place and "Extremoduro (Oficial)"
    in another. Nothing is fetched.

    The performer is the provider's structured ``artist``/``artists`` when the
    extractor says it sent one (``artist_metadata_explicit``). Otherwise it is
    read off the upload: an "Artist - Song" title, or the channel without its
    "Official"/"Topic"/"VEVO" label. Rows cached before this existed copied the
    channel into ``artist``; a distinct value there still counts as explicit.
    The result is idempotent, so a row adapted at extraction reads the same
    when it comes back out of a cache.
    """
    channel = str(row.get("channel") or row.get("uploader") or "")
    upload_title = str(row.get("source_title") or row.get("title") or "")
    structured = row.get("artists") or row.get("artist")
    artists = [str(x) for x in structured if x] if isinstance(structured, (list, tuple)) else None
    artist = ", ".join(artists) if artists else str(structured or "")
    explicit = bool(artist) and bool(row.get("artist_metadata_explicit", artist != channel))
    title = str(row.get("track") or (row.get("title") if explicit else upload_title) or "Unknown")
    identity = canonical_music_identity(
        artist if explicit else "",
        title,
        channel=channel or artist,
        authoritative=explicit,
        source_title=upload_title,
    )
    return {
        "title": identity.title,
        "artist": identity.artist,
        "artists": artists,
        "artist_metadata_explicit": explicit,
        # A cleaned label ("X - Topic" -> "X") or a title prefix names a
        # performer; a bare channel name might be anyone's upload.
        "artist_is_channel": not explicit and identity.artist == (channel or artist),
        "source_title": upload_title or title,
        "source_artist": str(row.get("source_artist") or channel or artist),
        "canonical_identity": identity.key,
        "playback_source_kind": identity.source_kind,
    }


def adapt_youtube_rows(rows: list[dict]) -> list[dict]:
    """Cached related-mix rows as fresh extraction would return them today."""
    return [{**row, **youtube_music_metadata(row)} for row in rows]
