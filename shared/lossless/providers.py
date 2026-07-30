from __future__ import annotations

import os
import re
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote, urlparse

import requests
from dotenv import dotenv_values

from shared.models import Track

from .models import LosslessCandidate

USER_AGENT = "SoundsibleLossless/1.0"
SEARCH_TIMEOUT = (2.0, 5.0)

_FREE_LICENSE_TOKENS = (
    "creativecommons.org/",
    "publicdomain",
    "public domain",
    "cc0",
)

PROVIDER_DOWNLOAD_HOSTS: dict[str, tuple[str, ...]] = {
    "jamendo": ("jamendo.com", "storage.jamendo.com", "usercontent.jamendo.com"),
    "wikimedia": ("wikimedia.org", "wikimediausercontent.org"),
    "internet_archive": ("archive.org", "us.archive.org"),
}


def _host_allowed(host: str, suffixes: tuple[str, ...]) -> bool:
    host = host.casefold().rstrip(".")
    return any(host == suffix or host.endswith(f".{suffix}") for suffix in suffixes)


def allowed_download_url(provider: str, url: str) -> bool:
    parsed = urlparse(str(url or ""))
    return (
        parsed.scheme == "https"
        and bool(parsed.hostname)
        and _host_allowed(parsed.hostname or "", PROVIDER_DOWNLOAD_HOSTS.get(provider, ()))
    )


