"""Reading and writing audio files: hashes, tags, covers, length.

One `AudioProcessor` for every part of Soundsible that touches an audio file:
the folder scan and the uploader read tags with it, downloads write them, and
the library edits them.
"""

from __future__ import annotations

import hashlib
import logging
import re
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import mutagen
from mutagen import File as MutagenFile
from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, ID3, TALB, TCMP, TDRC, TIT2, TPE1, TPE2, TPOS, TRCK, TXXX, UFID
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover, MP4FreeForm
from mutagen.oggopus import OggOpus
from mutagen.oggvorbis import OggVorbis

from shared.constants import SUPPORTED_AUDIO_FORMATS
from shared.musicbrainz import (
    MUSICBRAINZ_MP4_RECORDING_TAG,
    MUSICBRAINZ_UFID_OWNER,
    MUSICBRAINZ_VORBIS_RECORDING_TAG,
    first_recording_mbid,
    normalize_recording_mbid,
)

logger = logging.getLogger(__name__)

_TRUE_TAG_VALUES = {"1", "true", "yes"}


def _first(values: Any) -> Any:
    if isinstance(values, (list, tuple)):
        return values[0] if values else None
    return values


def _leading_int(value: Any) -> Optional[int]:
    """The number a tag starts with: "4/12" is 4, "2001-05-01" is 2001."""
    match = re.match(r"\s*(\d+)", str(_first(value) or ""))
    return int(match.group(1)) if match else None


def _number_pair(value: Any) -> Tuple[Optional[int], Optional[int]]:
    text = str(_first(value) or "").strip()
    if not text:
        return None, None
    first, _, second = text.partition("/")
    number = int(first) if first.strip().isdigit() else None
    total = int(second) if second.strip().isdigit() else None
    return number, total


def _tag_bool(value: Any) -> bool:
    return str(_first(value) or "").strip().casefold() in _TRUE_TAG_VALUES


def _artist_list(values: Any) -> Optional[list]:
    artists = [str(value).strip() for value in (values or []) if str(value).strip()]
    return artists or None


def _read_id3(tags: Any, out: Dict[str, Any]) -> None:
    def text(key: str) -> str:
        frame = tags.get(key)
        return str(frame) if frame is not None else ""

    out["title"] = text("TIT2")
    out["artists"] = _artist_list(getattr(tags.get("TPE1"), "text", []))
    out["album"] = text("TALB")
    out["album_artist"] = text("TPE2") or None
    out["year"] = _leading_int(text("TDRC"))
    out["genre"] = text("TCON") or None
    out["track_number"] = _leading_int(text("TRCK"))
    if "TPOS" in tags:
        out["disc_number"], out["disc_total"] = _number_pair(text("TPOS"))
    if "TCMP" in tags:
        out["is_compilation"] = _tag_bool(text("TCMP"))
    ufid = tags.get(f"UFID:{MUSICBRAINZ_UFID_OWNER}")
    out["musicbrainz_id"] = normalize_recording_mbid(getattr(ufid, "data", None))
    out["cover_art"] = any(str(key).startswith("APIC:") for key in tags.keys())


def _read_vorbis(tags: Any, out: Dict[str, Any]) -> None:
    def text(key: str) -> str:
        return str(_first(tags.get(key)) or "")

    out["title"] = text("title")
    out["artists"] = _artist_list(tags.get("artist"))
    out["album"] = text("album")
    out["album_artist"] = text("albumartist") or text("album artist") or None
    out["year"] = _leading_int(text("date"))
    out["genre"] = text("genre") or None
    out["track_number"] = _leading_int(text("tracknumber"))
    if text("discnumber"):
        out["disc_number"], out["disc_total"] = _number_pair(text("discnumber"))
    total_discs = text("disctotal") or text("totaldiscs")
    if total_discs:
        out["disc_total"] = _leading_int(total_discs)
    if text("compilation"):
        out["is_compilation"] = _tag_bool(text("compilation"))
    out["musicbrainz_id"] = first_recording_mbid(tags.get(MUSICBRAINZ_VORBIS_RECORDING_TAG))


