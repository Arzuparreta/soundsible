"""ODST downloader: YouTube search + download + library + cloud. No Spotify."""

from pathlib import Path
from typing import Optional

from .config import DEFAULT_WORKERS, LIBRARY_FILENAME, DEFAULT_COOKIE_BROWSER, DEFAULT_QUALITY
from .models import LibraryMetadata
from .youtube_downloader import YouTubeDownloader
from .cloud_sync import CloudSync


class ODSTDownloader:
    """YouTube search, download, library, and cloud sync. Used by the webapp; no Spotify."""

    def __init__(
        self,
        output_dir: Path,
        workers: int = DEFAULT_WORKERS,
        cookie_browser: Optional[str] = None,
        quality: str = DEFAULT_QUALITY,
    ):
        self.output_dir = Path(output_dir)
        self.workers = workers
        self.output_dir.mkdir(parents=True, exist_ok=True)

        self.cloud = CloudSync(self.output_dir)
        self.library_path = self.output_dir / LIBRARY_FILENAME
        self.library = self._load_library()
        self.downloader = YouTubeDownloader(
            self.output_dir, cookie_browser=cookie_browser, quality=quality
        )

    def _load_library(self) -> LibraryMetadata:
        if self.library_path.exists():
            try:
                with open(self.library_path, "r") as f:
                    return LibraryMetadata.from_json(f.read())
            except Exception:
                pass
        return LibraryMetadata(
            version=1,
            tracks=[],
            playlists={},
            settings={},
        )

    def save_library(self) -> None:
        with open(self.library_path, "w") as f:
            f.write(self.library.to_json())