def _text(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("value")
    return re.sub(r"<[^>]+>", "", str(value or "")).strip()


def _seconds(value: Any) -> int:
    try:
        raw = _text(value)
        if ":" in raw:
            total = 0.0
            for part in raw.split(":"):
                total = total * 60 + float(part)
            return max(0, int(round(total)))
        return max(0, int(round(float(raw))))
    except (TypeError, ValueError):
        return 0


def _size(value: Any) -> int | None:
    try:
        number = int(value)
        return number if number > 0 else None
    except (TypeError, ValueError):
        return None


def _free_license(value: str) -> bool:
    lowered = str(value or "").casefold()
    return any(token in lowered for token in _FREE_LICENSE_TOKENS)


def _clear_session_cookies(session: requests.Session) -> None:
    jar = getattr(session, "cookies", None)
    if jar is not None:
        jar.clear()


class JamendoProvider:
    name = "jamendo"
    api_url = "https://api.jamendo.com/v3.0/tracks/"

    def __init__(self, client_id: str | None = None, session: requests.Session | None = None):
        configured = os.getenv("JAMENDO_CLIENT_ID")
        if configured is None:
            env_path = Path(__file__).resolve().parents[2] / "odst_tool" / ".env"
            configured = str(
                (dotenv_values(str(env_path)) if os.path.exists(env_path) else {}).get(
                    "JAMENDO_CLIENT_ID", ""
                )
            )
        self.client_id = (client_id if client_id is not None else configured).strip()
        self.session = session or requests.Session()

    @property
    def available(self) -> bool:
        return bool(self.client_id)

    def search(self, track: Track, *, limit: int = 3) -> list[LosslessCandidate]:
        if not self.available:
            return []
        _clear_session_cookies(self.session)
        response = self.session.get(
            self.api_url,
            params={
                "client_id": self.client_id,
                "format": "json",
                "limit": max(1, min(10, limit)),
                "search": f"{track.artist} {track.title}",
                "include": "musicinfo licenses",
                "audioformat": "flac",
                "audiodlformat": "flac",
                "order": "relevance",
            },
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=SEARCH_TIMEOUT,
        )
        response.raise_for_status()
        rows = response.json().get("results") or []
        out: list[LosslessCandidate] = []
        for row in rows:
            if not row.get("audiodownload_allowed"):
                continue
            url = _text(row.get("audiodownload"))
            license_url = _text(row.get("license_ccurl"))
            if not allowed_download_url(self.name, url) or not _free_license(license_url):
                continue
            out.append(
                LosslessCandidate(
                    provider=self.name,
                    source_id=_text(row.get("id")),
                    title=_text(row.get("name")),
                    artist=_text(row.get("artist_name")),
                    album=_text(row.get("album_name")),
                    duration=_seconds(row.get("duration")),
                    download_url=url,
                    webpage_url=_text(row.get("shareurl")),
                    license_url=license_url,
                    format="flac",
                    original=False,
                )
            )
        return out[:limit]


class WikimediaProvider:
    name = "wikimedia"
    api_url = "https://commons.wikimedia.org/w/api.php"

    def __init__(self, session: requests.Session | None = None):
        self.session = session or requests.Session()

    @property
    def available(self) -> bool:
        return True

    def search(self, track: Track, *, limit: int = 3) -> list[LosslessCandidate]:
        _clear_session_cookies(self.session)
        response = self.session.get(
            self.api_url,
            params={
                "action": "query",
                "format": "json",
                "formatversion": 2,
                "generator": "search",
                "gsrnamespace": 6,
                "gsrlimit": max(1, min(10, limit * 2)),
                "gsrsearch": f'intitle:"{track.title}" "{track.artist}" filetype:flac',
                "prop": "imageinfo",
                "iiprop": "url|mime|size|extmetadata",
            },
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=SEARCH_TIMEOUT,
        )
        response.raise_for_status()
        pages = response.json().get("query", {}).get("pages", [])
        out: list[LosslessCandidate] = []
        for page in pages:
            info = (page.get("imageinfo") or [{}])[0]
            if _text(info.get("mime")).casefold() not in {"audio/flac", "audio/x-flac", "audio/wav", "audio/x-wav"}:
                continue
            url = _text(info.get("url"))
            meta = info.get("extmetadata") or {}
            license_url = _text(meta.get("LicenseUrl")) or _text(meta.get("LicenseShortName"))
            if not allowed_download_url(self.name, url) or not _free_license(license_url):
                continue
            page_title = _text(page.get("title")).removeprefix("File:")
            title = _text(meta.get("ObjectName")) or PurePosixPath(page_title).stem
            artist = _text(meta.get("Artist"))
            out.append(
                LosslessCandidate(
                    provider=self.name,
                    source_id=str(page.get("pageid") or page_title),
                    title=title,
                    artist=artist,
                    album="",
                    duration=_seconds(meta.get("Duration")),
                    download_url=url,
                    webpage_url=_text(info.get("descriptionurl")),
                    license_url=license_url,
                    format="wav" if "wav" in _text(info.get("mime")).casefold() else "flac",
                    expected_size=_size(info.get("size")),
                    original=True,
                )
            )
        return out[:limit]


class InternetArchiveProvider:
    name = "internet_archive"
    search_url = "https://archive.org/advancedsearch.php"

    def __init__(self, session: requests.Session | None = None):
        self.session = session or requests.Session()

    @property
    def available(self) -> bool:
        return True

    def search(self, track: Track, *, limit: int = 3) -> list[LosslessCandidate]:
        _clear_session_cookies(self.session)
        query = (
            f'mediatype:audio AND title:("{track.title}") AND '
            f'(creator:("{track.artist}") OR subject:("{track.artist}"))'
        )
        response = self.session.get(
            self.search_url,
            params={
                "q": query,
                "fl[]": ["identifier", "title", "creator", "licenseurl"],
                "rows": max(1, min(5, limit)),
                "page": 1,
                "output": "json",
            },
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=SEARCH_TIMEOUT,
        )
        response.raise_for_status()
        docs = response.json().get("response", {}).get("docs", [])
        out: list[LosslessCandidate] = []
        for doc in docs:
            identifier = _text(doc.get("identifier"))
            license_url = _text(doc.get("licenseurl"))
            if not identifier or not _free_license(license_url):
                continue
            _clear_session_cookies(self.session)
            metadata = self.session.get(
                f"https://archive.org/metadata/{quote(identifier, safe='')}",
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                timeout=SEARCH_TIMEOUT,
            )
            metadata.raise_for_status()
            item = metadata.json()
            item_meta = item.get("metadata") or {}
            item_license = _text(item_meta.get("licenseurl")) or license_url
            if not _free_license(item_license):
                continue
            for file_row in item.get("files") or []:
                fmt = _text(file_row.get("format")).casefold()
                source = _text(file_row.get("source")).casefold()
                name = _text(file_row.get("name"))
                if source != "original" or not name or not any(token in fmt for token in ("flac", "wave", "wav")):
                    continue
                url = f"https://archive.org/download/{quote(identifier, safe='')}/{quote(name)}"
                if not allowed_download_url(self.name, url):
                    continue
                out.append(
                    LosslessCandidate(
                        provider=self.name,
                        source_id=f"{identifier}/{name}",
                        title=_text(file_row.get("title")) or _text(item_meta.get("title")) or PurePosixPath(name).stem,
                        artist=_text(file_row.get("artist")) or _text(item_meta.get("creator")),
                        album=_text(file_row.get("album")) or _text(item_meta.get("title")),
                        duration=_seconds(file_row.get("length") or file_row.get("duration")),
                        download_url=url,
                        webpage_url=f"https://archive.org/details/{quote(identifier, safe='')}",
                        license_url=item_license,
                        format="wav" if "wave" in fmt or "wav" in fmt else "flac",
                        expected_size=_size(file_row.get("size")),
                        original=True,
                    )
                )
                if len(out) >= limit:
                    return out
        return out


def default_providers() -> list[JamendoProvider | WikimediaProvider | InternetArchiveProvider]:
    return [JamendoProvider(), WikimediaProvider(), InternetArchiveProvider()]