def _read_mp4(tags: Any, out: Dict[str, Any]) -> None:
    def text(key: str) -> str:
        return str(_first(tags.get(key)) or "")

    out["title"] = text("\xa9nam")
    out["artists"] = _artist_list(tags.get("\xa9ART"))
    out["album"] = text("\xa9alb")
    out["album_artist"] = text("aART") or None
    out["year"] = _leading_int(text("\xa9day"))
    out["genre"] = text("\xa9gen") or None
    if "trkn" in tags:
        out["track_number"] = tags["trkn"][0][0] or None
    if "disk" in tags:
        out["disc_number"] = tags["disk"][0][0] or None
        out["disc_total"] = tags["disk"][0][1] or None
    if "cpil" in tags:
        out["is_compilation"] = bool(_first(tags["cpil"]))
    out["musicbrainz_id"] = first_recording_mbid(tags.get(MUSICBRAINZ_MP4_RECORDING_TAG))
    out["cover_art"] = "covr" in tags


class AudioProcessor:
    """Handler for audio file operations."""

    @staticmethod
    def is_supported_format(file_path: str) -> bool:
        return Path(file_path).suffix.lower() in SUPPORTED_AUDIO_FORMATS

    @staticmethod
    def calculate_hash(file_path: str) -> str:
        """SHA-256 of the file's bytes: a track's id."""
        sha256 = hashlib.sha256()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                sha256.update(chunk)
        return sha256.hexdigest()

    @staticmethod
    def read_tags(file_path: str) -> Dict[str, Any]:
        """What a file says about itself, with nothing filled in.

        Missing text is "", missing numbers are None. Reads MP3, FLAC, Ogg
        Vorbis and MP4/M4A; any other file, or one that cannot be read,
        comes back blank.
        """
        out: Dict[str, Any] = {
            "title": "", "artist": "", "artists": None, "album": "", "album_artist": None,
            "year": None, "genre": None, "track_number": None, "disc_number": None,
            "disc_total": None, "is_compilation": False, "musicbrainz_id": None,
            "cover_art": False, "duration": 0, "bitrate": 0,
            "format": Path(file_path).suffix.lower().lstrip("."),
        }
        try:
            audio = MutagenFile(file_path, easy=False)
            if audio is None:
                return out
            info = getattr(audio, "info", None)
            out["duration"] = int(getattr(info, "length", 0) or 0)
            out["bitrate"] = int((getattr(info, "bitrate", 0) or 0) / 1000)
            if isinstance(audio, MP3):
                if audio.tags:
                    _read_id3(audio.tags, out)
            elif isinstance(audio, FLAC):
                if audio.tags:
                    _read_vorbis(audio.tags, out)
                out["cover_art"] = bool(audio.pictures)
            elif isinstance(audio, (OggVorbis, OggOpus)):
                if audio.tags:
                    _read_vorbis(audio.tags, out)
            elif isinstance(audio, MP4):
                if audio.tags:
                    _read_mp4(audio.tags, out)
        except Exception as e:
            logger.warning("Could not read tags from %s: %s", file_path, e)
        out["artist"] = " & ".join(out["artists"] or [])
        return out

    @staticmethod
    def extract_metadata(file_path: str) -> Dict[str, Any]:
        """`read_tags` with a library's defaults for what the file leaves out.

        A missing title becomes the file's name; a missing artist or album
        becomes "Unknown Artist" / "Unknown Album".
        """
        metadata = AudioProcessor.read_tags(file_path)
        metadata["title"] = metadata["title"] or Path(file_path).stem
        metadata["artist"] = metadata["artist"] or "Unknown Artist"
        metadata["album"] = metadata["album"] or "Unknown Album"
        return metadata

    @staticmethod
    def audio_details(file_path: str) -> Tuple[int, int, int]:
        """(duration in seconds, bitrate in kbps, size in bytes). Bitrate is 0
        when the format does not report one."""
        tags = AudioProcessor.read_tags(file_path)
        return tags["duration"], tags["bitrate"], Path(file_path).stat().st_size

    @staticmethod
    def embed_metadata(file_path: str, metadata: Dict[str, Any], cover_url: Optional[str] = None) -> None:
        """Write tags (and a cover from `cover_url`) into the file.

        MP3, FLAC, MP4/M4A, Ogg Vorbis and Opus. WebM is left as it is:
        mutagen cannot write Matroska tags. Writing changes the file's hash, so
        the artwork the file had is bound to the new hash before this returns.
        """
        from shared.artwork import artwork_store, download_image
        from shared.library_repair import shrink_cover

        store = artwork_store()
        before_hash = AudioProcessor.calculate_hash(file_path)
        previous = store.ref(before_hash)
        original = previous["hash"] if previous else None
        if not original:
            embedded = AudioProcessor.extract_cover_art(file_path)
            original = store.put(embedded) if embedded else None
        cover_data = None
        if cover_url:
            try:
                downloaded = download_image(cover_url)
                if downloaded:
                    original = store.put(downloaded)
                    cover_data = shrink_cover(downloaded)
            except Exception:
                pass
        suffix = Path(file_path).suffix.lower()
        if suffix == ".mp3":
            AudioProcessor._embed_mp3(file_path, metadata, cover_data)
        elif suffix == ".flac":
            AudioProcessor._embed_flac(file_path, metadata, cover_data)
        elif suffix in (".m4a", ".mp4"):
            AudioProcessor._embed_mp4(file_path, metadata, cover_data)
        elif suffix in (".ogg", ".opus"):
            AudioProcessor._embed_ogg(file_path, metadata, cover_data)
        if original:
            store.bind(
                AudioProcessor.calculate_hash(file_path), original,
                "manual" if cover_url else (previous["source"] if previous else "embedded"),
                only_missing=True,
            )

    @staticmethod
    def _year(metadata: Dict[str, Any]) -> Optional[str]:
        year = metadata.get("year") or (metadata["release_date"][:4] if metadata.get("release_date") else None)
        return str(year) if year else None

    @staticmethod
    def _disc(metadata: Dict[str, Any]) -> Optional[str]:
        if not metadata.get("disc_number"):
            return None
        disc = str(metadata["disc_number"])
        if metadata.get("disc_total"):
            disc += f"/{metadata['disc_total']}"
        return disc

    @staticmethod
    def _write_vorbis(audio: Any, metadata: Dict[str, Any]) -> None:
        """Vorbis comments: FLAC, Ogg Vorbis and Opus all carry these."""
        if metadata.get("title"):
            audio["title"] = metadata["title"]
        artists = metadata.get("artists")
        if isinstance(artists, list) and artists:
            audio["artist"] = [str(value) for value in artists if str(value).strip()]
        elif metadata.get("artist"):
            audio["artist"] = metadata["artist"]
        if metadata.get("album"):
            audio["album"] = metadata["album"]
        if metadata.get("album_artist"):
            audio["albumartist"] = metadata["album_artist"]
        if AudioProcessor._year(metadata):
            audio["date"] = AudioProcessor._year(metadata)
        if metadata.get("track_number"):
            audio["tracknumber"] = str(metadata["track_number"])
        if AudioProcessor._disc(metadata):
            audio["discnumber"] = AudioProcessor._disc(metadata)
        if metadata.get("is_compilation"):
            audio["compilation"] = "1"
        if metadata.get("isrc"):
            audio["isrc"] = metadata["isrc"]
        musicbrainz_id = normalize_recording_mbid(metadata.get("musicbrainz_id"))
        if musicbrainz_id:
            audio[MUSICBRAINZ_VORBIS_RECORDING_TAG] = musicbrainz_id

    @staticmethod
    def _cover_picture(cover_data: bytes) -> Picture:
        image = Picture()
        image.type = 3
        image.mime = "image/jpeg"
        image.desc = "Cover"
        image.data = cover_data
        return image

    @staticmethod
    def _embed_flac(file_path: str, metadata: Dict[str, Any], cover_data: Optional[bytes]) -> None:
        try:
            audio = FLAC(file_path)
            AudioProcessor._write_vorbis(audio, metadata)
            if cover_data:
                try:
                    audio.add_picture(AudioProcessor._cover_picture(cover_data))
                except Exception as e:
                    logger.warning("Could not embed a FLAC cover in %s: %s", file_path, e)
            audio.save()
        except Exception as e:
            logger.warning("Could not write FLAC tags to %s: %s", file_path, e)

    @staticmethod
    def _embed_ogg(file_path: str, metadata: Dict[str, Any], cover_data: Optional[bytes]) -> None:
        try:
            audio = MutagenFile(file_path)
            if not isinstance(audio, (OggVorbis, OggOpus)):
                return
            if audio.tags is None:
                audio.add_tags()
            AudioProcessor._write_vorbis(audio.tags, metadata)
            if cover_data:
                import base64

                picture = AudioProcessor._cover_picture(cover_data).write()
                audio.tags["metadata_block_picture"] = [base64.b64encode(picture).decode("ascii")]
            audio.save()
        except Exception as e:
            logger.warning("Could not write Ogg tags to %s: %s", file_path, e)

    @staticmethod
    def _embed_mp4(file_path: str, metadata: Dict[str, Any], cover_data: Optional[bytes]) -> None:
        try:
            audio = MP4(file_path)
            if audio.tags is None:
                audio.add_tags()
            tags = audio.tags
            if metadata.get("title"):
                tags["\xa9nam"] = [metadata["title"]]
            artists = metadata.get("artists")
            if isinstance(artists, list) and artists:
                tags["\xa9ART"] = [str(value) for value in artists if str(value).strip()]
            elif metadata.get("artist"):
                tags["\xa9ART"] = [metadata["artist"]]
            if metadata.get("album"):
                tags["\xa9alb"] = [metadata["album"]]
            if metadata.get("album_artist"):
                tags["aART"] = [metadata["album_artist"]]
            if AudioProcessor._year(metadata):
                tags["\xa9day"] = [AudioProcessor._year(metadata)]
            if metadata.get("track_number"):
                tags["trkn"] = [(int(metadata["track_number"]), 0)]
            if metadata.get("disc_number"):
                tags["disk"] = [(int(metadata["disc_number"]), int(metadata.get("disc_total") or 0))]
            if metadata.get("is_compilation"):
                tags["cpil"] = True
            if metadata.get("isrc"):
                tags["----:com.apple.iTunes:ISRC"] = [MP4FreeForm(str(metadata["isrc"]).encode("utf-8"))]
            musicbrainz_id = normalize_recording_mbid(metadata.get("musicbrainz_id"))
            if musicbrainz_id:
                tags[MUSICBRAINZ_MP4_RECORDING_TAG] = [MP4FreeForm(musicbrainz_id.encode("ascii"))]
            if cover_data:
                tags["covr"] = [MP4Cover(cover_data, imageformat=MP4Cover.FORMAT_JPEG)]
            audio.save()
        except Exception as e:
            logger.warning("Could not write MP4 tags to %s: %s", file_path, e)

    @staticmethod
    def _embed_mp3(file_path: str, metadata: Dict[str, Any], cover_data: Optional[bytes]) -> None:
        try:
            audio = MP3(file_path, ID3=ID3)
        except mutagen.MutagenError:
            audio = MP3(file_path)
            audio.add_tags()
        tags = audio.tags
        if metadata.get("title"):
            tags.add(TIT2(encoding=3, text=metadata["title"]))
        artists = metadata.get("artists")
        if isinstance(artists, list) and artists:
            tags.add(TPE1(encoding=3, text=[str(value) for value in artists if str(value).strip()]))
        elif metadata.get("artist"):
            tags.add(TPE1(encoding=3, text=metadata["artist"]))
        if metadata.get("album"):
            tags.add(TALB(encoding=3, text=metadata["album"]))
        if metadata.get("album_artist"):
            tags.add(TPE2(encoding=3, text=metadata["album_artist"]))
        if AudioProcessor._year(metadata):
            tags.add(TDRC(encoding=3, text=AudioProcessor._year(metadata)))
        if metadata.get("track_number"):
            tags.add(TRCK(encoding=3, text=str(metadata["track_number"])))
        if AudioProcessor._disc(metadata):
            tags.add(TPOS(encoding=3, text=AudioProcessor._disc(metadata)))
        if metadata.get("is_compilation"):
            tags.add(TCMP(encoding=3, text="1"))
        if metadata.get("isrc"):
            tags.add(TXXX(encoding=3, desc="ISRC", text=metadata["isrc"]))
        musicbrainz_id = normalize_recording_mbid(metadata.get("musicbrainz_id"))
        if musicbrainz_id:
            tags.add(UFID(owner=MUSICBRAINZ_UFID_OWNER, data=musicbrainz_id.encode("ascii")))
        if cover_data:
            try:
                # encoding 3 is UTF-8; type 3 is the front cover.
                tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=cover_data))
            except Exception as e:
                logger.warning("Could not embed an MP3 cover in %s: %s", file_path, e)
        audio.save()

    @staticmethod
    def update_tags(file_path: str, tags: Dict[str, str]) -> bool:
        """Set title, artist, album and album artist in place. False when the
        format is not supported or the write fails."""
        try:
            ext = Path(file_path).suffix.lower()
            if ext == ".mp3":
                from mutagen.easyid3 import EasyID3

                try:
                    audio = EasyID3(file_path)
                except mutagen.id3.ID3NoHeaderError:
                    audio = EasyID3()
                    audio.save(file_path)
                    audio = EasyID3(file_path)
            elif ext == ".flac":
                audio = FLAC(file_path)
            elif ext == ".ogg":
                audio = OggVorbis(file_path)
            elif ext == ".opus":
                from mutagen.oggopus import OggOpus

                audio = OggOpus(file_path)
            elif ext in (".m4a", ".mp4"):
                from mutagen.easymp4 import EasyMP4

                audio = EasyMP4(file_path)
            else:
                return False
            for key in ("title", "artist", "album"):
                if key in tags:
                    audio[key] = tags[key]
            if tags.get("album_artist"):
                audio["albumartist"] = tags["album_artist"]
            audio.save()
            return True
        except Exception as e:
            logger.warning("Could not update tags on %s: %s", file_path, e)
            return False

    @staticmethod
    def embed_artwork(file_path: str, cover_path: str) -> bool:
        """Replace the cover of an MP3 or FLAC file with the image at `cover_path`."""
        try:
            data = Path(cover_path).read_bytes()
            mime = "image/png" if data.startswith(b"\x89PNG") else "image/jpeg"
            ext = Path(file_path).suffix.lower()
            if ext == ".mp3":
                from mutagen.id3 import ID3NoHeaderError

                try:
                    audio = ID3(file_path)
                except ID3NoHeaderError:
                    audio = ID3()
                audio.delall("APIC")
                audio.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=data))
                audio.save(file_path, v2_version=3)
                return True
            if ext == ".flac":
                audio = FLAC(file_path)
                audio.clear_pictures()
                image = Picture()
                image.type = 3
                image.mime = mime
                image.desc = "Cover"
                image.data = data
                audio.add_picture(image)
                audio.save()
                return True
            return False
        except Exception as e:
            logger.warning("Could not embed artwork in %s: %s", file_path, e)
            return False

    @staticmethod
    def extract_cover_art(file_path: str) -> Optional[bytes]:
        """The embedded cover image of an MP3, FLAC or MP4 file, or None."""
        try:
            ext = Path(file_path).suffix.lower()
            if ext == ".mp3":
                try:
                    audio = ID3(file_path)
                except Exception:
                    return None
                for key in audio.keys():
                    if key.startswith("APIC:"):
                        return audio[key].data
            elif ext == ".flac":
                audio = FLAC(file_path)
                if audio.pictures:
                    return audio.pictures[0].data
            elif ext in (".m4a", ".mp4"):
                audio = MP4(file_path)
                if audio.tags and "covr" in audio.tags:
                    return bytes(audio.tags["covr"][0])
            return None
        except Exception as e:
            logger.warning("Could not read cover art from %s: %s", file_path, e)
            return None
